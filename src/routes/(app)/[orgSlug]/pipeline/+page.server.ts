import { fail } from '@sveltejs/kit';
import type { Actions } from './$types';
import { requireMemberForAction } from '$lib/server/crm/actions';
import {
	addInternalNote,
	createDeal,
	updateDeal
} from '$lib/server/crm/repository';
import { createDealSchema, saveNoteSchema, updateDealSchema } from '$lib/validation/schemas';

export const actions: Actions = {
	createDeal: async ({ request, params, locals }) => {
		const { org } = await requireMemberForAction(params.orgSlug, locals, 'agent');
		const fd = await request.formData();
		const parsed = createDealSchema.safeParse({
			organizationId: fd.get('organizationId'),
			title: fd.get('title'),
			contactId: fd.get('contactId'),
			stageId: fd.get('stageId'),
			dealType: fd.get('dealType') || 'Servicio',
			valueAmount: fd.get('valueAmount'),
			ownerUserId: fd.get('ownerUserId') || null
		});
		if (!parsed.success || parsed.data.organizationId !== org.id) {
			return fail(400, {
				error: parsed.success ? 'Organización inválida' : parsed.error.issues[0]?.message
			});
		}
		const deal = await createDeal(
			{
				...parsed.data,
				ownerUserId: parsed.data.ownerUserId ?? null
			},
			locals
		);
		return { ok: true, deal };
	},

	updateDeal: async ({ request, params, locals }) => {
		const { org } = await requireMemberForAction(params.orgSlug, locals, 'agent');
		const fd = await request.formData();
		const parsed = updateDealSchema.safeParse({
			organizationId: fd.get('organizationId'),
			dealId: fd.get('dealId'),
			stageId: fd.get('stageId') || undefined,
			contactId: fd.get('contactId') || undefined,
			dealType: fd.get('dealType') || undefined,
			ownerUserId:
				fd.get('ownerUserId') === null
					? undefined
					: fd.get('ownerUserId') === ''
						? null
						: String(fd.get('ownerUserId')),
			nextStepTitle:
				fd.get('nextStepTitle') !== null ? String(fd.get('nextStepTitle')) : undefined,
			nextStepLabel:
				fd.get('nextStepLabel') !== null ? String(fd.get('nextStepLabel')) : undefined
		});
		if (!parsed.success || parsed.data.organizationId !== org.id) {
			return fail(400, { error: 'No se pudo actualizar la oportunidad' });
		}
		await updateDeal(parsed.data, locals);
		return { ok: true };
	},

	saveNote: async ({ request, params, locals }) => {
		const { user, org } = await requireMemberForAction(params.orgSlug, locals, 'agent');
		const fd = await request.formData();
		const parsed = saveNoteSchema.safeParse({
			organizationId: fd.get('organizationId'),
			contactId: fd.get('contactId'),
			conversationId: null,
			body: fd.get('body')
		});
		if (!parsed.success || parsed.data.organizationId !== org.id) {
			return fail(400, { error: 'Nota inválida' });
		}
		await addInternalNote(
			{
				organizationId: org.id,
				contactId: parsed.data.contactId,
				conversationId: null,
				userId: user.id,
				body: parsed.data.body
			},
			locals
		);
		return { ok: true };
	}
};
