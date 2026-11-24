import { afterEach, describe, expect, it, vi } from 'vitest';
import { escapeHtml, sendTeamInvitationEmail } from '../invitations';

const envMocks = vi.hoisted(() => ({
	env: {} as Record<string, string | undefined>
}));

vi.mock('$env/dynamic/private', () => ({
	env: envMocks.env
}));

describe('Team invitation email delivery (Resend)', () => {
	afterEach(() => {
		delete envMocks.env.RESEND_API_KEY;
		delete envMocks.env.EMAIL_FROM;
	});

	it('returns { sent: false, provider: "none" } when RESEND_API_KEY is missing', async () => {
		const res = await sendTeamInvitationEmail({
			toEmail: 'ana@example.com',
			organizationName: 'Sportika',
			invitedByName: 'Arturo',
			role: 'agent',
			inviteUrl: 'https://app.okeo.ai/invite/tok_123',
			expiresAt: '2026-12-01T00:00:00Z'
		});
		expect(res).toEqual({ sent: false, provider: 'none' });
	});

	it('escapes HTML entities and sends authorized payload to Resend REST API', async () => {
		envMocks.env.RESEND_API_KEY = 're_test_key_123';
		envMocks.env.EMAIL_FROM = 'Okeo <hola@okeo.ai>';

		const mockFetch = vi.fn(async () => {
			return new Response(JSON.stringify({ id: 'email_msg_999' }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		});

		const res = await sendTeamInvitationEmail(
			{
				toEmail: 'equipo@example.com',
				organizationName: 'Club <Pro> & Co',
				invitedByName: 'Ana "Admin"',
				role: 'admin',
				inviteUrl: 'https://app.okeo.ai/invite/abc123',
				expiresAt: '2026-12-01T00:00:00Z'
			},
			mockFetch as unknown as typeof fetch
		);

		expect(res).toEqual({ sent: true, provider: 'resend', messageId: 'email_msg_999' });
		expect(mockFetch).toHaveBeenCalledOnce();
		const [url, init] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('https://api.resend.com/emails');
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer re_test_key_123');
		const sentBody = JSON.parse(String(init.body)) as { html: string; text: string; from: string };
		expect(sentBody.from).toBe('Okeo <hola@okeo.ai>');
		expect(sentBody.html).toContain('Club &lt;Pro&gt; &amp; Co');
		expect(sentBody.html).toContain('Ana &quot;Admin&quot;');
		expect(sentBody.text).toContain('https://app.okeo.ai/invite/abc123');
		expect(escapeHtml('<script>"test"</script>')).toBe('&lt;script&gt;&quot;test&quot;&lt;/script&gt;');
	});

	it('returns structured error without throwing when Resend API returns HTTP 422', async () => {
		envMocks.env.RESEND_API_KEY = 're_test_key_123';
		const failFetch = vi.fn(async () => {
			return new Response(JSON.stringify({ message: 'Domain not verified' }), {
				status: 422,
				headers: { 'content-type': 'application/json' }
			});
		});

		const res = await sendTeamInvitationEmail(
			{
				toEmail: 'equipo@example.com',
				organizationName: 'Sportika',
				invitedByName: 'Arturo',
				role: 'viewer',
				inviteUrl: 'https://app.okeo.ai/invite/abc123',
				expiresAt: '2026-12-01T00:00:00Z'
			},
			failFetch as unknown as typeof fetch
		);

		expect(res).toEqual({
			sent: false,
			provider: 'resend',
			error: 'Domain not verified'
		});
	});
});
