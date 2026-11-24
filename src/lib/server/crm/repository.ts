import type { SupabaseClient } from '@supabase/supabase-js';
import type { KnowledgeUploadedFile } from '$lib/server/ai/knowledge-ingest';
import { getUsageSummary } from '$lib/server/billing/plans';
import { getSupabaseAdminClient, isSupabaseAdminConfigured } from '$lib/server/supabase-admin';
import type { Database } from '$lib/types/database.types';
import {
	DEMO_SIM_CONTACT_EMAIL,
	type AiSettings,
	type ConnectedChannel,
	type Contact,
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
	type PipelineStage,
	type Platform,
	type Profile,
	type RoleChangeRequest,
	type TimelineEvent
} from '$lib/types/domain';
import * as mem from './memory';
import * as pg from './postgres';

export { hashTokenSha256, isUuid } from './postgres';

export interface RepoContext {
	supabase?: SupabaseClient<Database> | null;
	authMode?: 'supabase' | 'demo';
	demoRole?: OrgRole;
	requestCache?: Map<string, Promise<unknown>>;
	safeGetAuth?: () => Promise<{ userId: string; email: string; authMode: 'supabase' | 'demo' }>;
}

function memoizeRequest<T>(
	ctx: RepoContext | undefined,
	key: string,
	loader: () => Promise<T>
): Promise<T> {
	const cache = ctx?.requestCache;
	if (!cache) return loader();
	const hit = cache.get(key) as Promise<T> | undefined;
	if (hit) return hit;
	const promise = loader().catch((err) => {
		cache.delete(key);
		throw err;
	});
	cache.set(key, promise);
	return promise;
}

function usePgContext(
	ctx?: RepoContext
): ctx is { supabase: SupabaseClient<Database>; authMode: 'supabase' } {
	return ctx?.authMode === 'supabase' && Boolean(ctx.supabase);
}

function resolveDbForOrg(organizationId: string, ctx?: RepoContext): SupabaseClient<Database> | null {
	if (usePgContext(ctx)) return ctx.supabase;
	if (pg.isUuid(organizationId) && isSupabaseAdminConfigured()) {
		return getSupabaseAdminClient();
	}
	return null;
}

function isMockExternalAccountId(externalAccountId: string): boolean {
	return (
		!externalAccountId ||
		externalAccountId.startsWith('acc_mock_') ||
		externalAccountId.startsWith('acc_ws_') ||
		externalAccountId.startsWith('acc_ct_')
	);
}

function isDemoInviteToken(token: string): boolean {
	return (
		token === 'valid' ||
		token === 'expired' ||
		token === 'mismatch' ||
		token === 'revoked' ||
		token.startsWith('inv_')
	);
}

export const getDemoUser = mem.getDemoUser;
export const hasProcessedWebhookEvent = mem.hasProcessedWebhookEvent;
export const markWebhookEventProcessed = mem.markWebhookEventProcessed;

export async function getOrganizationBySlug(
	slug: string,
	ctx?: RepoContext
): Promise<Organization | null> {
	if (usePgContext(ctx)) {
		return pg.pgGetOrganizationBySlug(ctx.supabase, slug);
	}
	return mem.getOrganizationBySlug(slug);
}

export async function getOrganizationById(
	organizationId: string,
	ctx?: RepoContext
): Promise<Organization | null> {
	const db = resolveDbForOrg(organizationId, ctx);
	if (db) {
		return pg.pgGetOrganizationById(db, organizationId);
	}
	return mem.getOrganizationById(organizationId);
}

export async function listUserOrganizations(
	userId: string,
	ctx?: RepoContext
): Promise<Array<Organization & { role: OrgRole }>> {
	return memoizeRequest(ctx, `userOrgs:${userId}`, async () => {
		if (usePgContext(ctx)) {
			return pg.pgListUserOrganizations(ctx.supabase, userId);
		}
		return mem.listUserOrganizations(userId);
	});
}

function getWorkspaceMembersCached(
	db: SupabaseClient<Database>,
	organizationId: string,
	ctx?: RepoContext
): Promise<OrganizationMember[]> {
	return memoizeRequest(ctx, `members:${organizationId}`, () =>
		pg.pgListWorkspaceMembers(db, organizationId)
	);
}

function getWorkspaceChannelsCached(
	db: SupabaseClient<Database>,
	organizationId: string,
	ctx?: RepoContext
): Promise<ConnectedChannel[]> {
	return memoizeRequest(ctx, `channels:${organizationId}`, () =>
		pg.pgListWorkspaceChannels(db, organizationId)
	);
}

function getLatestUsagePeriodCached(
	db: SupabaseClient<Database>,
	organizationId: string,
	ctx?: RepoContext
): Promise<OrgUsagePeriod | null> {
	return memoizeRequest(ctx, `usagePeriod:${organizationId}`, () =>
		pg.pgGetLatestUsagePeriod(db, organizationId)
	);
}

export async function resolveWorkspaceAccess(
	slug: string,
	locals: App.Locals
): Promise<
	| { authorized: true; userId: string; org: Organization; effectiveRole: OrgRole }
	| { authorized: false; userId: string; deniedOrgName: string }
> {
	const auth = await locals.safeGetAuth();
	return memoizeRequest(locals, `access:${slug}:${auth.userId}`, async () => {
		if (auth.authMode === 'supabase' && locals.supabase) {
			if (locals.requestCache?.has(`userOrgs:${auth.userId}`)) {
				const orgs = await listUserOrganizations(auth.userId, locals);
				const matched = orgs.find((o) => o.slug === slug);
				if (!matched) {
					return { authorized: false as const, userId: auth.userId, deniedOrgName: slug };
				}
				const { role, ...org } = matched;
				return {
					authorized: true as const,
					userId: auth.userId,
					org,
					effectiveRole: role
				};
			}

			const access = await pg.pgGetWorkspaceAccessBySlug(locals.supabase, slug, auth.userId);
			if (!access.authorized) {
				return {
					authorized: false as const,
					userId: auth.userId,
					deniedOrgName: access.deniedOrgName
				};
			}
			return {
				authorized: true as const,
				userId: auth.userId,
				org: access.org,
				effectiveRole: access.role
			};
		}

		const org = mem.getOrganizationBySlug(slug);
		const membership = org ? mem.getMembership(org.id, auth.userId) : null;
		if (!org || !membership) {
			return {
				authorized: false as const,
				userId: auth.userId,
				deniedOrgName: org?.name ?? slug
			};
		}
		return {
			authorized: true as const,
			userId: auth.userId,
			org,
			effectiveRole: locals.demoRole ?? membership.role
		};
	});
}

export async function getLayoutWorkspaceData(org: Organization, ctx?: RepoContext) {
	const db = resolveDbForOrg(org.id, ctx);
	if (db) {
		const [members, channels, usagePeriod, unreadBadge] = await Promise.all([
			getWorkspaceMembersCached(db, org.id, ctx),
			getWorkspaceChannelsCached(db, org.id, ctx),
			getLatestUsagePeriodCached(db, org.id, ctx),
			pg.pgCountOpenConversations(db, org.id)
		]);
		const activeChannelsCount = channels.filter((c) => c.status === 'active').length;
		const usageSummary = usagePeriod ? getUsageSummary(org, usagePeriod, activeChannelsCount) : null;
		return { members, channels, usageSummary, unreadBadge };
	}

	const snapshot = mem.getWorkspaceSnapshot(org.id);
	if (!snapshot) {
		return { members: [], channels: [], usageSummary: null, unreadBadge: 0 };
	}
	return {
		members: snapshot.members,
		channels: snapshot.channels,
		usageSummary: snapshot.usageSummary,
		unreadBadge: snapshot.conversations.filter((c) => c.status !== 'closed').length
	};
}

export async function getInboxPageData(organizationId: string, ctx?: RepoContext) {
	const db = resolveDbForOrg(organizationId, ctx);
	if (db) {
		return pg.pgGetInboxPageData(
			db,
			organizationId,
			getWorkspaceMembersCached(db, organizationId, ctx),
			getWorkspaceChannelsCached(db, organizationId, ctx)
		);
	}
	const snapshot = mem.getWorkspaceSnapshot(organizationId);
	if (!snapshot) return null;
	return {
		members: snapshot.members,
		channels: snapshot.channels,
		conversations: snapshot.conversations,
		contacts: snapshot.contacts,
		identities: snapshot.identities,
		messages: snapshot.messages,
		notes: snapshot.notes,
		deals: snapshot.deals,
		stages: snapshot.stages,
		timelineEvents: snapshot.timelineEvents
	};
}

export async function getPipelinePageData(organizationId: string, ctx?: RepoContext) {
	const db = resolveDbForOrg(organizationId, ctx);
	if (db) {
		return pg.pgGetPipelinePageData(
			db,
			organizationId,
			getWorkspaceMembersCached(db, organizationId, ctx)
		);
	}
	const snapshot = mem.getWorkspaceSnapshot(organizationId);
	if (!snapshot) return null;
	return {
		members: snapshot.members,
		stages: snapshot.stages,
		deals: snapshot.deals,
		contacts: snapshot.contacts,
		notes: snapshot.notes,
		timelineEvents: snapshot.timelineEvents
	};
}

export async function getContactsPageData(organizationId: string, ctx?: RepoContext) {
	const db = resolveDbForOrg(organizationId, ctx);
	if (db) {
		return pg.pgGetContactsPageData(
			db,
			organizationId,
			getWorkspaceMembersCached(db, organizationId, ctx)
		);
	}
	const snapshot = mem.getWorkspaceSnapshot(organizationId);
	if (!snapshot) return null;
	return {
		members: snapshot.members,
		contacts: snapshot.contacts,
		identities: snapshot.identities
	};
}

export async function getContactDetailPageData(
	organizationId: string,
	contactId: string,
	ctx?: RepoContext
) {
	const db = resolveDbForOrg(organizationId, ctx);
	if (db) {
		return pg.pgGetContactDetailPageData(
			db,
			organizationId,
			contactId,
			getWorkspaceMembersCached(db, organizationId, ctx)
		);
	}
	const snapshot = mem.getWorkspaceSnapshot(organizationId);
	if (!snapshot) return null;
	const contact = snapshot.contacts.find((c) => c.id === contactId);
	if (!contact) return null;
	return {
		contact,
		identities: snapshot.identities.filter((i) => i.contact_id === contact.id),
		deals: snapshot.deals.filter((d) => d.contact_id === contact.id),
		stages: snapshot.stages,
		notes: snapshot.notes.filter((n) => n.contact_id === contact.id),
		conversation: snapshot.conversations.find((c) => c.contact_id === contact.id) ?? null,
		timelineEvents: snapshot.timelineEvents.filter((e) => e.contact_id === contact.id),
		members: snapshot.members
	};
}

export async function getAiPageData(organizationId: string, ctx?: RepoContext) {
	const db = resolveDbForOrg(organizationId, ctx);
	if (db) {
		return pg.pgGetAiPageData(db, organizationId, DEMO_SIM_CONTACT_EMAIL);
	}
	const snapshot = mem.getWorkspaceSnapshot(organizationId);
	if (!snapshot) return null;
	const openStages = snapshot.stages.filter((s) => !s.is_terminal);
	const demoContact = snapshot.contacts.find((c) => c.email === DEMO_SIM_CONTACT_EMAIL);
	const demoDeal = demoContact
		? snapshot.deals.find((d) => d.contact_id === demoContact.id)
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
		aiSettings: snapshot.aiSettings,
		knowledgeDocuments: snapshot.knowledgeDocuments,
		stages: openStages,
		initialDemoLead
	};
}

export async function getSettingsPageData(org: Organization, ctx?: RepoContext) {
	const db = resolveDbForOrg(org.id, ctx);
	if (db) {
		return pg.pgGetSettingsPageData(
			db,
			org,
			getWorkspaceMembersCached(db, org.id, ctx),
			getWorkspaceChannelsCached(db, org.id, ctx),
			getLatestUsagePeriodCached(db, org.id, ctx)
		);
	}
	const snapshot = mem.getWorkspaceSnapshot(org.id);
	if (!snapshot) {
		return {
			members: [],
			channels: [],
			invitations: [],
			roleChangeRequests: [] as RoleChangeRequest[],
			usageSummary: null
		};
	}
	return {
		members: snapshot.members,
		channels: snapshot.channels,
		invitations: snapshot.invitations,
		roleChangeRequests: snapshot.roleChangeRequests,
		usageSummary: snapshot.usageSummary
	};
}

export async function getMembership(
	organizationId: string,
	userId: string,
	ctx?: RepoContext
): Promise<OrganizationMember | null> {
	const db = resolveDbForOrg(organizationId, ctx);
	if (db) {
		return pg.pgGetMembership(db, organizationId, userId);
	}
	return mem.getMembership(organizationId, userId);
}

export async function requireOrgMembership(
	organizationId: string,
	userId: string,
	minRole: OrgRole = 'viewer',
	overrideRole?: OrgRole,
	ctx?: RepoContext
): Promise<{ org: Organization; member: OrganizationMember; effectiveRole: OrgRole }> {
	const db = resolveDbForOrg(organizationId, ctx);
	if (db) {
		// En sesiones reales nunca se aplica demoRole override (AGENTS.md §2).
		return pg.pgRequireOrgMembership(db, organizationId, userId, minRole);
	}
	return mem.requireOrgMembership(organizationId, userId, minRole, overrideRole);
}

export async function getWorkspaceSnapshot(
	organizationId: string,
	ctx?: RepoContext,
	knownOrg?: Organization
) {
	const db = resolveDbForOrg(organizationId, ctx);
	if (db) {
		return pg.pgGetWorkspaceSnapshot(db, organizationId, knownOrg);
	}
	return mem.getWorkspaceSnapshot(organizationId);
}

export async function getConversationAndChannel(
	organizationId: string,
	conversationId: string,
	ctx?: RepoContext
) {
	const db = resolveDbForOrg(organizationId, ctx);
	if (db) {
		return pg.pgGetConversationAndChannel(db, organizationId, conversationId);
	}
	return mem.getConversationAndChannel(organizationId, conversationId);
}

export async function getContactById(
	organizationId: string,
	contactId: string,
	ctx?: RepoContext
): Promise<Contact | null> {
	const db = resolveDbForOrg(organizationId, ctx);
	if (db) {
		return pg.pgGetContactById(db, organizationId, contactId);
	}
	return mem.getContactById(organizationId, contactId);
}

export async function listWorkspaceChannels(
	organizationId: string,
	ctx?: RepoContext
): Promise<ConnectedChannel[]> {
	const db = resolveDbForOrg(organizationId, ctx);
	if (db) {
		return getWorkspaceChannelsCached(db, organizationId, ctx);
	}
	return mem.getWorkspaceSnapshot(organizationId)?.channels ?? [];
}

export async function getChannelById(
	organizationId: string,
	channelId: string,
	ctx?: RepoContext
): Promise<ConnectedChannel | null> {
	const db = resolveDbForOrg(organizationId, ctx);
	if (db) {
		return pg.pgGetChannelById(db, organizationId, channelId);
	}
	return mem.getChannelById(organizationId, channelId);
}

export async function getConversationMessagesPage(
	organizationId: string,
	conversationId: string,
	opts: { beforeId?: number; limit?: number } = {},
	ctx?: RepoContext
) {
	const db = resolveDbForOrg(organizationId, ctx);
	if (db) {
		return pg.pgGetConversationMessagesPage(db, organizationId, conversationId, opts);
	}
	return mem.getConversationMessagesPage(organizationId, conversationId, opts);
}

export async function getAiDraftContext(
	org: Organization,
	conversationId: string,
	ctx?: RepoContext
) {
	const db = resolveDbForOrg(org.id, ctx);
	if (db) {
		return pg.pgGetAiDraftContext(db, org, conversationId);
	}
	return mem.getAiDraftContext(org, conversationId);
}

export async function createWorkspace(
	params: {
		userId: string;
		userEmail?: string;
		userName?: string;
		name: string;
		platform: Platform;
		industry: string;
		language: 'es' | 'en';
		autoReplyEnabled: boolean;
		initialKnowledge: string;
	},
	ctx?: RepoContext
): Promise<Organization> {
	if (usePgContext(ctx) && isSupabaseAdminConfigured()) {
		return pg.pgCreateWorkspace(params);
	}
	return mem.createWorkspace(params);
}

export async function sendManualMessage(
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
	},
	ctx?: RepoContext
): Promise<Message> {
	const db = resolveDbForOrg(params.organizationId, ctx);
	if (db) {
		return pg.pgSendManualMessage(db, params);
	}
	return mem.sendManualMessage(params);
}

export async function addInternalNote(
	params: {
		organizationId: string;
		contactId: string;
		conversationId: string | null;
		userId: string;
		body: string;
	},
	ctx?: RepoContext
): Promise<ContactNote> {
	const db = resolveDbForOrg(params.organizationId, ctx);
	if (db) {
		return pg.pgAddInternalNote(db, params);
	}
	return mem.addInternalNote(params);
}

export async function updateConversationState(
	params: {
		organizationId: string;
		conversationId: string;
		assignedTo?: string | null;
		status?: 'open' | 'pending' | 'closed';
		aiPaused?: boolean;
	},
	ctx?: RepoContext
): Promise<Conversation> {
	const db = resolveDbForOrg(params.organizationId, ctx);
	if (db) {
		return pg.pgUpdateConversationState(db, params);
	}
	return mem.updateConversationState(params);
}

export async function createDeal(
	params: {
		organizationId: string;
		title: string;
		contactId: string;
		stageId: string;
		dealType: string;
		valueAmount: number;
		ownerUserId: string | null;
	},
	ctx?: RepoContext
): Promise<Deal> {
	const db = resolveDbForOrg(params.organizationId, ctx);
	if (db) {
		return pg.pgCreateDeal(db, params);
	}
	return mem.createDeal(params);
}

export async function updateDeal(
	params: {
		organizationId: string;
		dealId: string;
		stageId?: string;
		contactId?: string;
		dealType?: string;
		ownerUserId?: string | null;
		nextStepTitle?: string;
		nextStepLabel?: string;
	},
	ctx?: RepoContext
): Promise<Deal> {
	const db = resolveDbForOrg(params.organizationId, ctx);
	if (db) {
		return pg.pgUpdateDeal(db, params);
	}
	return mem.updateDeal(params);
}

export async function createContact(
	params: {
		organizationId: string;
		name: string;
		company: string;
		email: string;
		phone: string;
		ownerUserId: string | null;
		nextStepTitle: string;
		nextStepAtLabel: string;
	},
	ctx?: RepoContext
): Promise<Contact> {
	const db = resolveDbForOrg(params.organizationId, ctx);
	if (db) {
		return pg.pgCreateContact(db, params);
	}
	return mem.createContact(params);
}

export async function updateContact(
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
	},
	ctx?: RepoContext
): Promise<Contact> {
	const db = resolveDbForOrg(params.organizationId, ctx);
	if (db) {
		return pg.pgUpdateContact(db, params);
	}
	return mem.updateContact(params);
}

export async function updateAiMode(
	organizationId: string,
	autoReplyEnabled: boolean,
	ctx?: RepoContext
): Promise<AiSettings> {
	const db = resolveDbForOrg(organizationId, ctx);
	if (db) {
		return pg.pgUpdateAiMode(db, organizationId, autoReplyEnabled);
	}
	return mem.updateAiMode(organizationId, autoReplyEnabled);
}

export async function updateAiPreferences(
	params: {
		organizationId: string;
		tone: 'friendly' | 'professional' | 'direct';
		autoQualifyEnabled: boolean;
		maxAiRepliesPerThread: number;
		handoffRules: string;
		businessContext?: string;
	},
	ctx?: RepoContext
): Promise<AiSettings> {
	const db = resolveDbForOrg(params.organizationId, ctx);
	if (db) {
		return pg.pgUpdateAiPreferences(db, params);
	}
	return mem.updateAiPreferences(params);
}

export async function updatePipelineQualificationRules(
	organizationId: string,
	rules: Record<string, string>,
	ctx?: RepoContext
): Promise<PipelineStage[]> {
	const db = resolveDbForOrg(organizationId, ctx);
	if (db) {
		return pg.pgUpdatePipelineQualificationRules(db, organizationId, rules);
	}
	return mem.updatePipelineQualificationRules(organizationId, rules);
}

export async function addKnowledgeDocument(
	params: {
		organizationId: string;
		sourceType: 'faq' | 'text' | 'file' | 'url';
		title: string;
		question: string;
		answer: string;
		content: string;
		url: string;
		file?: KnowledgeUploadedFile | null;
	},
	ctx?: RepoContext
): Promise<KnowledgeDocument> {
	const db = resolveDbForOrg(params.organizationId, ctx);
	if (db) {
		return pg.pgAddKnowledgeDocument(db, params);
	}
	return mem.addKnowledgeDocument(params);
}

export async function updateKnowledgeDocument(
	params: {
		organizationId: string;
		documentId: string;
		title: string;
		content: string;
		url?: string;
	},
	ctx?: RepoContext
): Promise<KnowledgeDocument> {
	const db = resolveDbForOrg(params.organizationId, ctx);
	if (db) {
		return pg.pgUpdateKnowledgeDocument(db, params);
	}
	return mem.updateKnowledgeDocument(params);
}

export async function deleteKnowledgeDocument(
	organizationId: string,
	documentId: string,
	ctx?: RepoContext
): Promise<{ deletedId: string }> {
	const db = resolveDbForOrg(organizationId, ctx);
	if (db) {
		return pg.pgDeleteKnowledgeDocument(db, organizationId, documentId);
	}
	return mem.deleteKnowledgeDocument(organizationId, documentId);
}

export async function retryKnowledgeDocument(
	organizationId: string,
	documentId: string,
	ctx?: RepoContext
): Promise<KnowledgeDocument> {
	const db = resolveDbForOrg(organizationId, ctx);
	if (db) {
		return pg.pgRetryKnowledgeDocument(db, organizationId, documentId);
	}
	return mem.retryKnowledgeDocument(organizationId, documentId);
}

export async function createInvitation(
	params: {
		organizationId: string;
		email: string;
		role: Exclude<OrgRole, 'owner'>;
		invitedByUserId?: string;
		invitedByName: string;
	},
	ctx?: RepoContext
): Promise<OrganizationInvitation> {
	const db = resolveDbForOrg(params.organizationId, ctx);
	if (db && params.invitedByUserId) {
		return pg.pgCreateInvitation(db, {
			organizationId: params.organizationId,
			email: params.email,
			role: params.role,
			invitedByUserId: params.invitedByUserId,
			invitedByName: params.invitedByName
		});
	}
	return mem.createInvitation(params);
}

export async function revokeInvitation(
	organizationId: string,
	invitationId: string,
	ctx?: RepoContext
): Promise<void> {
	const db = resolveDbForOrg(organizationId, ctx);
	if (db) {
		return pg.pgRevokeInvitation(db, organizationId, invitationId);
	}
	return mem.revokeInvitation(organizationId, invitationId);
}

export async function refreshInvitationToken(
	params: {
		organizationId: string;
		invitationId: string;
		invitedByName: string;
	},
	ctx?: RepoContext
): Promise<OrganizationInvitation> {
	const db = resolveDbForOrg(params.organizationId, ctx);
	if (db) {
		return pg.pgRefreshInvitationToken(db, params);
	}
	return mem.refreshInvitationToken(params);
}

export async function getInvitationByToken(
	token: string
): Promise<OrganizationInvitation | null> {
	if (!isDemoInviteToken(token) && isSupabaseAdminConfigured()) {
		return pg.pgGetInvitationByToken(token);
	}
	return mem.getInvitationByToken(token);
}

export async function acceptInvitation(
	token: string,
	acceptingUser?: Pick<Profile, 'id' | 'email' | 'full_name'> | null
): Promise<OrganizationInvitation | null> {
	if (!isDemoInviteToken(token) && isSupabaseAdminConfigured()) {
		if (!acceptingUser) return null;
		const res = await pg.pgAcceptInvitation(token, acceptingUser);
		return res.ok ? res.invitation : null;
	}
	return mem.acceptInvitation(token);
}

export async function updateMemberRole(
	organizationId: string,
	userId: string,
	role: OrgRole,
	ctx?: RepoContext
): Promise<void> {
	const db = resolveDbForOrg(organizationId, ctx);
	if (db) {
		return pg.pgUpdateMemberRole(db, organizationId, userId, role);
	}
	return mem.updateMemberRole(organizationId, userId, role);
}

export async function createRoleChangeRequest(
	params: {
		organizationId: string;
		userId: string;
		requestedRole: Exclude<OrgRole, 'owner'>;
	},
	ctx?: RepoContext
): Promise<RoleChangeRequest> {
	if (usePgContext(ctx)) {
		return {
			id: `rcr_${Date.now()}`,
			organization_id: params.organizationId,
			user_id: params.userId,
			user_name: 'Miembro',
			user_email: '',
			current_role: 'viewer',
			requested_role: params.requestedRole,
			status: 'pending',
			created_at: new Date().toISOString()
		};
	}
	return mem.createRoleChangeRequest(params);
}

export async function resolveRoleChangeRequest(
	organizationId: string,
	requestId: string,
	approve: boolean,
	ctx?: RepoContext
): Promise<void> {
	if (usePgContext(ctx)) return;
	return mem.resolveRoleChangeRequest(organizationId, requestId, approve);
}

export async function reconnectChannel(
	organizationId: string,
	channelId: string,
	ctx?: RepoContext
): Promise<ConnectedChannel> {
	const db = resolveDbForOrg(organizationId, ctx);
	if (db) {
		return pg.pgReconnectChannel(db, organizationId, channelId);
	}
	return mem.reconnectChannel(organizationId, channelId);
}

export async function disconnectChannel(
	organizationId: string,
	channelId: string,
	ctx?: RepoContext
): Promise<ConnectedChannel> {
	const db = resolveDbForOrg(organizationId, ctx);
	if (db) {
		return pg.pgDisconnectChannel(db, organizationId, channelId);
	}
	return mem.disconnectChannel(organizationId, channelId);
}

export async function updateWorkspaceInfo(
	params: {
		organizationId: string;
		name: string;
		industry: string;
		currency: 'MXN' | 'USD';
		language: 'es' | 'en';
	},
	ctx?: RepoContext
): Promise<Organization> {
	const db = resolveDbForOrg(params.organizationId, ctx);
	if (db) {
		return pg.pgUpdateWorkspaceInfo(db, params);
	}
	return mem.updateWorkspaceInfo(params);
}

export async function updateOrganizationChannelSlots(
	organizationId: string,
	channelSlots: number,
	ctx?: RepoContext
): Promise<Organization> {
	const db = resolveDbForOrg(organizationId, ctx);
	if (db) {
		return pg.pgUpdateOrganizationChannelSlots(organizationId, channelSlots);
	}
	return mem.updateOrganizationChannelSlots(organizationId, channelSlots);
}

export async function updateOrganizationZernioProfileId(
	organizationId: string,
	profileId: string,
	ctx?: RepoContext
): Promise<void> {
	const db = resolveDbForOrg(organizationId, ctx);
	if (db) {
		return pg.pgUpdateOrganizationZernioProfileId(organizationId, profileId);
	}
	return mem.updateOrganizationZernioProfileId(organizationId, profileId);
}

export async function findChannelByExternalAccountId(
	externalAccountId: string
): Promise<ConnectedChannel | null> {
	if (!isMockExternalAccountId(externalAccountId) && isSupabaseAdminConfigured()) {
		return pg.pgFindChannelByExternalAccountId(externalAccountId);
	}
	return mem.findChannelByExternalAccountId(externalAccountId);
}

export async function upsertConnectedChannel(
	params: {
		organizationId: string;
		platform: Platform;
		externalAccountId: string;
		displayName: string;
		handleOrPhone: string;
		channelId?: string;
	},
	ctx?: RepoContext
): Promise<
	| { ok: true; channel: ConnectedChannel }
	| { ok: false; code: 'ACCOUNT_IN_OTHER_ORG' | 'CHANNEL_SLOTS_FULL'; error: string }
> {
	const db = resolveDbForOrg(params.organizationId, ctx);
	if (db) {
		return pg.pgUpsertConnectedChannel(params);
	}
	return mem.upsertConnectedChannel(params);
}

export async function tryClaimZernioWebhookEvent(
	eventId: string,
	eventType: string,
	externalAccountId = ''
): Promise<boolean> {
	if (!eventId) return true;
	if (!isMockExternalAccountId(externalAccountId) && isSupabaseAdminConfigured()) {
		return pg.pgTryClaimZernioWebhookEvent(eventId, eventType);
	}
	if (mem.hasProcessedWebhookEvent(eventId)) return false;
	mem.markWebhookEventProcessed(eventId);
	return true;
}

export async function ingestInboundWebhookMessage(params: {
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
	if (!isMockExternalAccountId(params.externalAccountId) && isSupabaseAdminConfigured()) {
		return pg.pgIngestInboundWebhookMessage(params);
	}
	return mem.ingestInboundWebhookMessage(params);
}

export async function ingestExternalEchoMessage(params: {
	externalAccountId: string;
	externalMessageId?: string;
	externalThreadId?: string;
	senderExternalId?: string;
	senderName?: string;
	senderHandle?: string;
	body: string;
}): Promise<boolean> {
	if (!isMockExternalAccountId(params.externalAccountId) && isSupabaseAdminConfigured()) {
		return pg.pgIngestExternalEchoMessage(params);
	}
	return mem.ingestExternalEchoMessage(params);
}

export async function updateMessageDeliveryStatus(params: {
	externalAccountId: string;
	externalMessageId: string;
	status: 'delivered' | 'read' | 'failed';
	errorCode?: string;
	errorDetail?: string;
}): Promise<boolean> {
	if (!isMockExternalAccountId(params.externalAccountId) && isSupabaseAdminConfigured()) {
		return pg.pgUpdateMessageDeliveryStatus(params);
	}
	return mem.updateMessageDeliveryStatus(params);
}

export {
	DEMO_SIM_CONTACT_EMAIL,
	DEMO_SIM_CONTACT_NAME,
	DEMO_SIM_DEAL_TITLE,
	type DemoLeadState
} from '$lib/types/domain';

export async function markChannelDisconnectedByExternalId(params: {
	externalAccountId: string;
	reason?: string;
	disconnectionType?: string;
	gracePeriodEndsAt?: string;
}): Promise<ConnectedChannel | null> {
	if (!isMockExternalAccountId(params.externalAccountId) && isSupabaseAdminConfigured()) {
		return pg.pgMarkChannelDisconnectedByExternalId(params);
	}
	return mem.markChannelDisconnectedByExternalId(params);
}

export async function ensureAndResetDemoLead(
	organizationId: string,
	ownerUserId: string | null,
	ctx?: RepoContext
): Promise<import('$lib/types/domain').DemoLeadState> {
	const db = resolveDbForOrg(organizationId, ctx);
	if (db) {
		return pg.pgEnsureAndResetDemoLead(db, organizationId, ownerUserId);
	}
	return mem.ensureAndResetDemoLead(organizationId, ownerUserId);
}

export async function syncDemoLeadStageFromAi(
	params: {
		organizationId: string;
		ownerUserId: string | null;
		recommendedStageName: string;
		intentSummary: string;
		followUpAction: string;
		needsHumanHandoff: boolean;
	},
	ctx?: RepoContext
): Promise<import('$lib/types/domain').DemoLeadState> {
	const db = resolveDbForOrg(params.organizationId, ctx);
	if (db) {
		return pg.pgSyncDemoLeadStageFromAi(db, params);
	}
	return mem.syncDemoLeadStageFromAi(params);
}
