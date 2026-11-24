<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import {
		markWorkspaceViewsStale,
		patchWorkspaceDealStage,
		revalidateWorkspaceViewNow
	} from '$lib/client/workspace-cache';
	import { subscribeOrgRealtime } from '$lib/supabase/realtime';
	import EmptyState from '$lib/components/shared/EmptyState.svelte';
	import ModalDialog from '$lib/components/ui/ModalDialog.svelte';
	import PopupMenu from '$lib/components/ui/PopupMenu.svelte';
	import SidePanel from '$lib/components/ui/SidePanel.svelte';
	import { DEMO_SIM_CONTACT_EMAIL, hasMinRole } from '$lib/types/domain';
	import { formatMoneyCents, formatMoneyShort } from '$lib/utils/format';
	import { Plus, Check, ChevronRight, MessageSquare, Sparkles } from 'lucide-svelte';

	let { data } = $props();

	let selectedStageFilter = $state<'all' | string>('all');
	let selectedOwnerFilter = $state<'all' | 'unassigned' | string>('all');
	let selectedDealId = $state<string | null>(null);
	let newDealOpen = $state(false);
	let draggedDealId = $state<string | null>(null);
	let dragOverStageId = $state<string | null>(null);
	let editingNextStep = $state(false);
	let showNotes = $state(false);
	let showAiExplanation = $state(false);
	let showHistory = $state(false);
	let newNoteBody = $state('');

	let optimisticStages = $state<Record<string, string>>({});
	let moveError = $state('');
	let activeOrgId = '';
	const moveSeqByDeal: Record<string, number> = {};

	$effect(() => {
		if (data.denied) return;
		if (data.org.id !== activeOrgId) {
			activeOrgId = data.org.id;
			optimisticStages = {};
			moveError = '';
		}
	});

	let canAct = $derived(!data.denied && hasMinRole(data.effectiveRole, 'agent'));

	let effectiveDeals = $derived.by(() => {
		if (data.denied) return [];
		return data.deals.map((deal) => {
			const nextStageId = optimisticStages[deal.id];
			if (!nextStageId || nextStageId === deal.stage_id) return deal;
			return { ...deal, stage_id: nextStageId, last_moved_by: 'human' as const };
		});
	});

	let visibleStages = $derived.by(() => {
		if (data.denied) return [];
		const base = data.stages.filter((s) => !s.is_terminal);
		if (selectedStageFilter === 'all') return base;
		return base.filter((s) => s.id === selectedStageFilter);
	});

	let filteredDeals = $derived.by(() => {
		if (data.denied) return [];
		const openStageIds = new Set(data.stages.filter((s) => !s.is_terminal).map((s) => s.id));
		return effectiveDeals.filter((deal) => {
			if (!openStageIds.has(deal.stage_id)) return false;
			if (selectedStageFilter !== 'all' && deal.stage_id !== selectedStageFilter) return false;
			if (selectedOwnerFilter === 'unassigned' && deal.owner_user_id !== null) return false;
			if (
				selectedOwnerFilter !== 'all' &&
				selectedOwnerFilter !== 'unassigned' &&
				deal.owner_user_id !== selectedOwnerFilter
			) {
				return false;
			}
			return true;
		});
	});

	let totalPipelineCents = $derived(
		filteredDeals.reduce((sum, d) => sum + d.value_cents, 0)
	);

	let activeDeal = $derived.by(() => {
		if (data.denied || !selectedDealId) return null;
		return effectiveDeals.find((d) => d.id === selectedDealId) ?? null;
	});

	let activeContact = $derived.by(() => {
		if (data.denied || !activeDeal) return null;
		return data.contacts.find((c) => c.id === activeDeal.contact_id) ?? null;
	});

	let ownerFilterLabel = $derived.by(() => {
		if (data.denied) return 'Todo el equipo';
		if (selectedOwnerFilter === 'all') return 'Todo el equipo';
		if (selectedOwnerFilter === 'unassigned') return 'Sin asignar';
		return (
			data.members.find((m) => m.user_id === selectedOwnerFilter)?.profile.full_name ??
			'Todo el equipo'
		);
	});

	function countDealsForOwner(ownerId: string | null): number {
		if (data.denied) return 0;
		const openStageIds = new Set(data.stages.filter((s) => !s.is_terminal).map((s) => s.id));
		return effectiveDeals.filter(
			(d) => openStageIds.has(d.stage_id) && d.owner_user_id === ownerId
		).length;
	}

	function restoreOptimisticStage(dealId: string, previousStageId: string | undefined) {
		const next = { ...optimisticStages };
		if (previousStageId) {
			next[dealId] = previousStageId;
		} else {
			delete next[dealId];
		}
		optimisticStages = next;
	}

	async function moveDealToStage(dealId: string, stageId: string) {
		if (data.denied || !canAct) return;
		const currentDeal = effectiveDeals.find((d) => d.id === dealId);
		if (!currentDeal || currentDeal.stage_id === stageId) return;

		const orgId = data.org.id;
		const orgSlug = data.org.slug;
		const previousStageId = optimisticStages[dealId];
		const seq = (moveSeqByDeal[dealId] ?? 0) + 1;
		moveSeqByDeal[dealId] = seq;

		moveError = '';
		optimisticStages = { ...optimisticStages, [dealId]: stageId };
		patchWorkspaceDealStage(orgSlug, dealId, stageId);

		const formData = new FormData();
		formData.set('organizationId', orgId);
		formData.set('dealId', dealId);
		formData.set('stageId', stageId);

		try {
			const res = await fetch(`/${orgSlug}/pipeline?/updateDeal`, {
				method: 'POST',
				headers: { 'x-sveltekit-action': 'true' },
				body: formData
			});
			let actionType: string | undefined;
			try {
				const payload = (await res.json()) as { type?: string };
				actionType = payload?.type;
			} catch {
				actionType = undefined;
			}
			if (moveSeqByDeal[dealId] !== seq) return;
			if (!res.ok || actionType === 'failure' || actionType === 'error') {
				throw new Error('Action failed');
			}
			markWorkspaceViewsStale(orgSlug, ['inbox', 'contacts', 'ai']);
		} catch {
			if (moveSeqByDeal[dealId] !== seq) return;
			restoreOptimisticStage(dealId, previousStageId);
			moveError = 'No se pudo mover la oportunidad. Se revirtió el cambio.';
			markWorkspaceViewsStale(orgSlug, ['pipeline', 'inbox', 'contacts', 'ai']);
			void invalidateAll();
		}
	}

	$effect(() => {
		if (data.denied) return;
		return subscribeOrgRealtime({
			organizationId: data.org.id,
			tables: ['deals'],
			onChange: () => {
				revalidateWorkspaceViewNow(data.user.id, data.org.slug, 'pipeline', data.loadNonce);
			}
		});
	});
</script>

<svelte:head>
	<title>Pipeline · {data.denied ? 'okeo' : data.org.name}</title>
</svelte:head>

{#if !data.denied}
	<div class="flex min-h-0 flex-1 overflow-hidden">
		<div class="flex min-w-0 flex-1 flex-col overflow-hidden">
			<!-- Header -->
			<header class="flex flex-wrap items-start justify-between gap-4 px-5 pt-7 pb-4 sm:px-9">
				<div>
					<h1 class="text-[28px] font-semibold tracking-tight text-ink">Pipeline</h1>
					<p class="mt-1 text-sm text-ink-muted">
						{filteredDeals.length} oportunidades · {formatMoneyCents(totalPipelineCents, data.org.currency)}
					</p>
				</div>

				{#if canAct}
					<button
						type="button"
						onclick={() => (newDealOpen = true)}
						class="inline-flex h-10 items-center gap-1.5 rounded-lg bg-cta px-4 text-sm font-medium text-white transition-colors hover:bg-cta-hover"
					>
						<Plus class="size-4" aria-hidden="true" />
						<span>Nueva</span>
					</button>
				{/if}
			</header>

			<!-- Filtros (20_Filtros_y_notas.png) -->
			<div class="flex flex-wrap items-center gap-3 px-5 pb-5 sm:px-9">
				<PopupMenu
					label={selectedStageFilter === 'all'
						? 'Todas las etapas'
						: data.stages.find((s) => s.id === selectedStageFilter)?.name ?? 'Etapa'}
					menuLabel="Filtrar por etapa"
					triggerClass="px-2.5 py-1.5 text-xs text-ink-secondary hover:bg-surface"
				>
					{#snippet children({ close })}
						<button
							type="button"
							onclick={() => {
								selectedStageFilter = 'all';
								close();
							}}
							class="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs hover:bg-surface"
						>
							<span>Todas las etapas</span>
							{#if selectedStageFilter === 'all'}
								<Check class="size-3.5 text-sage-ink" aria-hidden="true" />
							{/if}
						</button>
						{#each data.stages.filter((s) => !s.is_terminal) as stage (stage.id)}
							<button
								type="button"
								onclick={() => {
									selectedStageFilter = stage.id;
									close();
								}}
								class="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs hover:bg-surface"
							>
								<span>{stage.name}</span>
								{#if selectedStageFilter === stage.id}
									<Check class="size-3.5 text-sage-ink" aria-hidden="true" />
								{/if}
							</button>
						{/each}
					{/snippet}
				</PopupMenu>

				<PopupMenu
					label={ownerFilterLabel}
					menuLabel="Filtrar por vendedor"
					triggerClass="px-2.5 py-1.5 text-xs text-ink-secondary hover:bg-surface"
				>
					{#snippet children({ close })}
						<div class="px-2.5 py-1.5 text-xs font-medium text-ink">Vendedor</div>
						<button
							type="button"
							onclick={() => {
								selectedOwnerFilter = 'all';
								close();
							}}
							class="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs hover:bg-surface"
						>
							<span class="font-medium text-ink">Todo el equipo</span>
							<span class="text-ink-muted">{effectiveDeals.filter((d) => !data.stages.find((s) => s.id === d.stage_id)?.is_terminal).length} oportunidades</span>
						</button>
						{#each data.members as member (member.user_id)}
							<button
								type="button"
								onclick={() => {
									selectedOwnerFilter = member.user_id;
									close();
								}}
								class="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs hover:bg-surface"
							>
								<span>{member.profile.full_name}</span>
								<span class="text-ink-muted">{countDealsForOwner(member.user_id)} oportunidades</span>
							</button>
						{/each}
						<button
							type="button"
							onclick={() => {
								selectedOwnerFilter = 'unassigned';
								close();
							}}
							class="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs hover:bg-surface"
						>
							<span>Sin asignar</span>
							<span class="text-ink-muted">{countDealsForOwner(null)} oportunidades</span>
						</button>
						<p class="px-2.5 py-1.5 text-[11px] text-ink-muted">
							El total y los subtotales reflejan el filtro activo.
						</p>
					{/snippet}
				</PopupMenu>
			</div>

			{#if moveError}
				<p
					role="alert"
					class="mx-5 mb-3 rounded-lg border border-amber-ink/30 bg-amber-soft/50 px-3.5 py-2 text-xs text-amber-ink sm:mx-9"
				>
					{moveError}
				</p>
			{/if}

			<!-- Tablero Kanban -->
			{#if filteredDeals.length === 0}
				<div class="flex flex-1 items-center justify-center p-6">
					<EmptyState
						title="Tu siguiente cliente empieza aquí."
						description="Crea tu primera oportunidad. También podrás crearla desde una conversación."
						actionLabel={canAct ? 'Nueva oportunidad' : undefined}
						onAction={() => (newDealOpen = true)}
					/>
				</div>
			{:else}
				<div class="flex-1 overflow-x-auto px-5 pb-8 sm:px-9">
					<div class="grid min-w-[780px] gap-4" style="grid-template-columns: repeat({visibleStages.length}, minmax(220px, 1fr));">
						{#each visibleStages as stage (stage.id)}
							{@const stageDeals = filteredDeals.filter((d) => d.stage_id === stage.id)}
							{@const stageSum = stageDeals.reduce((s, d) => s + d.value_cents, 0)}
							<section
								aria-label={stage.name}
								ondragover={(e) => {
									if (!canAct) return;
									e.preventDefault();
									dragOverStageId = stage.id;
								}}
								ondragleave={() => {
									if (dragOverStageId === stage.id) dragOverStageId = null;
								}}
								ondrop={(e) => {
									e.preventDefault();
									dragOverStageId = null;
									const dealId = draggedDealId;
									draggedDealId = null;
									if (dealId) {
										void moveDealToStage(dealId, stage.id);
									}
								}}
								class="flex flex-col rounded-xl p-1.5 transition-colors {dragOverStageId === stage.id ? 'bg-sage-soft/50 ring-1 ring-sage-ink/25' : ''}"
							>
								<div class="mb-3 px-1">
									<div class="flex items-center justify-between text-sm">
										<h2 class="font-medium text-ink">{stage.name}</h2>
										<span class="text-xs text-ink-muted">{stageDeals.length}</span>
									</div>
									<p class="mt-0.5 text-xs text-ink-muted">
										{formatMoneyCents(stageSum, data.org.currency)}
									</p>
								</div>

								<div class="space-y-3">
									{#each stageDeals as deal (deal.id)}
										{@const contact = data.contacts.find((c) => c.id === deal.contact_id)}
										{@const owner = data.members.find((m) => m.user_id === deal.owner_user_id)}
										{@const isSelected = selectedDealId === deal.id}
										<button
											type="button"
											draggable={canAct}
											ondragstart={() => (draggedDealId = deal.id)}
											ondragend={() => {
												draggedDealId = null;
												dragOverStageId = null;
											}}
											onclick={() => {
												selectedDealId = deal.id;
												editingNextStep = false;
											}}
											class="w-full rounded-xl border bg-canvas p-4 text-left transition-colors hover:border-border-strong {draggedDealId === deal.id ? 'opacity-45' : ''} {isSelected ? 'border-ink ring-1 ring-ink/10' : 'border-border'}"
										>
											<div class="flex items-start justify-between gap-2">
												<div class="flex flex-wrap items-center gap-1.5">
													<span class="text-sm font-medium text-ink">
														{contact?.name ?? deal.title}
													</span>
													{#if contact?.email === DEMO_SIM_CONTACT_EMAIL}
														<span class="rounded bg-surface px-1.5 py-0.5 text-[10px] font-medium text-ink-secondary">
															Demo IA
														</span>
													{/if}
													{#if deal.last_moved_by === 'ai'}
														<span class="inline-flex items-center gap-0.5 rounded bg-sage-soft px-1.5 py-0.5 text-[10px] font-medium text-sage-ink">
															<Sparkles class="size-2.5" aria-hidden="true" />
															<span>IA</span>
														</span>
													{/if}
												</div>
												<span class="text-[11px] font-medium text-ink-muted">
													{owner?.profile.initials ?? '—'}
												</span>
											</div>
											{#if contact?.company}
												<p class="mt-0.5 text-xs text-ink-muted">{contact.company}</p>
											{/if}
											<p class="mt-3 text-base font-semibold text-ink">
												{formatMoneyShort(deal.value_cents, deal.currency)}
											</p>
											{#if deal.ai_last_reason}
												<p class="mt-2 line-clamp-2 text-[11px] leading-snug text-ink-secondary">
													{deal.ai_last_reason}
												</p>
											{/if}
											<p
												class="mt-3 text-xs {deal.next_step_overdue
													? 'font-medium text-amber-ink'
													: 'text-ink-muted'}"
											>
												{deal.next_step_label ?? deal.next_step_title ?? 'Sin siguiente paso'}
											</p>
										</button>
									{/each}
								</div>
							</section>
						{/each}
					</div>
				</div>
			{/if}
		</div>

		<!-- Drawer de Oportunidad (04_Oportunidad.png) -->
		{#if activeDeal}
			{@const dealNotes = data.notes.filter((n) => n.contact_id === activeDeal.contact_id)}
			{@const dealEvents = data.timelineEvents.filter((e) => e.contact_id === activeDeal.contact_id)}
			<SidePanel
				open={true}
				title="Oportunidad"
				widthClass="lg:w-[360px]"
				onClose={() => (selectedDealId = null)}
			>
				<div>
					<h2 class="text-xl font-semibold text-ink">{activeDeal.title}</h2>
					{#if activeContact?.company}
						<p class="mt-0.5 text-sm text-ink-secondary">{activeContact.company}</p>
					{/if}
					<p class="mt-2 text-lg font-semibold text-ink">
						{formatMoneyCents(activeDeal.value_cents, activeDeal.currency)}
					</p>

					<!-- Metadata editable -->
					<div class="mt-5 space-y-3 border-t border-b border-border py-4 text-xs">
						<div class="flex items-center justify-between gap-3">
							<label for="deal-stage-select" class="text-ink-muted">Etapa</label>
							<select
								id="deal-stage-select"
								name="stageId"
								value={activeDeal.stage_id}
								disabled={!canAct}
								onchange={(e) => {
									if (activeDeal) void moveDealToStage(activeDeal.id, e.currentTarget.value);
								}}
								class="w-full max-w-[180px] rounded-md bg-transparent py-1 text-right font-medium text-ink"
							>
								{#each data.stages as stage (stage.id)}
									<option value={stage.id}>
										{stage.name}
									</option>
								{/each}
							</select>
						</div>

						<div class="flex items-center justify-between gap-3">
							<span class="text-ink-muted">Contacto</span>
							<a
								href="/{data.org.slug}/contacts/{activeDeal.contact_id}"
								class="font-medium text-ink hover:underline"
							>
								{activeContact?.name ?? 'Contacto'}
							</a>
						</div>

						<div class="flex items-center justify-between gap-3">
							<span class="text-ink-muted">Tipo</span>
							<span class="font-medium text-ink">{activeDeal.deal_type}</span>
						</div>

						<div class="flex items-center justify-between gap-3">
							<span class="text-ink-muted">Vendedor</span>
							<form method="POST" action="?/updateDeal" use:enhance class="flex-1 text-right">
								<input type="hidden" name="organizationId" value={data.org.id} />
								<input type="hidden" name="dealId" value={activeDeal.id} />
								<select
									name="ownerUserId"
									disabled={!canAct}
									onchange={(e) => e.currentTarget.form?.requestSubmit()}
									class="w-full max-w-[180px] rounded-md bg-transparent py-1 text-right font-medium text-ink"
								>
									<option value="">Sin asignar</option>
									{#each data.members as member (member.user_id)}
										<option value={member.user_id} selected={activeDeal.owner_user_id === member.user_id}>
											{member.profile.full_name}
										</option>
									{/each}
								</select>
							</form>
						</div>

						<div class="flex items-center justify-between gap-3">
							<span class="text-ink-muted">Tiempo</span>
							<span class="text-ink-secondary">
								{activeDeal.created_age_label} · {activeDeal.stage_age_label}
							</span>
						</div>
					</div>

					<!-- Siguiente paso -->
					<div class="border-b border-border py-4">
						<p class="text-xs text-ink-muted">Siguiente paso</p>
						{#if editingNextStep && canAct}
							<form
								method="POST"
								action="?/updateDeal"
								use:enhance={() => {
									return async ({ update }) => {
										editingNextStep = false;
										await update();
									};
								}}
								class="mt-2 space-y-2"
							>
								<input type="hidden" name="organizationId" value={data.org.id} />
								<input type="hidden" name="dealId" value={activeDeal.id} />
								<input
									name="nextStepTitle"
									type="text"
									value={activeDeal.next_step_title ?? ''}
									class="h-9 w-full rounded-lg border border-border px-2.5 text-xs"
								/>
								<input
									name="nextStepLabel"
									type="text"
									value={activeDeal.next_step_label ?? ''}
									class="h-9 w-full rounded-lg border border-border px-2.5 text-xs"
								/>
								<div class="flex justify-end gap-2">
									<button type="button" onclick={() => (editingNextStep = false)} class="text-xs text-ink-muted">
										Cancelar
									</button>
									<button type="submit" class="rounded-md bg-cta px-3 py-1 text-xs text-white">
										Guardar
									</button>
								</div>
							</form>
						{:else}
							<div class="mt-1.5 flex items-end justify-between gap-2">
								<div>
									<p class="text-sm font-semibold text-ink">
										{activeDeal.next_step_title ?? 'Sin siguiente paso'}
									</p>
									{#if activeDeal.next_step_label}
										<p class="mt-0.5 text-xs text-ink-muted">{activeDeal.next_step_label}</p>
									{/if}
								</div>
								{#if canAct}
									<button
										type="button"
										onclick={() => (editingNextStep = true)}
										class="text-xs text-ink-secondary hover:text-ink"
									>
										Editar
									</button>
								{/if}
							</div>
						{/if}
					</div>

					<!-- Notas -->
					<div class="border-b border-border py-3.5">
						<button
							type="button"
							onclick={() => (showNotes = !showNotes)}
							class="flex w-full items-center justify-between text-sm font-medium text-ink"
						>
							<span>Notas ({dealNotes.length})</span>
							<ChevronRight class="size-4 text-ink-muted transition-transform {showNotes ? 'rotate-90' : ''}" aria-hidden="true" />
						</button>
						{#if showNotes}
							<div class="mt-3 space-y-2.5">
								{#each dealNotes as note (note.id)}
									<div class="rounded-lg bg-note-soft p-3 text-xs">
										<p class="whitespace-pre-line text-ink">{note.body}</p>
										<p class="mt-1 text-[10px] text-ink-muted">{note.author_name} · {note.display_time}</p>
									</div>
								{/each}
								{#if canAct}
									<form
										method="POST"
										action="?/saveNote"
										use:enhance={() => {
											return async ({ result, update }) => {
												if (result.type === 'success') newNoteBody = '';
												await update();
											};
										}}
										class="flex gap-2"
									>
										<input type="hidden" name="organizationId" value={data.org.id} />
										<input type="hidden" name="contactId" value={activeDeal.contact_id} />
										<input
											name="body"
											type="text"
											bind:value={newNoteBody}
											placeholder="Agregar nota..."
											class="h-8 flex-1 rounded-lg border border-border px-2.5 text-xs"
										/>
										<button type="submit" class="h-8 rounded-lg bg-cta px-3 text-xs text-white">
											Guardar
										</button>
									</form>
								{/if}
							</div>
						{/if}
					</div>

					<!-- Calificación IA -->
					<div class="border-b border-border py-4">
						<p class="text-xs text-ink-muted">Calificación IA</p>
						<p class="mt-1 text-sm text-ink">
							{activeDeal.ai_last_reason ?? 'Sin calificación automática todavía.'}
						</p>
						<button
							type="button"
							onclick={() => (showAiExplanation = !showAiExplanation)}
							class="mt-1.5 text-xs font-medium text-ink hover:underline"
						>
							{showAiExplanation ? 'Ocultar explicación' : 'Ver explicación'}
						</button>
						{#if showAiExplanation}
							<p class="mt-2 rounded-lg bg-sage-soft p-3 text-xs text-ink-secondary">
								El lead preguntó por tiempos de entrega y alcance completo, cumpliendo la regla de la etapa actual.
							</p>
						{/if}
					</div>

					<!-- Historial -->
					<div class="py-3.5">
						<button
							type="button"
							onclick={() => (showHistory = !showHistory)}
							class="flex w-full items-center justify-between text-sm text-ink"
						>
							<span>Historial ({dealEvents.length})</span>
							<ChevronRight class="size-4 text-ink-muted transition-transform {showHistory ? 'rotate-90' : ''}" aria-hidden="true" />
						</button>
						{#if showHistory}
							<ul class="mt-2.5 space-y-2 text-xs">
								{#each dealEvents as ev (ev.id)}
									<li>
										<p class="font-medium text-ink">{ev.title}</p>
										<p class="text-ink-muted">{ev.detail} · {ev.timestamp_label}</p>
									</li>
								{/each}
							</ul>
						{/if}
					</div>

					<a
						href="/{data.org.slug}/inbox{activeDeal.conversation_id ? `?chat=${activeDeal.conversation_id}` : ''}"
						class="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-cta text-sm font-medium text-white transition-colors hover:bg-cta-hover"
					>
						<MessageSquare class="size-4" aria-hidden="true" />
						<span>Abrir conversación</span>
					</a>
				</div>
			</SidePanel>
		{/if}
	</div>

	<!-- Modal: Nueva oportunidad -->
	<ModalDialog bind:open={newDealOpen} title="Nueva oportunidad">
		<form
			method="POST"
			action="?/createDeal"
			use:enhance={() => {
				return async ({ result, update }) => {
					if (result.type === 'success') newDealOpen = false;
					await update();
				};
			}}
			class="space-y-4"
		>
			<input type="hidden" name="organizationId" value={data.org.id} />
			<div>
				<label for="deal-title" class="block text-xs font-medium text-ink-secondary">Título</label>
				<input
					id="deal-title"
					name="title"
					type="text"
					required
					placeholder="Ej. Branding y sitio web"
					class="mt-1.5 h-10 w-full rounded-lg border border-border px-3 text-sm"
				/>
			</div>
			<div class="grid gap-3 sm:grid-cols-2">
				<div>
					<label for="deal-contact" class="block text-xs font-medium text-ink-secondary">Contacto</label>
					<select
						id="deal-contact"
						name="contactId"
						class="mt-1.5 h-10 w-full rounded-lg border border-border px-2.5 text-sm"
					>
						{#each data.contacts as c (c.id)}
							<option value={c.id}>{c.name}</option>
						{/each}
					</select>
				</div>
				<div>
					<label for="deal-stage" class="block text-xs font-medium text-ink-secondary">Etapa</label>
					<select
						id="deal-stage"
						name="stageId"
						class="mt-1.5 h-10 w-full rounded-lg border border-border px-2.5 text-sm"
					>
						{#each data.stages.filter((s) => !s.is_terminal) as s (s.id)}
							<option value={s.id}>{s.name}</option>
						{/each}
					</select>
				</div>
			</div>
			<div class="grid gap-3 sm:grid-cols-2">
				<div>
					<label for="deal-value" class="block text-xs font-medium text-ink-secondary">Valor ({data.org.currency})</label>
					<input
						id="deal-value"
						name="valueAmount"
						type="number"
						min="0"
						required
						placeholder="24500"
						class="mt-1.5 h-10 w-full rounded-lg border border-border px-3 text-sm"
					/>
				</div>
				<div>
					<label for="deal-type" class="block text-xs font-medium text-ink-secondary">Tipo</label>
					<input
						id="deal-type"
						name="dealType"
						type="text"
						value="Branding"
						class="mt-1.5 h-10 w-full rounded-lg border border-border px-3 text-sm"
					/>
				</div>
			</div>
			<div class="flex justify-end gap-2 pt-2">
				<button
					type="button"
					onclick={() => (newDealOpen = false)}
					class="h-10 rounded-lg border border-border px-4 text-sm text-ink-secondary"
				>
					Cancelar
				</button>
				<button
					type="submit"
					class="h-10 rounded-lg bg-cta px-4 text-sm font-medium text-white hover:bg-cta-hover"
				>
					Crear oportunidad
				</button>
			</div>
		</form>
	</ModalDialog>
{/if}
