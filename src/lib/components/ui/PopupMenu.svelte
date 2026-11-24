<script lang="ts">
	import type { Snippet } from 'svelte';
	import { ChevronDown } from 'lucide-svelte';

	interface Props {
		label: string;
		menuLabel?: string;
		triggerClass?: string;
		align?: 'start' | 'end';
		children: Snippet<[{ close: () => void }]>;
		leading?: Snippet;
	}

	let {
		label,
		menuLabel,
		triggerClass = '',
		align = 'start',
		children,
		leading
	}: Props = $props();

	const baseId = $props.id();
	const triggerId = `${baseId}-trigger`;
	const menuId = `${baseId}-menu`;

	let triggerEl: HTMLButtonElement | undefined = $state();
	let popoverEl: HTMLDivElement | undefined = $state();
	let groupEl: HTMLDivElement | undefined = $state();
	let isOpen = $state(false);
	let enterOnOpen = false;

	export function close() {
		popoverEl?.hidePopover?.();
	}

	function positionFallback() {
		if (!triggerEl || !popoverEl) return;
		if (typeof CSS !== 'undefined' && CSS.supports?.('position-area: block-end')) return;
		const rect = triggerEl.getBoundingClientRect();
		const menuRect = popoverEl.getBoundingClientRect();
		const top = Math.min(window.innerHeight - menuRect.height - 8, rect.bottom + 6);
		const rawLeft = align === 'end' ? rect.right - menuRect.width : rect.left;
		const left = Math.max(8, Math.min(window.innerWidth - menuRect.width - 8, rawLeft));
		popoverEl.style.top = `${Math.max(8, top)}px`;
		popoverEl.style.left = `${left}px`;
	}

	function handleToggle(e: Event) {
		const toggleEvent = e as ToggleEvent;
		isOpen = toggleEvent.newState === 'open';
		if (isOpen) {
			positionFallback();
			if (enterOnOpen && groupEl) {
				enterOnOpen = false;
				const first = groupEl.querySelector<HTMLElement>(
					'button:not([disabled]), a[href]'
				);
				first?.focus();
			}
		} else {
			enterOnOpen = false;
		}
	}

	function handleTriggerClick(e: MouseEvent) {
		if (typeof HTMLButtonElement !== 'undefined' && !('commandForElement' in HTMLButtonElement.prototype)) {
			e.preventDefault();
			enterOnOpen = e.detail === 0;
			popoverEl?.togglePopover();
		} else {
			enterOnOpen = e.detail === 0;
		}
	}

	function handleTriggerKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			enterOnOpen = true;
			if (!isOpen) triggerEl?.click();
			else {
				const first = groupEl?.querySelector<HTMLElement>('button:not([disabled]), a[href]');
				first?.focus();
			}
		}
	}

	$effect(() => {
		const group = groupEl;
		if (!group) return;
		if (typeof HTMLElement !== 'undefined' && 'focusGroup' in HTMLElement.prototype) return;

		group.setAttribute('role', 'menu');
		group.querySelectorAll('button:not([role]), a:not([role])').forEach((item) => {
			item.setAttribute('role', 'menuitem');
		});

		const onKeydown = (event: KeyboardEvent) => {
			if (event.key === 'Tab') {
				close();
				return;
			}
			if (event.key === 'Escape') {
				close();
				triggerEl?.focus();
				return;
			}
			if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
			const items = [...group.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]')];
			if (!items.length) return;
			const current = items.indexOf(document.activeElement as HTMLElement);
			const next =
				event.key === 'Home'
					? 0
					: event.key === 'End'
						? items.length - 1
						: (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
			event.preventDefault();
			items[next]?.focus();
		};
		group.addEventListener('keydown', onKeydown);
		return () => group.removeEventListener('keydown', onKeydown);
	});
</script>

<button
	bind:this={triggerEl}
	id={triggerId}
	type="button"
	aria-haspopup="menu"
	aria-expanded={isOpen}
	{...({ commandfor: menuId, command: 'toggle-popover' } as Record<string, string>)}
	onclick={handleTriggerClick}
	onkeydown={handleTriggerKeydown}
	class={`inline-flex items-center gap-1.5 rounded-lg text-sm transition-colors ${triggerClass}`}
>
	{#if leading}
		{@render leading()}
	{/if}
	<span>{label}</span>
	<ChevronDown class="size-3.5 text-ink-muted" aria-hidden="true" />
</button>

<div
	bind:this={popoverEl}
	id={menuId}
	popover="auto"
	ontoggle={handleToggle}
	class="m-0 min-w-[230px] rounded-xl border border-border bg-canvas p-1.5 text-ink shadow-lg"
>
	<div
		bind:this={groupEl}
		aria-labelledby={triggerId}
		aria-label={menuLabel}
		{...({ focusgroup: 'menu nomemory' } as Record<string, string>)}
		class="flex flex-col gap-0.5"
	>
		{@render children({ close })}
	</div>
</div>
