import { fail } from '@sveltejs/kit';
import type { Actions } from './$types';
import { getChannelProvider } from '$lib/server/channels/zernio';
import { requireMemberForAction } from '$lib/server/crm/actions';
import {
	createInvitation,
	disconnectChannel,
	getChannelById,
	reconnectChannel,
	refreshInvitationToken,
	resolveRoleChangeRequest,
	revokeInvitation,
	updateMemberRole,
	updateWorkspaceInfo
} from '$lib/server/crm/repository';
import { sendTeamInvitationEmail } from '$lib/server/email/invitations';
import {
	inviteMemberSchema,
	updateMemberRoleSchema,
	updateWorkspaceSchema
} from '$lib/validation/schemas';

export const actions: Actions = {
	updateWorkspace: async ({ request, params, locals }) => {
		const { org } = await requireMemberForAction(params.orgSlug, locals, 'admin');
		const fd = await request.formData();
		const parsed = updateWorkspaceSchema.safeParse({
			organizationId: fd.get('organizationId'),
			name: fd.get('name'),
			industry: fd.get('industry'),
			currency: fd.get('currency'),
			language: fd.get('language')
		});
		if (!parsed.success || parsed.data.organizationId !== org.id) {
			return fail(400, { error: 'Revisa los datos del espacio' });
		}
		await updateWorkspaceInfo(parsed.data, locals);
		return { ok: true, action: 'updateWorkspace' };
	},

	reconnectChannel: async ({ request, params, locals }) => {
		const { org } = await requireMemberForAction(params.orgSlug, locals, 'admin');
		const fd = await request.formData();
		const channelId = String(fd.get('channelId') ?? '');
		if (!channelId) return fail(400, { error: 'Canal inválido' });
		await reconnectChannel(org.id, channelId, locals);
		return { ok: true, action: 'reconnectChannel' };
	},

	disconnectChannel: async ({ request, params, locals }) => {
		const { org } = await requireMemberForAction(params.orgSlug, locals, 'admin');
		const fd = await request.formData();
		const channelId = String(fd.get('channelId') ?? '');
		const orgIdField = fd.get('organizationId');
		if (!channelId || (orgIdField !== null && String(orgIdField) !== org.id)) {
			return fail(400, { error: 'Canal inválido' });
		}

		const existing = await getChannelById(org.id, channelId, locals);
		if (!existing) {
			return fail(404, { error: 'Canal no encontrado' });
		}

		try {
			await getChannelProvider().disconnectAccount(existing.external_account_id);
		} catch (err) {
			return fail(502, {
				error:
					err instanceof Error
						? `No se pudo desconectar en Zernio: ${err.message}`
						: 'Error al desconectar el canal en Zernio'
			});
		}

		await disconnectChannel(org.id, channelId, locals);
		return { ok: true, action: 'disconnectChannel' };
	},

	inviteMember: async ({ request, params, locals, url }) => {
		const { user, org } = await requireMemberForAction(params.orgSlug, locals, 'admin');
		const fd = await request.formData();
		const parsed = inviteMemberSchema.safeParse({
			organizationId: fd.get('organizationId'),
			email: fd.get('email'),
			role: fd.get('role') ?? 'agent'
		});
		if (!parsed.success || parsed.data.organizationId !== org.id) {
			return fail(400, { error: parsed.success ? 'Organización inválida' : parsed.error.issues[0]?.message });
		}
		const invitation = await createInvitation(
			{
				organizationId: org.id,
				email: parsed.data.email,
				role: parsed.data.role,
				invitedByUserId: user.id,
				invitedByName: user.full_name
			},
			locals
		);
		const emailDelivery = await sendTeamInvitationEmail({
			toEmail: invitation.email,
			organizationName: org.name,
			invitedByName: user.full_name,
			role: invitation.role,
			inviteUrl: `${url.origin}/invite/${invitation.demo_token}`,
			expiresAt: invitation.expires_at
		});
		return { ok: true, action: 'inviteMember', createdInvitation: invitation, emailDelivery };
	},

	resendInvitation: async ({ request, params, locals, url }) => {
		const { user, org } = await requireMemberForAction(params.orgSlug, locals, 'admin');
		const fd = await request.formData();
		const invitationId = String(fd.get('invitationId') ?? '').trim();
		const orgIdField = String(fd.get('organizationId') ?? org.id).trim();
		if (!invitationId || orgIdField !== org.id) {
			return fail(400, { action: 'resendInvitation', error: 'Invitación inválida' });
		}
		try {
			const refreshed = await refreshInvitationToken(
				{
					organizationId: org.id,
					invitationId,
					invitedByName: user.full_name
				},
				locals
			);
			const emailDelivery = await sendTeamInvitationEmail({
				toEmail: refreshed.email,
				organizationName: org.name,
				invitedByName: user.full_name,
				role: refreshed.role,
				inviteUrl: `${url.origin}/invite/${refreshed.demo_token}`,
				expiresAt: refreshed.expires_at
			});
			return {
				ok: true,
				action: 'resendInvitation',
				createdInvitation: refreshed,
				emailDelivery
			};
		} catch (err) {
			return fail(400, {
				action: 'resendInvitation',
				error: err instanceof Error ? err.message : 'No se pudo reenviar la invitación'
			});
		}
	},

	revokeInvitation: async ({ request, params, locals }) => {
		const { org } = await requireMemberForAction(params.orgSlug, locals, 'admin');
		const fd = await request.formData();
		const invitationId = String(fd.get('invitationId') ?? '');
		if (invitationId) await revokeInvitation(org.id, invitationId, locals);
		return { ok: true, action: 'revokeInvitation' };
	},

	updateRole: async ({ request, params, locals }) => {
		const { org } = await requireMemberForAction(params.orgSlug, locals, 'admin');
		const fd = await request.formData();
		const parsed = updateMemberRoleSchema.safeParse({
			organizationId: fd.get('organizationId'),
			userId: fd.get('userId'),
			role: fd.get('role')
		});
		if (!parsed.success || parsed.data.organizationId !== org.id) {
			return fail(400, { error: 'Rol inválido' });
		}
		try {
			await updateMemberRole(org.id, parsed.data.userId, parsed.data.role, locals);
		} catch (err) {
			return fail(403, {
				error: err instanceof Error ? err.message : 'No tienes permiso para cambiar este rol'
			});
		}
		return { ok: true, action: 'updateRole' };
	},

	resolveRoleRequest: async ({ request, params, locals }) => {
		const { org } = await requireMemberForAction(params.orgSlug, locals, 'admin');
		const fd = await request.formData();
		const requestId = String(fd.get('requestId') ?? '');
		const approve = fd.get('approve') === 'true';
		if (requestId) await resolveRoleChangeRequest(org.id, requestId, approve, locals);
		return { ok: true, action: 'resolveRoleRequest' };
	}
};
