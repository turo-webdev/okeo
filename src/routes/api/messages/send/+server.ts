import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { assertApiOrgMember, parseValidatedBody, requireApiSession } from '$lib/server/auth';
import { deliverManualMessage, OutboundDeliveryError } from '$lib/server/crm/outbound';
import { sendMessageSchema } from '$lib/validation/schemas';

export const POST: RequestHandler = async (event) => {
	const user = await requireApiSession(event);
	const body = await parseValidatedBody(event.request, sendMessageSchema);
	await assertApiOrgMember(event, body.organizationId, user.id, 'agent');

	try {
		const message = await deliverManualMessage(
			{
				organizationId: body.organizationId,
				conversationId: body.conversationId,
				userId: user.id,
				body: body.body,
				retryMessageId: body.retryMessageId,
				attachment: body.attachment
			},
			event.locals
		);
		return json({ ok: true, message });
	} catch (err) {
		if (err instanceof OutboundDeliveryError) {
			return json(
				{
					error: err.message,
					code: err.code
				},
				{ status: err.statusCode }
			);
		}
		return json(
			{
				error: err instanceof Error ? err.message : 'No se pudo enviar el mensaje.',
				code: 'SEND_FAILED'
			},
			{ status: 500 }
		);
	}
};
