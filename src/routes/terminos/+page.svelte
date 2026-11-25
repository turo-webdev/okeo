<script lang="ts">
	import BrandLogo from '$lib/components/shared/BrandLogo.svelte';

	let { data } = $props();
</script>

<svelte:head>
	<title>Términos y Condiciones — okeo</title>
	<meta
		name="description"
		content="Términos y condiciones de uso, planes, canales conectados y asistente de IA en Okeo."
	/>
	<link rel="canonical" href="https://okeo.ai/terminos" />
</svelte:head>

<div class="min-h-dvh bg-canvas text-ink">
	<header class="sticky top-0 z-30 border-b border-border/70 bg-canvas/95 backdrop-blur">
		<div class="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-8">
			<a href="/" class="inline-flex items-center">
				<BrandLogo />
			</a>

			<div class="flex items-center gap-4">
				<a
					href="{data.appOriginPrefix}/login"
					class="hidden text-sm text-ink-secondary hover:text-ink sm:inline-block"
				>
					Iniciar sesión
				</a>
				<a
					href="{data.appOriginPrefix}/onboarding"
					class="inline-flex h-9 items-center rounded-lg bg-cta px-4 text-xs font-medium text-white transition-colors hover:bg-cta-hover sm:text-sm"
				>
					Empezar ahora
				</a>
			</div>
		</div>
	</header>

	<main class="mx-auto max-w-3xl px-4 py-12 sm:px-8 sm:py-16">
		<p class="text-[11px] font-medium tracking-[0.14em] text-ink-muted uppercase">
			Última actualización: noviembre de 2026
		</p>
		<h1 class="mt-3 text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
			Términos y Condiciones
		</h1>
		<p class="mt-4 text-sm leading-relaxed text-ink-secondary sm:text-base">
			Estos términos regulan el acceso y uso de la plataforma <strong class="font-medium text-ink">Okeo</strong>
			(<code class="text-xs">okeo.ai</code> y <code class="text-xs">app.okeo.ai</code>). Al crear un espacio de
			trabajo o iniciar sesión aceptas estas condiciones.
		</p>

		<div class="mt-10 space-y-8 border-t border-border pt-8 text-sm leading-relaxed text-ink-secondary">
			<section class="space-y-2.5">
				<h2 class="text-base font-semibold text-ink">1. Descripción del servicio</h2>
				<p>
					Okeo es una plataforma de CRM y mensajería omnicanal que permite centralizar conversaciones de
					WhatsApp Business, Instagram y Messenger, organizar oportunidades en un pipeline comercial y
					asistir respuestas con inteligencia artificial basada en el conocimiento propio de cada negocio.
				</p>
			</section>

			<section class="space-y-2.5">
				<h2 class="text-base font-semibold text-ink">2. Cuentas, espacios de trabajo y equipo</h2>
				<p>
					El propietario y administradores de cada espacio de trabajo son responsables de mantener la
					confidencialidad de su acceso, asignar roles adecuados (propietario, administrador, agente o solo
					lectura) y gestionar las invitaciones de su equipo. Los espacios de trabajo incluyen usuarios
					ilimitados sin costo adicional por asiento.
				</p>
			</section>

			<section class="space-y-2.5">
				<h2 class="text-base font-semibold text-ink">3. Canales conectados y uso aceptable</h2>
				<p>Al conectar un canal en Okeo te comprometes a:</p>
				<ul class="list-disc space-y-1.5 pl-5">
					<li>
						Contar con autorización legítima sobre los números de WhatsApp, cuentas de Instagram o páginas
						de Facebook vinculadas.
					</li>
					<li>
						Cumplir las políticas comerciales y de mensajería aplicables de cada plataforma conectada,
						incluyendo el consentimiento de tus contactos y el respeto a las ventanas vigentes de atención.
					</li>
					<li>
						No utilizar Okeo para enviar spam, fraude, contenido ilegal, suplantación de identidad ni
						automatizaciones abusivas.
					</li>
				</ul>
			</section>

			<section class="space-y-2.5">
				<h2 class="text-base font-semibold text-ink">4. Asistente de Inteligencia Artificial</h2>
				<p>
					Okeo ofrece modos <strong class="font-medium text-ink">Copiloto</strong> (sugerencia revisada
					por tu equipo) y <strong class="font-medium text-ink">Automático</strong>. Eres responsable de la
					exactitud de los documentos, precios, políticas y enlaces que cargues en tu Base de Conocimiento,
					así como de supervisar las respuestas enviadas a tus clientes. Cuando una persona responde desde el
					Inbox o desde el dispositivo conectado, Okeo pausa automáticamente la respuesta automática en esa
					conversación.
				</p>
			</section>

			<section class="space-y-2.5">
				<h2 class="text-base font-semibold text-ink">5. Planes, cobros y cancelación</h2>
				<ul class="list-disc space-y-1.5 pl-5">
					<li>
						<strong class="font-medium text-ink">Suscripción por canal:</strong> el acceso para conectar
						canales reales tiene un precio base de <strong class="font-medium text-ink">$9 USD por canal
						conectado al mes</strong> (o el monto mostrado al momento de contratar), e incluye un pool
						compartido de 1,000 respuestas de IA al mes por cada canal contratado.
					</li>
					<li>
						<strong class="font-medium text-ink">Facturación recurrente:</strong> los pagos se procesan de
						forma mensual a través de nuestra pasarela de pagos segura. Aumentar o reducir la cantidad de
						canales contratados aplica los ajustes prorrateados correspondientes según el ciclo vigente.
					</li>
					<li>
						<strong class="font-medium text-ink">Cancelación e impago:</strong> puedes cancelar en cualquier
						momento desde el portal de facturación en <code class="text-xs">Configuración → Plan</code>; la
						suscripción permanecerá activa hasta el final del período ya pagado y no habrá cobros posteriores.
						Ante cancelación efectiva o falta de pago persistente, los canales conectados se pausarán y podrán
						desconectarse automáticamente tras el período de gracia.
					</li>
				</ul>
			</section>

			<section class="space-y-2.5">
				<h2 class="text-base font-semibold text-ink">6. Propiedad de los datos y del software</h2>
				<p>
					Todo el contenido, mensajes, contactos y documentos que subas a tu espacio de trabajo siguen siendo
					de tu exclusiva propiedad. La plataforma Okeo, su diseño, marca y software son propiedad intelectual
					de sus titulares.
				</p>
			</section>

			<section class="space-y-2.5">
				<h2 class="text-base font-semibold text-ink">7. Disponibilidad, limitación de responsabilidad y contacto</h2>
				<p>
					Trabajamos para mantener la plataforma disponible y segura de forma continua, aunque integraciones
					de terceros (como plataformas de mensajería, procesadores de pago o servicios externos de
					inteligencia artificial) pueden presentar intermitencias ajenas a nuestro control. En la máxima
					medida permitida por la ley, la responsabilidad total de Okeo por cualquier reclamación relacionada
					con el servicio no excederá el monto efectivamente pagado por el cliente durante los últimos tres
					(3) meses previos al evento.
				</p>
				<p>
					Para soporte o consultas legales escribe a
					<a href="mailto:hola@okeo.ai" class="font-medium text-ink underline underline-offset-2">
						hola@okeo.ai
					</a>. También puedes consultar nuestra
					<a href="/privacidad" class="font-medium text-ink underline underline-offset-2">
						Política de Privacidad
					</a>.
				</p>
			</section>
		</div>
	</main>

	<footer class="border-t border-border py-8">
		<div class="mx-auto flex max-w-6xl flex-col items-start justify-between gap-4 px-4 text-xs text-ink-muted sm:flex-row sm:items-center sm:px-8">
			<div class="flex items-center gap-6">
				<a href="/" class="inline-flex items-center"><BrandLogo size="sm" /></a>
				<span>Menos pendientes. Más posibilidades.</span>
			</div>
			<div class="flex flex-wrap items-center gap-5">
				<a href="/terminos" class="font-medium text-ink">Términos</a>
				<a href="/privacidad" class="hover:text-ink">Privacidad</a>
				<a href="{data.appOriginPrefix}/login" class="hover:text-ink">Iniciar sesión</a>
				<a href="{data.appOriginPrefix}/onboarding" class="hover:text-ink">Empezar</a>
			</div>
		</div>
	</footer>
</div>
