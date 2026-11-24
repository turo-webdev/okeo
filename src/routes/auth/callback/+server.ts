import type { EmailOtpType } from '@supabase/supabase-js';
import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listUserOrganizations } from '$lib/server/crm/repository';

const ALLOWED_OTP_TYPES = new Set<EmailOtpType>([
	'signup',
	'invite',
	'magiclink',
	'recovery',
	'email_change',
	'email'
]);

function resolveSafeNextPath(nextParam: string | null): string | null {
	if (!nextParam) return null;
	if (nextParam.startsWith('/') && !nextParam.startsWith('//')) {
		return nextParam;
	}
	return null;
}

async function redirectAfterAuth(url: URL, locals: App.Locals): Promise<never> {
	const explicitNext = resolveSafeNextPath(url.searchParams.get('next'));
	if (explicitNext) {
		throw redirect(303, explicitNext);
	}
	const { user } = await locals.safeGetSession();
	if (user && locals.authMode === 'supabase') {
		const orgs = await listUserOrganizations(user.id, locals);
		if (orgs.length > 0) {
			throw redirect(303, `/${orgs[0].slug}/inbox`);
		}
	}
	throw redirect(303, '/onboarding');
}

export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.supabase) {
		throw redirect(303, '/login?error=supabase_not_configured');
	}

	const code = url.searchParams.get('code');
	const tokenHash = url.searchParams.get('token_hash');
	const type = url.searchParams.get('type');

	if (code) {
		const { error } = await locals.supabase.auth.exchangeCodeForSession(code);
		if (!error) {
			return redirectAfterAuth(url, locals);
		}
	} else if (tokenHash && type && ALLOWED_OTP_TYPES.has(type as EmailOtpType)) {
		const { error } = await locals.supabase.auth.verifyOtp({
			token_hash: tokenHash,
			type: type as EmailOtpType
		});
		if (!error) {
			return redirectAfterAuth(url, locals);
		}
	}

	throw redirect(303, '/login?error=auth_callback_failed');
};
