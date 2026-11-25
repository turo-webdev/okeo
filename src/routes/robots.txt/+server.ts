import { env as publicEnv } from '$env/dynamic/public';
import { resolveDomainContext } from '$lib/server/domains';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const domainCtx = resolveDomainContext(url, publicEnv);
	const body = domainCtx.isAppHost
		? 'User-agent: *\nDisallow: /\n'
		: [
				'User-agent: *',
				'Allow: /',
				'Disallow: /api/',
				'Disallow: /auth/',
				'Disallow: /login',
				'Disallow: /signup',
				'Disallow: /onboarding',
				'Disallow: /invite/',
				''
			].join('\n');

	return new Response(body, {
		headers: {
			'Content-Type': 'text/plain; charset=utf-8',
			'Cache-Control': 'public, max-age=3600'
		}
	});
};
