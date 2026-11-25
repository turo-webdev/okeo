import { describe, expect, it } from 'vitest';
import {
	isAppOnlyPath,
	normalizeOrigin,
	resolveDomainContext,
	resolveDomainRedirect
} from '$lib/server/domains';

const PROD_ENV = {
	PUBLIC_APP_ORIGIN: 'https://app.okeo.ai',
	PUBLIC_MARKETING_ORIGIN: 'https://okeo.ai'
};

describe('domains helper', () => {
	it('normalizes valid http/https origins and rejects invalid values', () => {
		expect(normalizeOrigin('https://app.okeo.ai/')).toBe('https://app.okeo.ai');
		expect(normalizeOrigin('http://127.0.0.1:5173/inbox')).toBe('http://127.0.0.1:5173');
		expect(normalizeOrigin('   ')).toBeNull();
		expect(normalizeOrigin('ftp://okeo.ai')).toBeNull();
		expect(normalizeOrigin('not a url')).toBeNull();
	});

	it('stays neutral on localhost, 127.0.0.1, and workers.dev even when prod env is configured', () => {
		for (const origin of [
			'http://localhost:5173',
			'http://127.0.0.1:5173',
			'https://okeo.demo.workers.dev'
		]) {
			const url = new URL(`${origin}/wunderside/inbox?tab=open`);
			const ctx = resolveDomainContext(url, PROD_ENV);
			expect(ctx.isAppHost).toBe(false);
			expect(ctx.isMarketingHost).toBe(false);
			expect(ctx.appOriginPrefix).toBe('');
			expect(ctx.marketingHomeUrl).toBe('/');
			expect(resolveDomainRedirect(url, 'GET', PROD_ENV)).toBeNull();
		}
	});

	it('is a safe no-op when dual-domain env vars are unset', () => {
		const url = new URL('https://okeo.ai/login');
		const ctx = resolveDomainContext(url, {});
		expect(ctx.dualDomainActive).toBe(false);
		expect(ctx.isAppHost).toBe(false);
		expect(ctx.isMarketingHost).toBe(false);
		expect(ctx.appOriginPrefix).toBe('');
		expect(ctx.marketingHomeUrl).toBe('/');
		expect(resolveDomainRedirect(url, 'GET', {})).toBeNull();
	});

	it('redirects www.okeo.ai permanently (301) to canonical https://okeo.ai', () => {
		const url = new URL('https://www.okeo.ai/blog/guia?ref=ig');
		expect(resolveDomainRedirect(url, 'GET', PROD_ENV)).toEqual({
			status: 301,
			location: 'https://okeo.ai/blog/guia?ref=ig'
		});
	});

	it('keeps marketing pages, blog, and industry landings on okeo.ai without redirecting', () => {
		for (const path of ['/', '/blog', '/blog/whatsapp-crm', '/clinica-dental', '/precios']) {
			const url = new URL(`https://okeo.ai${path}`);
			const ctx = resolveDomainContext(url, PROD_ENV);
			expect(ctx.isMarketingHost).toBe(true);
			expect(ctx.isAppHost).toBe(false);
			expect(ctx.appOriginPrefix).toBe('https://app.okeo.ai');
			expect(isAppOnlyPath(url.pathname)).toBe(false);
			expect(resolveDomainRedirect(url, 'GET', PROD_ENV)).toBeNull();
		}
	});

	it('redirects app and auth routes on okeo.ai to app.okeo.ai with 302 (GET) or 307 (POST)', () => {
		const getPaths = [
			'/login',
			'/signup',
			'/onboarding',
			'/invite/tok123',
			'/auth/callback?code=1',
			'/sportika-metepec/inbox?tab=open',
			'/sportika-metepec/settings/billing'
		];

		for (const path of getPaths) {
			const url = new URL(`https://okeo.ai${path}`);
			expect(resolveDomainRedirect(url, 'GET', PROD_ENV)).toEqual({
				status: 302,
				location: `https://app.okeo.ai${path}`
			});
		}

		expect(resolveDomainRedirect(new URL('https://okeo.ai/login'), 'POST', PROD_ENV)).toEqual({
			status: 307,
			location: 'https://app.okeo.ai/login'
		});
	});

	it('leaves /api/* routes untouched on okeo.ai', () => {
		expect(
			resolveDomainRedirect(new URL('https://okeo.ai/api/webhooks/stripe'), 'POST', PROD_ENV)
		).toBeNull();
	});

	it('recognizes app.okeo.ai as app host and links home back to https://okeo.ai', () => {
		for (const path of ['/', '/clinica-dental/inbox']) {
			const url = new URL(`https://app.okeo.ai${path}`);
			const ctx = resolveDomainContext(url, PROD_ENV);
			expect(ctx.isAppHost).toBe(true);
			expect(ctx.isMarketingHost).toBe(false);
			expect(ctx.marketingHomeUrl).toBe('https://okeo.ai');
			expect(ctx.appOriginPrefix).toBe('');
			expect(resolveDomainRedirect(url, 'GET', PROD_ENV)).toBeNull();
		}
	});
});
