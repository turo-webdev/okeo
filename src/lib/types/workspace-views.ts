import type {
	AiSettings,
	ConnectedChannel,
	Contact,
	ContactIdentity,
	ContactNote,
	Conversation,
	Deal,
	DemoLeadState,
	KnowledgeDocument,
	Message,
	Organization,
	OrganizationInvitation,
	OrganizationMember,
	OrgRole,
	PipelineStage,
	RoleChangeRequest,
	TimelineEvent
} from './domain';

export type WorkspaceViewName = 'inbox' | 'pipeline' | 'contacts' | 'ai' | 'settings';

export interface UsageSummary {
	channelPriceUsd: number;
	monthlyTotalUsd: number;
	activeChannelsCount: number;
	channelSlots: number;
	includedAiReplies: number;
	usedAiReplies: number;
	remainingAiReplies: number;
	usagePercent: number;
	unlimitedUsers: boolean;
}

export type InboxConversationItem = Conversation & { within24h: boolean };

export interface InboxViewPayload {
	conversations: InboxConversationItem[];
	contacts: Contact[];
	identities: ContactIdentity[];
	messages: Message[];
	notes: ContactNote[];
	deals: Deal[];
	stages: PipelineStage[];
	timelineEvents: TimelineEvent[];
	channels: ConnectedChannel[];
	members: OrganizationMember[];
}

export interface PipelineViewPayload {
	stages: PipelineStage[];
	deals: Deal[];
	contacts: Contact[];
	notes: ContactNote[];
	timelineEvents: TimelineEvent[];
	members: OrganizationMember[];
}

export interface ContactsViewPayload {
	contacts: Contact[];
	identities: ContactIdentity[];
	members: OrganizationMember[];
}

export interface ContactDetailViewPayload {
	contact: Contact;
	identities: ContactIdentity[];
	deals: Deal[];
	stages: PipelineStage[];
	notes: ContactNote[];
	conversation: Conversation | null;
	timelineEvents: TimelineEvent[];
	members: OrganizationMember[];
}

export interface AiViewPayload {
	geminiConfigured: boolean;
	geminiModel: string;
	initialDemoLead: DemoLeadState | null;
	aiSettings: AiSettings;
	knowledgeDocuments: KnowledgeDocument[];
	stages: PipelineStage[];
}

export interface SettingsViewPayload {
	organizations: Array<Organization & { role: OrgRole }>;
	zernioConfigured: boolean;
	stripeConfigured: boolean;
	emailConfigured: boolean;
	channels: ConnectedChannel[];
	members: OrganizationMember[];
	invitations: OrganizationInvitation[];
	roleChangeRequests: RoleChangeRequest[];
	usageSummary: UsageSummary | null;
}

export interface WorkspaceViewMap {
	inbox: InboxViewPayload;
	pipeline: PipelineViewPayload;
	contacts: ContactsViewPayload;
	ai: AiViewPayload;
	settings: SettingsViewPayload;
}

export interface WorkspaceBootstrapPayload {
	inbox: InboxViewPayload;
	pipeline: PipelineViewPayload;
	contacts: ContactsViewPayload;
	ai: AiViewPayload | null;
	settings: SettingsViewPayload;
}
