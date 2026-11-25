import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { assertApiOrgMember, parseValidatedBody, requireApiSession } from '$lib/server/auth';
import {
	createCustomerPortalSession,
	isStripeConfigured
} from '$lib/server/billing/stripe';

const portalSchema = z.object({
	organizationId: z.string().min(1)
});

export const POST: RequestHandler = async (event) => {
	const user = await requireApiSession(event);
	const body = await parseValidatedBody(event.request, portalSchema);
	const { org } = await assertApiOrgMember(event, body.organizationId, user.id, 'admin');

	if (!isStripeConfigured()) {
		return json(
			{
				error: 'El portal de facturación no está disponible temporalmente.',
				code: 'STRIPE_NOT_CONFIGURED'
			},
			{ status: 503 }
		);
	}

	if (!org.stripe_customer_id) {
		return json(
			{
				error: 'Primero activa tu plan para acceder al portal de facturación.',
				code: 'NO_STRIPE_CUSTOMER'
			},
			{ status: 400 }
		);
	}

	try {
		const portal = await createCustomerPortalSession({
			customerId: org.stripe_customer_id,
			returnUrl: `${event.url.origin}/${org.slug}/settings?panel=plan`
		});

		return json({ ok: true, portalUrl: portal.portalUrl, mode: 'stripe' });
	} catch (err) {
		console.error('[billing/portal] createCustomerPortalSession failed:', err);
		return json(
			{
				error: 'No se pudo abrir el portal de facturación. Intenta de nuevo.'
			},
			{ status: 502 }
		);
	}
};
