import type { PageLoad } from './$types';
import { loadWorkspaceView } from '$lib/client/workspace-cache';

export const load: PageLoad = async ({ params, parent, fetch, depends }) => {
	depends(`app:view:${params.orgSlug}:contacts`);
	const parentData = await parent();
	if (parentData.accessDenied) return { denied: true as const };

	const contactsData = await loadWorkspaceView({
		fetch,
		userId: parentData.user.id,
		orgSlug: params.orgSlug,
		view: 'contacts',
		loadNonce: parentData.loadNonce
	});

	return {
		denied: false as const,
		org: parentData.org,
		effectiveRole: parentData.effectiveRole,
		contacts: contactsData.contacts,
		identities: contactsData.identities,
		members: contactsData.members
	};
};
