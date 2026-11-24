import type { PageLoad } from './$types';
import { loadWorkspaceView } from '$lib/client/workspace-cache';

export const load: PageLoad = async ({ url, params, parent, fetch, depends }) => {
	depends(`app:view:${params.orgSlug}:inbox`);
	const parentData = await parent();
	if (parentData.accessDenied) {
		return { denied: true as const };
	}

	const inboxData = await loadWorkspaceView({
		fetch,
		userId: parentData.user.id,
		orgSlug: params.orgSlug,
		view: 'inbox',
		loadNonce: parentData.loadNonce
	});

	const requestedChatId = url.searchParams.get('chat');
	const activeConv =
		inboxData.conversations.find((c) => c.id === requestedChatId) ??
		inboxData.conversations[0] ??
		null;

	return {
		denied: false as const,
		loadNonce: parentData.loadNonce,
		org: parentData.org,
		effectiveRole: parentData.effectiveRole,
		conversations: inboxData.conversations,
		activeConversationId: activeConv?.id ?? null,
		contacts: inboxData.contacts,
		identities: inboxData.identities,
		messages: inboxData.messages,
		notes: inboxData.notes,
		deals: inboxData.deals,
		stages: inboxData.stages,
		timelineEvents: inboxData.timelineEvents,
		channels: inboxData.channels,
		members: inboxData.members,
		hasExplicitChatParam: Boolean(requestedChatId)
	};
};
