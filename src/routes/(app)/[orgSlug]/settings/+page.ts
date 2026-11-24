import type { PageLoad } from './$types';
import { loadWorkspaceView } from '$lib/client/workspace-cache';

export const load: PageLoad = async ({ url, params, parent, fetch, depends }) => {
	depends(`app:view:${params.orgSlug}:settings`);
	const parentData = await parent();
	if (parentData.accessDenied) return { denied: true as const };

	const billingFeedback = url.searchParams.get('billing') ?? '';

	const settingsData = await loadWorkspaceView({
		fetch,
		userId: parentData.user.id,
		orgSlug: params.orgSlug,
		view: 'settings',
		loadNonce: parentData.loadNonce,
		forceFresh: url.searchParams.has('connected') || billingFeedback === 'success'
	});

	return {
		denied: false as const,
		org: parentData.org,
		effectiveRole: parentData.effectiveRole,
		organizations: settingsData.organizations,
		initialPanel: url.searchParams.get('panel') ?? '',
		zernioConfigured: settingsData.zernioConfigured,
		stripeConfigured: settingsData.stripeConfigured,
		emailConfigured: settingsData.emailConfigured,
		billingFeedback,
		connectedPlatform: url.searchParams.get('connected') ?? '',
		channelError: url.searchParams.get('error') ?? '',
		channels: settingsData.channels,
		members: settingsData.members,
		invitations: settingsData.invitations,
		roleChangeRequests: settingsData.roleChangeRequests,
		usageSummary: settingsData.usageSummary
	};
};
