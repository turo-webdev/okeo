import { fail } from '@sveltejs/kit';
import type { Actions } from './$types';
import { requireMemberForAction } from '$lib/server/crm/actions';
import { deliverManualMessage } from '$lib/server/crm/outbound';
import {
	addInternalNote,
	createRoleChangeRequest,
	getContactById,
	updateContact,
	updateConversationState,
	updateDeal
} from '$lib/server/crm/repository';
import {
	messageAttachmentSchema,
	requestRoleChangeSchema,
	saveNoteSchema,
	sendMessageSchema,
	updateConversationSchema
} from '$lib/validation/schemas';

export const actions: Actions = {
	sendMessage: async ({ request, params, locals }) => {
		const { user, org } = await requireMemberForAction(params.orgSlug, locals, 'agent');
		const fd = await request.formData();

		let parsedAttachment: ReturnType<typeof messageAttachmentSchema.safeParse>['data'] | undefined;
		const rawAtt = fd.get('attachmentJson');
		if (typeof rawAtt === 'string' && rawAtt.trim()) {
			try {
				const attResult = messageAttachmentSchema.safeParse(JSON.parse(rawAtt));
				if (attResult.success) parsedAttachment = attResult.data;
			} catch {
				return fail(400, { error: 'Adjunto inválido' });
			}
		}

		const parsed = sendMessageSchema.safeParse({
			organizationId: fd.get('organizationId'),
			conversationId: fd.get('conversationId'),
			body: fd.get('body') ?? '',
			retryMessageId: fd.get('retryMessageId') || undefined,
			attachment: parsedAttachment
		});
		if (!parsed.success || parsed.data.organizationId !== org.id) {
			return fail(400, {
				error: parsed.success ? 'Organización inválida' : parsed.error.issues[0]?.message
			});
		}
		try {
			await deliverManualMessage(
				{
					organizationId: org.id,
					conversationId: parsed.data.conversationId,
					userId: user.id,
					body: parsed.data.body,
					retryMessageId: parsed.data.retryMessageId,
					attachment: parsed.data.attachment
				},
				locals
			);
			return { ok: true, action: 'sendMessage' };
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : 'No se pudo enviar' });
		}
	},

	saveNote: async ({ request, params, locals }) => {
		const { user, org } = await requireMemberForAction(params.orgSlug, locals, 'agent');
		const fd = await request.formData();
		const parsed = saveNoteSchema.safeParse({
			organizationId: fd.get('organizationId'),
			contactId: fd.get('contactId'),
			conversationId: fd.get('conversationId') || null,
			body: fd.get('body')
		});
		if (!parsed.success || parsed.data.organizationId !== org.id) {
			return fail(400, { error: 'Nota inválida' });
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
		return { ok: true, action: 'saveNote' };
	},

	updateConversation: async ({ request, params, locals }) => {
		const { org } = await requireMemberForAction(params.orgSlug, locals, 'agent');
		const fd = await request.formData();
		const rawAssigned = fd.get('assignedTo');
		const rawAiPaused = fd.get('aiPaused');
		const rawStatus = fd.get('status');

		const parsed = updateConversationSchema.safeParse({
			organizationId: fd.get('organizationId'),
			conversationId: fd.get('conversationId'),
			assignedTo:
				rawAssigned === null ? undefined : rawAssigned === '' ? null : String(rawAssigned),
			status: rawStatus ? String(rawStatus) : undefined,
			aiPaused: rawAiPaused === null ? undefined : rawAiPaused === 'true'
		});
		if (!parsed.success || parsed.data.organizationId !== org.id) {
			return fail(400, { error: 'Actualización inválida' });
		}
		await updateConversationState(parsed.data, locals);
		return { ok: true, action: 'updateConversation' };
	},

	updateDealStage: async ({ request, params, locals }) => {
		const { org } = await requireMemberForAction(params.orgSlug, locals, 'agent');
		const fd = await request.formData();
		const dealId = String(fd.get('dealId') ?? '');
		const stageId = String(fd.get('stageId') ?? '');
		if (!dealId || !stageId) return fail(400, { error: 'Datos incompletos' });
		await updateDeal({ organizationId: org.id, dealId, stageId }, locals);
		return { ok: true, action: 'updateDealStage' };
	},

	updateClientMeta: async ({ request, params, locals }) => {
		const { org } = await requireMemberForAction(params.orgSlug, locals, 'agent');
		const fd = await request.formData();
		const contactId = String(fd.get('contactId') ?? '');
		const existing = await getContactById(org.id, contactId, locals);
		if (!existing) return fail(404, { error: 'Contacto no encontrado' });

		const ownerVal = fd.get('ownerUserId');
		const nextTitle = fd.get('nextStepTitle');
		const nextAt = fd.get('nextStepAtLabel');

		await updateContact(
			{
				organizationId: org.id,
				contactId: existing.id,
				name: existing.name,
				company: existing.company ?? '',
				roleTitle: existing.role_title ?? '',
				email: existing.email ?? '',
				phone: existing.phone ?? '',
				ownerUserId:
					ownerVal !== null
						? ownerVal === ''
							? null
							: String(ownerVal)
						: existing.owner_user_id,
				nextStepTitle:
					nextTitle !== null ? String(nextTitle) : existing.next_step_title ?? '',
				nextStepAtLabel:
					nextAt !== null ? String(nextAt) : existing.next_step_at_label ?? ''
			},
			locals
		);
		return { ok: true, action: 'updateClientMeta' };
	},

	requestAccess: async ({ request, params, locals }) => {
		const { user, org } = await requireMemberForAction(params.orgSlug, locals, 'viewer');
		const fd = await request.formData();
		const parsed = requestRoleChangeSchema.safeParse({
			organizationId: fd.get('organizationId'),
			requestedRole: fd.get('requestedRole') ?? 'agent'
		});
		if (!parsed.success || parsed.data.organizationId !== org.id) {
			return fail(400, { error: 'Solicitud inválida' });
		}
		await createRoleChangeRequest(
			{
				organizationId: org.id,
				userId: user.id,
				requestedRole: parsed.data.requestedRole
			},
			locals
		);
		return { ok: true, action: 'requestAccess', requested: true };
	}
};
