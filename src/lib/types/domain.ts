export type OrgRole = 'owner' | 'admin' | 'agent' | 'viewer';
export type Platform = 'whatsapp' | 'instagram' | 'facebook';
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'expired';
export type BillingMode = 'trial' | 'per_channel';
export type ChannelStatus = 'active' | 'disconnected' | 'paused_billing' | 'error';
export type ConversationStatus = 'open' | 'pending' | 'closed';
export type MessageDirection = 'inbound' | 'outbound';
export type MessageSenderType = 'contact' | 'agent' | 'ai' | 'external_human';
export type MessageStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed';
export type AiTone = 'friendly' | 'professional' | 'direct';
export type InboundAudioPolicy = 'transcribe_and_reply' | 'handoff_human';
export type KnowledgeSourceType = 'faq' | 'text' | 'file' | 'url';
export type KnowledgeStatus = 'processing' | 'ready' | 'error';
export type InvitationStatus = 'pending' | 'accepted' | 'expired' | 'revoked';

export const ROLE_RANK: Record<OrgRole, number> = {
	viewer: 1,
	agent: 2,
	admin: 3,
	owner: 4
};

export function hasMinRole(role: OrgRole | null | undefined, minRole: OrgRole): boolean {
	if (!role) return false;
	return ROLE_RANK[role] >= ROLE_RANK[minRole];
}

export interface Profile {
	id: string;
	full_name: string;
	initials: string;
	avatar_url: string | null;
	email: string;
	created_at: string;
	updated_at: string;
}

export interface Organization {
	id: string;
	name: string;
	slug: string;
	industry: string;
	language: string;
	currency: string;
	zernio_profile_id: string;
	subscription_status: SubscriptionStatus;
	billing_mode: BillingMode;
	stripe_customer_id: string | null;
	stripe_subscription_id: string | null;
	stripe_channel_item_id: string | null;
	stripe_ai_overage_item_id: string | null;
	channel_slots: number;
	included_ai_replies_per_channel: number;
	ai_overage_enabled: boolean;
	kb_document_limit: number;
	trial_ends_at: string | null;
	current_period_start: string;
	current_period_end: string;
	created_at: string;
}

export interface OrganizationMember {
	organization_id: string;
	user_id: string;
	role: OrgRole;
	profile: Profile;
	created_at: string;
}

export interface OrganizationInvitation {
	id: string;
	organization_id: string;
	organization_name: string;
	organization_slug: string;
	email: string;
	role: Exclude<OrgRole, 'owner'>;
	token_hash: string;
	demo_token: string;
	invited_by_name: string;
	status: InvitationStatus;
	expires_at: string;
	accepted_at: string | null;
	created_at: string;
}

export interface ConnectedChannel {
	id: string;
	organization_id: string;
	provider: 'zernio';
	platform: Platform;
	external_account_id: string;
	display_name: string;
	handle_or_phone: string;
	status: ChannelStatus;
	metadata: Record<string, unknown>;
	created_at: string;
	updated_at: string;
}

export interface Contact {
	id: string;
	organization_id: string;
	name: string;
	company: string | null;
	role_title: string | null;
	avatar_url: string | null;
	email: string | null;
	phone: string | null;
	owner_user_id: string | null;
	tags: string[];
	lead_score: number;
	lead_summary: string | null;
	ai_intent_label: string | null;
	next_step_title: string | null;
	next_step_at_label: string | null;
	next_step_overdue: boolean;
	created_at: string;
	updated_at: string;
}

export interface ContactIdentity {
	id: string;
	organization_id: string;
	contact_id: string;
	platform: Platform;
	external_user_id: string;
	username_or_phone: string;
	created_at: string;
}

export interface ContactNote {
	id: number;
	organization_id: string;
	contact_id: string;
	conversation_id: string | null;
	author_user_id: string;
	author_name: string;
	body: string;
	created_at: string;
	display_time: string;
}

export interface MessageAttachment {
	storage_path: string;
	mime_type: string;
	file_name: string;
	size_bytes: number;
	kind: 'image' | 'audio' | 'file';
}

export interface Message {
	id: number;
	organization_id: string;
	conversation_id: string;
	channel_id: string;
	external_message_id: string | null;
	direction: MessageDirection;
	sender_type: MessageSenderType;
	sender_user_id: string | null;
	sender_label: string;
	body: string;
	attachments: MessageAttachment[];
	status: MessageStatus;
	error_code: string | null;
	error_detail: string | null;
	day_group: string;
	display_time: string;
	created_at: string;
}

export interface Conversation {
	id: string;
	organization_id: string;
	channel_id: string;
	contact_id: string;
	external_thread_id: string;
	platform: Platform;
	status: ConversationStatus;
	assigned_to: string | null;
	needs_reply: boolean;
	ai_paused: boolean;
	ai_handoff_reason: string | null;
	ai_reply_count: number;
	ai_processing_locked_until: string | null;
	last_processed_inbound_message_id: number | null;
	last_inbound_at: string | null;
	last_message_preview: string;
	last_message_at: string;
	display_time: string;
	unread_count: number;
	created_at: string;
	updated_at: string;
}

export interface Pipeline {
	id: string;
	organization_id: string;
	name: string;
	is_default: boolean;
	created_at: string;
}

export interface PipelineStage {
	id: string;
	organization_id: string;
	pipeline_id: string;
	name: string;
	slug: string;
	color: string;
	position: number;
	is_terminal: boolean;
	ai_qualification_hint: string;
	created_at: string;
}

export interface Deal {
	id: string;
	organization_id: string;
	pipeline_id: string;
	stage_id: string;
	contact_id: string;
	conversation_id: string | null;
	owner_user_id: string | null;
	title: string;
	deal_type: string;
	value_cents: number;
	currency: string;
	position: number;
	last_moved_by: 'human' | 'ai';
	ai_last_reason: string | null;
	ai_updated_label: string | null;
	next_step_title: string | null;
	next_step_label: string | null;
	next_step_overdue: boolean;
	stage_age_label: string;
	created_age_label: string;
	qualification_data: Record<string, unknown>;
	created_at: string;
	updated_at: string;
}

export interface AiSettings {
	organization_id: string;
	enabled: boolean;
	auto_reply_enabled: boolean;
	auto_qualify_enabled: boolean;
	handle_inbound_audio: InboundAudioPolicy;
	business_context: string;
	tone: AiTone;
	handoff_rules: string;
	max_ai_replies_per_thread: number;
	updated_at: string;
}

export interface KnowledgeDocument {
	id: string;
	organization_id: string;
	title: string;
	subtitle: string | null;
	source_type: KnowledgeSourceType;
	source_url: string | null;
	storage_path: string | null;
	content_preview: string | null;
	embedding_model: string;
	status: KnowledgeStatus;
	error_detail: string | null;
	created_at: string;
}

export interface OrgUsagePeriod {
	id: number;
	organization_id: string;
	period_start: string;
	period_end: string;
	included_ai_replies: number;
	used_ai_replies: number;
	overage_ai_replies: number;
	draft_count: number;
	test_chat_count: number;
	updated_at: string;
}

export interface AiUsageLedger {
	id: number;
	organization_id: string;
	usage_period_id: number | null;
	conversation_id: string | null;
	action: 'auto_reply' | 'draft' | 'qualify_only' | 'embed' | 'test_chat';
	billable_units: number;
	model: string;
	input_tokens: number;
	output_tokens: number;
	estimated_cost_micros: number;
	stripe_meter_reported_at: string | null;
	created_at: string;
}

export interface RoleChangeRequest {
	id: string;
	organization_id: string;
	user_id: string;
	user_name: string;
	user_email: string;
	current_role: OrgRole;
	requested_role: Exclude<OrgRole, 'owner'>;
	status: 'pending' | 'approved' | 'rejected';
	created_at: string;
}

export interface TimelineEvent {
	id: string;
	organization_id: string;
	contact_id: string;
	deal_id: string | null;
	title: string;
	detail: string;
	timestamp_label: string;
	created_at: string;
}

export interface AiSimulationResult {
	reply_text: string;
	source_title: string | null;
	recommended_stage_name: string;
	follow_up_action: string;
	intent_summary: string;
	needs_human_handoff: boolean;
}

export const DEMO_SIM_CONTACT_EMAIL = 'demo-ia@okeo.test';
export const DEMO_SIM_CONTACT_NAME = 'Prospecto Demo (IA)';
export const DEMO_SIM_DEAL_TITLE = 'Simulación de Asistente IA';

export interface DemoLeadState {
	contactId: string;
	dealId: string;
	stageId: string;
	stageName: string;
	stageSlug: string;
}
