<script lang="ts">
	import { enhance } from '$app/forms';
	import BrandLogo from '$lib/components/shared/BrandLogo.svelte';

	interface GoogleCredentialResponse {
		credential: string;
	}

	interface GoogleAccountsId {
		initialize: (config: {
			client_id: string;
			nonce: string;
			ux_mode?: 'popup' | 'redirect';
			context?: 'signin' | 'signup' | 'use';
			itp_support?: boolean;
			use_fedcm_for_prompt?: boolean;
			callback: (response: GoogleCredentialResponse) => void | Promise<void>;
		}) => void;
		renderButton: (
			parent: HTMLElement,
			options: {
				type?: 'standard' | 'icon';
				theme?: 'outline' | 'filled_blue' | 'filled_black';
				size?: 'large' | 'medium' | 'small';
				text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin';
				shape?: 'rectangular' | 'pill' | 'circle' | 'square';
				logo_alignment?: 'left' | 'center';
				locale?: string;
				width?: number;
			}
		) => void;
	}

	let { data, form } = $props();
	let pending = $state(false);
	let googlePending = $state(false);
	let googleError = $state('');
	let gisReady = $state(false);
	let gisFailed = $state(false);
	let googleButtonEl = $state<HTMLDivElement | null>(null);

	let errorBanner = $derived(
		googleError ||
			form?.error ||
			(data.authError === 'auth_callback_failed'
				? 'El enlace de acceso expiró o ya fue utilizado. Solicita uno nuevo.'
				: data.authError === 'supabase_not_configured'
					? 'Supabase no está configurado en este entorno.'
					: '')
	);

	async function generateNoncePair(): Promise<{ rawNonce: string; hashedNonce: string }> {
		const bytes = new Uint8Array(32);
		crypto.getRandomValues(bytes);
		let binary = '';
		for (const byte of bytes) {
			binary += String.fromCharCode(byte);
		}
		const rawNonce = btoa(binary);
		const encoded = new TextEncoder().encode(rawNonce);
		const digest = await crypto.subtle.digest('SHA-256', encoded);
		const hashedNonce = Array.from(new Uint8Array(digest))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('');
		return { rawNonce, hashedNonce };
	}

	function getGoogleAccountsId(): GoogleAccountsId | null {
		const win = window as unknown as { google?: { accounts?: { id?: GoogleAccountsId } } };
		return win.google?.accounts?.id ?? null;
	}

	function loadGoogleIdentityScript(): Promise<GoogleAccountsId> {
		const existingApi = getGoogleAccountsId();
		if (existingApi) return Promise.resolve(existingApi);

		return new Promise((resolve, reject) => {
			const existingScript = document.querySelector<HTMLScriptElement>(
				'script[src="https://accounts.google.com/gsi/client"]'
			);
			const onReady = () => {
				const api = getGoogleAccountsId();
				if (api) resolve(api);
				else reject(new Error('Google Identity Services no disponible'));
			};

			if (existingScript) {
				existingScript.addEventListener('load', onReady, { once: true });
				existingScript.addEventListener('error', () => reject(new Error('GIS load error')), {
					once: true
				});
				return;
			}

			const script = document.createElement('script');
			script.src = 'https://accounts.google.com/gsi/client';
			script.async = true;
			script.defer = true;
			script.addEventListener('load', onReady, { once: true });
			script.addEventListener('error', () => reject(new Error('GIS load error')), { once: true });
			document.head.appendChild(script);
		});
	}

	$effect(() => {
		if (
			typeof window === 'undefined' ||
			!data.supabaseConfigured ||
			!data.googleClientId ||
			!googleButtonEl
		) {
			return;
		}
		if (!window.crypto?.subtle) {
			gisFailed = true;
			return;
		}

		let cancelled = false;
		const targetEl = googleButtonEl;

		(async () => {
			try {
				const [googleId, noncePair] = await Promise.all([
					loadGoogleIdentityScript(),
					generateNoncePair()
				]);
				if (cancelled) return;

				googleId.initialize({
					client_id: data.googleClientId,
					nonce: noncePair.hashedNonce,
					ux_mode: 'popup',
					context: 'signin',
					itp_support: true,
					use_fedcm_for_prompt: true,
					callback: async (response) => {
						googlePending = true;
						googleError = '';
						try {
							const res = await fetch('/auth/google', {
								method: 'POST',
								headers: { 'Content-Type': 'application/json' },
								credentials: 'same-origin',
								body: JSON.stringify({
									credential: response.credential,
									nonce: noncePair.rawNonce,
									next: data.nextPath
								})
							});
							const payload = (await res.json().catch(() => ({}))) as {
								error?: string;
								redirectTo?: string;
							};
							if (!res.ok || !payload.redirectTo) {
								googleError = payload.error ?? 'No pudimos validar tu acceso con Google.';
								googlePending = false;
								return;
							}
							window.location.href = payload.redirectTo;
						} catch {
							googleError = 'Error de red al iniciar sesión con Google.';
							googlePending = false;
						}
					}
				});

				targetEl.innerHTML = '';
				const width = Math.min(360, Math.max(240, Math.floor(targetEl.clientWidth || 360)));
				googleId.renderButton(targetEl, {
					type: 'standard',
					theme: 'outline',
					size: 'large',
					text: 'continue_with',
					shape: 'rectangular',
					logo_alignment: 'left',
					locale: 'es',
					width
				});
				gisReady = true;
			} catch {
				if (!cancelled) {
					gisFailed = true;
				}
			}
		})();

		return () => {
			cancelled = true;
		};
	});
</script>

<svelte:head>
	<title>Entra a Okeo</title>
</svelte:head>

<div class="flex min-h-dvh flex-col bg-canvas px-6 py-7 text-ink sm:px-10">
	<header>
		<a href={data.marketingHomeUrl} class="inline-flex items-center">
			<BrandLogo />
		</a>
	</header>

	<main class="mx-auto flex w-full max-w-[360px] flex-1 flex-col justify-center py-12">
		<h1 class="text-[32px] font-semibold tracking-tight text-ink">Entra a Okeo.</h1>
		<p class="mt-2 text-sm text-ink-secondary">Tu trabajo, en un solo lugar.</p>

		{#if data.supabaseConfigured && data.googleClientId && !gisFailed}
			<div class="mt-8">
				{#if googlePending}
					<div class="flex h-11 w-full items-center justify-center rounded-lg border border-border bg-surface text-sm font-medium text-ink-secondary">
						Iniciando sesión con Google...
					</div>
				{:else}
					<div class="relative min-h-[44px] w-full">
						{#if !gisReady}
							<div
								aria-hidden="true"
								class="flex h-11 w-full items-center justify-center gap-2.5 rounded-lg border border-border bg-canvas text-sm font-medium text-ink-secondary"
							>
								<span class="font-semibold">G</span>
								<span>Continuar con Google</span>
							</div>
						{/if}
						<div
							bind:this={googleButtonEl}
							class="flex w-full justify-center {gisReady ? '' : 'sr-only'}"
						></div>
					</div>
				{/if}
			</div>
		{:else}
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
		{/if}

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
			Al continuar aceptas los
			<a href="{data.marketingOriginPrefix}/terminos" class="underline underline-offset-2 hover:text-ink">
				términos
			</a>
			y la
			<a href="{data.marketingOriginPrefix}/privacidad" class="underline underline-offset-2 hover:text-ink">
				política de privacidad
			</a>.
		</p>
	</main>
</div>
