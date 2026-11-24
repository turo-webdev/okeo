import { describe, expect, it, vi } from 'vitest';
import {
	processAiDebounceJob,
	type AiDebounceJob,
	type AiProcessorContext,
	type AiProcessorDeps,
	type QualificationPlan
} from '../processor';

function createBaseContext(overrides?: Partial<AiProcessorContext>): AiProcessorContext {
	const recentIso = new Date(Date.now() - 5 * 60_000).toISOString();
	return {
		org: {
			id: '11111111-1111-4111-8111-111111111111',
			name: 'Sportika Metepec',
			currency: 'MXN',
			subscription_status: 'trialing',
			billing_mode: 'trial',
			trial_ends_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
			ai_overage_enabled: false
		},
		channel: {
			id: '22222222-2222-4222-8222-222222222222',
			external_account_id: 'acc_zernio_1',
			platform: 'whatsapp',
			status: 'active'
		},
		conv: {
			id: '33333333-3333-4333-8333-333333333333',
			organization_id: '11111111-1111-4111-8111-111111111111',
			channel_id: '22222222-2222-4222-8222-222222222222',
			contact_id: '44444444-4444-4444-8444-444444444444',
			external_thread_id: 'thr_wa_1',
			platform: 'whatsapp',
			ai_paused: false,
			ai_reply_count: 0,
			last_inbound_at: recentIso
		},
		aiSettings: {
			enabled: true,
			auto_reply_enabled: true,
			auto_qualify_enabled: true,
			handle_inbound_audio: 'transcribe_and_reply',
			business_context: 'Club deportivo para parejas y familias.',
			tone: 'friendly',
			handoff_rules: 'Escalar si pide hablar con recepción.',
			max_ai_replies_per_thread: 5
		},
		contact: {
			id: '44444444-4444-4444-8444-444444444444',
			name: 'Sofía Mendoza',
			email: null,
			phone: null
		},
		recentMessages: [
			{
				id: 9,
				direction: 'outbound',
				body: '¡Hola! ¿En qué podemos ayudarte?',
				attachments: []
			},
			{
				id: 10,
				direction: 'inbound',
				body: 'Hola, quiero agendar visita para membresía familiar',
				attachments: []
			}
		],
		defaultPipelineId: '55555555-5555-4555-8555-555555555555',
		stages: [
			{
				id: 'stg_new',
				pipeline_id: '55555555-5555-4555-8555-555555555555',
				name: 'Nuevos',
				slug: 'new',
				position: 1000,
				is_terminal: false,
				ai_qualification_hint: 'Primer mensaje.'
			},
			{
				id: 'stg_qual',
				pipeline_id: '55555555-5555-4555-8555-555555555555',
				name: 'Calificado',
				slug: 'qualified',
				position: 2000,
				is_terminal: false,
				ai_qualification_hint: 'Quiere visita.'
			},
			{
				id: 'stg_won',
				pipeline_id: '55555555-5555-4555-8555-555555555555',
				name: 'Ganado',
				slug: 'won',
				position: 3000,
				is_terminal: true,
				ai_qualification_hint: ''
			}
		],
		latestDeal: {
			id: '66666666-6666-4666-8666-666666666666',
			stage_id: 'stg_new',
			value_cents: 0
		},
		usagePeriod: {
			id: 1,
			used_ai_replies: 10,
			included_ai_replies: 100
		},
		...overrides
	};
}

function createHarness(
	ctx: AiProcessorContext | null = createBaseContext(),
	custom?: Partial<AiProcessorDeps>
) {
	const released: Array<number | null> = [];
	const pausedReasons: string[] = [];
	const savedPlans: QualificationPlan[] = [];
	const sentMessages: Array<{ body: string; idempotencyKey: string }> = [];
	const outboundPersisted: Array<{ body: string; nextAiReplyCount: number }> = [];
	const ledgerEntries: Array<{ action: string; billableUnits: number; hasAudio?: boolean }> = [];
	const quotaCalls: string[] = [];

	const deps: AiProcessorDeps = {
		acquireLease: vi.fn(async () => ({ acquired: true, reason: 'ok' })),
		releaseLease: vi.fn(async (_orgId, _convId, processedId) => {
			released.push(processedId);
		}),
		verifyReadyForSend: vi.fn(async () => ({ ready: true, reason: 'ok' })),
		loadContext: vi.fn(async () => ctx),
		mirrorAttachment: vi.fn(async (p) => ({
			attachment: {
				storage_path: `${p.organizationId}/${p.conversationId}/${p.messageId}-note.ogg`,
				mime_type: p.mimeType ?? 'audio/ogg',
				file_name: p.fileName ?? 'note.ogg',
				size_bytes: 2048,
				kind: p.kind
			},
			base64Data: 'AAAA'
		})),
		downloadPrivateMedia: vi.fn(async () => null),
		saveInboundAttachments: vi.fn(async () => {}),
		pauseConversation: vi.fn(async (_orgId, _convId, reason) => {
			pausedReasons.push(reason);
		}),
		searchKnowledge: vi.fn(async () => [
			{ title: 'Membresías', content: 'Contamos con membresía de pareja y familiar.' }
		]),
		generateReply: vi.fn(async () => ({
			result: {
				reply_text: '¡Con gusto! Tenemos membresía familiar. ¿Qué día te gustaría visitarnos?',
				needs_human_handoff: false,
				handoff_reason: null,
				lead_qualification: {
					score: 88,
					intent: 'Agendar visita familiar',
					recommended_stage_slug: 'qualified',
					summary: 'Solicita visita para membresía familiar.',
					extracted_fields: {
						email: 'sofia@example.com',
						phone: '+525511223344',
						estimated_value_cents: 450000
					}
				}
			},
			model: 'gemini-3.5-flash-lite',
			usage: { inputTokens: 900, outputTokens: 120 }
		})),
		saveQualification: vi.fn(async (_orgId, plan) => {
			savedPlans.push(plan);
		}),
		consumeQuota: vi.fn(async ({ action }) => {
			quotaCalls.push(action);
			return {
				allowed: true,
				reason: 'ok',
				usagePeriodId: 1,
				usedAiReplies: 11,
				includedAiReplies: 100,
				overageAiReplies: 0,
				draftCount: 0,
				testChatCount: 0
			};
		}),
		sendMessage: vi.fn(async (params) => {
			sentMessages.push({ body: params.body, idempotencyKey: params.idempotencyKey });
			return {
				externalMessageId: 'ext_ai_reply_10',
				sentAt: new Date().toISOString()
			};
		}),
		persistOutboundAiMessage: vi.fn(async (params) => {
			outboundPersisted.push({
				body: params.body,
				nextAiReplyCount: params.nextAiReplyCount
			});
		}),
		recordLedger: vi.fn(async (entry) => {
			ledgerEntries.push({
				action: entry.action,
				billableUnits: entry.billableUnits,
				hasAudio: entry.hasAudio
			});
		}),
		...custom
	};

	const job: AiDebounceJob = {
		organizationId: '11111111-1111-4111-8111-111111111111',
		conversationId: '33333333-3333-4333-8333-333333333333',
		messageId: 10
	};

	return {
		deps,
		job,
		released,
		pausedReasons,
		savedPlans,
		sentMessages,
		outboundPersisted,
		ledgerEntries,
		quotaCalls
	};
}

describe('processAiDebounceJob guardrails & end-to-end orchestration', () => {
	it('skips without calling Gemini or releasing holder lock on debounce supersede or locked lease', async () => {
		const superseded = createHarness(createBaseContext(), {
			acquireLease: vi.fn(async () => ({
				acquired: false,
				reason: 'superseded_by_newer_message'
			}))
		});
		const res1 = await processAiDebounceJob(superseded.job, superseded.deps);
		expect(res1).toEqual({ status: 'skipped', reason: 'superseded_by_newer_message' });
		expect(superseded.deps.generateReply).not.toHaveBeenCalled();
		expect(superseded.deps.releaseLease).not.toHaveBeenCalled();

		const locked = createHarness(createBaseContext(), {
			acquireLease: vi.fn(async () => ({ acquired: false, reason: 'locked' }))
		});
		const res2 = await processAiDebounceJob(locked.job, locked.deps);
		expect(res2).toEqual({ status: 'skipped', reason: 'locked' });
		expect(locked.deps.releaseLease).not.toHaveBeenCalled();
	});

	it('aborts send and avoids burning reply quota when pre-send check detects human or burst message', async () => {
		const h = createHarness(createBaseContext(), {
			verifyReadyForSend: vi.fn(async () => ({ ready: false, reason: 'ai_paused' }))
		});

		const res = await processAiDebounceJob(h.job, h.deps);
		expect(res).toEqual({ status: 'aborted_pre_send', reason: 'ai_paused' });
		expect(h.quotaCalls).toHaveLength(0);
		expect(h.sentMessages).toHaveLength(0);
		expect(h.ledgerEntries).toEqual([
			{ action: 'qualify_only', billableUnits: 0, hasAudio: false }
		]);
		expect(h.released).toEqual([10]);
	});

	it('enforces Meta 24h window, trial expiration, thread reply limit, and quota exhaustion', async () => {
		const expired24h = createHarness(
			createBaseContext({
				conv: {
					...createBaseContext().conv,
					last_inbound_at: new Date(Date.now() - 25 * 3600_000).toISOString()
				}
			})
		);
		expect(await processAiDebounceJob(expired24h.job, expired24h.deps)).toEqual({
			status: 'skipped',
			reason: 'meta_24h_closed'
		});
		expect(expired24h.sentMessages).toHaveLength(0);

		const expiredTrial = createHarness(
			createBaseContext({
				org: {
					...createBaseContext().org,
					trial_ends_at: new Date(Date.now() - 3600_000).toISOString()
				}
			})
		);
		expect(await processAiDebounceJob(expiredTrial.job, expiredTrial.deps)).toEqual({
			status: 'skipped',
			reason: 'subscription_inactive'
		});

		const threadCap = createHarness(
			createBaseContext({
				conv: { ...createBaseContext().conv, ai_reply_count: 5 }
			})
		);
		expect(await processAiDebounceJob(threadCap.job, threadCap.deps)).toEqual({
			status: 'handoff',
			reason: 'thread_limit_reached'
		});
		expect(threadCap.pausedReasons[0]).toContain('Límite de respuestas');

		const exhausted = createHarness(
			createBaseContext({
				usagePeriod: { id: 1, used_ai_replies: 100, included_ai_replies: 100 }
			})
		);
		expect(await processAiDebounceJob(exhausted.job, exhausted.deps)).toEqual({
			status: 'skipped',
			reason: 'quota_exhausted'
		});
		expect(exhausted.deps.generateReply).not.toHaveBeenCalled();
	});

	it('handles inbound audio policy (handoff_human vs transcribe_and_reply)', async () => {
		const handoffAudio = createHarness(
			createBaseContext({
				aiSettings: {
					...createBaseContext().aiSettings,
					handle_inbound_audio: 'handoff_human'
				}
			})
		);
		const audioJob: AiDebounceJob = {
			...handoffAudio.job,
			rawAttachments: [
				{ url: 'https://cdn.example.com/voice.ogg', mimeType: 'audio/ogg', kind: 'audio' }
			]
		};
		const resHandoff = await processAiDebounceJob(audioJob, handoffAudio.deps);
		expect(resHandoff).toEqual({ status: 'handoff', reason: 'inbound_audio_handoff' });
		expect(handoffAudio.deps.saveInboundAttachments).toHaveBeenCalledTimes(1);
		expect(handoffAudio.deps.generateReply).not.toHaveBeenCalled();

		const transcribeAudio = createHarness(createBaseContext());
		const resTranscribe = await processAiDebounceJob(audioJob, transcribeAudio.deps);
		expect(resTranscribe.status).toBe('replied');
		expect(transcribeAudio.deps.generateReply).toHaveBeenCalledWith(
			expect.objectContaining({
				mediaParts: [{ mimeType: 'audio/ogg', base64Data: 'AAAA' }]
			})
		);
		expect(transcribeAudio.ledgerEntries).toEqual([
			{ action: 'auto_reply', billableUnits: 1, hasAudio: true }
		]);
	});

	it('never updates deals in terminal stages (creates new open deal) and rejects invalid/terminal slugs', async () => {
		const ctxTerminal = createBaseContext({
			latestDeal: {
				id: 'deal_won_999',
				stage_id: 'stg_won',
				value_cents: 900000
			}
		});
		const h = createHarness(ctxTerminal, {
			generateReply: vi.fn(async () => ({
				result: {
					reply_text: '¡Qué gusto saludarte de nuevo!',
					needs_human_handoff: false,
					handoff_reason: null,
					lead_qualification: {
						score: 75,
						intent: 'Nueva consulta',
						// Modelo intenta recomendar etapa terminal 'won' -> debe ser rechazado
						recommended_stage_slug: 'won',
						summary: 'Cliente previo escribe de nuevo.',
						extracted_fields: { email: null, phone: null, estimated_value_cents: null }
					}
				},
				model: 'gemini-3.5-flash-lite',
				usage: { inputTokens: 600, outputTokens: 80 }
			}))
		});

		const res = await processAiDebounceJob(h.job, h.deps);
		expect(res.status).toBe('replied');
		expect(h.savedPlans).toHaveLength(1);
		expect(h.savedPlans[0].dealUpdate).toBeNull();
		expect(h.savedPlans[0].dealInsert).toMatchObject({
			stageId: 'stg_new',
			contactId: ctxTerminal.contact!.id,
			lastMovedBy: 'ai'
		});
		expect(h.savedPlans[0].dealInsert?.qualificationData).toMatchObject({
			recommended_stage_slug: null
		});
	});

	it('executes full happy path: RAG, qualification update, atomic quota, ChannelProvider send, and lease release', async () => {
		const h = createHarness(createBaseContext());
		const res = await processAiDebounceJob(h.job, h.deps);

		expect(res).toEqual({
			status: 'replied',
			externalMessageId: 'ext_ai_reply_10',
			usagePeriodId: 1
		});
		expect(h.quotaCalls).toEqual(['auto_reply']);
		expect(h.sentMessages).toEqual([
			{
				body: '¡Con gusto! Tenemos membresía familiar. ¿Qué día te gustaría visitarnos?',
				idempotencyKey: 'ai-33333333-3333-4333-8333-333333333333-10'
			}
		]);
		expect(h.outboundPersisted).toEqual([
			{
				body: '¡Con gusto! Tenemos membresía familiar. ¿Qué día te gustaría visitarnos?',
				nextAiReplyCount: 1
			}
		]);
		expect(h.savedPlans[0].dealUpdate).toMatchObject({
			dealId: '66666666-6666-4666-8666-666666666666',
			stageId: 'stg_qual',
			stageChanged: true,
			valueCents: 450000
		});
		expect(h.ledgerEntries).toEqual([
			{ action: 'auto_reply', billableUnits: 1, hasAudio: false }
		]);
		expect(h.released).toEqual([10]);
	});
});
