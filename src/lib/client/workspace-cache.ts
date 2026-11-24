import { browser } from '$app/environment';
import { invalidate } from '$app/navigation';
import { error } from '@sveltejs/kit';
import type {
	AiViewPayload,
	ContactDetailViewPayload,
	ContactsViewPayload,
	InboxConversationItem,
	InboxViewPayload,
	PipelineViewPayload,
	WorkspaceBootstrapPayload,
	WorkspaceViewMap,
	WorkspaceViewName
} from '$lib/types/workspace-views';

interface CacheEntry<T = unknown> {
	data: T;
	fingerprint: string;
	fetchedAt: number;
	loadNonce: string;
	stale: boolean;
}

const ALL_VIEWS: WorkspaceViewName[] = ['inbox', 'pipeline', 'contacts', 'ai', 'settings'];
const STALE_AFTER_MS = 15_000;

const viewCache = new Map<string, CacheEntry>();
const contactCache = new Map<string, CacheEntry<ContactDetailViewPayload>>();
const inFlightBootstrap = new Map<string, Promise<void>>();
const inFlightRevalidate = new Set<string>();

function viewKey(userId: string, orgSlug: string, view: WorkspaceViewName): string {
	return `${userId}:${orgSlug}:${view}`;
}

function contactKey(userId: string, orgSlug: string, contactId: string): string {
	return `${userId}:${orgSlug}:${contactId}`;
}

function fingerprintOf(value: unknown): string {
	try {
		return JSON.stringify(value) ?? '';
	} catch {
		return String(Date.now());
	}
}

function bumpOtherViewsStale(
	userId: string,
	orgSlug: string,
	activeView: WorkspaceViewName | null,
	newLoadNonce: string
): void {
	const prefix = `${userId}:${orgSlug}:`;
	for (const [k, entry] of viewCache.entries()) {
		if (!k.startsWith(prefix)) continue;
		const viewName = k.slice(prefix.length) as WorkspaceViewName;
		if (viewName === activeView) continue;
		if (entry.loadNonce !== newLoadNonce) {
			entry.loadNonce = newLoadNonce;
			entry.stale = true;
		}
	}
	for (const [k, entry] of contactCache.entries()) {
		if (!k.startsWith(prefix)) continue;
		if (entry.loadNonce !== newLoadNonce) {
			entry.loadNonce = newLoadNonce;
			entry.stale = true;
		}
	}
}

async function fetchJson<T>(
	fetchFn: typeof globalThis.fetch,
	url: string
): Promise<T> {
	const res = await fetchFn(url, { credentials: 'same-origin' });
	let payload: { data?: T; error?: string } | null = null;
	try {
		payload = (await res.json()) as { data?: T; error?: string };
	} catch {
		payload = null;
	}
	if (!res.ok || payload?.data === undefined) {
		throw error(res.status >= 400 ? res.status : 500, payload?.error ?? 'Error al cargar la vista');
	}
	return payload.data;
}

function revalidateViewInBackground<K extends WorkspaceViewName>(
	userId: string,
	orgSlug: string,
	view: K,
	loadNonce: string
): void {
	if (!browser) return;
	const k = viewKey(userId, orgSlug, view);
	if (inFlightRevalidate.has(k)) return;
	inFlightRevalidate.add(k);

	const url = `/api/workspace/${encodeURIComponent(orgSlug)}/view?name=${view}`;
	void globalThis
		.fetch(url, { credentials: 'same-origin' })
		.then(async (res) => {
			if (!res.ok) return;
			const payload = (await res.json()) as { data?: WorkspaceViewMap[K] };
			if (!payload?.data) return;

			const current = viewCache.get(k);
			if (current && current.loadNonce !== loadNonce) return;

			const nextFp = fingerprintOf(payload.data);
			const changed = !current || current.fingerprint !== nextFp;
			viewCache.set(k, {
				data: payload.data,
				fingerprint: nextFp,
				fetchedAt: Date.now(),
				loadNonce,
				stale: false
			});
			if (changed) {
				await invalidate(`app:view:${orgSlug}:${view}`);
			}
		})
		.catch(() => {
			// Fallos transitorios de red en revalidación silenciosa se reintentarán luego
		})
		.finally(() => {
			inFlightRevalidate.delete(k);
		});
}

function revalidateContactInBackground(
	userId: string,
	orgSlug: string,
	contactId: string,
	loadNonce: string
): void {
	if (!browser) return;
	const ck = contactKey(userId, orgSlug, contactId);
	const revalidateId = `contact:${ck}`;
	if (inFlightRevalidate.has(revalidateId)) return;
	inFlightRevalidate.add(revalidateId);

	const url = `/api/workspace/${encodeURIComponent(orgSlug)}/view?name=contact&id=${encodeURIComponent(contactId)}`;
	void globalThis
		.fetch(url, { credentials: 'same-origin' })
		.then(async (res) => {
			if (!res.ok) return;
			const payload = (await res.json()) as { data?: ContactDetailViewPayload };
			if (!payload?.data) return;

			const current = contactCache.get(ck);
			if (current && current.loadNonce !== loadNonce) return;

			const nextFp = fingerprintOf(payload.data);
			const changed = !current || current.fingerprint !== nextFp;
			contactCache.set(ck, {
				data: payload.data,
				fingerprint: nextFp,
				fetchedAt: Date.now(),
				loadNonce,
				stale: false
			});
			if (changed) {
				await invalidate(`app:view:${orgSlug}:contact:${contactId}`);
			}
		})
		.catch(() => {
			// Silencioso en segundo plano
		})
		.finally(() => {
			inFlightRevalidate.delete(revalidateId);
		});
}

function deriveContactDetailFromCache(
	userId: string,
	orgSlug: string,
	contactId: string,
	loadNonce: string
): ContactDetailViewPayload | null {
	const contactsEntry = viewCache.get(viewKey(userId, orgSlug, 'contacts')) as
		| CacheEntry<ContactsViewPayload>
		| undefined;
	const inboxEntry = viewCache.get(viewKey(userId, orgSlug, 'inbox')) as
		| CacheEntry<InboxViewPayload>
		| undefined;
	const pipelineEntry = viewCache.get(viewKey(userId, orgSlug, 'pipeline')) as
		| CacheEntry<PipelineViewPayload>
		| undefined;

	const contactsSource =
		contactsEntry && contactsEntry.loadNonce === loadNonce
			? contactsEntry.data
			: inboxEntry && inboxEntry.loadNonce === loadNonce
				? inboxEntry.data
				: null;
	if (!contactsSource) return null;

	const contact = contactsSource.contacts.find((c) => c.id === contactId);
	if (!contact) return null;

	const inboxData = inboxEntry?.data;
	const pipelineData = pipelineEntry?.data;

	const identities = (inboxData?.identities ?? contactsSource.identities).filter(
		(i) => i.contact_id === contactId
	);
	const deals = (pipelineData?.deals ?? inboxData?.deals ?? []).filter(
		(d) => d.contact_id === contactId
	);
	const stages = pipelineData?.stages ?? inboxData?.stages ?? [];
	const notes = (inboxData?.notes ?? pipelineData?.notes ?? []).filter(
		(n) => n.contact_id === contactId
	);
	const conversation = inboxData?.conversations.find((c) => c.contact_id === contactId) ?? null;
	const timelineEvents = (inboxData?.timelineEvents ?? pipelineData?.timelineEvents ?? []).filter(
		(e) => e.contact_id === contactId
	);

	return {
		contact,
		identities,
		deals,
		stages,
		notes,
		conversation,
		timelineEvents,
		members: contactsSource.members
	};
}

export function clearWorkspaceCache(): void {
	viewCache.clear();
	contactCache.clear();
	inFlightBootstrap.clear();
	inFlightRevalidate.clear();
}

export function markWorkspaceViewsStale(orgSlug: string, views?: WorkspaceViewName[]): void {
	if (!browser) return;
	const targetSet = views ? new Set<WorkspaceViewName>(views) : null;
	for (const [k, entry] of viewCache.entries()) {
		const parts = k.split(':');
		if (parts.length < 3 || parts[1] !== orgSlug) continue;
		const viewName = parts[2] as WorkspaceViewName;
		if (!targetSet || targetSet.has(viewName)) {
			entry.stale = true;
		}
	}
	for (const [k, entry] of contactCache.entries()) {
		const parts = k.split(':');
		if (parts.length < 3 || parts[1] !== orgSlug) continue;
		entry.stale = true;
	}
}

export function revalidateWorkspaceViewNow(
	userId: string,
	orgSlug: string,
	view: WorkspaceViewName,
	loadNonce: string
): void {
	revalidateViewInBackground(userId, orgSlug, view, loadNonce);
}

export function patchWorkspaceAiMode(orgSlug: string, autoReplyEnabled: boolean): void {
	if (!browser) return;
	for (const [k, entry] of viewCache.entries()) {
		const parts = k.split(':');
		if (parts.length < 3 || parts[1] !== orgSlug || parts[2] !== 'ai') continue;
		const payload = entry.data as AiViewPayload;
		if (!payload?.aiSettings) continue;
		const nextPayload: AiViewPayload = {
			...payload,
			aiSettings: {
				...payload.aiSettings,
				auto_reply_enabled: autoReplyEnabled
			}
		};
		entry.data = nextPayload;
		entry.fingerprint = fingerprintOf(nextPayload);
	}
}

export function patchWorkspaceConversation(
	orgSlug: string,
	conversationId: string,
	patch: Partial<
		Pick<
			InboxConversationItem,
			| 'ai_paused'
			| 'status'
			| 'assigned_to'
			| 'last_message_preview'
			| 'needs_reply'
			| 'unread_count'
		>
	>
): void {
	if (!browser) return;
	for (const [k, entry] of viewCache.entries()) {
		const parts = k.split(':');
		if (parts.length < 3 || parts[1] !== orgSlug || parts[2] !== 'inbox') continue;
		const payload = entry.data as InboxViewPayload;
		const nextConversations = payload.conversations.map((c) =>
			c.id === conversationId ? { ...c, ...patch } : c
		);
		const nextPayload: InboxViewPayload = {
			...payload,
			conversations: nextConversations
		};
		entry.data = nextPayload;
		entry.fingerprint = fingerprintOf(nextPayload);
	}
}

export function patchWorkspaceDealStage(orgSlug: string, dealId: string, stageId: string): void {
	if (!browser) return;
	for (const [k, entry] of viewCache.entries()) {
		const parts = k.split(':');
		if (parts.length < 3 || parts[1] !== orgSlug) continue;
		const viewName = parts[2] as WorkspaceViewName;
		if (viewName === 'pipeline') {
			const payload = entry.data as PipelineViewPayload;
			const deals = payload.deals.map((d) =>
				d.id === dealId ? { ...d, stage_id: stageId, last_moved_by: 'human' as const } : d
			);
			const nextPayload: PipelineViewPayload = { ...payload, deals };
			entry.data = nextPayload;
			entry.fingerprint = fingerprintOf(nextPayload);
		} else if (viewName === 'inbox') {
			const payload = entry.data as InboxViewPayload;
			const deals = payload.deals.map((d) =>
				d.id === dealId ? { ...d, stage_id: stageId, last_moved_by: 'human' as const } : d
			);
			const nextPayload: InboxViewPayload = { ...payload, deals };
			entry.data = nextPayload;
			entry.fingerprint = fingerprintOf(nextPayload);
		} else if (viewName === 'contacts' || viewName === 'ai') {
			entry.stale = true;
		}
	}
	for (const [k, entry] of contactCache.entries()) {
		const parts = k.split(':');
		if (parts.length < 3 || parts[1] !== orgSlug) continue;
		if (entry.data.deals.some((d) => d.id === dealId)) {
			const nextDeals = entry.data.deals.map((d) =>
				d.id === dealId ? { ...d, stage_id: stageId, last_moved_by: 'human' as const } : d
			);
			const nextPayload: ContactDetailViewPayload = { ...entry.data, deals: nextDeals };
			entry.data = nextPayload;
			entry.fingerprint = fingerprintOf(nextPayload);
		}
		entry.stale = true;
	}
}

export async function warmWorkspaceCache(
	userId: string,
	orgSlug: string,
	loadNonce: string
): Promise<void> {
	if (!browser) return;

	const now = Date.now();
	const allFresh = ALL_VIEWS.every((view) => {
		const entry = viewCache.get(viewKey(userId, orgSlug, view));
		return (
			entry &&
			entry.loadNonce === loadNonce &&
			!entry.stale &&
			now - entry.fetchedAt <= STALE_AFTER_MS
		);
	});
	if (allFresh) return;

	const bootKey = `${userId}:${orgSlug}:${loadNonce}`;
	const existingBoot = inFlightBootstrap.get(bootKey);
	if (existingBoot) return existingBoot;

	const bootPromise = globalThis
		.fetch(`/api/workspace/${encodeURIComponent(orgSlug)}/bootstrap`, {
			credentials: 'same-origin'
		})
		.then(async (res) => {
			if (!res.ok) return;
			const payload = (await res.json()) as { data?: WorkspaceBootstrapPayload };
			if (!payload?.data) return;

			const ts = Date.now();
			for (const view of ALL_VIEWS) {
				const viewPayload = payload.data[view];
				if (!viewPayload) continue;
				const k = viewKey(userId, orgSlug, view);
				const current = viewCache.get(k);
				if (current && current.loadNonce === loadNonce && !current.stale) continue;
				viewCache.set(k, {
					data: viewPayload,
					fingerprint: fingerprintOf(viewPayload),
					fetchedAt: ts,
					loadNonce,
					stale: false
				});
			}
		})
		.catch(() => {
			// Silencioso si el navegador canceló o falló la red
		})
		.finally(() => {
			inFlightBootstrap.delete(bootKey);
		});

	inFlightBootstrap.set(bootKey, bootPromise);
	return bootPromise;
}

export async function loadWorkspaceView<K extends WorkspaceViewName>(params: {
	fetch: typeof globalThis.fetch;
	userId: string;
	orgSlug: string;
	view: K;
	loadNonce: string;
	forceFresh?: boolean;
}): Promise<WorkspaceViewMap[K]> {
	const viewUrl = `/api/workspace/${encodeURIComponent(params.orgSlug)}/view?name=${params.view}`;

	if (!browser) {
		return fetchJson<WorkspaceViewMap[K]>(params.fetch, viewUrl);
	}

	const k = viewKey(params.userId, params.orgSlug, params.view);
	const cached = viewCache.get(k) as CacheEntry<WorkspaceViewMap[K]> | undefined;

	if (!params.forceFresh && cached && cached.loadNonce === params.loadNonce) {
		if (cached.stale || Date.now() - cached.fetchedAt > STALE_AFTER_MS) {
			revalidateViewInBackground(params.userId, params.orgSlug, params.view, params.loadNonce);
		}
		return cached.data;
	}

	const bootKey = `${params.userId}:${params.orgSlug}:${params.loadNonce}`;
	const activeBoot = inFlightBootstrap.get(bootKey);
	if (!params.forceFresh && !cached && activeBoot) {
		await activeBoot;
		const warmed = viewCache.get(k) as CacheEntry<WorkspaceViewMap[K]> | undefined;
		if (warmed && warmed.loadNonce === params.loadNonce) {
			return warmed.data;
		}
	}

	const fresh = await fetchJson<WorkspaceViewMap[K]>(params.fetch, viewUrl);
	const hadPreviousNonce = Boolean(cached && cached.loadNonce !== params.loadNonce);
	viewCache.set(k, {
		data: fresh,
		fingerprint: fingerprintOf(fresh),
		fetchedAt: Date.now(),
		loadNonce: params.loadNonce,
		stale: false
	});
	if (hadPreviousNonce) {
		bumpOtherViewsStale(params.userId, params.orgSlug, params.view, params.loadNonce);
	}
	return fresh;
}

export async function loadContactDetailView(params: {
	fetch: typeof globalThis.fetch;
	userId: string;
	orgSlug: string;
	contactId: string;
	loadNonce: string;
}): Promise<ContactDetailViewPayload | null> {
	const detailUrl = `/api/workspace/${encodeURIComponent(params.orgSlug)}/view?name=contact&id=${encodeURIComponent(params.contactId)}`;

	if (!browser) {
		const res = await params.fetch(detailUrl, { credentials: 'same-origin' });
		if (res.status === 404) return null;
		const payload = (await res.json()) as { data?: ContactDetailViewPayload; error?: string };
		if (!res.ok || !payload?.data) {
			throw error(res.status >= 400 ? res.status : 500, payload?.error ?? 'Error al cargar contacto');
		}
		return payload.data;
	}

	const ck = contactKey(params.userId, params.orgSlug, params.contactId);
	const cached = contactCache.get(ck);
	if (cached && cached.loadNonce === params.loadNonce) {
		if (cached.stale || Date.now() - cached.fetchedAt > STALE_AFTER_MS) {
			revalidateContactInBackground(
				params.userId,
				params.orgSlug,
				params.contactId,
				params.loadNonce
			);
		}
		return cached.data;
	}

	const derived = deriveContactDetailFromCache(
		params.userId,
		params.orgSlug,
		params.contactId,
		params.loadNonce
	);
	if (derived) {
		contactCache.set(ck, {
			data: derived,
			fingerprint: fingerprintOf(derived),
			fetchedAt: Date.now(),
			loadNonce: params.loadNonce,
			stale: true
		});
		revalidateContactInBackground(
			params.userId,
			params.orgSlug,
			params.contactId,
			params.loadNonce
		);
		return derived;
	}

	const res = await params.fetch(detailUrl, { credentials: 'same-origin' });
	if (res.status === 404) return null;
	const payload = (await res.json()) as { data?: ContactDetailViewPayload; error?: string };
	if (!res.ok || !payload?.data) {
		throw error(res.status >= 400 ? res.status : 500, payload?.error ?? 'Error al cargar contacto');
	}
	const hadPreviousNonce = Boolean(cached && cached.loadNonce !== params.loadNonce);
	contactCache.set(ck, {
		data: payload.data,
		fingerprint: fingerprintOf(payload.data),
		fetchedAt: Date.now(),
		loadNonce: params.loadNonce,
		stale: false
	});
	if (hadPreviousNonce) {
		bumpOtherViewsStale(params.userId, params.orgSlug, null, params.loadNonce);
	}
	return payload.data;
}
