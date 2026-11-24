<script lang="ts">
	import type { Snippet } from 'svelte';
	import { X } from 'lucide-svelte';

	interface Props {
		open: boolean;
		title: string;
		subtitle?: string;
		widthClass?: string;
		onClose: () => void;
		children: Snippet;
	}

	let {
		open,
		title,
		subtitle,
		widthClass = 'lg:w-[340px]',
		onClose,
		children
	}: Props = $props();
</script>

{#if open}
	<aside
		aria-label={title}
		class={`fixed inset-0 z-40 flex flex-col bg-canvas lg:static lg:inset-auto lg:z-auto lg:shrink-0 lg:border-l lg:border-border ${widthClass} lg:h-full`}
	>
		<div class="flex items-start justify-between gap-4 border-b border-border px-6 py-5 lg:border-b-0 lg:pb-3">
			<div class="min-w-0">
				<h2 class="text-sm font-medium text-ink-muted">{title}</h2>
				{#if subtitle}
					<p class="mt-0.5 text-xs text-ink-muted">{subtitle}</p>
				{/if}
			</div>
			<button
				type="button"
				onclick={onClose}
				aria-label={`Cerrar ${title}`}
				class="rounded-md p-1 text-ink-muted transition-colors hover:bg-surface hover:text-ink"
			>
				<X class="size-4" aria-hidden="true" />
			</button>
		</div>

		<div class="flex-1 overflow-y-auto px-6 pb-8">
			{@render children()}
		</div>
	</aside>
{/if}
