export interface DomainContext {
	appOrigin: string | null;
	marketingOrigin: string | null;
	dualDomainActive: boolean;
	isAppHost: boolean;
	isMarketingHost: boolean;
	isWwwMarketingHost: boolean;
	appOriginPrefix: string;
	marketingHomeUrl: string;
}

export interface DomainRedirect {
	status: 301 | 302 | 307;
	location: string;
}

const APP_ONLY_EXACT_OR_SUBPATH_PREFIXES = [
	'/login',
	'/signup',
	'/onboarding',
	'/logout',
	'/auth/callback',
	'/invite'
] as const;

const WORKSPACE_APP_ROUTE_RE = /^\/[^/]+\/(inbox|pipeline|contacts|ai|dashboard|settings)(\/|$)/;

/**
 * Normalizes an origin URL string (`http:` or `https:`), stripping paths/trailing slashes.
 */
export function normalizeOrigin(raw?: string | null): string | null {
	const trimmed = raw?.trim();
	if (!trimmed) return null;
	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			return null;
		}
		return parsed.origin;
	} catch {
		return null;
	}
}

/**
 * Resolves dual-domain host context (`okeo.ai` marketing vs `app.okeo.ai` app) for a request URL.
 */
export function resolveDomainContext(
	url: URL,
	env: Record<string, string | undefined>
): DomainContext {
	const appOrigin = normalizeOrigin(env.PUBLIC_APP_ORIGIN);
	const marketingOrigin = normalizeOrigin(env.PUBLIC_MARKETING_ORIGIN);
	const dualDomainActive = Boolean(appOrigin && marketingOrigin && appOrigin !== marketingOrigin);

	const isAppHost = dualDomainActive && url.origin === appOrigin;
	const isMarketingHost = dualDomainActive && url.origin === marketingOrigin;

	let isWwwMarketingHost = false;
	if (marketingOrigin) {
		try {
			const marketingHostname = new URL(marketingOrigin).hostname.toLowerCase();
			isWwwMarketingHost = url.hostname.toLowerCase() === `www.${marketingHostname}`;
		} catch {
			isWwwMarketingHost = false;
		}
	}

	return {
		appOrigin,
		marketingOrigin,
		dualDomainActive,
		isAppHost,
		isMarketingHost,
		isWwwMarketingHost,
		appOriginPrefix: isMarketingHost && appOrigin ? appOrigin : '',
		marketingHomeUrl: isAppHost && marketingOrigin ? marketingOrigin : '/'
	};
}

/**
 * Identifies routes belonging exclusively to the CRM app (`app.okeo.ai`),
 * leaving `/`, `/blog`, `/precios`, `/<industry-landing>`, and `/api/*` untouched on marketing.
 */
export function isAppOnlyPath(pathname: string): boolean {
	if (
		pathname === '/' ||
		pathname === '/api' ||
		pathname.startsWith('/api/') ||
		pathname.startsWith('/_app/') ||
		pathname === '/robots.txt' ||
		pathname === '/sitemap.xml'
	) {
		return false;
	}

	for (const prefix of APP_ONLY_EXACT_OR_SUBPATH_PREFIXES) {
		if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
			return true;
		}
	}

	return WORKSPACE_APP_ROUTE_RE.test(pathname);
}

/**
 * Computes canonical/domain redirect if the request arrived on `www` or hit an app route on the marketing host.
 * Returns `null` for localhost, `127.0.0.1`, `*.workers.dev`, and when dual-domain env vars are unset.
 */
export function resolveDomainRedirect(
	url: URL,
	method: string,
	env: Record<string, string | undefined>
): DomainRedirect | null {
	const ctx = resolveDomainContext(url, env);

	if (ctx.isWwwMarketingHost && ctx.marketingOrigin) {
		return {
			status: 301,
			location: `${ctx.marketingOrigin}${url.pathname}${url.search}`
		};
	}

	if (ctx.isMarketingHost && ctx.appOrigin && isAppOnlyPath(url.pathname)) {
		const status = method === 'GET' || method === 'HEAD' ? 302 : 307;
		return {
			status,
			location: `${ctx.appOrigin}${url.pathname}${url.search}`
		};
	}

	return null;
}
