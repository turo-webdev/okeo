import type Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';
import {
	handleVerifiedStripeEvent,
	reconcileChannelsForSubscription,
	reconcileCheckoutSessionForOrg,
	runBillingLifecycleSweep,
	type BillingChannelRow,
	type BillingLifecycleDeps
} from '../lifecycle';
import {
	extractInvoiceSubscriptionId,
	extractSubscriptionPeriod,
	mapStripeStatus,
	normalizeStripeSubscription
} from '../stripe';

function makeMockSubscription(overrides?: Partial<Stripe.Subscription>): Stripe.Subscription {
	const itemStart = Math.floor(Date.UTC(2026, 10, 1) / 1000);
	const itemEnd = Math.floor(Date.UTC(2026, 11, 1) / 1000);

	return {
		id: 'sub_test_123',
		object: 'subscription',
		customer: 'cus_test_123',
		status: 'active',
		metadata: { organizationId: '11111111-1111-4111-8111-111111111111' },
		items: {
			object: 'list',
			data: [
				{
					id: 'si_channel_123',
					quantity: 3,
					price: { id: 'price_channel_9usd' },
					current_period_start: itemStart,
					current_period_end: itemEnd
				} as unknown as Stripe.SubscriptionItem
			],
			has_more: false,
			url: '/v1/subscription_items'
		},
		...overrides
	} as unknown as Stripe.Subscription;
}

describe('Stripe subscription normalization & helpers', () => {
	it('extracts billing period from SubscriptionItem (Stripe v23+) and legacy root fields', () => {
		const sub = makeMockSubscription();
		const period = extractSubscriptionPeriod(sub);
		expect(period.periodStartIso).toBe(new Date(Date.UTC(2026, 10, 1)).toISOString());
		expect(period.periodEndIso).toBe(new Date(Date.UTC(2026, 11, 1)).toISOString());

		const legacySub = {
			items: { data: [] },
			current_period_start: Math.floor(Date.UTC(2026, 9, 15) / 1000),
			current_period_end: Math.floor(Date.UTC(2026, 10, 15) / 1000)
		} as unknown as Stripe.Subscription;
		const legacyPeriod = extractSubscriptionPeriod(legacySub);
		expect(legacyPeriod.periodStartIso).toBe(new Date(Date.UTC(2026, 9, 15)).toISOString());
		expect(legacyPeriod.periodEndIso).toBe(new Date(Date.UTC(2026, 10, 15)).toISOString());
	});

	it('maps Stripe statuses and extracts parent subscription IDs from invoices', () => {
		expect(mapStripeStatus('active')).toBe('active');
		expect(mapStripeStatus('trialing')).toBe('trialing');
		expect(mapStripeStatus('past_due')).toBe('past_due');
		expect(mapStripeStatus('incomplete')).toBe('past_due');
		expect(mapStripeStatus('paused')).toBe('past_due');
		expect(mapStripeStatus('canceled')).toBe('canceled');
		expect(mapStripeStatus('unpaid')).toBe('expired');
		expect(mapStripeStatus('incomplete_expired')).toBe('expired');

		const v23Invoice = {
			parent: {
				subscription_details: { subscription: 'sub_parent_999' }
			}
		} as unknown as Stripe.Invoice;
		expect(extractInvoiceSubscriptionId(v23Invoice)).toBe('sub_parent_999');

		const legacyInvoice = { subscription: 'sub_legacy_888' } as unknown as Stripe.Invoice;
		expect(extractInvoiceSubscriptionId(legacyInvoice)).toBe('sub_legacy_888');
	});
});

describe('Channel reconciliation, webhook handling & lifecycle Zernio cleanup', () => {
	function createDepsHarness(initialChannels: BillingChannelRow[]) {
		const channels = initialChannels.map((c) => ({ ...c, metadata: { ...c.metadata } }));
		const orgPatches: Array<{ orgId: string; patch: Record<string, unknown> }> = [];
		const usageSyncCalls: Array<{
			organizationId: string;
			periodStart: string;
			periodEnd: string;
			includedAiReplies: number;
		}> = [];
		const disconnectedExternalIds: string[] = [];

		const deps: BillingLifecycleDeps = {
			listOrgChannels: vi.fn(async (orgId) => channels.filter((c) => c.organization_id === orgId)),
			updateChannelState: vi.fn(async (_orgId, chId, status, metadata) => {
				const target = channels.find((c) => c.id === chId);
				if (target) {
					target.status = status;
					target.metadata = { ...metadata };
				}
			}),
			resolveOrgForBilling: vi.fn(async ({ explicitOrgId }) => ({
				id: explicitOrgId ?? '11111111-1111-4111-8111-111111111111',
				included_ai_replies_per_channel: 1000
			})),
			updateOrgSubscription: vi.fn(async (orgId, patch) => {
				orgPatches.push({ orgId, patch });
			}),
			syncUsageQuota: vi.fn(async (params) => {
				usageSyncCalls.push(params);
			}),
			retrieveCheckoutSession: vi.fn(async (sessionId) => ({
				id: sessionId,
				object: 'checkout.session',
				mode: 'subscription',
				status: 'complete',
				payment_status: 'paid',
				subscription: 'sub_reconciled_123',
				client_reference_id: '11111111-1111-4111-8111-111111111111',
				metadata: { organizationId: '11111111-1111-4111-8111-111111111111' }
			}) as unknown as Stripe.Checkout.Session),
			retrieveSubscription: vi.fn(async (subId) =>
				normalizeStripeSubscription(makeMockSubscription({ id: subId }))
			),
			listOverdueTrialOrgIds: vi.fn(async () => []),
			listPausedBillingChannels: vi.fn(async () =>
				channels.filter((c) => c.status === 'paused_billing')
			),
			disconnectZernioAccount: vi.fn(async (externalId) => {
				disconnectedExternalIds.push(externalId);
			})
		};

		return { deps, channels, orgPatches, usageSyncCalls, disconnectedExternalIds };
	}

	it('downgrades 3->1 by pausing newest excess channels and upgrades 1->3 by skipping Zernio-disconnected ones', async () => {
		const orgId = '11111111-1111-4111-8111-111111111111';
		const h = createDepsHarness([
			{
				id: 'ch_1',
				organization_id: orgId,
				external_account_id: 'ext_1',
				status: 'active',
				metadata: {},
				created_at: '2026-11-01T00:00:00Z'
			},
			{
				id: 'ch_2',
				organization_id: orgId,
				external_account_id: 'ext_2',
				status: 'active',
				metadata: {},
				created_at: '2026-11-02T00:00:00Z'
			},
			{
				id: 'ch_3',
				organization_id: orgId,
				external_account_id: 'ext_3',
				status: 'active',
				metadata: {},
				created_at: '2026-11-03T00:00:00Z'
			},
			{
				id: 'ch_4_killed',
				organization_id: orgId,
				external_account_id: 'ext_4',
				status: 'paused_billing',
				metadata: { zernio_disconnected_for_billing: true },
				created_at: '2026-11-04T00:00:00Z'
			}
		]);

		const down = await reconcileChannelsForSubscription(
			{
				organizationId: orgId,
				allowedSlots: 1,
				subscriptionStatus: 'active',
				nowIso: '2026-11-20T00:00:00Z'
			},
			h.deps
		);
		expect(down.pausedChannelIds).toEqual(['ch_2', 'ch_3']);
		expect(h.channels.find((c) => c.id === 'ch_1')?.status).toBe('active');
		expect(h.channels.find((c) => c.id === 'ch_2')?.status).toBe('paused_billing');
		expect(h.channels.find((c) => c.id === 'ch_2')?.metadata.paused_billing_at).toBe(
			'2026-11-20T00:00:00Z'
		);

		const up = await reconcileChannelsForSubscription(
			{
				organizationId: orgId,
				allowedSlots: 3,
				subscriptionStatus: 'active'
			},
			h.deps
		);
		expect(up.reactivatedChannelIds).toEqual(['ch_2', 'ch_3']);
		expect(h.channels.find((c) => c.id === 'ch_2')?.metadata.paused_billing_at).toBeUndefined();
		expect(h.channels.find((c) => c.id === 'ch_4_killed')?.status).toBe('paused_billing');
	});

	it('handles checkout.session.completed, invoice.payment_failed, and customer.subscription.deleted', async () => {
		const orgId = '11111111-1111-4111-8111-111111111111';
		const h = createDepsHarness([
			{
				id: 'ch_1',
				organization_id: orgId,
				external_account_id: 'ext_1',
				status: 'active',
				metadata: {},
				created_at: '2026-11-01T00:00:00Z'
			}
		]);

		const checkoutEvt = {
			id: 'evt_checkout_1',
			type: 'checkout.session.completed',
			data: {
				object: {
					mode: 'subscription',
					subscription: 'sub_live_1',
					client_reference_id: orgId,
					metadata: { organizationId: orgId }
				}
			}
		} as unknown as Stripe.Event;

		const checkoutRes = await handleVerifiedStripeEvent(checkoutEvt, h.deps);
		expect(checkoutRes).toEqual({ handled: true, organizationId: orgId });
		expect(h.orgPatches[0].patch).toMatchObject({
			billing_mode: 'per_channel',
			subscription_status: 'active',
			channel_slots: 3,
			kb_document_limit: 45,
			stripe_subscription_id: 'sub_live_1'
		});
		expect(h.usageSyncCalls[0].includedAiReplies).toBe(3000);

		const failedEvt = {
			id: 'evt_fail_1',
			type: 'invoice.payment_failed',
			data: {
				object: {
					customer: 'cus_test_123',
					parent: { subscription_details: { subscription: 'sub_live_1' } }
				}
			}
		} as unknown as Stripe.Event;

		const failRes = await handleVerifiedStripeEvent(failedEvt, h.deps);
		expect(failRes).toEqual({ handled: true, organizationId: orgId });
		expect(h.orgPatches.at(-1)?.patch).toEqual({ subscription_status: 'past_due' });
		expect(h.channels[0].status).toBe('active');

		const deletedEvt = {
			id: 'evt_del_1',
			type: 'customer.subscription.deleted',
			data: {
				object: makeMockSubscription({ id: 'sub_live_1', status: 'canceled' })
			}
		} as unknown as Stripe.Event;

		const delRes = await handleVerifiedStripeEvent(deletedEvt, h.deps);
		expect(delRes).toEqual({ handled: true, organizationId: orgId });
		expect(h.channels[0].status).toBe('paused_billing');
	});

	it('expires overdue trials and disconnects Zernio accounts only after the 3-day grace period with error resilience', async () => {
		const orgExpiredTrial = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
		const orgGrace = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
		const orgPastGrace = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
		const now = new Date('2026-11-24T12:00:00Z');

		const h = createDepsHarness([
			{
				id: 'ch_trial_overdue',
				organization_id: orgExpiredTrial,
				external_account_id: 'ext_trial_1',
				status: 'active',
				metadata: {},
				created_at: '2026-11-01T00:00:00Z'
			},
			{
				id: 'ch_within_grace',
				organization_id: orgGrace,
				external_account_id: 'ext_within_grace',
				status: 'paused_billing',
				metadata: { paused_billing_at: '2026-11-23T00:00:00Z' },
				created_at: '2026-11-01T00:00:00Z'
			},
			{
				id: 'ch_past_grace_fail',
				organization_id: orgPastGrace,
				external_account_id: 'ext_fail_zernio',
				status: 'paused_billing',
				metadata: { paused_billing_at: '2026-11-20T00:00:00Z' },
				created_at: '2026-11-01T00:00:00Z'
			},
			{
				id: 'ch_past_grace_ok',
				organization_id: orgPastGrace,
				external_account_id: 'ext_zombie_clean',
				status: 'paused_billing',
				metadata: { paused_billing_at: '2026-11-19T00:00:00Z' },
				created_at: '2026-11-01T00:00:00Z'
			}
		]);

		h.deps.listOverdueTrialOrgIds = vi.fn(async () => [orgExpiredTrial]);
		h.deps.disconnectZernioAccount = vi.fn(async (externalId) => {
			if (externalId === 'ext_fail_zernio') {
				throw new Error('Zernio timeout');
			}
			h.disconnectedExternalIds.push(externalId);
		});

		const summary = await runBillingLifecycleSweep({
			gracePeriodDays: 3,
			now,
			deps: h.deps
		});

		expect(summary.expiredTrialsCount).toBe(1);
		expect(summary.pausedChannelsCount).toBe(1);
		expect(summary.disconnectedZernioCount).toBe(1);
		expect(summary.errors).toHaveLength(1);
		expect(summary.errors[0]).toContain('ch_past_grace_fail');

		// Trial channel was paused (not yet past 3-day grace window so not disconnected in Zernio yet)
		expect(h.channels.find((c) => c.id === 'ch_trial_overdue')?.status).toBe('paused_billing');
		// Channel within grace stayed paused_billing
		expect(h.channels.find((c) => c.id === 'ch_within_grace')?.status).toBe('paused_billing');
		// Channel past grace was disconnected from Zernio and flagged
		expect(h.disconnectedExternalIds).toEqual(['ext_zombie_clean']);
		const cleaned = h.channels.find((c) => c.id === 'ch_past_grace_ok');
		expect(cleaned?.status).toBe('disconnected');
		expect(cleaned?.metadata.zernio_disconnected_for_billing).toBe(true);
	});

	it('reconciles a completed Checkout Session synchronously and enforces org & payment guards', async () => {
		const orgId = '11111111-1111-4111-8111-111111111111';
		const h = createDepsHarness([]);

		const okRes = await reconcileCheckoutSessionForOrg(
			{ organizationId: orgId, sessionId: 'cs_test_paid_123' },
			h.deps
		);
		expect(okRes).toEqual({ synced: true, subscriptionId: 'sub_reconciled_123' });
		expect(h.orgPatches).toHaveLength(1);
		expect(h.orgPatches[0].patch).toMatchObject({
			billing_mode: 'per_channel',
			subscription_status: 'active',
			stripe_subscription_id: 'sub_reconciled_123',
			channel_slots: 3
		});
		expect(h.usageSyncCalls).toHaveLength(1);
		expect(h.usageSyncCalls[0].includedAiReplies).toBe(3000);

		const mismatchRes = await reconcileCheckoutSessionForOrg(
			{ organizationId: '22222222-2222-4222-8222-222222222222', sessionId: 'cs_test_paid_123' },
			h.deps
		);
		expect(mismatchRes).toEqual({ synced: false, reason: 'organization_mismatch' });
		expect(h.orgPatches).toHaveLength(1);
		expect(h.usageSyncCalls).toHaveLength(1);

		h.deps.retrieveCheckoutSession = vi.fn(async (sessionId) => ({
			id: sessionId,
			mode: 'subscription',
			status: 'open',
			payment_status: 'unpaid',
			subscription: null,
			client_reference_id: orgId,
			metadata: { organizationId: orgId }
		}) as unknown as Stripe.Checkout.Session);

		const incompleteRes = await reconcileCheckoutSessionForOrg(
			{ organizationId: orgId, sessionId: 'cs_test_open_456' },
			h.deps
		);
		expect(incompleteRes).toEqual({ synced: false, reason: 'checkout_not_complete' });
		expect(h.orgPatches).toHaveLength(1);
		expect(h.usageSyncCalls).toHaveLength(1);
	});
});
