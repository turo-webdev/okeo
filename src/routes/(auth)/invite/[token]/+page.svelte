<script lang="ts">
	import { enhance } from '$app/forms';
	import BrandLogo from '$lib/components/shared/BrandLogo.svelte';
	import { formatRoleLabel } from '$lib/utils/format';
	import { Clock, Lock, Users, Check } from 'lucide-svelte';

	let { data, form } = $props();

	let inv = $derived(form?.invitation ?? data.invitation);
	let state = $derived.by(() => {
		if (form?.accepted || inv?.status === 'accepted') return 'accepted';
		if (!inv || inv.status === 'revoked') return 'revoked';
		if (inv.status === 'expired') return 'expired';
		if (data.requiresLogin) return 'login_required';
		if (data.currentAccountEmail.toLowerCase() !== inv.email.toLowerCase()) return 'mismatch';
		return 'valid';
	});
</script>

<svelte:head>
	<title>Invitación · okeo</title>
</svelte:head>

<div class="flex min-h-dvh flex-col bg-canvas px-6 py-7 text-ink sm:px-10">
	<header class="flex items-center justify-between">
		<a href={data.marketingHomeUrl}><BrandLogo /></a>
		<div class="flex flex-wrap gap-2 text-xs text-ink-muted">
			<span>Estados:</span>
			<a href="/invite/valid" class="hover:text-ink {data.token === 'valid' ? 'font-medium text-ink underline' : ''}">Válida</a>
			<a href="/invite/expired" class="hover:text-ink {data.token === 'expired' ? 'font-medium text-ink underline' : ''}">Vencida</a>
			<a href="/invite/mismatch" class="hover:text-ink {data.token === 'mismatch' ? 'font-medium text-ink underline' : ''}">Otro correo</a>
			<a href="/invite/revoked" class="hover:text-ink {data.token === 'revoked' ? 'font-medium text-ink underline' : ''}">Revocada</a>
		</div>
	</header>

	<main class="mx-auto flex w-full max-w-[400px] flex-1 items-center justify-center py-10">
		<div class="w-full rounded-2xl border border-border bg-canvas p-7">
			{#if state === 'accepted' && inv}
				<div class="flex items-center gap-2 text-sage-ink">
					<Check class="size-4" aria-hidden="true" />
					<span class="text-xs font-medium">Invitación aceptada</span>
				</div>
				<h1 class="mt-3 text-2xl font-semibold text-ink">
					Ya eres parte de {inv.organization_name}.
				</h1>
				<p class="mt-2 text-sm text-ink-secondary">
					Tu rol es {formatRoleLabel(inv.role)}.<br />
					Tu equipo y sus conversaciones te esperan.
				</p>
				<a
					href="/{inv.organization_slug}/inbox"
					class="mt-6 flex h-11 w-full items-center justify-center rounded-lg bg-cta text-sm font-medium text-white hover:bg-cta-hover"
				>
					Ir al Inbox
				</a>
				<p class="mt-4 text-xs text-ink-muted">Workspace · {inv.organization_name}</p>
			{:else if state === 'expired'}
				<Clock class="size-5 text-ink-muted" aria-hidden="true" />
				<h1 class="mt-4 text-2xl font-semibold text-ink">Esta invitación venció.</h1>
				<p class="mt-2 text-sm text-ink-secondary">
					Pide un enlace nuevo para unirte a {inv?.organization_name ?? 'este workspace'}.<br />
					Se enviará a {inv?.email ?? 'tu correo'}.
				</p>
				{#if form?.requestedNew}
					<p class="mt-4 rounded-lg bg-sage-soft p-3 text-xs text-ink">
						Solicitud registrada para {form.email}.
					</p>
				{:else}
					<form method="POST" action="?/requestNew" use:enhance class="mt-6">
						<button
							type="submit"
							class="h-11 w-full rounded-lg bg-cta text-sm font-medium text-white hover:bg-cta-hover"
						>
							Solicitar nuevo enlace
						</button>
					</form>
				{/if}
				<a href="/login" class="mt-4 inline-block text-xs text-ink-muted hover:text-ink">
					Volver al inicio de sesión
				</a>
			{:else if state === 'login_required' && inv}
				<Users class="size-5 text-ink-muted" aria-hidden="true" />
				<h1 class="mt-4 text-2xl font-semibold text-ink">Inicia sesión para unirte.</h1>
				<p class="mt-2 text-sm text-ink-secondary">
					Te invitaron a <strong>{inv.organization_name}</strong> con el correo{' '}
					<strong>{inv.email}</strong>.
				</p>
				<a
					href="/login?next=/invite/{data.token}"
					class="mt-6 flex h-11 w-full items-center justify-center rounded-lg bg-cta text-sm font-medium text-white hover:bg-cta-hover"
				>
					Iniciar sesión o crear cuenta
				</a>
			{:else if state === 'mismatch' && inv}
				<Users class="size-5 text-ink-muted" aria-hidden="true" />
				<h1 class="mt-4 text-2xl font-semibold text-ink">Usa el correo invitado.</h1>
				<p class="mt-2 text-sm text-ink-secondary">
					Esta invitación es para <strong>{inv.email}</strong>.<br />
					Ahora estás usando {data.currentAccountEmail}.
				</p>
				<a
					href={data.isDemoToken ? `/invite/${data.token}?account=match` : `/login?next=/invite/${data.token}`}
					class="mt-6 flex h-11 w-full items-center justify-center rounded-lg bg-cta text-sm font-medium text-white hover:bg-cta-hover"
				>
					Cambiar de cuenta
				</a>
				<p class="mt-4 text-xs text-ink-muted">¿Otro correo? Pide una nueva invitación.</p>
			{:else if state === 'revoked'}
				<Lock class="size-5 text-ink-muted" aria-hidden="true" />
				<h1 class="mt-4 text-2xl font-semibold text-ink">Este enlace ya no está activo.</h1>
				<p class="mt-2 text-sm text-ink-secondary">
					Quien administra este espacio retiró la invitación.<br />
					Contacta al equipo si todavía necesitas entrar.
				</p>
				<a
					href="/login"
					class="mt-6 flex h-11 w-full items-center justify-center rounded-lg bg-cta text-sm font-medium text-white hover:bg-cta-hover"
				>
					Volver al inicio de sesión
				</a>
			{:else if inv}
				<div class="mx-auto flex size-11 items-center justify-center rounded-full bg-surface text-sm font-semibold text-ink">
					{inv.organization_name.charAt(0).toUpperCase()}
				</div>
				<h1 class="mt-5 text-center text-2xl font-semibold text-ink">
					Te invitaron a {inv.organization_name}.
				</h1>
				<p class="mt-2 text-center text-sm text-ink-secondary">
					{inv.invited_by_name} quiere trabajar contigo en Okeo.
				</p>

				<hr class="my-5 border-border" />

				<div>
					<p class="text-xs text-ink-muted">Tu rol</p>
					<span class="mt-1.5 inline-block rounded-md bg-sage-soft px-2.5 py-1 text-xs font-medium text-sage-ink">
						{formatRoleLabel(inv.role)}
					</span>
					<p class="mt-2.5 text-sm leading-relaxed text-ink-secondary">
						Podrás responder conversaciones y dar seguimiento a contactos y oportunidades.
					</p>
				</div>

				<div class="mt-5">
					<p class="text-xs text-ink-muted">Vas a unirte con esta cuenta</p>
					<p class="mt-1 text-sm font-medium text-ink">{inv.email}</p>
					<a href="/login" class="mt-1 inline-block text-xs text-ink-muted hover:text-ink">
						Cambiar de cuenta
					</a>
				</div>

				{#if form?.error}
					<p
						role="alert"
						class="mt-4 rounded-lg border border-coral/30 bg-coral/10 px-3 py-2 text-xs text-coral"
					>
						{form.error}
					</p>
				{/if}

				<form method="POST" action="?/accept" use:enhance class="mt-6">
					<button
						type="submit"
						class="h-11 w-full rounded-lg bg-cta text-sm font-medium text-white transition-colors hover:bg-cta-hover"
					>
						Aceptar invitación
					</button>
				</form>
				<p class="mt-4 text-center text-xs text-ink-muted">
					Solo tendrás acceso a este workspace.
				</p>
			{/if}
		</div>
	</main>
</div>
