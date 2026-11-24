import type { PageLoad } from './$types';
import { loadWorkspaceView } from '$lib/client/workspace-cache';

export const load: PageLoad = async ({ params, parent, fetch, depends }) => {
	depends(`app:view:${params.orgSlug}:pipeline`);
	const parentData = await parent();
	if (parentData.accessDenied) return { denied: true as const };

	const pipelineData = await loadWorkspaceView({
		fetch,
		userId: parentData.user.id,
		orgSlug: params.orgSlug,
		view: 'pipeline',
		loadNonce: parentData.loadNonce
	});

	return {
		denied: false as const,
		loadNonce: parentData.loadNonce,
		org: parentData.org,
		effectiveRole: parentData.effectiveRole,
		stages: pipelineData.stages,
		deals: pipelineData.deals,
		contacts: pipelineData.contacts,
		notes: pipelineData.notes,
		timelineEvents: pipelineData.timelineEvents,
		members: pipelineData.members
	};
};
