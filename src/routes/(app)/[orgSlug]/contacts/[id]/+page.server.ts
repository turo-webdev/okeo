import { fail } from '@sveltejs/kit';
import type { Actions } from './$types';
import { requireMemberForAction } from '$lib/server/crm/actions';
import { addInternalNote, updateContact } from '$lib/server/crm/repository';
import { saveNoteSchema, updateContactSchema } from '$lib/validation/schemas';

export const actions: Actions = {
	updateContact: async ({ request, params, locals }) => {
		const { org } = await requireMemberForAction(params.orgSlug, locals, 'agent');
		const fd = await request.formData();
		const parsed = updateContactSchema.safeParse({
			organizationId: fd.get('organizationId'),
			contactId: fd.get('contactId'),
			name: fd.get('name'),
			company: fd.get('company') ?? '',
			roleTitle: fd.get('roleTitle') ?? '',
			email: fd.get('email') ?? '',
			phone: fd.get('phone') ?? '',
			ownerUserId: fd.get('ownerUserId') ? String(fd.get('ownerUserId')) : null,
			nextStepTitle: fd.get('nextStepTitle') ?? '',
			nextStepAtLabel: fd.get('nextStepAtLabel') ?? ''
		});
		if (!parsed.success || parsed.data.organizationId !== org.id) {
			return fail(400, { error: 'Revisa los datos del contacto' });
		}
		await updateContact(
			{
				...parsed.data,
				ownerUserId: parsed.data.ownerUserId ?? null
			},
			locals
		);
		return { ok: true };
	},

	addNote: async ({ request, params, locals }) => {
		const { user, org } = await requireMemberForAction(params.orgSlug, locals, 'agent');
		const fd = await request.formData();
		const parsed = saveNoteSchema.safeParse({
			organizationId: fd.get('organizationId'),
			contactId: fd.get('contactId'),
			conversationId: fd.get('conversationId') || null,
			body: fd.get('body')
		});
		if (!parsed.success || parsed.data.organizationId !== org.id) {
			return fail(400, { error: 'Escribe una nota válida' });
		}
		await addInternalNote(
			{
				organizationId: org.id,
				contactId: parsed.data.contactId,
				conversationId: parsed.data.conversationId ?? null,
				userId: user.id,
				body: parsed.data.body
			},
			locals
		);
		return { ok: true };
	}
};
