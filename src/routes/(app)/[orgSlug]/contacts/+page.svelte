<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import EmptyState from '$lib/components/shared/EmptyState.svelte';
	import ModalDialog from '$lib/components/ui/ModalDialog.svelte';
	import SidePanel from '$lib/components/ui/SidePanel.svelte';
	import { hasMinRole, type Platform } from '$lib/types/domain';
	import { Plus, Search, ChevronDown } from 'lucide-svelte';

	let { data } = $props();

	let searchQuery = $state('');
	let filterPanelOpen = $state(false);
	let addContactOpen = $state(false);

	// Filtros de panel (20_Filtros_y_notas.png)
	let filterOwner = $state<'all' | string>('all');
	let filterChannel = $state<'all' | Platform>('all');
	let filterFollowUp = $state<'all' | 'overdue'>('all');
	let filterData = $state<'all' | 'incomplete'>('all');
	let sortBy = $state<'recent' | 'oldest'>('recent');

	let canAct = $derived(!data.denied && hasMinRole(data.effectiveRole, 'agent'));

	let filteredContacts = $derived.by(() => {
		if (data.denied) return [];
		const q = searchQuery.trim().toLowerCase();
		const list = data.contacts.filter((c) => {
			if (filterOwner !== 'all' && c.owner_user_id !== filterOwner) return false;
			if (filterFollowUp === 'overdue' && !c.next_step_overdue) return false;
			if (filterData === 'incomplete' && c.email && c.phone) return false;
			if (filterChannel !== 'all') {
				const hasPlatform = data.identities.some(
					(i) => i.contact_id === c.id && i.platform === filterChannel
				);
				if (!hasPlatform) return false;
			}
			if (q) {
				const hay = `${c.name} ${c.company ?? ''} ${c.email ?? ''}`.toLowerCase();
				if (!hay.includes(q)) return false;
			}
			return true;
		});

		if (sortBy === 'oldest') {
			return [...list].sort(
				(a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
			);
		}
		return list;
	});

	function clearFilters() {
		searchQuery = '';
		filterOwner = 'all';
		filterChannel = 'all';
		filterFollowUp = 'all';
		filterData = 'all';
		sortBy = 'recent';
	}
</script>

<svelte:head>
	<title>Contactos · {data.denied ? 'okeo' : data.org.name}</title>
</svelte:head>

{#if !data.denied}
	<div class="flex min-h-0 flex-1 overflow-hidden">
		<div class="flex min-w-0 flex-1 flex-col overflow-y-auto px-5 pt-7 pb-10 sm:px-9">
			<header class="flex flex-wrap items-start justify-between gap-4">
				<div>
					<h1 class="text-[28px] font-semibold tracking-tight text-ink">Contactos</h1>
					<p class="mt-1 text-sm text-ink-muted">{data.contacts.length} personas</p>
				</div>

				{#if canAct}
					<button
						type="button"
						onclick={() => (addContactOpen = true)}
						class="inline-flex h-10 items-center gap-1.5 rounded-lg bg-cta px-4 text-sm font-medium text-white transition-colors hover:bg-cta-hover"
					>
						<Plus class="size-4" aria-hidden="true" />
						<span>Añadir</span>
					</button>
				{/if}
			</header>

			<!-- Buscador + Filtrar (05_Contactos.png) -->
			<div class="mt-7 flex items-center justify-between gap-4 border-b border-border pb-3.5">
				<search class="flex flex-1 items-center gap-2.5">
					<Search class="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
					<label for="contacts-search" class="visually-hidden">Buscar contacto</label>
					<input
						id="contacts-search"
						type="search"
						bind:value={searchQuery}
						placeholder="Buscar contacto"
						class="w-full max-w-sm bg-transparent text-sm text-ink placeholder:text-ink-muted focus:outline-none"
					/>
				</search>

				<button
					type="button"
					onclick={() => (filterPanelOpen = !filterPanelOpen)}
					aria-expanded={filterPanelOpen}
					class="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-ink-secondary hover:bg-surface hover:text-ink"
				>
					<span>Filtrar</span>
					<ChevronDown class="size-3.5" aria-hidden="true" />
				</button>
			</div>

			{#if data.contacts.length === 0}
				<div class="mt-10">
					<EmptyState
						title="Conoce a tus próximos clientes."
						description="Los contactos se guardan cuando te escriben. Puedes añadir uno ahora."
						actionLabel={canAct ? 'Añadir contacto' : undefined}
						onAction={() => (addContactOpen = true)}
					/>
				</div>
			{:else if filteredContacts.length === 0}
				<div class="mt-10">
					<EmptyState
						title="No encontramos coincidencias."
						description="Prueba otro nombre, empresa o correo. También puedes quitar los filtros activos."
						actionLabel="Limpiar filtros"
						onAction={clearFilters}
					/>
				</div>
			{:else}
				<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
				<div
					tabindex="0"
					role="region"
					aria-labelledby="contacts-caption"
					class="table-wrapper mt-2"
				>
					<table>
						<caption id="contacts-caption" class="visually-hidden">
							Directorio de contactos del workspace {data.org.name}
						</caption>
						<thead>
							<tr class="border-b border-border text-left text-xs font-normal text-ink-muted">
								<th scope="col" class="py-3 pr-4 font-normal">Nombre</th>
								<th scope="col" class="py-3 pr-4 font-normal">Empresa</th>
								<th scope="col" class="py-3 pr-4 font-normal">Vendedor</th>
								<th scope="col" class="py-3 font-normal">Seguimiento</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-border text-sm">
							{#each filteredContacts as contact (contact.id)}
								{@const owner = data.members.find((m) => m.user_id === contact.owner_user_id)}
								<tr
									onclick={() => goto(`/${data.org.slug}/contacts/${contact.id}`)}
									class="cursor-pointer transition-colors hover:bg-sidebar/70"
								>
									<th scope="row" class="py-4 pr-4 font-medium text-ink">
										<a href="/{data.org.slug}/contacts/{contact.id}" class="hover:underline">
											{contact.name}
										</a>
									</th>
									<td data-label="Empresa" class="py-4 pr-4 text-ink-secondary">
										{contact.company ?? '—'}
									</td>
									<td data-label="Vendedor" class="py-4 pr-4 text-ink-secondary">
										{owner?.profile.full_name ?? 'Sin asignar'}
									</td>
									<td
										data-label="Seguimiento"
										class="py-4 {contact.next_step_overdue ? 'text-amber-ink' : 'text-ink-muted'}"
									>
										{contact.next_step_title ?? 'Sin seguimiento'}{contact.next_step_at_label
											? ` · ${contact.next_step_at_label}`
											: ''}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>

				<p class="mt-6 text-xs text-ink-muted">
					Selecciona un contacto para ver su perfil completo.
				</p>
			{/if}
		</div>

		<!-- Panel contextual Filtrar contactos (20_Filtros_y_notas.png) -->
		<SidePanel
			open={filterPanelOpen}
			title="Filtrar contactos"
			onClose={() => (filterPanelOpen = false)}
		>
			<div class="space-y-4 text-xs">
				<div class="flex items-center justify-between border-b border-border pb-3">
					<label for="f-owner" class="text-ink-muted">Vendedor</label>
					<select id="f-owner" bind:value={filterOwner} class="bg-transparent font-medium text-ink">
						<option value="all">Todo el equipo</option>
						{#each data.members as m (m.user_id)}
							<option value={m.user_id}>{m.profile.full_name}</option>
						{/each}
					</select>
				</div>

				<div class="flex items-center justify-between border-b border-border pb-3">
					<label for="f-channel" class="text-ink-muted">Canal</label>
					<select id="f-channel" bind:value={filterChannel} class="bg-transparent font-medium text-ink">
						<option value="all">Todos</option>
						<option value="whatsapp">WhatsApp</option>
						<option value="instagram">Instagram</option>
						<option value="facebook">Messenger</option>
					</select>
				</div>

				<div class="flex items-center justify-between border-b border-border pb-3">
					<label for="f-follow" class="text-ink-muted">Seguimiento</label>
					<select id="f-follow" bind:value={filterFollowUp} class="bg-transparent font-medium text-ink">
						<option value="all">Todos</option>
						<option value="overdue">Pendiente del equipo</option>
					</select>
				</div>

				<div class="flex items-center justify-between border-b border-border pb-3">
					<label for="f-data" class="text-ink-muted">Datos</label>
					<select id="f-data" bind:value={filterData} class="bg-transparent font-medium text-ink">
						<option value="all">Todos</option>
						<option value="incomplete">Incompletos</option>
					</select>
				</div>

				<div class="flex items-center justify-between border-b border-border pb-3">
					<label for="f-sort" class="text-ink-muted">Ordenar</label>
					<select id="f-sort" bind:value={sortBy} class="bg-transparent font-medium text-ink">
						<option value="recent">Más recientes</option>
						<option value="oldest">Más antiguos</option>
					</select>
				</div>

				<div class="flex items-center gap-3 pt-2">
					<button
						type="button"
						onclick={() => (filterPanelOpen = false)}
						class="h-9 rounded-lg bg-cta px-4 font-medium text-white"
					>
						Aplicar filtros
					</button>
					<button type="button" onclick={clearFilters} class="text-ink-secondary hover:text-ink">
						Limpiar
					</button>
				</div>
			</div>
		</SidePanel>
	</div>

	<ModalDialog bind:open={addContactOpen} title="Añadir contacto">
		<form
			method="POST"
			action="?/createContact"
			use:enhance={() => {
				return async ({ result, update }) => {
					if (result.type === 'success') addContactOpen = false;
					await update();
				};
			}}
			class="space-y-4"
		>
			<input type="hidden" name="organizationId" value={data.org.id} />
			<div>
				<label for="c-name" class="block text-xs font-medium text-ink-secondary">Nombre</label>
				<input
					id="c-name"
					name="name"
					type="text"
					required
					autocomplete="name"
					class="mt-1.5 h-10 w-full rounded-lg border border-border px-3 text-sm"
				/>
			</div>
			<div>
				<label for="c-company" class="block text-xs font-medium text-ink-secondary">Empresa</label>
				<input
					id="c-company"
					name="company"
					type="text"
					class="mt-1.5 h-10 w-full rounded-lg border border-border px-3 text-sm"
				/>
			</div>
			<div class="grid gap-3 sm:grid-cols-2">
				<div>
					<label for="c-email" class="block text-xs font-medium text-ink-secondary">Correo</label>
					<input
						id="c-email"
						name="email"
						type="email"
						autocomplete="email"
						class="mt-1.5 h-10 w-full rounded-lg border border-border px-3 text-sm"
					/>
				</div>
				<div>
					<label for="c-phone" class="block text-xs font-medium text-ink-secondary">Teléfono</label>
					<input
						id="c-phone"
						name="phone"
						type="tel"
						autocomplete="tel"
						class="mt-1.5 h-10 w-full rounded-lg border border-border px-3 text-sm"
					/>
				</div>
			</div>
			<div class="flex justify-end gap-2 pt-2">
				<button
					type="button"
					onclick={() => (addContactOpen = false)}
					class="h-10 rounded-lg border border-border px-4 text-sm text-ink-secondary"
				>
					Cancelar
				</button>
				<button
					type="submit"
					class="h-10 rounded-lg bg-cta px-4 text-sm font-medium text-white hover:bg-cta-hover"
				>
					Guardar contacto
				</button>
			</div>
		</form>
	</ModalDialog>
{/if}
