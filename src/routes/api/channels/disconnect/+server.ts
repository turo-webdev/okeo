import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { assertApiOrgMember, parseValidatedBody, requireApiSession } from '$lib/server/auth';
import { getChannelProvider } from '$lib/server/channels/zernio';
import { disconnectChannel, getWorkspaceSnapshot } from '$lib/server/crm/repository';
import { channelActionSchema } from '$lib/validation/schemas';

export const POST: RequestHandler = async (event) => {
	const user = await requireApiSession(event);
	const body = await parseValidatedBody(event.request, channelActionSchema);
	await assertApiOrgMember(event, body.organizationId, user.id, 'admin');

	if (!body.channelId) {
		return json({ error: 'channelId requerido' }, { status: 400 });
	}

	const snapshot = await getWorkspaceSnapshot(body.organizationId, event.locals);
	const existing = snapshot?.channels.find((c) => c.id === body.channelId);
	if (!existing) {
		return json({ error: 'Canal no encontrado' }, { status: 404 });
	}

	try {
		await getChannelProvider().disconnectAccount(existing.external_account_id);
	} catch (err) {
		console.error('[channels/disconnect] disconnectAccount failed:', err);
		return json(
			{
				error: 'No se pudo desconectar el canal. Intenta de nuevo.'
			},
			{ status: 502 }
		);
	}

	const channel = await disconnectChannel(body.organizationId, body.channelId, event.locals);
	return json({ ok: true, channel });
};
