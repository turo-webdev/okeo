import { error } from '@sveltejs/kit';
import { getOrganizationBySlug, requireOrgMembership } from './repository';
import type { OrgRole } from '$lib/types/domain';

export async function requireMemberForAction(
	slug: string,
	locals: App.Locals,
	minRole: OrgRole
) {
	const { user } = await locals.safeGetSession();
	if (!user) throw error(401, 'Sesión requerida');
	const org = await getOrganizationBySlug(slug, locals);
	if (!org) throw error(404, 'Workspace no encontrado');
	const demoOverride = locals.authMode === 'supabase' ? undefined : locals.demoRole;
	return {
		user,
		...(await requireOrgMembership(org.id, user.id, minRole, demoOverride, locals))
	};
}
