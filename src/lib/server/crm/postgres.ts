import type { SupabaseClient } from '@supabase/supabase-js';
import { GEMINI_EMBEDDING_MODEL, generateTextEmbedding } from '$lib/server/ai/client';
import {
	ingestKnowledgeSource,
	reingestKnowledgeFileOrUrl,
	type KnowledgeUploadedFile
} from '$lib/server/ai/knowledge-ingest';
import {
	chunkKnowledgeText,
	formatPgVector,
	validateSafeExternalUrl
} from '$lib/server/ai/rag';
import { recordAiUsageLedger } from '$lib/server/ai/usage';
import {
	getUsageSummary,
	TRIAL_DAYS,
	TRIAL_INCLUDED_AI_REPLIES,
	TRIAL_KB_DOCUMENT_LIMIT
} from '$lib/server/billing/plans';
import { getChannelProvider } from '$lib/server/channels/zernio';
import { deletePrivateStorageFile } from '$lib/server/storage';
import { getSupabaseAdminClient } from '$lib/server/supabase-admin';
import type { Database, Json } from '$lib/types/database.types';
import {
	hasMinRole,
	type AiSettings,
	type ConnectedChannel,
	type Contact,
	type ContactIdentity,
	type ContactNote,
	type Conversation,
	type Deal,
	type DemoLeadState,
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

type DbClient = SupabaseClient<Database>;
type Tables = Database['public']['Tables'];

function unwrapSingle<T>(val: T | T[] | null | undefined): T | null {
	if (Array.isArray(val)) return val[0] ?? null;
	return val ?? null;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

export function isUuid(value: string | null | undefined): boolean {
	return Boolean(value && UUID_REGEX.test(value.trim()));
}

export async function hashTokenSha256(token: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token));
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

function computeInitials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
	return (parts[0]?.slice(0, 2) ?? 'OK').toUpperCase();
}

function formatDisplayTime(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return 'Ahora';
	return d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatDayGroup(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return 'Hoy';
	const now = new Date();
	const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const startTarget = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	const diffDays = Math.round((startToday - startTarget) / 86400_000);
	if (diffDays <= 0) return 'Hoy';
	if (diffDays === 1) return 'Ayer';
	return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
}

function formatNextStepLabel(iso: string | null): { label: string | null; overdue: boolean } {
	if (!iso) return { label: null, overdue: false };
	const ts = Date.parse(iso);
	if (Number.isNaN(ts)) return { label: null, overdue: false };
	const overdue = ts < Date.now();
	const d = new Date(ts);
	const now = new Date();
	const sameDay =
		d.getFullYear() === now.getFullYear() &&
		d.getMonth() === now.getMonth() &&
		d.getDate() === now.getDate();
	if (sameDay) {
		return {
			label: `Hoy, ${d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false })}`,
			overdue
		};
	}
	return {
		label: d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' }),
		overdue
	};
}

function parseNextStepAt(label: string | undefined): string | null {
	const trimmed = label?.trim() ?? '';
	if (!trimmed) return null;
	const lower = trimmed.toLowerCase();
	const now = new Date();

	if (lower.startsWith('hoy')) {
		const timeMatch = lower.match(/(\d{1,2}):(\d{2})/);
		const target = new Date(now);
		if (timeMatch) {
			target.setHours(Number(timeMatch[1]), Number(timeMatch[2]), 0, 0);
		} else {
			target.setHours(18, 0, 0, 0);
		}
		return target.toISOString();
	}

	if (lower.startsWith('mañana') || lower.startsWith('manana')) {
		return new Date(now.getTime() + 86400_000).toISOString();
	}

	const parsed = Date.parse(trimmed);
	if (!Number.isNaN(parsed)) {
		return new Date(parsed).toISOString();
	}

	return new Date(now.getTime() + 86400_000).toISOString();
}

function formatAgeLabel(iso: string, prefix: string): string {
	const diffHrs = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 3600_000));
	if (diffHrs < 1) return `${prefix} hoy`;
	if (diffHrs < 24) return `${diffHrs}h`;
	const days = Math.round(diffHrs / 24);
	return `${days}d`;
}

function mapProfile(row: Tables['profiles']['Row']): Profile {
	const name = row.full_name || row.email.split('@')[0] || 'Usuario';
	return {
		id: row.id,
		full_name: name,
		initials: computeInitials(name),
		avatar_url: row.avatar_url,
		email: row.email,
		created_at: row.created_at,
		updated_at: row.updated_at
	};
}

function mapOrganization(row: Tables['organizations']['Row']): Organization {
	return {
		id: row.id,
		name: row.name,
		slug: row.slug,
		industry: row.industry,
		language: row.language,
		currency: row.currency,
		zernio_profile_id: row.zernio_profile_id ?? '',
		subscription_status: row.subscription_status as Organization['subscription_status'],
		billing_mode: row.billing_mode as Organization['billing_mode'],
		stripe_customer_id: row.stripe_customer_id,
		stripe_subscription_id: row.stripe_subscription_id,
		stripe_channel_item_id: row.stripe_channel_item_id,
		stripe_ai_overage_item_id: row.stripe_ai_overage_item_id,
		channel_slots: row.channel_slots,
		included_ai_replies_per_channel: row.included_ai_replies_per_channel,
		ai_overage_enabled: row.ai_overage_enabled,
		kb_document_limit: row.kb_document_limit,
		trial_ends_at: row.trial_ends_at,
		current_period_start: row.current_period_start,
		current_period_end: row.current_period_end,
		created_at: row.created_at
	};
}

function mapChannel(row: Tables['connected_channels']['Row']): ConnectedChannel {
	return {
		id: row.id,
		organization_id: row.organization_id,
		provider: 'zernio',
		platform: row.platform as Platform,
		external_account_id: row.external_account_id,
		display_name: row.display_name,
		handle_or_phone: row.handle_or_phone,
		status: row.status as ConnectedChannel['status'],
		metadata:
			typeof row.metadata === 'object' && row.metadata !== null && !Array.isArray(row.metadata)
				? (row.metadata as Record<string, unknown>)
				: {},
		created_at: row.created_at,
		updated_at: row.updated_at
	};
}

function mapContact(row: Tables['contacts']['Row']): Contact {
	const step = formatNextStepLabel(row.next_step_at);
	return {
		id: row.id,
		organization_id: row.organization_id,
		name: row.name,
		company: row.company,
		role_title: row.role_title,
		avatar_url: row.avatar_url,
		email: row.email,
		phone: row.phone,
		owner_user_id: row.owner_user_id,
		tags: row.tags ?? [],
		lead_score: row.lead_score,
		lead_summary: row.lead_summary,
		ai_intent_label: row.ai_intent_label,
		next_step_title: row.next_step_title,
		next_step_at_label: step.label,
		next_step_overdue: step.overdue,
		created_at: row.created_at,
		updated_at: row.updated_at
	};
}

function mapIdentity(row: Tables['contact_identities']['Row']): ContactIdentity {
	return {
		id: row.id,
		organization_id: row.organization_id,
		contact_id: row.contact_id,
		platform: row.platform as Platform,
		external_user_id: row.external_user_id,
		username_or_phone: row.username_or_phone,
		created_at: row.created_at
	};
}

function mapConversation(row: Tables['conversations']['Row']): Conversation {
	return {
		id: row.id,
		organization_id: row.organization_id,
		channel_id: row.channel_id,
		contact_id: row.contact_id,
		external_thread_id: row.external_thread_id,
		platform: row.platform as Platform,
		status: row.status as Conversation['status'],
		assigned_to: row.assigned_to,
		needs_reply: row.needs_reply,
		ai_paused: row.ai_paused,
		ai_handoff_reason: row.ai_handoff_reason,
		ai_reply_count: row.ai_reply_count,
		ai_processing_locked_until: row.ai_processing_locked_until,
		last_processed_inbound_message_id: row.last_processed_inbound_message_id,
		last_inbound_at: row.last_inbound_at,
		last_message_preview: row.last_message_preview,
		last_message_at: row.last_message_at,
		display_time: formatDisplayTime(row.last_message_at),
		unread_count: row.unread_count,
		created_at: row.created_at,
		updated_at: row.updated_at
	};
}

function mapMessage(row: Tables['messages']['Row']): Message {
	return {
		id: row.id,
		organization_id: row.organization_id,
		conversation_id: row.conversation_id,
		channel_id: row.channel_id,
		external_message_id: row.external_message_id,
		direction: row.direction as Message['direction'],
		sender_type: row.sender_type as Message['sender_type'],
		sender_user_id: row.sender_user_id,
		sender_label: row.sender_label ?? (row.direction === 'inbound' ? 'Cliente' : 'Equipo'),
		body: row.body,
		attachments: (Array.isArray(row.attachments)
			? row.attachments
			: []) as unknown as MessageAttachment[],
		status: row.status as Message['status'],
		error_code: row.error_code,
		error_detail: row.error_detail,
		day_group: formatDayGroup(row.created_at),
		display_time: formatDisplayTime(row.created_at),
		created_at: row.created_at
	};
}

function mapDeal(row: Tables['deals']['Row']): Deal {
	const step = formatNextStepLabel(row.next_step_at);
	return {
		id: row.id,
		organization_id: row.organization_id,
		pipeline_id: row.pipeline_id,
		stage_id: row.stage_id,
		contact_id: row.contact_id,
		conversation_id: row.conversation_id,
		owner_user_id: row.owner_user_id,
		title: row.title,
		deal_type: row.deal_type,
		value_cents: row.value_cents,
		currency: row.currency,
		position: row.position,
		last_moved_by: row.last_moved_by as Deal['last_moved_by'],
		ai_last_reason: row.ai_last_reason,
		ai_updated_label:
			row.last_moved_by === 'ai' ? `IA ${formatAgeLabel(row.updated_at, 'hace')}` : null,
		next_step_title: row.next_step_title,
		next_step_label: step.label,
		next_step_overdue: step.overdue,
		stage_age_label: formatAgeLabel(row.updated_at, 'En etapa'),
		created_age_label: formatAgeLabel(row.created_at, 'Creada'),
		qualification_data:
			typeof row.qualification_data === 'object' &&
			row.qualification_data !== null &&
			!Array.isArray(row.qualification_data)
				? (row.qualification_data as Record<string, unknown>)
				: {},
		created_at: row.created_at,
		updated_at: row.updated_at
	};
}

function mapKnowledgeDoc(row: Tables['knowledge_documents']['Row']): KnowledgeDocument {
	return {
		id: row.id,
		organization_id: row.organization_id,
		title: row.title,
		subtitle: row.subtitle,
		source_type: row.source_type as KnowledgeDocument['source_type'],
		source_url: row.source_url,
		storage_path: row.storage_path,
		content_preview: row.content_preview,
		embedding_model: row.embedding_model,
		status: row.status as KnowledgeDocument['status'],
		error_detail: row.error_detail,
		created_at: row.created_at
	};
}

function mapStage(row: Tables['pipeline_stages']['Row']): PipelineStage {
	return {
		id: row.id,
		organization_id: row.organization_id,
		pipeline_id: row.pipeline_id,
		name: row.name,
		slug: row.slug,
		color: row.color,
		position: row.position,
		is_terminal: row.is_terminal,
		ai_qualification_hint: row.ai_qualification_hint,
		created_at: row.created_at
	};
}

function mapAiSettings(row: Tables['ai_settings']['Row']): AiSettings {
	return {
		organization_id: row.organization_id,
		enabled: row.enabled,
		auto_reply_enabled: row.auto_reply_enabled,
		auto_qualify_enabled: row.auto_qualify_enabled,
		handle_inbound_audio: row.handle_inbound_audio as AiSettings['handle_inbound_audio'],
		business_context: row.business_context,
		tone: row.tone as AiSettings['tone'],
		handoff_rules: row.handoff_rules,
		max_ai_replies_per_thread: row.max_ai_replies_per_thread,
		updated_at: row.updated_at
	};
}

function mapUsagePeriod(row: Tables['org_usage_periods']['Row']): OrgUsagePeriod {
	return {
		id: row.id,
		organization_id: row.organization_id,
		period_start: row.period_start,
		period_end: row.period_end,
		included_ai_replies: row.included_ai_replies,
		used_ai_replies: row.used_ai_replies,
		overage_ai_replies: row.overage_ai_replies,
		draft_count: row.draft_count,
		test_chat_count: row.test_chat_count,
		updated_at: row.updated_at
	};
}

function mapMemberRow(row: {
	organization_id: string;
	user_id: string;
	role: string;
	created_at: string;
	profiles?: Tables['profiles']['Row'] | Tables['profiles']['Row'][] | null;
}): OrganizationMember {
	const profileRow = unwrapSingle(row.profiles);
	const profile: Profile = profileRow
		? mapProfile(profileRow)
		: {
				id: row.user_id,
				full_name: 'Miembro',
				initials: 'MI',
				avatar_url: null,
				email: '',
				created_at: row.created_at,
				updated_at: row.created_at
			};
	return {
		organization_id: row.organization_id,
		user_id: row.user_id,
		role: row.role as OrgRole,
		profile,
		created_at: row.created_at
	};
}

function buildProfileNameMap(members: OrganizationMember[]): Map<string, string> {
	return new Map(members.map((m) => [m.user_id, m.profile.full_name]));
}

function mapNoteRow(
	row: Tables['contact_notes']['Row'],
	profileNames: Map<string, string>
): ContactNote {
	return {
		id: row.id,
		organization_id: row.organization_id,
		contact_id: row.contact_id,
		conversation_id: row.conversation_id,
		author_user_id: row.author_user_id ?? '',
		author_name: row.author_user_id
			? (profileNames.get(row.author_user_id) ?? 'Equipo')
			: 'Equipo',
		body: row.body,
		created_at: row.created_at,
		display_time: `${formatDayGroup(row.created_at)}, ${formatDisplayTime(row.created_at)}`
	};
}

function mapInvitationRow(
	row: Tables['organization_invitations']['Row'],
	org: Pick<Organization, 'name' | 'slug'>,
	profileNames: Map<string, string>
): OrganizationInvitation {
	return {
		id: row.id,
		organization_id: row.organization_id,
		organization_name: org.name,
		organization_slug: org.slug,
		email: row.email,
		role: row.role as Exclude<OrgRole, 'owner'>,
		token_hash: row.token_hash,
		demo_token: '',
		invited_by_name: row.invited_by
			? (profileNames.get(row.invited_by) ?? 'Admin')
			: 'Admin',
		status: row.status as OrganizationInvitation['status'],
		expires_at: row.expires_at,
		accepted_at: row.accepted_at,
		created_at: row.created_at
	};
}

function buildTimelineEvents(
	organizationId: string,
	conversations: Conversation[],
	deals: Pick<Deal, 'id' | 'contact_id'>[]
): TimelineEvent[] {
	return conversations.slice(0, 20).map((c) => ({
		id: `evt_conv_${c.id}`,
		organization_id: organizationId,
		contact_id: c.contact_id,
		deal_id: deals.find((d) => d.contact_id === c.contact_id)?.id ?? null,
		title: `Conversación por ${c.platform === 'whatsapp' ? 'WhatsApp' : c.platform === 'instagram' ? 'Instagram' : 'Messenger'}`,
		detail: c.last_message_preview || 'Conversación activa',
		timestamp_label: `${formatDayGroup(c.last_message_at)}, ${c.display_time}`,
		created_at: c.created_at
	}));
}

function requireAdminDb(): DbClient {
	const admin = getSupabaseAdminClient();
	if (!admin) {
		throw new Error('SUPABASE_SERVICE_ROLE_KEY no está configurado en el servidor.');
	}
	return admin;
}

export async function pgGetOrganizationBySlug(
	supabase: DbClient,
	slug: string
): Promise<Organization | null> {
	const { data, error } = await supabase
		.from('organizations')
		.select('*')
		.eq('slug', slug)
		.maybeSingle();
	if (error || !data) return null;
	return mapOrganization(data);
}

export async function pgGetOrganizationById(
	supabase: DbClient,
	organizationId: string
): Promise<Organization | null> {
	if (!isUuid(organizationId)) return null;
	const { data, error } = await supabase
		.from('organizations')
		.select('*')
		.eq('id', organizationId)
		.maybeSingle();
	if (error || !data) return null;
	return mapOrganization(data);
}

export async function pgListUserOrganizations(
	supabase: DbClient,
	userId: string
): Promise<Array<Organization & { role: OrgRole }>> {
	if (!isUuid(userId)) return [];
	const { data: memberships, error } = await supabase
		.from('organization_members')
		.select('role, organizations(*)')
		.eq('user_id', userId);
	if (error || !memberships || memberships.length === 0) return [];

	const items: Array<Organization & { role: OrgRole }> = [];
	for (const row of memberships) {
		const orgRow = unwrapSingle(row.organizations);
		if (!orgRow) continue;
		items.push({
			...mapOrganization(orgRow),
			role: row.role as OrgRole
		});
	}
	return items.sort(
		(a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
	);
}

export async function pgGetMembership(
	supabase: DbClient,
	organizationId: string,
	userId: string
): Promise<OrganizationMember | null> {
	if (!isUuid(organizationId) || !isUuid(userId)) return null;
	const { data: memberRow, error } = await supabase
		.from('organization_members')
		.select('organization_id, user_id, role, created_at, profiles(*)')
		.eq('organization_id', organizationId)
		.eq('user_id', userId)
		.maybeSingle();
	if (error || !memberRow) return null;

	return mapMemberRow(memberRow);
}

export async function pgRequireOrgMembership(
	supabase: DbClient,
	organizationId: string,
	userId: string,
	minRole: OrgRole = 'viewer'
): Promise<{ org: Organization; member: OrganizationMember; effectiveRole: OrgRole }> {
	if (!isUuid(organizationId)) {
		throw new Error('Organización no encontrada');
	}
	if (!isUuid(userId)) {
		throw new Error('No perteneces a este workspace');
	}

	const { data: row, error } = await supabase
		.from('organization_members')
		.select('organization_id, user_id, role, created_at, organizations(*), profiles(*)')
		.eq('organization_id', organizationId)
		.eq('user_id', userId)
		.maybeSingle();

	const orgRow = !error && row ? unwrapSingle(row.organizations) : null;
	if (!row || !orgRow) {
		const orgCheck = await pgGetOrganizationById(supabase, organizationId);
		if (!orgCheck) {
			throw new Error('Organización no encontrada');
		}
		throw new Error('No perteneces a este workspace');
	}

	const org = mapOrganization(orgRow);
	const member = mapMemberRow(row);
	// En sesiones Supabase reales nunca se permite override con demoRole.
	const effectiveRole = member.role;
	if (!hasMinRole(effectiveRole, minRole)) {
		throw new Error(`Permisos insuficientes (requiere rol ${minRole})`);
	}
	return { org, member, effectiveRole };
}

export async function pgGetWorkspaceAccessBySlug(
	supabase: DbClient,
	slug: string,
	userId: string
): Promise<
	| { authorized: true; org: Organization; role: OrgRole }
	| { authorized: false; deniedOrgName: string }
> {
	if (!isUuid(userId)) {
		return { authorized: false, deniedOrgName: slug };
	}

	const { data, error } = await supabase
		.from('organization_members')
		.select('role, organizations!inner(*)')
		.eq('user_id', userId)
		.eq('organizations.slug', slug)
		.maybeSingle();

	const orgRow = !error && data ? unwrapSingle(data.organizations) : null;
	if (!data || !orgRow) {
		return { authorized: false, deniedOrgName: slug };
	}

	return {
		authorized: true,
		org: mapOrganization(orgRow),
		role: data.role as OrgRole
	};
}

export async function pgListWorkspaceMembers(
	supabase: DbClient,
	organizationId: string
): Promise<OrganizationMember[]> {
	if (!isUuid(organizationId)) return [];
	const { data } = await supabase
		.from('organization_members')
		.select('organization_id, user_id, role, created_at, profiles(*)')
		.eq('organization_id', organizationId)
		.order('created_at', { ascending: true });
	return (data ?? []).map(mapMemberRow);
}

export async function pgListWorkspaceChannels(
	supabase: DbClient,
	organizationId: string
): Promise<ConnectedChannel[]> {
	if (!isUuid(organizationId)) return [];
	const { data } = await supabase
		.from('connected_channels')
		.select('*')
		.eq('organization_id', organizationId)
		.order('created_at', { ascending: true });
	return (data ?? []).map(mapChannel);
}

export async function pgGetLatestUsagePeriod(
	supabase: DbClient,
	organizationId: string
): Promise<OrgUsagePeriod | null> {
	if (!isUuid(organizationId)) return null;
	const { data } = await supabase
		.from('org_usage_periods')
		.select('*')
		.eq('organization_id', organizationId)
		.order('period_start', { ascending: false })
		.limit(1)
		.maybeSingle();
	return data ? mapUsagePeriod(data) : null;
}

export async function pgCountOpenConversations(
	supabase: DbClient,
	organizationId: string
): Promise<number> {
	if (!isUuid(organizationId)) return 0;
	const { count, error } = await supabase
		.from('conversations')
		.select('id', { count: 'exact', head: true })
		.eq('organization_id', organizationId)
		.neq('status', 'closed');
	if (error) return 0;
	return count ?? 0;
}

export async function pgGetInboxPageData(
	supabase: DbClient,
	organizationId: string,
	membersPromise: Promise<OrganizationMember[]>,
	channelsPromise: Promise<ConnectedChannel[]>
) {
	const [
		members,
		channels,
		convsRes,
		contactsRes,
		identitiesRes,
		msgsRes,
		notesRes,
		dealsRes,
		stagesRes
	] = await Promise.all([
		membersPromise,
		channelsPromise,
		supabase
			.from('conversations')
			.select('*')
			.eq('organization_id', organizationId)
			.order('last_message_at', { ascending: false })
			.limit(50),
		supabase
			.from('contacts')
			.select('*')
			.eq('organization_id', organizationId)
			.order('created_at', { ascending: false }),
		supabase.from('contact_identities').select('*').eq('organization_id', organizationId),
		supabase
			.from('messages')
			.select('*')
			.eq('organization_id', organizationId)
			.order('created_at', { ascending: false })
			.order('id', { ascending: false })
			.limit(100),
		supabase
			.from('contact_notes')
			.select('*')
			.eq('organization_id', organizationId)
			.order('created_at', { ascending: false }),
		supabase
			.from('deals')
			.select('*')
			.eq('organization_id', organizationId)
			.order('position', { ascending: true }),
		supabase
			.from('pipeline_stages')
			.select('*')
			.eq('organization_id', organizationId)
			.order('position', { ascending: true })
	]);

	const profileNames = buildProfileNameMap(members);
	const conversations = (convsRes.data ?? []).map(mapConversation);
	const contacts = (contactsRes.data ?? []).map(mapContact);
	const identities = (identitiesRes.data ?? []).map(mapIdentity);
	const messages = [...(msgsRes.data ?? [])].reverse().map(mapMessage);
	const notes = (notesRes.data ?? []).map((n) => mapNoteRow(n, profileNames));
	const deals = (dealsRes.data ?? []).map(mapDeal);
	const stages = (stagesRes.data ?? []).map(mapStage);
	const timelineEvents = buildTimelineEvents(organizationId, conversations, deals);

	return {
		members,
		channels,
		conversations,
		contacts,
		identities,
		messages,
		notes,
		deals,
		stages,
		timelineEvents
	};
}

export async function pgGetPipelinePageData(
	supabase: DbClient,
	organizationId: string,
	membersPromise: Promise<OrganizationMember[]>
) {
	const [members, stagesRes, dealsRes, contactsRes, notesRes, convsRes] = await Promise.all([
		membersPromise,
		supabase
			.from('pipeline_stages')
			.select('*')
			.eq('organization_id', organizationId)
			.order('position', { ascending: true }),
		supabase
			.from('deals')
			.select('*')
			.eq('organization_id', organizationId)
			.order('position', { ascending: true }),
		supabase
			.from('contacts')
			.select('*')
			.eq('organization_id', organizationId)
			.order('created_at', { ascending: false }),
		supabase
			.from('contact_notes')
			.select('*')
			.eq('organization_id', organizationId)
			.order('created_at', { ascending: false }),
		supabase
			.from('conversations')
			.select('*')
			.eq('organization_id', organizationId)
			.order('last_message_at', { ascending: false })
			.limit(20)
	]);

	const profileNames = buildProfileNameMap(members);
	const stages = (stagesRes.data ?? []).map(mapStage);
	const deals = (dealsRes.data ?? []).map(mapDeal);
	const contacts = (contactsRes.data ?? []).map(mapContact);
	const notes = (notesRes.data ?? []).map((n) => mapNoteRow(n, profileNames));
	const conversations = (convsRes.data ?? []).map(mapConversation);
	const timelineEvents = buildTimelineEvents(organizationId, conversations, deals);

	return { members, stages, deals, contacts, notes, timelineEvents };
}

export async function pgGetContactsPageData(
	supabase: DbClient,
	organizationId: string,
	membersPromise: Promise<OrganizationMember[]>
) {
	const [members, contactsRes, identitiesRes] = await Promise.all([
		membersPromise,
		supabase
			.from('contacts')
			.select('*')
			.eq('organization_id', organizationId)
			.order('created_at', { ascending: false }),
		supabase.from('contact_identities').select('*').eq('organization_id', organizationId)
	]);

	return {
		members,
		contacts: (contactsRes.data ?? []).map(mapContact),
		identities: (identitiesRes.data ?? []).map(mapIdentity)
	};
}

export async function pgGetContactDetailPageData(
	supabase: DbClient,
	organizationId: string,
	contactId: string,
	membersPromise: Promise<OrganizationMember[]>
) {
	if (!isUuid(organizationId) || !isUuid(contactId)) return null;

	const [members, contactRes, identitiesRes, dealsRes, stagesRes, notesRes, convsRes] =
		await Promise.all([
			membersPromise,
			supabase
				.from('contacts')
				.select('*')
				.eq('organization_id', organizationId)
				.eq('id', contactId)
				.maybeSingle(),
			supabase
				.from('contact_identities')
				.select('*')
				.eq('organization_id', organizationId)
				.eq('contact_id', contactId),
			supabase
				.from('deals')
				.select('*')
				.eq('organization_id', organizationId)
				.eq('contact_id', contactId)
				.order('position', { ascending: true }),
			supabase
				.from('pipeline_stages')
				.select('*')
				.eq('organization_id', organizationId)
				.order('position', { ascending: true }),
			supabase
				.from('contact_notes')
				.select('*')
				.eq('organization_id', organizationId)
				.eq('contact_id', contactId)
				.order('created_at', { ascending: false }),
			supabase
				.from('conversations')
				.select('*')
				.eq('organization_id', organizationId)
				.eq('contact_id', contactId)
				.order('last_message_at', { ascending: false })
				.limit(20)
		]);

	if (contactRes.error || !contactRes.data) return null;

	const profileNames = buildProfileNameMap(members);
	const contact = mapContact(contactRes.data);
	const identities = (identitiesRes.data ?? []).map(mapIdentity);
	const deals = (dealsRes.data ?? []).map(mapDeal);
	const stages = (stagesRes.data ?? []).map(mapStage);
	const notes = (notesRes.data ?? []).map((n) => mapNoteRow(n, profileNames));
	const conversations = (convsRes.data ?? []).map(mapConversation);
	const timelineEvents = buildTimelineEvents(organizationId, conversations, deals);

	return {
		contact,
		identities,
		deals,
		stages,
		notes,
		conversation: conversations[0] ?? null,
		timelineEvents,
		members
	};
}

export async function pgGetAiPageData(
	supabase: DbClient,
	organizationId: string,
	demoEmail: string
) {
	const [aiRes, kbRes, stagesRes, demoContactRes, dealsRes] = await Promise.all([
		supabase.from('ai_settings').select('*').eq('organization_id', organizationId).maybeSingle(),
		supabase
			.from('knowledge_documents')
			.select('*')
			.eq('organization_id', organizationId)
			.order('created_at', { ascending: false }),
		supabase
			.from('pipeline_stages')
			.select('*')
			.eq('organization_id', organizationId)
			.eq('is_terminal', false)
			.order('position', { ascending: true }),
		supabase
			.from('contacts')
			.select('id, email')
			.eq('organization_id', organizationId)
			.eq('email', demoEmail)
			.maybeSingle(),
		supabase
			.from('deals')
			.select('id, stage_id, contact_id')
			.eq('organization_id', organizationId)
			.order('position', { ascending: true })
	]);

	const openStages = (stagesRes.data ?? []).map(mapStage);
	const demoContact = demoContactRes.data;
	const demoDeal = demoContact
		? (dealsRes.data ?? []).find((d) => d.contact_id === demoContact.id)
		: undefined;
	const demoStage = demoDeal ? openStages.find((s) => s.id === demoDeal.stage_id) : undefined;
	const initialDemoLead: DemoLeadState | null =
		demoContact && demoDeal && demoStage
			? {
					contactId: demoContact.id,
					dealId: demoDeal.id,
					stageId: demoStage.id,
					stageName: demoStage.name,
					stageSlug: demoStage.slug
				}
			: null;

	return {
		aiSettings: aiRes.data ? mapAiSettings(aiRes.data) : null,
		knowledgeDocuments: (kbRes.data ?? []).map(mapKnowledgeDoc),
		stages: openStages,
		initialDemoLead
	};
}

export async function pgGetSettingsPageData(
	supabase: DbClient,
	org: Organization,
	membersPromise: Promise<OrganizationMember[]>,
	channelsPromise: Promise<ConnectedChannel[]>,
	usagePeriodPromise: Promise<OrgUsagePeriod | null>
) {
	const [members, channels, usagePeriod, invitesRes] = await Promise.all([
		membersPromise,
		channelsPromise,
		usagePeriodPromise,
		supabase
			.from('organization_invitations')
			.select('*')
			.eq('organization_id', org.id)
			.order('created_at', { ascending: false })
	]);

	const profileNames = buildProfileNameMap(members);
	const invitations = (invitesRes.data ?? []).map((inv) =>
		mapInvitationRow(inv, org, profileNames)
	);
	const activeChannelsCount = channels.filter((c) => c.status === 'active').length;
	const usageSummary = usagePeriod ? getUsageSummary(org, usagePeriod, activeChannelsCount) : null;

	return {
		members,
		channels,
		invitations,
		roleChangeRequests: [] as RoleChangeRequest[],
		usageSummary
	};
}

export async function pgGetConversationAndChannel(
	supabase: DbClient,
	organizationId: string,
	conversationId: string
): Promise<{ conv: Conversation | null; channel: ConnectedChannel | null }> {
	if (!isUuid(organizationId) || !isUuid(conversationId)) {
		return { conv: null, channel: null };
	}
	const { data: convRow } = await supabase
		.from('conversations')
		.select('*')
		.eq('organization_id', organizationId)
		.eq('id', conversationId)
		.maybeSingle();
	if (!convRow) return { conv: null, channel: null };

	const { data: channelRow } = await supabase
		.from('connected_channels')
		.select('*')
		.eq('organization_id', organizationId)
		.eq('id', convRow.channel_id)
		.maybeSingle();

	return {
		conv: mapConversation(convRow),
		channel: channelRow ? mapChannel(channelRow) : null
	};
}

export async function pgGetContactById(
	supabase: DbClient,
	organizationId: string,
	contactId: string
): Promise<Contact | null> {
	if (!isUuid(organizationId) || !isUuid(contactId)) return null;
	const { data } = await supabase
		.from('contacts')
		.select('*')
		.eq('organization_id', organizationId)
		.eq('id', contactId)
		.maybeSingle();
	return data ? mapContact(data) : null;
}

export async function pgGetChannelById(
	supabase: DbClient,
	organizationId: string,
	channelId: string
): Promise<ConnectedChannel | null> {
	if (!isUuid(organizationId) || !isUuid(channelId)) return null;
	const { data } = await supabase
		.from('connected_channels')
		.select('*')
		.eq('organization_id', organizationId)
		.eq('id', channelId)
		.maybeSingle();
	return data ? mapChannel(data) : null;
}

export async function pgGetConversationMessagesPage(
	supabase: DbClient,
	organizationId: string,
	conversationId: string,
	opts: { beforeId?: number; limit?: number } = {}
): Promise<{ messages: Message[]; hasMore: boolean; nextBeforeId: number | null }> {
	const limit = Math.min(100, Math.max(1, opts.limit ?? 40));
	if (!isUuid(organizationId) || !isUuid(conversationId)) {
		return { messages: [], hasMore: false, nextBeforeId: null };
	}

	let q = supabase
		.from('messages')
		.select('*')
		.eq('organization_id', organizationId)
		.eq('conversation_id', conversationId);
	if (opts.beforeId !== undefined) {
		q = q.lt('id', opts.beforeId);
	}
	const { data } = await q.order('id', { ascending: false }).limit(limit + 1);
	const rows = data ?? [];
	const hasMore = rows.length > limit;
	const sliced = hasMore ? rows.slice(0, limit) : rows;
	const messages = sliced.reverse().map(mapMessage);
	return {
		messages,
		hasMore,
		nextBeforeId: hasMore ? (messages[0]?.id ?? null) : null
	};
}

export async function pgGetAiDraftContext(
	supabase: DbClient,
	org: Organization,
	conversationId: string
) {
	if (!isUuid(org.id) || !isUuid(conversationId)) {
		return {
			conv: null,
			contact: null,
			recentMessages: [] as Message[],
			aiSettings: null,
			readyDocs: [] as KnowledgeDocument[],
			openStages: [] as PipelineStage[],
			usageSummary: null
		};
	}

	const [convRes, msgsRes, aiRes, kbRes, stagesRes, usagePeriod, channels] = await Promise.all([
		supabase
			.from('conversations')
			.select('*')
			.eq('organization_id', org.id)
			.eq('id', conversationId)
			.maybeSingle(),
		supabase
			.from('messages')
			.select('*')
			.eq('organization_id', org.id)
			.eq('conversation_id', conversationId)
			.order('id', { ascending: false })
			.limit(15),
		supabase.from('ai_settings').select('*').eq('organization_id', org.id).maybeSingle(),
		supabase
			.from('knowledge_documents')
			.select('*')
			.eq('organization_id', org.id)
			.eq('status', 'ready')
			.order('created_at', { ascending: false })
			.limit(5),
		supabase
			.from('pipeline_stages')
			.select('*')
			.eq('organization_id', org.id)
			.eq('is_terminal', false)
			.order('position', { ascending: true }),
		pgGetLatestUsagePeriod(supabase, org.id),
		pgListWorkspaceChannels(supabase, org.id)
	]);

	const conv = convRes.data ? mapConversation(convRes.data) : null;
	const contact = conv ? await pgGetContactById(supabase, org.id, conv.contact_id) : null;
	const activeChannelsCount = channels.filter((c) => c.status === 'active').length;
	const usageSummary = usagePeriod ? getUsageSummary(org, usagePeriod, activeChannelsCount) : null;

	return {
		conv,
		contact,
		recentMessages: [...(msgsRes.data ?? [])].reverse().map(mapMessage),
		aiSettings: aiRes.data ? mapAiSettings(aiRes.data) : null,
		readyDocs: (kbRes.data ?? []).map(mapKnowledgeDoc),
		openStages: (stagesRes.data ?? []).map(mapStage),
		usageSummary
	};
}

export async function pgGetWorkspaceSnapshot(
	supabase: DbClient,
	organizationId: string,
	knownOrg?: Organization
) {
	if (!isUuid(organizationId)) return null;

	const org = knownOrg ?? (await pgGetOrganizationById(supabase, organizationId));
	if (!org) return null;

	const [
		members,
		channels,
		contactsRes,
		identitiesRes,
		notesRes,
		convsRes,
		msgsRes,
		pipelinesRes,
		stagesRes,
		dealsRes,
		aiRes,
		kbRes,
		usageRes,
		invitesRes
	] = await Promise.all([
		pgListWorkspaceMembers(supabase, organizationId),
		pgListWorkspaceChannels(supabase, organizationId),
		supabase
			.from('contacts')
			.select('*')
			.eq('organization_id', organizationId)
			.order('created_at', { ascending: false }),
		supabase.from('contact_identities').select('*').eq('organization_id', organizationId),
		supabase
			.from('contact_notes')
			.select('*')
			.eq('organization_id', organizationId)
			.order('created_at', { ascending: false }),
		supabase
			.from('conversations')
			.select('*')
			.eq('organization_id', organizationId)
			.order('last_message_at', { ascending: false })
			.limit(50),
		supabase
			.from('messages')
			.select('*')
			.eq('organization_id', organizationId)
			.order('created_at', { ascending: false })
			.order('id', { ascending: false })
			.limit(100),
		supabase
			.from('pipelines')
			.select('*')
			.eq('organization_id', organizationId)
			.eq('is_default', true)
			.maybeSingle(),
		supabase
			.from('pipeline_stages')
			.select('*')
			.eq('organization_id', organizationId)
			.order('position', { ascending: true }),
		supabase
			.from('deals')
			.select('*')
			.eq('organization_id', organizationId)
			.order('position', { ascending: true }),
		supabase
			.from('ai_settings')
			.select('*')
			.eq('organization_id', organizationId)
			.maybeSingle(),
		supabase
			.from('knowledge_documents')
			.select('*')
			.eq('organization_id', organizationId)
			.order('created_at', { ascending: false }),
		pgGetLatestUsagePeriod(supabase, organizationId),
		supabase
			.from('organization_invitations')
			.select('*')
			.eq('organization_id', organizationId)
			.order('created_at', { ascending: false })
	]);

	const profileNames = buildProfileNameMap(members);
	const contacts: Contact[] = (contactsRes.data ?? []).map(mapContact);
	const identities: ContactIdentity[] = (identitiesRes.data ?? []).map(mapIdentity);
	const notes: ContactNote[] = (notesRes.data ?? []).map((n) => mapNoteRow(n, profileNames));
	const conversations: Conversation[] = (convsRes.data ?? []).map(mapConversation);
	const messages: Message[] = [...(msgsRes.data ?? [])].reverse().map(mapMessage);
	const pipeline: Pipeline | null = pipelinesRes.data
		? {
				id: pipelinesRes.data.id,
				organization_id: pipelinesRes.data.organization_id,
				name: pipelinesRes.data.name,
				is_default: pipelinesRes.data.is_default,
				created_at: pipelinesRes.data.created_at
			}
		: null;
	const stages: PipelineStage[] = (stagesRes.data ?? []).map(mapStage);
	const deals: Deal[] = (dealsRes.data ?? []).map(mapDeal);
	const aiSettings: AiSettings | null = aiRes.data ? mapAiSettings(aiRes.data) : null;
	const knowledgeDocuments: KnowledgeDocument[] = (kbRes.data ?? []).map(mapKnowledgeDoc);
	const usagePeriod: OrgUsagePeriod | null = usageRes;
	const invitations: OrganizationInvitation[] = (invitesRes.data ?? []).map((inv) =>
		mapInvitationRow(inv, org, profileNames)
	);
	const roleChangeRequests: RoleChangeRequest[] = [];
	const timelineEvents: TimelineEvent[] = buildTimelineEvents(organizationId, conversations, deals);
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

export async function pgCreateWorkspace(params: {
	userId: string;
	userEmail?: string;
	userName?: string;
	name: string;
	platform: Platform;
	industry: string;
	language: 'es' | 'en';
	autoReplyEnabled: boolean;
	initialKnowledge: string;
}): Promise<Organization> {
	const admin = requireAdminDb();
	if (!isUuid(params.userId)) {
		throw new Error('Se requiere una sesión autenticada válida para crear el workspace.');
	}

	// Asegura fila en profiles antes de crear membresía owner
	await admin.from('profiles').upsert(
		{
			id: params.userId,
			email: params.userEmail ?? '',
			full_name: params.userName || params.userEmail?.split('@')[0] || 'Usuario'
		},
		{ onConflict: 'id', ignoreDuplicates: true }
	);

	const baseSlug =
		params.name
			.toLowerCase()
			.normalize('NFD')
			.replace(/[\u0300-\u036f]/g, '')
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/(^-|-$)/g, '') || 'mi-espacio';

	let slug = baseSlug;
	let suffix = 2;
	while (true) {
		const { data: existing } = await admin
			.from('organizations')
			.select('id')
			.eq('slug', slug)
			.maybeSingle();
		if (!existing) break;
		slug = `${baseSlug}-${suffix++}`;
	}

	const { profileId } = await getChannelProvider().createProfile(params.name);
	const nowIso = new Date().toISOString();
	const trialEnd = new Date(Date.now() + TRIAL_DAYS * 86400_000).toISOString();

	const { data: orgRow, error: orgError } = await admin
		.from('organizations')
		.insert({
			name: params.name,
			slug,
			industry: params.industry || 'Servicios profesionales',
			language: params.language,
			currency: 'MXN',
			zernio_profile_id: profileId,
			subscription_status: 'trialing',
			billing_mode: 'trial',
			channel_slots: 1,
			included_ai_replies_per_channel: 1000,
			ai_overage_enabled: false,
			kb_document_limit: TRIAL_KB_DOCUMENT_LIMIT,
			trial_ends_at: trialEnd,
			current_period_start: nowIso,
			current_period_end: trialEnd
		})
		.select('*')
		.single();

	if (orgError || !orgRow) {
		throw new Error(orgError?.message ?? 'No se pudo crear el workspace en Supabase');
	}

	await admin.from('organization_members').insert({
		organization_id: orgRow.id,
		user_id: params.userId,
		role: 'owner'
	});

	const { data: pipRow, error: pipError } = await admin
		.from('pipelines')
		.insert({
			organization_id: orgRow.id,
			name: 'Pipeline principal',
			is_default: true
		})
		.select('*')
		.single();

	if (pipError || !pipRow) {
		throw new Error(pipError?.message ?? 'No se pudo inicializar el pipeline');
	}

	await admin.from('pipeline_stages').insert([
		{
			organization_id: orgRow.id,
			pipeline_id: pipRow.id,
			name: 'Nuevos',
			slug: 'new',
			color: '#8E8E86',
			position: 1000,
			is_terminal: false,
			ai_qualification_hint: 'Al escribir por primera vez.'
		},
		{
			organization_id: orgRow.id,
			pipeline_id: pipRow.id,
			name: 'En conversación',
			slug: 'in_conversation',
			color: '#3B6342',
			position: 2000,
			is_terminal: false,
			ai_qualification_hint: 'Al identificar una necesidad.'
		},
		{
			organization_id: orgRow.id,
			pipeline_id: pipRow.id,
			name: 'Propuesta enviada',
			slug: 'proposal_sent',
			color: '#1C1C1A',
			position: 3000,
			is_terminal: false,
			ai_qualification_hint: 'Al recibir alcance y precio.'
		},
		{
			organization_id: orgRow.id,
			pipeline_id: pipRow.id,
			name: 'Ganado',
			slug: 'won',
			color: '#3B6342',
			position: 4000,
			is_terminal: true,
			ai_qualification_hint: 'Solo tu equipo marca Ganado.'
		}
	]);

	await admin.from('ai_settings').insert({
		organization_id: orgRow.id,
		enabled: true,
		auto_reply_enabled: params.autoReplyEnabled,
		auto_qualify_enabled: true,
		handle_inbound_audio: 'transcribe_and_reply',
		business_context: params.initialKnowledge || `${params.name} — ${params.industry}`,
		tone: 'professional',
		handoff_rules: 'Pida ayuda, solicite descuentos o falte información.',
		max_ai_replies_per_thread: 5
	});

	if (params.initialKnowledge.trim()) {
		const content = params.initialKnowledge.trim();
		const { data: docRow } = await admin
			.from('knowledge_documents')
			.insert({
				organization_id: orgRow.id,
				title: 'Contexto inicial del negocio',
				subtitle: 'Texto',
				source_type: 'text',
				content_preview: content,
				embedding_model: 'gemini-embedding-001',
				status: 'ready'
			})
			.select('id')
			.single();
		if (docRow) {
			await admin.from('knowledge_chunks').insert({
				organization_id: orgRow.id,
				document_id: docRow.id,
				content
			});
		}
	}

	await admin.from('org_usage_periods').insert({
		organization_id: orgRow.id,
		period_start: nowIso,
		period_end: trialEnd,
		included_ai_replies: TRIAL_INCLUDED_AI_REPLIES,
		used_ai_replies: 0,
		overage_ai_replies: 0,
		draft_count: 0,
		test_chat_count: 0
	});

	return mapOrganization(orgRow);
}

export async function pgSendManualMessage(
	supabase: DbClient,
	params: {
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
	}
): Promise<Message> {
	const { data: conv } = await supabase
		.from('conversations')
		.select('*')
		.eq('id', params.conversationId)
		.eq('organization_id', params.organizationId)
		.maybeSingle();
	if (!conv) throw new Error('Conversación no encontrada en esta organización');

	const { data: profileRow } = await supabase
		.from('profiles')
		.select('full_name')
		.eq('id', params.userId)
		.maybeSingle();
	const senderLabel = `Tú · ${profileRow?.full_name || 'Equipo'}`;
	const nowIso = new Date().toISOString();
	const finalStatus = params.status ?? 'delivered';
	const attachments = params.attachments ?? [];

	let msgRow: Tables['messages']['Row'] | null = null;
	if (params.retryMessageId) {
		const { data: updated } = await supabase
			.from('messages')
			.update({
				body: params.body,
				...(attachments.length > 0 ? { attachments: attachments as unknown as Json } : {}),
				external_message_id: params.externalMessageId ?? undefined,
				status: finalStatus,
				error_code: finalStatus === 'failed' ? (params.errorCode ?? 'SEND_FAILED') : null,
				error_detail: finalStatus === 'failed' ? (params.errorDetail ?? 'Error de envío') : null
			})
			.eq('id', params.retryMessageId)
			.eq('conversation_id', conv.id)
			.eq('organization_id', params.organizationId)
			.select('*')
			.maybeSingle();
		msgRow = updated;
	}

	if (!msgRow) {
		const { data: inserted, error } = await supabase
			.from('messages')
			.insert({
				organization_id: params.organizationId,
				conversation_id: conv.id,
				channel_id: conv.channel_id,
				external_message_id: params.externalMessageId ?? null,
				direction: 'outbound',
				sender_type: 'agent',
				sender_user_id: params.userId,
				sender_label: senderLabel,
				body: params.body,
				attachments: attachments as unknown as Json,
				status: finalStatus,
				error_code: finalStatus === 'failed' ? (params.errorCode ?? 'SEND_FAILED') : null,
				error_detail: finalStatus === 'failed' ? (params.errorDetail ?? 'Error de envío') : null
			})
			.select('*')
			.single();
		if (error || !inserted) {
			throw new Error(error?.message ?? 'No se pudo guardar el mensaje');
		}
		msgRow = inserted;
	}

	const firstAtt = attachments[0];
	const attLabel =
		firstAtt?.kind === 'image' ? 'Imagen' : firstAtt?.kind === 'audio' ? 'Audio' : 'Archivo';
	const previewText = params.body.trim()
		? `Tú: ${params.body.trim()}`
		: firstAtt
			? `Tú: [${attLabel}] ${firstAtt.file_name}`
			: 'Tú: [Mensaje]';

	await supabase
		.from('conversations')
		.update({
			ai_paused: true,
			ai_handoff_reason: 'Intervención humana en Inbox',
			ai_reply_count: 0,
			needs_reply: false,
			unread_count: 0,
			last_message_preview: previewText,
			last_message_at: nowIso
		})
		.eq('id', conv.id)
		.eq('organization_id', params.organizationId);

	return mapMessage(msgRow);
}

export async function pgAddInternalNote(
	supabase: DbClient,
	params: {
		organizationId: string;
		contactId: string;
		conversationId: string | null;
		userId: string;
		body: string;
	}
): Promise<ContactNote> {
	const { data: row, error } = await supabase
		.from('contact_notes')
		.insert({
			organization_id: params.organizationId,
			contact_id: params.contactId,
			conversation_id: params.conversationId,
			author_user_id: params.userId,
			body: params.body
		})
		.select('*')
		.single();
	if (error || !row) throw new Error(error?.message ?? 'No se pudo guardar la nota');

	const { data: profileRow } = await supabase
		.from('profiles')
		.select('full_name')
		.eq('id', params.userId)
		.maybeSingle();

	return {
		id: row.id,
		organization_id: row.organization_id,
		contact_id: row.contact_id,
		conversation_id: row.conversation_id,
		author_user_id: row.author_user_id ?? params.userId,
		author_name: profileRow?.full_name || 'Equipo',
		body: row.body,
		created_at: row.created_at,
		display_time: `${formatDayGroup(row.created_at)}, ${formatDisplayTime(row.created_at)}`
	};
}

export async function pgUpdateConversationState(
	supabase: DbClient,
	params: {
		organizationId: string;
		conversationId: string;
		assignedTo?: string | null;
		status?: 'open' | 'pending' | 'closed';
		aiPaused?: boolean;
	}
): Promise<Conversation> {
	const patch: Tables['conversations']['Update'] = {};
	if (params.assignedTo !== undefined) patch.assigned_to = params.assignedTo;
	if (params.status !== undefined) {
		patch.status = params.status;
		if (params.status === 'closed') {
			patch.unread_count = 0;
			patch.needs_reply = false;
		}
	}
	if (params.aiPaused !== undefined) {
		patch.ai_paused = params.aiPaused;
		if (!params.aiPaused) {
			patch.ai_reply_count = 0;
			patch.ai_handoff_reason = null;
		}
	}

	const { data, error } = await supabase
		.from('conversations')
		.update(patch)
		.eq('id', params.conversationId)
		.eq('organization_id', params.organizationId)
		.select('*')
		.single();
	if (error || !data) throw new Error(error?.message ?? 'Conversación no encontrada');
	return mapConversation(data);
}

export async function pgCreateDeal(
	supabase: DbClient,
	params: {
		organizationId: string;
		title: string;
		contactId: string;
		stageId: string;
		dealType: string;
		valueAmount: number;
		ownerUserId: string | null;
	}
): Promise<Deal> {
	const [{ data: stage }, { data: contact }, { data: org }] = await Promise.all([
		supabase
			.from('pipeline_stages')
			.select('id, pipeline_id')
			.eq('id', params.stageId)
			.eq('organization_id', params.organizationId)
			.maybeSingle(),
		supabase
			.from('contacts')
			.select('id, owner_user_id')
			.eq('id', params.contactId)
			.eq('organization_id', params.organizationId)
			.maybeSingle(),
		supabase
			.from('organizations')
			.select('currency')
			.eq('id', params.organizationId)
			.maybeSingle()
	]);
	if (!stage || !contact) throw new Error('Etapa o contacto inválido');

	const { data: topDeal } = await supabase
		.from('deals')
		.select('position')
		.eq('organization_id', params.organizationId)
		.eq('stage_id', stage.id)
		.order('position', { ascending: false })
		.limit(1)
		.maybeSingle();

	const { data: conv } = await supabase
		.from('conversations')
		.select('id')
		.eq('organization_id', params.organizationId)
		.eq('contact_id', contact.id)
		.limit(1)
		.maybeSingle();

	const { data: inserted, error } = await supabase
		.from('deals')
		.insert({
			organization_id: params.organizationId,
			pipeline_id: stage.pipeline_id,
			stage_id: stage.id,
			contact_id: contact.id,
			conversation_id: conv?.id ?? null,
			owner_user_id: params.ownerUserId ?? contact.owner_user_id,
			title: params.title,
			deal_type: params.dealType,
			value_cents: Math.round(params.valueAmount * 100),
			currency: org?.currency ?? 'MXN',
			position: (topDeal?.position ?? 0) + 1000,
			last_moved_by: 'human',
			next_step_title: 'Definir siguiente paso',
			next_step_at: new Date().toISOString()
		})
		.select('*')
		.single();
	if (error || !inserted) throw new Error(error?.message ?? 'No se pudo crear la oportunidad');
	return mapDeal(inserted);
}

export async function pgUpdateDeal(
	supabase: DbClient,
	params: {
		organizationId: string;
		dealId: string;
		stageId?: string;
		contactId?: string;
		dealType?: string;
		ownerUserId?: string | null;
		nextStepTitle?: string;
		nextStepLabel?: string;
	}
): Promise<Deal> {
	const patch: Tables['deals']['Update'] = {};
	if (params.stageId) {
		patch.stage_id = params.stageId;
		patch.last_moved_by = 'human';
	}
	if (params.contactId) patch.contact_id = params.contactId;
	if (params.dealType) patch.deal_type = params.dealType;
	if (params.ownerUserId !== undefined) patch.owner_user_id = params.ownerUserId;
	if (params.nextStepTitle !== undefined) patch.next_step_title = params.nextStepTitle;
	if (params.nextStepLabel !== undefined) patch.next_step_at = parseNextStepAt(params.nextStepLabel);

	const { data, error } = await supabase
		.from('deals')
		.update(patch)
		.eq('id', params.dealId)
		.eq('organization_id', params.organizationId)
		.select('*')
		.single();
	if (error || !data) throw new Error(error?.message ?? 'Oportunidad no encontrada');
	return mapDeal(data);
}

export async function pgCreateContact(
	supabase: DbClient,
	params: {
		organizationId: string;
		name: string;
		company: string;
		email: string;
		phone: string;
		ownerUserId: string | null;
		nextStepTitle: string;
		nextStepAtLabel: string;
	}
): Promise<Contact> {
	const { data, error } = await supabase
		.from('contacts')
		.insert({
			organization_id: params.organizationId,
			name: params.name,
			company: params.company || null,
			email: params.email || null,
			phone: params.phone || null,
			owner_user_id: params.ownerUserId,
			lead_score: 50,
			ai_intent_label: 'Nuevo contacto',
			next_step_title: params.nextStepTitle || 'Primer contacto',
			next_step_at: parseNextStepAt(params.nextStepAtLabel || 'Mañana')
		})
		.select('*')
		.single();
	if (error || !data) throw new Error(error?.message ?? 'No se pudo crear el contacto');
	return mapContact(data);
}

export async function pgUpdateContact(
	supabase: DbClient,
	params: {
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
	}
): Promise<Contact> {
	const { data, error } = await supabase
		.from('contacts')
		.update({
			name: params.name,
			company: params.company || null,
			role_title: params.roleTitle || null,
			email: params.email || null,
			phone: params.phone || null,
			owner_user_id: params.ownerUserId,
			next_step_title: params.nextStepTitle || null,
			next_step_at: parseNextStepAt(params.nextStepAtLabel)
		})
		.eq('id', params.contactId)
		.eq('organization_id', params.organizationId)
		.select('*')
		.single();
	if (error || !data) throw new Error(error?.message ?? 'Contacto no encontrado');
	return mapContact(data);
}

export async function pgUpdateAiMode(
	supabase: DbClient,
	organizationId: string,
	autoReplyEnabled: boolean
): Promise<AiSettings> {
	const { data, error } = await supabase
		.from('ai_settings')
		.update({ auto_reply_enabled: autoReplyEnabled })
		.eq('organization_id', organizationId)
		.select('*')
		.single();
	if (error || !data) throw new Error(error?.message ?? 'Ajustes de IA no encontrados');
	return {
		organization_id: data.organization_id,
		enabled: data.enabled,
		auto_reply_enabled: data.auto_reply_enabled,
		auto_qualify_enabled: data.auto_qualify_enabled,
		handle_inbound_audio: data.handle_inbound_audio as AiSettings['handle_inbound_audio'],
		business_context: data.business_context,
		tone: data.tone as AiSettings['tone'],
		handoff_rules: data.handoff_rules,
		max_ai_replies_per_thread: data.max_ai_replies_per_thread,
		updated_at: data.updated_at
	};
}

export async function pgUpdateAiPreferences(
	supabase: DbClient,
	params: {
		organizationId: string;
		tone: 'friendly' | 'professional' | 'direct';
		autoQualifyEnabled: boolean;
		maxAiRepliesPerThread: number;
		handoffRules: string;
		businessContext?: string;
	}
): Promise<AiSettings> {
	const updatePayload: {
		tone: 'friendly' | 'professional' | 'direct';
		auto_qualify_enabled: boolean;
		max_ai_replies_per_thread: number;
		handoff_rules: string;
		business_context?: string;
	} = {
		tone: params.tone,
		auto_qualify_enabled: params.autoQualifyEnabled,
		max_ai_replies_per_thread: params.maxAiRepliesPerThread,
		handoff_rules: params.handoffRules
	};
	if (params.businessContext !== undefined) {
		updatePayload.business_context = params.businessContext;
	}

	const { data, error } = await supabase
		.from('ai_settings')
		.update(updatePayload)
		.eq('organization_id', params.organizationId)
		.select('*')
		.single();
	if (error || !data) throw new Error(error?.message ?? 'Ajustes de IA no encontrados');
	return {
		organization_id: data.organization_id,
		enabled: data.enabled,
		auto_reply_enabled: data.auto_reply_enabled,
		auto_qualify_enabled: data.auto_qualify_enabled,
		handle_inbound_audio: data.handle_inbound_audio as AiSettings['handle_inbound_audio'],
		business_context: data.business_context,
		tone: data.tone as AiSettings['tone'],
		handoff_rules: data.handoff_rules,
		max_ai_replies_per_thread: data.max_ai_replies_per_thread,
		updated_at: data.updated_at
	};
}

export async function pgUpdatePipelineQualificationRules(
	supabase: DbClient,
	organizationId: string,
	rules: Record<string, string>
): Promise<PipelineStage[]> {
	for (const [stageId, hint] of Object.entries(rules)) {
		if (!isUuid(stageId)) continue;
		await supabase
			.from('pipeline_stages')
			.update({ ai_qualification_hint: hint })
			.eq('id', stageId)
			.eq('organization_id', organizationId)
			.eq('is_terminal', false);
	}
	const { data } = await supabase
		.from('pipeline_stages')
		.select('*')
		.eq('organization_id', organizationId)
		.eq('is_terminal', false)
		.order('position', { ascending: true });
	return (data ?? []).map((s) => ({
		id: s.id,
		organization_id: s.organization_id,
		pipeline_id: s.pipeline_id,
		name: s.name,
		slug: s.slug,
		color: s.color,
		position: s.position,
		is_terminal: s.is_terminal,
		ai_qualification_hint: s.ai_qualification_hint,
		created_at: s.created_at
	}));
}

async function syncKnowledgeChunksWithEmbeddings(
	supabase: DbClient,
	organizationId: string,
	documentId: string,
	content: string
): Promise<void> {
	const chunks = chunkKnowledgeText(content, 1200, 150);
	if (chunks.length === 0) return;

	const MAX_EMBED_CHUNKS = 12;
	const embeddingResults = await Promise.all(
		chunks.slice(0, MAX_EMBED_CHUNKS).map((chunk) => generateTextEmbedding(chunk))
	);

	let totalEmbedTokens = 0;
	const rows = chunks.map((chunk, idx) => {
		const emb = idx < embeddingResults.length ? embeddingResults[idx] : null;
		if (emb) totalEmbedTokens += emb.inputTokens;
		return {
			organization_id: organizationId,
			document_id: documentId,
			content: chunk,
			embedding: emb ? formatPgVector(emb.values) : null
		};
	});

	const { error: insChunkErr } = await supabase.from('knowledge_chunks').insert(rows);
	if (insChunkErr) throw new Error(insChunkErr.message);

	if (totalEmbedTokens > 0) {
		await recordAiUsageLedger({
			organizationId,
			action: 'embed',
			billableUnits: 0,
			model: GEMINI_EMBEDDING_MODEL,
			inputTokens: totalEmbedTokens,
			outputTokens: 0
		});
	}
}

export async function pgAddKnowledgeDocument(
	supabase: DbClient,
	params: {
		organizationId: string;
		sourceType: 'faq' | 'text' | 'file' | 'url';
		title: string;
		question: string;
		answer: string;
		content: string;
		url: string;
		file?: KnowledgeUploadedFile | null;
	}
): Promise<KnowledgeDocument> {
	const [orgLimitRes, docCountRes] = await Promise.all([
		supabase
			.from('organizations')
			.select('kb_document_limit')
			.eq('id', params.organizationId)
			.maybeSingle(),
		supabase
			.from('knowledge_documents')
			.select('id', { count: 'exact', head: true })
			.eq('organization_id', params.organizationId)
	]);

	const kbLimit = orgLimitRes.data?.kb_document_limit ?? TRIAL_KB_DOCUMENT_LIMIT;
	const existingCount = docCountRes.count ?? 0;
	if (existingCount >= kbLimit) {
		throw new Error(
			`Alcanzaste el límite de ${kbLimit} fuentes en tu Base de Conocimiento para tu plan actual.`
		);
	}

	const ingested = await ingestKnowledgeSource({
		organizationId: params.organizationId,
		sourceType: params.sourceType,
		title: params.title,
		question: params.question,
		answer: params.answer,
		content: params.content,
		url: params.url,
		file: params.file
	});

	const { data: docRow, error } = await supabase
		.from('knowledge_documents')
		.insert({
			organization_id: params.organizationId,
			title: ingested.title,
			subtitle: ingested.subtitle,
			source_type: params.sourceType,
			source_url: ingested.sourceUrl,
			storage_path: ingested.storagePath,
			content_preview: ingested.contentPreview,
			embedding_model: GEMINI_EMBEDDING_MODEL,
			status: 'ready'
		})
		.select('*')
		.single();
	if (error || !docRow) throw new Error(error?.message ?? 'No se pudo guardar el documento');

	if (ingested.fullText) {
		await syncKnowledgeChunksWithEmbeddings(
			supabase,
			params.organizationId,
			docRow.id,
			ingested.fullText
		);
	}

	return mapKnowledgeDoc(docRow);
}

export async function pgUpdateKnowledgeDocument(
	supabase: DbClient,
	params: {
		organizationId: string;
		documentId: string;
		title: string;
		content: string;
		url?: string;
	}
): Promise<KnowledgeDocument> {
	if (!isUuid(params.documentId)) throw new Error('Fuente no encontrada');

	const { data: existing, error: fetchErr } = await supabase
		.from('knowledge_documents')
		.select('*')
		.eq('id', params.documentId)
		.eq('organization_id', params.organizationId)
		.maybeSingle();
	if (fetchErr || !existing) throw new Error(fetchErr?.message ?? 'Fuente no encontrada');

	const trimmedTitle = params.title.trim();
	const trimmedContent = params.content.trim();
	let sourceUrl = existing.source_url;

	if (existing.source_type === 'url' && params.url !== undefined) {
		const rawUrl = params.url.trim();
		if (!rawUrl) throw new Error('Ingresa una URL pública válida');
		const check = validateSafeExternalUrl(rawUrl);
		if (!check.ok) throw new Error(check.reason);
		sourceUrl = check.url.toString();
	}

	const { data: updatedRow, error: updateErr } = await supabase
		.from('knowledge_documents')
		.update({
			title: trimmedTitle,
			content_preview: trimmedContent,
			source_url: sourceUrl,
			status: 'ready',
			error_detail: null
		})
		.eq('id', params.documentId)
		.eq('organization_id', params.organizationId)
		.select('*')
		.single();
	if (updateErr || !updatedRow) {
		throw new Error(updateErr?.message ?? 'No se pudo actualizar la fuente');
	}

	const { error: delChunksErr } = await supabase
		.from('knowledge_chunks')
		.delete()
		.eq('organization_id', params.organizationId)
		.eq('document_id', params.documentId);
	if (delChunksErr) throw new Error(delChunksErr.message);

	await syncKnowledgeChunksWithEmbeddings(
		supabase,
		params.organizationId,
		params.documentId,
		trimmedContent
	);

	return mapKnowledgeDoc(updatedRow);
}

export async function pgDeleteKnowledgeDocument(
	supabase: DbClient,
	organizationId: string,
	documentId: string
): Promise<{ deletedId: string }> {
	if (!isUuid(documentId)) throw new Error('Fuente no encontrada');

	const { data, error } = await supabase
		.from('knowledge_documents')
		.delete()
		.eq('id', documentId)
		.eq('organization_id', organizationId)
		.select('id, storage_path')
		.maybeSingle();
	if (error) throw new Error(error.message);
	if (!data) throw new Error('Fuente no encontrada');

	if (data.storage_path) {
		await deletePrivateStorageFile(organizationId, data.storage_path, 'knowledge-files');
	}

	return { deletedId: data.id };
}

export async function pgRetryKnowledgeDocument(
	supabase: DbClient,
	organizationId: string,
	documentId: string
): Promise<KnowledgeDocument> {
	if (!isUuid(documentId)) throw new Error('Fuente no encontrada');

	const { data: existing, error: fetchErr } = await supabase
		.from('knowledge_documents')
		.select('*')
		.eq('id', documentId)
		.eq('organization_id', organizationId)
		.maybeSingle();
	if (fetchErr || !existing) throw new Error(fetchErr?.message ?? 'Fuente no encontrada');

	try {
		const reingested = await reingestKnowledgeFileOrUrl({
			organizationId,
			sourceType: existing.source_type as KnowledgeDocument['source_type'],
			sourceUrl: existing.source_url,
			storagePath: existing.storage_path,
			title: existing.title,
			existingContent: existing.content_preview
		});

		const { data: updatedRow, error: updateErr } = await supabase
			.from('knowledge_documents')
			.update({
				content_preview: reingested.contentPreview,
				embedding_model: reingested.embeddingModel,
				status: 'ready',
				error_detail: null
			})
			.eq('id', documentId)
			.eq('organization_id', organizationId)
			.select('*')
			.single();
		if (updateErr || !updatedRow) {
			throw new Error(updateErr?.message ?? 'No se pudo actualizar la fuente');
		}

		const { error: delChunksErr } = await supabase
			.from('knowledge_chunks')
			.delete()
			.eq('organization_id', organizationId)
			.eq('document_id', documentId);
		if (delChunksErr) throw new Error(delChunksErr.message);

		await syncKnowledgeChunksWithEmbeddings(
			supabase,
			organizationId,
			documentId,
			reingested.fullText
		);

		return mapKnowledgeDoc(updatedRow);
	} catch (err) {
		const detail = err instanceof Error ? err.message : 'Error al reintentar indexación';
		await supabase
			.from('knowledge_documents')
			.update({ status: 'error', error_detail: detail.slice(0, 300) })
			.eq('id', documentId)
			.eq('organization_id', organizationId);
		throw err instanceof Error ? err : new Error(detail);
	}
}

export async function pgCreateInvitation(
	supabase: DbClient,
	params: {
		organizationId: string;
		email: string;
		role: Exclude<OrgRole, 'owner'>;
		invitedByUserId: string;
		invitedByName: string;
	}
): Promise<OrganizationInvitation> {
	const rawToken =
		crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
	const tokenHash = await hashTokenSha256(rawToken);
	const expiresAt = new Date(Date.now() + 7 * 86400_000).toISOString();

	const [{ data: orgRow }, { data: invRow, error }] = await Promise.all([
		supabase.from('organizations').select('name, slug').eq('id', params.organizationId).single(),
		supabase
			.from('organization_invitations')
			.insert({
				organization_id: params.organizationId,
				email: params.email.toLowerCase(),
				role: params.role,
				token_hash: tokenHash,
				invited_by: params.invitedByUserId,
				status: 'pending',
				expires_at: expiresAt
			})
			.select('*')
			.single()
	]);

	if (error || !invRow) {
		throw new Error(error?.message ?? 'No se pudo crear la invitación');
	}

	return {
		id: invRow.id,
		organization_id: invRow.organization_id,
		organization_name: orgRow?.name ?? 'Workspace',
		organization_slug: orgRow?.slug ?? '',
		email: invRow.email,
		role: invRow.role as Exclude<OrgRole, 'owner'>,
		token_hash: invRow.token_hash,
		demo_token: rawToken,
		invited_by_name: params.invitedByName,
		status: invRow.status as OrganizationInvitation['status'],
		expires_at: invRow.expires_at,
		accepted_at: invRow.accepted_at,
		created_at: invRow.created_at
	};
}

export async function pgRevokeInvitation(
	supabase: DbClient,
	organizationId: string,
	invitationId: string
): Promise<void> {
	await supabase
		.from('organization_invitations')
		.update({ status: 'revoked' })
		.eq('id', invitationId)
		.eq('organization_id', organizationId);
}

export async function pgRefreshInvitationToken(
	supabase: DbClient,
	params: {
		organizationId: string;
		invitationId: string;
		invitedByName: string;
	}
): Promise<OrganizationInvitation> {
	if (!isUuid(params.invitationId)) {
		throw new Error('Invitación no encontrada');
	}

	const rawToken =
		crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
	const tokenHash = await hashTokenSha256(rawToken);
	const expiresAt = new Date(Date.now() + 7 * 86400_000).toISOString();

	const [{ data: orgRow }, { data: invRow, error }] = await Promise.all([
		supabase.from('organizations').select('name, slug').eq('id', params.organizationId).single(),
		supabase
			.from('organization_invitations')
			.update({
				token_hash: tokenHash,
				expires_at: expiresAt
			})
			.eq('id', params.invitationId)
			.eq('organization_id', params.organizationId)
			.eq('status', 'pending')
			.select('*')
			.maybeSingle()
	]);

	if (error || !invRow) {
		throw new Error(error?.message ?? 'La invitación pendiente no existe o ya fue utilizada');
	}

	return {
		id: invRow.id,
		organization_id: invRow.organization_id,
		organization_name: orgRow?.name ?? 'Workspace',
		organization_slug: orgRow?.slug ?? '',
		email: invRow.email,
		role: invRow.role as Exclude<OrgRole, 'owner'>,
		token_hash: invRow.token_hash,
		demo_token: rawToken,
		invited_by_name: params.invitedByName,
		status: invRow.status as OrganizationInvitation['status'],
		expires_at: invRow.expires_at,
		accepted_at: invRow.accepted_at,
		created_at: invRow.created_at
	};
}

export async function pgGetInvitationByToken(
	rawToken: string
): Promise<OrganizationInvitation | null> {
	const admin = getSupabaseAdminClient();
	if (!admin || !rawToken) return null;

	const tokenHash = await hashTokenSha256(rawToken);
	const { data: inv, error } = await admin
		.from('organization_invitations')
		.select('*')
		.eq('token_hash', tokenHash)
		.maybeSingle();
	if (error || !inv) return null;

	const [{ data: orgRow }, { data: inviterRow }] = await Promise.all([
		admin.from('organizations').select('name, slug').eq('id', inv.organization_id).maybeSingle(),
		inv.invited_by
			? admin.from('profiles').select('full_name').eq('id', inv.invited_by).maybeSingle()
			: Promise.resolve({ data: null })
	]);

	const expired =
		inv.status === 'pending' && new Date(inv.expires_at).getTime() <= Date.now();

	return {
		id: inv.id,
		organization_id: inv.organization_id,
		organization_name: orgRow?.name ?? 'Workspace',
		organization_slug: orgRow?.slug ?? '',
		email: inv.email,
		role: inv.role as Exclude<OrgRole, 'owner'>,
		token_hash: inv.token_hash,
		demo_token: rawToken,
		invited_by_name: inviterRow?.full_name ?? 'Administrador',
		status: expired ? 'expired' : (inv.status as OrganizationInvitation['status']),
		expires_at: inv.expires_at,
		accepted_at: inv.accepted_at,
		created_at: inv.created_at
	};
}

export async function pgAcceptInvitation(
	rawToken: string,
	acceptingUser: { id: string; email: string; full_name?: string }
): Promise<{ ok: true; invitation: OrganizationInvitation } | { ok: false; error: string }> {
	const admin = getSupabaseAdminClient();
	if (!admin) return { ok: false, error: 'Supabase admin no configurado' };

	const inv = await pgGetInvitationByToken(rawToken);
	if (!inv || inv.status !== 'pending') {
		return { ok: false, error: 'La invitación ya no está disponible o expiró.' };
	}

	if (inv.email.trim().toLowerCase() !== acceptingUser.email.trim().toLowerCase()) {
		return {
			ok: false,
			error: `Esta invitación es para ${inv.email}, pero tu sesión es ${acceptingUser.email}.`
		};
	}

	await admin.from('profiles').upsert(
		{
			id: acceptingUser.id,
			email: acceptingUser.email,
			full_name: acceptingUser.full_name || acceptingUser.email.split('@')[0] || 'Usuario'
		},
		{ onConflict: 'id', ignoreDuplicates: true }
	);

	const { data: existingMember } = await admin
		.from('organization_members')
		.select('role')
		.eq('organization_id', inv.organization_id)
		.eq('user_id', acceptingUser.id)
		.maybeSingle();

	if (!existingMember) {
		const { error: memError } = await admin.from('organization_members').insert({
			organization_id: inv.organization_id,
			user_id: acceptingUser.id,
			role: inv.role
		});
		if (memError) {
			return { ok: false, error: memError.message };
		}
	}

	const nowIso = new Date().toISOString();
	await admin
		.from('organization_invitations')
		.update({ status: 'accepted', accepted_at: nowIso })
		.eq('id', inv.id);

	return {
		ok: true,
		invitation: {
			...inv,
			status: 'accepted',
			accepted_at: nowIso
		}
	};
}

export async function pgUpdateMemberRole(
	supabase: DbClient,
	organizationId: string,
	userId: string,
	role: OrgRole
): Promise<void> {
	const { data, error } = await supabase
		.from('organization_members')
		.update({ role })
		.eq('organization_id', organizationId)
		.eq('user_id', userId)
		.select('user_id')
		.maybeSingle();

	if (error) {
		throw new Error(error.message);
	}
	if (!data) {
		throw new Error('No tienes permiso para cambiar el rol de este miembro.');
	}
}

export async function pgReconnectChannel(
	supabase: DbClient,
	organizationId: string,
	channelId: string
): Promise<ConnectedChannel> {
	const { data, error } = await supabase
		.from('connected_channels')
		.update({ status: 'active' })
		.eq('id', channelId)
		.eq('organization_id', organizationId)
		.select('*')
		.single();
	if (error || !data) throw new Error(error?.message ?? 'Canal no encontrado');
	return mapChannel(data);
}

export async function pgDisconnectChannel(
	supabase: DbClient,
	organizationId: string,
	channelId: string
): Promise<ConnectedChannel> {
	const { data, error } = await supabase
		.from('connected_channels')
		.update({ status: 'disconnected' })
		.eq('id', channelId)
		.eq('organization_id', organizationId)
		.select('*')
		.single();
	if (error || !data) throw new Error(error?.message ?? 'Canal no encontrado');
	return mapChannel(data);
}

export async function pgUpdateWorkspaceInfo(
	supabase: DbClient,
	params: {
		organizationId: string;
		name: string;
		industry: string;
		currency: 'MXN' | 'USD';
		language: 'es' | 'en';
	}
): Promise<Organization> {
	const { data, error } = await supabase
		.from('organizations')
		.update({
			name: params.name,
			industry: params.industry,
			currency: params.currency,
			language: params.language
		})
		.eq('id', params.organizationId)
		.select('*')
		.single();
	if (error || !data) throw new Error(error?.message ?? 'Organización no encontrada');
	return mapOrganization(data);
}

export async function pgUpdateOrganizationChannelSlots(
	organizationId: string,
	channelSlots: number
): Promise<Organization> {
	const admin = requireAdminDb();
	const { data: orgRow, error } = await admin
		.from('organizations')
		.update({
			billing_mode: 'per_channel',
			subscription_status: 'active',
			channel_slots: channelSlots,
			kb_document_limit: channelSlots * 15
		})
		.eq('id', organizationId)
		.select('*')
		.single();
	if (error || !orgRow) throw new Error(error?.message ?? 'Organización no encontrada');

	const { data: latestPeriod } = await admin
		.from('org_usage_periods')
		.select('id')
		.eq('organization_id', organizationId)
		.order('period_start', { ascending: false })
		.limit(1)
		.maybeSingle();
	if (latestPeriod) {
		await admin
			.from('org_usage_periods')
			.update({
				included_ai_replies: channelSlots * orgRow.included_ai_replies_per_channel
			})
			.eq('id', latestPeriod.id);
	}

	return mapOrganization(orgRow);
}

export async function pgUpdateOrganizationZernioProfileId(
	organizationId: string,
	profileId: string
): Promise<void> {
	const admin = requireAdminDb();
	await admin
		.from('organizations')
		.update({ zernio_profile_id: profileId })
		.eq('id', organizationId);
}

export async function pgFindChannelByExternalAccountId(
	externalAccountId: string
): Promise<ConnectedChannel | null> {
	const admin = getSupabaseAdminClient();
	if (!admin || !externalAccountId) return null;
	const { data } = await admin
		.from('connected_channels')
		.select('*')
		.eq('provider', 'zernio')
		.eq('external_account_id', externalAccountId)
		.maybeSingle();
	return data ? mapChannel(data) : null;
}

export async function pgUpsertConnectedChannel(params: {
	organizationId: string;
	platform: Platform;
	externalAccountId: string;
	displayName: string;
	handleOrPhone: string;
	channelId?: string;
}): Promise<
	| { ok: true; channel: ConnectedChannel }
	| { ok: false; code: 'ACCOUNT_IN_OTHER_ORG' | 'CHANNEL_SLOTS_FULL'; error: string }
> {
	const admin = requireAdminDb();

	const { data: orgRow } = await admin
		.from('organizations')
		.select('id, channel_slots')
		.eq('id', params.organizationId)
		.maybeSingle();
	if (!orgRow) throw new Error('Organización no encontrada');

	const { data: collision } = await admin
		.from('connected_channels')
		.select('id, organization_id')
		.eq('provider', 'zernio')
		.eq('external_account_id', params.externalAccountId)
		.neq('organization_id', params.organizationId)
		.maybeSingle();
	if (collision) {
		return {
			ok: false,
			code: 'ACCOUNT_IN_OTHER_ORG',
			error: 'Esta cuenta social ya está conectada en otro workspace de Okeo.'
		};
	}

	const { data: orgChannels } = await admin
		.from('connected_channels')
		.select('*')
		.eq('organization_id', params.organizationId);

	const activeCount = (orgChannels ?? []).filter((c) => c.status === 'active').length;
	const existing =
		(params.channelId
			? (orgChannels ?? []).find((c) => c.id === params.channelId)
			: undefined) ??
		(orgChannels ?? []).find((c) => c.external_account_id === params.externalAccountId);

	if (existing) {
		if (existing.status !== 'active' && activeCount >= orgRow.channel_slots) {
			return {
				ok: false,
				code: 'CHANNEL_SLOTS_FULL',
				error: 'Alcanzaste el límite de canales contratados en este workspace.'
			};
		}
		const { data: updated, error } = await admin
			.from('connected_channels')
			.update({
				platform: params.platform,
				external_account_id: params.externalAccountId,
				display_name: params.displayName,
				handle_or_phone: params.handleOrPhone,
				status: 'active'
			})
			.eq('id', existing.id)
			.eq('organization_id', params.organizationId)
			.select('*')
			.single();
		if (error || !updated) throw new Error(error?.message ?? 'Error al reconectar canal');
		return { ok: true, channel: mapChannel(updated) };
	}

	if (activeCount >= orgRow.channel_slots) {
		return {
			ok: false,
			code: 'CHANNEL_SLOTS_FULL',
			error: 'Alcanzaste el límite de canales contratados en este workspace.'
		};
	}

	const { data: inserted, error } = await admin
		.from('connected_channels')
		.insert({
			organization_id: params.organizationId,
			provider: 'zernio',
			platform: params.platform,
			external_account_id: params.externalAccountId,
			display_name: params.displayName,
			handle_or_phone: params.handleOrPhone,
			status: 'active',
			metadata: {}
		})
		.select('*')
		.single();
	if (error || !inserted) throw new Error(error?.message ?? 'Error al guardar canal conectado');
	return { ok: true, channel: mapChannel(inserted) };
}

async function resolveOrCreateWebhookConversationPg(
	admin: DbClient,
	params: {
		channel: ConnectedChannel;
		externalThreadId?: string;
		senderExternalId?: string;
		senderName?: string;
		senderHandle?: string;
	}
): Promise<{ conv: Tables['conversations']['Row']; contactName: string }> {
	const { channel } = params;
	const orgId = channel.organization_id;

	if (params.externalThreadId) {
		const { data: byThread } = await admin
			.from('conversations')
			.select('*')
			.eq('organization_id', orgId)
			.eq('channel_id', channel.id)
			.eq('external_thread_id', params.externalThreadId)
			.maybeSingle();
		if (byThread) {
			const { data: ct } = await admin
				.from('contacts')
				.select('name')
				.eq('id', byThread.contact_id)
				.maybeSingle();
			return { conv: byThread, contactName: ct?.name ?? 'Contacto' };
		}
	}

	let contactId: string | null = null;
	let contactName = params.senderName?.trim() || params.senderHandle?.trim() || 'Contacto nuevo';

	if (params.senderExternalId) {
		const { data: identity } = await admin
			.from('contact_identities')
			.select('contact_id')
			.eq('organization_id', orgId)
			.eq('platform', channel.platform)
			.eq('external_user_id', params.senderExternalId)
			.maybeSingle();
		if (identity) {
			contactId = identity.contact_id;
			const { data: ct } = await admin
				.from('contacts')
				.select('name')
				.eq('id', contactId)
				.maybeSingle();
			if (ct?.name) contactName = ct.name;
		}
	}

	if (!contactId) {
		const { data: createdContact, error: ctError } = await admin
			.from('contacts')
			.insert({
				organization_id: orgId,
				name: contactName,
				phone: channel.platform === 'whatsapp' && params.senderHandle ? params.senderHandle : null,
				lead_score: 50,
				ai_intent_label: 'Mensaje entrante',
				next_step_title: 'Responder conversación',
				next_step_at: new Date().toISOString()
			})
			.select('id, name')
			.single();
		if (ctError || !createdContact) {
			throw new Error(ctError?.message ?? 'No se pudo crear contacto desde webhook');
		}
		contactId = createdContact.id;
		contactName = createdContact.name;

		if (params.senderExternalId || params.senderHandle) {
			await admin.from('contact_identities').insert({
				organization_id: orgId,
				contact_id: contactId,
				platform: channel.platform,
				external_user_id: params.senderExternalId ?? params.senderHandle ?? contactId,
				username_or_phone: params.senderHandle ?? params.senderName ?? contactId
			});
		}
	}

	const threadId = params.externalThreadId ?? `thr_${channel.id}_${Date.now()}`;
	const { data: convRow, error: convError } = await admin
		.from('conversations')
		.upsert(
			{
				organization_id: orgId,
				channel_id: channel.id,
				contact_id: contactId,
				external_thread_id: threadId,
				platform: channel.platform,
				status: 'open',
				needs_reply: true,
				ai_paused: false,
				last_inbound_at: new Date().toISOString(),
				last_message_at: new Date().toISOString()
			},
			{ onConflict: 'channel_id,external_thread_id' }
		)
		.select('*')
		.single();

	if (convError || !convRow) {
		throw new Error(convError?.message ?? 'No se pudo crear conversación desde webhook');
	}

	return { conv: convRow, contactName };
}

export async function pgTryClaimZernioWebhookEvent(
	eventId: string,
	eventType: string
): Promise<boolean> {
	const cleanId = eventId.trim();
	if (!cleanId) return true;

	const admin = requireAdminDb();
	const { error } = await admin.from('zernio_webhook_events').insert({
		event_id: cleanId,
		event_type: eventType.trim() || 'unknown'
	});

	if (!error) return true;
	if (error.code === '23505') {
		return false;
	}
	console.warn('[webhook/zernio] No se pudo registrar event_id en zernio_webhook_events:', error.message);
	return true;
}

export async function pgIngestInboundWebhookMessage(params: {
	externalAccountId: string;
	externalMessageId?: string;
	externalThreadId?: string;
	senderExternalId?: string;
	senderName?: string;
	senderHandle?: string;
	body: string;
}): Promise<{
	organizationId: string;
	conversationId: string;
	messageId: number;
	deduplicated: boolean;
} | null> {
	const admin = requireAdminDb();
	const channel = await pgFindChannelByExternalAccountId(params.externalAccountId);
	if (!channel) return null;

	if (params.externalMessageId) {
		const { data: duplicate } = await admin
			.from('messages')
			.select('id, organization_id, conversation_id')
			.eq('channel_id', channel.id)
			.eq('external_message_id', params.externalMessageId)
			.maybeSingle();
		if (duplicate) {
			return {
				organizationId: duplicate.organization_id,
				conversationId: duplicate.conversation_id,
				messageId: duplicate.id,
				deduplicated: true
			};
		}
	}

	const { conv, contactName } = await resolveOrCreateWebhookConversationPg(admin, {
		channel,
		externalThreadId: params.externalThreadId,
		senderExternalId: params.senderExternalId,
		senderName: params.senderName,
		senderHandle: params.senderHandle
	});

	const nowIso = new Date().toISOString();
	const bodyText = params.body.trim() || '[Mensaje]';

	const { data: msgRow, error } = await admin
		.from('messages')
		.insert({
			organization_id: channel.organization_id,
			conversation_id: conv.id,
			channel_id: channel.id,
			external_message_id: params.externalMessageId ?? null,
			direction: 'inbound',
			sender_type: 'contact',
			sender_user_id: null,
			sender_label: params.senderName?.trim() || contactName,
			body: bodyText,
			attachments: [],
			status: 'delivered'
		})
		.select('id')
		.single();

	if (error) {
		if (error.code === '23505' && params.externalMessageId) {
			const { data: raced } = await admin
				.from('messages')
				.select('id, organization_id, conversation_id')
				.eq('channel_id', channel.id)
				.eq('external_message_id', params.externalMessageId)
				.maybeSingle();
			if (raced) {
				return {
					organizationId: raced.organization_id,
					conversationId: raced.conversation_id,
					messageId: raced.id,
					deduplicated: true
				};
			}
		}
		throw new Error(error.message ?? 'Error al guardar mensaje entrante');
	}
	if (!msgRow) {
		throw new Error('Error al guardar mensaje entrante');
	}

	await admin
		.from('conversations')
		.update({
			last_inbound_at: nowIso,
			last_message_at: nowIso,
			last_message_preview: bodyText,
			needs_reply: true,
			unread_count: conv.unread_count + 1,
			status: conv.status === 'closed' ? 'open' : conv.status
		})
		.eq('id', conv.id)
		.eq('organization_id', channel.organization_id);

	return {
		organizationId: channel.organization_id,
		conversationId: conv.id,
		messageId: msgRow.id,
		deduplicated: false
	};
}

export async function pgIngestExternalEchoMessage(params: {
	externalAccountId: string;
	externalMessageId?: string;
	externalThreadId?: string;
	senderExternalId?: string;
	senderName?: string;
	senderHandle?: string;
	body: string;
}): Promise<boolean> {
	const admin = requireAdminDb();
	const channel = await pgFindChannelByExternalAccountId(params.externalAccountId);
	if (!channel) return false;

	if (params.externalMessageId) {
		const { data: existing } = await admin
			.from('messages')
			.select('id')
			.eq('channel_id', channel.id)
			.eq('external_message_id', params.externalMessageId)
			.maybeSingle();
		if (existing) return true;
	}

	const { conv } = await resolveOrCreateWebhookConversationPg(admin, {
		channel,
		externalThreadId: params.externalThreadId,
		senderExternalId: params.senderExternalId,
		senderName: params.senderName,
		senderHandle: params.senderHandle
	});

	const nowIso = new Date().toISOString();
	const bodyText = params.body.trim() || '[Mensaje saliente]';

	await admin.from('messages').insert({
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
		status: 'sent'
	});

	await admin
		.from('conversations')
		.update({
			ai_paused: true,
			ai_handoff_reason: 'Respuesta manual desde app externa',
			ai_reply_count: 0,
			needs_reply: false,
			unread_count: 0,
			last_message_preview: `Externo: ${bodyText}`,
			last_message_at: nowIso
		})
		.eq('id', conv.id)
		.eq('organization_id', channel.organization_id);

	return true;
}

export async function pgUpdateMessageDeliveryStatus(params: {
	externalAccountId: string;
	externalMessageId: string;
	status: 'delivered' | 'read' | 'failed';
	errorCode?: string;
	errorDetail?: string;
}): Promise<boolean> {
	if (!params.externalMessageId) return false;
	const admin = requireAdminDb();
	const channel = await pgFindChannelByExternalAccountId(params.externalAccountId);
	if (!channel) return false;

	const { data: msg } = await admin
		.from('messages')
		.select('id, status')
		.eq('channel_id', channel.id)
		.eq('external_message_id', params.externalMessageId)
		.maybeSingle();
	if (!msg) return false;

	if (msg.status === 'read' && params.status === 'delivered') {
		return true;
	}

	await admin
		.from('messages')
		.update({
			status: params.status,
			error_code: params.status === 'failed' ? (params.errorCode ?? 'DELIVERY_FAILED') : null,
			error_detail:
				params.status === 'failed'
					? (params.errorDetail ?? 'No se pudo entregar el mensaje en el canal.')
					: null
		})
		.eq('id', msg.id);

	return true;
}

import {
	DEMO_SIM_CONTACT_EMAIL,
	DEMO_SIM_CONTACT_NAME,
	DEMO_SIM_DEAL_TITLE
} from '$lib/types/domain';
import { matchOpenStage, scoreForDemoStage } from './demo-lead';

export async function pgMarkChannelDisconnectedByExternalId(params: {
	externalAccountId: string;
	reason?: string;
	disconnectionType?: string;
	gracePeriodEndsAt?: string;
}): Promise<ConnectedChannel | null> {
	const admin = requireAdminDb();
	const channel = await pgFindChannelByExternalAccountId(params.externalAccountId);
	if (!channel) return null;

	const nextMetadata = {
		...channel.metadata,
		...(params.disconnectionType ? { disconnection_type: params.disconnectionType } : {}),
		...(params.reason ? { disconnection_reason: params.reason } : {}),
		...(params.gracePeriodEndsAt ? { grace_period_ends_at: params.gracePeriodEndsAt } : {})
	};

	const { data: updated } = await admin
		.from('connected_channels')
		.update({
			status: 'disconnected',
			metadata: nextMetadata as Database['public']['Tables']['connected_channels']['Update']['metadata']
		})
		.eq('id', channel.id)
		.select('*')
		.single();

	return updated ? mapChannel(updated) : channel;
}

async function ensurePgDemoLeadRecords(
	supabase: DbClient,
	organizationId: string,
	ownerUserId: string | null
) {
	const [{ data: stageRows, error: stageErr }, { data: orgRow }] = await Promise.all([
		supabase
			.from('pipeline_stages')
			.select('id, pipeline_id, name, slug, position, is_terminal')
			.eq('organization_id', organizationId)
			.eq('is_terminal', false)
			.order('position', { ascending: true }),
		supabase.from('organizations').select('currency').eq('id', organizationId).maybeSingle()
	]);

	if (stageErr || !stageRows || stageRows.length === 0) {
		throw new Error(stageErr?.message ?? 'No hay etapas activas en el pipeline');
	}

	const firstStage = stageRows[0];
	let { data: contactRow } = await supabase
		.from('contacts')
		.select('*')
		.eq('organization_id', organizationId)
		.eq('email', DEMO_SIM_CONTACT_EMAIL)
		.limit(1)
		.maybeSingle();

	if (!contactRow) {
		const { data: insertedContact, error: contactErr } = await supabase
			.from('contacts')
			.insert({
				organization_id: organizationId,
				name: DEMO_SIM_CONTACT_NAME,
				company: 'Simulador IA',
				role_title: 'Prospecto de prueba',
				email: DEMO_SIM_CONTACT_EMAIL,
				owner_user_id: ownerUserId,
				tags: ['demo-ia'],
				lead_score: 50,
				ai_intent_label: 'Lead nuevo (simulación)',
				lead_summary: 'Listo para iniciar prueba con el asistente IA.',
				next_step_title: 'Esperando primer mensaje de prueba',
				next_step_at: new Date().toISOString()
			})
			.select('*')
			.single();
		if (contactErr || !insertedContact) {
			throw new Error(contactErr?.message ?? 'No se pudo crear el contacto demo');
		}
		contactRow = insertedContact;
	}

	let { data: dealRow } = await supabase
		.from('deals')
		.select('*')
		.eq('organization_id', organizationId)
		.eq('contact_id', contactRow.id)
		.order('created_at', { ascending: false })
		.limit(1)
		.maybeSingle();

	if (!dealRow) {
		const { data: insertedDeal, error: dealErr } = await supabase
			.from('deals')
			.insert({
				organization_id: organizationId,
				pipeline_id: firstStage.pipeline_id,
				stage_id: firstStage.id,
				contact_id: contactRow.id,
				owner_user_id: ownerUserId ?? contactRow.owner_user_id,
				title: DEMO_SIM_DEAL_TITLE,
				deal_type: 'Prueba IA',
				value_cents: 0,
				currency: orgRow?.currency ?? 'MXN',
				position: 1000,
				last_moved_by: 'ai',
				ai_last_reason: 'Lead nuevo listo para probar el asistente IA.',
				next_step_title: 'Esperando primer mensaje de prueba',
				next_step_at: new Date().toISOString()
			})
			.select('*')
			.single();
		if (dealErr || !insertedDeal) {
			throw new Error(dealErr?.message ?? 'No se pudo crear la oportunidad demo');
		}
		dealRow = insertedDeal;
	}

	return { openStages: stageRows, firstStage, contactRow, dealRow };
}

export async function pgEnsureAndResetDemoLead(
	supabase: DbClient,
	organizationId: string,
	ownerUserId: string | null
): Promise<DemoLeadState> {
	const { firstStage, contactRow, dealRow } = await ensurePgDemoLeadRecords(
		supabase,
		organizationId,
		ownerUserId
	);
	const nowIso = new Date().toISOString();

	const [{ error: cErr }, { error: dErr }] = await Promise.all([
		supabase
			.from('contacts')
			.update({
				name: DEMO_SIM_CONTACT_NAME,
				company: 'Simulador IA',
				tags: ['demo-ia'],
				owner_user_id: ownerUserId ?? contactRow.owner_user_id,
				lead_score: 50,
				ai_intent_label: 'Lead nuevo (simulación)',
				lead_summary: 'Listo para iniciar prueba con el asistente IA.',
				next_step_title: 'Esperando primer mensaje de prueba',
				next_step_at: nowIso
			})
			.eq('id', contactRow.id)
			.eq('organization_id', organizationId),
		supabase
			.from('deals')
			.update({
				stage_id: firstStage.id,
				owner_user_id: ownerUserId ?? dealRow.owner_user_id,
				last_moved_by: 'ai',
				ai_last_reason: 'Lead nuevo listo para probar el asistente IA.',
				next_step_title: 'Esperando primer mensaje de prueba',
				next_step_at: nowIso,
				qualification_data: {},
				updated_at: nowIso
			})
			.eq('id', dealRow.id)
			.eq('organization_id', organizationId)
	]);

	if (cErr) throw new Error(cErr.message);
	if (dErr) throw new Error(dErr.message);

	return {
		contactId: contactRow.id,
		dealId: dealRow.id,
		stageId: firstStage.id,
		stageName: firstStage.name,
		stageSlug: firstStage.slug
	};
}

export async function pgSyncDemoLeadStageFromAi(
	supabase: DbClient,
	params: {
		organizationId: string;
		ownerUserId: string | null;
		recommendedStageName: string;
		intentSummary: string;
		followUpAction: string;
		needsHumanHandoff: boolean;
	}
): Promise<DemoLeadState> {
	const { openStages, contactRow, dealRow } = await ensurePgDemoLeadRecords(
		supabase,
		params.organizationId,
		params.ownerUserId
	);
	const targetStage = matchOpenStage(openStages, params.recommendedStageName, dealRow.stage_id);
	const nowIso = new Date().toISOString();

	const [{ error: dErr }, { error: cErr }] = await Promise.all([
		supabase
			.from('deals')
			.update({
				stage_id: targetStage.id,
				last_moved_by: 'ai',
				ai_last_reason: params.intentSummary,
				next_step_title: params.followUpAction,
				next_step_at: nowIso,
				qualification_data: {
					demo_simulation: true,
					needs_human_handoff: params.needsHumanHandoff,
					recommended_stage_name: targetStage.name,
					updated_at: nowIso
				},
				updated_at: nowIso
			})
			.eq('id', dealRow.id)
			.eq('organization_id', params.organizationId),
		supabase
			.from('contacts')
			.update({
				ai_intent_label: params.intentSummary,
				lead_summary: params.followUpAction,
				next_step_title: params.followUpAction,
				lead_score: scoreForDemoStage(targetStage.slug)
			})
			.eq('id', contactRow.id)
			.eq('organization_id', params.organizationId)
	]);

	if (dErr) throw new Error(dErr.message);
	if (cErr) throw new Error(cErr.message);

	return {
		contactId: contactRow.id,
		dealId: dealRow.id,
		stageId: targetStage.id,
		stageName: targetStage.name,
		stageSlug: targetStage.slug
	};
}
