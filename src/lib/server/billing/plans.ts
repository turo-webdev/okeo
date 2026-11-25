import {
	CHANNEL_PRICE_USD,
	INCLUDED_AI_REPLIES_PER_CHANNEL,
	KB_DOCUMENTS_PER_CHANNEL,
	TRIAL_DAYS,
	TRIAL_INCLUDED_AI_REPLIES,
	TRIAL_KB_DOCUMENT_LIMIT,
	UNLIMITED_USERS
} from '$lib/constants/plans';
import type { Organization, OrgUsagePeriod } from '$lib/types/domain';

export {
	CHANNEL_PRICE_USD,
	INCLUDED_AI_REPLIES_PER_CHANNEL,
	KB_DOCUMENTS_PER_CHANNEL,
	TRIAL_DAYS,
	TRIAL_INCLUDED_AI_REPLIES,
	TRIAL_KB_DOCUMENT_LIMIT,
	UNLIMITED_USERS
};

export function isOrganizationTrialExpired(org: Pick<Organization, 'billing_mode' | 'trial_ends_at'>): boolean {
	if (org.billing_mode !== 'trial' || !org.trial_ends_at) return false;
	const ts = Date.parse(org.trial_ends_at);
	return Number.isFinite(ts) && ts < Date.now();
}

export function isOrganizationSubscriptionBlocked(
	org: Pick<Organization, 'subscription_status' | 'billing_mode' | 'trial_ends_at'>
): boolean {
	if (
		org.subscription_status === 'past_due' ||
		org.subscription_status === 'canceled' ||
		org.subscription_status === 'expired'
	) {
		return true;
	}
	return isOrganizationTrialExpired(org);
}

export function canOrganizationConnectRealChannels(
	org: Pick<Organization, 'billing_mode' | 'subscription_status' | 'trial_ends_at'>
): boolean {
	if (isOrganizationSubscriptionBlocked(org)) return false;
	return org.billing_mode === 'per_channel' && org.subscription_status === 'active';
}

export function calculateIncludedAiReplies(org: Organization): number {
	if (org.billing_mode === 'trial') {
		return TRIAL_INCLUDED_AI_REPLIES;
	}
	return org.channel_slots * org.included_ai_replies_per_channel;
}

export function calculateMonthlyTotalUsd(channelSlots: number): number {
	return Math.max(1, channelSlots) * CHANNEL_PRICE_USD;
}

export function getUsageSummary(org: Organization, period: OrgUsagePeriod, activeChannelsCount: number) {
	const included = period.included_ai_replies || calculateIncludedAiReplies(org);
	const used = period.used_ai_replies;
	const remaining = Math.max(0, included - used);
	const percent = included > 0 ? Math.min(100, Math.round((used / included) * 100)) : 0;

	return {
		channelPriceUsd: CHANNEL_PRICE_USD,
		monthlyTotalUsd: org.billing_mode === 'trial' ? 0 : calculateMonthlyTotalUsd(org.channel_slots),
		activeChannelsCount,
		channelSlots: org.channel_slots,
		includedAiReplies: included,
		usedAiReplies: used,
		remainingAiReplies: remaining,
		usagePercent: percent,
		unlimitedUsers: UNLIMITED_USERS
	};
}
