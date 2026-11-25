<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { markWorkspaceViewsStale } from '$lib/client/workspace-cache';
	import ChannelIcon from '$lib/components/shared/ChannelIcon.svelte';
	import ModalDialog from '$lib/components/ui/ModalDialog.svelte';
	import SidePanel from '$lib/components/ui/SidePanel.svelte';
	import { CHANNEL_PRICE_USD, INCLUDED_AI_REPLIES_PER_CHANNEL } from '$lib/constants/plans';
	import { hasMinRole, type Platform, type SubscriptionStatus } from '$lib/types/domain';
	import { formatRoleLabel } from '$lib/utils/format';
	import { ChevronRight, Lock, Check, Copy, CreditCard, ExternalLink, Mail } from 'lucide-svelte';

	let { data, form } = $props();

	type SettingsPanel = '' | 'workspace' | 'canales' | 'equipo' | 'plan';
	let activePanel = $state<SettingsPanel>('');
	let helpOpen = $state(false);
	let adminNotified = $state(false);
	let copiedInviteId = $state<string | null>(null);
	let inviteEmail = $state('');
	let sendingInvite = $state(false);
	let resendingInviteId = $state<string | null>(null);
	let desiredSlots = $state(1);
	let connectingKey = $state<string | null>(null);
	let connectError = $state<string | null>(null);
	let billingBusy = $state<'checkout' | 'quantity' | 'portal' | null>(null);
	let billingError = $state<string | null>(null);
	let billingNotice = $state<string | null>(null);

	$effect(() => {
		if (data.denied) return;
		const p = data.initialPanel;
		if (p === 'workspace' || p === 'canales' || p === 'equipo' || p === 'plan') {
			activePanel = p;
		}
		desiredSlots = data.org.channel_slots;
	});

	let canManage = $derived(!data.denied && hasMinRole(data.effectiveRole, 'admin'));
	let activeChannelsCount = $derived(
		data.denied ? 0 : data.channels.filter((c) => c.status === 'active').length
	);
	let hasActiveStripeSubscription = $derived(
		!data.denied &&
			Boolean(
				data.org.stripe_subscription_id &&
					data.org.subscription_status !== 'canceled' &&
					data.org.subscription_status !== 'expired'
			)
	);
	let canConnectRealChannels = $derived(
		!data.denied &&
			data.org.billing_mode === 'per_channel' &&
			data.org.subscription_status === 'active'
	);

	function subscriptionStatusLabel(status: SubscriptionStatus, billingMode: string): {
		label: string;
		className: string;
	} {
		if (status === 'active') {
			return { label: 'Suscripción activa', className: 'bg-sage-soft text-sage-ink' };
		}
		if (status === 'trialing') {
			return {
				label: billingMode === 'trial' ? 'Sin plan activo' : 'Trial Stripe',
				className: 'bg-surface text-ink-secondary'
			};
		}
		if (status === 'past_due') {
			return { label: 'Pago pendiente', className: 'bg-note-soft text-amber-ink' };
		}
		if (status === 'canceled') {
			return { label: 'Cancelada', className: 'bg-note-soft text-amber-ink' };
		}
		return { label: 'Expirada', className: 'bg-note-soft text-amber-ink' };
	}

	async function startStripeCheckout() {
		if (data.denied || billingBusy) return;
		billingError = null;
		billingNotice = null;
		billingBusy = 'checkout';
		try {
			const res = await fetch('/api/billing/checkout', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					organizationId: data.org.id,
					channelSlots: desiredSlots
				})
			});
			const payload = (await res.json()) as { checkoutUrl?: string; error?: string };
			if (!res.ok || !payload.checkoutUrl) {
				billingError = payload.error ?? 'No se pudo iniciar Stripe Checkout.';
				return;
			}
			window.location.href = payload.checkoutUrl;
		} catch {
			billingError = 'Error de red al conectar con Stripe.';
		} finally {
			billingBusy = null;
		}
	}

	async function updateStripeChannelsQuantity() {
		if (data.denied || billingBusy) return;
		billingError = null;
		billingNotice = null;
		billingBusy = 'quantity';
		try {
			const res = await fetch('/api/billing/channels-quantity', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					organizationId: data.org.id,
					channelSlots: desiredSlots
				})
			});
			const payload = (await res.json()) as {
				ok?: boolean;
				channelSlots?: number;
				pausedChannelIds?: string[];
				reactivatedChannelIds?: string[];
				error?: string;
			};
			if (!res.ok || !payload.ok) {
				billingError = payload.error ?? 'No se pudo actualizar los cupos en Stripe.';
				return;
			}

			const parts = [
				`Cupos actualizados a ${payload.channelSlots ?? desiredSlots} canal(es) con prorrateo en Stripe.`
			];
			if (payload.pausedChannelIds && payload.pausedChannelIds.length > 0) {
				parts.push(`${payload.pausedChannelIds.length} canal(es) excedente(s) pasaron a pausa.`);
			} else if (payload.reactivatedChannelIds && payload.reactivatedChannelIds.length > 0) {
				parts.push(`${payload.reactivatedChannelIds.length} canal(es) reactivado(s).`);
			}
			billingNotice = parts.join(' ');
			markWorkspaceViewsStale(data.org.slug, ['settings', 'inbox']);
			await invalidateAll();
		} catch {
			billingError = 'Error de red al actualizar cupos.';
		} finally {
			billingBusy = null;
		}
	}

	async function openStripePortal() {
		if (data.denied || billingBusy) return;
		billingError = null;
		billingNotice = null;
		billingBusy = 'portal';
		try {
			const res = await fetch('/api/billing/portal', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ organizationId: data.org.id })
			});
			const payload = (await res.json()) as { portalUrl?: string; error?: string };
			if (!res.ok || !payload.portalUrl) {
				billingError = payload.error ?? 'No se pudo abrir el portal de facturación.';
				return;
			}
			window.location.href = payload.portalUrl;
		} catch {
			billingError = 'Error de red al abrir el portal.';
		} finally {
			billingBusy = null;
		}
	}

	function platformLabel(platform: string): string {
		if (platform === 'whatsapp') return 'WhatsApp';
		if (platform === 'instagram') return 'Instagram';
		if (platform === 'facebook') return 'Messenger';
		return platform;
	}

	function mapChannelErrorMessage(code: string): string {
		switch (code) {
			case 'subscription_required':
				return 'Activa tu plan ($9 USD/canal/mes) en Configuración → Plan para conectar canales reales.';
			case 'account_in_other_org':
				return 'Esa cuenta social ya está conectada en otro workspace de Okeo.';
			case 'channel_slots_full':
				return 'Alcanzaste el límite de canales contratados en este workspace.';
			case 'oauth_cancelled':
				return 'Cancelaste la autorización con la red social antes de completarla.';
			case 'account_not_found':
				return 'No encontramos la cuenta seleccionada dentro de tu perfil de Zernio.';
			case 'missing_account_id':
				return 'Zernio no devolvió el identificador de la cuenta conectada.';
			case 'zernio_verify_failed':
				return 'No pudimos verificar la cuenta conectada con Zernio.';
			default:
				return 'No se pudo completar la conexión del canal. Intenta de nuevo.';
		}
	}

	async function startChannelOAuth(platform: Platform, channelId?: string) {
		if (data.denied) return;
		connectError = null;
		connectingKey = channelId ?? platform;
		try {
			const res = await fetch('/api/channels/connect', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					organizationId: data.org.id,
					platform,
					...(channelId ? { channelId } : {})
				})
			});
			const payload = (await res.json()) as { ok?: boolean; authUrl?: string; error?: string };
			if (!res.ok || !payload.authUrl) {
				connectError = payload.error ?? 'No se pudo iniciar la conexión del canal.';
				return;
			}
			window.location.href = payload.authUrl;
		} catch {
			connectError = 'Error de red al conectar con el servidor.';
		} finally {
			connectingKey = null;
		}
	}

	async function copyInviteLink(id: string, demoToken: string) {
		const url = `${window.location.origin}/invite/${demoToken}`;
		await navigator.clipboard?.writeText(url);
		copiedInviteId = id;
		setTimeout(() => (copiedInviteId = null), 2000);
	}
</script>

<svelte:head>
	<title>Ajustes · {data.denied ? 'okeo' : data.org.name}</title>
</svelte:head>

{#if !data.denied}
	<div class="flex min-h-0 flex-1 overflow-hidden">
		<div class="flex-1 overflow-y-auto px-5 pt-7 pb-14 sm:px-9">
			<div class="max-w-xl">
				<header>
					<h1 class="text-[28px] font-semibold tracking-tight text-ink">Ajustes</h1>
					<p class="mt-1 text-sm text-ink-muted">Lo esencial de tu espacio.</p>
				</header>

				<!-- Lista limpia de ajustes (08_Ajustes.png) -->
				<div class="mt-9 divide-y divide-border border-b border-border">
					<button
						type="button"
						onclick={() => (activePanel = 'workspace')}
						class="flex w-full items-center justify-between py-5 text-left transition-colors hover:bg-sidebar/50"
					>
						<div>
							<p class="text-sm font-semibold text-ink">Workspace</p>
							<p class="mt-1 text-xs text-ink-muted">{data.org.name}</p>
						</div>
						<ChevronRight class="size-4 text-ink-muted" aria-hidden="true" />
					</button>

					<button
						type="button"
						onclick={() => (activePanel = 'canales')}
						class="flex w-full items-center justify-between py-5 text-left transition-colors hover:bg-sidebar/50"
					>
						<div>
							<p class="text-sm font-semibold text-ink">Canales</p>
							<p class="mt-1 text-xs text-ink-muted">{activeChannelsCount} conectados</p>
						</div>
						<ChevronRight class="size-4 text-ink-muted" aria-hidden="true" />
					</button>

					<button
						type="button"
						onclick={() => (activePanel = 'equipo')}
						class="flex w-full items-center justify-between py-5 text-left transition-colors hover:bg-sidebar/50"
					>
						<div>
							<p class="text-sm font-semibold text-ink">Equipo</p>
							<p class="mt-1 text-xs text-ink-muted">
								{data.members.length} personas · Usuarios ilimitados
							</p>
						</div>
						<ChevronRight class="size-4 text-ink-muted" aria-hidden="true" />
					</button>

					<button
						type="button"
						onclick={() => (activePanel = 'plan')}
						class="flex w-full items-center justify-between py-5 text-left transition-colors hover:bg-sidebar/50"
					>
						<div>
							<p class="text-sm font-semibold text-ink">Plan</p>
							<p class="mt-1 text-xs text-ink-muted">
								{subscriptionStatusLabel(data.org.subscription_status, data.org.billing_mode).label}
								{data.org.billing_mode === 'trial'
									? ' · Activa $9 USD/canal para conectar canales reales'
									: ` · $${CHANNEL_PRICE_USD} USD/canal · ${data.org.channel_slots} canales`}
							</p>
						</div>
						<ChevronRight class="size-4 text-ink-muted" aria-hidden="true" />
					</button>
				</div>

				<div class="mt-10 space-y-4 border-t border-border pt-6">
					<button
						type="button"
						onclick={() => (helpOpen = true)}
						class="flex w-full items-center justify-between text-left text-xs text-ink-secondary hover:text-ink"
					>
						<span>Ayuda</span>
						<ChevronRight class="size-4 text-ink-muted" aria-hidden="true" />
					</button>

					<form method="POST" action="/logout">
						<button type="submit" class="block text-xs text-ink-muted hover:text-ink">
							Cerrar sesión
						</button>
					</form>
				</div>
			</div>
		</div>

		<!-- Panel Workspace -->
		<SidePanel
			open={activePanel === 'workspace'}
			title="Workspace"
			onClose={() => (activePanel = '')}
		>
			<form method="POST" action="?/updateWorkspace" use:enhance class="space-y-4">
				<input type="hidden" name="organizationId" value={data.org.id} />
				<div>
					<label for="ws-name" class="block text-xs text-ink-muted">Nombre</label>
					<input
						id="ws-name"
						name="name"
						type="text"
						required
						disabled={!canManage}
						value={data.org.name}
						class="mt-1.5 h-10 w-full rounded-lg border border-border px-3 text-sm"
					/>
				</div>
				<div>
					<label for="ws-ind" class="block text-xs text-ink-muted">Rubro</label>
					<input
						id="ws-ind"
						name="industry"
						type="text"
						required
						disabled={!canManage}
						value={data.org.industry}
						class="mt-1.5 h-10 w-full rounded-lg border border-border px-3 text-sm"
					/>
				</div>
				<div class="grid grid-cols-2 gap-3">
					<div>
						<label for="ws-cur" class="block text-xs text-ink-muted">Moneda</label>
						<select
							id="ws-cur"
							name="currency"
							disabled={!canManage}
							value={data.org.currency}
							class="mt-1.5 h-10 w-full rounded-lg border border-border px-2.5 text-sm"
						>
							<option value="MXN">MXN</option>
							<option value="USD">USD</option>
						</select>
					</div>
					<div>
						<label for="ws-lang" class="block text-xs text-ink-muted">Idioma</label>
						<select
							id="ws-lang"
							name="language"
							disabled={!canManage}
							value={data.org.language}
							class="mt-1.5 h-10 w-full rounded-lg border border-border px-2.5 text-sm"
						>
							<option value="es">Español</option>
							<option value="en">English</option>
						</select>
					</div>
				</div>
				{#if canManage}
					<button type="submit" class="h-10 w-full rounded-lg bg-cta text-sm font-medium text-white hover:bg-cta-hover">
						Guardar workspace
					</button>
				{/if}
			</form>

			<div class="mt-8 border-t border-border pt-5">
				<p class="text-xs text-ink-muted">Tus espacios</p>
				<ul class="mt-2 space-y-1.5">
					{#each data.organizations as o (o.id)}
						<li>
							<a
								href="/{o.slug}/settings?panel=workspace"
								class="flex items-center justify-between rounded-lg px-3 py-2 text-xs hover:bg-surface {o.id === data.org.id ? 'bg-sage-soft font-medium' : ''}"
							>
								<span>{o.name}</span>
								<span class="text-ink-muted">{formatRoleLabel(o.role)}</span>
							</a>
						</li>
					{/each}
				</ul>
				<a
					href="/onboarding"
					class="mt-3 inline-block text-xs font-medium text-ink hover:underline"
				>
					+ Nuevo workspace
				</a>
			</div>
		</SidePanel>

		<!-- Panel Canales (11_Paneles_contextuales.png & 19_Permisos_y_acceso.png) -->
		<SidePanel
			open={activePanel === 'canales'}
			title="Canales"
			onClose={() => (activePanel = '')}
		>
			{#if !canManage}
				<div class="rounded-xl border border-border p-5">
					<Lock class="size-4 text-ink-muted" aria-hidden="true" />
					<h3 class="mt-3 text-base font-semibold text-ink">Necesitas un administrador.</h3>
					<p class="mt-1.5 text-xs leading-relaxed text-ink-secondary">
						Tu rol ({formatRoleLabel(data.effectiveRole)}) permite atender clientes, pero no gestionar canales.
						Pide al administrador que reconecte o agregue redes.
					</p>
					{#if adminNotified}
						<p class="mt-4 rounded-lg bg-sage-soft p-3 text-xs text-ink">
							✓ Avisamos al administrador de {data.org.name}.
						</p>
					{:else}
						<button
							type="button"
							onclick={() => (adminNotified = true)}
							class="mt-5 h-10 w-full rounded-lg bg-cta text-xs font-medium text-white hover:bg-cta-hover"
						>
							Avisar al administrador
						</button>
					{/if}
				</div>
			{:else}
				<div class="mb-4 flex items-center justify-between gap-2">
					<span
						class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium {data.zernioConfigured
							? 'bg-sage-soft text-sage-ink'
							: 'bg-surface text-ink-muted'}"
					>
						<span
							class="size-1.5 rounded-full {data.zernioConfigured
								? 'bg-sage-ink'
								: 'bg-ink-muted'}"
						></span>
						{data.zernioConfigured
							? 'Zernio conectado'
							: 'Modo pruebas local · falta ZERNIO_API_KEY'}
					</span>
				</div>

				{#if data.connectedPlatform}
					<p class="mb-4 rounded-lg bg-sage-soft px-3 py-2 text-xs text-ink">
						✓ {platformLabel(data.connectedPlatform)} conectado correctamente.
					</p>
				{/if}

				{#if data.channelError || connectError}
					<p class="mb-4 rounded-lg border border-note-border bg-note-soft px-3 py-2 text-xs text-amber-ink">
						{connectError ?? mapChannelErrorMessage(data.channelError)}
					</p>
				{/if}

				<div class="divide-y divide-border">
					{#each data.channels as channel (channel.id)}
						<div class="flex items-center justify-between py-3.5 text-sm">
							<div class="flex items-center gap-2.5">
								<ChannelIcon platform={channel.platform} class="size-4 text-ink-muted" />
								<div>
									<p class="font-medium text-ink">{channel.display_name}</p>
									<p class="text-xs text-ink-muted">{channel.handle_or_phone}</p>
								</div>
							</div>
							{#if channel.status === 'active'}
								<div class="flex items-center gap-3">
									<span class="text-xs text-ink-muted">Conectado</span>
									<form method="POST" action="?/disconnectChannel" use:enhance>
										<input type="hidden" name="organizationId" value={data.org.id} />
										<input type="hidden" name="channelId" value={channel.id} />
										<button type="submit" class="text-[11px] text-ink-muted hover:text-ink">
											Desconectar
										</button>
									</form>
								</div>
							{:else if channel.status === 'paused_billing'}
								<div class="flex items-center gap-2.5">
									<span class="rounded-full bg-note-soft px-2 py-0.5 text-[11px] font-medium text-amber-ink">
										Pausado por plan
									</span>
									<button
										type="button"
										onclick={() => (activePanel = 'plan')}
										class="text-xs font-medium text-ink hover:underline"
									>
										Ajustar plan
									</button>
								</div>
							{:else if canConnectRealChannels}
								<button
									type="button"
									disabled={connectingKey !== null}
									onclick={() => startChannelOAuth(channel.platform, channel.id)}
									class="text-xs font-medium text-amber-ink hover:underline disabled:opacity-50"
								>
									{connectingKey === channel.id ? 'Conectando...' : 'Reconectar'}
								</button>
							{:else}
								<button
									type="button"
									onclick={() => (activePanel = 'plan')}
									class="text-xs font-medium text-ink hover:underline"
								>
									Activar plan
								</button>
							{/if}
						</div>
					{/each}
				</div>

				{#if !canConnectRealChannels}
					<div class="mt-5 rounded-xl border border-border bg-sidebar p-4">
						<p class="text-xs leading-relaxed text-ink-secondary">
							Activa tu suscripción (<strong class="font-medium text-ink">${CHANNEL_PRICE_USD} USD/canal/mes</strong>) para conectar WhatsApp, Instagram o Messenger reales. Mientras tanto puedes cargar tu Base de Conocimiento y probar el Simulador IA.
						</p>
						<button
							type="button"
							onclick={() => (activePanel = 'plan')}
							class="mt-3 h-10 w-full rounded-lg bg-cta text-xs font-medium text-white transition-colors hover:bg-cta-hover"
						>
							Activar plan (${CHANNEL_PRICE_USD} USD/canal/mes)
						</button>
					</div>
				{:else}
					<p class="mt-5 text-xs text-ink-muted">
						{activeChannelsCount} de {data.org.channel_slots} canales contratados
					</p>

					{#if activeChannelsCount < data.org.channel_slots}
						<div class="mt-4 space-y-2 border-t border-border pt-4">
							<p class="text-xs font-medium text-ink">Conectar nuevo canal</p>
							<div class="grid grid-cols-3 gap-2">
								{#each ['whatsapp', 'instagram', 'facebook'] as const as platform}
									<button
										type="button"
										disabled={connectingKey !== null}
										onclick={() => startChannelOAuth(platform)}
										class="flex items-center justify-center gap-1.5 rounded-lg border border-border px-2.5 py-2 text-xs font-medium text-ink transition-colors hover:bg-surface disabled:opacity-50"
									>
										<ChannelIcon {platform} class="size-3.5 text-ink-muted" />
										<span>{connectingKey === platform ? '...' : platformLabel(platform)}</span>
									</button>
								{/each}
							</div>
						</div>
					{:else}
						<button
							type="button"
							onclick={() => (activePanel = 'plan')}
							class="mt-4 h-10 w-full rounded-lg border border-border text-xs font-medium text-ink hover:bg-surface"
						>
							Añadir otro canal (+${CHANNEL_PRICE_USD} USD/mes)
						</button>
					{/if}
				{/if}
			{/if}
		</SidePanel>

		<!-- Panel Equipo (11, 16, 19) -->
		<SidePanel
			open={activePanel === 'equipo'}
			title="Equipo"
			subtitle="Usuarios ilimitados incluidos sin costo por asiento."
			widthClass="lg:w-[370px]"
			onClose={() => (activePanel = '')}
		>
			<div class="space-y-6">
				<div class="divide-y divide-border">
					{#each data.members as member (member.user_id)}
						<div class="flex items-center justify-between gap-2 py-3 text-sm">
							<div class="min-w-0">
								<p class="truncate font-medium text-ink">{member.profile.full_name}</p>
								<p class="truncate text-[11px] text-ink-muted">{member.profile.email}</p>
							</div>
							{#if canManage && member.role !== 'owner'}
								<form method="POST" action="?/updateRole" use:enhance>
									<input type="hidden" name="organizationId" value={data.org.id} />
									<input type="hidden" name="userId" value={member.user_id} />
									<select
										name="role"
										aria-label="Rol de {member.profile.full_name}"
										onchange={(e) => e.currentTarget.form?.requestSubmit()}
										class="bg-transparent text-right text-xs text-ink-secondary"
									>
										<option value="admin" selected={member.role === 'admin'}>Admin</option>
										<option value="agent" selected={member.role === 'agent'}>Agente</option>
										<option value="viewer" selected={member.role === 'viewer'}>Solo lectura</option>
									</select>
								</form>
							{:else}
								<span class="text-xs text-ink-muted">{formatRoleLabel(member.role)}</span>
							{/if}
						</div>
					{/each}
				</div>

				<!-- Solicitudes de acceso pendientes (19_Permisos_y_acceso.png) -->
				{#if canManage && data.roleChangeRequests.length > 0}
					<div class="rounded-xl border border-border bg-sidebar p-4">
						<p class="text-xs font-semibold text-ink">Solicitudes de acceso</p>
						{#each data.roleChangeRequests as req (req.id)}
							<div class="mt-2.5 flex items-center justify-between gap-2 text-xs">
								<div>
									<p class="font-medium text-ink">{req.user_name}</p>
									<p class="text-ink-muted">Solicita {formatRoleLabel(req.requested_role)}</p>
								</div>
								<div class="flex items-center gap-1.5">
									<form method="POST" action="?/resolveRoleRequest" use:enhance>
										<input type="hidden" name="requestId" value={req.id} />
										<input type="hidden" name="approve" value="true" />
										<button type="submit" class="rounded-md bg-cta px-2.5 py-1 text-white">
											Aprobar
										</button>
									</form>
									<form method="POST" action="?/resolveRoleRequest" use:enhance>
										<input type="hidden" name="requestId" value={req.id} />
										<input type="hidden" name="approve" value="false" />
										<button type="submit" class="px-2 py-1 text-ink-muted hover:text-ink">
											Rechazar
										</button>
									</form>
								</div>
							</div>
						{/each}
					</div>
				{/if}

				<!-- Invitar miembro (16_Estados_de_invitacion.png) -->
				{#if canManage}
					<div class="flex items-center justify-between gap-2">
						<span
							class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium {data.emailConfigured
								? 'bg-sage-soft text-sage-ink'
								: 'bg-surface text-ink-muted'}"
						>
							<Mail class="size-3" aria-hidden="true" />
							{data.emailConfigured
								? 'Correos automáticos activos'
								: 'Modo enlace manual · falta RESEND_API_KEY'}
						</span>
					</div>

					<form
						method="POST"
						action="?/inviteMember"
						use:enhance={() => {
							sendingInvite = true;
							return async ({ result, update }) => {
								sendingInvite = false;
								if (result.type === 'success') {
									inviteEmail = '';
									if (!data.denied) markWorkspaceViewsStale(data.org.slug, ['settings']);
								}
								await update();
							};
						}}
						class="space-y-3"
					>
						<input type="hidden" name="organizationId" value={data.org.id} />
						<p class="text-xs font-medium text-ink">Invita a tu equipo</p>
						<div class="flex gap-2">
							<label for="invite-email" class="visually-hidden">Correo de la persona</label>
							<input
								id="invite-email"
								name="email"
								type="email"
								required
								autocorrect="off"
								autocapitalize="none"
								spellcheck="false"
								bind:value={inviteEmail}
								placeholder="Correo de la persona"
								class="h-10 flex-1 rounded-lg border border-border px-3 text-xs"
							/>
							<select name="role" aria-label="Rol para invitación" class="h-10 rounded-lg border border-border px-2 text-xs">
								<option value="agent">Agente</option>
								<option value="admin">Admin</option>
								<option value="viewer">Solo lectura</option>
							</select>
						</div>
						<button
							type="submit"
							disabled={sendingInvite}
							class="h-10 w-full rounded-lg bg-cta text-xs font-medium text-white hover:bg-cta-hover disabled:opacity-60"
						>
							{sendingInvite ? 'Creando invitación...' : 'Enviar invitación'}
						</button>
					</form>

					{#if form?.error && (form?.action === 'resendInvitation' || !form?.action)}
						<p role="alert" class="rounded-lg border border-note-border bg-note-soft px-3 py-2 text-xs text-amber-ink">
							{form.error}
						</p>
					{/if}

					{#if form?.createdInvitation}
						{@const delivery = form.emailDelivery}
						<div
							role="status"
							class="rounded-xl border border-border p-3.5 text-xs {delivery?.provider === 'resend' && !delivery.sent
								? 'border-note-border bg-note-soft/70'
								: 'bg-sage-soft/70'}"
						>
							<div
								class="flex items-center gap-1.5 font-medium {delivery?.provider === 'resend' && !delivery.sent
									? 'text-amber-ink'
									: 'text-sage-ink'}"
							>
								<Check class="size-3.5" aria-hidden="true" />
								<span>
									{#if delivery?.sent}
										Correo de invitación enviado
									{:else if delivery?.provider === 'resend'}
										Invitación creada, pero falló el envío por correo
									{:else}
										Enlace de invitación listo para compartir
									{/if}
								</span>
							</div>
							<p class="mt-1 text-ink">{form.createdInvitation.email}</p>
							<p class="text-ink-muted">
								{formatRoleLabel(form.createdInvitation.role)} · El enlace vence en 7 días.
							</p>
							{#if delivery?.provider === 'resend' && !delivery.sent && delivery.error}
								<p class="mt-1.5 text-[11px] text-amber-ink">
									{delivery.error}. Comparte el enlace manualmente:
								</p>
							{:else if !delivery?.sent}
								<p class="mt-1.5 text-[11px] text-ink-muted">
									Comparte este enlace o configura <code class="rounded bg-canvas px-1 py-0.5 text-[10px]">RESEND_API_KEY</code> para enviarlo por correo automáticamente.
								</p>
							{/if}
							<div class="mt-2.5 flex items-center gap-2">
								<button
									type="button"
									onclick={() =>
										copyInviteLink(
											form.createdInvitation.id,
											form.createdInvitation.demo_token
										)}
									class="inline-flex items-center gap-1 rounded-md border border-border bg-canvas px-2.5 py-1 text-[11px]"
								>
									<Copy class="size-3" aria-hidden="true" />
									<span>{copiedInviteId === form.createdInvitation.id ? 'Copiado' : 'Copiar enlace'}</span>
								</button>
								<a
									href="/invite/{form.createdInvitation.demo_token}"
									class="text-[11px] font-medium text-ink hover:underline"
								>
									Probar enlace
								</a>
							</div>
						</div>
					{/if}

					<!-- Invitaciones pendientes -->
					{@const pendingInvs = data.invitations.filter((i) => i.status === 'pending')}
					{#if pendingInvs.length > 0}
						<div class="border-t border-border pt-4">
							<p class="text-xs text-ink-muted">Invitaciones pendientes</p>
							<div class="mt-2 space-y-2.5">
								{#each pendingInvs as inv (inv.id)}
									<div class="flex items-center justify-between gap-2 text-xs">
										<div class="min-w-0">
											<p class="truncate font-medium text-ink">{inv.email}</p>
											<p class="text-ink-muted">{formatRoleLabel(inv.role)}</p>
										</div>
										<div class="flex items-center gap-2.5">
											{#if inv.demo_token}
												<button
													type="button"
													onclick={() => copyInviteLink(inv.id, inv.demo_token)}
													class="text-ink-secondary hover:text-ink"
												>
													{copiedInviteId === inv.id ? 'Copiado' : 'Copiar'}
												</button>
											{/if}
											<form
												method="POST"
												action="?/resendInvitation"
												use:enhance={() => {
													resendingInviteId = inv.id;
													return async ({ result, update }) => {
														resendingInviteId = null;
														if (result.type === 'success' && !data.denied) {
															markWorkspaceViewsStale(data.org.slug, ['settings']);
														}
														await update();
													};
												}}
											>
												<input type="hidden" name="organizationId" value={data.org.id} />
												<input type="hidden" name="invitationId" value={inv.id} />
												<button
													type="submit"
													disabled={resendingInviteId === inv.id}
													class="text-ink-secondary hover:text-ink disabled:opacity-50"
												>
													{resendingInviteId === inv.id ? 'Enviando...' : 'Reenviar'}
												</button>
											</form>
											<form
												method="POST"
												action="?/revokeInvitation"
												use:enhance={() => {
													return async ({ result, update }) => {
														if (result.type === 'success' && !data.denied) {
															markWorkspaceViewsStale(data.org.slug, ['settings']);
														}
														await update();
													};
												}}
											>
												<input type="hidden" name="invitationId" value={inv.id} />
												<button type="submit" class="text-amber-ink hover:underline">
													Revocar
												</button>
											</form>
										</div>
									</div>
								{/each}
							</div>
						</div>
					{/if}
				{/if}

				<!-- Guía de roles (19_Permisos_y_acceso.png) -->
				<div class="border-t border-border pt-4 text-[11px] text-ink-secondary">
					<p class="font-medium text-ink">Roles en Equipo</p>
					<ul class="mt-2 space-y-1.5">
						<li><strong>Solo lectura:</strong> Consultar conversaciones y contactos.</li>
						<li><strong>Agente:</strong> Responder y gestionar oportunidades.</li>
						<li><strong>Admin:</strong> Gestionar equipo, canales y asistente.</li>
						<li><strong>Owner:</strong> Administrar el espacio y la suscripción.</li>
					</ul>
				</div>
			</div>
		</SidePanel>

		<!-- Panel Plan ($9 USD/canal/mes + 1,000 resp IA + usuarios ilimitados) -->
		<SidePanel
			open={activePanel === 'plan'}
			title="Plan"
			onClose={() => (activePanel = '')}
		>
			{#if data.usageSummary}
				{@const badge = subscriptionStatusLabel(data.org.subscription_status, data.org.billing_mode)}
				<div class="space-y-5">
					<div class="flex flex-wrap items-center justify-between gap-2">
						<span class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium {badge.className}">
							{badge.label}
						</span>
						<span
							class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium {data.stripeConfigured
								? 'bg-sage-soft text-sage-ink'
								: 'bg-surface text-ink-muted'}"
						>
							<CreditCard class="size-3" aria-hidden="true" />
							{data.stripeConfigured ? 'Stripe conectado' : 'Falta configurar Stripe'}
						</span>
					</div>

					{#if data.billingFeedback === 'success'}
						{#if hasActiveStripeSubscription}
							<p class="rounded-lg bg-sage-soft px-3 py-2 text-xs text-ink">
								✓ Pago confirmado en Stripe. Tus cupos y respuestas de IA ya están sincronizados.
							</p>
						{:else}
							<p class="rounded-lg border border-note-border bg-note-soft px-3 py-2 text-xs text-amber-ink">
								Pago recibido en Stripe. Estamos sincronizando tu suscripción; recarga en unos segundos si aún figura como trial.
							</p>
						{/if}
					{:else if data.billingFeedback === 'canceled'}
						<p class="rounded-lg border border-note-border bg-note-soft px-3 py-2 text-xs text-amber-ink">
							El proceso de pago en Stripe fue cancelado; no se realizó ningún cargo.
						</p>
					{/if}

					{#if billingNotice}
						<p class="rounded-lg bg-sage-soft px-3 py-2 text-xs text-ink">
							✓ {billingNotice}
						</p>
					{/if}

					{#if billingError}
						<p class="rounded-lg border border-note-border bg-note-soft px-3 py-2 text-xs text-amber-ink">
							{billingError}
						</p>
					{/if}

					<div>
						<p class="text-lg font-semibold text-ink">
							{data.org.billing_mode === 'trial'
								? 'Sin suscripción activa'
								: `$${data.usageSummary.monthlyTotalUsd} USD/mes`}
						</p>
						<p class="mt-0.5 text-xs text-ink-muted">
							${CHANNEL_PRICE_USD} USD/canal · {INCLUDED_AI_REPLIES_PER_CHANNEL.toLocaleString('en-US')} respuestas IA por canal · Usuarios ilimitados
						</p>
					</div>

					<!-- Barra de consumo -->
					<div>
						<div class="flex items-center justify-between text-xs">
							<span class="text-ink-secondary">Respuestas de IA</span>
							<span class="font-medium text-ink">
								{data.usageSummary.usedAiReplies.toLocaleString('en-US')} / {data.usageSummary.includedAiReplies.toLocaleString('en-US')}
							</span>
						</div>
						<div class="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface">
							<div
								class="h-full rounded-full bg-sage-ink/70 transition-all"
								style="width: {data.usageSummary.usagePercent}%"
							></div>
						</div>
					</div>

					<p class="text-xs text-ink-secondary">
						Canales {data.usageSummary.activeChannelsCount}/{data.usageSummary.channelSlots} · Equipo {data.members.length} (Ilimitados)
					</p>

					{#if canManage}
						<div class="space-y-3 border-t border-border pt-4">
							<div class="flex items-center justify-between text-xs">
								<label for="plan-slots" class="font-medium text-ink">Canales contratados</label>
								<input
									id="plan-slots"
									type="number"
									min="1"
									max="50"
									bind:value={desiredSlots}
									disabled={billingBusy !== null}
									class="h-9 w-20 rounded-lg border border-border px-2.5 text-center text-sm"
								/>
							</div>

							<p class="text-[11px] text-ink-muted">
								Total: ${desiredSlots * CHANNEL_PRICE_USD} USD/mes · {(desiredSlots * INCLUDED_AI_REPLIES_PER_CHANNEL).toLocaleString('en-US')} respuestas IA/mes incluidas
							</p>

							{#if hasActiveStripeSubscription && desiredSlots < activeChannelsCount}
								<p class="rounded-lg border border-note-border bg-note-soft px-3 py-2 text-[11px] text-amber-ink">
									Tienes {activeChannelsCount} canales activos. Al bajar a {desiredSlots}, los {activeChannelsCount - desiredSlots} más recientes pasarán a pausa sin borrar tu historial.
								</p>
							{/if}

							{#if hasActiveStripeSubscription}
								<button
									type="button"
									disabled={!data.stripeConfigured || billingBusy !== null || desiredSlots === data.org.channel_slots}
									onclick={updateStripeChannelsQuantity}
									class="h-10 w-full rounded-lg bg-cta text-xs font-medium text-white hover:bg-cta-hover disabled:opacity-50"
								>
									{billingBusy === 'quantity'
										? 'Actualizando en Stripe...'
										: 'Actualizar cupos (prorrateo Stripe)'}
								</button>

								{#if data.org.stripe_customer_id}
									<button
										type="button"
										disabled={!data.stripeConfigured || billingBusy !== null}
										onclick={openStripePortal}
										class="flex h-10 w-full items-center justify-center gap-1.5 rounded-lg border border-border text-xs font-medium text-ink hover:bg-surface disabled:opacity-50"
									>
										<span>
											{billingBusy === 'portal'
												? 'Abriendo portal...'
												: 'Gestionar facturación y facturas'}
										</span>
										<ExternalLink class="size-3.5 text-ink-muted" aria-hidden="true" />
									</button>
								{/if}
							{:else}
								<button
									type="button"
									disabled={!data.stripeConfigured || billingBusy !== null}
									onclick={startStripeCheckout}
									class="h-10 w-full rounded-lg bg-cta text-xs font-medium text-white hover:bg-cta-hover disabled:opacity-50"
								>
									{billingBusy === 'checkout'
										? 'Redirigiendo a Stripe...'
										: `Activar plan ($${desiredSlots * CHANNEL_PRICE_USD} USD/mes)`}
								</button>

								{#if data.org.stripe_customer_id}
									<button
										type="button"
										disabled={!data.stripeConfigured || billingBusy !== null}
										onclick={openStripePortal}
										class="flex h-10 w-full items-center justify-center gap-1.5 rounded-lg border border-border text-xs font-medium text-ink hover:bg-surface disabled:opacity-50"
									>
										<span>Ver historial de facturas</span>
										<ExternalLink class="size-3.5 text-ink-muted" aria-hidden="true" />
									</button>
								{/if}
							{/if}

							{#if !data.stripeConfigured}
								<p class="text-[11px] text-ink-muted">
									Agrega <code class="rounded bg-surface px-1 py-0.5 text-[10px]">STRIPE_SECRET_KEY</code>,
									<code class="rounded bg-surface px-1 py-0.5 text-[10px]">STRIPE_CHANNEL_PRICE_ID</code> y
									<code class="rounded bg-surface px-1 py-0.5 text-[10px]">STRIPE_WEBHOOK_SECRET</code> en tu archivo
									<code class="rounded bg-surface px-1 py-0.5 text-[10px]">.env</code> para habilitar Checkout y Portal reales.
								</p>
							{/if}
						</div>
					{/if}

					<p class="text-[11px] text-ink-muted">
						Puedes seguir viendo y respondiendo mensajes manualmente aunque se pause un canal o agotes tu cuota de IA.
					</p>
				</div>
			{/if}
		</SidePanel>
	</div>

	<ModalDialog bind:open={helpOpen} title="Ayuda y soporte">
		<p class="text-sm text-ink-secondary">
			¿Necesitas ayuda conectando WhatsApp Cloud API o Instagram? Escríbenos a soporte@okeo.app o consulta la guía rápida del workspace.
		</p>
		<div class="mt-5 flex justify-end">
			<button
				type="button"
				onclick={() => (helpOpen = false)}
				class="h-10 rounded-lg bg-cta px-4 text-sm font-medium text-white"
			>
				Entendido
			</button>
		</div>
	</ModalDialog>
{/if}
