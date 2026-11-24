import type { KnowledgeUploadedFile } from '$lib/server/ai/knowledge-ingest';
import { getUsageSummary, TRIAL_DAYS, TRIAL_INCLUDED_AI_REPLIES, TRIAL_KB_DOCUMENT_LIMIT } from '$lib/server/billing/plans';
import { getChannelProvider } from '$lib/server/channels/zernio';
import { validateSafeExternalUrl } from '$lib/server/ai/rag';
import { createInitialSeedState, type SeedState } from './seed';
import {
	hasMinRole,
	type AiSettings,
	type ConnectedChannel,
	type Contact,
	type ContactNote,
	type Conversation,
	type Deal,
	type KnowledgeDocument,
	type Message,
	type MessageAttachment,
	type Organization,
	type OrganizationInvitation,
	type OrganizationMember,
	type OrgRole,
	type OrgUsagePeriod,
	type Pipeline,
	type PipelineStage,
	type Platform,
	type Profile,
	type RoleChangeRequest,
	type TimelineEvent
} from '$lib/types/domain';

const globalKey = '__okeo_seed_state_v1__';
const globalStore = globalThis as unknown as Record<string, SeedState | undefined>;

function getState(): SeedState {
	if (!globalStore[globalKey]) {
		globalStore[globalKey] = createInitialSeedState();
	}
	return globalStore[globalKey]!;
}

export function getDemoUser(): Profile {
	return getState().profiles[0];
}

export function getOrganizationBySlug(slug: string): Organization | null {
	return getState().organizations.find((o) => o.slug === slug) ?? null;
}

export function getOrganizationById(organizationId: string): Organization | null {
	return getState().organizations.find((o) => o.id === organizationId) ?? null;
}

export function listUserOrganizations(userId: string): Array<Organization & { role: OrgRole }> {
	const s = getState();
	return s.members
		.filter((m) => m.user_id === userId)
		.map((m) => {
			const org = s.organizations.find((o) => o.id === m.organization_id);
			return org ? { ...org, role: m.role } : null;
		})
		.filter((x): x is Organization & { role: OrgRole } => Boolean(x));
}

export function getMembership(organizationId: string, userId: string): OrganizationMember | null {
	return (
		getState().members.find(
			(m) => m.organization_id === organizationId && m.user_id === userId
		) ?? null
	);
}

export function requireOrgMembership(
	organizationId: string,
	userId: string,
	minRole: OrgRole = 'viewer',
	overrideRole?: OrgRole
): { org: Organization; member: OrganizationMember; effectiveRole: OrgRole } {
	const org = getOrganizationById(organizationId);
	if (!org) {
		throw new Error('Organización no encontrada');
	}
	const member = getMembership(organizationId, userId);
	if (!member) {
		throw new Error('No perteneces a este workspace');
	}
	const effectiveRole = overrideRole ?? member.role;
	if (!hasMinRole(effectiveRole, minRole)) {
		throw new Error(`Permisos insuficientes (requiere rol ${minRole})`);
	}
	return { org, member, effectiveRole };
}

export function getWorkspaceSnapshot(organizationId: string) {
	const s = getState();
	const org = getOrganizationById(organizationId);
	if (!org) return null;

	const members = s.members.filter((m) => m.organization_id === organizationId);
	const channels = s.channels.filter((c) => c.organization_id === organizationId);
	const contacts = s.contacts.filter((c) => c.organization_id === organizationId);
	const identities = s.identities.filter((i) => i.organization_id === organizationId);
	const notes = s.notes.filter((n) => n.organization_id === organizationId);
	const conversations = s.conversations
		.filter((c) => c.organization_id === organizationId)
		.sort((a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime());
	const messages = s.messages.filter((m) => m.organization_id === organizationId);
	const pipeline = s.pipelines.find((p) => p.organization_id === organizationId && p.is_default) ?? null;
	const stages = s.stages
		.filter((st) => st.organization_id === organizationId)
		.sort((a, b) => a.position - b.position);
	const deals = s.deals
		.filter((d) => d.organization_id === organizationId)
		.sort((a, b) => a.position - b.position);
	const aiSettings = s.aiSettings.find((a) => a.organization_id === organizationId) ?? null;
	const knowledgeDocuments = s.knowledgeDocuments.filter((k) => k.organization_id === organizationId);
	const usagePeriod = s.usagePeriods.find((u) => u.organization_id === organizationId) ?? null;
	const invitations = s.invitations.filter((inv) => inv.organization_id === organizationId);
	const roleChangeRequests = s.roleChangeRequests.filter(
		(r) => r.organization_id === organizationId && r.status === 'pending'
	);
	const timelineEvents = s.timelineEvents.filter((e) => e.organization_id === organizationId);
	const activeChannelsCount = channels.filter((c) => c.status === 'active').length;
	const usageSummary = usagePeriod ? getUsageSummary(org, usagePeriod, activeChannelsCount) : null;

	return {
		org,
		members,
		channels,
		contacts,
		identities,
		notes,
		conversations,
		messages,
		pipeline,
		stages,
		deals,
		aiSettings,
		knowledgeDocuments,
		usagePeriod,
		usageSummary,
		invitations,
		roleChangeRequests,
		timelineEvents
	};
}

export async function createWorkspace(params: {
	userId: string;
	name: string;
	platform: Platform;
	industry: string;
	language: 'es' | 'en';
	autoReplyEnabled: boolean;
	initialKnowledge: string;
}): Promise<Organization> {
	const s = getState();
	const user = s.profiles.find((p) => p.id === params.userId) ?? s.profiles[0];
	const baseSlug = params.name
		.toLowerCase()
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/(^-|-$)/g, '') || 'mi-espacio';

	let slug = baseSlug;
	let suffix = 2;
	while (s.organizations.some((o) => o.slug === slug)) {
		slug = `${baseSlug}-${suffix++}`;
	}

	const { profileId } = await getChannelProvider().createProfile(params.name);
	const nowIso = new Date().toISOString();
	const trialEnd = new Date(Date.now() + TRIAL_DAYS * 86400_000).toISOString();
	const orgId = `org_${slug}_${Date.now()}`;

	const org: Organization = {
		id: orgId,
		name: params.name,
		slug,
		industry: params.industry || 'Servicios profesionales',
		language: params.language,
		currency: 'MXN',
		zernio_profile_id: profileId,
		subscription_status: 'trialing',
		billing_mode: 'trial',
		stripe_customer_id: null,
		stripe_subscription_id: null,
		stripe_channel_item_id: null,
		stripe_ai_overage_item_id: null,
		channel_slots: 1,
		included_ai_replies_per_channel: 1000,
		ai_overage_enabled: false,
		kb_document_limit: TRIAL_KB_DOCUMENT_LIMIT,
		trial_ends_at: trialEnd,
		current_period_start: nowIso,
		current_period_end: trialEnd,
		created_at: nowIso
	};

	s.organizations.push(org);
	s.members.push({
		organization_id: orgId,
		user_id: user.id,
		role: 'owner',
		profile: user,
		created_at: nowIso
	});

	const platformLabels: Record<Platform, { name: string; handle: string }> = {
		whatsapp: { name: 'WhatsApp', handle: '+52 55 0101 0202' },
		instagram: { name: 'Instagram', handle: `@${slug}` },
		facebook: { name: 'Messenger', handle: params.name }
	};

	s.channels.push({
		id: `ch_${slug}_${params.platform}`,
		organization_id: orgId,
		provider: 'zernio',
		platform: params.platform,
		external_account_id: `acc_mock_${slug}_${params.platform}`,
		display_name: platformLabels[params.platform].name,
		handle_or_phone: platformLabels[params.platform].handle,
		status: 'active',
		metadata: {},
		created_at: nowIso,
		updated_at: nowIso
	});

	const pipId = `pip_${slug}`;
	s.pipelines.push({
		id: pipId,
		organization_id: orgId,
		name: 'Pipeline principal',
		is_default: true,
		created_at: nowIso
	});

	s.stages.push(
		{
			id: `stg_${slug}_new`,
			organization_id: orgId,
			pipeline_id: pipId,
			name: 'Nuevos',
			slug: 'new',
			color: '#8E8E86',
			position: 1000,
			is_terminal: false,
			ai_qualification_hint: 'Al escribir por primera vez.',
			created_at: nowIso
		},
		{
			id: `stg_${slug}_conv`,
			organization_id: orgId,
			pipeline_id: pipId,
			name: 'En conversación',
			slug: 'in_conversation',
			color: '#3B6342',
			position: 2000,
			is_terminal: false,
			ai_qualification_hint: 'Al identificar una necesidad.',
			created_at: nowIso
		},
		{
			id: `stg_${slug}_prop`,
			organization_id: orgId,
			pipeline_id: pipId,
			name: 'Propuesta enviada',
			slug: 'proposal_sent',
			color: '#1C1C1A',
			position: 3000,
			is_terminal: false,
			ai_qualification_hint: 'Al recibir alcance y precio.',
			created_at: nowIso
		},
		{
			id: `stg_${slug}_won`,
			organization_id: orgId,
			pipeline_id: pipId,
			name: 'Ganado',
			slug: 'won',
			color: '#3B6342',
			position: 4000,
			is_terminal: true,
			ai_qualification_hint: 'Solo tu equipo marca Ganado.',
			created_at: nowIso
		}
	);

	s.aiSettings.push({
		organization_id: orgId,
		enabled: true,
		auto_reply_enabled: params.autoReplyEnabled,
		auto_qualify_enabled: true,
		handle_inbound_audio: 'transcribe_and_reply',
		business_context: params.initialKnowledge || `${params.name} — ${params.industry}`,
		tone: 'professional',
		handoff_rules: 'Pida ayuda, solicite descuentos o falte información.',
		max_ai_replies_per_thread: 5,
		updated_at: nowIso
	});

	if (params.initialKnowledge.trim()) {
		s.knowledgeDocuments.push({
			id: `kb_${slug}_1`,
			organization_id: orgId,
			title: 'Contexto inicial del negocio',
			subtitle: 'Texto',
			source_type: 'text',
			source_url: null,
			storage_path: null,
			content_preview: params.initialKnowledge.trim(),
			embedding_model: 'gemini-embedding-001',
			status: 'ready',
			error_detail: null,
			created_at: nowIso
		});
	}

	s.usagePeriods.push({
		id: s.usagePeriods.length + 1,
		organization_id: orgId,
		period_start: nowIso,
		period_end: trialEnd,
		included_ai_replies: TRIAL_INCLUDED_AI_REPLIES,
		used_ai_replies: 0,
		overage_ai_replies: 0,
		draft_count: 0,
		test_chat_count: 0,
		updated_at: nowIso
	});

	return org;
}

export function sendManualMessage(params: {
	organizationId: string;
	conversationId: string;
	userId: string;
	body: string;
	attachments?: MessageAttachment[];
	retryMessageId?: number;
	externalMessageId?: string;
	status?: 'delivered' | 'failed';
	errorCode?: string | null;
	errorDetail?: string | null;
}): Message {
	const s = getState();
	const conv = s.conversations.find(
		(c) => c.id === params.conversationId && c.organization_id === params.organizationId
	);
	if (!conv) throw new Error('Conversación no encontrada en esta organización');

	const profile = s.profiles.find((p) => p.id === params.userId) ?? s.profiles[0];
	const nowIso = new Date().toISOString();
	const timeStr = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });
	const finalStatus = params.status ?? 'delivered';
	const attachments = params.attachments ?? [];
	const firstAtt = attachments[0];
	const attLabel =
		firstAtt?.kind === 'image' ? 'Imagen' : firstAtt?.kind === 'audio' ? 'Audio' : 'Archivo';
	const previewText = params.body.trim()
		? `Tú: ${params.body.trim()}`
		: firstAtt
			? `Tú: [${attLabel}] ${firstAtt.file_name}`
			: 'Tú: [Mensaje]';

	if (params.retryMessageId) {
		const existing = s.messages.find(
			(m) =>
				m.id === params.retryMessageId &&
				m.conversation_id === conv.id &&
				m.organization_id === params.organizationId
		);
		if (existing) {
			existing.body = params.body;
			if (attachments.length > 0) existing.attachments = attachments;
			existing.external_message_id = params.externalMessageId ?? existing.external_message_id;
			existing.status = finalStatus;
			existing.error_code = finalStatus === 'failed' ? (params.errorCode ?? 'SEND_FAILED') : null;
			existing.error_detail = finalStatus === 'failed' ? (params.errorDetail ?? 'Error de envío') : null;
			existing.display_time = timeStr;
			conv.ai_paused = true;
			conv.ai_reply_count = 0;
			conv.needs_reply = false;
			conv.unread_count = 0;
			conv.last_message_preview = previewText;
			conv.last_message_at = nowIso;
			conv.display_time = timeStr;
			return existing;
		}
	}

	const msg: Message = {
		id: s.nextMessageId++,
		organization_id: params.organizationId,
		conversation_id: conv.id,
		channel_id: conv.channel_id,
		external_message_id: params.externalMessageId ?? `ext_local_${Date.now()}`,
		direction: 'outbound',
		sender_type: 'agent',
		sender_user_id: profile.id,
		sender_label: `Tú · ${profile.full_name}`,
		body: params.body,
		attachments,
		status: finalStatus,
		error_code: finalStatus === 'failed' ? (params.errorCode ?? 'SEND_FAILED') : null,
		error_detail: finalStatus === 'failed' ? (params.errorDetail ?? 'Error de envío') : null,
		day_group: 'Hoy',
		display_time: timeStr,
		created_at: nowIso
	};

	s.messages.push(msg);
	// Guardrail obligatorio: intervención humana pausa IA y reinicia contadores
	conv.ai_paused = true;
	conv.ai_handoff_reason = 'Intervención humana en Inbox';
	conv.ai_reply_count = 0;
	conv.needs_reply = false;
	conv.unread_count = 0;
	conv.last_message_preview = previewText;
	conv.last_message_at = nowIso;
	conv.display_time = timeStr;
	conv.updated_at = nowIso;

	return msg;
}

export function addInternalNote(params: {
	organizationId: string;
	contactId: string;
	conversationId: string | null;
	userId: string;
	body: string;
}): ContactNote {
	const s = getState();
	const contact = s.contacts.find(
		(c) => c.id === params.contactId && c.organization_id === params.organizationId
	);
	if (!contact) throw new Error('Contacto no encontrado');
	const profile = s.profiles.find((p) => p.id === params.userId) ?? s.profiles[0];
	const timeStr = new Date().toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });

	const note: ContactNote = {
		id: s.nextNoteId++,
		organization_id: params.organizationId,
		contact_id: contact.id,
		conversation_id: params.conversationId,
		author_user_id: profile.id,
		author_name: profile.full_name,
		body: params.body,
		created_at: new Date().toISOString(),
		display_time: `Hoy, ${timeStr}`
	};

	s.notes.unshift(note);
	return note;
}

export function updateConversationState(params: {
	organizationId: string;
	conversationId: string;
	assignedTo?: string | null;
	status?: 'open' | 'pending' | 'closed';
	aiPaused?: boolean;
}): Conversation {
	const s = getState();
	const conv = s.conversations.find(
		(c) => c.id === params.conversationId && c.organization_id === params.organizationId
	);
	if (!conv) throw new Error('Conversación no encontrada');

	if (params.assignedTo !== undefined) {
		conv.assigned_to = params.assignedTo;
	}
	if (params.status !== undefined) {
		conv.status = params.status;
		if (params.status === 'closed') {
			conv.unread_count = 0;
			conv.needs_reply = false;
		}
	}
	if (params.aiPaused !== undefined) {
		conv.ai_paused = params.aiPaused;
		if (!params.aiPaused) {
			conv.ai_reply_count = 0;
			conv.ai_handoff_reason = null;
		}
	}
	conv.updated_at = new Date().toISOString();
	return conv;
}

export function createDeal(params: {
	organizationId: string;
	title: string;
	contactId: string;
	stageId: string;
	dealType: string;
	valueAmount: number;
	ownerUserId: string | null;
}): Deal {
	const s = getState();
	const stage = s.stages.find((st) => st.id === params.stageId && st.organization_id === params.organizationId);
	const contact = s.contacts.find((c) => c.id === params.contactId && c.organization_id === params.organizationId);
	if (!stage || !contact) throw new Error('Etapa o contacto inválido');

	const maxPos = s.deals
		.filter((d) => d.organization_id === params.organizationId && d.stage_id === stage.id)
		.reduce((max, d) => Math.max(max, d.position), 0);

	const org = getOrganizationById(params.organizationId)!;
	const nowIso = new Date().toISOString();

	const deal: Deal = {
		id: `deal_${Date.now()}`,
		organization_id: params.organizationId,
		pipeline_id: stage.pipeline_id,
		stage_id: stage.id,
		contact_id: contact.id,
		conversation_id:
			s.conversations.find(
				(c) => c.contact_id === contact.id && c.organization_id === params.organizationId
			)?.id ?? null,
		owner_user_id: params.ownerUserId ?? contact.owner_user_id,
		title: params.title,
		deal_type: params.dealType,
		value_cents: Math.round(params.valueAmount * 100),
		currency: org.currency,
		position: maxPos + 1000,
		last_moved_by: 'human',
		ai_last_reason: null,
		ai_updated_label: null,
		next_step_title: 'Definir siguiente paso',
		next_step_label: 'Hoy',
		next_step_overdue: false,
		stage_age_label: 'Recién creada',
		created_age_label: 'Creada hoy',
		qualification_data: {},
		created_at: nowIso,
		updated_at: nowIso
	};

	s.deals.push(deal);
	return deal;
}

export function updateDeal(params: {
	organizationId: string;
	dealId: string;
	stageId?: string;
	contactId?: string;
	dealType?: string;
	ownerUserId?: string | null;
	nextStepTitle?: string;
	nextStepLabel?: string;
}): Deal {
	const s = getState();
	const deal = s.deals.find((d) => d.id === params.dealId && d.organization_id === params.organizationId);
	if (!deal) throw new Error('Oportunidad no encontrada');

	if (params.stageId) {
		const stage = s.stages.find((st) => st.id === params.stageId && st.organization_id === params.organizationId);
		if (!stage) throw new Error('Etapa inválida');
		if (deal.stage_id !== stage.id) {
			deal.stage_id = stage.id;
			deal.last_moved_by = 'human';
			deal.stage_age_label = 'Hoy en esta etapa';
		}
	}
	if (params.contactId) deal.contact_id = params.contactId;
	if (params.dealType) deal.deal_type = params.dealType;
	if (params.ownerUserId !== undefined) deal.owner_user_id = params.ownerUserId;
	if (params.nextStepTitle !== undefined) deal.next_step_title = params.nextStepTitle;
	if (params.nextStepLabel !== undefined) {
		deal.next_step_label = params.nextStepLabel;
		deal.next_step_overdue = false;
	}
	deal.updated_at = new Date().toISOString();
	return deal;
}

export function createContact(params: {
	organizationId: string;
	name: string;
	company: string;
	email: string;
	phone: string;
	ownerUserId: string | null;
	nextStepTitle: string;
	nextStepAtLabel: string;
}): Contact {
	const s = getState();
	const nowIso = new Date().toISOString();
	const contact: Contact = {
		id: `cnt_${Date.now()}`,
		organization_id: params.organizationId,
		name: params.name,
		company: params.company || null,
		role_title: null,
		avatar_url: null,
		email: params.email || null,
		phone: params.phone || null,
		owner_user_id: params.ownerUserId,
		tags: [],
		lead_score: 50,
		lead_summary: null,
		ai_intent_label: 'Nuevo contacto',
		next_step_title: params.nextStepTitle || 'Primer contacto',
		next_step_at_label: params.nextStepAtLabel || 'Mañana',
		next_step_overdue: false,
		created_at: nowIso,
		updated_at: nowIso
	};
	s.contacts.unshift(contact);
	return contact;
}

export function updateContact(params: {
	organizationId: string;
	contactId: string;
	name: string;
	company: string;
	roleTitle: string;
	email: string;
	phone: string;
	ownerUserId: string | null;
	nextStepTitle: string;
	nextStepAtLabel: string;
}): Contact {
	const s = getState();
	const contact = s.contacts.find(
		(c) => c.id === params.contactId && c.organization_id === params.organizationId
	);
	if (!contact) throw new Error('Contacto no encontrado');

	contact.name = params.name;
	contact.company = params.company || null;
	contact.role_title = params.roleTitle || null;
	contact.email = params.email || null;
	contact.phone = params.phone || null;
	contact.owner_user_id = params.ownerUserId;
	contact.next_step_title = params.nextStepTitle || null;
	contact.next_step_at_label = params.nextStepAtLabel || null;
	contact.next_step_overdue = false;
	contact.updated_at = new Date().toISOString();
	return contact;
}

export function updateAiMode(organizationId: string, autoReplyEnabled: boolean): AiSettings {
	const s = getState();
	const settings = s.aiSettings.find((a) => a.organization_id === organizationId);
	if (!settings) throw new Error('Ajustes de IA no encontrados');
	settings.auto_reply_enabled = autoReplyEnabled;
	settings.updated_at = new Date().toISOString();
	return settings;
}

export function updateAiPreferences(params: {
	organizationId: string;
	tone: 'friendly' | 'professional' | 'direct';
	autoQualifyEnabled: boolean;
	maxAiRepliesPerThread: number;
	handoffRules: string;
	businessContext?: string;
}): AiSettings {
	const s = getState();
	const settings = s.aiSettings.find((a) => a.organization_id === params.organizationId);
	if (!settings) throw new Error('Ajustes de IA no encontrados');
	settings.tone = params.tone;
	settings.auto_qualify_enabled = params.autoQualifyEnabled;
	settings.max_ai_replies_per_thread = params.maxAiRepliesPerThread;
	settings.handoff_rules = params.handoffRules;
	if (params.businessContext !== undefined) {
		settings.business_context = params.businessContext;
	}
	settings.updated_at = new Date().toISOString();
	return settings;
}

export function updatePipelineQualificationRules(
	organizationId: string,
	rules: Record<string, string>
): PipelineStage[] {
	const s = getState();
	const stages = s.stages.filter((st) => st.organization_id === organizationId && !st.is_terminal);
	for (const stage of stages) {
		if (rules[stage.id] !== undefined) {
			stage.ai_qualification_hint = rules[stage.id];
		}
	}
	return stages;
}

export function addKnowledgeDocument(params: {
	organizationId: string;
	sourceType: 'faq' | 'text' | 'file' | 'url';
	title: string;
	question: string;
	answer: string;
	content: string;
	url: string;
	file?: KnowledgeUploadedFile | null;
}): KnowledgeDocument {
	const s = getState();
	const nowIso = new Date().toISOString();
	let docTitle = params.title.trim();
	let preview = params.content.trim();
	let subtitle = 'Texto';
	let sourceUrl: string | null = null;
	let storagePath: string | null = null;

	if (params.sourceType === 'url') {
		const check = validateSafeExternalUrl(params.url);
		if (!check.ok) throw new Error(check.reason);
		sourceUrl = check.url.toString();
		docTitle = docTitle || check.url.hostname + check.url.pathname;
		subtitle = 'URL indexada';
		preview = preview || `Contenido indexado desde ${sourceUrl}`;
	} else if (params.sourceType === 'faq') {
		docTitle = docTitle || params.question.trim() || 'Pregunta frecuente';
		subtitle = 'FAQ';
		preview = `${params.question.trim()} — ${params.answer.trim()}`;
	} else if (params.sourceType === 'file') {
		const uploadedName = params.file?.name?.trim() || '';
		const isPdf = (params.file?.mimeType || uploadedName).toLowerCase().includes('pdf');
		docTitle = docTitle || uploadedName || 'Documento.pdf';
		subtitle = isPdf ? 'PDF' : 'Archivo';
		storagePath = `${params.organizationId}/${Date.now()}/${docTitle}`;
		if (params.file && !isPdf && params.file.bytes.byteLength > 0) {
			preview = new TextDecoder('utf-8', { fatal: false }).decode(params.file.bytes).trim().slice(0, 6000);
		} else {
			preview = preview || `Archivo procesado: ${docTitle}`;
		}
	}

	const doc: KnowledgeDocument = {
		id: `kb_${Date.now()}`,
		organization_id: params.organizationId,
		title: docTitle || 'Fuente de conocimiento',
		subtitle,
		source_type: params.sourceType,
		source_url: sourceUrl,
		storage_path: storagePath,
		content_preview: preview,
		embedding_model: 'gemini-embedding-001',
		status: 'ready',
		error_detail: null,
		created_at: nowIso
	};

	s.knowledgeDocuments.unshift(doc);
	return doc;
}

export function updateKnowledgeDocument(params: {
	organizationId: string;
	documentId: string;
	title: string;
	content: string;
	url?: string;
}): KnowledgeDocument {
	const s = getState();
	const doc = s.knowledgeDocuments.find(
		(d) => d.id === params.documentId && d.organization_id === params.organizationId
	);
	if (!doc) throw new Error('Fuente no encontrada');

	if (doc.source_type === 'url' && params.url !== undefined) {
		const rawUrl = params.url.trim();
		if (!rawUrl) throw new Error('Ingresa una URL pública válida');
		const check = validateSafeExternalUrl(rawUrl);
		if (!check.ok) throw new Error(check.reason);
		doc.source_url = check.url.toString();
	}

	doc.title = params.title.trim();
	doc.content_preview = params.content.trim();
	doc.status = 'ready';
	doc.error_detail = null;
	return doc;
}

export function deleteKnowledgeDocument(
	organizationId: string,
	documentId: string
): { deletedId: string } {
	const s = getState();
	const idx = s.knowledgeDocuments.findIndex(
		(d) => d.id === documentId && d.organization_id === organizationId
	);
	if (idx === -1) throw new Error('Fuente no encontrada');
	s.knowledgeDocuments.splice(idx, 1);
	return { deletedId: documentId };
}

export function retryKnowledgeDocument(organizationId: string, documentId: string): KnowledgeDocument {
	const s = getState();
	const doc = s.knowledgeDocuments.find(
		(d) => d.id === documentId && d.organization_id === organizationId
	);
	if (!doc) throw new Error('Fuente no encontrada');
	doc.status = 'ready';
	doc.error_detail = null;
	doc.content_preview = doc.content_preview || `Texto extraído correctamente de ${doc.title}`;
	return doc;
}

export function createInvitation(params: {
	organizationId: string;
	email: string;
	role: Exclude<OrgRole, 'owner'>;
	invitedByName: string;
}): OrganizationInvitation {
	const s = getState();
	const org = getOrganizationById(params.organizationId);
	if (!org) throw new Error('Organización no encontrada');
	const token = `inv_${Date.now()}`;
	const inv: OrganizationInvitation = {
		id: `inv_${Date.now()}`,
		organization_id: org.id,
		organization_name: org.name,
		organization_slug: org.slug,
		email: params.email,
		role: params.role,
		token_hash: `hash_${token}`,
		demo_token: token,
		invited_by_name: params.invitedByName,
		status: 'pending',
		expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(),
		accepted_at: null,
		created_at: new Date().toISOString()
	};
	s.invitations.unshift(inv);
	return inv;
}

export function revokeInvitation(organizationId: string, invitationId: string): void {
	const s = getState();
	const inv = s.invitations.find(
		(i) => i.id === invitationId && i.organization_id === organizationId
	);
	if (inv) inv.status = 'revoked';
}

export function refreshInvitationToken(params: {
	organizationId: string;
	invitationId: string;
	invitedByName: string;
}): OrganizationInvitation {
	const s = getState();
	const inv = s.invitations.find(
		(i) =>
			i.id === params.invitationId &&
			i.organization_id === params.organizationId &&
			i.status === 'pending'
	);
	if (!inv) {
		throw new Error('La invitación pendiente no existe o ya fue utilizada');
	}
	const token = `inv_${Date.now()}`;
	inv.token_hash = `hash_${token}`;
	inv.demo_token = token;
	inv.invited_by_name = params.invitedByName;
	inv.expires_at = new Date(Date.now() + 7 * 86400_000).toISOString();
	return inv;
}

export function getInvitationByToken(token: string): OrganizationInvitation | null {
	return getState().invitations.find((i) => i.demo_token === token) ?? null;
}

export function acceptInvitation(token: string): OrganizationInvitation | null {
	const inv = getInvitationByToken(token);
	if (!inv || inv.status !== 'pending') return null;
	inv.status = 'accepted';
	inv.accepted_at = new Date().toISOString();
	return inv;
}

export function updateMemberRole(organizationId: string, userId: string, role: OrgRole): void {
	const s = getState();
	const member = s.members.find(
		(m) => m.organization_id === organizationId && m.user_id === userId
	);
	if (!member) throw new Error('Miembro no encontrado');
	member.role = role;
}

export function createRoleChangeRequest(params: {
	organizationId: string;
	userId: string;
	requestedRole: Exclude<OrgRole, 'owner'>;
}): RoleChangeRequest {
	const s = getState();
	const existing = s.roleChangeRequests.find(
		(r) =>
			r.organization_id === params.organizationId &&
			r.user_id === params.userId &&
			r.status === 'pending'
	);
	if (existing) return existing;
	const profile = s.profiles.find((p) => p.id === params.userId) ?? s.profiles[0];
	const member = getMembership(params.organizationId, params.userId);
	const req: RoleChangeRequest = {
		id: `rcr_${Date.now()}`,
		organization_id: params.organizationId,
		user_id: profile.id,
		user_name: profile.full_name,
		user_email: profile.email,
		current_role: member?.role ?? 'viewer',
		requested_role: params.requestedRole,
		status: 'pending',
		created_at: new Date().toISOString()
	};
	s.roleChangeRequests.unshift(req);
	return req;
}

export function resolveRoleChangeRequest(
	organizationId: string,
	requestId: string,
	approve: boolean
): void {
	const s = getState();
	const req = s.roleChangeRequests.find(
		(r) => r.id === requestId && r.organization_id === organizationId
	);
	if (!req) return;
	req.status = approve ? 'approved' : 'rejected';
	if (approve) {
		updateMemberRole(organizationId, req.user_id, req.requested_role);
	}
}

export function reconnectChannel(organizationId: string, channelId: string): ConnectedChannel {
	const s = getState();
	const ch = s.channels.find((c) => c.id === channelId && c.organization_id === organizationId);
	if (!ch) throw new Error('Canal no encontrado');
	ch.status = 'active';
	ch.updated_at = new Date().toISOString();
	return ch;
}

export function disconnectChannel(organizationId: string, channelId: string): ConnectedChannel {
	const s = getState();
	const ch = s.channels.find((c) => c.id === channelId && c.organization_id === organizationId);
	if (!ch) throw new Error('Canal no encontrado');
	ch.status = 'disconnected';
	ch.updated_at = new Date().toISOString();
	return ch;
}

export function updateWorkspaceInfo(params: {
	organizationId: string;
	name: string;
	industry: string;
	currency: 'MXN' | 'USD';
	language: 'es' | 'en';
}): Organization {
	const org = getOrganizationById(params.organizationId);
	if (!org) throw new Error('Organización no encontrada');
	org.name = params.name;
	org.industry = params.industry;
	org.currency = params.currency;
	org.language = params.language;
	return org;
}

export function updateOrganizationChannelSlots(organizationId: string, channelSlots: number): Organization {
	const s = getState();
	const org = getOrganizationById(organizationId);
	if (!org) throw new Error('Organización no encontrada');
	org.billing_mode = 'per_channel';
	org.subscription_status = 'active';
	org.channel_slots = channelSlots;
	org.kb_document_limit = channelSlots * 15;
	const period = s.usagePeriods.find((u) => u.organization_id === organizationId);
	if (period) {
		period.included_ai_replies = channelSlots * org.included_ai_replies_per_channel;
	}
	return org;
}

export function updateOrganizationZernioProfileId(organizationId: string, profileId: string): void {
	const org = getOrganizationById(organizationId);
	if (!org) throw new Error('Organización no encontrada');
	org.zernio_profile_id = profileId;
}

export function findChannelByExternalAccountId(externalAccountId: string): ConnectedChannel | null {
	if (!externalAccountId) return null;
	return (
		getState().channels.find(
			(c) => c.provider === 'zernio' && c.external_account_id === externalAccountId
		) ?? null
	);
}

export function upsertConnectedChannel(params: {
	organizationId: string;
	platform: Platform;
	externalAccountId: string;
	displayName: string;
	handleOrPhone: string;
	channelId?: string;
}):
	| { ok: true; channel: ConnectedChannel }
	| { ok: false; code: 'ACCOUNT_IN_OTHER_ORG' | 'CHANNEL_SLOTS_FULL'; error: string } {
	const s = getState();
	const org = getOrganizationById(params.organizationId);
	if (!org) throw new Error('Organización no encontrada');

	const collision = s.channels.find(
		(c) =>
			c.provider === 'zernio' &&
			c.external_account_id === params.externalAccountId &&
			c.organization_id !== params.organizationId
	);
	if (collision) {
		return {
			ok: false,
			code: 'ACCOUNT_IN_OTHER_ORG',
			error: 'Esta cuenta social ya está conectada en otro workspace de Okeo.'
		};
	}

	const nowIso = new Date().toISOString();
	const existing =
		(params.channelId
			? s.channels.find(
					(c) => c.id === params.channelId && c.organization_id === params.organizationId
				)
			: undefined) ??
		s.channels.find(
			(c) =>
				c.organization_id === params.organizationId &&
				c.provider === 'zernio' &&
				c.external_account_id === params.externalAccountId
		);

	const activeCount = s.channels.filter(
		(c) => c.organization_id === params.organizationId && c.status === 'active'
	).length;

	if (existing) {
		if (existing.status !== 'active' && activeCount >= org.channel_slots) {
			return {
				ok: false,
				code: 'CHANNEL_SLOTS_FULL',
				error: 'Alcanzaste el límite de canales contratados en este workspace.'
			};
		}
		existing.platform = params.platform;
		existing.external_account_id = params.externalAccountId;
		existing.display_name = params.displayName;
		existing.handle_or_phone = params.handleOrPhone;
		existing.status = 'active';
		existing.updated_at = nowIso;
		return { ok: true, channel: existing };
	}

	if (activeCount >= org.channel_slots) {
		return {
			ok: false,
			code: 'CHANNEL_SLOTS_FULL',
			error: 'Alcanzaste el límite de canales contratados en este workspace.'
		};
	}

	const channel: ConnectedChannel = {
		id: `ch_${params.platform}_${Date.now()}`,
		organization_id: params.organizationId,
		provider: 'zernio',
		platform: params.platform,
		external_account_id: params.externalAccountId,
		display_name: params.displayName,
		handle_or_phone: params.handleOrPhone,
		status: 'active',
		metadata: {},
		created_at: nowIso,
		updated_at: nowIso
	};
	s.channels.push(channel);
	return { ok: true, channel };
}

function getProcessedWebhookSet(s: SeedState): Set<string> {
	if (!s.processedWebhookEvents) {
		s.processedWebhookEvents = new Set<string>();
	}
	return s.processedWebhookEvents;
}

export function hasProcessedWebhookEvent(eventId: string): boolean {
	if (!eventId) return false;
	return getProcessedWebhookSet(getState()).has(eventId);
}

export function markWebhookEventProcessed(eventId: string): void {
	if (!eventId) return;
	const set = getProcessedWebhookSet(getState());
	if (set.size >= 5000) {
		const oldest = set.values().next().value;
		if (oldest) set.delete(oldest);
	}
	set.add(eventId);
}

function resolveOrCreateWebhookConversation(params: {
	s: SeedState;
	channel: ConnectedChannel;
	externalThreadId?: string;
	senderExternalId?: string;
	senderName?: string;
	senderHandle?: string;
}): { conv: Conversation; contact: Contact } {
	const { s, channel } = params;
	const orgId = channel.organization_id;

	if (params.externalThreadId) {
		const byThread = s.conversations.find(
			(c) =>
				c.organization_id === orgId &&
				c.channel_id === channel.id &&
				c.external_thread_id === params.externalThreadId
		);
		if (byThread) {
			const contact =
				s.contacts.find((ct) => ct.id === byThread.contact_id && ct.organization_id === orgId) ??
				s.contacts[0];
			return { conv: byThread, contact };
		}
	}

	if (params.senderExternalId) {
		const identity = s.identities.find(
			(i) =>
				i.organization_id === orgId &&
				i.platform === channel.platform &&
				i.external_user_id === params.senderExternalId
		);
		if (identity) {
			const contact = s.contacts.find(
				(ct) => ct.id === identity.contact_id && ct.organization_id === orgId
			);
			if (contact) {
				const existingConv = s.conversations.find(
					(c) =>
						c.organization_id === orgId &&
						c.channel_id === channel.id &&
						c.contact_id === contact.id
				);
				if (existingConv) {
					if (params.externalThreadId) {
						existingConv.external_thread_id = params.externalThreadId;
					}
					return { conv: existingConv, contact };
				}
				const nowIso = new Date().toISOString();
				const newConv: Conversation = {
					id: `conv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
					organization_id: orgId,
					channel_id: channel.id,
					contact_id: contact.id,
					external_thread_id: params.externalThreadId ?? `thr_${channel.id}_${Date.now()}`,
					platform: channel.platform,
					status: 'open',
					assigned_to: null,
					needs_reply: true,
					ai_paused: false,
					ai_handoff_reason: null,
					ai_reply_count: 0,
					ai_processing_locked_until: null,
					last_processed_inbound_message_id: null,
					last_inbound_at: nowIso,
					last_message_preview: '',
					last_message_at: nowIso,
					display_time: 'Ahora',
					unread_count: 0,
					created_at: nowIso,
					updated_at: nowIso
				};
				s.conversations.unshift(newConv);
				return { conv: newConv, contact };
			}
		}
	}

	const nowIso = new Date().toISOString();
	const displayName =
		params.senderName?.trim() || params.senderHandle?.trim() || 'Contacto nuevo';
	const contactId = `cnt_wh_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
	const contact: Contact = {
		id: contactId,
		organization_id: orgId,
		name: displayName,
		company: null,
		role_title: null,
		avatar_url: null,
		email: null,
		phone: channel.platform === 'whatsapp' && params.senderHandle ? params.senderHandle : null,
		owner_user_id: null,
		tags: [],
		lead_score: 50,
		lead_summary: null,
		ai_intent_label: 'Mensaje entrante',
		next_step_title: 'Responder conversación',
		next_step_at_label: 'Hoy',
		next_step_overdue: false,
		created_at: nowIso,
		updated_at: nowIso
	};
	s.contacts.unshift(contact);

	if (params.senderExternalId || params.senderHandle) {
		s.identities.push({
			id: `id_wh_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
			organization_id: orgId,
			contact_id: contact.id,
			platform: channel.platform,
			external_user_id: params.senderExternalId ?? params.senderHandle ?? contact.id,
			username_or_phone: params.senderHandle ?? params.senderName ?? contact.id,
			created_at: nowIso
		});
	}

	const conv: Conversation = {
		id: `conv_wh_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
		organization_id: orgId,
		channel_id: channel.id,
		contact_id: contact.id,
		external_thread_id: params.externalThreadId ?? `thr_${channel.id}_${Date.now()}`,
		platform: channel.platform,
		status: 'open',
		assigned_to: null,
		needs_reply: true,
		ai_paused: false,
		ai_handoff_reason: null,
		ai_reply_count: 0,
		ai_processing_locked_until: null,
		last_processed_inbound_message_id: null,
		last_inbound_at: nowIso,
		last_message_preview: '',
		last_message_at: nowIso,
		display_time: 'Ahora',
		unread_count: 0,
		created_at: nowIso,
		updated_at: nowIso
	};
	s.conversations.unshift(conv);
	return { conv, contact };
}

export function ingestInboundWebhookMessage(params: {
	externalAccountId: string;
	externalMessageId?: string;
	externalThreadId?: string;
	senderExternalId?: string;
	senderName?: string;
	senderHandle?: string;
	body: string;
}): {
	organizationId: string;
	conversationId: string;
	messageId: number;
	deduplicated: boolean;
} | null {
	const s = getState();
	const channel = findChannelByExternalAccountId(params.externalAccountId);
	if (!channel) return null;

	if (params.externalMessageId) {
		const duplicate = s.messages.find(
			(m) =>
				m.channel_id === channel.id &&
				m.external_message_id === params.externalMessageId
		);
		if (duplicate) {
			return {
				organizationId: duplicate.organization_id,
				conversationId: duplicate.conversation_id,
				messageId: duplicate.id,
				deduplicated: true
			};
		}
	}

	const { conv, contact } = resolveOrCreateWebhookConversation({
		s,
		channel,
		externalThreadId: params.externalThreadId,
		senderExternalId: params.senderExternalId,
		senderName: params.senderName,
		senderHandle: params.senderHandle
	});

	const nowIso = new Date().toISOString();
	const timeStr = new Date().toLocaleTimeString('es-MX', {
		hour: '2-digit',
		minute: '2-digit',
		hour12: false
	});
	const bodyText = params.body.trim() || '[Mensaje]';

	const msg: Message = {
		id: s.nextMessageId++,
		organization_id: channel.organization_id,
		conversation_id: conv.id,
		channel_id: channel.id,
		external_message_id: params.externalMessageId ?? null,
		direction: 'inbound',
		sender_type: 'contact',
		sender_user_id: null,
		sender_label: params.senderName?.trim() || contact.name,
		body: bodyText,
		attachments: [],
		status: 'delivered',
		error_code: null,
		error_detail: null,
		day_group: 'Hoy',
		display_time: timeStr,
		created_at: nowIso
	};
	s.messages.push(msg);

	conv.last_inbound_at = nowIso;
	conv.last_message_at = nowIso;
	conv.last_message_preview = bodyText;
	conv.display_time = timeStr;
	conv.needs_reply = true;
	conv.unread_count += 1;
	if (conv.status === 'closed') conv.status = 'open';
	conv.updated_at = nowIso;

	return {
		organizationId: channel.organization_id,
		conversationId: conv.id,
		messageId: msg.id,
		deduplicated: false
	};
}

export function ingestExternalEchoMessage(params: {
	externalAccountId: string;
	externalMessageId?: string;
	externalThreadId?: string;
	senderExternalId?: string;
	senderName?: string;
	senderHandle?: string;
	body: string;
}): boolean {
	const s = getState();
	const channel = findChannelByExternalAccountId(params.externalAccountId);
	if (!channel) return false;

	if (params.externalMessageId) {
		const existing = s.messages.find(
			(m) =>
				m.channel_id === channel.id &&
				m.external_message_id === params.externalMessageId
		);
		// Si ya lo guardamos síncronamente al enviarlo desde Okeo (agente o IA), no duplicar ni alterar ai_paused.
		if (existing) {
			return true;
		}
	}

	const { conv } = resolveOrCreateWebhookConversation({
		s,
		channel,
		externalThreadId: params.externalThreadId,
		senderExternalId: params.senderExternalId,
		senderName: params.senderName,
		senderHandle: params.senderHandle
	});

	const nowIso = new Date().toISOString();
	const timeStr = new Date().toLocaleTimeString('es-MX', {
		hour: '2-digit',
		minute: '2-digit',
		hour12: false
	});
	const bodyText = params.body.trim() || '[Mensaje saliente]';

	const msg: Message = {
		id: s.nextMessageId++,
		organization_id: channel.organization_id,
		conversation_id: conv.id,
		channel_id: channel.id,
		external_message_id: params.externalMessageId ?? null,
		direction: 'outbound',
		sender_type: 'external_human',
		sender_user_id: null,
		sender_label: 'App externa',
		body: bodyText,
		attachments: [],
		status: 'sent',
		error_code: null,
		error_detail: null,
		day_group: 'Hoy',
		display_time: timeStr,
		created_at: nowIso
	};
	s.messages.push(msg);

	// Guardrail obligatorio (AGENTS.md §5): eco saliente externo pausa IA de inmediato
	conv.ai_paused = true;
	conv.ai_handoff_reason = 'Respuesta manual desde app externa';
	conv.ai_reply_count = 0;
	conv.needs_reply = false;
	conv.unread_count = 0;
	conv.last_message_preview = `Externo: ${bodyText}`;
	conv.last_message_at = nowIso;
	conv.display_time = timeStr;
	conv.updated_at = nowIso;
	return true;
}

export function updateMessageDeliveryStatus(params: {
	externalAccountId: string;
	externalMessageId: string;
	status: 'delivered' | 'read' | 'failed';
	errorCode?: string;
	errorDetail?: string;
}): boolean {
	if (!params.externalMessageId) return false;
	const s = getState();
	const channel = findChannelByExternalAccountId(params.externalAccountId);
	if (!channel) return false;

	const msg = s.messages.find(
		(m) =>
			m.channel_id === channel.id &&
			m.external_message_id === params.externalMessageId
	);
	if (!msg) return false;

	// Evita retroceder un estado 'read' a 'delivered' si un webhook llega desordenado.
	if (msg.status === 'read' && params.status === 'delivered') {
		return true;
	}

	msg.status = params.status;
	if (params.status === 'failed') {
		msg.error_code = params.errorCode ?? 'DELIVERY_FAILED';
		msg.error_detail = params.errorDetail ?? 'No se pudo entregar el mensaje en el canal.';
	} else {
		msg.error_code = null;
		msg.error_detail = null;
	}
	return true;
}

import {
	DEMO_SIM_CONTACT_EMAIL,
	DEMO_SIM_CONTACT_NAME,
	DEMO_SIM_DEAL_TITLE,
	type DemoLeadState
} from '$lib/types/domain';
import { matchOpenStage, scoreForDemoStage } from './demo-lead';

export function markChannelDisconnectedByExternalId(params: {
	externalAccountId: string;
	reason?: string;
	disconnectionType?: string;
	gracePeriodEndsAt?: string;
}): ConnectedChannel | null {
	const channel = findChannelByExternalAccountId(params.externalAccountId);
	if (!channel) return null;

	channel.status = 'disconnected';
	channel.updated_at = new Date().toISOString();
	channel.metadata = {
		...channel.metadata,
		...(params.disconnectionType ? { disconnection_type: params.disconnectionType } : {}),
		...(params.reason ? { disconnection_reason: params.reason } : {}),
		...(params.gracePeriodEndsAt ? { grace_period_ends_at: params.gracePeriodEndsAt } : {})
	};
	return channel;
}

function getOrCreateMemDemoLeadRecords(organizationId: string, ownerUserId: string | null) {
	const s = getState();
	const org = getOrganizationById(organizationId);
	if (!org) throw new Error('Workspace no encontrado');

	const openStages = s.stages
		.filter((st) => st.organization_id === organizationId && !st.is_terminal)
		.sort((a, b) => a.position - b.position);
	if (openStages.length === 0) {
		throw new Error('No hay etapas activas en el pipeline');
	}
	const firstStage = openStages[0];
	const nowIso = new Date().toISOString();

	let contact = s.contacts.find(
		(c) => c.organization_id === organizationId && c.email === DEMO_SIM_CONTACT_EMAIL
	);
	if (!contact) {
		contact = {
			id: `cnt_demo_${organizationId}`,
			organization_id: organizationId,
			name: DEMO_SIM_CONTACT_NAME,
			company: 'Simulador IA',
			role_title: 'Prospecto de prueba',
			avatar_url: null,
			email: DEMO_SIM_CONTACT_EMAIL,
			phone: null,
			owner_user_id: ownerUserId,
			tags: ['demo-ia'],
			lead_score: 50,
			lead_summary: 'Listo para iniciar prueba con el asistente IA.',
			ai_intent_label: 'Lead nuevo (simulación)',
			next_step_title: 'Esperando primer mensaje de prueba',
			next_step_at_label: 'Ahora',
			next_step_overdue: false,
			created_at: nowIso,
			updated_at: nowIso
		};
		s.contacts.unshift(contact);
	}

	let deal = s.deals.find(
		(d) => d.organization_id === organizationId && d.contact_id === contact.id
	);
	if (!deal) {
		const maxPos = s.deals
			.filter((d) => d.organization_id === organizationId && d.stage_id === firstStage.id)
			.reduce((max, d) => Math.max(max, d.position), 0);
		deal = {
			id: `deal_demo_${organizationId}`,
			organization_id: organizationId,
			pipeline_id: firstStage.pipeline_id,
			stage_id: firstStage.id,
			contact_id: contact.id,
			conversation_id: null,
			owner_user_id: ownerUserId,
			title: DEMO_SIM_DEAL_TITLE,
			deal_type: 'Prueba IA',
			value_cents: 0,
			currency: org.currency,
			position: maxPos + 1000,
			last_moved_by: 'ai',
			ai_last_reason: 'Lead nuevo listo para probar el asistente IA.',
			ai_updated_label: 'Ahora',
			next_step_title: 'Esperando primer mensaje de prueba',
			next_step_label: 'Ahora',
			next_step_overdue: false,
			stage_age_label: 'Recién creada',
			created_age_label: 'Creada hoy',
			qualification_data: {},
			created_at: nowIso,
			updated_at: nowIso
		};
		s.deals.push(deal);
	}

	return { openStages, firstStage, contact, deal };
}

export function ensureAndResetDemoLead(
	organizationId: string,
	ownerUserId: string | null
): DemoLeadState {
	const { firstStage, contact, deal } = getOrCreateMemDemoLeadRecords(organizationId, ownerUserId);
	const nowIso = new Date().toISOString();

	contact.name = DEMO_SIM_CONTACT_NAME;
	contact.company = 'Simulador IA';
	contact.tags = ['demo-ia'];
	contact.owner_user_id = ownerUserId ?? contact.owner_user_id;
	contact.lead_score = 50;
	contact.ai_intent_label = 'Lead nuevo (simulación)';
	contact.lead_summary = 'Listo para iniciar prueba con el asistente IA.';
	contact.next_step_title = 'Esperando primer mensaje de prueba';
	contact.next_step_at_label = 'Ahora';
	contact.updated_at = nowIso;

	deal.stage_id = firstStage.id;
	deal.owner_user_id = ownerUserId ?? deal.owner_user_id;
	deal.last_moved_by = 'ai';
	deal.ai_last_reason = 'Lead nuevo listo para probar el asistente IA.';
	deal.ai_updated_label = 'Ahora';
	deal.next_step_title = 'Esperando primer mensaje de prueba';
	deal.next_step_label = 'Ahora';
	deal.next_step_overdue = false;
	deal.qualification_data = {};
	deal.updated_at = nowIso;

	return {
		contactId: contact.id,
		dealId: deal.id,
		stageId: firstStage.id,
		stageName: firstStage.name,
		stageSlug: firstStage.slug
	};
}

export function syncDemoLeadStageFromAi(params: {
	organizationId: string;
	ownerUserId: string | null;
	recommendedStageName: string;
	intentSummary: string;
	followUpAction: string;
	needsHumanHandoff: boolean;
}): DemoLeadState {
	const { openStages, contact, deal } = getOrCreateMemDemoLeadRecords(
		params.organizationId,
		params.ownerUserId
	);
	const targetStage = matchOpenStage(openStages, params.recommendedStageName, deal.stage_id);
	const nowIso = new Date().toISOString();

	deal.stage_id = targetStage.id;
	deal.last_moved_by = 'ai';
	deal.ai_last_reason = params.intentSummary;
	deal.ai_updated_label = 'Ahora';
	deal.next_step_title = params.followUpAction;
	deal.next_step_label = params.followUpAction;
	deal.qualification_data = {
		demo_simulation: true,
		needs_human_handoff: params.needsHumanHandoff,
		recommended_stage_name: targetStage.name,
		updated_at: nowIso
	};
	deal.updated_at = nowIso;

	contact.ai_intent_label = params.intentSummary;
	contact.lead_summary = params.followUpAction;
	contact.next_step_title = params.followUpAction;
	contact.lead_score = scoreForDemoStage(targetStage.slug);
	contact.updated_at = nowIso;

	return {
		contactId: contact.id,
		dealId: deal.id,
		stageId: targetStage.id,
		stageName: targetStage.name,
		stageSlug: targetStage.slug
	};
}

export function getConversationAndChannel(organizationId: string, conversationId: string) {
	const s = getState();
	const conv =
		s.conversations.find(
			(c) => c.id === conversationId && c.organization_id === organizationId
		) ?? null;
	const channel = conv
		? (s.channels.find((ch) => ch.id === conv.channel_id && ch.organization_id === organizationId) ??
			null)
		: null;
	return { conv, channel };
}

export function getContactById(organizationId: string, contactId: string): Contact | null {
	const s = getState();
	return s.contacts.find((c) => c.id === contactId && c.organization_id === organizationId) ?? null;
}

export function getChannelById(organizationId: string, channelId: string): ConnectedChannel | null {
	const s = getState();
	return (
		s.channels.find((ch) => ch.id === channelId && ch.organization_id === organizationId) ?? null
	);
}

export function getConversationMessagesPage(
	organizationId: string,
	conversationId: string,
	opts: { beforeId?: number; limit?: number } = {}
): { messages: Message[]; hasMore: boolean; nextBeforeId: number | null } {
	const limit = Math.min(100, Math.max(1, opts.limit ?? 40));
	const s = getState();
	const filtered = s.messages
		.filter(
			(m) =>
				m.organization_id === organizationId &&
				m.conversation_id === conversationId &&
				(opts.beforeId === undefined || m.id < opts.beforeId)
		)
		.sort((a, b) => b.id - a.id);

	const hasMore = filtered.length > limit;
	const sliced = hasMore ? filtered.slice(0, limit) : filtered;
	const messages = [...sliced].reverse();
	return {
		messages,
		hasMore,
		nextBeforeId: hasMore ? (messages[0]?.id ?? null) : null
	};
}

export function getAiDraftContext(org: Organization, conversationId: string) {
	const s = getState();
	const conv =
		s.conversations.find((c) => c.id === conversationId && c.organization_id === org.id) ?? null;
	const contact = conv
		? (s.contacts.find((c) => c.id === conv.contact_id && c.organization_id === org.id) ?? null)
		: null;
	const recentMessages = conv
		? s.messages
				.filter((m) => m.organization_id === org.id && m.conversation_id === conversationId)
				.slice(-15)
		: [];
	const aiSettings = s.aiSettings.find((a) => a.organization_id === org.id) ?? null;
	const readyDocs = s.knowledgeDocuments
		.filter((d) => d.organization_id === org.id && d.status === 'ready')
		.slice(0, 5);
	const openStages = s.stages
		.filter((st) => st.organization_id === org.id && !st.is_terminal)
		.sort((a, b) => a.position - b.position);
	const usagePeriod = s.usagePeriods.find((u) => u.organization_id === org.id) ?? null;
	const activeChannelsCount = s.channels.filter(
		(c) => c.organization_id === org.id && c.status === 'active'
	).length;
	const usageSummary = usagePeriod ? getUsageSummary(org, usagePeriod, activeChannelsCount) : null;

	return {
		conv,
		contact,
		recentMessages,
		aiSettings,
		readyDocs,
		openStages,
		usageSummary
	};
}
