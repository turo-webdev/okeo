<script lang="ts">
	import BrandLogo from '$lib/components/shared/BrandLogo.svelte';
	import ModalDialog from '$lib/components/ui/ModalDialog.svelte';
	import { ArrowRight, Play, Sparkles } from 'lucide-svelte';

	let videoModalOpen = $state(false);
</script>

<svelte:head>
	<title>okeo — Convierte conversaciones en clientes</title>
</svelte:head>

<div class="min-h-dvh bg-canvas text-ink">
	<!-- Navbar 100% self-serve -->
	<header class="sticky top-0 z-30 border-b border-border/70 bg-canvas/95 backdrop-blur">
		<div class="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-8">
			<a href="/" class="inline-flex items-center">
				<BrandLogo />
			</a>

			<nav aria-label="Navegación principal" class="hidden items-center gap-7 text-sm text-ink-secondary md:flex">
				<a href="#producto" class="hover:text-ink">Producto</a>
				<a href="#como-funciona" class="hover:text-ink">Cómo funciona</a>
				<a href="#preguntas" class="hover:text-ink">Preguntas</a>
			</nav>

			<div class="flex items-center gap-4">
				<a href="/login" class="hidden text-sm text-ink-secondary hover:text-ink sm:inline-block">
					Iniciar sesión
				</a>
				<a
					href="/onboarding"
					class="inline-flex h-9 items-center rounded-lg bg-cta px-4 text-xs font-medium text-white transition-colors hover:bg-cta-hover sm:text-sm"
				>
					<span class="sm:hidden">Prueba gratis</span>
					<span class="hidden sm:inline">Empezar gratis</span>
				</a>
			</div>
		</div>
	</header>

	<main>
		<!-- Hero -->
		<section class="mx-auto max-w-5xl px-4 pt-14 pb-16 text-center sm:px-8 sm:pt-20">
			<p class="text-[11px] font-medium tracking-[0.16em] text-ink-muted uppercase">
				TU NEGOCIO, UN POCO MÁS LIGERO.
			</p>
			<h1 class="mx-auto mt-4 max-w-2xl text-4xl font-semibold tracking-tight text-ink sm:text-6xl sm:leading-[1.06]">
				Convierte conversaciones en clientes.
			</h1>
			<p class="mt-4 text-xl font-medium text-sage-ink sm:text-2xl">
				Sin vivir pendiente del chat.
			</p>
			<p class="mx-auto mt-4 max-w-md text-sm leading-relaxed text-ink-secondary sm:text-base">
				Reúne tus mensajes, califica leads y da seguimiento en un solo lugar.
				Okeo te ayuda con la IA. Tú llevas la relación.
			</p>

			<div class="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row sm:gap-5">
				<a
					href="/onboarding"
					class="inline-flex h-11 w-full max-w-xs items-center justify-center gap-2 rounded-lg bg-cta px-6 text-sm font-medium text-white transition-colors hover:bg-cta-hover sm:w-auto"
				>
					<span>Prueba gratis 14 días</span>
					<ArrowRight class="size-4" aria-hidden="true" />
				</a>
				<button
					type="button"
					onclick={() => (videoModalOpen = true)}
					class="inline-flex h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium text-ink-secondary transition-colors hover:bg-surface hover:text-ink"
				>
					<Play class="size-3.5 fill-current" aria-hidden="true" />
					<span>Ver demo en video</span>
				</button>
			</div>

			<p class="mt-6 text-xs text-ink-muted">WhatsApp · Instagram · Messenger</p>

			<!-- Hero UI Preview -->
			<div class="mt-10 rounded-2xl border border-border bg-sidebar/70 p-4 text-left shadow-sm sm:p-6">
				<div class="flex items-center justify-between pb-3 text-xs text-ink-muted">
					<span>Tu día, en orden.</span>
					<span>Inbox · Okeo</span>
				</div>
				<div class="grid overflow-hidden rounded-xl border border-border bg-canvas md:grid-cols-[170px_230px_1fr]">
					<div class="hidden border-r border-border bg-sidebar p-4 md:block">
						<BrandLogo size="sm" />
						<p class="mt-4 text-xs font-medium text-ink">Wunderside</p>
						<div class="mt-5 space-y-2 text-xs text-ink-secondary">
							<div class="rounded-md bg-sage-soft px-2.5 py-1.5 font-medium text-ink">Inbox</div>
							<div class="px-2.5 py-1">Pipeline</div>
							<div class="px-2.5 py-1">Contactos</div>
						</div>
					</div>
					<div class="hidden border-r border-border p-4 md:block">
						<div class="flex items-center justify-between">
							<span class="text-sm font-semibold">Inbox <span class="text-xs font-normal text-ink-muted">4</span></span>
						</div>
						<div class="mt-4 space-y-2.5 text-xs">
							<div class="rounded-lg bg-sage-soft/75 p-2.5">
								<div class="flex justify-between font-medium"><span>Mariana López</span><span class="text-ink-muted">10:42</span></div>
								<p class="mt-0.5 truncate text-ink-secondary">¿Empezaríamos por el branding?</p>
							</div>
							<div class="p-2">
								<div class="flex justify-between font-medium"><span>Diego Ramírez</span><span class="text-ink-muted">10:18</span></div>
								<p class="mt-0.5 truncate text-amber-ink">Necesita respuesta</p>
							</div>
							<div class="p-2">
								<div class="flex justify-between font-medium"><span>Ana Torres</span><span class="text-ink-muted">09:56</span></div>
								<p class="mt-0.5 truncate text-ink-secondary">¿Incluye la tienda en línea?</p>
							</div>
						</div>
					</div>
					<div class="p-4 sm:p-5">
						<div class="flex items-center justify-between border-b border-border pb-3">
							<div>
								<p class="text-sm font-semibold">Mariana López</p>
								<p class="text-[11px] text-ink-muted">WhatsApp</p>
							</div>
							<span class="rounded-md border border-border px-2.5 py-1 text-xs">✓ Resolver</span>
						</div>
						<div class="mt-4 space-y-3 text-xs">
							<div class="max-w-xs rounded-xl bg-surface px-3.5 py-2.5 text-ink">
								Hola, ¿qué incluye el servicio de branding?
							</div>
							<div class="ml-auto max-w-xs rounded-xl border border-border px-3.5 py-2.5 text-ink">
								Trabajamos estrategia, identidad visual y manual de marca.
								<div class="mt-1 flex items-center justify-end gap-1 text-[10px] text-ink-muted">
									<Sparkles class="size-3" aria-hidden="true" />
									<span>Asistente IA · 10:29</span>
								</div>
							</div>
							<div class="ml-auto max-w-xs rounded-xl bg-sage-bubble px-3.5 py-2.5 text-ink">
								Podemos revisarlo hoy por la tarde. ¿Qué alcance tienes en mente?
							</div>
						</div>
					</div>
				</div>
				<p class="mt-3 text-center text-[11px] text-ink-muted">
					Interfaz de Okeo · Conversación de ejemplo —
					<a href="/wunderside/inbox" class="font-medium text-ink underline underline-offset-2">
						Explorar el espacio interactivo
					</a>
				</p>
			</div>
		</section>

		<!-- Declaración -->
		<section class="mx-auto max-w-3xl px-4 py-16 text-center sm:px-8">
			<h2 class="text-2xl font-semibold tracking-tight text-ink sm:text-4xl">
				Tu próximo cliente ya te escribió.
				<span class="block text-sage-ink">Que no se quede esperando.</span>
			</h2>
			<p class="mx-auto mt-5 max-w-xl text-sm leading-relaxed text-ink-secondary sm:text-base">
				Mientras atiendes tu negocio, los mensajes se acumulan. Una respuesta que se retrasa.
				Una cotización que se enfría. Un seguimiento que se olvida. No necesitas estar en todo.
				Necesitas tener claro qué sigue.
			</p>
		</section>

		<!-- 3 Bloques de producto -->
		<div id="producto" class="space-y-12">
			<!-- 01 -->
			<section class="mx-auto grid max-w-6xl items-center gap-10 px-4 py-10 sm:px-8 lg:grid-cols-2">
				<div>
					<p class="text-[11px] font-medium tracking-[0.14em] text-ink-muted uppercase">01 / RESPONDE A TIEMPO</p>
					<h2 class="mt-3 text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
						Cada conversación, en su lugar.
					</h2>
					<p class="mt-3 text-sm leading-relaxed text-ink-secondary sm:text-base">
						WhatsApp, Instagram y Messenger en una sola bandeja. Tu equipo sabe qué responder
						y quién se encarga, sin perder el contexto del cliente.
					</p>
					<p class="mt-4 text-sm font-medium text-ink">Menos saltar entre apps. Más atender bien.</p>
				</div>
				<div class="rounded-2xl border border-border bg-canvas p-5 shadow-xs">
					<div class="flex items-center justify-between border-b border-border pb-3 text-xs">
						<span class="font-medium text-ink">Mariana López · WhatsApp</span>
						<span class="text-sage-ink">• IA pausada</span>
					</div>
					<div class="mt-4 space-y-2.5 text-xs">
						<div class="max-w-[78%] rounded-xl bg-surface px-3.5 py-2.5">
							Hola, ¿qué incluye el servicio de branding?
						</div>
						<div class="ml-auto max-w-[78%] rounded-xl bg-sage-bubble px-3.5 py-2.5">
							Trabajamos estrategia, identidad visual y manual de marca.
						</div>
					</div>
				</div>
			</section>

			<!-- 02 (Banda #EEF2EA) -->
			<section class="bg-[#eef2ea]/85 py-14">
				<div class="mx-auto grid max-w-6xl items-center gap-10 px-4 sm:px-8 lg:grid-cols-2">
					<div class="order-2 rounded-2xl border border-border bg-canvas p-5 shadow-xs lg:order-1">
						<div class="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
							<div class="rounded-lg border border-border p-3">
								<p class="font-medium text-ink">Nuevos</p>
								<p class="mt-1 text-[11px] text-ink-muted">$50,000</p>
								<p class="mt-2 font-medium text-ink">Diego Ramírez</p>
							</div>
							<div class="rounded-lg border border-border p-3">
								<p class="font-medium text-ink">En conversación</p>
								<p class="mt-1 text-[11px] text-ink-muted">$46,500</p>
								<p class="mt-2 font-medium text-ink">Mariana López</p>
							</div>
							<div class="rounded-lg border border-border p-3">
								<p class="font-medium text-ink">Propuesta</p>
								<p class="mt-1 text-[11px] text-ink-muted">$64,000</p>
								<p class="mt-2 font-medium text-ink">Ana Torres</p>
							</div>
							<div class="rounded-lg border border-border p-3">
								<p class="font-medium text-ink">Por cerrar</p>
								<p class="mt-1 text-[11px] text-ink-muted">$32,000</p>
								<p class="mt-2 font-medium text-ink">Pablo Cruz</p>
							</div>
						</div>
						<p class="mt-3 text-center text-[11px] text-ink-muted">Del primer mensaje al cierre.</p>
					</div>
					<div class="order-1 lg:order-2">
						<p class="text-[11px] font-medium tracking-[0.14em] text-ink-muted uppercase">02 / DA EL SIGUIENTE PASO</p>
						<h2 class="mt-3 text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
							Que ninguna oportunidad se quede a medias.
						</h2>
						<p class="mt-3 text-sm leading-relaxed text-ink-secondary sm:text-base">
							Visualiza cada venta, su responsable y el próximo paso. Detecta lo que necesita
							atención y retoma la conversación antes de que pierda impulso.
						</p>
						<p class="mt-4 text-sm font-medium text-ink">Tu seguimiento deja de depender de tu memoria.</p>
					</div>
				</div>
			</section>

			<!-- 03 -->
			<section class="mx-auto grid max-w-6xl items-center gap-10 px-4 py-10 sm:px-8 lg:grid-cols-2">
				<div>
					<p class="text-[11px] font-medium tracking-[0.14em] text-ink-muted uppercase">03 / RECUPERA TU TIEMPO</p>
					<h2 class="mt-3 text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
						Menos respuestas repetitivas. Más conversaciones que sí importan.
					</h2>
					<p class="mt-3 text-sm leading-relaxed text-ink-secondary sm:text-base">
						Tu asistente sugiere respuestas con la información de tu negocio y califica cada oportunidad en tu pipeline.
						Tú decides cuándo revisar en Copiloto y cuándo activar Automático.
					</p>
					<p class="mt-4 text-sm font-medium text-ink">Empieza con Copiloto. Revisa antes de enviar.</p>
				</div>
				<div class="rounded-2xl border border-border bg-sidebar/70 p-6">
					<div class="space-y-3 rounded-xl border border-border bg-canvas p-5 text-xs">
						<div class="rounded-xl border border-border p-3.5 text-ink">
							Trabajamos estrategia, identidad visual y manual de marca en entregas de 4 a 6 semanas.
							<div class="mt-1.5 flex items-center gap-1 text-[10px] text-ink-muted">
								<Sparkles class="size-3" aria-hidden="true" />
								<span>Asistente IA</span>
							</div>
						</div>
						<div class="rounded-xl bg-sage-soft p-3.5 text-ink">
							<p class="font-semibold">Lo que haría</p>
							<p class="mt-1 text-ink-secondary">› Movería a En conversación · Alta intención</p>
						</div>
					</div>
				</div>
			</section>
		</div>

		<!-- 3 Pasos + Pricing claro -->
		<section id="como-funciona" class="mx-auto max-w-5xl px-4 py-16 sm:px-8">
			<h2 class="text-center text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
				Empieza simple. Avanza a tu ritmo.
			</h2>
			<p class="mt-2 text-center text-sm text-ink-secondary">
				$9 USD/canal al mes · 1,000 respuestas de IA por canal · Usuarios ilimitados.
			</p>
			<div class="mt-10 grid gap-8 sm:grid-cols-3">
				<div>
					<p class="text-xs font-medium text-ink-muted">01</p>
					<h3 class="mt-2 text-base font-semibold text-ink">Conecta tus canales.</h3>
					<p class="mt-1.5 text-sm text-ink-secondary">
						Reúne los mensajes que ya recibes en el mismo espacio de trabajo.
					</p>
				</div>
				<div>
					<p class="text-xs font-medium text-ink-muted">02</p>
					<h3 class="mt-2 text-base font-semibold text-ink">Dale tu contexto a la IA.</h3>
					<p class="mt-1.5 text-sm text-ink-secondary">
						Comparte tus servicios y respuestas. Prueba con Copiloto antes de automatizar.
					</p>
				</div>
				<div>
					<p class="text-xs font-medium text-ink-muted">03</p>
					<h3 class="mt-2 text-base font-semibold text-ink">Enfócate en tus clientes.</h3>
					<p class="mt-1.5 text-sm text-ink-secondary">
						Atiende, califica y da seguimiento. Con tu equipo y la IA, en un mismo lugar.
					</p>
				</div>
			</div>
		</section>

		<!-- FAQ con <details name="landing-faq"> (modern-web-guidance: html) -->
		<section id="preguntas" class="mx-auto max-w-3xl px-4 py-12 sm:px-8">
			<h2 class="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
				Antes de dar el siguiente paso.
			</h2>
			<div class="mt-6 divide-y divide-border border-t border-b border-border">
				<details name="landing-faq" open class="group py-4">
					<summary class="cursor-pointer list-none text-sm font-medium text-ink">
						¿La IA responde sola desde el principio?
					</summary>
					<p class="mt-2 text-sm text-ink-secondary">
						No. Puedes comenzar con Copiloto: sugiere y tú revisas. Activa Automático cuando estés listo.
					</p>
				</details>
				<details name="landing-faq" class="group py-4">
					<summary class="cursor-pointer list-none text-sm font-medium text-ink">
						¿Mi equipo puede seguir atendiendo?
					</summary>
					<p class="mt-2 text-sm text-ink-secondary">
						Sí. Invita usuarios ilimitados sin costo extra por asiento, asigna conversaciones y comparte notas internas.
					</p>
				</details>
				<details name="landing-faq" class="group py-4">
					<summary class="cursor-pointer list-none text-sm font-medium text-ink">
						¿Cómo funciona el cobro por canal?
					</summary>
					<p class="mt-2 text-sm text-ink-secondary">
						Empiezas con 14 días de prueba. Después pagas $9 USD/mes por cada canal conectado, incluyendo 1,000 respuestas de IA al mes por canal en tu workspace.
					</p>
				</details>
			</div>
		</section>

		<!-- Final CTA -->
		<section class="mx-auto max-w-5xl px-4 py-14 sm:px-8">
			<div class="rounded-2xl bg-[#20211e] px-6 py-14 text-center text-white sm:px-12">
				<h2 class="text-2xl font-semibold tracking-tight sm:text-3xl">
					Tu negocio avanza.
					<span class="block">Y tú vuelves a tener espacio.</span>
				</h2>
				<p class="mx-auto mt-3 max-w-md text-sm text-white/75">
					Ve cómo se ordenan tus conversaciones, tu equipo y tu pipeline en Okeo.
				</p>
				<div class="mt-7 flex flex-wrap items-center justify-center gap-3">
					<a
						href="/onboarding"
						class="inline-flex h-10 items-center gap-2 rounded-lg bg-canvas px-5 text-sm font-medium text-ink transition-colors hover:bg-surface"
					>
						<span>Prueba gratis 14 días</span>
						<ArrowRight class="size-4" aria-hidden="true" />
					</a>
					<button
						type="button"
						onclick={() => (videoModalOpen = true)}
						class="inline-flex h-10 items-center gap-2 rounded-lg border border-white/25 px-5 text-sm font-medium text-white transition-colors hover:bg-white/10"
					>
						<Play class="size-3.5 fill-current" aria-hidden="true" />
						<span>Ver demo en video</span>
					</button>
				</div>
			</div>
		</section>
	</main>

	<footer class="border-t border-border py-8">
		<div class="mx-auto flex max-w-6xl flex-col items-start justify-between gap-4 px-4 text-xs text-ink-muted sm:flex-row sm:items-center sm:px-8">
			<div class="flex items-center gap-6">
				<BrandLogo size="sm" />
				<span>Menos pendientes. Más posibilidades.</span>
			</div>
			<div class="flex items-center gap-5">
				<a href="/login" class="hover:text-ink">Iniciar sesión</a>
				<a href="/onboarding" class="hover:text-ink">Empezar</a>
			</div>
		</div>
	</footer>
</div>

<ModalDialog
	bind:open={videoModalOpen}
	title="Demo en video de Okeo"
	subtitle="Recorrido rápido por Inbox, Pipeline Kanban y el Asistente IA (100% self-serve)."
>
	<div class="flex aspect-video w-full flex-col items-center justify-center rounded-xl border border-border bg-sidebar p-6 text-center">
		<div class="flex size-12 items-center justify-center rounded-full bg-cta text-white">
			<Play class="ml-0.5 size-5 fill-current" aria-hidden="true" />
		</div>
		<p class="mt-3 text-sm font-medium text-ink">Espacio listo para incrustar el video demo</p>
		<p class="mt-1 text-xs text-ink-muted">
			Aquí irá el video walkthrough de conexión de canales, respuestas con IA y pipeline.
		</p>
	</div>

	<div class="mt-5 flex flex-wrap items-center justify-between gap-3">
		<a href="/wunderside/inbox" class="text-xs font-medium text-ink-secondary hover:text-ink hover:underline">
			Probar interfaz interactiva
		</a>
		<a
			href="/onboarding"
			class="inline-flex h-10 items-center gap-2 rounded-lg bg-cta px-4 text-sm font-medium text-white hover:bg-cta-hover"
		>
			<span>Empezar prueba gratis</span>
			<ArrowRight class="size-4" aria-hidden="true" />
		</a>
	</div>
</ModalDialog>
