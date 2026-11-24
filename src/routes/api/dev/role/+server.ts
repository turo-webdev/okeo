import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { parseValidatedBody } from '$lib/server/auth';

const devRoleSchema = z.object({
	role: z.enum(['owner', 'admin', 'agent', 'viewer'])
});

export const POST: RequestHandler = async ({ request, cookies, locals }) => {
	await locals.safeGetSession();
	if (locals.authMode === 'supabase') {
		return json({ error: 'No disponible en sesiones reales' }, { status: 403 });
	}

	const body = await parseValidatedBody(request, devRoleSchema);
	cookies.set('okeo_demo_role', body.role, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		maxAge: 60 * 60 * 24 * 7
	});
	return json({ ok: true, role: body.role });
};
