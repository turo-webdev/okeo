import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { handleVerifiedStripeEvent } from '$lib/server/billing/lifecycle';
import {
	isStripeWebhookConfigured,
	tryClaimStripeWebhookEvent,
	verifyStripeWebhookEvent
} from '$lib/server/billing/stripe';

export const POST: RequestHandler = async ({ request }) => {
	// Leer raw body antes de cualquier parseo JSON para verificar firma de Stripe (AGENTS.md §2)
	const rawBody = await request.text();
	const sig = request.headers.get('stripe-signature');

	if (!isStripeWebhookConfigured()) {
		return json(
			{
				error: 'Stripe webhook no configurado en el servidor (STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET).',
				code: 'STRIPE_WEBHOOK_NOT_CONFIGURED'
			},
			{ status: 503 }
		);
	}

	if (!sig) {
		return json({ error: 'Cabecera Stripe-Signature requerida' }, { status: 400 });
	}

	let event;
	try {
		event = await verifyStripeWebhookEvent(rawBody, sig);
	} catch (err) {
		return json(
			{
				error:
					err instanceof Error
						? `Firma de webhook de Stripe inválida: ${err.message}`
						: 'Firma Stripe-Signature inválida'
			},
			{ status: 400 }
		);
	}

	const claimed = await tryClaimStripeWebhookEvent(event.id, event.type);
	if (!claimed) {
		return json({ received: true, deduplicated: true, type: event.type });
	}

	try {
		const result = await handleVerifiedStripeEvent(event);
		return json({
			received: true,
			type: event.type,
			handled: result.handled,
			...(result.organizationId ? { organizationId: result.organizationId } : {})
		});
	} catch (err) {
		console.error('[webhooks/stripe] Error procesando evento:', event.type, err);
		return json(
			{
				error: err instanceof Error ? err.message : 'Error sincronizando evento de Stripe'
			},
			{ status: 500 }
		);
	}
};
