<script lang="ts">
	import type { Snippet } from 'svelte';
	import { navigating, page } from '$app/state';
	import { invalidateAll } from '$app/navigation';
	import { clearWorkspaceCache } from '$lib/client/workspace-cache';
	import BrandLogo from './BrandLogo.svelte';
	import PopupMenu from '$lib/components/ui/PopupMenu.svelte';
	import type { Organization, OrgRole, Profile } from '$lib/types/domain';
	import { formatRoleLabel } from '$lib/utils/format';
	import {
		Mail,
		Columns3,
		Users,
		Bot,
		Settings,
		Check,
		Plus,
		Shield
	} from 'lucide-svelte';

	interface Props {
		currentOrg: Organization;
		organizations: Array<Organization & { role: OrgRole }>;
		user: Profile;
		effectiveRole: OrgRole;
		unreadBadge?: number;
		children: Snippet;
	}

	let {
		currentOrg,
		organizations,
		user,
		effectiveRole,
		unreadBadge = 0,
		children
	}: Props = $props();

	let pendingPathname = $derived(navigating.to?.url.pathname ?? null);
	let pathname = $derived(pendingPathname ?? page.url.pathname);
	let isNavigating = $derived(Boolean(navigating.to));
	let base = $derived(`/${currentOrg.slug}`);

	function isActive(segment: string): boolean {
		return pathname === `${base}${segment}` || pathname.startsWith(`${base}${segment}/`);
	}

	async function switchDemoRole(role: OrgRole) {
		await fetch('/api/dev/role', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ role })
		});
		clearWorkspaceCache();
		await invalidateAll();
	}
</script>

<div class="flex min-h-dvh flex-col bg-canvas text-ink lg:h-dvh lg:flex-row lg:overflow-hidden">
	{#if isNavigating}
		<div
			aria-hidden="true"
			class="pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5 overflow-hidden bg-sage-soft"
		>
			<div class="nav-progress-bar h-full w-1/3 bg-sage-ink/75"></div>
		</div>
	{/if}

	<!-- Sidebar Desktop -->
	<aside
		aria-label="Navegación del workspace"
		class="hidden w-[204px] shrink-0 flex-col border-r border-border bg-sidebar px-3.5 py-5 lg:flex"
	>
		<div class="px-1.5">
			<a href="{base}/inbox" class="inline-flex items-center focus-visible:rounded-md">
				<BrandLogo />
			</a>
		</div>

		<!-- Selector de Workspace -->
		<div class="mt-5 px-0.5">
			<PopupMenu
				label={currentOrg.name}
				menuLabel="Cambiar de workspace"
				triggerClass="w-full justify-between px-2 py-1.5 text-sm font-medium text-ink hover:bg-surface"
			>
				{#snippet children({ close })}
					{#each organizations as org (org.id)}
						<a
							href="/{org.slug}/inbox"
							onclick={close}
							class="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-surface {org.id === currentOrg.id ? 'bg-sage-soft font-medium text-ink' : 'text-ink-secondary'}"
						>
							<span class="truncate">{org.name}</span>
							{#if org.id === currentOrg.id}
								<Check class="size-3.5 shrink-0 text-sage-ink" aria-hidden="true" />
							{/if}
						</a>
					{/each}
					<hr class="my-1 border-border" />
					<a
						href="/onboarding"
						onclick={close}
						class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-ink hover:bg-surface"
					>
						<Plus class="size-3.5 text-ink-muted" aria-hidden="true" />
						<span>Nuevo workspace</span>
					</a>
					<a
						href="/estudio-norte/inbox"
						data-sveltekit-preload-data="off"
						onclick={close}
						class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-ink-muted hover:bg-surface"
					>
						<Shield class="size-3.5" aria-hidden="true" />
						<span>Probar sin acceso</span>
					</a>
				{/snippet}
			</PopupMenu>
		</div>

		<!-- Navegación principal -->
		<nav aria-label="Principal" class="mt-6 flex flex-1 flex-col gap-1">
			<a
				href="{base}/inbox"
				class="flex items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors {isActive('/inbox') ? 'bg-sage-soft font-medium text-ink' : 'text-ink-secondary hover:bg-surface hover:text-ink'}"
			>
				<span class="flex items-center gap-2.5">
					<Mail class="size-4" aria-hidden="true" />
					<span>Inbox</span>
				</span>
				{#if unreadBadge > 0}
					<span class="text-xs text-ink-muted">{unreadBadge}</span>
				{/if}
			</a>
			<a
				href="{base}/pipeline"
				class="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors {isActive('/pipeline') ? 'bg-sage-soft font-medium text-ink' : 'text-ink-secondary hover:bg-surface hover:text-ink'}"
			>
				<Columns3 class="size-4" aria-hidden="true" />
				<span>Pipeline</span>
			</a>
			<a
				href="{base}/contacts"
				class="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors {isActive('/contacts') ? 'bg-sage-soft font-medium text-ink' : 'text-ink-secondary hover:bg-surface hover:text-ink'}"
			>
				<Users class="size-4" aria-hidden="true" />
				<span>Contactos</span>
			</a>
		</nav>

		<!-- Bloque inferior -->
		<div class="mt-auto flex flex-col gap-1 pt-4">
			<a
				href="{base}/ai"
				class="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors {isActive('/ai') ? 'bg-sage-soft font-medium text-ink' : 'text-ink-secondary hover:bg-surface hover:text-ink'}"
			>
				<Bot class="size-4" aria-hidden="true" />
				<span>Asistente</span>
			</a>
			<a
				href="{base}/settings"
				class="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors {isActive('/settings') ? 'bg-sage-soft font-medium text-ink' : 'text-ink-secondary hover:bg-surface hover:text-ink'}"
			>
				<Settings class="size-4" aria-hidden="true" />
				<span>Ajustes</span>
			</a>

			<div class="mt-3 px-1">
				<PopupMenu
					label={user.full_name}
					menuLabel="Perfil y vista de rol"
					triggerClass="w-full justify-between px-2 py-1.5 text-sm text-ink hover:bg-surface"
				>
					{#snippet leading()}
						<span class="inline-flex size-6 items-center justify-center rounded-full bg-surface text-[11px] font-medium text-ink-secondary">
							{user.initials}
						</span>
					{/snippet}
					{#snippet children({ close })}
						<div class="px-2.5 py-1.5 text-xs text-ink-muted">
							Previsualizar rol ({formatRoleLabel(effectiveRole)})
						</div>
						{#each ['owner', 'admin', 'agent', 'viewer'] as roleOption (roleOption)}
							<button
								type="button"
								onclick={async () => {
									await switchDemoRole(roleOption as OrgRole);
									close();
								}}
								class="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-surface"
							>
								<span>{formatRoleLabel(roleOption)}</span>
								{#if effectiveRole === roleOption}
									<Check class="size-3.5 text-sage-ink" aria-hidden="true" />
								{/if}
							</button>
						{/each}
						<hr class="my-1 border-border" />
						<form method="POST" action="/logout">
							<button
								type="submit"
								onclick={() => {
									clearWorkspaceCache();
									close();
								}}
								class="flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-sm text-ink-secondary hover:bg-surface hover:text-ink"
							>
								Cerrar sesión
							</button>
						</form>
					{/snippet}
				</PopupMenu>
			</div>
		</div>
	</aside>

	<!-- Contenido principal -->
	<main class="flex min-w-0 flex-1 flex-col pb-16 lg:h-dvh lg:overflow-hidden lg:pb-0">
		{@render children()}
	</main>

	<!-- Bottom Tab Bar Móvil (12_Movil.png) -->
	<nav
		aria-label="Navegación móvil"
		class="fixed inset-x-0 bottom-0 z-30 flex items-center justify-around border-t border-border bg-canvas/95 py-2 backdrop-blur lg:hidden"
	>
		<a
			href="{base}/inbox"
			class="flex flex-col items-center gap-0.5 px-3 py-1 text-[11px] {isActive('/inbox') ? 'font-medium text-ink' : 'text-ink-muted'}"
		>
			<Mail class="size-4" aria-hidden="true" />
			<span>Inbox</span>
		</a>
		<a
			href="{base}/pipeline"
			class="flex flex-col items-center gap-0.5 px-3 py-1 text-[11px] {isActive('/pipeline') ? 'font-medium text-ink' : 'text-ink-muted'}"
		>
			<Columns3 class="size-4" aria-hidden="true" />
			<span>Pipeline</span>
		</a>
		<a
			href="{base}/contacts"
			class="flex flex-col items-center gap-0.5 px-3 py-1 text-[11px] {isActive('/contacts') ? 'font-medium text-ink' : 'text-ink-muted'}"
		>
			<Users class="size-4" aria-hidden="true" />
			<span>Contactos</span>
		</a>
		<a
			href="{base}/ai"
			class="flex flex-col items-center gap-0.5 px-3 py-1 text-[11px] {isActive('/ai') ? 'font-medium text-ink' : 'text-ink-muted'}"
		>
			<Bot class="size-4" aria-hidden="true" />
			<span>Asistente</span>
		</a>
		<a
			href="{base}/settings"
			class="flex flex-col items-center gap-0.5 px-3 py-1 text-[11px] {isActive('/settings') ? 'font-medium text-ink' : 'text-ink-muted'}"
		>
			<Settings class="size-4" aria-hidden="true" />
			<span>Ajustes</span>
		</a>
	</nav>
</div>
