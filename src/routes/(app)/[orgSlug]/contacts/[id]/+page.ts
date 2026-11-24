import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { loadContactDetailView } from '$lib/client/workspace-cache';

export const load: PageLoad = async ({ params, parent, fetch, depends }) => {
	depends(`app:view:${params.orgSlug}:contact:${params.id}`);
	const parentData = await parent();
	if (parentData.accessDenied) return { denied: true as const };

	const detail = await loadContactDetailView({
		fetch,
		userId: parentData.user.id,
		orgSlug: params.orgSlug,
		contactId: params.id,
		loadNonce: parentData.loadNonce
	});
	if (!detail) throw error(404, 'Contacto no encontrado');

	return {
		denied: false as const,
		org: parentData.org,
		effectiveRole: parentData.effectiveRole,
		contact: detail.contact,
		identities: detail.identities,
		deals: detail.deals,
		stages: detail.stages,
		notes: detail.notes,
		conversation: detail.conversation,
		timelineEvents: detail.timelineEvents,
		members: detail.members
	};
};
