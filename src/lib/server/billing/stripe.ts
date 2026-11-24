import Stripe from 'stripe';
import { env } from '$env/dynamic/private';
import { getSupabaseAdminClient } from '$lib/server/supabase-admin';
import type { SubscriptionStatus } from '$lib/types/domain';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface NormalizedStripeSubscription {
	customerId: string;
	subscriptionId: string;
	channelItemId: string | null;
	status: SubscriptionStatus;
	channelSlots: number;
	periodStartIso: string;
	periodEndIso: string;
	organizationIdFromMetadata: string | null;
}

export function isStripeConfigured(): boolean {
	return Boolean(env.STRIPE_SECRET_KEY?.trim() && env.STRIPE_CHANNEL_PRICE_ID?.trim());
}

export function isStripeWebhookConfigured(): boolean {
	return Boolean(env.STRIPE_SECRET_KEY?.trim() && env.STRIPE_WEBHOOK_SECRET?.trim());
}

function getConfiguredChannelPriceId(): string {
	const priceId = env.STRIPE_CHANNEL_PRICE_ID?.trim();
	if (!priceId) {
		throw new Error('STRIPE_CHANNEL_PRICE_ID no configurado en el servidor.');
	}
	return priceId;
}

export function getStripeClient(): Stripe {
	const secretKey = env.STRIPE_SECRET_KEY?.trim();
	if (!secretKey) {
		throw new Error('STRIPE_SECRET_KEY no configurado en el servidor.');
	}
	return new Stripe(secretKey, {
		httpClient: Stripe.createFetchHttpClient()
	});
}

export function extractSubscriptionPeriod(sub: Pick<Stripe.Subscription, 'items'> & {
	current_period_start?: number;
	current_period_end?: number;
}): {
	periodStartIso: string;
	periodEndIso: string;
} {
	const itemPeriods = (sub.items?.data ?? [])
		.map((item) => ({
			start: typeof item.current_period_start === 'number' ? item.current_period_start : null,
			end: typeof item.current_period_end === 'number' ? item.current_period_end : null
		}))
		.filter((p): p is { start: number; end: number } => p.start !== null && p.end !== null);

	if (itemPeriods.length > 0) {
		const startSec = Math.min(...itemPeriods.map((p) => p.start));
		const endSec = Math.max(...itemPeriods.map((p) => p.end));
		return {
			periodStartIso: new Date(startSec * 1000).toISOString(),
			periodEndIso: new Date(endSec * 1000).toISOString()
		};
	}

	if (typeof sub.current_period_start === 'number' && typeof sub.current_period_end === 'number') {
		return {
			periodStartIso: new Date(sub.current_period_start * 1000).toISOString(),
			periodEndIso: new Date(sub.current_period_end * 1000).toISOString()
		};
	}

	const now = Date.now();
	return {
		periodStartIso: new Date(now).toISOString(),
		periodEndIso: new Date(now + 30 * 86400_000).toISOString()
	};
}

export function mapStripeStatus(status: Stripe.Subscription.Status | string): SubscriptionStatus {
	switch (status) {
		case 'active':
			return 'active';
		case 'trialing':
			return 'trialing';
		case 'canceled':
			return 'canceled';
		case 'unpaid':
		case 'incomplete_expired':
			return 'expired';
		case 'past_due':
		case 'incomplete':
		case 'paused':
		default:
			return 'past_due';
	}
}

export function normalizeStripeSubscription(
	sub: Stripe.Subscription,
	forceStatus?: SubscriptionStatus
): NormalizedStripeSubscription {
	const configuredPriceId = env.STRIPE_CHANNEL_PRICE_ID?.trim();
	const items = sub.items?.data ?? [];
	const channelItem =
		(configuredPriceId ? items.find((it) => it.price?.id === configuredPriceId) : undefined) ??
		items[0] ??
		null;

	const { periodStartIso, periodEndIso } = extractSubscriptionPeriod(sub);
	const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;

	return {
		customerId,
		subscriptionId: sub.id,
		channelItemId: channelItem?.id ?? null,
		status: forceStatus ?? mapStripeStatus(sub.status),
		channelSlots: Math.max(1, channelItem?.quantity ?? 1),
		periodStartIso,
		periodEndIso,
		organizationIdFromMetadata: sub.metadata?.organizationId?.trim() || null
	};
}

export function extractInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
	const parentSub = invoice.parent?.subscription_details?.subscription;
	if (typeof parentSub === 'string' && parentSub.trim()) return parentSub.trim();
	if (parentSub && typeof parentSub === 'object' && 'id' in parentSub && parentSub.id) {
		return parentSub.id;
	}

	const legacy = (invoice as unknown as { subscription?: string | { id?: string } | null })
		.subscription;
	if (typeof legacy === 'string' && legacy.trim()) return legacy.trim();
	if (legacy && typeof legacy === 'object' && legacy.id) return legacy.id;
	return null;
}

export async function createOrGetStripeCustomer(params: {
	organizationId: string;
	organizationName: string;
	email?: string | null;
	existingCustomerId?: string | null;
}): Promise<string> {
	if (params.existingCustomerId?.trim()) {
		return params.existingCustomerId.trim();
	}

	const stripe = getStripeClient();
	const customer = await stripe.customers.create({
		name: params.organizationName.trim().slice(0, 120) || 'Okeo Workspace',
		...(params.email?.trim() ? { email: params.email.trim() } : {}),
		metadata: {
			organizationId: params.organizationId
		}
	});

	if (UUID_REGEX.test(params.organizationId)) {
		const admin = getSupabaseAdminClient();
		if (admin) {
			await admin
				.from('organizations')
				.update({ stripe_customer_id: customer.id })
				.eq('id', params.organizationId);
		}
	}

	return customer.id;
}

export async function createChannelCheckoutSession(params: {
	organizationId: string;
	organizationName: string;
	email?: string | null;
	existingCustomerId?: string | null;
	channelSlots: number;
	successUrl: string;
	cancelUrl: string;
}): Promise<{ checkoutUrl: string; customerId: string; sessionId: string }> {
	const stripe = getStripeClient();
	const priceId = getConfiguredChannelPriceId();
	const customerId = await createOrGetStripeCustomer({
		organizationId: params.organizationId,
		organizationName: params.organizationName,
		email: params.email,
		existingCustomerId: params.existingCustomerId
	});

	const safeQuantity = Math.max(1, Math.min(100, Math.round(params.channelSlots)));
	const automaticTaxEnabled = env.STRIPE_AUTOMATIC_TAX?.trim() === 'true';
	const session = await stripe.checkout.sessions.create({
		mode: 'subscription',
		customer: customerId,
		client_reference_id: params.organizationId,
		line_items: [{ price: priceId, quantity: safeQuantity }],
		billing_address_collection: 'auto',
		tax_id_collection: { enabled: true },
		customer_update: {
			name: 'auto',
			address: 'auto'
		},
		...(automaticTaxEnabled ? { automatic_tax: { enabled: true } } : {}),
		allow_promotion_codes: true,
		metadata: {
			organizationId: params.organizationId
		},
		subscription_data: {
			metadata: {
				organizationId: params.organizationId
			}
		},
		success_url: params.successUrl,
		cancel_url: params.cancelUrl
	});

	if (!session.url) {
		throw new Error('Stripe Checkout no devolvió una URL de pago.');
	}

	return {
		checkoutUrl: session.url,
		customerId,
		sessionId: session.id
	};
}

export async function updateStripeSubscriptionChannelQuantity(params: {
	subscriptionId: string;
	channelItemId?: string | null;
	channelSlots: number;
}): Promise<NormalizedStripeSubscription> {
	const stripe = getStripeClient();
	const safeQuantity = Math.max(1, Math.min(100, Math.round(params.channelSlots)));

	let itemId = params.channelItemId?.trim() || null;
	if (!itemId) {
		const existing = await stripe.subscriptions.retrieve(params.subscriptionId);
		const configuredPriceId = env.STRIPE_CHANNEL_PRICE_ID?.trim();
		const items = existing.items?.data ?? [];
		const matched =
			(configuredPriceId ? items.find((it) => it.price?.id === configuredPriceId) : undefined) ??
			items[0];
		itemId = matched?.id ?? null;
	}

	if (!itemId) {
		throw new Error('No se encontró el ítem de canales dentro de la suscripción de Stripe.');
	}

	const updated = await stripe.subscriptions.update(params.subscriptionId, {
		items: [{ id: itemId, quantity: safeQuantity }],
		proration_behavior: 'create_prorations'
	});

	return normalizeStripeSubscription(updated);
}

export async function createCustomerPortalSession(params: {
	customerId: string;
	returnUrl: string;
}): Promise<{ portalUrl: string }> {
	const stripe = getStripeClient();
	const session = await stripe.billingPortal.sessions.create({
		customer: params.customerId,
		return_url: params.returnUrl
	});
	return { portalUrl: session.url };
}

export async function retrieveNormalizedStripeSubscription(
	subscriptionId: string
): Promise<NormalizedStripeSubscription> {
	const stripe = getStripeClient();
	const sub = await stripe.subscriptions.retrieve(subscriptionId);
	return normalizeStripeSubscription(sub);
}

export async function retrieveCheckoutSession(
	sessionId: string
): Promise<Stripe.Checkout.Session> {
	const stripe = getStripeClient();
	return stripe.checkout.sessions.retrieve(sessionId);
}

export async function verifyStripeWebhookEvent(
	rawBody: string,
	signatureHeader: string
): Promise<Stripe.Event> {
	const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim();
	if (!webhookSecret) {
		throw new Error('STRIPE_WEBHOOK_SECRET no configurado en el servidor.');
	}
	const stripe = getStripeClient();
	return stripe.webhooks.constructEventAsync(rawBody, signatureHeader, webhookSecret);
}

/**
 * Garantiza idempotencia ante reintentos de Stripe insertando `event_id` en `stripe_webhook_events`.
 * Única capa con acceso a `stripe_webhook_events` (AGENTS.md §4).
 */
export async function tryClaimStripeWebhookEvent(
	eventId: string,
	eventType: string
): Promise<boolean> {
	const cleanId = eventId.trim();
	if (!cleanId) return true;

	const admin = getSupabaseAdminClient();
	if (!admin) return true;

	const { error } = await admin.from('stripe_webhook_events').insert({
		event_id: cleanId,
		event_type: eventType.trim() || 'unknown'
	});

	if (!error) return true;
	if (error.code === '23505') {
		return false;
	}
	throw new Error(`No se pudo registrar evento de Stripe: ${error.message}`);
}
