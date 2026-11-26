import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getChannelConnectOptions } from '../config';
import {
	cancelChannelConnectSession,
	claimConnectSessionForCompletion,
	clearMemoryConnectSessionsForTests,
	completeChannelConnectSession,
	createChannelConnectSession,
	decryptProviderPayload,
	encryptProviderPayload,
	failChannelConnectSession,
	generateConnectSessionId,
	getChannelConnectSession,
	isConnectSessionExpired,
	parseHeadlessUserProfile,
	revertConnectSessionToPendingSelection,
	transitionSessionToPendingSelection
} from '../connect-sessions';
import { MockChannelProvider } from '../mock';

afterEach(() => {
	clearMemoryConnectSessionsForTests();
});

describe('AES-256-GCM connect payload encryption', () => {
	const secret = 'super-secret-oauth-key-for-tests-123';

	it('round-trips temporary provider credentials with unique IVs', async () => {
		const payload = {
			tempToken: 'fb_temp_token_secret_xyz',
			connectToken: 'conn_tok_abc',
			scopes: 'messaging,posting',
			userProfile: {
				id: 'fb_usr_1',
				name: 'Arturo Méndez',
				profilePicture: 'https://graph.facebook.com/avatar.jpg'
			}
		};

		const tokenA = await encryptProviderPayload(payload, secret);
		const tokenB = await encryptProviderPayload(payload, secret);
		expect(tokenA).not.toBe(tokenB);
		expect(tokenA.startsWith('v1.')).toBe(true);

		const decrypted = await decryptProviderPayload(tokenA, secret);
		expect(decrypted).toEqual(payload);
	});

	it('rejects tampered tokens and wrong secrets', async () => {
		const token = await encryptProviderPayload({ tempToken: 'temp_123' }, secret);
		expect(await decryptProviderPayload(token, 'wrong-secret')).toBeNull();

		const parts = token.split('.');
		const tamperedCipher = `${parts[2].slice(0, -2)}AA`;
		expect(
			await decryptProviderPayload(`${parts[0]}.${parts[1]}.${tamperedCipher}`, secret)
		).toBeNull();
		expect(await decryptProviderPayload('invalid-format', secret)).toBeNull();
	});
});

describe('Headless userProfile decoding & redirect URL budget', () => {
	it('parses double-encoded, single-encoded, and raw JSON userProfile safely', () => {
		const expected = {
			id: '10159999',
			name: 'María Pérez',
			profilePicture: 'https://cdn.example.com/p.jpg'
		};
		const once = encodeURIComponent(JSON.stringify(expected));
		// URLSearchParams decodes once on the server; Zernio double-encodes on the wire.
		expect(parseHeadlessUserProfile(once)).toEqual(expected);
		expect(parseHeadlessUserProfile(encodeURIComponent(once))).toEqual(expected);
		expect(parseHeadlessUserProfile(JSON.stringify(expected))).toEqual(expected);
		expect(parseHeadlessUserProfile('not-json%ZZ')).toEqual({});
		expect(parseHeadlessUserProfile(null)).toEqual({});
	});

	it('keeps headless redirect_url well under Zernio 165-char limit', () => {
		const sid = generateConnectSessionId();
		const redirectUrl = `https://app.okeo.ai/api/channels/connect/callback?sid=${encodeURIComponent(sid)}`;
		expect(sid.startsWith('cs_')).toBe(true);
		expect(redirectUrl.length).toBeLessThan(120);
	});
});

describe('Channel connect session state machine & anti-replay', () => {
	const secret = 'session-state-secret-test';

	it('enforces initiated -> pending_selection -> completing -> completed and wipes tokens', async () => {
		const session = await createChannelConnectSession({
			organizationId: 'org_wunderside',
			userId: 'usr_arturo',
			platform: 'facebook'
		});
		expect(session.status).toBe('initiated');
		expect(isConnectSessionExpired(session)).toBe(false);

		const encrypted = await encryptProviderPayload(
			{ tempToken: 'temp_abc', userProfile: { id: 'u1', name: 'Arturo' } },
			secret
		);
		const pending = await transitionSessionToPendingSelection({
			sessionId: session.id,
			encryptedProviderPayload: encrypted
		});
		expect(pending?.status).toBe('pending_selection');
		expect(pending?.encryptedProviderPayload).toBe(encrypted);

		// Replaying initiated -> pending_selection must fail
		expect(
			await transitionSessionToPendingSelection({
				sessionId: session.id,
				encryptedProviderPayload: encrypted
			})
		).toBeNull();

		const claimed = await claimConnectSessionForCompletion({
			sessionId: session.id,
			expectedStatus: 'pending_selection'
		});
		expect(claimed?.status).toBe('completing');

		// Concurrent double-submit claim must fail
		expect(
			await claimConnectSessionForCompletion({
				sessionId: session.id,
				expectedStatus: 'pending_selection'
			})
		).toBeNull();

		const completed = await completeChannelConnectSession({
			sessionId: session.id,
			connectedChannelId: 'ch_new_fb'
		});
		expect(completed?.status).toBe('completed');
		expect(completed?.connectedChannelId).toBe('ch_new_fb');
		expect(completed?.encryptedProviderPayload).toBeNull();

		const fetched = await getChannelConnectSession(session.id);
		expect(fetched?.encryptedProviderPayload).toBeNull();
	});

	it('allows rollback from completing on transient error and wipes payload on cancel/fail', async () => {
		const session = await createChannelConnectSession({
			organizationId: 'org_wunderside',
			userId: 'usr_arturo',
			platform: 'facebook'
		});
		const encrypted = await encryptProviderPayload({ tempToken: 'temp_xyz' }, secret);
		await transitionSessionToPendingSelection({
			sessionId: session.id,
			encryptedProviderPayload: encrypted
		});

		await claimConnectSessionForCompletion({
			sessionId: session.id,
			expectedStatus: 'pending_selection'
		});
		await revertConnectSessionToPendingSelection(session.id);

		const reverted = await getChannelConnectSession(session.id);
		expect(reverted?.status).toBe('pending_selection');
		expect(reverted?.encryptedProviderPayload).toBe(encrypted);

		await cancelChannelConnectSession(session.id);
		const cancelled = await getChannelConnectSession(session.id);
		expect(cancelled?.status).toBe('cancelled');
		expect(cancelled?.encryptedProviderPayload).toBeNull();

		const s2 = await createChannelConnectSession({
			organizationId: 'org_wunderside',
			userId: 'usr_arturo',
			platform: 'whatsapp'
		});
		await failChannelConnectSession({ sessionId: s2.id, errorCode: 'no_facebook_pages' });
		const failed = await getChannelConnectSession(s2.id);
		expect(failed?.status).toBe('failed');
		expect(failed?.errorCode).toBe('no_facebook_pages');
	});

	it('detects expired sessions based on TTL', async () => {
		const expired = await createChannelConnectSession({
			organizationId: 'org_wunderside',
			userId: 'usr_arturo',
			platform: 'facebook',
			ttlMs: -5_000
		});
		expect(isConnectSessionExpired(expired)).toBe(true);
	});
});

describe('Provider config & Mock headless Messenger flow', () => {
	it('configures non-conflicting options per channel', () => {
		const fb = getChannelConnectOptions('facebook');
		expect(fb.headless).toBe(true);
		expect(fb.signupHosted).toBe(false);
		expect(fb.brandName).toBeUndefined();

		const wa = getChannelConnectOptions('whatsapp');
		expect(wa.headless).toBe(false);
		expect(wa.signupHosted).toBe(true);
		expect(wa.brandName).toBe('Okeo');
		expect(wa.primaryColor).toBe('#20211e');
		expect(wa.language).toBe('es');

		const ig = getChannelConnectOptions('instagram');
		expect(ig.headless).toBe(false);
		expect(ig.signupHosted).toBe(false);
		expect(ig.brandName).toBeUndefined();
	});

	it('runs end-to-end MockChannelProvider headless page discovery & selection', async () => {
		const provider = new MockChannelProvider();
		const { authUrl } = await provider.getConnectUrl({
			profileId: 'prof_mock_1',
			platform: 'facebook',
			redirectUri: 'https://app.okeo.ai/api/channels/connect/callback?sid=cs_abc',
			headless: true
		});

		const callbackUrl = new URL(authUrl);
		expect(callbackUrl.searchParams.get('step')).toBe('select_page');
		const tempToken = callbackUrl.searchParams.get('tempToken') ?? '';
		const userProfile = parseHeadlessUserProfile(callbackUrl.searchParams.get('userProfile'));
		expect(tempToken).toBe('mock_temp_fb_token');
		expect(userProfile.name).toBe('Equipo Okeo');

		const { pages } = await provider.listPendingFacebookPages({
			profileId: 'prof_mock_1',
			tempToken
		});
		expect(pages.length).toBeGreaterThanOrEqual(2);

		const selected = await provider.selectPendingFacebookPage({
			profileId: 'prof_mock_1',
			pageId: pages[0].pageId,
			tempToken,
			userProfile
		});
		expect(selected.externalAccountId).toBe(`acc_mock_facebook_${pages[0].pageId}`);
		expect(selected.displayName).toBe(pages[0].name);
	});

	it('keeps @zernio/node imports isolated strictly inside src/lib/server/channels/ (AGENTS.md §4)', () => {
		const srcRoot = resolve(process.cwd(), 'src');
		const channelsRoot = resolve(srcRoot, 'lib/server/channels');
		const violations: string[] = [];

		function walk(dir: string) {
			for (const entry of readdirSync(dir)) {
				const fullPath = join(dir, entry);
				if (statSync(fullPath).isDirectory()) {
					walk(fullPath);
				} else if (/\.(ts|js|svelte)$/.test(entry)) {
					const content = readFileSync(fullPath, 'utf8');
					if (content.includes('@zernio/node') && !fullPath.startsWith(channelsRoot)) {
						violations.push(fullPath);
					}
				}
			}
		}

		walk(srcRoot);
		expect(violations).toEqual([]);
	});
});
