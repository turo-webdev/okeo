import { redirect } from '@sveltejs/kit';
import { env as publicEnv } from '$env/dynamic/public';
import { listUserOrganizations } from '$lib/server/crm/repository';
import { resolveDomainContext } from '$lib/server/domains';
import { isSupabaseConfigured } from '$lib/server/supabase-admin';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, locals }) => {
	if (resolveDomainContext(url, publicEnv).isAppHost) {
		if (isSupabaseConfigured() && locals.supabase) {
			const { user } = await locals.safeGetSession();
			if (locals.authMode === 'supabase' && user) {
				const orgs = await listUserOrganizations(user.id, locals);
				throw redirect(303, orgs.length > 0 ? `/${orgs[0].slug}/inbox` : '/onboarding');
			}
		}
		throw redirect(303, '/login');
	}

	return {};
};
