import { error } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { requireOrgMembership } from '$lib/server/crm/repository';
import type { OrgRole, Profile } from '$lib/types/domain';

export async function requireApiSession(event: RequestEvent): Promise<Profile> {
	const { user } = await event.locals.safeGetSession();
	if (!user) {
		throw error(401, 'Sesión requerida');
	}
	return user;
}

export async function parseValidatedBody<T extends z.ZodTypeAny>(
	request: Request,
	schema: T
): Promise<z.infer<T>> {
	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		throw error(400, 'JSON inválido');
	}
	const result = schema.safeParse(raw);
	if (!result.success) {
		throw error(400, result.error.issues[0]?.message ?? 'Datos inválidos');
	}
	return result.data;
}

export async function assertApiOrgMember(
	event: RequestEvent,
	organizationId: string,
	userId: string,
	minRole: OrgRole
) {
	const demoOverride =
		event.locals.authMode === 'supabase' ? undefined : event.locals.demoRole;
	try {
		return await requireOrgMembership(
			organizationId,
			userId,
			minRole,
			demoOverride,
			event.locals
		);
	} catch (err) {
		throw error(403, err instanceof Error ? err.message : 'Sin permisos en este workspace');
	}
}
