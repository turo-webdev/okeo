<script lang="ts">
	import type { MessageAttachment } from '$lib/types/domain';
	import { ExternalLink, FileText, Volume2, ImageOff } from 'lucide-svelte';

	const CACHE_TTL_MS = 240_000;
	const signedUrlCache = new Map<string, { url: string; expiresAt: number }>();
	const inflightRequests = new Map<string, Promise<string | null>>();

	async function fetchSignedMediaUrl(organizationId: string, storagePath: string): Promise<string | null> {
		const cacheKey = `${organizationId}:dm-media:${storagePath}`;
		const cached = signedUrlCache.get(cacheKey);
		if (cached && cached.expiresAt > Date.now()) {
			return cached.url;
		}

		const inflight = inflightRequests.get(cacheKey);
		if (inflight) return inflight;

		const req = (async () => {
			try {
				const qs = new URLSearchParams({
					organizationId,
					bucket: 'dm-media',
					path: storagePath
				});
				const res = await fetch(`/api/media/signed-url?${qs.toString()}`, {
					credentials: 'same-origin'
				});
				if (!res.ok) return null;
				const payload = (await res.json()) as { ok?: boolean; signedUrl?: string };
				if (!payload?.ok || !payload.signedUrl) return null;
				signedUrlCache.set(cacheKey, {
					url: payload.signedUrl,
					expiresAt: Date.now() + CACHE_TTL_MS
				});
				return payload.signedUrl;
			} catch {
				return null;
			} finally {
				inflightRequests.delete(cacheKey);
			}
		})();

		inflightRequests.set(cacheKey, req);
		return req;
	}

	function formatBytes(bytes: number): string {
		if (!Number.isFinite(bytes) || bytes <= 0) return '';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	let {
		organizationId,
		attachments,
		initialUrls = {}
	}: {
		organizationId: string;
		attachments: MessageAttachment[];
		initialUrls?: Record<string, string>;
	} = $props();

	let resolvedUrls = $state<Record<string, string>>({});
	let failedPaths = $state<Record<string, boolean>>({});

	$effect(() => {
		let cancelled = false;
		for (const att of attachments) {
			const path = att.storage_path;
			if (!path) continue;
			if (initialUrls[path] || resolvedUrls[path] || failedPaths[path]) continue;

			const cacheKey = `${organizationId}:dm-media:${path}`;
			const cached = signedUrlCache.get(cacheKey);
			if (cached && cached.expiresAt > Date.now()) {
				resolvedUrls = { ...resolvedUrls, [path]: cached.url };
				continue;
			}

			void fetchSignedMediaUrl(organizationId, path).then((url) => {
				if (cancelled) return;
				if (url) {
					resolvedUrls = { ...resolvedUrls, [path]: url };
				} else {
					failedPaths = { ...failedPaths, [path]: true };
				}
			});
		}
		return () => {
			cancelled = true;
		};
	});

	function getUrl(att: MessageAttachment): string | null {
		return initialUrls[att.storage_path] ?? resolvedUrls[att.storage_path] ?? null;
	}
</script>

<div class="space-y-2">
	{#each attachments as att, idx (att.storage_path || `${att.file_name}-${idx}`)}
		{@const mediaUrl = getUrl(att)}
		{@const hasError = Boolean(failedPaths[att.storage_path])}
		{@const sizeLabel = formatBytes(att.size_bytes)}

		{#if att.kind === 'image'}
			{#if mediaUrl}
				<a
					href={mediaUrl}
					target="_blank"
					rel="noopener noreferrer"
					class="block overflow-hidden rounded-lg border border-border/60 bg-canvas/50"
				>
					<img
						src={mediaUrl}
						alt={att.file_name}
						loading="lazy"
						decoding="async"
						class="max-h-60 max-w-full rounded-lg object-cover"
					/>
				</a>
			{:else if hasError}
				<div class="flex items-center gap-2 rounded-lg border border-border bg-canvas/70 px-3 py-2 text-xs text-ink-muted">
					<ImageOff class="size-4 shrink-0" aria-hidden="true" />
					<span class="truncate">{att.file_name} · Imagen no disponible</span>
				</div>
			{:else}
				<div
					aria-label="Cargando imagen {att.file_name}"
					class="h-32 w-48 animate-pulse rounded-lg border border-border/50 bg-canvas/60"
				></div>
			{/if}
		{:else if att.kind === 'audio'}
			{#if mediaUrl}
				<figure class="space-y-1">
					<audio
						controls
						preload="none"
						{...({ loading: 'lazy' } as Record<string, string>)}
						src={mediaUrl}
						aria-label={att.file_name}
						class="h-9 w-full min-w-[220px] max-w-[260px]"
					></audio>
					<figcaption class="flex items-center gap-1.5 truncate text-[11px] text-ink-muted">
						<Volume2 class="size-3 shrink-0" aria-hidden="true" />
						<span class="truncate">{att.file_name}{sizeLabel ? ` · ${sizeLabel}` : ''}</span>
					</figcaption>
				</figure>
			{:else if hasError}
				<div class="flex items-center gap-2 rounded-lg border border-border bg-canvas/70 px-3 py-2 text-xs text-ink-muted">
					<Volume2 class="size-4 shrink-0" aria-hidden="true" />
					<span class="truncate">{att.file_name} · Audio no disponible</span>
				</div>
			{:else}
				<div class="h-10 w-56 animate-pulse rounded-lg border border-border/50 bg-canvas/60"></div>
			{/if}
		{:else}
			{#if mediaUrl}
				<a
					href={mediaUrl}
					target="_blank"
					rel="noopener noreferrer"
					class="flex items-center gap-2.5 rounded-lg border border-border bg-canvas/85 px-3 py-2 text-xs text-ink transition-colors hover:bg-canvas"
				>
					<FileText class="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
					<span class="min-w-0 flex-1">
						<span class="block truncate font-medium">{att.file_name}</span>
						{#if sizeLabel}
							<span class="block text-[11px] text-ink-muted">{sizeLabel}</span>
						{/if}
					</span>
					<ExternalLink class="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
				</a>
			{:else if hasError}
				<div class="flex items-center gap-2 rounded-lg border border-border bg-canvas/70 px-3 py-2 text-xs text-ink-muted">
					<FileText class="size-4 shrink-0" aria-hidden="true" />
					<span class="truncate">{att.file_name} · Archivo no disponible</span>
				</div>
			{:else}
				<div class="h-11 w-52 animate-pulse rounded-lg border border-border/50 bg-canvas/60"></div>
			{/if}
		{/if}
	{/each}
</div>
