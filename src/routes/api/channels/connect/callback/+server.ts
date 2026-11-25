import { json, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { canOrganizationConnectRealChannels } from '$lib/server/billing/plans';
import { getOAuthStateSecret, verifyOAuthState } from '$lib/server/channels/state';
import { getChannelProvider, isZernioConfigured } from '$lib/server/channels/zernio';
import {
	getOrganizationById,
	requireOrgMembership,
	upsertConnectedChannel
} from '$lib/server/crm/repository';
import type { Platform } from '$lib/types/domain';

function defaultDisplayName(platform: Platform): string {
	if (platform === 'whatsapp') return 'WhatsApp';
	if (platform === 'instagram') return 'Instagram';
	return 'Messenger';
}

export const GET: RequestHandler = async (event) => {
	const stateParam = event.url.searchParams.get('state');
	if (!stateParam) {
		return json({ error: 'Falta parámetro state de OAuth' }, { status: 400 });
	}

	let secret: string;
	try {
		secret = getOAuthStateSecret();
	} catch (err) {
		return json(
			{ error: err instanceof Error ? err.message : 'Falta OAUTH_STATE_SECRET' },
			{ status: 503 }
		);
	}

	const payload = await verifyOAuthState(stateParam, secret);
	if (!payload) {
		return json({ error: 'State OAuth inválido o expirado' }, { status: 400 });
	}

	const org = await getOrganizationById(payload.organizationId, event.locals);
	if (!org) {
		return json({ error: 'Organización no encontrada' }, { status: 404 });
	}

	try {
		await requireOrgMembership(org.id, payload.userId, 'admin', undefined, event.locals);
	} catch {
		return json({ error: 'El usuario no tiene permisos para conectar canales en este espacio' }, { status: 403 });
	}

	const { user: sessionUser } = await event.locals.safeGetSession();
	if (sessionUser && sessionUser.id !== payload.userId) {
		return json({ error: 'La sesión actual no coincide con quien inició la conexión' }, { status: 403 });
	}

	if (!canOrganizationConnectRealChannels(org)) {
		throw redirect(303, `/${org.slug}/settings?panel=plan&error=subscription_required`);
	}

	const oauthError = event.url.searchParams.get('error');
	if (oauthError) {
		throw redirect(303, `/${org.slug}/settings?panel=canales&error=oauth_cancelled`);
	}

	const accountIdParam = event.url.searchParams.get('accountId')?.trim();
	const usernameParam = event.url.searchParams.get('username')?.trim();
	const liveMode = isZernioConfigured();

	let externalAccountId = accountIdParam ?? `acc_mock_${payload.platform}_${Date.now()}`;
	let displayName = defaultDisplayName(payload.platform);
	let handleOrPhone =
		usernameParam ||
		(payload.platform === 'whatsapp'
			? '+52 55 0101 0202'
			: payload.platform === 'instagram'
				? `@${org.slug}`
				: org.name);

	if (liveMode) {
		if (!accountIdParam) {
			throw redirect(303, `/${org.slug}/settings?panel=canales&error=missing_account_id`);
		}
		try {
			const accounts = await getChannelProvider().listAccounts(org.zernio_profile_id);
			const matched = accounts.find((acc) => acc.externalAccountId === accountIdParam);
			if (!matched) {
				throw redirect(303, `/${org.slug}/settings?panel=canales&error=account_not_found`);
			}
			externalAccountId = matched.externalAccountId;
			displayName = matched.displayName;
			handleOrPhone = matched.handleOrPhone;
		} catch (err) {
			if (err && typeof err === 'object' && 'status' in err && 'location' in err) {
				throw err;
			}
			throw redirect(303, `/${org.slug}/settings?panel=canales&error=zernio_verify_failed`);
		}
	}

	const result = await upsertConnectedChannel(
		{
			organizationId: org.id,
			platform: payload.platform,
			externalAccountId,
			displayName,
			handleOrPhone,
			channelId: payload.channelId
		},
		event.locals
	);

	if (!result.ok) {
		throw redirect(303, `/${org.slug}/settings?panel=canales&error=${result.code.toLowerCase()}`);
	}

	throw redirect(303, `/${org.slug}/settings?panel=canales&connected=${payload.platform}`);
};
