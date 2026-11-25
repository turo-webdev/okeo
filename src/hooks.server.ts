import { createServerClient } from '@supabase/ssr';
import { env as publicEnv } from '$env/dynamic/public';
import type { Handle } from '@sveltejs/kit';
import { getDemoUser } from '$lib/server/crm/repository';
import { resolveDomainContext, resolveDomainRedirect } from '$lib/server/domains';
import type { Database } from '$lib/types/database.types';
import type { OrgRole, Profile } from '$lib/types/domain';

const VALID_ROLES = new Set<OrgRole>(['owner', 'admin', 'agent', 'viewer']);

function computeInitials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	if (parts.length >= 2) {
		return (parts[0][0] + parts[1][0]).toUpperCase();
	}
	return (parts[0]?.slice(0, 2) ?? 'OK').toUpperCase();
}

export const handle: Handle = async ({ event, resolve }) => {
	const domainRedirect = resolveDomainRedirect(event.url, event.request.method, publicEnv);
	if (domainRedirect) {
		return new Response(null, {
			status: domainRedirect.status,
			headers: { Location: domainRedirect.location }
		});
	}
	const domainCtx = resolveDomainContext(event.url, publicEnv);

	const roleCookie = event.cookies.get('okeo_demo_role') as OrgRole | undefined;
	const demoRole: OrgRole = roleCookie && VALID_ROLES.has(roleCookie) ? roleCookie : 'owner';

	const supabaseUrl = publicEnv.PUBLIC_SUPABASE_URL?.trim();
	const publishableKey = publicEnv.PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();

	const isHttps = event.url.protocol === 'https:';

	event.locals.supabase =
		supabaseUrl && publishableKey
			? createServerClient<Database>(supabaseUrl, publishableKey, {
					cookies: {
						getAll: () => event.cookies.getAll(),
						setAll: (cookiesToSet, headers) => {
							try {
								for (const { name, value, options } of cookiesToSet) {
									event.cookies.set(name, value, { ...options, path: '/', secure: isHttps });
								}
							} catch {
								// Ignorar cuando @supabase/ssr dispara refresh después de generada la respuesta
							}
							if (headers && Object.keys(headers).length > 0) {
								try {
									event.setHeaders(headers);
								} catch {
									// Headers may already be set in the same request lifecycle
								}
							}
						}
					}
				})
			: null;

	event.locals.demoRole = demoRole;
	event.locals.authMode = 'demo';
	event.locals.sessionUser = null;
	event.locals.requestCache = new Map();

	let authPromise: Promise<{ userId: string; email: string; authMode: 'supabase' | 'demo' }> | null = null;
	let sessionPromise: Promise<{ user: Profile | null }> | null = null;

	event.locals.safeGetAuth = async () => {
		if (authPromise) return authPromise;

		authPromise = (async () => {
			const hasAuthCookie = event.cookies.getAll().some((c) => c.name.startsWith('sb-'));
			if (event.locals.supabase && hasAuthCookie) {
				// Validación criptográfica local del JWT (ES256 JWKS cacheado); nunca usar user_metadata para authz (AGENTS.md §2).
				const { data: claimsData, error } = await event.locals.supabase.auth.getClaims();
				const sub = claimsData?.claims?.sub;
				if (!error && typeof sub === 'string' && sub.length > 0) {
					const email =
						typeof claimsData?.claims?.email === 'string' ? claimsData.claims.email : '';
					event.locals.authMode = 'supabase';
					return { userId: sub, email, authMode: 'supabase' as const };
				}
			}

			const demoUser = getDemoUser();
			event.locals.authMode = 'demo';
			return { userId: demoUser.id, email: demoUser.email, authMode: 'demo' as const };
		})();

		return authPromise;
	};

	event.locals.safeGetSession = async () => {
		if (sessionPromise) return sessionPromise;

		sessionPromise = (async () => {
			const auth = await event.locals.safeGetAuth();

			if (auth.authMode === 'supabase' && event.locals.supabase) {
				const { data: profileRow } = await event.locals.supabase
					.from('profiles')
					.select('id, full_name, avatar_url, email, created_at, updated_at')
					.eq('id', auth.userId)
					.maybeSingle();

				const fallbackEmail = auth.email;
				const fullName =
					profileRow?.full_name?.trim() || fallbackEmail.split('@')[0] || 'Usuario';
				const nowIso = new Date().toISOString();

				const profile: Profile = {
					id: auth.userId,
					full_name: fullName,
					initials: computeInitials(fullName),
					avatar_url: profileRow?.avatar_url ?? null,
					email: profileRow?.email ?? fallbackEmail,
					created_at: profileRow?.created_at ?? nowIso,
					updated_at: profileRow?.updated_at ?? nowIso
				};

				event.locals.sessionUser = profile;
				return { user: profile };
			}

			// Fallback local para exploración del workspace demo mientras no exista sesión Auth activa
			const demoUser = getDemoUser();
			event.locals.authMode = 'demo';
			event.locals.sessionUser = demoUser;
			return { user: demoUser };
		})();

		return sessionPromise;
	};

	const response = await resolve(event, {
		filterSerializedResponseHeaders(name) {
			return name === 'content-range' || name === 'x-supabase-api-version';
		}
	});

	if (domainCtx.isAppHost) {
		try {
			response.headers.set('X-Robots-Tag', 'noindex, nofollow');
		} catch {
			const headers = new Headers(response.headers);
			headers.set('X-Robots-Tag', 'noindex, nofollow');
			return new Response(response.body, {
				status: response.status,
				statusText: response.statusText,
				headers
			});
		}
	}

	return response;
};
