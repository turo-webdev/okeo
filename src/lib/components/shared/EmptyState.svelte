<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title: string;
		description: string;
		actionLabel?: string;
		actionHref?: string;
		onAction?: () => void;
		secondaryLabel?: string;
		secondaryHref?: string;
		onSecondary?: () => void;
		icon?: Snippet;
	}

	let {
		title,
		description,
		actionLabel,
		actionHref,
		onAction,
		secondaryLabel,
		secondaryHref,
		onSecondary,
		icon
	}: Props = $props();
</script>

<div class="mx-auto flex max-w-md flex-col items-start rounded-xl border border-border bg-canvas p-7">
	{#if icon}
		<div class="mb-4 text-ink-secondary">
			{@render icon()}
		</div>
	{/if}
	<h2 class="text-base font-semibold text-ink">{title}</h2>
	<p class="mt-1.5 text-sm leading-relaxed text-ink-secondary">{description}</p>

	{#if actionLabel}
		<div class="mt-5 flex flex-wrap items-center gap-3">
			{#if actionHref}
				<a
					href={actionHref}
					class="inline-flex h-10 items-center justify-center rounded-lg bg-cta px-4 text-sm font-medium text-white transition-colors hover:bg-cta-hover"
				>
					{actionLabel}
				</a>
			{:else if onAction}
				<button
					type="button"
					onclick={onAction}
					class="inline-flex h-10 items-center justify-center rounded-lg bg-cta px-4 text-sm font-medium text-white transition-colors hover:bg-cta-hover"
				>
					{actionLabel}
				</button>
			{/if}

			{#if secondaryLabel && secondaryHref}
				<a href={secondaryHref} class="text-sm text-ink-secondary hover:text-ink">
					{secondaryLabel}
				</a>
			{:else if secondaryLabel && onSecondary}
				<button type="button" onclick={onSecondary} class="text-sm text-ink-secondary hover:text-ink">
					{secondaryLabel}
				</button>
			{/if}
		</div>
	{/if}
</div>
