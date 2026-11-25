import { describe, expect, it, vi } from 'vitest';

const repoMocks = vi.hoisted(() => ({
	listUserOrganizations: vi.fn()
}));

vi.mock('$lib/server/crm/repository', () => ({
	listUserOrganizations: repoMocks.listUserOrganizations
}));

import { POST } from '../../../routes/auth/google/+server';

function makeRequest(body: unknown) {
	return new Request('https://app.okeo.ai/auth/google', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
}

describe('POST /auth/google (GIS signInWithIdToken)', () => {
	it('returns 503 when supabase is not configured', async () => {
		const res = await POST({
			request: makeRequest({ credential: 'x'.repeat(25), nonce: 'nonce_123456' }),
			locals: { supabase: null } as unknown as App.Locals
		} as Parameters<typeof POST>[0]);

		expect(res.status).toBe(503);
	});

	it('returns 400 when credential or nonce fails validation', async () => {
		const res = await POST({
			request: makeRequest({ credential: 'short', nonce: 'bad' }),
			locals: { supabase: { auth: {} } } as unknown as App.Locals
		} as Parameters<typeof POST>[0]);

		expect(res.status).toBe(400);
	});

	it('returns 401 when Supabase rejects the ID token', async () => {
		const signInWithIdToken = vi.fn().mockResolvedValue({
			data: null,
			error: { message: 'Invalid token' }
		});

		const res = await POST({
			request: makeRequest({ credential: 't'.repeat(30), nonce: 'valid_nonce_123' }),
			locals: {
				supabase: { auth: { signInWithIdToken } }
			} as unknown as App.Locals
		} as Parameters<typeof POST>[0]);

		expect(res.status).toBe(401);
		expect(signInWithIdToken).toHaveBeenCalledWith({
			provider: 'google',
			token: 't'.repeat(30),
			nonce: 'valid_nonce_123'
		});
	});

	it('returns safe redirectTo and prevents open redirects', async () => {
		const signInWithIdToken = vi.fn().mockResolvedValue({ data: {}, error: null });
		const safeGetSession = vi.fn().mockResolvedValue({
			user: { id: 'user_1', email: 'hola@okeo.ai' }
		});
		repoMocks.listUserOrganizations.mockResolvedValue([{ slug: 'sportika-metepec' }]);

		const withExplicitNext = await POST({
			request: makeRequest({
				credential: 't'.repeat(30),
				nonce: 'valid_nonce_123',
				next: '/invite/abc'
			}),
			locals: {
				supabase: { auth: { signInWithIdToken } },
				safeGetSession,
				authMode: 'supabase'
			} as unknown as App.Locals
		} as Parameters<typeof POST>[0]);

		expect(withExplicitNext.status).toBe(200);
		await expect(withExplicitNext.json()).resolves.toEqual({
			ok: true,
			redirectTo: '/invite/abc'
		});

		const withUnsafeNext = await POST({
			request: makeRequest({
				credential: 't'.repeat(30),
				nonce: 'valid_nonce_123',
				next: '//evil.com'
			}),
			locals: {
				supabase: { auth: { signInWithIdToken } },
				safeGetSession,
				authMode: 'supabase'
			} as unknown as App.Locals
		} as Parameters<typeof POST>[0]);

		expect(withUnsafeNext.status).toBe(200);
		await expect(withUnsafeNext.json()).resolves.toEqual({
			ok: true,
			redirectTo: '/sportika-metepec/inbox'
		});
	});
});
