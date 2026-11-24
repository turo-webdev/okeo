<script lang="ts">
	import { AlertTriangle, Unplug, Bot, CreditCard } from 'lucide-svelte';

	interface Props {
		variant: 'disconnected_channel' | 'quota_exhausted' | 'billing_inactive' | 'offline';
		channelName?: string;
		actionHref?: string;
		onAction?: () => void;
		dismissible?: boolean;
		onDismiss?: () => void;
	}

	let {
		variant,
		channelName = 'Messenger',
		actionHref,
		onAction,
		dismissible = false,
		onDismiss
	}: Props = $props();
</script>

<div
	role="status"
	class="flex flex-wrap items-center justify-between gap-3 border-b border-note-border bg-note-soft px-4 py-2.5 text-xs text-ink sm:px-6"
>
	<div class="flex items-center gap-2.5">
		{#if variant === 'disconnected_channel'}
			<Unplug class="size-4 shrink-0 text-amber-ink" aria-hidden="true" />
			<span>
				<strong>{channelName} necesita reconectarse.</strong> Tus otras conversaciones siguen disponibles.
			</span>
		{:else if variant === 'billing_inactive'}
			<CreditCard class="size-4 shrink-0 text-amber-ink" aria-hidden="true" />
			<span>
				<strong>Tu trial terminó o hay un pago pendiente.</strong> Tus conversaciones siguen visibles; activa o regulariza tu plan para usar canales e IA.
			</span>
		{:else if variant === 'quota_exhausted'}
			<Bot class="size-4 shrink-0 text-amber-ink" aria-hidden="true" />
			<span>
				<strong>Respuestas de IA agotadas este mes.</strong> Puedes seguir recibiendo y respondiendo mensajes manualmente.
			</span>
		{:else}
			<AlertTriangle class="size-4 shrink-0 text-amber-ink" aria-hidden="true" />
			<span>
				<strong>Sin conexión.</strong> Tu borrador sigue guardado en este dispositivo.
			</span>
		{/if}
	</div>

	<div class="flex items-center gap-3">
		{#if actionHref}
			<a
				href={actionHref}
				class="rounded-md bg-cta px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-cta-hover"
			>
				{variant === 'disconnected_channel'
					? `Reconectar ${channelName}`
					: variant === 'billing_inactive'
						? 'Activar plan'
						: 'Ver plan'}
			</a>
		{:else if onAction}
			<button
				type="button"
				onclick={onAction}
				class="rounded-md bg-cta px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-cta-hover"
			>
				Reintentar
			</button>
		{/if}
		{#if dismissible && onDismiss}
			<button type="button" onclick={onDismiss} class="text-ink-muted hover:text-ink">
				Ocultar
			</button>
		{/if}
	</div>
</div>
