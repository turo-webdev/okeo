import { describe, expect, it } from 'vitest';
import { createSignedStorageUrl, isPathOwnedByOrganization } from '$lib/server/storage';

describe('Supabase Storage multi-tenant path ownership', () => {
	const orgA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
	const orgB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

	it('allows paths prefixed by the authorized organization id', () => {
		expect(isPathOwnedByOrganization(`${orgA}/msg_1/audio.ogg`, orgA)).toBe(true);
		expect(isPathOwnedByOrganization(`${orgA}/kb_1/guia.pdf`, orgA)).toBe(true);
	});

	it('rejects cross-tenant paths, traversal segments, backslashes, and empty ids', () => {
		expect(isPathOwnedByOrganization(`${orgB}/msg_1/audio.ogg`, orgA)).toBe(false);
		expect(isPathOwnedByOrganization(`${orgA}/../${orgB}/secret.pdf`, orgA)).toBe(false);
		expect(isPathOwnedByOrganization(`${orgA}\\msg_1\\audio.ogg`, orgA)).toBe(false);
		expect(isPathOwnedByOrganization(`${orgA}/msg_1/audio.ogg`, '')).toBe(false);
	});

	it('returns null from createSignedStorageUrl when path does not belong to organization', async () => {
		const res = await createSignedStorageUrl({
			organizationId: orgA,
			storagePath: `${orgB}/kb_1/privado.pdf`,
			bucket: 'knowledge-files'
		});
		expect(res).toBeNull();
	});
});

describe('repository security helpers', () => {
	it('validates canonical UUID format only', async () => {
		const { isUuid } = await import('$lib/server/crm/repository');
		expect(isUuid('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
		expect(isUuid('org_wunderside')).toBe(false);
		expect(isUuid('not-a-uuid')).toBe(false);
	});

	it('hashes invitation tokens with deterministic 64-hex SHA-256 digest', async () => {
		const { hashTokenSha256 } = await import('$lib/server/crm/repository');
		const first = await hashTokenSha256('sample-token-123');
		const second = await hashTokenSha256('sample-token-123');
		const other = await hashTokenSha256('different-token');
		expect(first).toBe(second);
		expect(first).not.toBe(other);
		expect(first).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe('focused route loaders, workspace access and requestCache deduplication', () => {
	function makeDemoLocals(userId = 'usr_arturo'): App.Locals {
		return {
			supabase: null,
			authMode: 'demo',
			sessionUser: null,
			demoRole: 'owner',
			requestCache: new Map(),
			safeGetAuth: async () => ({
				userId,
				email: 'arturo@wunderside.mx',
				authMode: 'demo' as const
			}),
			safeGetSession: async () => ({ user: null })
		};
	}

	it('returns scoped data from each focused loader and rejects nonexistent or cross-tenant contacts', async () => {
		const {
			getAiPageData,
			getContactDetailPageData,
			getContactsPageData,
			getInboxPageData,
			getLayoutWorkspaceData,
			getOrganizationBySlug,
			getPipelinePageData,
			getSettingsPageData
		} = await import('$lib/server/crm/repository');

		const org = await getOrganizationBySlug('wunderside');
		expect(org).toBeTruthy();

		const layoutData = await getLayoutWorkspaceData(org!);
		expect(layoutData.members.length).toBeGreaterThan(0);
		expect(layoutData.channels.length).toBeGreaterThan(0);
		expect(typeof layoutData.unreadBadge).toBe('number');

		const inboxData = await getInboxPageData(org!.id);
		expect(inboxData?.conversations.length).toBeGreaterThan(0);
		expect(inboxData?.messages.length).toBeGreaterThan(0);
		expect(inboxData?.stages.length).toBeGreaterThan(0);

		const pipelineData = await getPipelinePageData(org!.id);
		expect(pipelineData?.stages.length).toBeGreaterThan(0);
		expect(pipelineData?.deals.length).toBeGreaterThan(0);
		expect(pipelineData?.contacts.length).toBeGreaterThan(0);

		const contactsData = await getContactsPageData(org!.id);
		expect(contactsData?.contacts.length).toBeGreaterThan(0);

		const firstContact = contactsData!.contacts[0];
		const detail = await getContactDetailPageData(org!.id, firstContact.id);
		expect(detail?.contact.id).toBe(firstContact.id);

		const missing = await getContactDetailPageData(org!.id, 'cnt_inexistente');
		expect(missing).toBeNull();

		const crossTenant = await getContactDetailPageData('org_estudio_norte', firstContact.id);
		expect(crossTenant).toBeNull();

		const aiData = await getAiPageData(org!.id);
		expect(aiData?.aiSettings?.organization_id).toBe(org!.id);
		expect(aiData?.stages.every((s) => !s.is_terminal)).toBe(true);

		const settingsData = await getSettingsPageData(org!);
		expect(settingsData.members.length).toBe(layoutData.members.length);
		expect(settingsData.channels.length).toBe(layoutData.channels.length);
	});

	it('authorizes member workspace and denies unauthorized slug via resolveWorkspaceAccess', async () => {
		const { resolveWorkspaceAccess } = await import('$lib/server/crm/repository');

		const locals = makeDemoLocals();
		const allowed = await resolveWorkspaceAccess('wunderside', locals);
		expect(allowed.authorized).toBe(true);
		if (allowed.authorized) {
			expect(allowed.org.slug).toBe('wunderside');
			expect(allowed.effectiveRole).toBe('owner');
		}

		const denied = await resolveWorkspaceAccess('estudio-norte', locals);
		expect(denied.authorized).toBe(false);
	});

	it('deduplicates repeated calls within the same requestCache while isolating separate requests', async () => {
		const { listUserOrganizations, resolveWorkspaceAccess } = await import(
			'$lib/server/crm/repository'
		);

		const req1 = makeDemoLocals();
		const firstPromise = listUserOrganizations('usr_arturo', req1);
		const secondPromise = listUserOrganizations('usr_arturo', req1);
		expect(req1.requestCache.has('userOrgs:usr_arturo')).toBe(true);
		const [orgsA, orgsB] = await Promise.all([firstPromise, secondPromise]);
		expect(orgsA).toBe(orgsB);

		const access1 = resolveWorkspaceAccess('wunderside', req1);
		const access2 = resolveWorkspaceAccess('wunderside', req1);
		const [res1, res2] = await Promise.all([access1, access2]);
		expect(req1.requestCache.has('access:wunderside:usr_arturo')).toBe(true);
		expect(res1).toBe(res2);

		// Separate request starts with an empty requestCache
		const req2 = makeDemoLocals();
		expect(req2.requestCache.size).toBe(0);
		const orgsC = await listUserOrganizations('usr_arturo', req2);
		expect(orgsC).not.toBe(orgsA);
		expect(orgsC).toEqual(orgsA);
	});

	it('accepts optional knownOrg in getWorkspaceSnapshot with identical output', async () => {
		const { getOrganizationBySlug, getWorkspaceSnapshot } = await import(
			'$lib/server/crm/repository'
		);

		const org = await getOrganizationBySlug('wunderside');
		expect(org).toBeTruthy();

		const snapA = await getWorkspaceSnapshot(org!.id);
		const snapB = await getWorkspaceSnapshot(org!.id, undefined, org!);
		expect(snapA).toEqual(snapB);
	});

	it('loads single-record helpers, AI draft context, and paginated conversation messages with tenant isolation', async () => {
		const {
			getAiDraftContext,
			getChannelById,
			getContactById,
			getConversationAndChannel,
			getConversationMessagesPage,
			getInboxPageData,
			getOrganizationBySlug
		} = await import('$lib/server/crm/repository');

		const org = await getOrganizationBySlug('wunderside');
		expect(org).toBeTruthy();

		const inbox = await getInboxPageData(org!.id);
		const firstConv = inbox!.conversations[0];
		const firstContact = inbox!.contacts[0];
		const firstChannel = inbox!.channels[0];

		const convAndChannel = await getConversationAndChannel(org!.id, firstConv.id);
		expect(convAndChannel.conv?.id).toBe(firstConv.id);
		expect(convAndChannel.channel?.id).toBe(firstConv.channel_id);
		expect(await getConversationAndChannel('org_other', firstConv.id)).toEqual({
			conv: null,
			channel: null
		});

		expect((await getContactById(org!.id, firstContact.id))?.id).toBe(firstContact.id);
		expect(await getContactById('org_other', firstContact.id)).toBeNull();

		expect((await getChannelById(org!.id, firstChannel.id))?.id).toBe(firstChannel.id);
		expect(await getChannelById('org_other', firstChannel.id)).toBeNull();

		const draftCtx = await getAiDraftContext(org!, firstConv.id);
		expect(draftCtx.conv?.id).toBe(firstConv.id);
		expect(draftCtx.aiSettings?.organization_id).toBe(org!.id);
		expect(draftCtx.openStages.every((s) => !s.is_terminal)).toBe(true);

		const allConvMsgs = inbox!.messages
			.filter((m) => m.conversation_id === firstConv.id)
			.sort((a, b) => a.id - b.id);
		expect(allConvMsgs.length).toBeGreaterThanOrEqual(2);

		const page1 = await getConversationMessagesPage(org!.id, firstConv.id, { limit: 1 });
		expect(page1.messages.length).toBe(1);
		expect(page1.messages[0].id).toBe(allConvMsgs[allConvMsgs.length - 1].id);
		expect(page1.hasMore).toBe(true);
		expect(page1.nextBeforeId).toBe(page1.messages[0].id);

		const page2 = await getConversationMessagesPage(org!.id, firstConv.id, {
			beforeId: page1.nextBeforeId ?? undefined,
			limit: 10
		});
		expect(page2.messages.every((m) => m.id < page1.messages[0].id)).toBe(true);
		for (let i = 1; i < page2.messages.length; i++) {
			expect(page2.messages[i].id).toBeGreaterThan(page2.messages[i - 1].id);
		}

		const crossTenantPage = await getConversationMessagesPage('org_other', firstConv.id, {
			limit: 10
		});
		expect(crossTenantPage).toEqual({ messages: [], hasMore: false, nextBeforeId: null });
	});

	it('enforces anti-SSRF on external attachment mirroring and computes chunking/cost metrics', async () => {
		const { mirrorExternalMediaToPrivateStorage } = await import('$lib/server/storage');
		const { chunkKnowledgeText } = await import('$lib/server/ai/rag');
		const { estimateGeminiCostMicros } = await import('$lib/server/ai/usage');

		const ssrfBlocked = await mirrorExternalMediaToPrivateStorage({
			organizationId: '11111111-1111-4111-8111-111111111111',
			conversationId: '22222222-2222-4222-8222-222222222222',
			messageId: 1,
			sourceUrl: 'http://169.254.169.254/latest/meta-data/',
			kind: 'image'
		});
		expect(ssrfBlocked).toBeNull();

		const loopbackBlocked = await mirrorExternalMediaToPrivateStorage({
			organizationId: '11111111-1111-4111-8111-111111111111',
			conversationId: '22222222-2222-4222-8222-222222222222',
			messageId: 1,
			sourceUrl: 'http://127.0.0.1:8080/internal.png',
			kind: 'image'
		});
		expect(loopbackBlocked).toBeNull();

		expect(chunkKnowledgeText('Texto corto.')).toEqual(['Texto corto.']);
		const longText = 'Párrafo informativo sobre horarios y membresías familiares. '.repeat(40);
		const chunks = chunkKnowledgeText(longText, 500, 80);
		expect(chunks.length).toBeGreaterThan(2);
		expect(chunks.every((c) => c.length <= 500)).toBe(true);

		expect(estimateGeminiCostMicros('gemini-2.5-flash', 3000, 300, false)).toBe(1650);
		expect(estimateGeminiCostMicros('gemini-2.5-flash', 1000, 200, true)).toBe(1500);
		expect(estimateGeminiCostMicros('gemini-embedding-001', 1000, 0)).toBe(150);
	});
});
