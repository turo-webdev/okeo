import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { reconcileCheckoutSessionForOrg } from '$lib/server/billing/lifecycle';
import { isOrganizationSubscriptionBlocked } from '$lib/server/billing/plans';
import { isStripeConfigured } from '$lib/server/billing/stripe';
import { getLayoutWorkspaceData, listUserOrganizations } from '$lib/server/crm/repository';
import { hasMinRole } from '$lib/types/domain';

export const load: LayoutServerLoad = async ({ params, locals, url }) => {
	const auth = await locals.safeGetAuth();
	let [{ user }, organizations] = await Promise.all([
		locals.safeGetSession(),
		listUserOrganizations(auth.userId, locals)
	]);
	if (!user) {
		const nextPath = `${url.pathname}${url.search}`;
		throw redirect(302, `/login?next=${encodeURIComponent(nextPath)}`);
	}

	let matched = organizations.find((o) => o.slug === params.orgSlug);
	if (!matched) {
		return {
			accessDenied: true as const,
			deniedOrgName: params.orgSlug,
			user,
			organizations
		};
	}

	let effectiveRole = locals.authMode === 'supabase' ? matched.role : (locals.demoRole ?? matched.role);
	const sessionId = url.searchParams.get('session_id')?.trim() ?? '';
	if (
		url.searchParams.get('billing') === 'success' &&
		sessionId.startsWith('cs_') &&
		hasMinRole(effectiveRole, 'admin') &&
		isStripeConfigured() &&
		!matched.stripe_subscription_id
	) {
		try {
			const res = await reconcileCheckoutSessionForOrg({
				organizationId: matched.id,
				sessionId
			});
			if (res.synced) {
				locals.requestCache.clear();
				organizations = await listUserOrganizations(auth.userId, locals);
				matched = organizations.find((o) => o.slug === params.orgSlug) ?? matched;
				effectiveRole = locals.authMode === 'supabase' ? matched.role : (locals.demoRole ?? matched.role);
			}
		} catch {
			// Nunca bloquear carga de pantalla si Stripe devuelve error transitorio; el webhook sincronizará en paralelo.
		}
	}

	const { role: _matchedRole, ...org } = matched;
	const layoutData = await getLayoutWorkspaceData(org, locals);

	const unreadBadge = layoutData.unreadBadge;
	const disconnectedChannel =
		layoutData.channels.find((c) => c.status === 'disconnected') ?? null;
	const quotaExhausted = Boolean(
		layoutData.usageSummary &&
			!org.ai_overage_enabled &&
			layoutData.usageSummary.usedAiReplies >= layoutData.usageSummary.includedAiReplies
	);
	const billingInactive = isOrganizationSubscriptionBlocked(org);

	return {
		accessDenied: false as const,
		loadNonce: crypto.randomUUID(),
		user,
		organizations,
		org,
		effectiveRole,
		unreadBadge,
		disconnectedChannel,
		quotaExhausted,
		billingInactive,
		members: layoutData.members,
		channels: layoutData.channels,
		usageSummary: layoutData.usageSummary
	};
};
