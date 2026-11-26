import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { assertApiOrgMember, parseValidatedBody, requireApiSession } from '$lib/server/auth';
import { canOrganizationConnectRealChannels } from '$lib/server/billing/plans';
import { getChannelConnectOptions } from '$lib/server/channels/config';
import {
	createChannelConnectSession,
	failChannelConnectSession
} from '$lib/server/channels/connect-sessions';
import { getOAuthStateSecret } from '$lib/server/channels/state';
import { getChannelProvider, isZernioConfigured } from '$lib/server/channels/zernio';
import {
	listWorkspaceChannels,
	updateOrganizationZernioProfileId
} from '$lib/server/crm/repository';
import { channelActionSchema } from '$lib/validation/schemas';

export const POST: RequestHandler = async (event) => {
	const user = await requireApiSession(event);
	const body = await parseValidatedBody(event.request, channelActionSchema);
	const { org } = await assertApiOrgMember(event, body.organizationId, user.id, 'admin');

	if (!canOrganizationConnectRealChannels(org)) {
		return json(
			{
				error: 'Activa tu plan ($9 USD/canal/mes) en Configuración → Plan para conectar canales reales.',
				code: 'SUBSCRIPTION_REQUIRED'
			},
			{ status: 402 }
		);
	}

	const channels = await listWorkspaceChannels(org.id, event.locals);
	const existingChannel = body.channelId
		? channels.find((c) => c.id === body.channelId)
		: undefined;
	if (body.channelId && !existingChannel) {
		return json({ error: 'Canal no encontrado en este workspace' }, { status: 404 });
	}

	const activeCount = channels.filter((c) => c.status === 'active').length;
	const needsNewSlot = !existingChannel || existingChannel.status !== 'active';
	if (needsNewSlot && activeCount >= org.channel_slots) {
		return json(
			{ error: 'Alcanzaste el límite de canales contratados.', code: 'CHANNEL_SLOTS_FULL' },
			{ status: 403 }
		);
	}

	const liveMode = isZernioConfigured();
	const provider = getChannelProvider();

	try {
		getOAuthStateSecret();
	} catch (err) {
		console.error('[channels/connect] OAuth state secret missing:', err);
		return json(
			{ error: 'Servicio de conexión no disponible temporalmente.' },
			{ status: 503 }
		);
	}

	let profileId = org.zernio_profile_id;
	if (liveMode && (!profileId || profileId.startsWith('zernio_prof_'))) {
		try {
			const created = await provider.createProfile(org.name);
			profileId = created.profileId;
			await updateOrganizationZernioProfileId(org.id, profileId, event.locals);
		} catch (err) {
			console.error('[channels/connect] createProfile failed:', err);
			return json(
				{
					error: 'No se pudo inicializar la conexión de mensajería. Intenta de nuevo.'
				},
				{ status: 502 }
			);
		}
	}

	const platform = body.platform ?? existingChannel?.platform ?? 'whatsapp';
	const connectSession = await createChannelConnectSession({
		organizationId: org.id,
		userId: user.id,
		platform,
		targetChannelId: existingChannel?.id
	});

	try {
		const redirectUri = `${event.url.origin}/api/channels/connect/callback?sid=${encodeURIComponent(connectSession.id)}`;
		const connectOptions = getChannelConnectOptions(platform);
		const { authUrl } = await provider.getConnectUrl({
			profileId,
			platform,
			redirectUri,
			reconnectAccountId: existingChannel?.external_account_id,
			...connectOptions
		});

		return json({
			ok: true,
			authUrl,
			sessionId: connectSession.id,
			mode: liveMode ? 'zernio' : 'mock'
		});
	} catch (err) {
		console.error('[channels/connect] getConnectUrl failed:', err);
		await failChannelConnectSession({
			sessionId: connectSession.id,
			errorCode: 'connect_url_failed'
		}).catch(() => {});
		return json(
			{
				error: 'No se pudo generar el enlace de conexión del canal. Intenta de nuevo.'
			},
			{ status: 502 }
		);
	}
};
