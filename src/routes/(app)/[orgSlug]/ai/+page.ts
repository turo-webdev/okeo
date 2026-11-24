import type { PageLoad } from './$types';
import { loadWorkspaceView } from '$lib/client/workspace-cache';

export const load: PageLoad = async ({ url, params, parent, fetch, depends }) => {
	depends(`app:view:${params.orgSlug}:ai`);
	const parentData = await parent();
	if (parentData.accessDenied) return { denied: true as const };

	const aiData = await loadWorkspaceView({
		fetch,
		userId: parentData.user.id,
		orgSlug: params.orgSlug,
		view: 'ai',
		loadNonce: parentData.loadNonce
	});

	return {
		denied: false as const,
		org: parentData.org,
		effectiveRole: parentData.effectiveRole,
		initialPanel: url.searchParams.get('panel') ?? '',
		geminiConfigured: aiData.geminiConfigured,
		geminiModel: aiData.geminiModel,
		initialDemoLead: aiData.initialDemoLead,
		aiSettings: aiData.aiSettings,
		knowledgeDocuments: aiData.knowledgeDocuments,
		stages: aiData.stages
	};
};
