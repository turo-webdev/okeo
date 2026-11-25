<script lang="ts">
	import BrandLogo from '$lib/components/shared/BrandLogo.svelte';
	import RecoveryBanner from '$lib/components/shared/RecoveryBanner.svelte';
	import WorkspaceShell from '$lib/components/shared/WorkspaceShell.svelte';
	import { clearWorkspaceCache, warmWorkspaceCache } from '$lib/client/workspace-cache';
	import { Lock } from 'lucide-svelte';

	let { data, children } = $props();

	let bannerDismissed = $state(false);
	let isOffline = $state(false);
	let lastAuthIdentity = '';
	let lastWarmedKey = '';

	$effect(() => {
		if (typeof window === 'undefined') return;
		const identity = `${data.user.id}:${data.accessDenied ? '' : data.effectiveRole}`;
		if (lastAuthIdentity && lastAuthIdentity !== identity) {
			clearWorkspaceCache();
			lastWarmedKey = '';
		}
		lastAuthIdentity = identity;

		if (data.accessDenied) return;
		const warmKey = `${data.user.id}:${data.org.slug}:${data.loadNonce}`;
		if (warmKey === lastWarmedKey) return;

		const timer = window.setTimeout(() => {
			lastWarmedKey = warmKey;
			void warmWorkspaceCache(data.user.id, data.org.slug, data.loadNonce);
		}, 80);
		return () => window.clearTimeout(timer);
	});

	$effect(() => {
		if (typeof window === 'undefined') return;
		isOffline = !navigator.onLine;
		const onOnline = () => (isOffline = false);
		const onOffline = () => (isOffline = true);
		window.addEventListener('online', onOnline);
		window.addEventListener('offline', onOffline);
		return () => {
			window.removeEventListener('online', onOnline);
			window.removeEventListener('offline', onOffline);
		};
	});
</script>

{#if data.accessDenied}
	<div class="flex min-h-dvh flex-col bg-canvas px-6 py-7 text-ink sm:px-10">
		<header>
			<a href={data.marketingHomeUrl}><BrandLogo /></a>
		</header>
		<main class="mx-auto flex w-full max-w-[420px] flex-1 items-center justify-center">
			<div class="w-full rounded-2xl border border-border bg-canvas p-7">
				<Lock class="size-5 text-ink-muted" aria-hidden="true" />
				<h1 class="mt-4 text-2xl font-semibold text-ink">No tienes acceso a este espacio.</h1>
				<p class="mt-2 text-sm text-ink-secondary">
					Pide una invitación a quien administra <strong>{data.deniedOrgName}</strong>.<br />
					También puedes entrar a uno de tus otros espacios.
				</p>
				<div class="mt-6 space-y-3">
					<a
						href="/{data.organizations[0]?.slug ?? 'wunderside'}/inbox"
						class="flex h-11 w-full items-center justify-center rounded-lg bg-cta text-sm font-medium text-white hover:bg-cta-hover"
					>
						Cambiar de workspace
					</a>
					<a href="/login" class="block text-xs text-ink-muted hover:text-ink">
						Cambiar de cuenta
					</a>
				</div>
			</div>
		</main>
	</div>
{:else}
	<WorkspaceShell
		currentOrg={data.org}
		organizations={data.organizations}
		user={data.user}
		effectiveRole={data.effectiveRole}
		unreadBadge={data.unreadBadge}
	>
		{#if isOffline}
			<RecoveryBanner variant="offline" onAction={() => location.reload()} />
		{:else if data.billingInactive}
			<RecoveryBanner variant="billing_inactive" actionHref="/{data.org.slug}/settings?panel=plan" />
		{:else if data.quotaExhausted}
			<RecoveryBanner variant="quota_exhausted" actionHref="/{data.org.slug}/settings?panel=plan" />
		{:else if data.disconnectedChannel && !bannerDismissed}
			<RecoveryBanner
				variant="disconnected_channel"
				channelName={data.disconnectedChannel.display_name}
				actionHref="/{data.org.slug}/settings?panel=canales"
				dismissible={true}
				onDismiss={() => (bannerDismissed = true)}
			/>
		{/if}

		{@render children()}
	</WorkspaceShell>
{/if}
