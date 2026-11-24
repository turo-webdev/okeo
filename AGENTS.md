# AGENTS.md — Contrato de Ingeniería para Okeo

Fuente de verdad del producto y arquitectura: `docs/design-document.md` (v1.1). Antes de crear tablas, rutas, servicios o flujos nuevos, verifica el contrato correspondiente en ese documento.

---

## 1. Stack y Sintaxis Obligatoria

- **Framework UI/BFF:** **SvelteKit 2 + Svelte 5 (Runes)** + Tailwind CSS v4 + `shadcn-svelte`.
  - Usar exclusivamente Runes de Svelte 5 (`$state`, `$derived`, `$effect`, `$props`, `$bindable`).
  - **Prohibido** usar sintaxis legacy de Svelte 4 (`export let`, `$:`, `createEventDispatcher`) o stores globales innecesarios.
- **Runtime y Colas:** **Cloudflare Workers** (`@sveltejs/adapter-cloudflare` con Workers Static Assets y `nodejs_compat`) + **Cloudflare Queues** (`delaySeconds` para debounce).
  - No desplegar como legacy Cloudflare Pages; las colas se producen/consumen desde Workers.
  - Evitar librerías de Node incompatibles con Workers (por ejemplo `pdf-parse` / `pdf.js` pesados); delegar extracción de PDFs a Gemini multimodal o API dedicada.
- **Base de datos, Auth, Storage y Realtime:** **Supabase**.

---

## 2. Multi-tenancy, Rutas y Autorización

- **Rutas de la app:** Todas las vistas autenticadas de un workspace deben vivir bajo `/[orgSlug]/...` (`/dashboard`, `/inbox`, `/pipeline`, `/contacts`, `/ai`, `/settings/*`). Nunca depender de una cookie global de "organización activa" para mutaciones o envíos.
- **API Routes y FormActions:**
  - Todo endpoint bajo `src/routes/api/*` y toda `FormAction` debe recibir explícitamente `organizationId` (o resolver `orgSlug` de la ruta y verificar membresía), validar entradas con **Zod/Valibot** y comprobar el rol mínimo requerido en `organization_members`.
  - Webhooks externos (`/api/webhooks/zernio`, `/api/webhooks/stripe`) validan firma criptográfica sobre el **raw body** antes de parsear JSON.
- **Sesión SSR:** Usar siempre `safeGetSession()` validando el usuario con `auth.getUser()` / `auth.getClaims()`; nunca confiar en `getSession()` sin validar ni usar `user_metadata` en decisiones de autorización.
- **Secretos:** `SUPABASE_SERVICE_ROLE_KEY`, tokens de Zernio, Gemini y Stripe existen solo en servidor; nunca en variables `PUBLIC_*` ni en código cliente.

---

## 3. Reglas Estrictas de Supabase (PostgreSQL, RLS y Storage)

Toda migración en `supabase/migrations/` debe cumplir sin excepción:

1. **RLS habilitado en toda tabla de `public`:** `ALTER TABLE public.<tabla> ENABLE ROW LEVEL SECURITY;`.
2. **Políticas explícitas `TO authenticated`:** Nunca usar `auth.role()`.
3. **Helpers en esquema `private` (no expuesto en PostgREST):**
   - Usar `private.user_org_ids(min_role text DEFAULT 'viewer')` y `private.is_org_member(target_org_id uuid, min_role text DEFAULT 'viewer')`, ambos `STABLE SECURITY DEFINER SET search_path = ''` verificando internamente `(select auth.uid())`.
   - **Permisos obligatorios:** `REVOKE ALL` de `PUBLIC` y `anon`, y **`GRANT USAGE ON SCHEMA private TO authenticated` + `GRANT EXECUTE ... TO authenticated`** (sin `EXECUTE` a `authenticated`, las consultas bajo RLS fallarán).
4. **Verdadero `InitPlan` en políticas:**
   - Preferir `USING (organization_id IN (SELECT private.user_org_ids('viewer')))` para evitar subconsultas correlacionadas fila-a-fila y permitir uso de índice en `organization_id`.
   - Toda política `UPDATE` debe incluir tanto `USING` como `WITH CHECK`; toda política `INSERT` debe incluir `WITH CHECK`.
5. **Integridad e índices:**
   - Indexar `organization_id`, `(user_id, organization_id)` en `organization_members`, y todas las llaves foráneas usadas en filtros/joins.
   - Usar llaves foráneas compuestas `(organization_id, <fk_id>)` en tablas hijas (`contact_identities`, `contact_notes`, `conversations`, `messages`, `pipeline_stages`, `deals`, `knowledge_chunks`) para impedir referencias cross-tenant.
   - Tablas append-only (`messages`, `contact_notes`, `knowledge_chunks`, `ai_usage_ledger`, `org_usage_periods`) usan `bigint generated always as identity` como PK.
   - `messages` usa índice único parcial `(channel_id, external_message_id) WHERE external_message_id IS NOT NULL`.
6. **Storage privado:**
   - Buckets `dm-media` y `knowledge-files` siempre privados (`public = false`) con ruta `{organization_id}/{resource_id}/{filename}`.
   - Servir archivos únicamente mediante Signed URLs emitidas tras validar membresía en servidor.
7. **Realtime:** Toda suscripción `postgres_changes` debe filtrar explícitamente por `organization_id=eq.<orgId>`.

---

## 4. Aislamiento de Proveedores

- **Zernio:** Ningún archivo fuera de `src/lib/server/channels/` puede importar `@zernio/node`. Toda operación de canales pasa por `ChannelProvider` (`src/lib/server/channels/provider.ts`).
- **IA (Google Gemini):** Ningún archivo fuera de `src/lib/server/ai/` puede importar `@google/genai` ni escribir directamente en `ai_usage_ledger` u `org_usage_periods`.
- **Stripe:** Ningún archivo fuera de `src/lib/server/billing/` puede importar `stripe` ni tocar `stripe_webhook_events`.

---

## 5. Guardrails de IA, Concurrencia y Billing

- **Costo de Gemini:** Usar `gemini-2.5-flash` con **`thinkingBudget: 0`** en generación de respuestas/calificación. Acotar historial a los últimos 15 mensajes y RAG a los top 5 chunks.
- **Debounce y concurrencia:** Al procesar un job en `processor.ts`, adquirir *lease* atómico (`ai_processing_locked_until`), procesar multimedia entrante (audio/imagen), y antes de llamar a `ChannelProvider.sendMessage` ejecutar un **re-check atómico** confirmando que `ai_paused = false`, la ventana de **24h** sigue abierta (`last_inbound_at`) y no entró ningún mensaje posterior.
- **Intervención humana y etapas terminales:**
  - Cualquier respuesta desde Inbox o eco saliente externo (`external_human`) marca `ai_paused = true` de inmediato.
  - Validar `recommended_stage_slug` en servidor contra etapas existentes no terminales del pipeline del workspace; la IA nunca modifica deals con `is_terminal = true`.
- **Seguridad en RAG/KB:** Validar contra **SSRF** antes de hacer `fetch()` de URLs en Base de Conocimiento (bloquear IPs privadas, loopback y metadata); usar `SET LOCAL hnsw.iterative_scan = relaxed_order` en la búsqueda híbrida (`fts` `'simple'` + `pgvector`).
- **Modelo de Billing:**
  - **Trial 14 días:** 1 canal, 100 respuestas IA, 5 docs KB (sin plan Free perpetuo con canal conectado).
  - **Suscripción modular:** **$9 USD/canal/mes** = **1,000 respuestas IA/mes por canal** en pool compartido por workspace (`org_usage_periods`); **usuarios ilimitados** (no implementar ni validar `seat_limit`).
  - Toda actualización de suscripción vía webhook de Stripe debe registrar `event.id` en `stripe_webhook_events` para garantizar idempotencia.

---

## 6. Verificaciones Esperadas por Cambio

Antes de dar por terminada una tarea en el código:
1. Ejecutar verificación de tipos y chequeo de Svelte (`npm run check` / `npx svelte-check` cuando el proyecto esté inicializado).
2. Ejecutar pruebas unitarias/integración relevantes (`npm test` / tests de RLS y webhooks si se tocaron migraciones o endpoints críticos).
3. Validar que ninguna migración o cambio viole la separación de adaptadores ni el aislamiento multi-tenant.
