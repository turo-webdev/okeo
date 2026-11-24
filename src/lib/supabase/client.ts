import { createBrowserClient } from '@supabase/ssr';
import { env } from '$env/dynamic/public';
import type { Database } from '$lib/types/database.types';

export function createSupabaseBrowserClient() {
	const url = env.PUBLIC_SUPABASE_URL?.trim();
	const key = env.PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
	if (!url || !key) return null;
	return createBrowserClient<Database>(url, key);
}
