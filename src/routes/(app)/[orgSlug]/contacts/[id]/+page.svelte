<script lang="ts">
	import { enhance } from '$app/forms';
	import ChannelIcon from '$lib/components/shared/ChannelIcon.svelte';
	import ModalDialog from '$lib/components/ui/ModalDialog.svelte';
	import { hasMinRole } from '$lib/types/domain';
	import { formatMoneyCents, formatPlatformLabel } from '$lib/utils/format';
	import { ArrowLeft, ChevronRight, Clock, MessageSquare } from 'lucide-svelte';

	let { data } = $props();

	let editOpen = $state(false);
	let addNoteOpen = $state(false);
	let showAllHistory = $state(false);
	let canAct = $derived(!data.denied && hasMinRole(data.effectiveRole, 'agent'));
</script>

<svelte:head>
	<title>{data.denied ? 'Contacto' : data.contact.name} · okeo</title>
</svelte:head>

{#if !data.denied}
	{@const contact = data.contact}
	{@const owner = data.members.find((m) => m.user_id === contact.owner_user_id)}
	<div class="flex-1 overflow-y-auto px-5 pt-6 pb-14 sm:px-9">
		<a
			href="/{data.org.slug}/contacts"
			class="inline-flex items-center gap-1.5 text-xs text-ink-muted hover:text-ink"
		>
			<ArrowLeft class="size-3.5" aria-hidden="true" />
			<span>Contactos</span>
		</a>

		<!-- Header perfil completo (13_Perfil_completo.png) -->
		<header class="mt-5 flex flex-wrap items-start justify-between gap-4">
			<div>
				<h1 class="text-[28px] font-semibold tracking-tight text-ink">{contact.name}</h1>
				<p class="mt-1 text-sm text-ink-secondary">
					{[contact.role_title, contact.company].filter(Boolean).join(' · ') || 'Contacto'}
				</p>
			</div>

			<div class="flex items-center gap-2.5">
				<a
					href="/{data.org.slug}/inbox{data.conversation ? `?chat=${data.conversation.id}` : ''}"
					class="inline-flex h-10 items-center gap-2 rounded-lg bg-cta px-4 text-sm font-medium text-white transition-colors hover:bg-cta-hover"
				>
					<MessageSquare class="size-4" aria-hidden="true" />
					<span>Conversación</span>
				</a>
				{#if canAct}
					<button
						type="button"
						onclick={() => (editOpen = true)}
						class="h-10 rounded-lg border border-border bg-canvas px-4 text-sm font-medium text-ink transition-colors hover:bg-surface"
					>
						Editar
					</button>
				{/if}
			</div>
		</header>

		<!-- Información -->
		<section class="mt-8 border-t border-border pt-4">
			<h2 class="text-xs font-medium text-ink-muted">Información</h2>
			<div class="mt-3 grid gap-6 sm:grid-cols-3">
				<div>
					<p class="text-xs text-ink-muted">Correo</p>
					<p class="mt-1 text-sm text-ink">{contact.email ?? 'Sin correo'}</p>
				</div>
				<div>
					<p class="text-xs text-ink-muted">Responsable</p>
					<div class="mt-1 flex items-center gap-2 text-sm text-ink">
						{#if owner}
							<span class="inline-flex size-5 items-center justify-center rounded-full bg-surface text-[10px] font-medium text-ink-secondary">
								{owner.profile.initials}
							</span>
							<span>{owner.profile.full_name}</span>
						{:else}
							<span>Sin asignar</span>
						{/if}
					</div>
				</div>
				<div>
					<p class="text-xs text-ink-muted">Calificación IA</p>
					{#if contact.ai_intent_label}
						<span class="mt-1 inline-block rounded-md bg-sage-soft px-2.5 py-0.5 text-xs font-medium text-sage-ink">
							{contact.ai_intent_label}
						</span>
					{:else}
						<p class="mt-1 text-sm text-ink-muted">—</p>
					{/if}
				</div>
			</div>
		</section>

		<!-- Canales vinculados -->
		<section class="mt-8">
			<h2 class="text-sm font-semibold text-ink">Canales vinculados</h2>
			<div class="mt-3 grid gap-3 sm:grid-cols-3">
				{#each data.identities as ident (ident.id)}
					<div class="flex items-start gap-3 rounded-xl border border-border bg-canvas p-4">
						<ChannelIcon platform={ident.platform} class="mt-0.5 size-4 text-ink-secondary" />
						<div class="min-w-0">
							<p class="text-sm font-medium text-ink">{formatPlatformLabel(ident.platform)}</p>
							<p class="mt-0.5 truncate text-xs text-ink-muted">{ident.username_or_phone}</p>
						</div>
					</div>
				{:else}
					<p class="text-xs text-ink-muted">Sin identidades de canal vinculadas todavía.</p>
				{/each}
			</div>
		</section>

		<!-- Cuerpo 2 columnas (Oportunidades + Notas / Siguiente paso + Actividad) -->
		<div class="mt-9 grid gap-8 lg:grid-cols-[1.2fr_1fr]">
			<div class="space-y-8">
				<section>
					<h2 class="text-sm font-semibold text-ink">Oportunidades</h2>
					<div class="mt-3 divide-y divide-border border-t border-b border-border">
						{#each data.deals as deal (deal.id)}
							{@const stage = data.stages.find((s) => s.id === deal.stage_id)}
							<a
								href="/{data.org.slug}/pipeline"
								class="flex items-center justify-between py-3.5 transition-colors hover:bg-sidebar/60"
							>
								<div>
									<p class="text-sm font-medium text-ink">{deal.title}</p>
									<p class="mt-0.5 text-xs text-ink-muted">
										{formatMoneyCents(deal.value_cents, deal.currency)} · {stage?.name ?? 'Etapa'}
									</p>
								</div>
								<ChevronRight class="size-4 text-ink-muted" aria-hidden="true" />
							</a>
						{:else}
							<p class="py-4 text-xs text-ink-muted">Sin oportunidades registradas.</p>
						{/each}
					</div>
				</section>

				<section>
					<div class="flex items-center justify-between">
						<h2 class="text-sm font-semibold text-ink">Notas del equipo</h2>
						{#if canAct}
							<button
								type="button"
								onclick={() => (addNoteOpen = true)}
								class="text-xs font-medium text-ink hover:underline"
							>
								Añadir
							</button>
						{/if}
					</div>
					<div class="mt-3 space-y-3">
						{#each data.notes as note (note.id)}
							<div class="rounded-xl bg-sidebar p-4">
								<p class="text-sm leading-relaxed whitespace-pre-line text-ink">{note.body}</p>
								<p class="mt-2 text-xs text-ink-muted">{note.author_name} · {note.display_time}</p>
							</div>
						{:else}
							<p class="text-xs text-ink-muted">No hay notas del equipo para este contacto.</p>
						{/each}
					</div>
				</section>
			</div>

			<div class="space-y-7">
				<!-- Siguiente paso -->
				<section class="rounded-xl bg-sidebar p-5">
					<p class="text-xs text-ink-muted">Siguiente paso</p>
					<p class="mt-1.5 text-base font-semibold text-ink">
						{contact.next_step_title ?? 'Sin definir'}
					</p>
					{#if contact.next_step_at_label}
						<p class="mt-2 flex items-center gap-1.5 text-xs text-ink-secondary">
							<Clock class="size-3.5 text-ink-muted" aria-hidden="true" />
							<span>{contact.next_step_at_label}</span>
						</p>
					{/if}
					{#if canAct}
						<button
							type="button"
							onclick={() => (editOpen = true)}
							class="mt-4 text-xs font-medium text-ink hover:underline"
						>
							Editar seguimiento
						</button>
					{/if}
				</section>

				<!-- Actividad reciente -->
				<section>
					<div class="flex items-center justify-between">
						<h2 class="text-sm font-semibold text-ink">Actividad reciente</h2>
					</div>
					<ul class="mt-3 divide-y divide-border">
						{#each showAllHistory ? data.timelineEvents : data.timelineEvents.slice(0, 2) as evt (evt.id)}
							<li class="py-3">
								<p class="text-xs text-ink-muted">{evt.timestamp_label}</p>
								<p class="mt-0.5 text-sm font-medium text-ink">{evt.title}</p>
								<p class="mt-0.5 text-xs text-ink-muted">{evt.detail}</p>
							</li>
						{:else}
							<li class="py-3 text-xs text-ink-muted">Sin actividad reciente.</li>
						{/each}
					</ul>
					{#if data.timelineEvents.length > 2}
						<button
							type="button"
							onclick={() => (showAllHistory = !showAllHistory)}
							class="mt-2 text-xs text-ink-secondary hover:text-ink"
						>
							{showAllHistory ? 'Ver menos' : 'Ver historial completo'}
						</button>
					{/if}
				</section>
			</div>
		</div>
	</div>

	<ModalDialog bind:open={editOpen} title="Editar contacto">
		<form
			method="POST"
			action="?/updateContact"
			use:enhance={() => {
				return async ({ result, update }) => {
					if (result.type === 'success') editOpen = false;
					await update();
				};
			}}
			class="space-y-3.5"
		>
			<input type="hidden" name="organizationId" value={data.org.id} />
			<input type="hidden" name="contactId" value={contact.id} />
			<div>
				<label for="e-name" class="block text-xs font-medium text-ink-secondary">Nombre</label>
				<input id="e-name" name="name" type="text" required value={contact.name} class="mt-1 h-10 w-full rounded-lg border border-border px-3 text-sm" />
			</div>
			<div class="grid gap-3 sm:grid-cols-2">
				<div>
					<label for="e-role" class="block text-xs font-medium text-ink-secondary">Cargo</label>
					<input id="e-role" name="roleTitle" type="text" value={contact.role_title ?? ''} class="mt-1 h-10 w-full rounded-lg border border-border px-3 text-sm" />
				</div>
				<div>
					<label for="e-company" class="block text-xs font-medium text-ink-secondary">Empresa</label>
					<input id="e-company" name="company" type="text" value={contact.company ?? ''} class="mt-1 h-10 w-full rounded-lg border border-border px-3 text-sm" />
				</div>
			</div>
			<div class="grid gap-3 sm:grid-cols-2">
				<div>
					<label for="e-email" class="block text-xs font-medium text-ink-secondary">Correo</label>
					<input id="e-email" name="email" type="email" value={contact.email ?? ''} class="mt-1 h-10 w-full rounded-lg border border-border px-3 text-sm" />
				</div>
				<div>
					<label for="e-phone" class="block text-xs font-medium text-ink-secondary">Teléfono</label>
					<input id="e-phone" name="phone" type="tel" value={contact.phone ?? ''} class="mt-1 h-10 w-full rounded-lg border border-border px-3 text-sm" />
				</div>
			</div>
			<div class="grid gap-3 sm:grid-cols-2">
				<div>
					<label for="e-next" class="block text-xs font-medium text-ink-secondary">Siguiente paso</label>
					<input id="e-next" name="nextStepTitle" type="text" value={contact.next_step_title ?? ''} class="mt-1 h-10 w-full rounded-lg border border-border px-3 text-sm" />
				</div>
				<div>
					<label for="e-next-at" class="block text-xs font-medium text-ink-secondary">Fecha / hora</label>
					<input id="e-next-at" name="nextStepAtLabel" type="text" value={contact.next_step_at_label ?? ''} class="mt-1 h-10 w-full rounded-lg border border-border px-3 text-sm" />
				</div>
			</div>
			<input type="hidden" name="ownerUserId" value={contact.owner_user_id ?? ''} />
			<div class="flex justify-end gap-2 pt-2">
				<button type="button" onclick={() => (editOpen = false)} class="h-10 rounded-lg border border-border px-4 text-sm text-ink-secondary">
					Cancelar
				</button>
				<button type="submit" class="h-10 rounded-lg bg-cta px-4 text-sm font-medium text-white hover:bg-cta-hover">
					Guardar cambios
				</button>
			</div>
		</form>
	</ModalDialog>

	<ModalDialog bind:open={addNoteOpen} title="Añadir nota interna">
		<form
			method="POST"
			action="?/addNote"
			use:enhance={() => {
				return async ({ result, update }) => {
					if (result.type === 'success') addNoteOpen = false;
					await update();
				};
			}}
			class="space-y-4"
		>
			<input type="hidden" name="organizationId" value={data.org.id} />
			<input type="hidden" name="contactId" value={contact.id} />
			<input type="hidden" name="conversationId" value={data.conversation?.id ?? ''} />
			<div>
				<label for="n-body" class="block text-xs font-medium text-ink-secondary">Solo visible para tu equipo</label>
				<textarea
					id="n-body"
					name="body"
					rows="3"
					required
					placeholder="Contexto de la cuenta o acuerdos de seguimiento..."
					class="mt-1.5 w-full rounded-lg border border-border p-3 text-sm"
				></textarea>
			</div>
			<div class="flex justify-end gap-2">
				<button type="button" onclick={() => (addNoteOpen = false)} class="h-10 rounded-lg border border-border px-4 text-sm text-ink-secondary">
					Cancelar
				</button>
				<button type="submit" class="h-10 rounded-lg bg-cta px-4 text-sm font-medium text-white hover:bg-cta-hover">
					Guardar nota
				</button>
			</div>
		</form>
	</ModalDialog>
{/if}
