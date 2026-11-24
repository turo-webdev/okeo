import { beforeEach, describe, expect, it, vi } from 'vitest';

const envState = { browser: true };
const invalidateMock = vi.fn(async () => {});

vi.mock('$app/environment', () => ({
	get browser() {
		return envState.browser;
	}
}));

vi.mock('$app/navigation', () => ({
	invalidate: invalidateMock
}));

describe('workspace-cache SWR and tenant/user isolation', () => {
	beforeEach(async () => {
		envState.browser = true;
		invalidateMock.mockClear();
		const { clearWorkspaceCache } = await import('$lib/client/workspace-cache');
		clearWorkspaceCache();
	});

	it('serves subsequent hits in 0 extra fetches and isolates caches by userId and orgSlug', async () => {
		const { loadWorkspaceView, clearWorkspaceCache } = await import('$lib/client/workspace-cache');

		const fetchMock = vi.fn(async (url: string | URL | Request) => {
			const u = String(url);
			const tag = u.includes('/ws-b/') ? 'ws-b' : 'ws-a';
			return new Response(
				JSON.stringify({ ok: true, data: { contacts: [{ id: tag }], identities: [], members: [] } }),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);
		}) as unknown as typeof globalThis.fetch;

		const first = await loadWorkspaceView({
			fetch: fetchMock,
			userId: 'user-1',
			orgSlug: 'ws-a',
			view: 'contacts',
			loadNonce: 'nonce-1'
		});
		const second = await loadWorkspaceView({
			fetch: fetchMock,
			userId: 'user-1',
			orgSlug: 'ws-a',
			view: 'contacts',
			loadNonce: 'nonce-1'
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(second).toBe(first);

		// Different userId must not see user-1's cache
		await loadWorkspaceView({
			fetch: fetchMock,
			userId: 'user-2',
			orgSlug: 'ws-a',
			view: 'contacts',
			loadNonce: 'nonce-1'
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);

		// Different orgSlug must not share cache
		const wsB = await loadWorkspaceView({
			fetch: fetchMock,
			userId: 'user-1',
			orgSlug: 'ws-b',
			view: 'contacts',
			loadNonce: 'nonce-1'
		});
		expect(wsB.contacts[0].id).toBe('ws-b');
		expect(fetchMock).toHaveBeenCalledTimes(3);

		clearWorkspaceCache();
		await loadWorkspaceView({
			fetch: fetchMock,
			userId: 'user-1',
			orgSlug: 'ws-a',
			view: 'contacts',
			loadNonce: 'nonce-1'
		});
		expect(fetchMock).toHaveBeenCalledTimes(4);
	});

	it('marks views stale, returns cached immediately, and triggers background SWR invalidation on change', async () => {
		const { loadWorkspaceView, markWorkspaceViewsStale } = await import(
			'$lib/client/workspace-cache'
		);

		const loadFetch = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					ok: true,
					data: { stages: [], deals: [{ id: 'old' }], contacts: [], notes: [], timelineEvents: [], members: [] }
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);
		}) as unknown as typeof globalThis.fetch;

		const bgFetch = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					ok: true,
					data: { stages: [], deals: [{ id: 'updated' }], contacts: [], notes: [], timelineEvents: [], members: [] }
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);
		}) as unknown as typeof globalThis.fetch;
		const origFetch = globalThis.fetch;
		globalThis.fetch = bgFetch;

		try {
			const initial = await loadWorkspaceView({
				fetch: loadFetch,
				userId: 'user-1',
				orgSlug: 'sportika',
				view: 'pipeline',
				loadNonce: 'nonce-1'
			});
			expect(initial.deals[0].id).toBe('old');

			markWorkspaceViewsStale('sportika', ['pipeline']);

			// Immediate stale-while-revalidate return
			const immediate = await loadWorkspaceView({
				fetch: loadFetch,
				userId: 'user-1',
				orgSlug: 'sportika',
				view: 'pipeline',
				loadNonce: 'nonce-1'
			});
			expect(immediate.deals[0].id).toBe('old');
			expect(loadFetch).toHaveBeenCalledTimes(1);

			await vi.waitFor(() => {
				expect(bgFetch).toHaveBeenCalledTimes(1);
				expect(invalidateMock).toHaveBeenCalledWith('app:view:sportika:pipeline');
			});

			const refreshed = await loadWorkspaceView({
				fetch: loadFetch,
				userId: 'user-1',
				orgSlug: 'sportika',
				view: 'pipeline',
				loadNonce: 'nonce-1'
			});
			expect(refreshed.deals[0].id).toBe('updated');
		} finally {
			globalThis.fetch = origFetch;
		}
	});

	it('never caches across requests when running in SSR (browser = false)', async () => {
		envState.browser = false;
		const { loadWorkspaceView } = await import('$lib/client/workspace-cache');

		const fetchMock = vi.fn(async () => {
			return new Response(
				JSON.stringify({ ok: true, data: { contacts: [], identities: [], members: [] } }),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);
		}) as unknown as typeof globalThis.fetch;

		await loadWorkspaceView({
			fetch: fetchMock,
			userId: 'user-1',
			orgSlug: 'ws-a',
			view: 'contacts',
			loadNonce: 'nonce-1'
		});
		await loadWorkspaceView({
			fetch: fetchMock,
			userId: 'user-1',
			orgSlug: 'ws-a',
			view: 'contacts',
			loadNonce: 'nonce-1'
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('patches deal stage optimistically inside cached pipeline view with 0 extra fetches', async () => {
		const { loadWorkspaceView, patchWorkspaceDealStage } = await import(
			'$lib/client/workspace-cache'
		);

		const fetchMock = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					ok: true,
					data: {
						stages: [],
						deals: [{ id: 'deal-1', stage_id: 'stg-new', last_moved_by: 'ai' }],
						contacts: [],
						notes: [],
						timelineEvents: [],
						members: []
					}
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);
		}) as unknown as typeof globalThis.fetch;

		await loadWorkspaceView({
			fetch: fetchMock,
			userId: 'user-1',
			orgSlug: 'sportika',
			view: 'pipeline',
			loadNonce: 'nonce-1'
		});

		patchWorkspaceDealStage('sportika', 'deal-1', 'stg-qualified');

		const next = await loadWorkspaceView({
			fetch: fetchMock,
			userId: 'user-1',
			orgSlug: 'sportika',
			view: 'pipeline',
			loadNonce: 'nonce-1'
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(next.deals[0].stage_id).toBe('stg-qualified');
		expect(next.deals[0].last_moved_by).toBe('human');
	});

	it('patches AI mode and Inbox conversation fields optimistically with 0 extra fetches', async () => {
		const {
			loadWorkspaceView,
			patchWorkspaceAiMode,
			patchWorkspaceConversation
		} = await import('$lib/client/workspace-cache');

		const fetchMock = vi.fn(async (url: string | URL | Request) => {
			const u = String(url);
			if (u.includes('name=ai')) {
				return new Response(
					JSON.stringify({
						ok: true,
						data: {
							geminiConfigured: true,
							geminiModel: 'gemini-3.5-flash-lite',
							initialDemoLead: null,
							aiSettings: { auto_reply_enabled: false },
							knowledgeDocuments: [],
							stages: []
						}
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				);
			}
			return new Response(
				JSON.stringify({
					ok: true,
					data: {
						conversations: [{ id: 'conv-1', ai_paused: false, status: 'open', assigned_to: null }],
						contacts: [],
						identities: [],
						messages: [],
						notes: [],
						deals: [],
						stages: [],
						timelineEvents: [],
						channels: [],
						members: []
					}
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);
		}) as unknown as typeof globalThis.fetch;

		await loadWorkspaceView({
			fetch: fetchMock,
			userId: 'user-1',
			orgSlug: 'sportika',
			view: 'ai',
			loadNonce: 'nonce-1'
		});
		await loadWorkspaceView({
			fetch: fetchMock,
			userId: 'user-1',
			orgSlug: 'sportika',
			view: 'inbox',
			loadNonce: 'nonce-1'
		});

		patchWorkspaceAiMode('sportika', true);
		patchWorkspaceConversation('sportika', 'conv-1', {
			ai_paused: true,
			status: 'closed',
			assigned_to: 'usr_1'
		});

		const nextAi = await loadWorkspaceView({
			fetch: fetchMock,
			userId: 'user-1',
			orgSlug: 'sportika',
			view: 'ai',
			loadNonce: 'nonce-1'
		});
		const nextInbox = await loadWorkspaceView({
			fetch: fetchMock,
			userId: 'user-1',
			orgSlug: 'sportika',
			view: 'inbox',
			loadNonce: 'nonce-1'
		});

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(nextAi.aiSettings.auto_reply_enabled).toBe(true);
		expect(nextInbox.conversations[0].ai_paused).toBe(true);
		expect(nextInbox.conversations[0].status).toBe('closed');
		expect(nextInbox.conversations[0].assigned_to).toBe('usr_1');
	});
});
