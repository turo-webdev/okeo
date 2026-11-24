<script lang="ts">
	import { enhance } from '$app/forms';
	import { markWorkspaceViewsStale, patchWorkspaceAiMode } from '$lib/client/workspace-cache';
	import ModalDialog from '$lib/components/ui/ModalDialog.svelte';
	import SidePanel from '$lib/components/ui/SidePanel.svelte';
	import {
		hasMinRole,
		type AiSimulationResult,
		type DemoLeadState,
		type KnowledgeDocument
	} from '$lib/types/domain';
	import {
		FileText,
		MessageSquare,
		Link2,
		ChevronRight,
		AlertTriangle,
		Sparkles,
		Maximize2,
		Minimize2,
		RotateCcw,
		Pencil,
		Trash2,
		ExternalLink
	} from 'lucide-svelte';

	let { data, form } = $props();

	type PanelKind =
		| ''
		| 'prueba'
		| 'conocimiento'
		| 'editar_conocimiento'
		| 'preferencias'
		| 'reglas';
	let activePanel = $state<PanelKind>('');
	let showAllSources = $state(false);
	let errorDocModal = $state<KnowledgeDocument | null>(null);

	// Edición / eliminación de fuente de conocimiento
	let editingDoc = $state<KnowledgeDocument | null>(null);
	let editDocTitle = $state('');
	let editDocContent = $state('');
	let editDocUrl = $state('');
	let confirmDeleteDoc = $state(false);
	let savingDoc = $state(false);
	let deletingDoc = $state(false);
	let openingFileDocId = $state<string | null>(null);
	let openFileError = $state('');

	function openEditDoc(doc: KnowledgeDocument) {
		editingDoc = doc;
		editDocTitle = doc.title;
		editDocContent = doc.content_preview ?? '';
		editDocUrl = doc.source_url ?? '';
		confirmDeleteDoc = false;
		openFileError = '';
		activePanel = 'editar_conocimiento';
	}

	function closeEditDoc() {
		editingDoc = null;
		confirmDeleteDoc = false;
		openFileError = '';
		if (activePanel === 'editar_conocimiento') {
			activePanel = '';
		}
	}

	async function openPrivateKnowledgeFile(doc: KnowledgeDocument) {
		if (data.denied || !doc.storage_path || openingFileDocId) return;
		openingFileDocId = doc.id;
		openFileError = '';
		try {
			const qs = new URLSearchParams({
				organizationId: data.org.id,
				bucket: 'knowledge-files',
				path: doc.storage_path
			});
			const res = await fetch(`/api/media/signed-url?${qs.toString()}`, {
				credentials: 'same-origin'
			});
			const payload = (await res.json().catch(() => ({}))) as {
				ok?: boolean;
				signedUrl?: string;
				error?: string;
			};
			if (!res.ok || !payload.ok || !payload.signedUrl) {
				throw new Error(payload.error ?? 'No pudimos abrir el archivo privado.');
			}
			window.open(payload.signedUrl, '_blank', 'noopener,noreferrer');
		} catch (err) {
			openFileError = err instanceof Error ? err.message : 'No pudimos abrir el archivo privado.';
		} finally {
			openingFileDocId = null;
		}
	}

	function sourceTypeLabel(sourceType: KnowledgeDocument['source_type']): string {
		switch (sourceType) {
			case 'faq':
				return 'FAQ';
			case 'url':
				return 'URL';
			case 'file':
				return 'Archivo';
			default:
				return 'Texto';
		}
	}

	function statusLabel(status: KnowledgeDocument['status']): string {
		switch (status) {
			case 'ready':
				return 'Lista';
			case 'processing':
				return 'Procesando';
			case 'error':
				return 'Requiere atención';
		}
	}

	$effect(() => {
		const p = data.denied ? '' : data.initialPanel;
		if (p === 'prueba' || p === 'conocimiento' || p === 'preferencias' || p === 'reglas') {
			activePanel = p;
		}
	});

	let canManage = $derived(!data.denied && hasMinRole(data.effectiveRole, 'admin'));

	// Conocimiento form state (11_Paneles_contextuales.png)
	let kbType = $state<'faq' | 'file' | 'url' | 'text'>('faq');
	let kbSubmitting = $state(false);
	let selectedKbFileName = $state('');

	// Simulador state (07_Prueba_de_IA.png)
	interface SimMessage {
		role: 'user' | 'assistant';
		text: string;
		sim?: AiSimulationResult;
	}

	const QUICK_SIM_PROMPTS = [
		'Hola, ¿qué horarios y membresías tienen?',
		'¿Tienen clases individuales?',
		'Me interesa conocer, ¿agendamos una cita el martes a las 5 pm?',
		'La verdad se me hace muy caro, no me alcanza'
	];

	let activeSimOrgId = $state('');
	let didInitialResetOrgId = $state('');
	let simMessages = $state<SimMessage[]>([]);
	let simInput = $state('');
	let simLoading = $state(false);
	let simError = $state('');
	let simProvider = $state<'gemini' | 'mock' | null>(null);
	let simModel = $state<string | null>(null);
	let expandedSim = $state(false);
	let syncDemoLead = $state(true);
	let demoLead = $state<DemoLeadState | null>(null);
	let demoSyncing = $state(false);

	// Modo Copiloto / Automático optimista (0 ms)
	let optimisticAutoReply = $state<boolean | null>(null);
	let modeError = $state('');
	let modeSeq = 0;
	let isAutoReply = $derived(
		data.denied ? false : (optimisticAutoReply ?? data.aiSettings.auto_reply_enabled)
	);

	$effect(() => {
		if (!data.denied && optimisticAutoReply !== null && data.aiSettings.auto_reply_enabled === optimisticAutoReply) {
			optimisticAutoReply = null;
		}
	});

	async function setAutoReplyMode(enabled: boolean) {
		if (data.denied || !canManage || isAutoReply === enabled) return;
		const orgId = data.org.id;
		const orgSlug = data.org.slug;
		const seq = ++modeSeq;

		optimisticAutoReply = enabled;
		modeError = '';
		patchWorkspaceAiMode(orgSlug, enabled);

		const fd = new FormData();
		fd.set('organizationId', orgId);
		fd.set('autoReplyEnabled', String(enabled));

		try {
			const res = await fetch(`/${orgSlug}/ai?/updateMode`, {
				method: 'POST',
				headers: { 'x-sveltekit-action': 'true' },
				body: fd
			});
			let actionType: string | undefined;
			try {
				const payload = (await res.json()) as { type?: string };
				actionType = payload?.type;
			} catch {
				actionType = undefined;
			}
			if (seq !== modeSeq) return;
			if (!res.ok || actionType === 'failure' || actionType === 'error') {
				throw new Error('Mode update failed');
			}
		} catch {
			if (seq !== modeSeq) return;
			const fallback = data.denied ? false : data.aiSettings.auto_reply_enabled;
			optimisticAutoReply = null;
			patchWorkspaceAiMode(orgSlug, fallback);
			modeError = 'No se pudo cambiar el modo. Se revirtió el cambio.';
			markWorkspaceViewsStale(orgSlug, ['ai']);
		}
	}

	$effect(() => {
		const orgId = data.denied ? '' : data.org.id;
		if (orgId && orgId !== activeSimOrgId) {
			activeSimOrgId = orgId;
			didInitialResetOrgId = '';
			simMessages = [];
			simInput = '';
			simError = '';
			simProvider = null;
			simModel = null;
			demoLead = data.denied ? null : data.initialDemoLead;
			optimisticAutoReply = null;
			modeError = '';
			closeEditDoc();
		}
	});

	$effect(() => {
		if (
			!data.denied &&
			activePanel === 'prueba' &&
			simMessages.length === 0 &&
			syncDemoLead &&
			didInitialResetOrgId !== data.org.id
		) {
			didInitialResetOrgId = data.org.id;
			void resetDemoLead();
		}
	});

	async function resetDemoLead() {
		if (data.denied) return;
		demoSyncing = true;
		try {
			const res = await fetch('/api/ai/simulate/reset', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ organizationId: data.org.id })
			});
			const payload = await res.json();
			if (res.ok && payload.demoLead) {
				demoLead = payload.demoLead;
				markWorkspaceViewsStale(data.org.slug, ['pipeline', 'contacts', 'inbox']);
			}
		} catch {
			// Keep chat responsive if background reset encounters transient network issues
		} finally {
			demoSyncing = false;
		}
	}

	function togglePruebaPanel() {
		if (activePanel === 'prueba') {
			activePanel = '';
			return;
		}
		activePanel = 'prueba';
		if (!data.denied && syncDemoLead) {
			simMessages = [];
			simInput = '';
			simError = '';
			simProvider = null;
			simModel = null;
			didInitialResetOrgId = data.org.id;
			void resetDemoLead();
		}
	}

	async function submitSimulation(rawPrompt: string) {
		if (data.denied || simLoading) return;
		const prompt = rawPrompt.trim();
		if (!prompt) return;

		const history = simMessages.slice(-14).map((m) => ({
			role: m.role,
			text: m.text
		}));

		simInput = '';
		simError = '';
		simMessages = [...simMessages, { role: 'user', text: prompt }];
		simLoading = true;
		try {
			const res = await fetch('/api/ai/simulate', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					organizationId: data.org.id,
					message: prompt,
					syncDemoLead,
					history
				})
			});
			const payload = await res.json();
			if (res.ok && payload.result) {
				simProvider = payload.provider ?? null;
				simModel = payload.model ?? null;
				if (payload.demoLead) {
					demoLead = payload.demoLead;
					markWorkspaceViewsStale(data.org.slug, ['pipeline', 'contacts', 'inbox']);
				}
				simMessages = [
					...simMessages,
					{ role: 'assistant', text: payload.result.reply_text, sim: payload.result }
				];
			} else {
				simError = payload?.error ?? 'No se pudo obtener respuesta del asistente.';
			}
		} catch {
			simError = 'Error de red al probar el asistente.';
		} finally {
			simLoading = false;
		}
	}

	function runSimulation(e: SubmitEvent) {
		e.preventDefault();
		void submitSimulation(simInput);
	}

	function handleSimKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			void submitSimulation(simInput);
		}
	}

	function resetSimulation() {
		simMessages = [];
		simInput = '';
		simError = '';
		simProvider = null;
		simModel = null;
		if (syncDemoLead) {
			void resetDemoLead();
		}
	}
</script>

<svelte:head>
	<title>Asistente · {data.denied ? 'okeo' : data.org.name}</title>
</svelte:head>

{#if !data.denied}
	{@const visibleDocs = showAllSources
		? data.knowledgeDocuments
		: data.knowledgeDocuments.slice(0, 3)}
	<div class="flex min-h-0 flex-1 overflow-hidden">
		<div class="flex-1 overflow-y-auto px-5 pt-7 pb-14 sm:px-9">
			<div class="max-w-xl">
				<header class="flex items-start justify-between gap-4">
					<div>
						<h1 class="text-[28px] font-semibold tracking-tight text-ink">Asistente</h1>
						<p class="mt-1 text-sm text-ink-muted">
							Empieza con Copiloto. Activa más cuando lo necesites.
						</p>
					</div>

					<button
						type="button"
						onclick={togglePruebaPanel}
						class="h-10 rounded-lg bg-cta px-5 text-sm font-medium text-white transition-colors hover:bg-cta-hover"
					>
						Probar
					</button>
				</header>

				<!-- Modo Copiloto / Automático (06_Asistente.png) -->
				<section class="mt-9">
					<h2 class="text-sm font-semibold text-ink">Modo</h2>
					<div class="mt-3 inline-flex rounded-xl border border-border bg-canvas p-1">
						<button
							type="button"
							disabled={!canManage}
							onclick={() => void setAutoReplyMode(false)}
							class="rounded-lg px-5 py-2 text-sm transition-colors {!isAutoReply ? 'bg-sage-soft font-medium text-ink' : 'text-ink-secondary hover:text-ink'}"
						>
							Copiloto
						</button>
						<button
							type="button"
							disabled={!canManage}
							onclick={() => void setAutoReplyMode(true)}
							class="rounded-lg px-5 py-2 text-sm transition-colors {isAutoReply ? 'bg-sage-soft font-medium text-ink' : 'text-ink-secondary hover:text-ink'}"
						>
							Automático
						</button>
					</div>
					<p class="mt-2.5 text-xs text-ink-muted">
						{isAutoReply
							? 'La IA responde automáticamente usando tu base de conocimiento.'
							: 'La IA sugiere. Tú revisas y envías.'}
					</p>
					{#if modeError}
						<p role="alert" class="mt-2 text-xs text-amber-ink">{modeError}</p>
					{/if}
				</section>

				<!-- Conocimiento -->
				<section class="mt-10">
					<div class="flex items-center justify-between">
						<h2 class="text-sm font-semibold text-ink">Conocimiento</h2>
						{#if canManage}
							<button
								type="button"
								onclick={() => {
									closeEditDoc();
									activePanel = 'conocimiento';
								}}
								class="text-xs font-medium text-ink-secondary hover:text-ink"
							>
								Añadir
							</button>
						{/if}
					</div>

					{#if data.knowledgeDocuments.length === 0}
						<div class="mt-3 rounded-xl border border-dashed border-border p-4 text-xs text-ink-muted">
							Aún no hay fuentes cargadas. {canManage ? 'Usa «Añadir» para cargar información de tu negocio.' : 'Un administrador puede agregar fuentes aquí.'}
						</div>
					{:else}
						<ul class="mt-3 divide-y divide-border border-b border-border">
							{#each visibleDocs as doc (doc.id)}
								{@const isSelected = activePanel === 'editar_conocimiento' && editingDoc?.id === doc.id}
								<li class="flex items-center justify-between gap-3 py-3 {isSelected ? '-mx-2 rounded-lg bg-sage-soft/40 px-2' : ''}">
									<button
										type="button"
										onclick={() => openEditDoc(doc)}
										class="group flex min-w-0 flex-1 items-start gap-3 py-1 text-left"
									>
										{#if doc.source_type === 'faq'}
											<MessageSquare class="mt-0.5 size-4 shrink-0 text-ink-muted group-hover:text-sage-ink" aria-hidden="true" />
										{:else if doc.source_type === 'url'}
											<Link2 class="mt-0.5 size-4 shrink-0 text-ink-muted group-hover:text-sage-ink" aria-hidden="true" />
										{:else}
											<FileText class="mt-0.5 size-4 shrink-0 text-ink-muted group-hover:text-sage-ink" aria-hidden="true" />
										{/if}
										<span class="min-w-0 flex-1">
											<span class="block truncate text-sm text-ink group-hover:text-sage-ink">{doc.title}</span>
											{#if doc.content_preview}
												<span class="mt-0.5 block truncate text-xs text-ink-muted">{doc.content_preview}</span>
											{/if}
										</span>
										{#if doc.status !== 'error'}
											<span class="mt-0.5 flex shrink-0 items-center gap-2 text-xs text-ink-muted">
												{#if doc.subtitle}
													<span>{doc.subtitle}</span>
												{/if}
												{#if canManage}
													<Pencil class="size-3.5 opacity-60 transition-opacity group-hover:text-ink group-hover:opacity-100" aria-hidden="true" />
												{:else}
													<ChevronRight class="size-3.5 opacity-60 transition-opacity group-hover:opacity-100" aria-hidden="true" />
												{/if}
											</span>
										{/if}
									</button>

									{#if doc.status === 'error'}
										<button
											type="button"
											onclick={() => (errorDocModal = doc)}
											class="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-amber-ink hover:underline"
										>
											<AlertTriangle class="size-3.5" aria-hidden="true" />
											<span>Requiere atención</span>
										</button>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}

					{#if data.knowledgeDocuments.length > 3}
						<button
							type="button"
							onclick={() => (showAllSources = !showAllSources)}
							class="mt-3 text-xs text-ink-secondary hover:text-ink"
						>
							{showAllSources ? 'Ver menos fuentes' : `Ver las ${data.knowledgeDocuments.length} fuentes`}
						</button>
					{/if}
				</section>

				<!-- Menú de subpaneles -->
				<div class="mt-8 divide-y divide-border border-t border-b border-border">
					<button
						type="button"
						onclick={() => (activePanel = 'preferencias')}
						class="flex w-full items-center justify-between py-4 text-left text-sm font-medium text-ink transition-colors hover:text-sage-ink"
					>
						<span>Preferencias</span>
						<ChevronRight class="size-4 text-ink-muted" aria-hidden="true" />
					</button>
					<button
						type="button"
						onclick={() => (activePanel = 'reglas')}
						class="flex w-full items-center justify-between py-4 text-left text-sm font-medium text-ink transition-colors hover:text-sage-ink"
					>
						<span>Reglas del pipeline</span>
						<ChevronRight class="size-4 text-ink-muted" aria-hidden="true" />
					</button>
				</div>

				<p class="mt-8 text-xs text-ink-muted">
					Cuando tú respondes, el asistente se pausa en ese chat.
				</p>
			</div>
		</div>

		<!-- Panel contextual: Prueba tu asistente (07_Prueba_de_IA.png) -->
		<SidePanel
			open={activePanel === 'prueba'}
			title="Prueba tu asistente"
			subtitle="Solo tú ves esta conversación."
			widthClass={expandedSim ? 'lg:w-[560px]' : 'lg:w-[410px]'}
			onClose={() => (activePanel = '')}
		>
			<div class="flex h-full flex-col justify-between gap-4">
				<div class="space-y-4">
					<div class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-surface/60 px-3 py-2 text-[11px]">
						<span class="text-ink-secondary">
							{#if simProvider === 'gemini' || data.geminiConfigured}
								Gemini en vivo ({simModel ?? data.geminiModel}) · {data.org.name}
							{:else}
								Modo simulado con tu KB · agrega GEMINI_API_KEY para IA real
							{/if}
						</span>
						<div class="flex items-center gap-1.5">
							{#if simMessages.length > 0}
								<button
									type="button"
									onclick={resetSimulation}
									class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-ink-muted hover:bg-canvas hover:text-ink"
									title="Reiniciar chat"
								>
									<RotateCcw class="size-3" aria-hidden="true" />
									<span>Reiniciar</span>
								</button>
							{/if}
							<button
								type="button"
								onclick={() => (expandedSim = !expandedSim)}
								class="hidden items-center gap-1 rounded px-1.5 py-0.5 text-ink-muted hover:bg-canvas hover:text-ink lg:inline-flex"
								title={expandedSim ? 'Reducir ancho' : 'Ampliar chat'}
							>
								{#if expandedSim}
									<Minimize2 class="size-3" aria-hidden="true" />
								{:else}
									<Maximize2 class="size-3" aria-hidden="true" />
								{/if}
							</button>
						</div>
					</div>

					<div class="rounded-lg border border-border bg-canvas p-3 text-[11px]">
						<div class="flex items-center justify-between gap-2">
							<span class="font-medium text-ink">Prospecto Demo (IA)</span>
							<div class="flex items-center gap-3">
								<label class="inline-flex cursor-pointer items-center gap-1.5 text-ink-secondary">
									<input
										type="checkbox"
										bind:checked={syncDemoLead}
										class="size-3.5 accent-sage-ink"
									/>
									<span>Sincronizar</span>
								</label>
								<a
									href="/{data.org.slug}/pipeline"
									target="_blank"
									rel="noopener noreferrer"
									class="font-medium text-sage-ink hover:underline"
								>
									Ver Pipeline ↗
								</a>
							</div>
						</div>
						<div class="mt-2 flex flex-wrap items-center gap-1.5">
							{#each data.stages as stage (stage.id)}
								{@const isCurrent = demoLead?.stageId === stage.id}
								<span
									class="rounded-md px-2 py-0.5 text-[10px] font-medium transition-colors {isCurrent
										? stage.slug === 'disqualified'
											? 'bg-amber-soft text-amber-ink ring-1 ring-amber-ink/30'
											: stage.slug === 'qualified'
												? 'bg-sage-soft text-sage-ink ring-1 ring-sage-ink/30'
												: 'bg-ink text-white'
										: 'border border-border bg-surface/60 text-ink-muted'}"
								>
									{stage.name}
								</span>
							{/each}
							{#if demoSyncing}
								<span class="text-[10px] text-ink-muted">Sincronizando…</span>
							{/if}
						</div>
					</div>

					{#if simMessages.length === 0}
						<div class="rounded-xl border border-dashed border-border p-4">
							<p class="text-xs font-medium text-ink">
								Conversa con el asistente de {data.org.name}
							</p>
							<p class="mt-1 text-xs leading-relaxed text-ink-secondary">
								Usa el historial multi-turno, las preferencias y la base de conocimiento cargada en este workspace sin modificar el Inbox ni el Pipeline reales.
							</p>
							<div class="mt-3 flex flex-wrap gap-1.5">
								{#each QUICK_SIM_PROMPTS as prompt (prompt)}
									<button
										type="button"
										onclick={() => void submitSimulation(prompt)}
										disabled={simLoading}
										class="rounded-full border border-border bg-canvas px-3 py-1.5 text-left text-xs text-ink transition-colors hover:bg-surface disabled:opacity-50"
									>
										{prompt}
									</button>
								{/each}
							</div>
						</div>
					{:else}
						{#each simMessages as m, idx (idx)}
							{#if m.role === 'user'}
								<div class="max-w-[85%] rounded-2xl bg-surface px-4 py-3 text-sm whitespace-pre-line text-ink">
									{m.text}
								</div>
							{:else}
								<div class="space-y-2.5">
									<div class="ml-auto max-w-[90%] rounded-2xl border border-border bg-canvas px-4 py-3 text-sm whitespace-pre-line text-ink">
										{m.text}
									</div>
									<div class="flex items-center justify-end gap-1 text-[11px] text-ink-muted">
										<Sparkles class="size-3" aria-hidden="true" />
										<span>Asistente IA</span>
									</div>
									{#if m.sim}
										{#if m.sim.source_title}
											<p class="text-[11px] text-ink-muted">Fuente: {m.sim.source_title}</p>
										{/if}
										<div class="rounded-xl p-4 text-xs {m.sim.needs_human_handoff ? 'border border-amber-ink/20 bg-amber-soft/60' : 'bg-sage-soft'}">
											<div class="flex items-center justify-between gap-2">
												<p class="font-semibold text-ink">Lo que haría</p>
												{#if m.sim.needs_human_handoff}
													<span class="rounded px-1.5 py-0.5 text-[10px] font-medium text-amber-ink">
														Escala a humano
													</span>
												{/if}
											</div>
											<p class="mt-2 text-ink">› Movería a {m.sim.recommended_stage_name}</p>
											<p class="mt-1 text-ink">› {m.sim.follow_up_action}</p>
											{#if m.sim.needs_human_handoff}
												<p class="mt-1 font-medium text-amber-ink">› Pausaría la IA en esta conversación</p>
											{/if}
											<p class="mt-2.5 text-[11px] text-ink-secondary">{m.sim.intent_summary}</p>
										</div>
									{/if}
								</div>
							{/if}
						{/each}
						<p class="text-[11px] text-ink-muted">
							{syncDemoLead
								? 'Prospecto Demo (IA) sincronizado en vivo con el Pipeline.'
								: 'Simulación aislada: no cambia datos del workspace.'}
						</p>
					{/if}

					{#if simError}
						<p role="alert" class="rounded-lg border border-coral/30 bg-coral/10 px-3 py-2 text-xs text-coral">
							{simError}
						</p>
					{/if}
				</div>

				<div class="border-t border-border pt-3">
					<form onsubmit={runSimulation} class="rounded-xl border border-border p-3">
						<label for="sim-msg" class="visually-hidden">Escribe un mensaje de prueba</label>
						<textarea
							id="sim-msg"
							rows="2"
							bind:value={simInput}
							onkeydown={handleSimKeydown}
							placeholder="Escribe un mensaje como cliente (Enter para enviar)..."
							class="w-full resize-none bg-transparent text-sm focus:outline-none"
						></textarea>
						<div class="mt-2 flex items-center justify-between gap-2">
							<span class="text-[11px] text-ink-muted">Shift + Enter para nueva línea</span>
							<button
								type="submit"
								disabled={simLoading || !simInput.trim()}
								class="h-9 rounded-lg bg-cta px-4 text-xs font-medium text-white hover:bg-cta-hover disabled:opacity-50"
							>
								{simLoading ? 'Pensando...' : 'Enviar'}
							</button>
						</div>
					</form>
				</div>
			</div>
		</SidePanel>

		<!-- Panel contextual: Añadir conocimiento (11_Paneles_contextuales.png) -->
		<SidePanel
			open={activePanel === 'conocimiento'}
			title="Añadir conocimiento"
			onClose={() => (activePanel = '')}
		>
			<form
				method="POST"
				action="?/addKnowledge"
				enctype="multipart/form-data"
				use:enhance={() => {
					kbSubmitting = true;
					return async ({ result, update }) => {
						kbSubmitting = false;
						if (result.type === 'success') {
							selectedKbFileName = '';
							activePanel = '';
							if (!data.denied) markWorkspaceViewsStale(data.org.slug, ['ai']);
						}
						await update();
					};
				}}
				class="space-y-4"
			>
				<input type="hidden" name="organizationId" value={data.org.id} />
				<div>
					<label for="kb-type" class="block text-xs text-ink-muted">Tipo de fuente</label>
					<select
						id="kb-type"
						name="sourceType"
						bind:value={kbType}
						class="mt-1.5 h-10 w-full rounded-lg border border-border px-3 text-sm"
					>
						<option value="faq">Pregunta frecuente</option>
						<option value="file">Archivo PDF / TXT / MD / CSV</option>
						<option value="url">URL de tu sitio</option>
						<option value="text">Texto libre</option>
					</select>
				</div>

				{#if kbType === 'faq'}
					<div>
						<label for="kb-q" class="block text-xs text-ink-muted">Pregunta</label>
						<input id="kb-q" name="question" type="text" required placeholder="¿Puedo pagar en dos partes?" class="mt-1.5 h-10 w-full rounded-lg border border-border px-3 text-sm" />
					</div>
					<div>
						<label for="kb-a" class="block text-xs text-ink-muted">Respuesta</label>
						<textarea id="kb-a" name="answer" rows="3" required placeholder="Sí, 50% al iniciar y 50% al entregar." class="mt-1.5 w-full rounded-lg border border-border p-3 text-sm"></textarea>
					</div>
				{:else if kbType === 'url'}
					<div>
						<label for="kb-url" class="block text-xs text-ink-muted">URL pública</label>
						<input
							id="kb-url"
							name="url"
							type="url"
							required
							autocorrect="off"
							autocapitalize="none"
							spellcheck="false"
							aria-describedby="kb-url-help"
							placeholder="https://tunegocio.com/servicios"
							class="mt-1.5 h-10 w-full rounded-lg border border-border px-3 text-sm"
						/>
						<p id="kb-url-help" class="mt-1.5 text-[11px] text-ink-muted">
							Descargamos y extraemos automáticamente el texto público de esta URL.
						</p>
					</div>
					<div>
						<label for="kb-url-title" class="block text-xs text-ink-muted">Título (opcional)</label>
						<input id="kb-url-title" name="title" type="text" maxlength={140} placeholder="Catálogo de servicios" class="mt-1.5 h-10 w-full rounded-lg border border-border px-3 text-sm" />
					</div>
				{:else if kbType === 'file'}
					<div>
						<label for="kb-file" class="block text-xs text-ink-muted">Archivo (PDF, TXT, MD o CSV)</label>
						<input
							id="kb-file"
							name="file"
							type="file"
							required
							accept=".pdf,.txt,.md,.csv,application/pdf,text/plain,text/markdown,text/csv"
							aria-describedby="kb-file-help"
							onchange={(e) => {
								const f = (e.currentTarget as HTMLInputElement).files?.[0];
								selectedKbFileName = f ? f.name : '';
							}}
							class="mt-1.5 block w-full cursor-pointer rounded-lg border border-border px-3 py-2 text-xs text-ink file:mr-3 file:rounded-md file:border-0 file:bg-surface file:px-2.5 file:py-1 file:text-xs file:font-medium file:text-ink hover:file:bg-border"
						/>
						<p id="kb-file-help" class="mt-1.5 text-[11px] text-ink-muted">
							{selectedKbFileName
								? `Seleccionado: ${selectedKbFileName} · máx. 10 MB.`
								: 'PDF, TXT, MD o CSV · máx. 10 MB. Extraemos el texto automáticamente para tu asistente.'}
						</p>
					</div>
					<div>
						<label for="kb-file-title" class="block text-xs text-ink-muted">Título (opcional)</label>
						<input id="kb-file-title" name="title" type="text" maxlength={140} placeholder="Catálogo 2026" class="mt-1.5 h-10 w-full rounded-lg border border-border px-3 text-sm" />
					</div>
				{:else}
					<div>
						<label for="kb-title" class="block text-xs text-ink-muted">Título</label>
						<input id="kb-title" name="title" type="text" required placeholder="Políticas de envío" class="mt-1.5 h-10 w-full rounded-lg border border-border px-3 text-sm" />
					</div>
					<div>
						<label for="kb-content" class="block text-xs text-ink-muted">Contenido</label>
						<textarea id="kb-content" name="content" rows="4" required class="mt-1.5 w-full rounded-lg border border-border p-3 text-sm"></textarea>
					</div>
				{/if}

				{#if form?.error && form?.action === 'addKnowledge'}
					<p role="alert" class="text-xs text-amber-ink">{form.error}</p>
				{/if}

				<button
					type="submit"
					disabled={kbSubmitting}
					class="h-10 w-full rounded-lg bg-cta text-sm font-medium text-white hover:bg-cta-hover disabled:opacity-60"
				>
					{kbSubmitting ? 'Procesando fuente...' : 'Guardar'}
				</button>
			</form>
		</SidePanel>

		<!-- Panel contextual: Editar / Ver conocimiento -->
		<SidePanel
			open={activePanel === 'editar_conocimiento' && Boolean(editingDoc)}
			title={canManage ? 'Editar conocimiento' : 'Detalle de conocimiento'}
			subtitle={editingDoc?.subtitle ?? undefined}
			widthClass="lg:w-[440px]"
			onClose={closeEditDoc}
		>
			{#if editingDoc}
				<div class="space-y-5">
					<div class="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface/60 px-3 py-2 text-xs">
						<span class="font-medium text-ink-secondary">
							Tipo: {sourceTypeLabel(editingDoc.source_type)}
						</span>
						<span
							class="rounded-md px-2 py-0.5 text-[11px] font-medium {editingDoc.status === 'ready'
								? 'bg-sage-soft text-sage-ink'
								: editingDoc.status === 'error'
									? 'bg-amber-soft text-amber-ink'
									: 'bg-canvas text-ink-muted'}"
						>
							{statusLabel(editingDoc.status)}
						</span>
					</div>

					{#if editingDoc.source_type === 'file' && editingDoc.storage_path}
						<div class="space-y-1.5">
							<button
								type="button"
								disabled={openingFileDocId === editingDoc.id}
								onclick={() => editingDoc && void openPrivateKnowledgeFile(editingDoc)}
								class="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-canvas px-3 text-xs font-medium text-ink transition-colors hover:bg-surface disabled:opacity-60"
							>
								<span>
									{openingFileDocId === editingDoc.id ? 'Generando enlace...' : 'Abrir archivo original'}
								</span>
								<ExternalLink class="size-3.5 text-ink-muted" aria-hidden="true" />
							</button>
							{#if openFileError}
								<p role="alert" class="text-xs text-amber-ink">{openFileError}</p>
							{/if}
						</div>
					{/if}

					{#if canManage}
						<form
							method="POST"
							action="?/updateKnowledge"
							use:enhance={() => {
								savingDoc = true;
								return async ({ result, update }) => {
									savingDoc = false;
									if (result.type === 'success') {
										closeEditDoc();
										if (!data.denied) markWorkspaceViewsStale(data.org.slug, ['ai']);
									}
									await update();
								};
							}}
							class="space-y-4"
						>
							<input type="hidden" name="organizationId" value={data.org.id} />
							<input type="hidden" name="documentId" value={editingDoc.id} />

							<div>
								<label for="edit-kb-title" class="block text-xs font-medium text-ink-secondary">
									Título
								</label>
								<input
									id="edit-kb-title"
									name="title"
									type="text"
									required
									maxlength={140}
									bind:value={editDocTitle}
									class="mt-1.5 h-10 w-full rounded-lg border border-border px-3 text-sm text-ink"
								/>
							</div>

							{#if editingDoc.source_type === 'url'}
								<div>
									<label for="edit-kb-url" class="block text-xs font-medium text-ink-secondary">
										URL pública
									</label>
									<input
										id="edit-kb-url"
										name="url"
										type="url"
										required
										maxlength={500}
										bind:value={editDocUrl}
										class="mt-1.5 h-10 w-full rounded-lg border border-border px-3 text-sm text-ink"
									/>
								</div>
							{/if}

							<div>
								<div class="flex items-center justify-between gap-2">
									<label for="edit-kb-content" class="block text-xs font-medium text-ink-secondary">
										Contenido
									</label>
									<span class="text-[11px] text-ink-muted">
										{editDocContent.length} / 6000
									</span>
								</div>
								<textarea
									id="edit-kb-content"
									name="content"
									rows="10"
									required
									maxlength={6000}
									bind:value={editDocContent}
									class="mt-1.5 w-full rounded-lg border border-border p-3 text-xs leading-relaxed text-ink"
								></textarea>
								<p class="mt-1.5 text-[11px] text-ink-muted">
									El asistente y el simulador usan estos cambios al instante.
								</p>
							</div>

							{#if form?.error && (form?.action === 'updateKnowledge' || form?.action === 'deleteKnowledge')}
								<p role="alert" class="rounded-lg border border-amber-ink/25 bg-amber-soft/50 px-3 py-2 text-xs text-amber-ink">
									{form.error}
								</p>
							{/if}

							<button
								type="submit"
								disabled={savingDoc || !editDocTitle.trim() || !editDocContent.trim()}
								class="h-10 w-full rounded-lg bg-cta text-sm font-medium text-white hover:bg-cta-hover disabled:opacity-50"
							>
								{savingDoc ? 'Guardando...' : 'Guardar cambios'}
							</button>
						</form>

						<div class="mt-6 border-t border-border pt-4">
							{#if !confirmDeleteDoc}
								<button
									type="button"
									onclick={() => (confirmDeleteDoc = true)}
									class="inline-flex items-center gap-1.5 text-xs font-medium text-coral hover:underline"
								>
									<Trash2 class="size-3.5" aria-hidden="true" />
									<span>Eliminar fuente</span>
								</button>
							{:else}
								<div class="space-y-3 rounded-lg border border-coral/30 bg-coral/5 p-3">
									<p class="text-xs leading-relaxed text-ink">
										¿Eliminar «{editingDoc.title}»? La IA dejará de usar esta información.
									</p>
									<div class="flex items-center gap-2">
										<button
											type="button"
											onclick={() => (confirmDeleteDoc = false)}
											disabled={deletingDoc}
											class="h-8 rounded-lg border border-border bg-canvas px-3 text-xs font-medium text-ink hover:bg-surface disabled:opacity-50"
										>
											Cancelar
										</button>
										<form
											method="POST"
											action="?/deleteKnowledge"
											use:enhance={() => {
												deletingDoc = true;
												return async ({ result, update }) => {
													deletingDoc = false;
													if (result.type === 'success') {
														closeEditDoc();
														if (!data.denied) markWorkspaceViewsStale(data.org.slug, ['ai']);
													}
													await update();
												};
											}}
										>
											<input type="hidden" name="organizationId" value={data.org.id} />
											<input type="hidden" name="documentId" value={editingDoc.id} />
											<button
												type="submit"
												disabled={deletingDoc}
												class="h-8 rounded-lg bg-coral px-3 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
											>
												{deletingDoc ? 'Eliminando...' : 'Sí, eliminar'}
											</button>
										</form>
									</div>
								</div>
							{/if}
						</div>
					{:else}
						<div class="space-y-4">
							<div>
								<p class="text-xs font-medium text-ink-muted">Título</p>
								<p class="mt-1 text-sm font-medium text-ink">{editingDoc.title}</p>
							</div>
							{#if editingDoc.source_url}
								<div>
									<p class="text-xs font-medium text-ink-muted">URL pública</p>
									<p class="mt-1 break-all text-xs text-ink-secondary">{editingDoc.source_url}</p>
								</div>
							{/if}
							<div>
								<p class="text-xs font-medium text-ink-muted">Contenido</p>
								<div class="mt-1.5 rounded-lg border border-border bg-surface/40 p-3 text-xs leading-relaxed whitespace-pre-line text-ink">
									{editingDoc.content_preview ?? 'Sin contenido disponible.'}
								</div>
							</div>
							<p class="text-[11px] text-ink-muted">
								Solo administradores pueden editar la base de conocimiento.
							</p>
						</div>
					{/if}
				</div>
			{/if}
		</SidePanel>

		<!-- Panel contextual: Preferencias (11_Paneles_contextuales.png) -->
		<SidePanel
			open={activePanel === 'preferencias'}
			title="Preferencias"
			widthClass="lg:w-[440px]"
			onClose={() => (activePanel = '')}
		>
			<form
				method="POST"
				action="?/updatePreferences"
				use:enhance={() => {
					return async ({ result, update }) => {
						if (result.type === 'success') activePanel = '';
						await update();
					};
				}}
				class="space-y-4 text-sm"
			>
				<input type="hidden" name="organizationId" value={data.org.id} />
				<div class="flex items-center justify-between border-b border-border pb-3">
					<label for="pref-tone" class="text-ink-secondary">Tono</label>
					<select
						id="pref-tone"
						name="tone"
						value={data.aiSettings.tone}
						disabled={!canManage}
						class="bg-transparent font-medium text-ink disabled:opacity-60"
					>
						<option value="professional">Profesional</option>
						<option value="friendly">Cercano</option>
						<option value="direct">Directo</option>
					</select>
				</div>

				<div class="flex items-center justify-between border-b border-border pb-3">
					<label for="pref-qualify" class="text-ink-secondary">Calificar leads</label>
					<input
						id="pref-qualify"
						name="autoQualifyEnabled"
						type="checkbox"
						checked={data.aiSettings.auto_qualify_enabled}
						disabled={!canManage}
						class="size-4 accent-sage-ink disabled:opacity-60"
					/>
				</div>

				<div class="flex items-center justify-between border-b border-border pb-3">
					<label for="pref-max" class="text-ink-secondary">Respuestas seguidas</label>
					<select
						id="pref-max"
						name="maxAiRepliesPerThread"
						value={String(data.aiSettings.max_ai_replies_per_thread)}
						disabled={!canManage}
						class="bg-transparent font-medium text-ink disabled:opacity-60"
					>
						<option value="3">3</option>
						<option value="5">5</option>
						<option value="8">8</option>
						<option value="10">10</option>
					</select>
				</div>

				<div>
					<label for="pref-context" class="block text-xs font-medium text-ink-secondary">
						Contexto del negocio
					</label>
					<p class="mt-0.5 text-[11px] text-ink-muted">
						Describe tu negocio, oferta, objetivo principal y reglas comerciales globales del asistente.
					</p>
					<textarea
						id="pref-context"
						name="businessContext"
						rows="5"
						maxlength={4000}
						disabled={!canManage}
						value={data.aiSettings.business_context}
						class="mt-1.5 w-full rounded-lg border border-border p-3 text-xs leading-relaxed text-ink disabled:bg-surface/50 disabled:opacity-75"
					></textarea>
				</div>

				<div>
					<label for="pref-handoff" class="block text-xs font-medium text-ink-secondary">
						Pasar a una persona cuando...
					</label>
					<textarea
						id="pref-handoff"
						name="handoffRules"
						rows="3"
						disabled={!canManage}
						value={data.aiSettings.handoff_rules}
						class="mt-1.5 w-full rounded-lg border border-border p-3 text-xs disabled:bg-surface/50 disabled:opacity-75"
					></textarea>
				</div>

				{#if form?.error && form?.action === 'updatePreferences'}
					<p role="alert" class="text-xs text-amber-ink">{form.error}</p>
				{/if}

				{#if canManage}
					<button type="submit" class="h-10 w-full rounded-lg bg-cta text-sm font-medium text-white hover:bg-cta-hover">
						Guardar preferencias
					</button>
				{:else}
					<p class="text-[11px] text-ink-muted">
						Solo administradores pueden modificar las preferencias.
					</p>
				{/if}
			</form>
		</SidePanel>

		<!-- Panel contextual: Reglas del pipeline (11_Paneles_contextuales.png) -->
		<SidePanel
			open={activePanel === 'reglas'}
			title="Reglas del pipeline"
			onClose={() => (activePanel = '')}
		>
			<form
				method="POST"
				action="?/updateRules"
				use:enhance={() => {
					return async ({ result, update }) => {
						if (result.type === 'success') activePanel = '';
						await update();
					};
				}}
				class="space-y-4"
			>
				<input type="hidden" name="organizationId" value={data.org.id} />
				<div class="divide-y divide-border">
					{#each data.stages as stage (stage.id)}
						<div class="py-3">
							<label for="rule-{stage.id}" class="block text-xs font-medium text-ink">
								{stage.name}
							</label>
							<input
								id="rule-{stage.id}"
								name="rule_{stage.id}"
								type="text"
								disabled={!canManage}
								value={stage.ai_qualification_hint}
								class="mt-1.5 h-9 w-full rounded-lg border border-border px-2.5 text-xs text-ink-secondary disabled:bg-surface/50 disabled:opacity-75"
							/>
						</div>
					{/each}
				</div>
				<p class="text-[11px] text-ink-muted">Ganado y Perdido solo los cambia tu equipo.</p>
				{#if form?.error && form?.action === 'updateRules'}
					<p role="alert" class="text-xs text-amber-ink">{form.error}</p>
				{/if}
				{#if canManage}
					<button type="submit" class="h-10 w-full rounded-lg bg-cta text-sm font-medium text-white hover:bg-cta-hover">
						Guardar reglas
					</button>
				{/if}
			</form>
		</SidePanel>
	</div>

	<!-- Modal: Fuente de conocimiento con error (18_Errores_y_recuperacion.png) -->
	<ModalDialog
		open={Boolean(errorDocModal)}
		title="Este archivo necesita atención."
		onClose={() => (errorDocModal = null)}
	>
		{#if errorDocModal}
			<p class="text-sm font-medium text-ink">{errorDocModal.title}</p>
			<p class="mt-1.5 text-sm text-ink-secondary">
				{errorDocModal.error_detail ?? 'No pudimos leerlo. Prueba cargarlo de nuevo.'}
			</p>
			<p class="mt-2 text-xs text-ink-muted">La IA sigue usando tus otras fuentes listas.</p>
			<div class="mt-6 flex flex-wrap gap-2">
				<form
					method="POST"
					action="?/retryKnowledge"
					use:enhance={() => {
						return async ({ result, update }) => {
							if (result.type === 'success') {
								errorDocModal = null;
								if (!data.denied) markWorkspaceViewsStale(data.org.slug, ['ai']);
							}
							await update();
						};
					}}
				>
					<input type="hidden" name="documentId" value={errorDocModal.id} />
					<button type="submit" class="h-10 rounded-lg bg-cta px-4 text-sm font-medium text-white">
						Reintentar
					</button>
				</form>
				{#if form?.error && form?.action === 'retryKnowledge'}
					<p role="alert" class="w-full text-xs text-amber-ink">{form.error}</p>
				{/if}
				<button
					type="button"
					onclick={() => {
						errorDocModal = null;
						kbType = 'file';
						activePanel = 'conocimiento';
					}}
					class="h-10 rounded-lg border border-border px-4 text-sm text-ink"
				>
					Reemplazar archivo
				</button>
			</div>
		{/if}
	</ModalDialog>
{/if}
