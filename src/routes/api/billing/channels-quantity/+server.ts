import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { assertApiOrgMember, parseValidatedBody, requireApiSession } from '$lib/server/auth';
import { syncStripeSubscriptionToOrg } from '$lib/server/billing/lifecycle';
import {
	isStripeConfigured,
	updateStripeSubscriptionChannelQuantity
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

	if (!org.stripe_subscription_id) {
		return json(
			{
				error: 'Este workspace aún no tiene una suscripción activa.',
				code: 'NO_ACTIVE_SUBSCRIPTION'
			},
			{ status: 400 }
		);
	}

	try {
		const updatedSub = await updateStripeSubscriptionChannelQuantity({
			subscriptionId: org.stripe_subscription_id,
			channelItemId: org.stripe_channel_item_id,
			channelSlots: body.channelSlots
		});

		const syncResult = await syncStripeSubscriptionToOrg(updatedSub, org.id);

		return json({
			ok: true,
			channelSlots: syncResult?.channelSlots ?? updatedSub.channelSlots,
			subscriptionStatus: syncResult?.subscriptionStatus ?? updatedSub.status,
			pausedChannelIds: syncResult?.pausedChannelIds ?? [],
			reactivatedChannelIds: syncResult?.reactivatedChannelIds ?? []
		});
	} catch (err) {
		console.error('[billing/channels-quantity] update failed:', err);
		return json(
			{
				error: 'No se pudo actualizar la cantidad de canales. Intenta de nuevo.'
			},
			{ status: 502 }
		);
	}
};
