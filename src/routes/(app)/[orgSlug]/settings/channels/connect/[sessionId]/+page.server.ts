import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { z } from 'zod';
import { canOrganizationConnectRealChannels } from '$lib/server/billing/plans';
import {
	cancelChannelConnectSession,
	claimConnectSessionForCompletion,
	completeChannelConnectSession,
	decryptProviderPayload,
	expireChannelConnectSession,
	failChannelConnectSession,
	getChannelConnectSession,
	isConnectSessionExpired,
	revertConnectSessionToPendingSelection
} from '$lib/server/channels/connect-sessions';
import { getOAuthStateSecret } from '$lib/server/channels/state';
import { getChannelProvider } from '$lib/server/channels/zernio';
import { requireMemberForAction } from '$lib/server/crm/actions';
import { listWorkspaceChannels, upsertConnectedChannel } from '$lib/server/crm/repository';
import { hasMinRole } from '$lib/types/domain';

const selectFacebookPageSchema = z.object({
	organizationId: z.string().min(1),
	pageId: z.string().trim().min(1, 'Selecciona una Página de Facebook').max(120)
});

export const load: PageServerLoad = async ({ parent, params }) => {
	const parentData = await parent();
	if (parentData.accessDenied) {
		return { state: 'invalid' as const };
	}

	if (!hasMinRole(parentData.effectiveRole, 'admin')) {
		return { state: 'forbidden' as const };
	}

	const session = await getChannelConnectSession(params.sessionId);
	if (
		!session ||
		session.organizationId !== parentData.org.id ||
		session.userId !== parentData.user.id
	) {
		return { state: 'invalid' as const };
	}

	if (session.status === 'completed') {
		const connected = parentData.channels.find((c) => c.id === session.connectedChannelId);
		return {
			state: 'completed' as const,
			platform: session.platform,
			channelName: connected?.display_name ?? 'Messenger',
			channelHandle: connected?.handle_or_phone ?? ''
		};
	}

	if (isConnectSessionExpired(session)) {
		await expireChannelConnectSession(session.id);
		return {
			state: 'expired' as const,
			platform: session.platform
		};
	}

	if (session.status === 'cancelled' || session.status === 'failed') {
		return {
			state: 'error' as const,
			platform: session.platform,
			errorCode:
				session.errorCode ??
				(session.status === 'cancelled' ? 'oauth_cancelled' : 'connect_session_invalid')
		};
	}

	if (session.status === 'completing') {
		return {
			state: 'completing' as const,
			platform: session.platform
		};
	}

	if (session.status !== 'pending_selection' || !session.encryptedProviderPayload) {
		return { state: 'invalid' as const };
	}

	if (!canOrganizationConnectRealChannels(parentData.org)) {
		return {
			state: 'subscription_required' as const,
			platform: session.platform
		};
	}

	let secret: string;
	try {
		secret = getOAuthStateSecret();
	} catch {
		return {
			state: 'load_error' as const,
			platform: session.platform
		};
	}

	const payload = await decryptProviderPayload(session.encryptedProviderPayload, secret);
	if (!payload) {
		return { state: 'invalid' as const };
	}

	try {
		const { pages, truncated } = await getChannelProvider().listPendingFacebookPages({
			profileId: parentData.org.zernio_profile_id,
			tempToken: payload.tempToken
		});

		if (pages.length === 0) {
			return {
				state: 'empty' as const,
				platform: 'facebook' as const,
				userDisplayName: payload.userProfile?.name ?? ''
			};
		}

		return {
			state: 'ready' as const,
			sessionId: session.id,
			platform: 'facebook' as const,
			isReconnect: Boolean(session.targetChannelId),
			userDisplayName: payload.userProfile?.name ?? '',
			pages,
			truncated
		};
	} catch (err) {
		console.error('[channels/connect/picker] listPendingFacebookPages failed:', err);
		return {
			state: 'load_error' as const,
			platform: 'facebook' as const
		};
	}
};

export const actions: Actions = {
	selectPage: async ({ request, params, locals }) => {
		const { user, org } = await requireMemberForAction(params.orgSlug, locals, 'admin');
		const fd = await request.formData();
		const parsed = selectFacebookPageSchema.safeParse({
			organizationId: fd.get('organizationId'),
			pageId: fd.get('pageId')
		});
		if (!parsed.success || parsed.data.organizationId !== org.id) {
			return fail(400, {
				error: parsed.success
					? 'Workspace inválido'
					: (parsed.error.issues[0]?.message ?? 'Selecciona una Página de Facebook')
			});
		}

		const session = await getChannelConnectSession(params.sessionId);
		if (
			!session ||
			session.organizationId !== org.id ||
			session.userId !== user.id ||
			session.platform !== 'facebook'
		) {
			return fail(404, { error: 'Sesión de conexión no encontrada o no autorizada.' });
		}

		if (session.status === 'completed') {
			throw redirect(303, `/${org.slug}/settings/channels/connect/${session.id}`);
		}

		if (isConnectSessionExpired(session)) {
			await expireChannelConnectSession(session.id);
			return fail(410, {
				error: 'La sesión de conexión expiró. Inicia el proceso nuevamente.'
			});
		}

		if (!canOrganizationConnectRealChannels(org)) {
			return fail(402, {
				error: 'Activa tu plan ($9 USD/canal/mes) en Configuración → Plan para conectar canales reales.'
			});
		}

		const channels = await listWorkspaceChannels(org.id, locals);
		const targetChannel = session.targetChannelId
			? channels.find((c) => c.id === session.targetChannelId)
			: undefined;
		const activeCount = channels.filter((c) => c.status === 'active').length;
		const needsNewSlot = !targetChannel || targetChannel.status !== 'active';
		if (needsNewSlot && activeCount >= org.channel_slots) {
			return fail(403, {
				error: 'Alcanzaste el límite de canales contratados en este workspace.'
			});
		}

		const claimed = await claimConnectSessionForCompletion({
			sessionId: session.id,
			expectedStatus: 'pending_selection'
		});
		if (!claimed || !claimed.encryptedProviderPayload) {
			return fail(409, {
				error: 'Ya estamos completando esta conexión. Espera un momento o recarga la página.'
			});
		}

		let secret: string;
		try {
			secret = getOAuthStateSecret();
		} catch {
			await revertConnectSessionToPendingSelection(session.id);
			return fail(503, { error: 'Servicio de conexión no disponible temporalmente.' });
		}

		const payload = await decryptProviderPayload(claimed.encryptedProviderPayload, secret);
		if (!payload) {
			await failChannelConnectSession({
				sessionId: session.id,
				errorCode: 'connect_session_invalid'
			});
			return fail(400, { error: 'La sesión de conexión ya no es válida. Inicia de nuevo.' });
		}

		let selected: { externalAccountId: string; displayName: string; handleOrPhone: string };
		try {
			selected = await getChannelProvider().selectPendingFacebookPage({
				profileId: org.zernio_profile_id,
				pageId: parsed.data.pageId,
				tempToken: payload.tempToken,
				userProfile: payload.userProfile ?? {},
				scopes: payload.scopes
			});
		} catch (err) {
			console.error('[channels/connect/picker] selectPendingFacebookPage failed:', err);
			await revertConnectSessionToPendingSelection(session.id);
			return fail(502, {
				error: 'No pudimos conectar esa Página de Facebook. Intenta de nuevo.'
			});
		}

		const upsertResult = await upsertConnectedChannel(
			{
				organizationId: org.id,
				platform: 'facebook',
				externalAccountId: selected.externalAccountId,
				displayName: selected.displayName,
				handleOrPhone: selected.handleOrPhone,
				channelId: session.targetChannelId ?? undefined
			},
			locals
		);

		if (!upsertResult.ok) {
			await failChannelConnectSession({
				sessionId: session.id,
				errorCode: upsertResult.code.toLowerCase()
			});
			return fail(409, { error: upsertResult.error });
		}

		await completeChannelConnectSession({
			sessionId: session.id,
			connectedChannelId: upsertResult.channel.id
		});

		throw redirect(303, `/${org.slug}/settings/channels/connect/${session.id}`);
	},

	cancel: async ({ params, locals }) => {
		const { user, org } = await requireMemberForAction(params.orgSlug, locals, 'admin');
		const session = await getChannelConnectSession(params.sessionId);
		if (session && session.organizationId === org.id && session.userId === user.id) {
			await cancelChannelConnectSession(session.id);
		}
		throw redirect(303, `/${org.slug}/settings?panel=canales&error=oauth_cancelled`);
	}
};
