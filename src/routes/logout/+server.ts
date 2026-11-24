import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	throw redirect(303, '/login');
};

export const POST: RequestHandler = async ({ locals, cookies }) => {
	if (locals.supabase) {
		await locals.supabase.auth.signOut();
	}
	cookies.delete('okeo_demo_role', { path: '/' });
	throw redirect(303, '/login');
};
