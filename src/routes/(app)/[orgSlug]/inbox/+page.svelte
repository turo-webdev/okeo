<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import {
		markWorkspaceViewsStale,
		patchWorkspaceConversation,
		revalidateWorkspaceViewNow
	} from '$lib/client/workspace-cache';
	import { subscribeOrgRealtime } from '$lib/supabase/realtime';
	import MessageAttachments from '$lib/components/inbox/MessageAttachments.svelte';
	import ChannelIcon from '$lib/components/shared/ChannelIcon.svelte';
	import EmptyState from '$lib/components/shared/EmptyState.svelte';
	import ModalDialog from '$lib/components/ui/ModalDialog.svelte';
	import PopupMenu from '$lib/components/ui/PopupMenu.svelte';
	import SidePanel from '$lib/components/ui/SidePanel.svelte';
	import {
		hasMinRole,
		type ContactNote,
		type Message,
		type MessageAttachment,
		type Platform
	} from '$lib/types/domain';
	import type { InboxConversationItem } from '$lib/types/workspace-views';
	import { formatMoneyCents, formatPlatformLabel, formatRoleLabel } from '$lib/utils/format';
	import {
		Search,
		Check,
		Sparkles,
		FileText,
		Lock,
		Users,
		ArrowLeft,
		ChevronRight,
		AlertTriangle,
		Clock,
		Send,
		X
	} from 'lucide-svelte';

	let { data, form } = $props();

	type ViewFilter = 'pending' | 'needs_reply' | 'mine' | 'all';
	let viewFilter = $state<ViewFilter>('pending');
	let channelFilter = $state<'all' | Platform>('all');
	let searchOpen = $state(false);
	let searchQuery = $state('');

	let selectedConvId = $state<string | null>(null);
	let mobileThreadOpen = $state(false);
	let clientPanelOpen = $state(false);

	type ConvPatch = Partial<
		Pick<
			InboxConversationItem,
			| 'ai_paused'
			| 'status'
			| 'assigned_to'
			| 'last_message_preview'
			| 'needs_reply'
			| 'unread_count'
		>
	>;

	let optimisticConvPatches = $state<Record<string, ConvPatch>>({});
	let optimisticMessages = $state<Message[]>([]);
	let optimisticNotes = $state<ContactNote[]>([]);
	let inboxActionError = $state('');
	let extraMessagesByConv = $state<Record<string, Message[]>>({});
	let historyMetaByConv = $state<
		Record<string, { hasMore: boolean; nextBeforeId: number | null; loading: boolean; loaded: boolean }>
	>({});
	let activeInboxOrgId = '';
	const convSeqById: Record<string, number> = {};

	$effect(() => {
		if (data.denied) return;
		if (data.org.id !== activeInboxOrgId) {
			activeInboxOrgId = data.org.id;
			optimisticConvPatches = {};
			optimisticMessages = [];
			optimisticNotes = [];
			inboxActionError = '';
			extraMessagesByConv = {};
			historyMetaByConv = {};
			pendingAttachment = null;
			pendingAttachmentPreview = null;
			uploadingAttachment = false;
			localAttachmentUrls = {};
		}
		if (
			!selectedConvId ||
			!data.conversations.some((c) => c.id === selectedConvId)
		) {
			selectedConvId = data.activeConversationId;
		}
		if (data.hasExplicitChatParam) {
			mobileThreadOpen = true;
		}
	});

	let composerTab = $state<'reply' | 'note'>('reply');
	let replyText = $state('');
	let noteText = $state('');
	let noteSavedFeedback = $state(false);
	let draftLoading = $state(false);
	let draftError = $state<string | null>(null);
	let retryingMessageId = $state<number | null>(null);
	let editingNextStep = $state(false);
	let showTeamNotes = $state(false);
	let showHistory = $state(false);

	// Adjuntos de salida en Inbox
	let fileInputEl = $state<HTMLInputElement | null>(null);
	let pendingAttachment = $state<MessageAttachment | null>(null);
	let pendingAttachmentPreview = $state<string | null>(null);
	let uploadingAttachment = $state(false);
	let localAttachmentUrls = $state<Record<string, string>>({});

	// Modals
	let requestAccessOpen = $state(false);
	let requestSent = $state(false);

	let canAct = $derived(!data.denied && hasMinRole(data.effectiveRole, 'agent'));
	let canManage = $derived(!data.denied && hasMinRole(data.effectiveRole, 'admin'));

	let viewFilterLabel = $derived.by(() => {
		switch (viewFilter) {
			case 'pending':
				return 'Pendientes';
			case 'needs_reply':
				return 'Necesitan respuesta';
			case 'mine':
				return 'Míos';
			case 'all':
				return 'Todos';
		}
	});

	$effect(() => {
		if (data.denied) return;
		return subscribeOrgRealtime({
			organizationId: data.org.id,
			tables: ['conversations', 'messages', 'connected_channels'],
			onChange: () => {
				revalidateWorkspaceViewNow(data.user.id, data.org.slug, 'inbox', data.loadNonce);
			}
		});
	});

	let effectiveConversations = $derived.by(() => {
		if (data.denied) return [];
		return data.conversations.map((conv) =>
			optimisticConvPatches[conv.id] ? { ...conv, ...optimisticConvPatches[conv.id] } : conv
		);
	});

	let filteredConversations = $derived.by(() => {
		if (data.denied) return [];
		const q = searchQuery.trim().toLowerCase();
		return effectiveConversations.filter((conv) => {
			if (viewFilter === 'pending' && conv.status === 'closed') return false;
			if (viewFilter === 'needs_reply' && !conv.needs_reply) return false;
			if (viewFilter === 'mine' && conv.assigned_to !== data.user.id) return false;
			if (channelFilter !== 'all' && conv.platform !== channelFilter) return false;

			if (q) {
				const contact = data.contacts.find((c) => c.id === conv.contact_id);
				const hay = `${contact?.name ?? ''} ${contact?.company ?? ''} ${conv.last_message_preview}`.toLowerCase();
				if (!hay.includes(q)) return false;
			}
			return true;
		});
	});

	let activeConv = $derived.by(() => {
		if (data.denied) return null;
		return (
			effectiveConversations.find((c) => c.id === selectedConvId) ??
			filteredConversations[0] ??
			effectiveConversations[0] ??
			null
		);
	});

	let activeContact = $derived.by(() => {
		if (data.denied || !activeConv) return null;
		return data.contacts.find((c) => c.id === activeConv.contact_id) ?? null;
	});

	let activeMessages = $derived.by(() => {
		if (data.denied || !activeConv) return [];
		const convId = activeConv.id;
		const byId = new Map<number, Message>();
		for (const m of data.messages) {
			if (m.conversation_id === convId) byId.set(m.id, m);
		}
		for (const m of extraMessagesByConv[convId] ?? []) {
			if (!byId.has(m.id)) byId.set(m.id, m);
		}
		const persisted = Array.from(byId.values());
		const combined = [...persisted];
		for (const om of optimisticMessages) {
			if (om.conversation_id !== convId) continue;
			const omTs = Date.parse(om.created_at);
			const matched = persisted.some(
				(pm) =>
					pm.direction === om.direction &&
					pm.body === om.body &&
					Date.parse(pm.created_at) >= omTs - 5000
			);
			if (!matched) combined.push(om);
		}
		return combined.sort(
			(a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id
		);
	});

	let activeHistoryMeta = $derived(
		activeConv ? (historyMetaByConv[activeConv.id] ?? null) : null
	);

	let activeNotes = $derived.by(() => {
		if (data.denied || !activeContact) return [];
		const contactId = activeContact.id;
		const persisted = data.notes.filter((n) => n.contact_id === contactId);
		const pending = optimisticNotes.filter((on) => {
			if (on.contact_id !== contactId) return false;
			const onTs = Date.parse(on.created_at);
			return !persisted.some(
				(pn) => pn.body === on.body && Date.parse(pn.created_at) >= onTs - 5000
			);
		});
		return [...pending, ...persisted];
	});

	$effect(() => {
		if (data.denied || !activeConv) return;
		const convId = activeConv.id;
		const meta = historyMetaByConv[convId];
		if (meta?.loaded || meta?.loading) return;
		const localCount = data.messages.filter((m) => m.conversation_id === convId).length;
		if (localCount === 0 || localCount >= 40 || data.messages.length >= 100) {
			void loadConversationMessages(convId);
		}
	});

	async function loadConversationMessages(convId: string, beforeId?: number) {
		if (data.denied) return;
		const existing = historyMetaByConv[convId];
		if (existing?.loading) return;
		historyMetaByConv = {
			...historyMetaByConv,
			[convId]: {
				hasMore: existing?.hasMore ?? false,
				nextBeforeId: existing?.nextBeforeId ?? null,
				loading: true,
				loaded: existing?.loaded ?? false
			}
		};
		try {
			const params = new URLSearchParams({ conversationId: convId, limit: '40' });
			if (beforeId !== undefined) params.set('beforeId', String(beforeId));
			const res = await fetch(
				`/api/workspace/${encodeURIComponent(data.org.slug)}/messages?${params.toString()}`,
				{ credentials: 'same-origin' }
			);
			const payload = (await res.json()) as {
				ok?: boolean;
				messages?: Message[];
				hasMore?: boolean;
				nextBeforeId?: number | null;
			};
			if (!res.ok || !payload?.ok || !Array.isArray(payload.messages)) {
				throw new Error('Failed to load messages');
			}
			const currentExtra = extraMessagesByConv[convId] ?? [];
			const byId = new Map<number, Message>();
			for (const m of payload.messages) byId.set(m.id, m);
			for (const m of currentExtra) byId.set(m.id, m);
			extraMessagesByConv = {
				...extraMessagesByConv,
				[convId]: Array.from(byId.values())
			};
			historyMetaByConv = {
				...historyMetaByConv,
				[convId]: {
					hasMore: Boolean(payload.hasMore),
					nextBeforeId: payload.nextBeforeId ?? null,
					loading: false,
					loaded: true
				}
			};
		} catch {
			historyMetaByConv = {
				...historyMetaByConv,
				[convId]: {
					hasMore: existing?.hasMore ?? false,
					nextBeforeId: existing?.nextBeforeId ?? null,
					loading: false,
					loaded: existing?.loaded ?? false
				}
			};
		}
	}

	async function updateConversationOptimistic(convId: string, patch: ConvPatch) {
		if (data.denied || !canAct) return;
		const orgId = data.org.id;
		const orgSlug = data.org.slug;
		const userId = data.user.id;
		const nonce = data.loadNonce;
		const prevPatch = optimisticConvPatches[convId];
		const seq = (convSeqById[convId] ?? 0) + 1;
		convSeqById[convId] = seq;

		inboxActionError = '';
		optimisticConvPatches = {
			...optimisticConvPatches,
			[convId]: { ...(prevPatch ?? {}), ...patch }
		};
		patchWorkspaceConversation(orgSlug, convId, patch);

		const fd = new FormData();
		fd.set('organizationId', orgId);
		fd.set('conversationId', convId);
		if (patch.assigned_to !== undefined) {
			fd.set('assignedTo', patch.assigned_to ?? '');
		}
		if (patch.status !== undefined) {
			fd.set('status', patch.status);
		}
		if (patch.ai_paused !== undefined) {
			fd.set('aiPaused', String(patch.ai_paused));
		}

		try {
			const res = await fetch(`/${orgSlug}/inbox?/updateConversation`, {
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
			if (convSeqById[convId] !== seq) return;
			if (!res.ok || actionType === 'failure' || actionType === 'error') {
				throw new Error('Action failed');
			}
			revalidateWorkspaceViewNow(userId, orgSlug, 'inbox', nonce);
			markWorkspaceViewsStale(orgSlug, ['pipeline']);
		} catch {
			if (convSeqById[convId] !== seq) return;
			const next = { ...optimisticConvPatches };
			if (prevPatch) {
				next[convId] = prevPatch;
			} else {
				delete next[convId];
			}
			optimisticConvPatches = next;
			inboxActionError = 'No se pudo actualizar la conversación. Se revirtió el cambio.';
			revalidateWorkspaceViewNow(userId, orgSlug, 'inbox', nonce);
		}
	}

	function formatAttachmentBytes(bytes: number): string {
		if (!Number.isFinite(bytes) || bytes <= 0) return '';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	async function handleInboxFileChange(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file || data.denied || !canAct || !activeConv) return;

		if (file.size > 10 * 1024 * 1024) {
			inboxActionError = 'El archivo excede el límite máximo de 10 MB.';
			return;
		}

		uploadingAttachment = true;
		inboxActionError = '';
		try {
			const fd = new FormData();
			fd.set('organizationId', data.org.id);
			fd.set('conversationId', activeConv.id);
			fd.set('file', file);

			const res = await fetch('/api/media/upload', {
				method: 'POST',
				body: fd
			});
			const payload = (await res.json().catch(() => ({}))) as {
				ok?: boolean;
				attachment?: MessageAttachment;
				previewUrl?: string | null;
				error?: string;
			};
			if (!res.ok || !payload.ok || !payload.attachment) {
				throw new Error(payload.error ?? 'No se pudo subir el archivo.');
			}

			pendingAttachment = payload.attachment;
			pendingAttachmentPreview = payload.previewUrl ?? null;
			if (payload.previewUrl) {
				localAttachmentUrls = {
					...localAttachmentUrls,
					[payload.attachment.storage_path]: payload.previewUrl
				};
			}
		} catch (err) {
			inboxActionError =
				err instanceof Error ? err.message : 'No se pudo adjuntar el archivo.';
		} finally {
			uploadingAttachment = false;
		}
	}

	async function submitReplyOptimistic(e: SubmitEvent) {
		e.preventDefault();
		if (data.denied || !canAct || !activeConv || uploadingAttachment) return;
		const body = replyText.trim();
		const attachment = pendingAttachment;
		const previewUrlSnapshot = pendingAttachmentPreview;
		if (!body && !attachment) return;

		const orgId = data.org.id;
		const orgSlug = data.org.slug;
		const userId = data.user.id;
		const nonce = data.loadNonce;
		const convId = activeConv.id;
		const channelId = activeConv.channel_id;
		const retryId = retryingMessageId;
		const tempId = -(Date.now() * 1000 + Math.floor(Math.random() * 1000));
		const now = new Date();
		const timeStr = now.toLocaleTimeString('es-MX', {
			hour: '2-digit',
			minute: '2-digit',
			hour12: false
		});

		const attLabel =
			attachment?.kind === 'image'
				? 'Imagen'
				: attachment?.kind === 'audio'
					? 'Audio'
					: 'Archivo';
		const previewText = body
			? `Tú: ${body}`
			: attachment
				? `Tú: [${attLabel}] ${attachment.file_name}`
				: 'Tú: [Mensaje]';

		const tempMsg: Message = {
			id: tempId,
			organization_id: orgId,
			conversation_id: convId,
			channel_id: channelId,
			external_message_id: null,
			direction: 'outbound',
			sender_type: 'agent',
			sender_user_id: userId,
			sender_label: `Tú · ${data.user.full_name}`,
			body,
			attachments: attachment ? [attachment] : [],
			status: 'sent',
			error_code: null,
			error_detail: null,
			day_group: 'Hoy',
			display_time: timeStr,
			created_at: now.toISOString()
		};

		const convPatch: ConvPatch = {
			ai_paused: true,
			needs_reply: false,
			unread_count: 0,
			last_message_preview: previewText
		};

		replyText = '';
		pendingAttachment = null;
		pendingAttachmentPreview = null;
		retryingMessageId = null;
		inboxActionError = '';
		optimisticMessages = [...optimisticMessages, tempMsg];
		optimisticConvPatches = {
			...optimisticConvPatches,
			[convId]: { ...(optimisticConvPatches[convId] ?? {}), ...convPatch }
		};
		patchWorkspaceConversation(orgSlug, convId, convPatch);

		try {
			const res = await fetch('/api/messages/send', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					organizationId: orgId,
					conversationId: convId,
					body,
					...(retryId ? { retryMessageId: retryId } : {}),
					...(attachment ? { attachment } : {})
				})
			});
			const payload = (await res.json().catch(() => ({}))) as {
				ok?: boolean;
				error?: string;
			};
			if (!res.ok || !payload.ok) {
				throw new Error(payload.error ?? 'No se pudo enviar el mensaje.');
			}
			revalidateWorkspaceViewNow(userId, orgSlug, 'inbox', nonce);
		} catch (err) {
			optimisticMessages = optimisticMessages.filter((m) => m.id !== tempId);
			if (!replyText.trim()) replyText = body;
			if (!pendingAttachment && attachment) {
				pendingAttachment = attachment;
				pendingAttachmentPreview = previewUrlSnapshot;
			}
			inboxActionError =
				err instanceof Error ? err.message : 'No se pudo enviar el mensaje.';
			revalidateWorkspaceViewNow(userId, orgSlug, 'inbox', nonce);
		}
	}

	async function submitNoteOptimistic(e: SubmitEvent) {
		e.preventDefault();
		if (data.denied || !canAct || !activeConv || !activeContact) return;
		const body = noteText.trim();
		if (!body) return;

		const orgId = data.org.id;
		const orgSlug = data.org.slug;
		const userId = data.user.id;
		const nonce = data.loadNonce;
		const convId = activeConv.id;
		const contactId = activeContact.id;
		const tempId = -(Date.now() * 1000 + Math.floor(Math.random() * 1000));
		const now = new Date();
		const timeStr = now.toLocaleTimeString('es-MX', {
			hour: '2-digit',
			minute: '2-digit',
			hour12: false
		});

		const tempNote: ContactNote = {
			id: tempId,
			organization_id: orgId,
			contact_id: contactId,
			conversation_id: convId,
			author_user_id: userId,
			author_name: data.user.full_name,
			body,
			created_at: now.toISOString(),
			display_time: `Hoy, ${timeStr}`
		};

		noteText = '';
		noteSavedFeedback = true;
		inboxActionError = '';
		optimisticNotes = [tempNote, ...optimisticNotes];

		const fd = new FormData();
		fd.set('organizationId', orgId);
		fd.set('contactId', contactId);
		fd.set('conversationId', convId);
		fd.set('body', body);

		try {
			const res = await fetch(`/${orgSlug}/inbox?/saveNote`, {
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
			if (!res.ok || actionType === 'failure' || actionType === 'error') {
				throw new Error('No se pudo guardar la nota.');
			}
			revalidateWorkspaceViewNow(userId, orgSlug, 'inbox', nonce);
			markWorkspaceViewsStale(orgSlug, ['pipeline', 'contacts']);
		} catch {
			optimisticNotes = optimisticNotes.filter((n) => n.id !== tempId);
			noteSavedFeedback = false;
			if (!noteText.trim()) noteText = body;
			inboxActionError = 'No se pudo guardar la nota.';
		}
	}

	let activeIdentities = $derived.by(() => {
		if (data.denied || !activeContact) return [];
		return data.identities.filter((i) => i.contact_id === activeContact.id);
	});

	let activeDeal = $derived.by(() => {
		if (data.denied || !activeContact) return null;
		return (
			data.deals.find((d) => {
				const stage = data.stages.find((s) => s.id === d.stage_id);
				return d.contact_id === activeContact.id && !stage?.is_terminal;
			}) ??
			data.deals.find((d) => d.contact_id === activeContact.id) ??
			null
		);
	});

	let activeTimeline = $derived.by(() => {
		if (data.denied || !activeContact) return [];
		return data.timelineEvents.filter((e) => e.contact_id === activeContact.id);
	});

	let assignedMember = $derived.by(() => {
		if (data.denied || !activeConv?.assigned_to) return null;
		return data.members.find((m) => m.user_id === activeConv.assigned_to) ?? null;
	});

	function selectConversation(id: string) {
		selectedConvId = id;
		mobileThreadOpen = true;
		retryingMessageId = null;
		pendingAttachment = null;
		pendingAttachmentPreview = null;
		draftError = null;
		goto(`/${data.org?.slug}/inbox?chat=${id}`, { replaceState: true, noScroll: true, keepFocus: true });
	}

	async function suggestAiDraft() {
		if (!activeConv || data.denied || !canAct) return;
		draftLoading = true;
		draftError = null;
		composerTab = 'reply';
		try {
			const res = await fetch('/api/ai/draft', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					organizationId: data.org.id,
					conversationId: activeConv.id
				})
			});
			const payload = await res.json();
			if (!res.ok) {
				draftError = payload.error ?? 'No se pudo sugerir una respuesta.';
			} else {
				replyText = payload.draft;
			}
		} catch {
			draftError = 'Error de red al consultar al asistente.';
		} finally {
			draftLoading = false;
		}
	}

	function handleComposerKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			if (uploadingAttachment || (!replyText.trim() && !pendingAttachment)) return;
			const formEl = (e.currentTarget as HTMLTextAreaElement).closest('form');
			formEl?.requestSubmit();
		}
	}
</script>

<svelte:head>
	<title>Inbox · {data.denied ? 'okeo' : data.org.name}</title>
</svelte:head>

{#if !data.denied}
	<div class="flex min-h-0 flex-1 overflow-hidden">
		<!-- Columna 1: Lista de conversaciones -->
		<section
			aria-label="Lista de conversaciones"
			class="flex w-full shrink-0 flex-col border-r border-border bg-canvas lg:w-[295px] {mobileThreadOpen ? 'hidden lg:flex' : 'flex'}"
		>
			<div class="flex items-center justify-between px-5 pt-6 pb-3">
				<div class="flex items-baseline gap-2">
					<h1 class="text-[22px] font-semibold tracking-tight text-ink">Inbox</h1>
					<span class="text-xs text-ink-muted">{filteredConversations.length}</span>
				</div>
				<button
					type="button"
					onclick={() => (searchOpen = !searchOpen)}
					aria-label="Buscar conversaciones"
					aria-expanded={searchOpen}
					class="rounded-md p-1.5 text-ink-secondary hover:bg-surface hover:text-ink"
				>
					<Search class="size-4" aria-hidden="true" />
				</button>
			</div>

			{#if searchOpen}
				<search class="px-4 pb-3">
					<label for="inbox-search" class="visually-hidden">Buscar conversación</label>
					<input
						id="inbox-search"
						type="search"
						bind:value={searchQuery}
						placeholder="Buscar por nombre o mensaje..."
						class="h-9 w-full rounded-lg border border-border px-3 text-xs placeholder:text-ink-muted"
					/>
				</search>
			{/if}

			<!-- Filtros (20_Filtros_y_notas.png) -->
			<div class="space-y-1.5 px-4 pb-3">
				<div>
					<PopupMenu
						label={viewFilterLabel}
						menuLabel="Filtrar conversaciones"
						triggerClass="px-2 py-1 text-xs font-medium text-ink hover:bg-surface"
					>
						{#snippet children({ close })}
							{#each [
								{ id: 'pending', title: 'Pendientes', desc: 'Abiertas por atender' },
								{ id: 'needs_reply', title: 'Necesitan respuesta', desc: 'Esperan una respuesta del equipo' },
								{ id: 'mine', title: 'Míos', desc: 'Asignadas a ti' },
								{ id: 'all', title: 'Todos', desc: 'Abiertas y resueltas' }
							] as opt (opt.id)}
								<button
									type="button"
									onclick={() => {
										viewFilter = opt.id as ViewFilter;
										close();
									}}
									class="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left hover:bg-surface {viewFilter === opt.id ? 'bg-sage-soft' : ''}"
								>
									<span>
										<span class="block text-sm font-medium text-ink">{opt.title}</span>
										<span class="block text-[11px] text-ink-muted">{opt.desc}</span>
									</span>
									{#if viewFilter === opt.id}
										<Check class="size-3.5 text-sage-ink" aria-hidden="true" />
									{/if}
								</button>
							{/each}
						{/snippet}
					</PopupMenu>
				</div>

				<div>
					<PopupMenu
						label={channelFilter === 'all' ? 'Todos los canales' : formatPlatformLabel(channelFilter)}
						menuLabel="Filtrar por canal"
						triggerClass="px-2 py-1 text-xs text-ink-secondary hover:bg-surface"
					>
						{#snippet children({ close })}
							{#each [
								{ id: 'all', label: 'Todos los canales' },
								{ id: 'whatsapp', label: 'WhatsApp' },
								{ id: 'instagram', label: 'Instagram' },
								{ id: 'facebook', label: 'Messenger' }
							] as ch (ch.id)}
								<button
									type="button"
									onclick={() => {
										channelFilter = ch.id as 'all' | Platform;
										close();
									}}
									class="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-surface"
								>
									<span>{ch.label}</span>
									{#if channelFilter === ch.id}
										<Check class="size-3.5 text-sage-ink" aria-hidden="true" />
									{/if}
								</button>
							{/each}
						{/snippet}
					</PopupMenu>
				</div>
			</div>

			<!-- Lista o Empty States (17_Estados_vacios.png) -->
			<div class="flex-1 overflow-y-auto px-2.5 pb-4">
				{#if data.channels.filter((c) => c.status === 'active').length === 0}
					<div class="p-3">
						<EmptyState
							title="Conecta tu primer canal."
							description="Tus conversaciones aparecerán aquí. Empieza con la red que más uses."
							actionLabel={canManage ? 'Conectar un canal' : undefined}
							actionHref="/{data.org.slug}/settings?panel=canales"
						/>
					</div>
				{:else if effectiveConversations.length === 0}
					<div class="p-3">
						<EmptyState
							title="Tu bandeja está lista."
							description="Envía un mensaje de prueba a tu cuenta. Lo verás aquí cuando llegue."
							actionLabel="Actualizar Inbox"
							onAction={() => {
								if (!data.denied) {
									revalidateWorkspaceViewNow(data.user.id, data.org.slug, 'inbox', data.loadNonce);
								}
							}}
							secondaryLabel="Revisar canales"
							secondaryHref="/{data.org.slug}/settings?panel=canales"
						/>
					</div>
				{:else if filteredConversations.length === 0}
					<div class="p-3">
						<EmptyState
							title={searchQuery ? 'No encontramos coincidencias.' : 'Todo al día.'}
							description={searchQuery
								? 'Prueba otro nombre, empresa o quita los filtros activos.'
								: 'No hay conversaciones pendientes. Te avisaremos cuando llegue una nueva.'}
							actionLabel={searchQuery ? 'Limpiar filtros' : 'Ver todas las conversaciones'}
							onAction={() => {
								searchQuery = '';
								channelFilter = 'all';
								viewFilter = 'all';
							}}
						/>
					</div>
				{:else}
					<ul class="space-y-1">
						{#each filteredConversations as conv (conv.id)}
							{@const contact = data.contacts.find((c) => c.id === conv.contact_id)}
							{@const selected = activeConv?.id === conv.id}
							<li>
								<button
									type="button"
									onclick={() => selectConversation(conv.id)}
									class="flex w-full flex-col rounded-xl px-3.5 py-3 text-left transition-colors {selected ? 'bg-sage-soft' : 'hover:bg-surface/70'}"
								>
									<div class="flex items-center justify-between gap-2">
										<span class="truncate text-sm font-medium text-ink">
											{contact?.name ?? 'Contacto'}
										</span>
										<span class="shrink-0 text-[11px] text-ink-muted">{conv.display_time}</span>
									</div>
									<p class="mt-0.5 truncate text-xs text-ink-secondary">
										{conv.last_message_preview}
									</p>
									<div class="mt-1.5 flex items-center justify-between gap-2">
										<span class="inline-flex items-center gap-1.5 text-[11px] {conv.needs_reply ? 'font-medium text-amber-ink' : 'text-ink-muted'}">
											<ChannelIcon platform={conv.platform} class="size-3" />
											<span>
												{conv.needs_reply ? 'Necesita respuesta' : formatPlatformLabel(conv.platform)}
											</span>
										</span>
										{#if conv.unread_count > 0}
											<span class="size-1.5 rounded-full bg-sage-ink" aria-label="Sin leer"></span>
										{/if}
									</div>
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</section>

		<!-- Columna 2: Hilo activo -->
		<section
			aria-label="Hilo de conversación"
			class="flex min-w-0 flex-1 flex-col bg-canvas {mobileThreadOpen ? 'flex' : 'hidden lg:flex'}"
		>
			{#if activeConv && activeContact}
				<!-- Header del chat -->
				<header class="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-4 sm:px-7">
					<div class="flex items-center gap-3">
						<button
							type="button"
							onclick={() => (mobileThreadOpen = false)}
							aria-label="Volver a conversaciones"
							class="rounded-md p-1 text-ink-secondary hover:bg-surface lg:hidden"
						>
							<ArrowLeft class="size-4" aria-hidden="true" />
						</button>
						<div>
							<p class="text-base font-semibold text-ink">{activeContact.name}</p>
							<p class="text-xs text-ink-muted">{formatPlatformLabel(activeConv.platform)}</p>
						</div>
					</div>

					<div class="flex flex-wrap items-center gap-2 sm:gap-3">
						<!-- Asignar vendedor (20_Filtros_y_notas.png) -->
						{#if canAct}
							<PopupMenu
								label={assignedMember?.profile.full_name ?? 'Sin asignar'}
								menuLabel="Asignar conversación"
								triggerClass="px-2.5 py-1.5 text-xs text-ink-secondary hover:bg-surface"
							>
								{#snippet children({ close })}
									<div class="px-2.5 py-1.5 text-xs font-medium text-ink">Asignar conversación</div>
									{#each data.members as member (member.user_id)}
										<button
											type="button"
											onclick={() => {
												if (activeConv) {
													void updateConversationOptimistic(activeConv.id, {
														assigned_to: member.user_id
													});
												}
												close();
											}}
											class="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs hover:bg-surface"
										>
											<span>
												<span class="block font-medium text-ink">{member.profile.full_name}</span>
												<span class="block text-[11px] text-ink-muted">{formatRoleLabel(member.role)}</span>
											</span>
											{#if activeConv.assigned_to === member.user_id}
												<Check class="size-3.5 text-sage-ink" aria-hidden="true" />
											{/if}
										</button>
									{/each}
									<button
										type="button"
										onclick={() => {
											if (activeConv) {
												void updateConversationOptimistic(activeConv.id, { assigned_to: null });
											}
											close();
										}}
										class="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-xs text-ink-secondary hover:bg-surface"
									>
										<span>Sin asignar</span>
									</button>
								{/snippet}
							</PopupMenu>

							<!-- Toggle IA pausada / activa -->
							<button
								type="button"
								onclick={() => {
									if (activeConv) {
										void updateConversationOptimistic(activeConv.id, {
											ai_paused: !activeConv.ai_paused
										});
									}
								}}
								title={activeConv.ai_handoff_reason ?? 'Cambiar estado de IA en este chat'}
								class="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-ink-secondary hover:bg-surface"
							>
								<span
									class="size-1.5 rounded-full {activeConv.ai_paused ? 'bg-ink-muted' : 'bg-sage-ink'}"
								></span>
								<span>{activeConv.ai_paused ? 'IA pausada' : 'IA activa'}</span>
							</button>

							<!-- Resolver / Reabrir -->
							<button
								type="button"
								onclick={() => {
									if (!activeConv) return;
									const reopening = activeConv.status === 'closed';
									void updateConversationOptimistic(activeConv.id, {
										status: reopening ? 'pending' : 'closed',
										unread_count: reopening ? activeConv.unread_count : 0,
										needs_reply: reopening ? activeConv.needs_reply : false
									});
								}}
								class="inline-flex items-center gap-1.5 rounded-lg border border-border bg-canvas px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-surface"
							>
								<Check class="size-3.5" aria-hidden="true" />
								<span>{activeConv.status === 'closed' ? 'Reabrir' : 'Resolver'}</span>
							</button>
						{/if}

						<button
							type="button"
							onclick={() => (clientPanelOpen = !clientPanelOpen)}
							aria-expanded={clientPanelOpen}
							class="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-ink-secondary hover:bg-surface hover:text-ink"
						>
							<Users class="size-4 lg:hidden" aria-hidden="true" />
							<span class="hidden sm:inline">{clientPanelOpen ? 'Ocultar contacto' : 'Ver contacto'}</span>
						</button>
					</div>
				</header>

				<!-- Mensajes y tarjetas contextuales -->
				<div class="flex-1 overflow-y-auto px-4 py-6 sm:px-8">
					<div class="mx-auto max-w-2xl space-y-5">
						{#if !activeConv.within24h && activeConv.last_inbound_at}
							<div
								role="status"
								class="flex items-center gap-2 rounded-lg border border-note-border bg-note-soft px-3.5 py-2 text-xs text-note-ink"
							>
								<Clock class="size-3.5 shrink-0" aria-hidden="true" />
								<span>
									Ventana de 24h de Meta cerrada (último mensaje del cliente hace más de 24 horas).
								</span>
							</div>
						{/if}

						{#if activeHistoryMeta?.hasMore && activeHistoryMeta.nextBeforeId}
							<div class="flex justify-center">
								<button
									type="button"
									disabled={activeHistoryMeta.loading}
									onclick={() =>
										activeConv &&
										activeHistoryMeta?.nextBeforeId &&
										void loadConversationMessages(activeConv.id, activeHistoryMeta.nextBeforeId)}
									class="rounded-full border border-border bg-canvas px-3.5 py-1.5 text-xs text-ink-secondary transition-colors hover:bg-surface hover:text-ink disabled:opacity-50"
								>
									{activeHistoryMeta.loading ? 'Cargando mensajes...' : 'Cargar mensajes anteriores'}
								</button>
							</div>
						{/if}

						{#if activeMessages[0]}
							<p class="text-xs text-ink-muted">{activeMessages[0].day_group}</p>
						{/if}

						{#each activeMessages as msg (msg.id)}
							{#if msg.direction === 'inbound'}
								<div class="flex flex-col items-start">
									<div class="max-w-[85%] rounded-2xl bg-surface px-4 py-3 text-sm leading-relaxed whitespace-pre-line text-ink sm:max-w-[75%]">
										{#if msg.attachments.length > 0}
											<MessageAttachments
												organizationId={data.org.id}
												attachments={msg.attachments}
												initialUrls={localAttachmentUrls}
											/>
										{/if}
										{#if msg.body.trim() && !(msg.attachments.length > 0 && msg.body.trim() === '[Archivo adjunto]')}
											<p class={msg.attachments.length > 0 ? 'mt-2' : ''}>{msg.body}</p>
										{/if}
									</div>
									<span class="mt-1.5 text-[11px] text-ink-muted">
										{msg.sender_label} · {msg.display_time}
									</span>
								</div>
							{:else}
								<div class="flex flex-col items-end">
									<div
										class="max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-line text-ink sm:max-w-[75%] {msg.sender_type === 'ai'
											? 'border border-border bg-canvas'
											: 'bg-sage-bubble'}"
									>
										{#if msg.attachments.length > 0}
											<MessageAttachments
												organizationId={data.org.id}
												attachments={msg.attachments}
												initialUrls={localAttachmentUrls}
											/>
										{/if}
										{#if msg.body.trim()}
											<p class={msg.attachments.length > 0 ? 'mt-2' : ''}>{msg.body}</p>
										{/if}
									</div>
									<span class="mt-1.5 inline-flex items-center gap-1 text-[11px] text-ink-muted">
										{#if msg.sender_type === 'ai'}
											<Sparkles class="size-3" aria-hidden="true" />
										{/if}
										<span>{msg.sender_label} · {msg.display_time}</span>
									</span>

									<!-- Estado de fallo recuperable (18_Errores_y_recuperacion.png) -->
									{#if msg.status === 'failed'}
										<div class="mt-2 flex flex-wrap items-center justify-end gap-2 text-xs">
											<span class="inline-flex items-center gap-1 text-amber-ink">
												<AlertTriangle class="size-3.5" aria-hidden="true" />
												<span>{msg.error_detail ?? 'No se pudo enviar.'}</span>
											</span>
											{#if canAct}
												<form method="POST" action="?/sendMessage" use:enhance class="inline">
													<input type="hidden" name="organizationId" value={data.org.id} />
													<input type="hidden" name="conversationId" value={activeConv.id} />
													<input type="hidden" name="body" value={msg.body} />
													<input type="hidden" name="retryMessageId" value={msg.id} />
													{#if msg.attachments[0]}
														<input type="hidden" name="attachmentJson" value={JSON.stringify(msg.attachments[0])} />
													{/if}
													<button
														type="submit"
														class="rounded-md bg-cta px-2.5 py-1 text-[11px] font-medium text-white hover:bg-cta-hover"
													>
														Reintentar envío
													</button>
												</form>
												<button
													type="button"
													onclick={() => {
														composerTab = 'reply';
														replyText = msg.body;
														retryingMessageId = msg.id;
														if (msg.attachments[0]) {
															pendingAttachment = msg.attachments[0];
															pendingAttachmentPreview =
																localAttachmentUrls[msg.attachments[0].storage_path] ?? null;
														}
													}}
													class="text-[11px] text-ink-secondary hover:text-ink"
												>
													Editar mensaje
												</button>
											{/if}
										</div>
									{/if}
								</div>
							{/if}
						{/each}

						<!-- Notas internas guardadas dentro del hilo (20_Filtros_y_notas.png / 23) -->
						{#each activeNotes.filter((n) => n.conversation_id === activeConv.id) as note (note.id)}
							<div class="rounded-xl border border-note-border bg-note-soft p-4">
								<div class="flex items-center gap-1.5 text-xs font-medium text-note-ink">
									<Lock class="size-3.5" aria-hidden="true" />
									<span>Nota interna · {note.author_name}</span>
								</div>
								<p class="mt-2 text-sm leading-relaxed whitespace-pre-line text-ink">
									{note.body}
								</p>
								<p class="mt-2 text-[11px] text-ink-muted">{note.display_time} · Solo tu equipo</p>
							</div>
						{/each}
					</div>
				</div>

				<!-- Composer inferior -->
				<div class="border-t border-border px-4 py-4 sm:px-8">
					<div class="mx-auto max-w-2xl">
						{#if !canAct}
							<!-- Rol Solo lectura (19_Permisos_y_acceso.png) -->
							<div class="flex items-start gap-3 rounded-xl border border-border bg-sidebar p-4">
								<Lock class="mt-0.5 size-4 shrink-0 text-ink-muted" aria-hidden="true" />
								<div class="text-xs">
									<p class="font-medium text-ink">Tu rol es de solo lectura.</p>
									<p class="mt-0.5 text-ink-secondary">
										Puedes consultar, pero no responder o editar.
									</p>
									<button
										type="button"
										onclick={() => {
											requestSent = false;
											requestAccessOpen = true;
										}}
										class="mt-2 font-medium text-sage-ink hover:underline"
									>
										Solicitar acceso para responder
									</button>
								</div>
							</div>
						{:else}
							<div class="mb-2.5 flex items-center justify-between gap-2">
								<div class="flex items-center gap-5 text-xs">
									<button
										type="button"
										onclick={() => (composerTab = 'reply')}
										class="pb-1 transition-colors {composerTab === 'reply' ? 'border-b-2 border-ink font-medium text-ink' : 'text-ink-muted hover:text-ink'}"
									>
										Responder
									</button>
									<button
										type="button"
										onclick={() => (composerTab = 'note')}
										class="pb-1 transition-colors {composerTab === 'note' ? 'border-b-2 border-note-ink font-medium text-ink' : 'text-ink-muted hover:text-ink'}"
									>
										Nota interna
									</button>
								</div>

								<button
									type="button"
									onclick={suggestAiDraft}
									disabled={draftLoading}
									class="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-ink-secondary transition-colors hover:bg-surface hover:text-ink disabled:opacity-60"
								>
									<Sparkles class="size-3.5" aria-hidden="true" />
									<span>{draftLoading ? 'Generando...' : 'Sugerir respuesta'}</span>
								</button>
							</div>

							{#if inboxActionError}
								<p role="alert" class="mb-2 text-xs text-amber-ink">{inboxActionError}</p>
							{/if}

							{#if draftError}
								<p role="alert" class="mb-2 text-xs text-amber-ink">{draftError}</p>
							{/if}

							{#if composerTab === 'reply'}
								<form
									onsubmit={submitReplyOptimistic}
									class="rounded-xl border border-border bg-canvas p-3 focus-within:border-border-strong"
								>
									<label for="inbox-file-upload" class="visually-hidden">
										Adjuntar imagen, audio o documento
									</label>
									<input
										id="inbox-file-upload"
										bind:this={fileInputEl}
										type="file"
										accept="image/jpeg,image/png,image/webp,image/gif,audio/ogg,audio/mpeg,audio/mp4,audio/wav,audio/webm,.pdf,.txt,.csv,.docx,.xlsx"
										onchange={handleInboxFileChange}
										class="visually-hidden"
									/>

									{#if uploadingAttachment}
										<div
											role="status"
											class="mb-2 flex items-center justify-between rounded-lg border border-border bg-surface/60 px-3 py-2 text-xs text-ink-secondary"
										>
											<span>Subiendo adjunto...</span>
										</div>
									{:else if pendingAttachment}
										<div class="mb-2 flex items-center justify-between gap-2 rounded-lg border border-border bg-surface/60 px-3 py-2 text-xs">
											<div class="flex min-w-0 items-center gap-2.5">
												{#if pendingAttachment.kind === 'image' && pendingAttachmentPreview}
													<img
														src={pendingAttachmentPreview}
														alt={pendingAttachment.file_name}
														class="size-9 shrink-0 rounded object-cover"
													/>
												{:else}
													<FileText class="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
												{/if}
												<div class="min-w-0">
													<p class="truncate font-medium text-ink">{pendingAttachment.file_name}</p>
													<p class="text-[11px] text-ink-muted">
														{formatAttachmentBytes(pendingAttachment.size_bytes)}
													</p>
												</div>
											</div>
											<button
												type="button"
												onclick={() => {
													pendingAttachment = null;
													pendingAttachmentPreview = null;
												}}
												aria-label="Quitar adjunto"
												class="rounded p-1 text-ink-muted hover:bg-canvas hover:text-ink"
											>
												<X class="size-3.5" aria-hidden="true" />
											</button>
										</div>
									{/if}

									<label for="reply-composer" class="visually-hidden">Escribe tu respuesta</label>
									<textarea
										id="reply-composer"
										name="body"
										rows="2"
										bind:value={replyText}
										onkeydown={handleComposerKeydown}
										placeholder="Escribe tu respuesta..."
										class="w-full resize-none bg-transparent text-sm text-ink placeholder:text-ink-muted focus:outline-none"
									></textarea>
									<div class="mt-2 flex items-center justify-between">
										<button
											type="button"
											disabled={uploadingAttachment}
											onclick={() => fileInputEl?.click()}
											title="Adjuntar archivo (máx. 10 MB)"
											aria-label="Adjuntar archivo"
											class="rounded-md p-1.5 text-ink-muted hover:bg-surface hover:text-ink disabled:opacity-50"
										>
											<FileText class="size-4" aria-hidden="true" />
										</button>
										<button
											type="submit"
											disabled={uploadingAttachment || (!replyText.trim() && !pendingAttachment)}
											class="inline-flex h-9 items-center gap-1.5 rounded-lg bg-cta px-4 text-xs font-medium text-white transition-colors hover:bg-cta-hover disabled:opacity-45"
										>
											<span class="hidden sm:inline">Enviar</span>
											<Send class="size-3.5 sm:hidden" aria-hidden="true" />
										</button>
									</div>
								</form>
							{:else}
								<form
									onsubmit={submitNoteOptimistic}
									class="rounded-xl border border-note-border bg-note-soft p-3.5"
								>
									<div class="mb-2 flex items-center gap-1.5 text-xs font-medium text-note-ink">
										<Lock class="size-3.5" aria-hidden="true" />
										<span>Solo visible para tu equipo</span>
									</div>
									<label for="note-composer" class="visually-hidden">Escribe una nota interna</label>
									<textarea
										id="note-composer"
										name="body"
										rows="2"
										bind:value={noteText}
										placeholder="Escribe una nota interna para tu equipo..."
										class="w-full resize-none bg-transparent text-sm text-ink placeholder:text-note-ink/60 focus:outline-none"
									></textarea>
									<div class="mt-2 flex items-center justify-between">
										<span class="text-[11px] text-ink-muted">Esta nota no se envía al cliente.</span>
										<button
											type="submit"
											disabled={!noteText.trim()}
											class="h-9 rounded-lg bg-cta px-4 text-xs font-medium text-white transition-colors hover:bg-cta-hover disabled:opacity-45"
										>
											Guardar nota
										</button>
									</div>
								</form>
								{#if noteSavedFeedback || form?.action === 'saveNote'}
									<p class="mt-2 text-xs text-sage-ink">
										✓ Nota guardada. Tu cliente no recibe un mensaje.
									</p>
								{/if}
							{/if}
						{/if}
					</div>
				</div>
			{:else}
				<div class="flex flex-1 items-center justify-center p-6">
					<EmptyState
						title="Selecciona una conversación"
						description="Elige un mensaje de la izquierda para ver el historial y responder."
					/>
				</div>
			{/if}
		</section>

		<!-- Columna 3: Panel contextual Cliente (02_Inbox_con_cliente.png) -->
		{#if activeContact}
			<SidePanel
				open={clientPanelOpen}
				title="Cliente"
				onClose={() => (clientPanelOpen = false)}
			>
				<div>
					<h3 class="text-xl font-semibold text-ink">{activeContact.name}</h3>
					{#if activeContact.company}
						<p class="mt-0.5 text-sm text-ink-secondary">{activeContact.company}</p>
					{/if}
					{#if activeContact.email}
						<p class="mt-2 text-xs text-ink-muted">{activeContact.email}</p>
					{/if}

					<div class="mt-4 flex items-center justify-between border-b border-border pb-4 text-xs">
						<span class="text-ink-muted">Vendedor</span>
							{#if canAct}
								<form method="POST" action="?/updateClientMeta" use:enhance>
									<input type="hidden" name="organizationId" value={data.org.id} />
									<input type="hidden" name="contactId" value={activeContact.id} />
								<select
									name="ownerUserId"
									aria-label="Vendedor asignado"
									onchange={(e) => e.currentTarget.form?.requestSubmit()}
									class="rounded-md bg-transparent py-1 text-right text-xs font-medium text-ink"
								>
									<option value="">Sin asignar</option>
									{#each data.members as m (m.user_id)}
										<option value={m.user_id} selected={activeContact.owner_user_id === m.user_id}>
											{m.profile.full_name}
										</option>
									{/each}
								</select>
							</form>
						{:else}
							<span class="font-medium text-ink">
								{data.members.find((m) => m.user_id === activeContact.owner_user_id)?.profile.full_name ?? 'Sin asignar'}
							</span>
						{/if}
					</div>

					<!-- Resumen IA -->
					<div class="border-b border-border py-4">
						<p class="text-xs text-ink-muted">Resumen IA</p>
						<p class="mt-1.5 text-sm leading-relaxed text-ink">
							{activeContact.lead_summary ?? 'Sin resumen todavía.'}
						</p>
						<a
							href="/{data.org.slug}/contacts/{activeContact.id}"
							class="mt-2 inline-block text-xs font-medium text-ink hover:underline"
						>
							Ver detalle
						</a>
					</div>

					<!-- Oportunidad -->
					{#if activeDeal}
						<div class="border-b border-border py-4">
							<p class="text-xs text-ink-muted">Oportunidad</p>
							<p class="mt-1.5 text-sm font-semibold text-ink">{activeDeal.title}</p>
							<p class="mt-0.5 text-sm text-ink-secondary">
								{formatMoneyCents(activeDeal.value_cents, activeDeal.currency)}
							</p>
							{#if canAct}
								<form method="POST" action="?/updateDealStage" use:enhance class="mt-2.5">
									<input type="hidden" name="organizationId" value={data.org.id} />
									<input type="hidden" name="dealId" value={activeDeal.id} />
									<select
										name="stageId"
										aria-label="Etapa de la oportunidad"
										onchange={(e) => e.currentTarget.form?.requestSubmit()}
										class="w-full rounded-lg border border-border bg-canvas px-2.5 py-1.5 text-xs font-medium text-ink"
									>
										{#each data.stages as st (st.id)}
											<option value={st.id} selected={activeDeal.stage_id === st.id}>
												{st.name}
											</option>
										{/each}
									</select>
								</form>
							{/if}
							{#if activeDeal.ai_updated_label}
								<p class="mt-1.5 text-[11px] text-ink-muted">{activeDeal.ai_updated_label}</p>
							{/if}
						</div>
					{/if}

					<!-- Siguiente paso -->
					<div class="border-b border-border py-4">
						<p class="text-xs text-ink-muted">Siguiente paso</p>
						{#if editingNextStep && canAct}
							<form
								method="POST"
								action="?/updateClientMeta"
								use:enhance={() => {
									return async ({ update }) => {
										editingNextStep = false;
										await update();
									};
								}}
								class="mt-2 space-y-2"
							>
								<input type="hidden" name="organizationId" value={data.org.id} />
								<input type="hidden" name="contactId" value={activeContact.id} />
								<input
									name="nextStepTitle"
									type="text"
									value={activeContact.next_step_title ?? ''}
									placeholder="Ej. Llamada con Mariana"
									class="h-9 w-full rounded-lg border border-border px-2.5 text-xs"
								/>
								<input
									name="nextStepAtLabel"
									type="text"
									value={activeContact.next_step_at_label ?? ''}
									placeholder="Ej. Hoy, 16:00"
									class="h-9 w-full rounded-lg border border-border px-2.5 text-xs"
								/>
								<div class="flex justify-end gap-2">
									<button
										type="button"
										onclick={() => (editingNextStep = false)}
										class="text-xs text-ink-muted"
									>
										Cancelar
									</button>
									<button
										type="submit"
										class="rounded-md bg-cta px-3 py-1 text-xs font-medium text-white"
									>
										Guardar
									</button>
								</div>
							</form>
						{:else}
							<div class="mt-1.5 flex items-start justify-between gap-2">
								<div>
									<p class="text-sm font-medium text-ink">
										{activeContact.next_step_title ?? 'Sin definir'}
									</p>
									{#if activeContact.next_step_at_label}
										<p class="mt-0.5 text-xs text-ink-muted">{activeContact.next_step_at_label}</p>
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

					<!-- Canales vinculados -->
					{#if activeIdentities.length > 0}
						<div class="border-b border-border py-4">
							<p class="text-xs text-ink-muted">Canales vinculados</p>
							<ul class="mt-2 space-y-1.5 text-xs">
								{#each activeIdentities as ident (ident.id)}
									<li class="flex items-center justify-between text-ink-secondary">
										<span>{formatPlatformLabel(ident.platform)}</span>
										<span class="text-ink">{ident.username_or_phone}</span>
									</li>
								{/each}
							</ul>
						</div>
					{/if}

					<!-- Acordeones ligeros -->
					<div class="divide-y divide-border border-b border-border">
						<div>
							<button
								type="button"
								onclick={() => (showTeamNotes = !showTeamNotes)}
								aria-expanded={showTeamNotes}
								class="flex w-full items-center justify-between py-3.5 text-sm text-ink"
							>
								<span>Notas del equipo ({activeNotes.length})</span>
								<ChevronRight class="size-4 text-ink-muted transition-transform {showTeamNotes ? 'rotate-90' : ''}" aria-hidden="true" />
							</button>
							{#if showTeamNotes}
								<div class="space-y-2 pb-3.5">
									{#each activeNotes as n (n.id)}
										<div class="rounded-lg bg-note-soft p-2.5 text-xs text-ink">
											<p class="whitespace-pre-line">{n.body}</p>
											<p class="mt-1 text-[10px] text-ink-muted">{n.author_name} · {n.display_time}</p>
										</div>
									{:else}
										<p class="text-xs text-ink-muted">Sin notas internas.</p>
									{/each}
								</div>
							{/if}
						</div>

						<div>
							<button
								type="button"
								onclick={() => (showHistory = !showHistory)}
								aria-expanded={showHistory}
								class="flex w-full items-center justify-between py-3.5 text-sm text-ink"
							>
								<span>Historial ({activeTimeline.length})</span>
								<ChevronRight class="size-4 text-ink-muted transition-transform {showHistory ? 'rotate-90' : ''}" aria-hidden="true" />
							</button>
							{#if showHistory}
								<ul class="space-y-2 pb-3.5 text-xs">
									{#each activeTimeline as evt (evt.id)}
										<li>
											<p class="font-medium text-ink">{evt.title}</p>
											<p class="text-ink-muted">{evt.detail} · {evt.timestamp_label}</p>
										</li>
									{:else}
										<li class="text-ink-muted">Sin eventos registrados.</li>
									{/each}
								</ul>
							{/if}
						</div>
					</div>

					<a
						href="/{data.org.slug}/contacts/{activeContact.id}"
						class="mt-4 inline-block text-xs font-medium text-ink hover:underline"
					>
						Ver perfil completo
					</a>
				</div>
			</SidePanel>
		{/if}
	</div>

	<!-- Modal: Solicitar acceso para responder (19_Permisos_y_acceso.png) -->
	<ModalDialog bind:open={requestAccessOpen} title="Solicitar acceso para responder">
		{#if requestSent}
			<p class="text-sm font-medium text-ink">Tu solicitud está pendiente.</p>
			<p class="mt-1.5 text-sm text-ink-secondary">
				Te avisaremos cuando un administrador de {data.org.name} la revise.
			</p>
			<div class="mt-5 flex justify-end">
				<button
					type="button"
					onclick={() => (requestAccessOpen = false)}
					class="h-10 rounded-lg bg-cta px-4 text-sm font-medium text-white"
				>
					Seguir en modo lectura
				</button>
			</div>
		{:else}
			<p class="text-sm text-ink-secondary">
				Se enviará una solicitud al administrador de {data.org.name}.
			</p>
			<div class="mt-4">
				<p class="text-xs text-ink-muted">Acceso solicitado</p>
				<span class="mt-1.5 inline-block rounded-md bg-sage-soft px-2.5 py-1 text-xs font-medium text-sage-ink">
					Agente
				</span>
				<p class="mt-2 text-xs text-ink-secondary">
					Podrás responder chats y actualizar oportunidades.
				</p>
			</div>
			<form
				method="POST"
				action="?/requestAccess"
				use:enhance={() => {
					return async ({ result, update }) => {
						if (result.type === 'success') requestSent = true;
						await update();
					};
				}}
				class="mt-6 flex justify-end gap-2"
			>
				<input type="hidden" name="organizationId" value={data.org.id} />
				<input type="hidden" name="requestedRole" value="agent" />
				<button
					type="button"
					onclick={() => (requestAccessOpen = false)}
					class="h-10 rounded-lg border border-border px-4 text-sm text-ink-secondary"
				>
					Cancelar
				</button>
				<button
					type="submit"
					class="h-10 rounded-lg bg-cta px-4 text-sm font-medium text-white hover:bg-cta-hover"
				>
					Enviar solicitud
				</button>
			</form>
		{/if}
	</ModalDialog>
{/if}
