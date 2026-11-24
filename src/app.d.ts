import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '$lib/types/database.types';
import type { OrgRole, Profile } from '$lib/types/domain';

declare global {
	namespace App {
		interface Locals {
			supabase: SupabaseClient<Database> | null;
			authMode: 'supabase' | 'demo';
			sessionUser: Profile | null;
			demoRole: OrgRole;
			requestCache: Map<string, Promise<unknown>>;
			safeGetAuth: () => Promise<{ userId: string; email: string; authMode: 'supabase' | 'demo' }>;
			safeGetSession: () => Promise<{ user: Profile | null }>;
		}
		interface Platform {
			env?: {
				AI_JOBS?: {
					send(body: unknown, options?: { delaySeconds?: number }): Promise<void>;
				};
				QUEUE_INTERNAL_SECRET?: string;
				OAUTH_STATE_SECRET?: string;
			};
			context?: {
				waitUntil(promise: Promise<unknown>): void;
			};
		}
	}
}

export {};
