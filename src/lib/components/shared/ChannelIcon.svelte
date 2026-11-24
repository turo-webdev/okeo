<script lang="ts">
	import type { Platform } from '$lib/types/domain';

	interface Props {
		platform: Platform;
		class?: string;
	}
	let { platform, class: className = 'size-3.5 text-ink-muted' }: Props = $props();
</script>

{#if platform === 'whatsapp'}
	<svg aria-hidden="true" class={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
		<path d="M3 20l1.3-3.9A9 9 0 1 1 7.9 19.7L3 20z" />
		<path d="M9.5 9.5c.3 1.8 2.2 3.7 4 4l1.2-1.2 2 .8-.5 1.8c-2.6.5-6.6-3.5-6.1-6.1l1.8-.5.8 2-1.2 1.2z" />
	</svg>
{:else if platform === 'instagram'}
	<svg aria-hidden="true" class={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
		<rect x="3" y="3" width="18" height="18" rx="5" />
		<circle cx="12" cy="12" r="4" />
		<circle cx="17.5" cy="6.5" r="0.8" fill="currentColor" stroke="none" />
	</svg>
{:else}
	<svg aria-hidden="true" class={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
		<path d="M12 3c5 0 9 3.7 9 8.3 0 4.6-4 8.3-9 8.3-1 0-1.9-.1-2.8-.4L5 21l.9-3.6C4 16 3 13.8 3 11.3 3 6.7 7 3 12 3z" />
		<path d="M8.5 13l2.7-2.8 1.9 1.9L15.8 9.5" />
	</svg>
{/if}
