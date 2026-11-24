import type { NormalizedInboundAttachment } from '$lib/server/channels/provider';
import { getChannelProvider } from '$lib/server/channels/zernio';
import { isOrganizationSubscriptionBlocked } from '$lib/server/billing/plans';
import {
	downloadPrivateMediaAsBase64,
	mirrorExternalMediaToPrivateStorage
} from '$lib/server/storage';
import { getSupabaseAdminClient } from '$lib/server/supabase-admin';
import type { Database, Json } from '$lib/types/database.types';
import type {
	AiSettings,
	ConnectedChannel,
	Contact,
	Conversation,
	KnowledgeDocument,
	MessageAttachment,
	Organization,
	OrgUsagePeriod,
	PipelineStage,
	Platform
} from '$lib/types/domain';
import {
	generateInboundAutoReplyTurn,
	generateMockAiTurn,
	type AiUsageTokens,
	type InboundAiTurnResult,
	type InboundMediaPart
} from './client';
import { searchWorkspaceKnowledge, selectRelevantKnowledge } from './rag';
import {
	consumeAiQuota,
	recordAiUsageLedger,
	type ConsumeAiQuotaResult
} from './usage';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AiDebounceJob {
	organizationId: string;
	conversationId: string;
	messageId: number;
	rawAttachments?: NormalizedInboundAttachment[];
}

export interface AiJobResult {
	status:
		| 'replied'
		| 'qualified_only'
		| 'handoff'
		| 'aborted_pre_send'
		| 'skipped';
	reason?: string;
	externalMessageId?: string;
	usagePeriodId?: number | null;
}

export interface AiProcessorContext {
	org: Pick<
		Organization,
		| 'id'
		| 'name'
		| 'currency'
		| 'subscription_status'
		| 'billing_mode'
		| 'trial_ends_at'
		| 'ai_overage_enabled'
	>;
	channel: Pick<ConnectedChannel, 'id' | 'external_account_id' | 'platform' | 'status'> | null;
	conv: Pick<
		Conversation,
		| 'id'
		| 'organization_id'
		| 'channel_id'
		| 'contact_id'
		| 'external_thread_id'
		| 'platform'
		| 'ai_paused'
		| 'ai_reply_count'
		| 'last_inbound_at'
	>;
	aiSettings: Pick<
		AiSettings,
		| 'enabled'
		| 'auto_reply_enabled'
		| 'auto_qualify_enabled'
		| 'handle_inbound_audio'
		| 'business_context'
		| 'tone'
		| 'handoff_rules'
		| 'max_ai_replies_per_thread'
	>;
	contact: Pick<Contact, 'id' | 'name' | 'email' | 'phone'> | null;
	recentMessages: Array<{
		id: number;
		direction: 'inbound' | 'outbound';
		body: string;
		attachments: MessageAttachment[];
	}>;
	defaultPipelineId: string | null;
	stages: Array<
		Pick<PipelineStage, 'id' | 'pipeline_id' | 'name' | 'slug' | 'position' | 'is_terminal' | 'ai_qualification_hint'>
	>;
	latestDeal: {
		id: string;
		stage_id: string;
		value_cents: number;
	} | null;
	usagePeriod: Pick<
		OrgUsagePeriod,
		'id' | 'used_ai_replies' | 'included_ai_replies'
	> | null;
}

export interface QualificationPlan {
	contactId: string;
	contactPatch: {
		lead_score: number;
		lead_summary: string;
		ai_intent_label: string;
		email?: string;
		phone?: string;
	};
	dealUpdate: {
		dealId: string;
		stageId: string;
		stageChanged: boolean;
		lastMovedBy: 'ai';
		aiLastReason: string;
		qualificationData: Json;
		valueCents?: number;
	} | null;
	dealInsert: {
		pipelineId: string;
		stageId: string;
		contactId: string;
		conversationId: string;
		title: string;
		dealType: string;
		valueCents: number;
		currency: 'MXN' | 'USD';
		lastMovedBy: 'ai';
		aiLastReason: string;
		qualificationData: Json;
	} | null;
}

export function resolveQualificationPlan(
	ctx: AiProcessorContext,
	turn: InboundAiTurnResult,
	nonTerminalStages: AiProcessorContext['stages']
): QualificationPlan | null {
	if (!ctx.contact) return null;

	const { lead_qualification: lq } = turn;
	const contactPatch: QualificationPlan['contactPatch'] = {
		lead_score: Math.min(100, Math.max(0, Math.round(lq.score))),
		lead_summary: lq.summary,
		ai_intent_label: lq.intent
	};
	if (!ctx.contact.email && lq.extracted_fields.email) {
		contactPatch.email = lq.extracted_fields.email;
	}
	if (!ctx.contact.phone && lq.extracted_fields.phone) {
		contactPatch.phone = lq.extracted_fields.phone;
	}

	if (!ctx.defaultPipelineId || nonTerminalStages.length === 0) {
		return { contactId: ctx.contact.id, contactPatch, dealUpdate: null, dealInsert: null };
	}

	const targetStage =
		(lq.recommended_stage_slug
			? nonTerminalStages.find((s) => s.slug === lq.recommended_stage_slug)
			: null) ?? null;

	const latestDealStage = ctx.latestDeal
		? (ctx.stages.find((s) => s.id === ctx.latestDeal!.stage_id) ?? null)
		: null;

	const qualificationData: Json = {
		intent: lq.intent,
		score: contactPatch.lead_score,
		recommended_stage_slug: targetStage?.slug ?? null,
		extracted_fields: {
			email: lq.extracted_fields.email,
			phone: lq.extracted_fields.phone,
			estimated_value_cents: lq.extracted_fields.estimated_value_cents
		}
	};
	const extractedValue = lq.extracted_fields.estimated_value_cents;

	if (ctx.latestDeal && latestDealStage && !latestDealStage.is_terminal) {
		const nextStageId = targetStage?.id ?? ctx.latestDeal.stage_id;
		return {
			contactId: ctx.contact.id,
			contactPatch,
			dealUpdate: {
				dealId: ctx.latestDeal.id,
				stageId: nextStageId,
				stageChanged: nextStageId !== ctx.latestDeal.stage_id,
				lastMovedBy: 'ai',
				aiLastReason: lq.summary,
				qualificationData,
				...(ctx.latestDeal.value_cents === 0 && extractedValue
					? { valueCents: extractedValue }
					: {})
			},
			dealInsert: null
		};
	}

	// Sin deal previo o el único deal previo está en etapa terminal (Ganado/Perdido):
	// nunca modificar el deal terminal; crear un nuevo deal abierto (AGENTS.md §5).
	const initialStage = targetStage ?? nonTerminalStages[0];
	return {
		contactId: ctx.contact.id,
		contactPatch,
		dealUpdate: null,
		dealInsert: {
			pipelineId: ctx.defaultPipelineId,
			stageId: initialStage.id,
			contactId: ctx.contact.id,
			conversationId: ctx.conv.id,
			title: `${ctx.contact.name} · ${lq.intent || 'Oportunidad'}`,
			dealType: 'Consulta entrante',
			valueCents: extractedValue ?? 0,
			currency: ctx.org.currency === 'USD' ? 'USD' : 'MXN',
			lastMovedBy: 'ai',
			aiLastReason: lq.summary,
			qualificationData
		}
	};
}

export interface AiProcessorDeps {
	acquireLease: (
		orgId: string,
		conversationId: string,
		messageId: number,
		leaseSeconds: number
	) => Promise<{ acquired: boolean; reason: string }>;
	releaseLease: (
		orgId: string,
		conversationId: string,
		processedMessageId: number | null
	) => Promise<void>;
	verifyReadyForSend: (
		orgId: string,
		conversationId: string,
		expectedInboundMessageId: number
	) => Promise<{ ready: boolean; reason: string }>;
	loadContext: (
		orgId: string,
		conversationId: string,
		messageId: number
	) => Promise<AiProcessorContext | null>;
	mirrorAttachment: typeof mirrorExternalMediaToPrivateStorage;
	downloadPrivateMedia: typeof downloadPrivateMediaAsBase64;
	saveInboundAttachments: (
		orgId: string,
		messageId: number,
		attachments: MessageAttachment[]
	) => Promise<void>;
	pauseConversation: (orgId: string, conversationId: string, reason: string) => Promise<void>;
	searchKnowledge: (params: {
		organizationId: string;
		query: string;
		limit: number;
	}) => Promise<Array<{ title: string; content: string }>>;
	generateReply: (params: {
		organizationName: string;
		businessContext: string;
		handoffRules: string;
		tone: AiSettings['tone'];
		userMessage: string;
		history: Array<{ role: 'user' | 'assistant'; text: string }>;
		knowledgeDocs: Array<{ title: string; content: string }>;
		stages: Array<{ name: string; slug: string; hint: string }>;
		mediaParts: InboundMediaPart[];
	}) => Promise<{ result: InboundAiTurnResult; model: string; usage: AiUsageTokens }>;
	saveQualification: (orgId: string, plan: QualificationPlan) => Promise<void>;
	consumeQuota: (params: {
		organizationId: string;
		action: 'auto_reply';
	}) => Promise<ConsumeAiQuotaResult>;
	sendMessage: (params: {
		externalAccountId: string;
		externalThreadId: string;
		platform: Platform;
		body: string;
		idempotencyKey: string;
	}) => Promise<{ externalMessageId: string; sentAt: string }>;
	persistOutboundAiMessage: (params: {
		orgId: string;
		conversationId: string;
		channelId: string;
		body: string;
		externalMessageId: string;
		sentAt: string;
		nextAiReplyCount: number;
		processedMessageId: number;
	}) => Promise<void>;
	recordLedger: typeof recordAiUsageLedger;
}

export interface AiProcessorGuardrailState {
	conversation: Conversation;
	settings: AiSettings;
	stages: PipelineStage[];
	docs: KnowledgeDocument[];
	usedAiReplies: number;
	includedAiReplies: number;
	aiOverageEnabled: boolean;
}

export function isWithinMeta24hWindow(lastInboundAt: string | null): boolean {
	if (!lastInboundAt) return false;
	const diffMs = Date.now() - new Date(lastInboundAt).getTime();
	return diffMs <= 24 * 60 * 60 * 1000;
}

/** Compatibilidad con vistas/previews rápidos en memoria. */
export async function processInboundAiPreview(
	state: AiProcessorGuardrailState,
	inboundText: string
) {
	if (!state.settings.enabled || state.conversation.ai_paused) {
		return { skipped: true as const, reason: 'ai_paused' };
	}
	if (!isWithinMeta24hWindow(state.conversation.last_inbound_at)) {
		return { skipped: true as const, reason: 'meta_24h_closed' };
	}
	if (state.conversation.ai_reply_count >= state.settings.max_ai_replies_per_thread) {
		return { skipped: true as const, reason: 'thread_limit_reached' };
	}
	if (!state.aiOverageEnabled && state.usedAiReplies >= state.includedAiReplies) {
		return { skipped: true as const, reason: 'quota_exhausted' };
	}

	const topChunks = selectRelevantKnowledge(state.docs, inboundText, 5);
	const stageNames = state.stages.filter((s) => !s.is_terminal).map((s) => s.name);

	const turn = await generateMockAiTurn({
		organizationName: state.conversation.organization_id,
		userMessage: inboundText,
		tone: state.settings.tone,
		knowledgeTitles: topChunks.map((d) => d.title),
		stageNames
	});

	return { skipped: false as const, turn };
}

function parseMessageAttachments(raw: unknown): MessageAttachment[] {
	if (!Array.isArray(raw)) return [];
	return raw.filter(
		(item): item is MessageAttachment =>
			typeof item === 'object' &&
			item !== null &&
			typeof (item as { storage_path?: unknown }).storage_path === 'string' &&
			typeof (item as { mime_type?: unknown }).mime_type === 'string'
	);
}

function createDefaultProcessorDeps(): AiProcessorDeps {
	return {
		async acquireLease(orgId, conversationId, messageId, leaseSeconds) {
			const admin = getSupabaseAdminClient();
			if (!admin || !UUID_REGEX.test(orgId) || !UUID_REGEX.test(conversationId)) {
				return { acquired: false, reason: 'supabase_unconfigured' };
			}
			const { data, error } = await admin.rpc('acquire_conversation_ai_lease_rpc', {
				p_org_id: orgId,
				p_conversation_id: conversationId,
				p_message_id: messageId,
				p_lease_seconds: leaseSeconds
			});
			if (error) {
				throw new Error(`No se pudo adquirir lease de conversación: ${error.message}`);
			}
			const row = Array.isArray(data) ? data[0] : data;
			return {
				acquired: Boolean(row?.acquired),
				reason: row?.reason ?? 'lease_failed'
			};
		},

		async releaseLease(orgId, conversationId, processedMessageId) {
			const admin = getSupabaseAdminClient();
			if (!admin || !UUID_REGEX.test(orgId) || !UUID_REGEX.test(conversationId)) return;
			const { error } = await admin.rpc('release_conversation_ai_lease_rpc', {
				p_org_id: orgId,
				p_conversation_id: conversationId,
				...(processedMessageId !== null ? { p_processed_message_id: processedMessageId } : {})
			});
			if (error) {
				console.error('[ai/processor] Error al liberar lease:', error.message);
			}
		},

		async verifyReadyForSend(orgId, conversationId, expectedInboundMessageId) {
			const admin = getSupabaseAdminClient();
			if (!admin) return { ready: false, reason: 'supabase_unconfigured' };
			const { data, error } = await admin.rpc('verify_conversation_ready_for_ai_send_rpc', {
				p_org_id: orgId,
				p_conversation_id: conversationId,
				p_expected_inbound_message_id: expectedInboundMessageId
			});
			if (error) {
				throw new Error(`Error verificando estado pre-envío: ${error.message}`);
			}
			const row = Array.isArray(data) ? data[0] : data;
			return {
				ready: Boolean(row?.ready),
				reason: row?.reason ?? 'unknown'
			};
		},

		async loadContext(orgId, conversationId, messageId) {
			const admin = getSupabaseAdminClient();
			if (!admin) return null;

			const [orgRes, convRes, aiRes, msgsRes, pipelinesRes, stagesRes, usageRes] =
				await Promise.all([
					admin
						.from('organizations')
						.select(
							'id, name, currency, subscription_status, billing_mode, trial_ends_at, ai_overage_enabled'
						)
						.eq('id', orgId)
						.maybeSingle(),
					admin
						.from('conversations')
						.select(
							'id, organization_id, channel_id, contact_id, external_thread_id, platform, ai_paused, ai_reply_count, last_inbound_at'
						)
						.eq('id', conversationId)
						.eq('organization_id', orgId)
						.maybeSingle(),
					admin
						.from('ai_settings')
						.select(
							'enabled, auto_reply_enabled, auto_qualify_enabled, handle_inbound_audio, business_context, tone, handoff_rules, max_ai_replies_per_thread'
						)
						.eq('organization_id', orgId)
						.maybeSingle(),
					admin
						.from('messages')
						.select('id, direction, body, attachments')
						.eq('organization_id', orgId)
						.eq('conversation_id', conversationId)
						.order('id', { ascending: false })
						.limit(15),
					admin
						.from('pipelines')
						.select('id, is_default')
						.eq('organization_id', orgId)
						.order('is_default', { ascending: false })
						.limit(1),
					admin
						.from('pipeline_stages')
						.select('id, pipeline_id, name, slug, position, is_terminal, ai_qualification_hint')
						.eq('organization_id', orgId)
						.order('position', { ascending: true }),
					admin
						.from('org_usage_periods')
						.select('id, used_ai_replies, included_ai_replies')
						.eq('organization_id', orgId)
						.order('period_start', { ascending: false })
						.limit(1)
						.maybeSingle()
				]);

			if (!orgRes.data || !convRes.data || !aiRes.data) {
				return null;
			}

			const defaultPipelineId =
				pipelinesRes.data?.[0]?.id ?? stagesRes.data?.[0]?.pipeline_id ?? null;

			const [channelRes, contactRes, dealRes] = await Promise.all([
				admin
					.from('connected_channels')
					.select('id, external_account_id, platform, status')
					.eq('id', convRes.data.channel_id)
					.eq('organization_id', orgId)
					.maybeSingle(),
				admin
					.from('contacts')
					.select('id, name, email, phone')
					.eq('id', convRes.data.contact_id)
					.eq('organization_id', orgId)
					.maybeSingle(),
				defaultPipelineId
					? admin
							.from('deals')
							.select('id, stage_id, value_cents')
							.eq('organization_id', orgId)
							.eq('pipeline_id', defaultPipelineId)
							.eq('contact_id', convRes.data.contact_id)
							.order('created_at', { ascending: false })
							.limit(1)
							.maybeSingle()
					: Promise.resolve({ data: null })
			]);

			const recentMessages = [...(msgsRes.data ?? [])]
				.reverse()
				.filter((m) => m.id <= messageId)
				.map((m) => ({
					id: m.id,
					direction: m.direction as 'inbound' | 'outbound',
					body: m.body,
					attachments: parseMessageAttachments(m.attachments)
				}));

			return {
				org: {
					...orgRes.data,
					subscription_status: orgRes.data.subscription_status as Organization['subscription_status'],
					billing_mode: orgRes.data.billing_mode as Organization['billing_mode']
				},
				channel: channelRes.data
					? {
							...channelRes.data,
							platform: channelRes.data.platform as Platform,
							status: channelRes.data.status as ConnectedChannel['status']
						}
					: null,
				conv: {
					...convRes.data,
					platform: convRes.data.platform as Platform
				},
				aiSettings: {
					...aiRes.data,
					handle_inbound_audio: aiRes.data.handle_inbound_audio as AiSettings['handle_inbound_audio'],
					tone: aiRes.data.tone as AiSettings['tone']
				},
				contact: contactRes.data ?? null,
				recentMessages,
				defaultPipelineId,
				stages: stagesRes.data ?? [],
				latestDeal: dealRes.data ?? null,
				usagePeriod: usageRes.data ?? null
			};
		},

		mirrorAttachment: mirrorExternalMediaToPrivateStorage,
		downloadPrivateMedia: downloadPrivateMediaAsBase64,

		async saveInboundAttachments(orgId, messageId, attachments) {
			const admin = getSupabaseAdminClient();
			if (!admin || attachments.length === 0) return;
			await admin
				.from('messages')
				.update({ attachments: attachments as unknown as Json })
				.eq('id', messageId)
				.eq('organization_id', orgId);
		},

		async pauseConversation(orgId, conversationId, reason) {
			const admin = getSupabaseAdminClient();
			if (!admin) return;
			await admin
				.from('conversations')
				.update({
					ai_paused: true,
					ai_handoff_reason: reason.slice(0, 240),
					needs_reply: true
				})
				.eq('id', conversationId)
				.eq('organization_id', orgId);
		},

		async searchKnowledge(params) {
			const hits = await searchWorkspaceKnowledge({
				organizationId: params.organizationId,
				query: params.query,
				limit: params.limit
			});
			return hits.map((h) => ({ title: h.title, content: h.content }));
		},

		async generateReply(params) {
			const res = await generateInboundAutoReplyTurn(params);
			return { result: res.result, model: res.model, usage: res.usage };
		},

		async saveQualification(orgId, plan) {
			const admin = getSupabaseAdminClient();
			if (!admin) return;

			const contactUpdate: Database['public']['Tables']['contacts']['Update'] = {
				lead_score: plan.contactPatch.lead_score,
				lead_summary: plan.contactPatch.lead_summary,
				ai_intent_label: plan.contactPatch.ai_intent_label,
				...(plan.contactPatch.email ? { email: plan.contactPatch.email } : {}),
				...(plan.contactPatch.phone ? { phone: plan.contactPatch.phone } : {})
			};

			await admin
				.from('contacts')
				.update(contactUpdate)
				.eq('id', plan.contactId)
				.eq('organization_id', orgId);

			if (plan.dealUpdate) {
				let nextPosition: number | undefined;
				if (plan.dealUpdate.stageChanged) {
					const { data: lastInCol } = await admin
						.from('deals')
						.select('position')
						.eq('organization_id', orgId)
						.eq('stage_id', plan.dealUpdate.stageId)
						.order('position', { ascending: false })
						.limit(1)
						.maybeSingle();
					nextPosition = (lastInCol?.position ?? 0) + 1000;
				}

				await admin
					.from('deals')
					.update({
						stage_id: plan.dealUpdate.stageId,
						...(nextPosition !== undefined ? { position: nextPosition } : {}),
						last_moved_by: plan.dealUpdate.lastMovedBy,
						ai_last_reason: plan.dealUpdate.aiLastReason,
						qualification_data: plan.dealUpdate.qualificationData,
						...(plan.dealUpdate.valueCents !== undefined
							? { value_cents: plan.dealUpdate.valueCents }
							: {})
					})
					.eq('id', plan.dealUpdate.dealId)
					.eq('organization_id', orgId);
				return;
			}

			if (plan.dealInsert) {
				const { data: lastInCol } = await admin
					.from('deals')
					.select('position')
					.eq('organization_id', orgId)
					.eq('stage_id', plan.dealInsert.stageId)
					.order('position', { ascending: false })
					.limit(1)
					.maybeSingle();

				await admin.from('deals').insert({
					organization_id: orgId,
					pipeline_id: plan.dealInsert.pipelineId,
					stage_id: plan.dealInsert.stageId,
					contact_id: plan.dealInsert.contactId,
					conversation_id: plan.dealInsert.conversationId,
					title: plan.dealInsert.title,
					deal_type: plan.dealInsert.dealType,
					value_cents: plan.dealInsert.valueCents,
					currency: plan.dealInsert.currency,
					position: (lastInCol?.position ?? 0) + 1000,
					last_moved_by: plan.dealInsert.lastMovedBy,
					ai_last_reason: plan.dealInsert.aiLastReason,
					qualification_data: plan.dealInsert.qualificationData
				});
			}
		},

		consumeQuota: consumeAiQuota,

		async sendMessage(params) {
			return getChannelProvider().sendMessage(params);
		},

		async persistOutboundAiMessage(params) {
			const admin = getSupabaseAdminClient();
			if (!admin) return;

			await admin.from('messages').insert({
				organization_id: params.orgId,
				conversation_id: params.conversationId,
				channel_id: params.channelId,
				external_message_id: params.externalMessageId,
				direction: 'outbound',
				sender_type: 'ai',
				sender_user_id: null,
				sender_label: 'Asistente IA',
				body: params.body,
				attachments: [],
				status: 'sent'
			});

			await admin
				.from('conversations')
				.update({
					ai_reply_count: params.nextAiReplyCount,
					last_message_preview: `IA: ${params.body}`,
					last_message_at: params.sentAt,
					needs_reply: false,
					last_processed_inbound_message_id: params.processedMessageId
				})
				.eq('id', params.conversationId)
				.eq('organization_id', params.orgId);
		},

		recordLedger: recordAiUsageLedger
	};
}

/**
 * Worker de procesamiento automático tras la ventana de debounce (4s).
 * Implementa Flujo B completo de docs/design-document.md y guardrails AGENTS.md §5.
 */
export async function processAiDebounceJob(
	job: AiDebounceJob,
	overrides?: Partial<AiProcessorDeps>
): Promise<AiJobResult> {
	const deps: AiProcessorDeps = { ...createDefaultProcessorDeps(), ...overrides };

	const lease = await deps.acquireLease(
		job.organizationId,
		job.conversationId,
		job.messageId,
		35
	);
	if (!lease.acquired) {
		return { status: 'skipped', reason: lease.reason };
	}

	let processedMessageId: number | null = null;

	try {
		const ctx = await deps.loadContext(job.organizationId, job.conversationId, job.messageId);
		if (!ctx) {
			processedMessageId = job.messageId;
			return { status: 'skipped', reason: 'context_missing' };
		}

		if (isOrganizationSubscriptionBlocked(ctx.org)) {
			processedMessageId = job.messageId;
			return { status: 'skipped', reason: 'subscription_inactive' };
		}

		if (!ctx.channel || ctx.channel.status !== 'active') {
			processedMessageId = job.messageId;
			return { status: 'skipped', reason: 'channel_inactive' };
		}

		if (
			!ctx.aiSettings.enabled ||
			(!ctx.aiSettings.auto_reply_enabled && !ctx.aiSettings.auto_qualify_enabled)
		) {
			processedMessageId = job.messageId;
			return { status: 'skipped', reason: 'ai_disabled' };
		}

		if (ctx.conv.ai_paused) {
			processedMessageId = job.messageId;
			return { status: 'skipped', reason: 'ai_paused' };
		}

		if (!isWithinMeta24hWindow(ctx.conv.last_inbound_at)) {
			processedMessageId = job.messageId;
			return { status: 'skipped', reason: 'meta_24h_closed' };
		}

		const inboundMsg =
			ctx.recentMessages.find((m) => m.id === job.messageId) ??
			ctx.recentMessages.at(-1) ??
			null;

		const rawAtts = (job.rawAttachments ?? []).slice(0, 3);
		const mirroredAttachments: MessageAttachment[] = [];
		const mediaParts: InboundMediaPart[] = [];
		let hasInboundAudio =
			rawAtts.some((a) => a.kind === 'audio') ||
			Boolean(inboundMsg?.attachments.some((a) => a.kind === 'audio'));

		for (const att of rawAtts) {
			if (!att.url) continue;
			const mirrored = await deps.mirrorAttachment({
				organizationId: ctx.org.id,
				conversationId: ctx.conv.id,
				messageId: job.messageId,
				sourceUrl: att.url,
				mimeType: att.mimeType,
				fileName: att.fileName,
				kind: att.kind
			});
			if (!mirrored) continue;
			mirroredAttachments.push(mirrored.attachment);
			if (mirrored.attachment.kind === 'audio') {
				hasInboundAudio = true;
			}
			if (
				(mirrored.attachment.kind === 'image' ||
					(mirrored.attachment.kind === 'audio' &&
						ctx.aiSettings.handle_inbound_audio === 'transcribe_and_reply')) &&
				mirrored.attachment.size_bytes <= 5 * 1024 * 1024
			) {
				mediaParts.push({
					mimeType: mirrored.attachment.mime_type,
					base64Data: mirrored.base64Data
				});
			}
		}

		if (mirroredAttachments.length > 0) {
			await deps.saveInboundAttachments(ctx.org.id, job.messageId, mirroredAttachments);
		} else if (mediaParts.length === 0 && inboundMsg && inboundMsg.attachments.length > 0) {
			for (const existingAtt of inboundMsg.attachments.slice(0, 3)) {
				if (existingAtt.kind === 'audio') hasInboundAudio = true;
				if (
					existingAtt.kind === 'image' ||
					(existingAtt.kind === 'audio' &&
						ctx.aiSettings.handle_inbound_audio === 'transcribe_and_reply')
				) {
					const b64 = await deps.downloadPrivateMedia(
						ctx.org.id,
						existingAtt.storage_path,
						'dm-media'
					);
					if (b64) {
						mediaParts.push({ mimeType: existingAtt.mime_type, base64Data: b64 });
					}
				}
			}
		}

		if (hasInboundAudio && ctx.aiSettings.handle_inbound_audio === 'handoff_human') {
			await deps.pauseConversation(
				ctx.org.id,
				ctx.conv.id,
				'Nota de voz entrante (pase a humano configurado)'
			);
			processedMessageId = job.messageId;
			return { status: 'handoff', reason: 'inbound_audio_handoff' };
		}

		if (
			ctx.aiSettings.auto_reply_enabled &&
			ctx.conv.ai_reply_count >= ctx.aiSettings.max_ai_replies_per_thread
		) {
			await deps.pauseConversation(
				ctx.org.id,
				ctx.conv.id,
				'Límite de respuestas consecutivas de IA alcanzado'
			);
			processedMessageId = job.messageId;
			return { status: 'handoff', reason: 'thread_limit_reached' };
		}

		if (
			ctx.aiSettings.auto_reply_enabled &&
			!ctx.org.ai_overage_enabled &&
			ctx.usagePeriod &&
			ctx.usagePeriod.used_ai_replies >= ctx.usagePeriod.included_ai_replies
		) {
			processedMessageId = job.messageId;
			return { status: 'skipped', reason: 'quota_exhausted' };
		}

		const userMessage = inboundMsg?.body?.trim() || '[Mensaje entrante]';
		const history = ctx.recentMessages
			.filter((m) => m.id < job.messageId)
			.slice(-14)
			.map((m) => ({
				role: m.direction === 'inbound' ? ('user' as const) : ('assistant' as const),
				text: m.body
			}));

		const nonTerminalStages = ctx.stages
			.filter((s) => !s.is_terminal)
			.sort((a, b) => a.position - b.position);

		const kbHits = await deps.searchKnowledge({
			organizationId: ctx.org.id,
			query: userMessage,
			limit: 5
		});

		const { result: turn, model, usage } = await deps.generateReply({
			organizationName: ctx.org.name,
			businessContext: ctx.aiSettings.business_context,
			handoffRules: ctx.aiSettings.handoff_rules,
			tone: ctx.aiSettings.tone,
			userMessage,
			history,
			knowledgeDocs: kbHits,
			stages: nonTerminalStages.map((s) => ({
				name: s.name,
				slug: s.slug,
				hint: s.ai_qualification_hint
			})),
			mediaParts
		});

		const hasAudioTokens = mediaParts.some((p) => p.mimeType.startsWith('audio/'));

		if (ctx.aiSettings.auto_qualify_enabled) {
			const plan = resolveQualificationPlan(ctx, turn, nonTerminalStages);
			if (plan) {
				await deps.saveQualification(ctx.org.id, plan);
			}
		}

		if (!ctx.aiSettings.auto_reply_enabled) {
			await deps.recordLedger({
				organizationId: ctx.org.id,
				usagePeriodId: ctx.usagePeriod?.id ?? null,
				conversationId: ctx.conv.id,
				action: 'qualify_only',
				billableUnits: 0,
				model,
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				hasAudio: hasAudioTokens
			});
			processedMessageId = job.messageId;
			return { status: 'qualified_only', reason: 'copilot_mode' };
		}

		if (turn.needs_human_handoff) {
			const handoffReason =
				turn.handoff_reason || 'Escalación automática solicitada por el asistente IA';
			await deps.pauseConversation(ctx.org.id, ctx.conv.id, handoffReason);
			await deps.recordLedger({
				organizationId: ctx.org.id,
				usagePeriodId: ctx.usagePeriod?.id ?? null,
				conversationId: ctx.conv.id,
				action: 'qualify_only',
				billableUnits: 0,
				model,
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				hasAudio: hasAudioTokens
			});
			processedMessageId = job.messageId;
			return { status: 'handoff', reason: handoffReason };
		}

		// Re-check atómico antes de consumir cuota o enviar (AGENTS.md §5)
		const preSend = await deps.verifyReadyForSend(ctx.org.id, ctx.conv.id, job.messageId);
		if (!preSend.ready) {
			await deps.recordLedger({
				organizationId: ctx.org.id,
				usagePeriodId: ctx.usagePeriod?.id ?? null,
				conversationId: ctx.conv.id,
				action: 'qualify_only',
				billableUnits: 0,
				model,
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				hasAudio: hasAudioTokens
			});
			processedMessageId = job.messageId;
			return { status: 'aborted_pre_send', reason: preSend.reason };
		}

		const quota = await deps.consumeQuota({
			organizationId: ctx.org.id,
			action: 'auto_reply'
		});
		if (!quota.allowed) {
			await deps.recordLedger({
				organizationId: ctx.org.id,
				usagePeriodId: quota.usagePeriodId,
				conversationId: ctx.conv.id,
				action: 'qualify_only',
				billableUnits: 0,
				model,
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				hasAudio: hasAudioTokens
			});
			processedMessageId = job.messageId;
			return { status: 'skipped', reason: quota.reason };
		}

		const sent = await deps.sendMessage({
			externalAccountId: ctx.channel.external_account_id,
			externalThreadId: ctx.conv.external_thread_id,
			platform: ctx.channel.platform,
			body: turn.reply_text,
			idempotencyKey: `ai-${ctx.conv.id}-${job.messageId}`
		});

		await deps.persistOutboundAiMessage({
			orgId: ctx.org.id,
			conversationId: ctx.conv.id,
			channelId: ctx.channel.id,
			body: turn.reply_text,
			externalMessageId: sent.externalMessageId,
			sentAt: sent.sentAt,
			nextAiReplyCount: ctx.conv.ai_reply_count + 1,
			processedMessageId: job.messageId
		});

		await deps.recordLedger({
			organizationId: ctx.org.id,
			usagePeriodId: quota.usagePeriodId,
			conversationId: ctx.conv.id,
			action: 'auto_reply',
			billableUnits: 1,
			model,
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			hasAudio: hasAudioTokens
		});

		processedMessageId = job.messageId;
		return {
			status: 'replied',
			externalMessageId: sent.externalMessageId,
			usagePeriodId: quota.usagePeriodId
		};
	} finally {
		await deps.releaseLease(job.organizationId, job.conversationId, processedMessageId);
	}
}
