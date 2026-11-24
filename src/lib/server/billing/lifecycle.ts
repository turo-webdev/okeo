import type Stripe from 'stripe';
import { syncUsagePeriodQuota } from '$lib/server/ai/usage';
import { getChannelProvider } from '$lib/server/channels/zernio';
import { getSupabaseAdminClient } from '$lib/server/supabase-admin';
import type { Json } from '$lib/types/database.types';
import type { ConnectedChannel, SubscriptionStatus } from '$lib/types/domain';
import {
	INCLUDED_AI_REPLIES_PER_CHANNEL,
	KB_DOCUMENTS_PER_CHANNEL
} from './plans';
import {
	extractInvoiceSubscriptionId,
	normalizeStripeSubscription,
	retrieveCheckoutSession,
	retrieveNormalizedStripeSubscription,
	type NormalizedStripeSubscription
} from './stripe';

export interface BillingChannelRow {
	id: string;
	organization_id: string;
	external_account_id: string;
	status: ConnectedChannel['status'];
	metadata: Record<string, unknown>;
	created_at: string;
	org_subscription_status?: SubscriptionStatus;
}

export interface BillingLifecycleDeps {
	listOrgChannels: (organizationId: string) => Promise<BillingChannelRow[]>;
	updateChannelState: (
		organizationId: string,
		channelId: string,
		status: ConnectedChannel['status'],
		metadata: Record<string, unknown>
	) => Promise<void>;
	resolveOrgForBilling: (params: {
		explicitOrgId?: string | null;
		subscriptionId?: string | null;
		customerId?: string | null;
	}) => Promise<{ id: string; included_ai_replies_per_channel: number } | null>;
	updateOrgSubscription: (
		organizationId: string,
		patch: {
			billing_mode?: 'trial' | 'per_channel';
			subscription_status: SubscriptionStatus;
			stripe_customer_id?: string | null;
			stripe_subscription_id?: string | null;
			stripe_channel_item_id?: string | null;
			channel_slots?: number;
			kb_document_limit?: number;
			current_period_start?: string;
			current_period_end?: string;
		}
	) => Promise<void>;
	syncUsageQuota: typeof syncUsagePeriodQuota;
	retrieveCheckoutSession: (sessionId: string) => Promise<Stripe.Checkout.Session>;
	retrieveSubscription: (subscriptionId: string) => Promise<NormalizedStripeSubscription>;
	listOverdueTrialOrgIds: (nowIso: string) => Promise<string[]>;
	listPausedBillingChannels: () => Promise<BillingChannelRow[]>;
	disconnectZernioAccount: (externalAccountId: string) => Promise<void>;
}

function asMetaRecord(raw: unknown): Record<string, unknown> {
	if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
		return raw as Record<string, unknown>;
	}
	return {};
}

function createDefaultLifecycleDeps(): BillingLifecycleDeps {
	return {
		async listOrgChannels(organizationId) {
			const admin = getSupabaseAdminClient();
			if (!admin) return [];
			const { data, error } = await admin
				.from('connected_channels')
				.select('id, organization_id, external_account_id, status, metadata, created_at')
				.eq('organization_id', organizationId)
				.order('created_at', { ascending: true });
			if (error || !data) return [];
			return data.map((row) => ({
				id: row.id,
				organization_id: row.organization_id,
				external_account_id: row.external_account_id,
				status: row.status as ConnectedChannel['status'],
				metadata: asMetaRecord(row.metadata),
				created_at: row.created_at
			}));
		},

		async updateChannelState(organizationId, channelId, status, metadata) {
			const admin = getSupabaseAdminClient();
			if (!admin) return;
			const { error } = await admin
				.from('connected_channels')
				.update({ status, metadata: metadata as Json })
				.eq('id', channelId)
				.eq('organization_id', organizationId);
			if (error) {
				throw new Error(`No se pudo actualizar estado de canal ${channelId}: ${error.message}`);
			}
		},

		async resolveOrgForBilling({ explicitOrgId, subscriptionId, customerId }) {
			const admin = getSupabaseAdminClient();
			if (!admin) return null;

			if (explicitOrgId) {
				const { data } = await admin
					.from('organizations')
					.select('id, included_ai_replies_per_channel')
					.eq('id', explicitOrgId)
					.maybeSingle();
				if (data) return data;
			}

			if (subscriptionId) {
				const { data } = await admin
					.from('organizations')
					.select('id, included_ai_replies_per_channel')
					.eq('stripe_subscription_id', subscriptionId)
					.maybeSingle();
				if (data) return data;
			}

			if (customerId) {
				const { data } = await admin
					.from('organizations')
					.select('id, included_ai_replies_per_channel')
					.eq('stripe_customer_id', customerId)
					.maybeSingle();
				if (data) return data;
			}

			return null;
		},

		async updateOrgSubscription(organizationId, patch) {
			const admin = getSupabaseAdminClient();
			if (!admin) return;
			const { error } = await admin
				.from('organizations')
				.update(patch)
				.eq('id', organizationId);
			if (error) {
				throw new Error(`No se pudo sincronizar suscripción en org ${organizationId}: ${error.message}`);
			}
		},

		syncUsageQuota: syncUsagePeriodQuota,
		retrieveCheckoutSession,
		retrieveSubscription: retrieveNormalizedStripeSubscription,

		async listOverdueTrialOrgIds(nowIso) {
			const admin = getSupabaseAdminClient();
			if (!admin) return [];
			const { data, error } = await admin
				.from('organizations')
				.select('id')
				.eq('billing_mode', 'trial')
				.eq('subscription_status', 'trialing')
				.lt('trial_ends_at', nowIso)
				.limit(100);
			if (error || !data) return [];
			return data.map((r) => r.id);
		},

		async listPausedBillingChannels() {
			const admin = getSupabaseAdminClient();
			if (!admin) return [];
			const { data, error } = await admin
				.from('connected_channels')
				.select(
					'id, organization_id, external_account_id, status, metadata, created_at, organizations!inner(subscription_status)'
				)
				.eq('status', 'paused_billing')
				.limit(200);
			if (error || !data) return [];

			return data.map((row) => {
				const orgJoin = Array.isArray(row.organizations)
					? row.organizations[0]
					: row.organizations;
				return {
					id: row.id,
					organization_id: row.organization_id,
					external_account_id: row.external_account_id,
					status: row.status as ConnectedChannel['status'],
					metadata: asMetaRecord(row.metadata),
					created_at: row.created_at,
					org_subscription_status: orgJoin?.subscription_status as SubscriptionStatus | undefined
				};
			});
		},

		async disconnectZernioAccount(externalAccountId) {
			await getChannelProvider().disconnectAccount(externalAccountId);
		}
	};
}

/**
 * Reconcilia canales conectados con `channel_slots` y estado de suscripción:
 * - Canceled/Expired -> pausa todos los canales activos (`paused_billing`).
 * - Downgrade -> pausa canales activos excedentes (conserva los más antiguos).
 * - Upgrade/Reactivación -> reactiva canales en `paused_billing` no desconectados en Zernio.
 */
export async function reconcileChannelsForSubscription(
	params: {
		organizationId: string;
		allowedSlots: number;
		subscriptionStatus: SubscriptionStatus;
		nowIso?: string;
	},
	overrides?: Partial<BillingLifecycleDeps>
): Promise<{ pausedChannelIds: string[]; reactivatedChannelIds: string[] }> {
	const deps: BillingLifecycleDeps = { ...createDefaultLifecycleDeps(), ...overrides };
	const nowIso = params.nowIso ?? new Date().toISOString();
	const channels = await deps.listOrgChannels(params.organizationId);

	const pausedChannelIds: string[] = [];
	const reactivatedChannelIds: string[] = [];

	const activeChannels = channels.filter((c) => c.status === 'active');

	if (params.subscriptionStatus === 'canceled' || params.subscriptionStatus === 'expired') {
		for (const ch of activeChannels) {
			const pausedAt =
				typeof ch.metadata.paused_billing_at === 'string' && ch.metadata.paused_billing_at
					? ch.metadata.paused_billing_at
					: nowIso;
			await deps.updateChannelState(params.organizationId, ch.id, 'paused_billing', {
				...ch.metadata,
				paused_billing_at: pausedAt
			});
			pausedChannelIds.push(ch.id);
		}
		return { pausedChannelIds, reactivatedChannelIds };
	}

	if (params.subscriptionStatus === 'active' || params.subscriptionStatus === 'trialing') {
		const targetSlots = Math.max(0, Math.round(params.allowedSlots));
		if (activeChannels.length > targetSlots) {
			const excess = activeChannels.slice(targetSlots);
			for (const ch of excess) {
				await deps.updateChannelState(params.organizationId, ch.id, 'paused_billing', {
					...ch.metadata,
					paused_billing_at: nowIso
				});
				pausedChannelIds.push(ch.id);
			}
			return { pausedChannelIds, reactivatedChannelIds };
		}

		const freeSlots = targetSlots - activeChannels.length;
		if (freeSlots > 0) {
			const eligiblePaused = channels.filter(
				(c) =>
					c.status === 'paused_billing' && c.metadata.zernio_disconnected_for_billing !== true
			);
			for (const ch of eligiblePaused.slice(0, freeSlots)) {
				const nextMeta = { ...ch.metadata };
				delete nextMeta.paused_billing_at;
				await deps.updateChannelState(params.organizationId, ch.id, 'active', nextMeta);
				reactivatedChannelIds.push(ch.id);
			}
		}
	}

	return { pausedChannelIds, reactivatedChannelIds };
}

export async function syncStripeSubscriptionToOrg(
	sub: NormalizedStripeSubscription,
	explicitOrgId?: string | null,
	overrides?: Partial<BillingLifecycleDeps>
): Promise<{
	organizationId: string;
	subscriptionStatus: SubscriptionStatus;
	channelSlots: number;
	pausedChannelIds: string[];
	reactivatedChannelIds: string[];
} | null> {
	const deps: BillingLifecycleDeps = { ...createDefaultLifecycleDeps(), ...overrides };
	const org = await deps.resolveOrgForBilling({
		explicitOrgId: explicitOrgId ?? sub.organizationIdFromMetadata,
		subscriptionId: sub.subscriptionId,
		customerId: sub.customerId
	});
	if (!org) return null;

	const channelSlots = Math.max(1, sub.channelSlots);
	const kbDocumentLimit = channelSlots * KB_DOCUMENTS_PER_CHANNEL;
	const includedPerChannel =
		org.included_ai_replies_per_channel > 0
			? org.included_ai_replies_per_channel
			: INCLUDED_AI_REPLIES_PER_CHANNEL;

	await deps.updateOrgSubscription(org.id, {
		billing_mode: 'per_channel',
		subscription_status: sub.status,
		stripe_customer_id: sub.customerId,
		stripe_subscription_id: sub.subscriptionId,
		stripe_channel_item_id: sub.channelItemId,
		channel_slots: channelSlots,
		kb_document_limit: kbDocumentLimit,
		current_period_start: sub.periodStartIso,
		current_period_end: sub.periodEndIso
	});

	await deps.syncUsageQuota({
		organizationId: org.id,
		periodStart: sub.periodStartIso,
		periodEnd: sub.periodEndIso,
		includedAiReplies: channelSlots * includedPerChannel
	});

	const reconciled = await reconcileChannelsForSubscription(
		{
			organizationId: org.id,
			allowedSlots: channelSlots,
			subscriptionStatus: sub.status
		},
		deps
	);

	return {
		organizationId: org.id,
		subscriptionStatus: sub.status,
		channelSlots,
		pausedChannelIds: reconciled.pausedChannelIds,
		reactivatedChannelIds: reconciled.reactivatedChannelIds
	};
}

/**
 * Reconcilia de forma síncrona una Checkout Session completada al volver a Ajustes -> Plan,
 * verificando pertenencia al workspace y evitando depender únicamente del timing del webhook.
 */
export async function reconcileCheckoutSessionForOrg(
	params: {
		organizationId: string;
		sessionId: string;
	},
	overrides?: Partial<BillingLifecycleDeps>
): Promise<{ synced: boolean; subscriptionId?: string; reason?: string }> {
	const cleanId = params.sessionId.trim();
	if (!cleanId.startsWith('cs_')) {
		return { synced: false, reason: 'invalid_session_id' };
	}

	const deps: BillingLifecycleDeps = { ...createDefaultLifecycleDeps(), ...overrides };
	const session = await deps.retrieveCheckoutSession(cleanId);

	if (session.mode !== 'subscription') {
		return { synced: false, reason: 'non_subscription_checkout' };
	}

	const sessionOrgId =
		session.metadata?.organizationId?.trim() || session.client_reference_id?.trim() || null;
	if (sessionOrgId !== params.organizationId) {
		return { synced: false, reason: 'organization_mismatch' };
	}

	if (session.status !== 'complete' && session.payment_status !== 'paid') {
		return { synced: false, reason: 'checkout_not_complete' };
	}

	const subscriptionId =
		typeof session.subscription === 'string'
			? session.subscription
			: session.subscription?.id ?? null;
	if (!subscriptionId) {
		return { synced: false, reason: 'missing_subscription_id' };
	}

	const normalized = await deps.retrieveSubscription(subscriptionId);
	const synced = await syncStripeSubscriptionToOrg(normalized, params.organizationId, deps);
	return synced
		? { synced: true, subscriptionId }
		: { synced: false, reason: 'organization_not_found' };
}

export async function handleVerifiedStripeEvent(
	event: Stripe.Event,
	overrides?: Partial<BillingLifecycleDeps>
): Promise<{ handled: boolean; organizationId?: string; reason?: string }> {
	const deps: BillingLifecycleDeps = { ...createDefaultLifecycleDeps(), ...overrides };

	switch (event.type) {
		case 'checkout.session.completed': {
			const session = event.data.object as Stripe.Checkout.Session;
			if (session.mode !== 'subscription') {
				return { handled: false, reason: 'non_subscription_checkout' };
			}
			const subscriptionId =
				typeof session.subscription === 'string'
					? session.subscription
					: session.subscription?.id ?? null;
			if (!subscriptionId) {
				return { handled: false, reason: 'missing_subscription_id' };
			}
			const explicitOrgId =
				session.metadata?.organizationId?.trim() ||
				session.client_reference_id?.trim() ||
				null;
			const normalized = await deps.retrieveSubscription(subscriptionId);
			const synced = await syncStripeSubscriptionToOrg(normalized, explicitOrgId, deps);
			return synced
				? { handled: true, organizationId: synced.organizationId }
				: { handled: false, reason: 'organization_not_found' };
		}

		case 'customer.subscription.created':
		case 'customer.subscription.updated': {
			const subscription = event.data.object as Stripe.Subscription;
			const normalized = normalizeStripeSubscription(subscription);
			const synced = await syncStripeSubscriptionToOrg(
				normalized,
				normalized.organizationIdFromMetadata,
				deps
			);
			return synced
				? { handled: true, organizationId: synced.organizationId }
				: { handled: false, reason: 'organization_not_found' };
		}

		case 'customer.subscription.deleted': {
			const subscription = event.data.object as Stripe.Subscription;
			const normalized = normalizeStripeSubscription(subscription, 'canceled');
			const synced = await syncStripeSubscriptionToOrg(
				normalized,
				normalized.organizationIdFromMetadata,
				deps
			);
			return synced
				? { handled: true, organizationId: synced.organizationId }
				: { handled: false, reason: 'organization_not_found' };
		}

		case 'invoice.paid':
		case 'invoice.payment_succeeded': {
			const invoice = event.data.object as Stripe.Invoice;
			const subscriptionId = extractInvoiceSubscriptionId(invoice);
			if (!subscriptionId) {
				return { handled: false, reason: 'invoice_without_subscription' };
			}
			const normalized = await deps.retrieveSubscription(subscriptionId);
			const synced = await syncStripeSubscriptionToOrg(
				normalized,
				normalized.organizationIdFromMetadata,
				deps
			);
			return synced
				? { handled: true, organizationId: synced.organizationId }
				: { handled: false, reason: 'organization_not_found' };
		}

		case 'invoice.payment_failed': {
			const invoice = event.data.object as Stripe.Invoice;
			const subscriptionId = extractInvoiceSubscriptionId(invoice);
			const customerId =
				typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id ?? null;
			const org = await deps.resolveOrgForBilling({ subscriptionId, customerId });
			if (!org) {
				return { handled: false, reason: 'organization_not_found' };
			}
			await deps.updateOrgSubscription(org.id, {
				subscription_status: 'past_due'
			});
			return { handled: true, organizationId: org.id };
		}

		default:
			return { handled: false, reason: `ignored_${event.type}` };
	}
}

/**
 * Barrido diario (Cron Trigger Cloudflare Workers):
 * 1. Expira trials de 14 días sin suscripción activa y pausa sus canales.
 * 2. Desconecta cuentas en Zernio tras superar el periodo de gracia (`gracePeriodDays = 3`)
 *    para evitar cuentas zombi ($1-$6 USD/canal/mes).
 */
export async function runBillingLifecycleSweep(options?: {
	gracePeriodDays?: number;
	now?: Date;
	deps?: Partial<BillingLifecycleDeps>;
}): Promise<{
	expiredTrialsCount: number;
	pausedChannelsCount: number;
	disconnectedZernioCount: number;
	errors: string[];
}> {
	const deps: BillingLifecycleDeps = { ...createDefaultLifecycleDeps(), ...options?.deps };
	const graceDays = Math.max(0, options?.gracePeriodDays ?? 3);
	const now = options?.now ?? new Date();
	const nowIso = now.toISOString();
	const cutoffMs = now.getTime() - graceDays * 86400_000;

	let expiredTrialsCount = 0;
	let pausedChannelsCount = 0;
	let disconnectedZernioCount = 0;
	const errors: string[] = [];

	const overdueOrgIds = await deps.listOverdueTrialOrgIds(nowIso);
	for (const orgId of overdueOrgIds) {
		try {
			await deps.updateOrgSubscription(orgId, {
				subscription_status: 'expired'
			});
			const reconciled = await reconcileChannelsForSubscription(
				{
					organizationId: orgId,
					allowedSlots: 0,
					subscriptionStatus: 'expired',
					nowIso
				},
				deps
			);
			expiredTrialsCount += 1;
			pausedChannelsCount += reconciled.pausedChannelIds.length;
		} catch (err) {
			errors.push(
				`Trial org ${orgId}: ${err instanceof Error ? err.message : 'error expirando trial'}`
			);
		}
	}

	const pausedChannels = await deps.listPausedBillingChannels();
	for (const ch of pausedChannels) {
		if (ch.metadata.zernio_disconnected_for_billing === true) continue;
		const pausedAtRaw =
			typeof ch.metadata.paused_billing_at === 'string' ? ch.metadata.paused_billing_at : null;
		const pausedAtMs = pausedAtRaw ? Date.parse(pausedAtRaw) : NaN;
		if (!Number.isFinite(pausedAtMs) || pausedAtMs > cutoffMs) {
			continue;
		}

		try {
			await deps.disconnectZernioAccount(ch.external_account_id);
			await deps.updateChannelState(ch.organization_id, ch.id, 'disconnected', {
				...ch.metadata,
				zernio_disconnected_for_billing: true,
				disconnected_for_billing_at: nowIso
			});
			disconnectedZernioCount += 1;
		} catch (err) {
			errors.push(
				`Zernio disconnect ${ch.id}: ${err instanceof Error ? err.message : 'error desconectando cuenta'}`
			);
		}
	}

	return {
		expiredTrialsCount,
		pausedChannelsCount,
		disconnectedZernioCount,
		errors
	};
}
