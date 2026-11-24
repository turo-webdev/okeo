import { fail } from '@sveltejs/kit';
import type { Actions } from './$types';
import { requireMemberForAction } from '$lib/server/crm/actions';
import { createContact } from '$lib/server/crm/repository';
import { createContactSchema } from '$lib/validation/schemas';

export const actions: Actions = {
	createContact: async ({ request, params, locals }) => {
		const { org } = await requireMemberForAction(params.orgSlug, locals, 'agent');
		const fd = await request.formData();
		const parsed = createContactSchema.safeParse({
			organizationId: fd.get('organizationId'),
			name: fd.get('name'),
			company: fd.get('company') ?? '',
			email: fd.get('email') ?? '',
			phone: fd.get('phone') ?? '',
			ownerUserId: fd.get('ownerUserId') ? String(fd.get('ownerUserId')) : null,
			nextStepTitle: fd.get('nextStepTitle') ?? 'Primer contacto',
			nextStepAtLabel: fd.get('nextStepAtLabel') ?? 'Mañana'
		});
		if (!parsed.success || parsed.data.organizationId !== org.id) {
			return fail(400, { error: parsed.success ? 'Organización inválida' : parsed.error.issues[0]?.message });
		}
		await createContact(
			{
				...parsed.data,
				ownerUserId: parsed.data.ownerUserId ?? null
			},
			locals
		);
		return { ok: true };
	}
};
