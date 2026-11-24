<script lang="ts">
	import type { Snippet } from 'svelte';
	import { X } from 'lucide-svelte';

	interface Props {
		open: boolean;
		title: string;
		subtitle?: string;
		closedBy?: 'any' | 'closerequest' | 'none';
		onClose?: () => void;
		children: Snippet;
	}

	let {
		open = $bindable(false),
		title,
		subtitle,
		closedBy = 'any',
		onClose,
		children
	}: Props = $props();

	let dialogEl: HTMLDialogElement | undefined = $state();
	const titleId = $props.id();

	$effect(() => {
		const el = dialogEl;
		if (!el) return;
		if (open && !el.open) {
			el.showModal();
		} else if (!open && el.open) {
			el.close();
		}
	});

	$effect(() => {
		const el = dialogEl;
		if (!el) return;
		if (closedBy !== 'any' || 'closedBy' in HTMLDialogElement.prototype) return;

		let pressedOutside = false;
		const isOutside = (e: PointerEvent) => {
			const r = el.getBoundingClientRect();
			return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
		};
		const onDown = (e: PointerEvent) => {
			pressedOutside = isOutside(e);
		};
		const onUp = (e: PointerEvent) => {
			if (pressedOutside && isOutside(e)) el.close();
		};
		el.addEventListener('pointerdown', onDown);
		el.addEventListener('pointerup', onUp);
		return () => {
			el.removeEventListener('pointerdown', onDown);
			el.removeEventListener('pointerup', onUp);
		};
	});

	function handleClose() {
		if (dialogEl) dialogEl.returnValue = '';
		open = false;
		onClose?.();
	}
</script>

<dialog
	bind:this={dialogEl}
	aria-labelledby={titleId}
	{...({ closedby: closedBy } as Record<string, string>)}
	onclose={handleClose}
	class="m-auto w-[min(92vw,460px)] rounded-xl border border-border bg-canvas p-6 text-ink shadow-xl"
>
	<div class="flex items-start justify-between gap-4">
		<div>
			<h2 id={titleId} class="text-lg font-semibold text-ink">{title}</h2>
			{#if subtitle}
				<p class="mt-1 text-xs text-ink-muted">{subtitle}</p>
			{/if}
		</div>
		<button
			type="button"
			onclick={() => dialogEl?.close()}
			aria-label="Cerrar ventana"
			class="rounded-md p-1.5 text-ink-muted transition-colors hover:bg-surface hover:text-ink"
		>
			<X class="size-4" aria-hidden="true" />
		</button>
	</div>

	<div class="mt-5">
		{@render children()}
	</div>
</dialog>
