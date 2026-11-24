<script lang="ts">
	import { enhance } from '$app/forms';
	import BrandLogo from '$lib/components/shared/BrandLogo.svelte';

	let { data, form } = $props();
	let pending = $state(false);

	let errorBanner = $derived(
		form?.error ??
			(data.authError === 'auth_callback_failed'
				? 'El enlace de acceso expiró o ya fue utilizado. Solicita uno nuevo.'
				: data.authError === 'supabase_not_configured'
					? 'Supabase no está configurado en este entorno.'
					: '')
	);
</script>

<svelte:head>
	<title>Entra a Okeo</title>
</svelte:head>

<div class="flex min-h-dvh flex-col bg-canvas px-6 py-7 text-ink sm:px-10">
	<header>
		<a href="/" class="inline-flex items-center">
			<BrandLogo />
		</a>
	</header>

	<main class="mx-auto flex w-full max-w-[360px] flex-1 flex-col justify-center py-12">
		<h1 class="text-[32px] font-semibold tracking-tight text-ink">Entra a Okeo.</h1>
		<p class="mt-2 text-sm text-ink-secondary">Tu trabajo, en un solo lugar.</p>

		<form
			method="POST"
			action={data.supabaseConfigured ? '?/googleOAuth' : '?/googleDemo'}
			use:enhance
			class="mt-8"
		>
			<input type="hidden" name="next" value={data.nextPath} />
			<button
				type="submit"
				class="flex h-11 w-full items-center justify-center gap-2.5 rounded-lg border border-border bg-canvas text-sm font-medium text-ink transition-colors hover:bg-surface"
			>
				<span class="font-semibold" aria-hidden="true">G</span>
				<span>Continuar con Google</span>
			</button>
		</form>

		<div class="my-6 flex items-center gap-3 text-xs text-ink-muted">
			<div class="h-px flex-1 bg-border"></div>
			<span>o</span>
			<div class="h-px flex-1 bg-border"></div>
		</div>

		{#if form?.sent}
			<div role="status" class="rounded-xl border border-border bg-sage-soft p-4 text-sm text-ink">
				<p class="font-medium">Te enviamos un enlace a {form.email}</p>
				{#if form.liveAuth}
					<p class="mt-1 text-xs text-ink-secondary">
						Revisa tu bandeja de entrada y abre el enlace para iniciar sesión en Okeo.
					</p>
				{:else}
					<p class="mt-1 text-xs text-ink-secondary">
						En este entorno local puedes entrar directo al workspace demo o crear uno nuevo.
					</p>
					<div class="mt-4 flex flex-wrap gap-2">
						<a
							href="/wunderside/inbox"
							class="inline-flex h-9 items-center rounded-lg bg-cta px-4 text-xs font-medium text-white hover:bg-cta-hover"
						>
							Entrar a Wunderside
						</a>
						<a
							href="/onboarding"
							class="inline-flex h-9 items-center rounded-lg border border-border bg-canvas px-4 text-xs font-medium text-ink hover:bg-surface"
						>
							Crear workspace
						</a>
					</div>
				{/if}
			</div>
		{:else}
			<form
				method="POST"
				action="?/magicLink"
				use:enhance={() => {
					pending = true;
					return async ({ update }) => {
						pending = false;
						await update();
					};
				}}
				class="space-y-4"
			>
				<input type="hidden" name="next" value={data.nextPath} />
				<div>
					<label for="login-email" class="block text-xs font-medium text-ink-secondary">
						Tu correo
					</label>
					<input
						id="login-email"
						name="email"
						type="email"
						required
						autocomplete="email"
						autocorrect="off"
						autocapitalize="none"
						spellcheck="false"
						placeholder="tu@negocio.com"
						aria-invalid={errorBanner ? 'true' : undefined}
						class="mt-1.5 h-11 w-full rounded-lg border border-border px-3.5 text-sm placeholder:text-ink-muted"
					/>
					{#if errorBanner}
						<p role="alert" class="mt-1.5 text-xs text-amber-ink">{errorBanner}</p>
					{/if}
				</div>

				<button
					type="submit"
					disabled={pending}
					class="h-11 w-full rounded-lg bg-cta text-sm font-medium text-white transition-colors hover:bg-cta-hover disabled:opacity-60"
				>
					{pending ? 'Enviando enlace...' : 'Recibir enlace de acceso'}
				</button>

				<p class="text-xs text-ink-muted">
					Te enviaremos un enlace para entrar o crear tu cuenta.
				</p>
			</form>
		{/if}

		<div class="mt-8 border-t border-border pt-5">
			<a
				href="/wunderside/inbox"
				class="text-xs font-medium text-ink-secondary hover:text-ink hover:underline"
			>
				Explorar demo interactivo (Wunderside) →
			</a>
		</div>

		<p class="mt-6 text-[11px] text-ink-muted">
			Al continuar aceptas los términos y la política de privacidad.
		</p>
	</main>
</div>
