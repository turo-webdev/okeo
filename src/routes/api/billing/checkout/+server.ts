import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { assertApiOrgMember, parseValidatedBody, requireApiSession } from '$lib/server/auth';
import {
	createChannelCheckoutSession,
	isStripeConfigured
} from '$lib/server/billing/stripe';
import { updateChannelSlotsSchema } from '$lib/validation/schemas';

export const POST: RequestHandler = async (event) => {
	const user = await requireApiSession(event);
	const body = await parseValidatedBody(event.request, updateChannelSlotsSchema);
	const { org } = await assertApiOrgMember(event, body.organizationId, user.id, 'admin');

	if (!isStripeConfigured()) {
		return json(
			{
				error: 'El servicio de facturación no está disponible temporalmente.',
				code: 'STRIPE_NOT_CONFIGURED'
			},
			{ status: 503 }
		);
	}

	if (
		org.stripe_subscription_id &&
		(org.subscription_status === 'active' || org.subscription_status === 'trialing')
	) {
		return json(
			{
				error: 'Ya tienes una suscripción activa. Ajusta los cupos directamente o abre el portal de facturación.',
				code: 'SUBSCRIPTION_ALREADY_ACTIVE'
			},
			{ status: 409 }
		);
	}

	try {
		const session = await createChannelCheckoutSession({
			organizationId: org.id,
			organizationName: org.name,
			email: user.email,
			existingCustomerId: org.stripe_customer_id,
			channelSlots: body.channelSlots,
			successUrl: `${event.url.origin}/${org.slug}/settings?panel=plan&billing=success&session_id={CHECKOUT_SESSION_ID}`,
			cancelUrl: `${event.url.origin}/${org.slug}/settings?panel=plan&billing=canceled`
		});

		return json({
			ok: true,
			checkoutUrl: session.checkoutUrl,
			sessionId: session.sessionId,
			mode: 'stripe'
		});
	} catch (err) {
		console.error('[billing/checkout] createChannelCheckoutSession failed:', err);
		return json(
			{
				error: 'No se pudo iniciar el proceso de pago. Intenta de nuevo.'
			},
			{ status: 502 }
		);
	}
};
