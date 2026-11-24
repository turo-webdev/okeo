import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env as privateEnv } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import type { Database } from '$lib/types/database.types';

export function isSupabaseConfigured(): boolean {
	return Boolean(
		publicEnv.PUBLIC_SUPABASE_URL?.trim() &&
			publicEnv.PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim()
	);
}

export function isSupabaseAdminConfigured(): boolean {
	return Boolean(isSupabaseConfigured() && privateEnv.SUPABASE_SERVICE_ROLE_KEY?.trim());
}

/**
 * Cliente Supabase privilegiado (solo servidor: webhooks, Storage Signed URLs y workers).
 * Nunca importar ni exponer SUPABASE_SERVICE_ROLE_KEY en cliente o variables PUBLIC_* (AGENTS.md §2).
 */
export function getSupabaseAdminClient(): SupabaseClient<Database> | null {
	const url = publicEnv.PUBLIC_SUPABASE_URL?.trim();
	const serviceKey = privateEnv.SUPABASE_SERVICE_ROLE_KEY?.trim();
	if (!url || !serviceKey) return null;

	return createClient<Database>(url, serviceKey, {
		auth: {
			persistSession: false,
			autoRefreshToken: false
		}
	});
}
