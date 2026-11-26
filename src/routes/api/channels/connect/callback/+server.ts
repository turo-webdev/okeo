import { json, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { canOrganizationConnectRealChannels } from '$lib/server/billing/plans';
import {
	cancelChannelConnectSession,
	claimConnectSessionForCompletion,
	completeChannelConnectSession,
	encryptProviderPayload,
	expireChannelConnectSession,
	failChannelConnectSession,
	getChannelConnectSession,
	isConnectSessionExpired,
	parseHeadlessUserProfile,
	transitionSessionToPendingSelection
} from '$lib/server/channels/connect-sessions';
import { getOAuthStateSecret } from '$lib/server/channels/state';
import { getChannelProvider, isZernioConfigured } from '$lib/server/channels/zernio';
import {
	getOrganizationById,
	requireOrgMembership,
	upsertConnectedChannel
} from '$lib/server/crm/repository';
import { isSupabaseConfigured } from '$lib/server/supabase-admin';
import type { Platform } from '$lib/types/domain';

function defaultDisplayName(platform: Platform): string {
	if (platform === 'whatsapp') return 'WhatsApp';
	if (platform === 'instagram') return 'Instagram';
	return 'Messenger';
}

function mapProviderCallbackError(rawError: string): {
	cancelled: boolean;
	code: string;
} {
	const normalized = rawError.trim().toLowerCase();
	if (normalized === 'access_denied' || normalized === 'user_denied' || normalized === 'oauth_denied') {
		return { cancelled: true, code: 'oauth_denied' };
	}
	if (
		normalized === 'connection_cancelled' ||
		normalized === 'cancelled' ||
		normalized === 'canceled'
	) {
		return { cancelled: true, code: 'oauth_cancelled' };
	}
	if (normalized === 'no_facebook_pages') {
		return { cancelled: false, code: 'no_facebook_pages' };
	}
	return { cancelled: false, code: 'provider_error' };
}

export const GET: RequestHandler = async (event) => {
	const sid = event.url.searchParams.get('sid')?.trim();
	if (!sid) {
		return json({ error: 'Falta identificador de sesión de conexión' }, { status: 400 });
	}

	let secret: string;
	try {
		secret = getOAuthStateSecret();
	} catch (err) {
		console.error('[channels/connect/callback] OAuth state secret missing:', err);
		return json(
			{ error: 'Servicio de conexión no disponible temporalmente.' },
			{ status: 503 }
		);
	}

	const session = await getChannelConnectSession(sid);
	if (!session) {
		return json({ error: 'Sesión de conexión inválida o expirada' }, { status: 400 });
	}

	const org = await getOrganizationById(session.organizationId, event.locals);
	if (!org) {
		return json({ error: 'Organización no encontrada' }, { status: 404 });
	}

	if (isConnectSessionExpired(session)) {
		await expireChannelConnectSession(session.id);
		throw redirect(303, `/${org.slug}/settings?panel=canales&error=session_expired`);
	}

	try {
		await requireOrgMembership(org.id, session.userId, 'admin', undefined, event.locals);
	} catch {
		return json(
			{ error: 'El usuario no tiene permisos para conectar canales en este espacio' },
			{ status: 403 }
		);
	}

	const { user: sessionUser } = await event.locals.safeGetSession();
	if (sessionUser && sessionUser.id !== session.userId) {
		return json(
			{ error: 'La sesión actual no coincide con quien inició la conexión' },
			{ status: 403 }
		);
	}

	if (!canOrganizationConnectRealChannels(org)) {
		await failChannelConnectSession({
			sessionId: session.id,
			errorCode: 'subscription_required'
		});
		throw redirect(303, `/${org.slug}/settings?panel=plan&error=subscription_required`);
	}

	const oauthError = event.url.searchParams.get('error')?.trim();
	if (oauthError) {
		const mapped = mapProviderCallbackError(oauthError);
		if (mapped.cancelled) {
			await cancelChannelConnectSession(session.id);
		} else {
			await failChannelConnectSession({
				sessionId: session.id,
				errorCode: mapped.code
			});
		}
		throw redirect(303, `/${org.slug}/settings?panel=canales&error=${mapped.code}`);
	}

	const stepParam = event.url.searchParams.get('step')?.trim();
	const tempTokenParam = event.url.searchParams.get('tempToken')?.trim();
	const accountIdParam = event.url.searchParams.get('accountId')?.trim();

	// Flujo headless de Messenger / Facebook Page Picker: cifrar credenciales en servidor y continuar dentro de Okeo.
	if (
		stepParam === 'select_page' ||
		(session.platform === 'facebook' && Boolean(tempTokenParam) && !accountIdParam)
	) {
		if (session.status === 'pending_selection' || session.status === 'completed') {
			throw redirect(303, `/${org.slug}/settings/channels/connect/${session.id}`);
		}
		if (session.status !== 'initiated') {
			throw redirect(303, `/${org.slug}/settings?panel=canales&error=connect_session_invalid`);
		}
		if (session.platform !== 'facebook' || !tempTokenParam) {
			await failChannelConnectSession({
				sessionId: session.id,
				errorCode: 'connect_session_invalid'
			});
			throw redirect(303, `/${org.slug}/settings?panel=canales&error=connect_session_invalid`);
		}

		const userProfile = parseHeadlessUserProfile(event.url.searchParams.get('userProfile'));
		const connectToken = event.url.searchParams.get('connect_token')?.trim() || undefined;
		const scopes = event.url.searchParams.get('scopes')?.trim() || undefined;

		const encryptedPayload = await encryptProviderPayload(
			{
				tempToken: tempTokenParam,
				...(connectToken ? { connectToken } : {}),
				...(scopes ? { scopes } : {}),
				userProfile
			},
			secret
		);

		const transitioned = await transitionSessionToPendingSelection({
			sessionId: session.id,
			encryptedProviderPayload: encryptedPayload
		});

		if (!transitioned) {
			const latest = await getChannelConnectSession(session.id);
			if (latest && (latest.status === 'pending_selection' || latest.status === 'completed')) {
				throw redirect(303, `/${org.slug}/settings/channels/connect/${session.id}`);
			}
			throw redirect(303, `/${org.slug}/settings?panel=canales&error=connect_session_invalid`);
		}

		throw redirect(303, `/${org.slug}/settings/channels/connect/${session.id}`);
	}

	// Completado directo (Instagram, WhatsApp o reactivación directa del canal)
	if (session.status === 'completed') {
		throw redirect(303, `/${org.slug}/settings?panel=canales&connected=${session.platform}`);
	}

	if (isSupabaseConfigured() && event.locals.authMode !== 'supabase') {
		const nextPath = `${event.url.pathname}${event.url.search}`;
		throw redirect(302, `/login?next=${encodeURIComponent(nextPath)}`);
	}

	const claimed = await claimConnectSessionForCompletion({
		sessionId: session.id,
		expectedStatus: 'initiated'
	});
	if (!claimed) {
		throw redirect(303, `/${org.slug}/settings?panel=canales&error=connect_session_invalid`);
	}

	const usernameParam = event.url.searchParams.get('username')?.trim();
	const liveMode = isZernioConfigured();

	let externalAccountId = accountIdParam ?? `acc_mock_${session.platform}_${Date.now()}`;
	let displayName = defaultDisplayName(session.platform);
	let handleOrPhone =
		usernameParam ||
		(session.platform === 'whatsapp'
			? '+52 55 0101 0202'
			: session.platform === 'instagram'
				? `@${org.slug}`
				: org.name);

	if (liveMode) {
		if (!accountIdParam) {
			await failChannelConnectSession({
				sessionId: session.id,
				errorCode: 'missing_account_id'
			});
			throw redirect(303, `/${org.slug}/settings?panel=canales&error=missing_account_id`);
		}
		try {
			const accounts = await getChannelProvider().listAccounts(org.zernio_profile_id);
			const matched = accounts.find((acc) => acc.externalAccountId === accountIdParam);
			if (!matched) {
				await failChannelConnectSession({
					sessionId: session.id,
					errorCode: 'account_not_found'
				});
				throw redirect(303, `/${org.slug}/settings?panel=canales&error=account_not_found`);
			}
			if (matched.platform !== session.platform) {
				await failChannelConnectSession({
					sessionId: session.id,
					errorCode: 'platform_mismatch'
				});
				throw redirect(303, `/${org.slug}/settings?panel=canales&error=platform_mismatch`);
			}
			externalAccountId = matched.externalAccountId;
			displayName = matched.displayName;
			handleOrPhone = matched.handleOrPhone;
		} catch (err) {
			if (err && typeof err === 'object' && 'status' in err && 'location' in err) {
				throw err;
			}
			await failChannelConnectSession({
				sessionId: session.id,
				errorCode: 'provider_verify_failed'
			});
			throw redirect(303, `/${org.slug}/settings?panel=canales&error=provider_verify_failed`);
		}
	}

	const result = await upsertConnectedChannel(
		{
			organizationId: org.id,
			platform: session.platform,
			externalAccountId,
			displayName,
			handleOrPhone,
			channelId: session.targetChannelId ?? undefined
		},
		event.locals
	);

	if (!result.ok) {
		await failChannelConnectSession({
			sessionId: session.id,
			errorCode: result.code.toLowerCase()
		});
		throw redirect(303, `/${org.slug}/settings?panel=canales&error=${result.code.toLowerCase()}`);
	}

	await completeChannelConnectSession({
		sessionId: session.id,
		connectedChannelId: result.channel.id
	});

	throw redirect(303, `/${org.slug}/settings?panel=canales&connected=${session.platform}`);
};
