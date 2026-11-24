<script lang="ts">
	interface Props {
		size?: 'sm' | 'md';
	}
	let { size = 'md' }: Props = $props();
</script>

<span class="inline-flex items-center gap-2 font-medium tracking-tight text-ink">
	<svg
		aria-hidden="true"
		class={size === 'sm' ? 'size-4.5' : 'size-5'}
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
	>
		<circle cx="12" cy="12" r="9" />
	</svg>
	<span class={size === 'sm' ? 'text-base' : 'text-[19px]'}>okeo</span>
</span>
