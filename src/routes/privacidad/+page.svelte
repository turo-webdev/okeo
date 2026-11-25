<script lang="ts">
	import BrandLogo from '$lib/components/shared/BrandLogo.svelte';

	let { data } = $props();
</script>

<svelte:head>
	<title>Política de Privacidad — okeo</title>
	<meta
		name="description"
		content="Política de privacidad, protección de datos y proceso de eliminación de datos en Okeo."
	/>
	<link rel="canonical" href="https://okeo.ai/privacidad" />
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
			Política de Privacidad
		</h1>
		<p class="mt-4 text-sm leading-relaxed text-ink-secondary sm:text-base">
			En <strong class="font-medium text-ink">Okeo</strong> (<code class="text-xs">okeo.ai</code> y
			<code class="text-xs">app.okeo.ai</code>) protegemos la información de tu negocio, de tu equipo
			y de los clientes que atiendes a través de tus canales conectados.
		</p>

		<div class="mt-10 space-y-8 border-t border-border pt-8 text-sm leading-relaxed text-ink-secondary">
			<section class="space-y-2.5">
				<h2 class="text-base font-semibold text-ink">1. Responsable y contacto de privacidad</h2>
				<p>
					Para cualquier duda, solicitud de acceso, rectificación o eliminación de datos personales
					puedes escribir directamente a
					<a href="mailto:privacidad@okeo.ai" class="font-medium text-ink underline underline-offset-2">
						privacidad@okeo.ai
					</a>.
				</p>
			</section>

			<section class="space-y-2.5">
				<h2 class="text-base font-semibold text-ink">2. Datos que recopilamos</h2>
				<ul class="list-disc space-y-1.5 pl-5">
					<li>
						<strong class="font-medium text-ink">Cuenta y autenticación:</strong> nombre, correo electrónico,
						identificador de inicio de sesión y pertenencia a espacios de trabajo.
					</li>
					<li>
						<strong class="font-medium text-ink">Contenido de tu espacio de trabajo:</strong> contactos,
						oportunidades comerciales, notas internas, historial de conversaciones, archivos multimedia y
						documentos o enlaces que subas a tu Base de Conocimiento.
					</li>
					<li>
						<strong class="font-medium text-ink">Canales conectados:</strong> identificadores de página,
						cuenta profesional de Instagram o número de WhatsApp Business, así como mensajes entrantes,
						estados de entrega y archivos adjuntos necesarios para operar la bandeja compartida.
					</li>
					<li>
						<strong class="font-medium text-ink">Facturación:</strong> los pagos, tarjetas y datos
						fiscales se procesan directamente a través de nuestra pasarela de pagos certificada. Okeo no
						almacena números completos de tarjetas ni códigos CVV.
					</li>
				</ul>
			</section>

			<section class="space-y-2.5">
				<h2 class="text-base font-semibold text-ink">3. Para qué usamos la información</h2>
				<p>Utilizamos los datos exclusivamente para operar el servicio contratado:</p>
				<ul class="list-disc space-y-1.5 pl-5">
					<li>Mostrar y responder conversaciones de WhatsApp, Instagram y Messenger desde tu bandeja.</li>
					<li>Organizar leads, etapas y seguimiento comercial dentro de tu espacio de trabajo.</li>
					<li>
						Generar sugerencias o respuestas de asistencia inteligente utilizando únicamente el historial
						de la conversación y la Base de Conocimiento de tu propio espacio de trabajo.
					</li>
					<li>Gestionar suscripciones, facturación, enlaces de acceso y notificaciones de invitación.</li>
				</ul>
			</section>

			<section class="space-y-2.5">
				<h2 class="text-base font-semibold text-ink">4. Proveedores de servicio y encargados de tratamiento</h2>
				<p>
					Para operar la plataforma trabajamos con proveedores especializados sujetos a acuerdos de
					confidencialidad y seguridad, incluyendo proveedores de infraestructura en la nube y
					almacenamiento de datos, servicios de conectividad de mensajería, servicios de procesamiento de
					inteligencia artificial bajo demanda, pasarelas de pago certificadas y servicios de correo
					transaccional.
				</p>
				<p>
					Okeo <strong class="font-medium text-ink">no vende</strong> datos personales ni comerciales a terceros,
					ni mezcla o entrena respuestas de un espacio de trabajo usando la información de otro cliente.
				</p>
			</section>

			<section class="space-y-2.5">
				<h2 class="text-base font-semibold text-ink">5. Seguridad y aislamiento de la información</h2>
				<ul class="list-disc space-y-1.5 pl-5">
					<li>Cifrado en tránsito mediante HTTPS/TLS en toda la plataforma.</li>
					<li>Aislamiento estricto por organización y control de acceso por rol dentro de cada equipo.</li>
					<li>
						Almacenamiento privado para archivos adjuntos y documentos con accesos temporales autenticados.
					</li>
					<li>Validación criptográfica de las notificaciones externas recibidas por la plataforma.</li>
				</ul>
			</section>

			<section class="space-y-2.5">
				<h2 class="text-base font-semibold text-ink">6. Retención y eliminación de datos</h2>
				<p>
					Conservamos la información de tu espacio de trabajo mientras mantengas una cuenta activa o sea
					necesario para cumplir obligaciones legales o fiscales.
				</p>
				<p>
					Puedes desconectar cualquier canal en cualquier momento desde
					<code class="text-xs">Configuración → Canales</code> en <code class="text-xs">app.okeo.ai</code>.
					Si deseas solicitar la eliminación completa de tu cuenta, espacio de trabajo o datos asociados a un
					número de WhatsApp o cuenta vinculada, envía un correo a
					<a href="mailto:privacidad@okeo.ai" class="font-medium text-ink underline underline-offset-2">
						privacidad@okeo.ai
					</a>
					indicando el nombre de tu espacio de trabajo y correo de administrador; atenderemos la solicitud en un
					plazo máximo de 15 días hábiles.
				</p>
			</section>

			<section class="space-y-2.5">
				<h2 class="text-base font-semibold text-ink">7. Tus derechos y cambios a esta política</h2>
				<p>
					Como titular o administrador de los datos puedes solicitar acceso, corrección, portabilidad o
					eliminación de tu información escribiendo a
					<a href="mailto:privacidad@okeo.ai" class="font-medium text-ink underline underline-offset-2">
						privacidad@okeo.ai
					</a>. Cuando realicemos cambios relevantes a esta política, actualizaremos la fecha superior de esta
					página.
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
				<a href="/terminos" class="hover:text-ink">Términos</a>
				<a href="/privacidad" class="font-medium text-ink">Privacidad</a>
				<a href="{data.appOriginPrefix}/login" class="hover:text-ink">Iniciar sesión</a>
				<a href="{data.appOriginPrefix}/onboarding" class="hover:text-ink">Empezar</a>
			</div>
		</div>
	</footer>
</div>
