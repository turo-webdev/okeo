<script lang="ts">
	import { enhance } from '$app/forms';
	import BrandLogo from '$lib/components/shared/BrandLogo.svelte';
	import type { Platform } from '$lib/types/domain';
	import { Check, ChevronRight, ArrowRight } from 'lucide-svelte';

	let { data, form } = $props();

	let businessName = $state('Wunderside');
	let selectedPlatform = $state<Platform>('whatsapp');
	let customizeOpen = $state(false);
	let industry = $state('Servicios profesionales');
	let language = $state<'es' | 'en'>('es');
	let aiMode = $state<'copilot' | 'auto'>('copilot');
	let initialKnowledge = $state('');
	let pending = $state(false);

	const platforms: Array<{ id: Platform; label: string; hint: string }> = [
		{ id: 'whatsapp', label: 'WhatsApp', hint: 'Embedded Signup de Meta (WABA)' },
		{ id: 'instagram', label: 'Instagram', hint: 'Cuenta Profesional vinculada a Facebook' },
		{ id: 'facebook', label: 'Messenger', hint: 'Página de Facebook' }
	];
</script>

<svelte:head>
	<title>Empezar · okeo</title>
</svelte:head>

<div class="flex min-h-dvh flex-col bg-canvas px-6 py-7 text-ink sm:px-10">
	<header class="flex items-center justify-between">
		<a href={data.marketingHomeUrl}><BrandLogo /></a>
		<a href="/wunderside/inbox" class="text-xs text-ink-muted hover:text-ink">
			Ir al demo existente
		</a>
	</header>

	<main class="mx-auto flex w-full max-w-[440px] flex-1 flex-col justify-center py-12">
		<h1 class="text-[32px] font-semibold tracking-tight text-ink">Vamos a empezar.</h1>
		<p class="mt-2 text-sm text-ink-secondary">Solo necesitamos tu espacio y un canal.</p>

		<form
			method="POST"
			use:enhance={() => {
				pending = true;
				return async ({ update }) => {
					pending = false;
					await update();
				};
			}}
			class="mt-8 space-y-6"
		>
			<div>
				<label for="org-name" class="block text-xs font-medium text-ink-secondary">
					Nombre de tu negocio
				</label>
				<input
					id="org-name"
					name="name"
					type="text"
					required
					bind:value={businessName}
					class="mt-1.5 h-11 w-full rounded-lg border border-border px-3.5 text-sm text-ink"
				/>
			</div>

			<fieldset>
				<legend class="text-xs font-medium text-ink-secondary">Conecta un canal</legend>
				<input type="hidden" name="platform" value={selectedPlatform} />
				<div class="mt-2 grid grid-cols-3 gap-3">
					{#each platforms as p (p.id)}
						<button
							type="button"
							onclick={() => (selectedPlatform = p.id)}
							aria-pressed={selectedPlatform === p.id}
							class="flex h-12 items-center justify-between rounded-lg border px-3.5 text-sm transition-colors {selectedPlatform === p.id ? 'border-transparent bg-sage-soft font-medium text-ink' : 'border-border bg-canvas text-ink-secondary hover:bg-surface'}"
						>
							<span>{p.label}</span>
							{#if selectedPlatform === p.id}
								<Check class="size-3.5 text-sage-ink" aria-hidden="true" />
							{/if}
						</button>
					{/each}
				</div>
				<p class="mt-2 text-[11px] text-ink-muted">
					{platforms.find((p) => p.id === selectedPlatform)?.hint} · Explora tu workspace y activa tu plan ($9 USD/canal/mes) al conectar un canal real.
				</p>
			</fieldset>

			<!-- Personalización progresiva (09_Empezar.png) -->
			<div>
				<button
					type="button"
					onclick={() => (customizeOpen = !customizeOpen)}
					aria-expanded={customizeOpen}
					class="flex w-full items-center justify-between py-1 text-xs font-medium text-ink-secondary hover:text-ink"
				>
					<span>Personalizar</span>
					<ChevronRight
						class="size-4 transition-transform {customizeOpen ? 'rotate-90' : ''}"
						aria-hidden="true"
					/>
				</button>

				{#if customizeOpen}
					<div class="mt-3 space-y-4 rounded-xl border border-border bg-sidebar/70 p-4">
						<div class="grid gap-3 sm:grid-cols-2">
							<div>
								<label for="org-industry" class="block text-xs text-ink-secondary">Rubro</label>
								<input
									id="org-industry"
									name="industry"
									type="text"
									bind:value={industry}
									class="mt-1 h-9 w-full rounded-lg border border-border bg-canvas px-3 text-xs"
								/>
							</div>
							<div>
								<label for="org-lang" class="block text-xs text-ink-secondary">Idioma</label>
								<select
									id="org-lang"
									name="language"
									bind:value={language}
									class="mt-1 h-9 w-full rounded-lg border border-border bg-canvas px-2.5 text-xs"
								>
									<option value="es">Español</option>
									<option value="en">English</option>
								</select>
							</div>
						</div>

						<div>
							<span class="block text-xs text-ink-secondary">Modo del asistente</span>
							<input type="hidden" name="mode" value={aiMode} />
							<div class="mt-1.5 inline-flex rounded-lg border border-border bg-canvas p-0.5 text-xs">
								<button
									type="button"
									onclick={() => (aiMode = 'copilot')}
									class="rounded-md px-3 py-1.5 {aiMode === 'copilot' ? 'bg-sage-soft font-medium text-ink' : 'text-ink-secondary'}"
								>
									Copiloto (recomendado)
								</button>
								<button
									type="button"
									onclick={() => (aiMode = 'auto')}
									class="rounded-md px-3 py-1.5 {aiMode === 'auto' ? 'bg-sage-soft font-medium text-ink' : 'text-ink-secondary'}"
								>
									Automático
								</button>
							</div>
						</div>

						<div>
							<label for="org-kb" class="block text-xs text-ink-secondary">
								Información inicial (FAQs o servicios)
							</label>
							<textarea
								id="org-kb"
								name="initialKnowledge"
								rows="3"
								bind:value={initialKnowledge}
								placeholder="Horarios, servicios principales, formas de pago..."
								class="mt-1 w-full rounded-lg border border-border bg-canvas p-2.5 text-xs"
							></textarea>
						</div>
					</div>
				{:else}
					<input type="hidden" name="industry" value={industry} />
					<input type="hidden" name="language" value={language} />
					<input type="hidden" name="mode" value={aiMode} />
					<input type="hidden" name="initialKnowledge" value={initialKnowledge} />
				{/if}
			</div>

			{#if form?.error}
				<p role="alert" class="text-xs text-amber-ink">{form.error}</p>
			{/if}

			<button
				type="submit"
				disabled={pending}
				class="flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-cta text-sm font-medium text-white transition-colors hover:bg-cta-hover disabled:opacity-60"
			>
				<ArrowRight class="size-4" aria-hidden="true" />
				<span>{pending ? 'Creando espacio...' : 'Entrar a mi Inbox'}</span>
			</button>

			<p class="text-xs text-ink-muted">
				Puedes añadir información, equipo y más canales después.
			</p>
		</form>
	</main>
</div>
