import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { createWorkspace } from '$lib/server/crm/repository';
import { createWorkspaceSchema } from '$lib/validation/schemas';

export const load: PageServerLoad = async ({ locals }) => {
	const { user } = await locals.safeGetSession();
	return { user };
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
		const { user } = await locals.safeGetSession();
		if (!user) return fail(401, { error: 'Inicia sesión primero' });

		const fd = await request.formData();
		const parsed = createWorkspaceSchema.safeParse({
			name: fd.get('name'),
			platform: fd.get('platform') ?? 'whatsapp',
			industry: fd.get('industry') ?? 'Servicios profesionales',
			language: fd.get('language') ?? 'es',
			autoReplyEnabled: fd.get('mode') === 'auto',
			initialKnowledge: fd.get('initialKnowledge') ?? ''
		});

		if (!parsed.success) {
			return fail(400, { error: parsed.error.issues[0]?.message ?? 'Revisa los datos' });
		}

		const org = await createWorkspace(
			{
				userId: user.id,
				userEmail: user.email,
				userName: user.full_name,
				...parsed.data
			},
			locals
		);

		throw redirect(303, `/${org.slug}/inbox`);
	}
};
