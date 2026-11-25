import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { z } from 'zod';
import { listUserOrganizations } from '$lib/server/crm/repository';

const googleIdTokenSchema = z.object({
	credential: z.string().trim().min(20, 'Token de Google inválido'),
	nonce: z.string().trim().min(10, 'Nonce inválido'),
	next: z.string().optional()
});

function resolveSafeNextPath(nextParam?: string | null): string | null {
	if (!nextParam) return null;
	if (nextParam.startsWith('/') && !nextParam.startsWith('//')) {
		return nextParam;
	}
	return null;
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.supabase) {
		return json({ error: 'El inicio de sesión no está disponible en este entorno.' }, { status: 503 });
	}

	let rawBody: unknown;
	try {
		rawBody = await request.json();
	} catch {
		return json({ error: 'Solicitud inválida.' }, { status: 400 });
	}

	const parsed = googleIdTokenSchema.safeParse(rawBody);
	if (!parsed.success) {
		return json(
			{ error: parsed.error.issues[0]?.message ?? 'Datos de Google inválidos' },
			{ status: 400 }
		);
	}

	const { error } = await locals.supabase.auth.signInWithIdToken({
		provider: 'google',
		token: parsed.data.credential,
		nonce: parsed.data.nonce
	});

	if (error) {
		return json(
			{ error: error.message || 'No pudimos validar tu acceso con Google.' },
			{ status: 401 }
		);
	}

	const safeNext = resolveSafeNextPath(parsed.data.next);
	let redirectTo = safeNext ?? '/onboarding';

	if (!safeNext) {
		const { user } = await locals.safeGetSession();
		if (user && locals.authMode === 'supabase') {
			const orgs = await listUserOrganizations(user.id, locals);
			redirectTo = orgs.length > 0 ? `/${orgs[0].slug}/inbox` : '/onboarding';
		}
	}

	return json({ ok: true, redirectTo });
};
