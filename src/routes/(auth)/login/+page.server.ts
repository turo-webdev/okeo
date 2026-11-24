import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { z } from 'zod';
import { listUserOrganizations } from '$lib/server/crm/repository';
import { isSupabaseConfigured } from '$lib/server/supabase-admin';

const magicLinkSchema = z.object({
	email: z.string().trim().email('Escribe un correo válido')
});

function resolveSafeNextPath(nextParam: string | null): string | null {
	if (!nextParam) return null;
	if (nextParam.startsWith('/') && !nextParam.startsWith('//')) {
		return nextParam;
	}
	return null;
}

function buildCallbackUrl(url: URL, nextRaw: FormDataEntryValue | string | null): string {
	const safeNext = resolveSafeNextPath(typeof nextRaw === 'string' ? nextRaw : null);
	if (safeNext) {
		return `${url.origin}/auth/callback?next=${encodeURIComponent(safeNext)}`;
	}
	return `${url.origin}/auth/callback`;
}

export const load: PageServerLoad = async ({ url, locals }) => {
	const supabaseConfigured = isSupabaseConfigured();
	const nextPath = resolveSafeNextPath(url.searchParams.get('next')) ?? '';
	if (supabaseConfigured && locals.supabase) {
		const { user } = await locals.safeGetSession();
		if (locals.authMode === 'supabase' && user) {
			if (nextPath) {
				throw redirect(303, nextPath);
			}
			const orgs = await listUserOrganizations(user.id, locals);
			throw redirect(303, orgs.length > 0 ? `/${orgs[0].slug}/inbox` : '/onboarding');
		}
	}
	return {
		supabaseConfigured,
		nextPath,
		authError: url.searchParams.get('error') ?? ''
	};
};

export const actions: Actions = {
	magicLink: async ({ request, locals, url }) => {
		const fd = await request.formData();
		const parsed = magicLinkSchema.safeParse({ email: fd.get('email') });
		if (!parsed.success) {
			return fail(400, { error: parsed.error.issues[0]?.message ?? 'Correo inválido' });
		}

		const emailRedirectTo = buildCallbackUrl(url, fd.get('next') ?? url.searchParams.get('next'));

		if (locals.supabase) {
			const { error } = await locals.supabase.auth.signInWithOtp({
				email: parsed.data.email,
				options: {
					emailRedirectTo
				}
			});
			if (error) {
				return fail(400, {
					error: error.message || 'No pudimos enviar el enlace de acceso.'
				});
			}
			return { sent: true, email: parsed.data.email, liveAuth: true };
		}

		return { sent: true, email: parsed.data.email, liveAuth: false };
	},

	googleOAuth: async ({ request, locals, url }) => {
		if (!locals.supabase) {
			throw redirect(303, '/wunderside/inbox');
		}
		const fd = await request.formData();
		const redirectTo = buildCallbackUrl(url, fd.get('next') ?? url.searchParams.get('next'));
		const { data, error } = await locals.supabase.auth.signInWithOAuth({
			provider: 'google',
			options: {
				redirectTo
			}
		});
		if (error || !data?.url) {
			return fail(400, {
				error: error?.message ?? 'No se pudo iniciar el acceso con Google.'
			});
		}
		throw redirect(303, data.url);
	},

	googleDemo: async () => {
		throw redirect(303, '/wunderside/inbox');
	}
};
