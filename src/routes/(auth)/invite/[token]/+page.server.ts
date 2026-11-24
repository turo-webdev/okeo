import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { acceptInvitation, getInvitationByToken } from '$lib/server/crm/repository';

function isDemoToken(token: string): boolean {
	return (
		token === 'valid' ||
		token === 'expired' ||
		token === 'mismatch' ||
		token === 'revoked' ||
		token.startsWith('inv_')
	);
}

export const load: PageServerLoad = async ({ params, url, locals }) => {
	const invitation = await getInvitationByToken(params.token);
	const modeOverride = url.searchParams.get('account');
	const demo = isDemoToken(params.token);
	const { user } = await locals.safeGetSession();
	const isAuthenticatedSupabase = locals.authMode === 'supabase' && Boolean(user);

	const requiresLogin = !demo && !isAuthenticatedSupabase;
	const currentAccountEmail = !demo
		? isAuthenticatedSupabase
			? user?.email ?? ''
			: ''
		: modeOverride === 'match'
			? invitation?.email ?? 'maria@equipo.example'
			: params.token === 'mismatch'
				? 'sofia@equipo.example'
				: 'maria@equipo.example';

	return {
		token: params.token,
		isDemoToken: demo,
		requiresLogin,
		invitation,
		currentAccountEmail
	};
};

export const actions: Actions = {
	accept: async ({ params, locals }) => {
		const demo = isDemoToken(params.token);
		const { user } = await locals.safeGetSession();

		if (!demo && (locals.authMode !== 'supabase' || !user)) {
			return fail(401, { error: 'Inicia sesión con tu correo invitado antes de aceptar.' });
		}

		const acceptingUser =
			locals.authMode === 'supabase' && user
				? {
						id: user.id,
						email: user.email ?? '',
						full_name: user.full_name || user.email?.split('@')[0] || 'Usuario'
					}
				: null;

		const updated = await acceptInvitation(params.token, acceptingUser);
		if (!updated) {
			return fail(400, {
				error: 'La invitación no coincide con tu cuenta actual o ya no está disponible.'
			});
		}
		return { accepted: true, invitation: updated };
	},
	requestNew: async ({ params }) => {
		const invitation = await getInvitationByToken(params.token);
		return { requestedNew: true, email: invitation?.email ?? 'maria@equipo.example' };
	}
};
