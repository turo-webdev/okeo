<script lang="ts">
	import { enhance } from '$app/forms';
	import { markWorkspaceViewsStale } from '$lib/client/workspace-cache';
	import BrandLogo from '$lib/components/shared/BrandLogo.svelte';
	import ChannelIcon from '$lib/components/shared/ChannelIcon.svelte';
	import { AlertCircle, ArrowLeft, Check, Loader2, RefreshCw } from 'lucide-svelte';

	let { data, form } = $props();

	let org = $derived(!data.accessDenied && 'org' in data && data.org ? data.org : null);
	let selectedPageId = $state('');
	let submitting = $state(false);
	let cancelling = $state(false);
	let retryingConnect = $state(false);
	let retryError = $state<string | null>(null);

	$effect(() => {
		if (data.state === 'ready' && data.pages.length === 1 && !selectedPageId) {
			selectedPageId = data.pages[0].pageId;
		}
	});

	let formError = $derived(
		retryError ?? (form && 'error' in form && typeof form.error === 'string' ? form.error : null)
	);

	async function restartFacebookConnect() {
		if (!org || retryingConnect) return;
		retryError = null;
		retryingConnect = true;
		try {
			const res = await fetch('/api/channels/connect', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					organizationId: org.id,
					platform: 'facebook'
				})
			});
			const payload = (await res.json()) as { authUrl?: string; error?: string };
			if (!res.ok || !payload.authUrl) {
				retryError = payload.error ?? 'No se pudo reiniciar la conexión con Facebook.';
				return;
			}
			window.location.href = payload.authUrl;
		} catch {
			retryError = 'Error de red al reiniciar la conexión.';
		} finally {
			retryingConnect = false;
		}
	}
</script>

<svelte:head>
	<title>Conectar Messenger · {org ? org.name : 'okeo'}</title>
</svelte:head>

{#if org}
	{@const currentOrg = org}
	<div class="flex min-h-0 flex-1 overflow-y-auto bg-sidebar/50 px-5 py-10 sm:px-9">
		<div class="mx-auto w-full max-w-lg self-start">
			<div class="mb-6 flex items-center justify-between">
				<BrandLogo size="sm" />
				<a
					href="/{currentOrg.slug}/settings?panel=canales"
					class="inline-flex items-center gap-1.5 text-xs font-medium text-ink-muted transition-colors hover:text-ink"
				>
					<ArrowLeft class="size-3.5" aria-hidden="true" />
					<span>Volver a canales</span>
				</a>
			</div>

			<div class="rounded-2xl border border-border bg-canvas p-6 shadow-xs sm:p-8">
				{#if data.state === 'ready'}
					<div class="flex items-center gap-2.5">
						<span class="flex size-9 items-center justify-center rounded-xl bg-surface">
							<ChannelIcon platform="facebook" class="size-4.5 text-ink" />
						</span>
						<div>
							<p class="text-[11px] font-medium tracking-wide text-ink-muted uppercase">
								{data.isReconnect ? 'Reconectar canal' : 'Conectar canal'}
							</p>
							<h1 class="text-xl font-semibold tracking-tight text-ink">
								Elige tu Página de Facebook
							</h1>
						</div>
					</div>

					<p class="mt-3 text-sm leading-relaxed text-ink-secondary">
						{#if data.userDisplayName}
							Autorizado como <strong class="font-medium text-ink">{data.userDisplayName}</strong>.
						{/if}
						Selecciona la Página que conectaremos a Messenger en
						<strong class="font-medium text-ink">{currentOrg.name}</strong>.
					</p>

					{#if data.truncated}
						<p class="mt-4 rounded-lg border border-note-border bg-note-soft px-3.5 py-2.5 text-xs text-amber-ink">
							Meta limitó la lista visible porque administras muchas Páginas. Si no ves la que buscas, revisa tus permisos de Página e inténtalo de nuevo.
						</p>
					{/if}

					{#if formError}
						<p class="mt-4 rounded-lg border border-note-border bg-note-soft px-3.5 py-2.5 text-xs text-amber-ink">
							{formError}
						</p>
					{/if}

					<form
						method="POST"
						action="?/selectPage"
						use:enhance={() => {
							submitting = true;
							return async ({ result, update }) => {
								submitting = false;
								if (result.type === 'redirect') {
									markWorkspaceViewsStale(currentOrg.slug, ['settings', 'inbox']);
								}
								await update();
							};
						}}
						class="mt-5 space-y-5"
					>
						<input type="hidden" name="organizationId" value={currentOrg.id} />

						<fieldset class="space-y-2.5">
							<legend class="visually-hidden">Páginas de Facebook disponibles</legend>
							{#each data.pages as fbPage (fbPage.pageId)}
								{@const checked = selectedPageId === fbPage.pageId}
								<label
									class="flex cursor-pointer items-center justify-between gap-3 rounded-xl border px-4 py-3.5 transition-colors {checked
										? 'border-ink bg-surface'
										: 'border-border bg-canvas hover:bg-sidebar/70'}"
								>
									<span class="flex min-w-0 items-center gap-3">
										<input
											type="radio"
											name="pageId"
											value={fbPage.pageId}
											bind:group={selectedPageId}
											required
											class="size-4 accent-cta"
										/>
										<span class="min-w-0">
											<span class="block truncate text-sm font-medium text-ink">
												{fbPage.name}
											</span>
											<span class="block truncate text-xs text-ink-muted">
												{fbPage.username ? `@${fbPage.username}` : 'Sin usuario público'}
												{fbPage.category ? ` · ${fbPage.category}` : ''}
											</span>
										</span>
									</span>
									{#if checked}
										<Check class="size-4 shrink-0 text-sage-ink" aria-hidden="true" />
									{/if}
								</label>
							{/each}
						</fieldset>

						<button
							type="submit"
							disabled={!selectedPageId || submitting || cancelling}
							class="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-cta px-4 text-sm font-medium text-white transition-colors hover:bg-cta-hover disabled:opacity-50"
						>
							{#if submitting}
								<Loader2 class="size-4 animate-spin" aria-hidden="true" />
								<span>Conectando página...</span>
							{:else}
								<span>Conectar página</span>
							{/if}
						</button>
					</form>

					<form
						method="POST"
						action="?/cancel"
						use:enhance={() => {
							cancelling = true;
							return async ({ update }) => {
								cancelling = false;
								await update();
							};
						}}
						class="mt-2.5"
					>
						<button
							type="submit"
							disabled={submitting || cancelling}
							class="h-10 w-full rounded-xl border border-border text-xs font-medium text-ink-secondary transition-colors hover:bg-surface hover:text-ink disabled:opacity-50"
						>
							{cancelling ? 'Cancelando...' : 'Cancelar'}
						</button>
					</form>
				{:else if data.state === 'completed'}
					<div class="flex flex-col items-start">
						<span class="flex size-10 items-center justify-center rounded-full bg-sage-soft text-sage-ink">
							<Check class="size-5" aria-hidden="true" />
						</span>
						<h1 class="mt-4 text-xl font-semibold tracking-tight text-ink">
							Messenger conectado
						</h1>
						<p class="mt-2 text-sm leading-relaxed text-ink-secondary">
							La Página <strong class="font-medium text-ink">{data.channelName}</strong>
							{#if data.channelHandle}
								({data.channelHandle})
							{/if}
							ya está activa en <strong class="font-medium text-ink">{currentOrg.name}</strong> y lista para recibir mensajes en tu Inbox.
						</p>

						<div class="mt-6 flex w-full flex-col gap-2.5 sm:flex-row">
							<a
								href="/{currentOrg.slug}/inbox"
								class="inline-flex h-10 flex-1 items-center justify-center rounded-xl bg-cta px-4 text-xs font-medium text-white transition-colors hover:bg-cta-hover"
							>
								Ir al Inbox
							</a>
							<a
								href="/{currentOrg.slug}/settings?panel=canales"
								class="inline-flex h-10 flex-1 items-center justify-center rounded-xl border border-border px-4 text-xs font-medium text-ink transition-colors hover:bg-surface"
							>
								Ver canales
							</a>
						</div>
					</div>
				{:else if data.state === 'empty'}
					<div class="flex flex-col items-start">
						<span class="flex size-10 items-center justify-center rounded-full bg-note-soft text-amber-ink">
							<AlertCircle class="size-5" aria-hidden="true" />
						</span>
						<h1 class="mt-4 text-xl font-semibold tracking-tight text-ink">
							No encontramos Páginas disponibles
						</h1>
						<p class="mt-2 text-sm leading-relaxed text-ink-secondary">
							Tu cuenta autorizó el acceso, pero no recibimos Páginas de Facebook administradas con permisos de mensajería.
							En Meta, asegúrate de marcar al menos una Página antes de continuar.
						</p>
						{#if formError}
							<p class="mt-4 w-full rounded-lg border border-note-border bg-note-soft px-3.5 py-2.5 text-xs text-amber-ink">
								{formError}
							</p>
						{/if}
						<div class="mt-6 flex w-full flex-col gap-2.5 sm:flex-row">
							<button
								type="button"
								disabled={retryingConnect}
								onclick={restartFacebookConnect}
								class="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl bg-cta px-4 text-xs font-medium text-white transition-colors hover:bg-cta-hover disabled:opacity-50"
							>
								<RefreshCw class="size-3.5" aria-hidden="true" />
								<span>{retryingConnect ? 'Abriendo...' : 'Reintentar conexión'}</span>
							</button>
							<a
								href="/{currentOrg.slug}/settings?panel=canales"
								class="inline-flex h-10 flex-1 items-center justify-center rounded-xl border border-border px-4 text-xs font-medium text-ink transition-colors hover:bg-surface"
							>
								Volver a canales
							</a>
						</div>
					</div>
				{:else if data.state === 'subscription_required'}
					<div class="flex flex-col items-start">
						<span class="flex size-10 items-center justify-center rounded-full bg-note-soft text-amber-ink">
							<AlertCircle class="size-5" aria-hidden="true" />
						</span>
						<h1 class="mt-4 text-xl font-semibold tracking-tight text-ink">
							Suscripción requerida
						</h1>
						<p class="mt-2 text-sm leading-relaxed text-ink-secondary">
							Activa tu plan ($9 USD/canal/mes) en Configuración → Plan antes de completar la conexión de este canal.
						</p>
						<a
							href="/{currentOrg.slug}/settings?panel=plan"
							class="mt-6 inline-flex h-10 w-full items-center justify-center rounded-xl bg-cta px-4 text-xs font-medium text-white transition-colors hover:bg-cta-hover"
						>
							Ir a Plan y facturación
						</a>
					</div>
				{:else if data.state === 'forbidden'}
					<div class="flex flex-col items-start">
						<h1 class="text-xl font-semibold tracking-tight text-ink">Permisos insuficientes</h1>
						<p class="mt-2 text-sm leading-relaxed text-ink-secondary">
							Solo propietarios o administradores del workspace pueden completar la conexión de un canal.
						</p>
						<a
							href="/{currentOrg.slug}/settings?panel=canales"
							class="mt-6 inline-flex h-10 w-full items-center justify-center rounded-xl border border-border px-4 text-xs font-medium text-ink transition-colors hover:bg-surface"
						>
							Volver a Ajustes
						</a>
					</div>
				{:else}
					<div class="flex flex-col items-start">
						<span class="flex size-10 items-center justify-center rounded-full bg-note-soft text-amber-ink">
							<AlertCircle class="size-5" aria-hidden="true" />
						</span>
						<h1 class="mt-4 text-xl font-semibold tracking-tight text-ink">
							{#if data.state === 'expired'}
								La sesión de conexión expiró
							{:else if data.state === 'completing'}
								Estamos terminando la conexión
							{:else}
								No pudimos continuar esta conexión
							{/if}
						</h1>
						<p class="mt-2 text-sm leading-relaxed text-ink-secondary">
							{#if data.state === 'expired'}
								Por seguridad, las sesiones de conexión caducan después de 10 minutos. Inicia nuevamente desde Ajustes → Canales.
							{:else if data.state === 'completing'}
								Recibimos tu selección y estamos guardando el canal. Recarga en unos segundos si aún no ves la confirmación.
							{:else}
								Esta sesión ya se utilizó, fue cancelada o pertenece a otro usuario. Inicia la conexión de nuevo desde Canales.
							{/if}
						</p>
						{#if formError}
							<p class="mt-4 w-full rounded-lg border border-note-border bg-note-soft px-3.5 py-2.5 text-xs text-amber-ink">
								{formError}
							</p>
						{/if}
						<div class="mt-6 flex w-full flex-col gap-2.5 sm:flex-row">
							<button
								type="button"
								disabled={retryingConnect}
								onclick={restartFacebookConnect}
								class="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl bg-cta px-4 text-xs font-medium text-white transition-colors hover:bg-cta-hover disabled:opacity-50"
							>
								<RefreshCw class="size-3.5" aria-hidden="true" />
								<span>{retryingConnect ? 'Abriendo...' : 'Intentar de nuevo'}</span>
							</button>
							<a
								href="/{currentOrg.slug}/settings?panel=canales"
								class="inline-flex h-10 flex-1 items-center justify-center rounded-xl border border-border px-4 text-xs font-medium text-ink transition-colors hover:bg-surface"
							>
								Volver a canales
							</a>
						</div>
					</div>
				{/if}
			</div>
		</div>
	</div>
{/if}
