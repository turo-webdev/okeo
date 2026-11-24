-- Okeo Initial Multi-Tenant Schema (19 tables + private schema + vector index)

-- 1. Extensions outside public
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

-- 2. Private schema (never exposed in PostgREST)
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;

-- 3. Shared updated_at trigger helper
CREATE OR REPLACE FUNCTION private.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
	NEW.updated_at = now();
	RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.set_updated_at() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.set_updated_at() TO authenticated, service_role;

-- 4. Core Tenant & Auth Tables

-- (1) profiles
CREATE TABLE public.profiles (
	id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
	full_name text NOT NULL DEFAULT '',
	avatar_url text,
	email text NOT NULL DEFAULT '',
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER profiles_set_updated_at
	BEFORE UPDATE ON public.profiles
	FOR EACH ROW
	EXECUTE FUNCTION private.set_updated_at();

-- Auto-sync auth.users -> public.profiles
CREATE OR REPLACE FUNCTION private.handle_auth_user_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
	v_name text;
	v_avatar text;
BEGIN
	v_name := coalesce(
		nullif(trim(NEW.raw_user_meta_data ->> 'full_name'), ''),
		nullif(trim(NEW.raw_user_meta_data ->> 'name'), ''),
		nullif(split_part(coalesce(NEW.email, ''), '@', 1), ''),
		'Usuario'
	);
	v_avatar := nullif(trim(NEW.raw_user_meta_data ->> 'avatar_url'), '');

	INSERT INTO public.profiles (id, full_name, avatar_url, email)
	VALUES (NEW.id, v_name, v_avatar, coalesce(NEW.email, ''))
	ON CONFLICT (id) DO UPDATE
		SET email = EXCLUDED.email,
			full_name = CASE
				WHEN coalesce(public.profiles.full_name, '') = '' THEN EXCLUDED.full_name
				ELSE public.profiles.full_name
			END,
			avatar_url = coalesce(public.profiles.avatar_url, EXCLUDED.avatar_url),
			updated_at = now();

	RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.handle_auth_user_sync() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER on_auth_user_synced
	AFTER INSERT OR UPDATE ON auth.users
	FOR EACH ROW
	EXECUTE FUNCTION private.handle_auth_user_sync();

-- (2) organizations (no seat_limit — unlimited workspace members)
CREATE TABLE public.organizations (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	name text NOT NULL,
	slug text NOT NULL UNIQUE,
	industry text NOT NULL DEFAULT 'Servicios profesionales',
	language text NOT NULL DEFAULT 'es' CHECK (language IN ('es', 'en')),
	currency text NOT NULL DEFAULT 'MXN' CHECK (currency IN ('MXN', 'USD')),
	zernio_profile_id text UNIQUE,
	subscription_status text NOT NULL DEFAULT 'trialing'
		CHECK (subscription_status IN ('trialing', 'active', 'past_due', 'canceled', 'expired')),
	billing_mode text NOT NULL DEFAULT 'trial'
		CHECK (billing_mode IN ('trial', 'per_channel')),
	stripe_customer_id text UNIQUE,
	stripe_subscription_id text UNIQUE,
	stripe_channel_item_id text,
	stripe_ai_overage_item_id text,
	channel_slots integer NOT NULL DEFAULT 1 CHECK (channel_slots >= 1),
	included_ai_replies_per_channel integer NOT NULL DEFAULT 1000 CHECK (included_ai_replies_per_channel >= 0),
	ai_overage_enabled boolean NOT NULL DEFAULT false,
	kb_document_limit integer NOT NULL DEFAULT 5 CHECK (kb_document_limit >= 1),
	trial_ends_at timestamptz DEFAULT (now() + interval '14 days'),
	current_period_start timestamptz NOT NULL DEFAULT now(),
	current_period_end timestamptz NOT NULL DEFAULT (now() + interval '14 days'),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER organizations_set_updated_at
	BEFORE UPDATE ON public.organizations
	FOR EACH ROW
	EXECUTE FUNCTION private.set_updated_at();

-- (3) organization_members
CREATE TABLE public.organization_members (
	organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
	user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
	role text NOT NULL CHECK (role IN ('owner', 'admin', 'agent', 'viewer')),
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (organization_id, user_id)
);

-- Secondary index required for RLS user_org_ids() & FK cascade
CREATE INDEX organization_members_user_org_idx
	ON public.organization_members (user_id, organization_id);

-- (4) organization_invitations
CREATE TABLE public.organization_invitations (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
	email text NOT NULL,
	role text NOT NULL CHECK (role IN ('admin', 'agent', 'viewer')),
	token_hash text NOT NULL UNIQUE,
	invited_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
	status text NOT NULL DEFAULT 'pending'
		CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
	expires_at timestamptz NOT NULL,
	accepted_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX organization_invitations_org_idx
	ON public.organization_invitations (organization_id, status);
CREATE INDEX organization_invitations_invited_by_idx
	ON public.organization_invitations (invited_by);

-- (5) stripe_webhook_events (service_role only idempotency log)
CREATE TABLE public.stripe_webhook_events (
	event_id text PRIMARY KEY,
	event_type text NOT NULL,
	processed_at timestamptz NOT NULL DEFAULT now()
);

-- 5. Omnichannel Channels & CRM Tables

-- (6) connected_channels
CREATE TABLE public.connected_channels (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
	provider text NOT NULL DEFAULT 'zernio' CHECK (provider IN ('zernio')),
	platform text NOT NULL CHECK (platform IN ('whatsapp', 'instagram', 'facebook')),
	external_account_id text NOT NULL,
	display_name text NOT NULL,
	handle_or_phone text NOT NULL DEFAULT '',
	status text NOT NULL DEFAULT 'active'
		CHECK (status IN ('active', 'disconnected', 'paused_billing', 'error')),
	metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (provider, external_account_id),
	UNIQUE (organization_id, id)
);

CREATE INDEX connected_channels_org_status_idx
	ON public.connected_channels (organization_id, status);

CREATE TRIGGER connected_channels_set_updated_at
	BEFORE UPDATE ON public.connected_channels
	FOR EACH ROW
	EXECUTE FUNCTION private.set_updated_at();

-- (7) contacts
CREATE TABLE public.contacts (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
	name text NOT NULL,
	company text,
	role_title text,
	avatar_url text,
	email text,
	phone text,
	owner_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
	tags text[] NOT NULL DEFAULT '{}',
	lead_score smallint NOT NULL DEFAULT 0 CHECK (lead_score >= 0 AND lead_score <= 100),
	lead_summary text,
	ai_intent_label text,
	next_step_title text,
	next_step_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id)
);

CREATE INDEX contacts_org_created_idx
	ON public.contacts (organization_id, created_at DESC);
CREATE INDEX contacts_owner_idx
	ON public.contacts (owner_user_id);

CREATE TRIGGER contacts_set_updated_at
	BEFORE UPDATE ON public.contacts
	FOR EACH ROW
	EXECUTE FUNCTION private.set_updated_at();

-- (8) contact_identities
CREATE TABLE public.contact_identities (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
	contact_id uuid NOT NULL,
	platform text NOT NULL CHECK (platform IN ('whatsapp', 'instagram', 'facebook')),
	external_user_id text NOT NULL,
	username_or_phone text NOT NULL DEFAULT '',
	created_at timestamptz NOT NULL DEFAULT now(),
	FOREIGN KEY (organization_id, contact_id)
		REFERENCES public.contacts(organization_id, id) ON DELETE CASCADE,
	UNIQUE (organization_id, platform, external_user_id)
);

CREATE INDEX contact_identities_org_contact_idx
	ON public.contact_identities (organization_id, contact_id);

-- (9) conversations
CREATE TABLE public.conversations (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
	channel_id uuid NOT NULL,
	contact_id uuid NOT NULL,
	external_thread_id text NOT NULL,
	platform text NOT NULL CHECK (platform IN ('whatsapp', 'instagram', 'facebook')),
	status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'closed')),
	assigned_to uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
	needs_reply boolean NOT NULL DEFAULT false,
	ai_paused boolean NOT NULL DEFAULT false,
	ai_handoff_reason text,
	ai_reply_count integer NOT NULL DEFAULT 0 CHECK (ai_reply_count >= 0),
	ai_processing_locked_until timestamptz,
	last_processed_inbound_message_id bigint,
	last_inbound_at timestamptz,
	last_message_preview text NOT NULL DEFAULT '',
	last_message_at timestamptz NOT NULL DEFAULT now(),
	unread_count integer NOT NULL DEFAULT 0 CHECK (unread_count >= 0),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (channel_id, external_thread_id),
	UNIQUE (organization_id, id),
	FOREIGN KEY (organization_id, channel_id)
		REFERENCES public.connected_channels(organization_id, id) ON DELETE CASCADE,
	FOREIGN KEY (organization_id, contact_id)
		REFERENCES public.contacts(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX conversations_org_last_msg_idx
	ON public.conversations (organization_id, last_message_at DESC);
CREATE INDEX conversations_org_channel_idx
	ON public.conversations (organization_id, channel_id);
CREATE INDEX conversations_org_contact_idx
	ON public.conversations (organization_id, contact_id);
CREATE INDEX conversations_assigned_to_idx
	ON public.conversations (assigned_to);

CREATE TRIGGER conversations_set_updated_at
	BEFORE UPDATE ON public.conversations
	FOR EACH ROW
	EXECUTE FUNCTION private.set_updated_at();

-- (10) contact_notes
CREATE TABLE public.contact_notes (
	id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
	contact_id uuid NOT NULL,
	conversation_id uuid,
	author_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
	body text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	FOREIGN KEY (organization_id, contact_id)
		REFERENCES public.contacts(organization_id, id) ON DELETE CASCADE,
	FOREIGN KEY (organization_id, conversation_id)
		REFERENCES public.conversations(organization_id, id) ON DELETE SET NULL (conversation_id)
);

CREATE INDEX contact_notes_org_contact_idx
	ON public.contact_notes (organization_id, contact_id, created_at DESC);
CREATE INDEX contact_notes_org_conv_idx
	ON public.contact_notes (organization_id, conversation_id);
CREATE INDEX contact_notes_author_idx
	ON public.contact_notes (author_user_id);

CREATE TRIGGER contact_notes_set_updated_at
	BEFORE UPDATE ON public.contact_notes
	FOR EACH ROW
	EXECUTE FUNCTION private.set_updated_at();

-- (11) messages (append-only high volume)
CREATE TABLE public.messages (
	id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
	conversation_id uuid NOT NULL,
	channel_id uuid NOT NULL,
	external_message_id text,
	direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
	sender_type text NOT NULL CHECK (sender_type IN ('contact', 'agent', 'ai', 'external_human')),
	sender_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
	sender_label text,
	body text NOT NULL DEFAULT '',
	attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
	status text NOT NULL DEFAULT 'delivered'
		CHECK (status IN ('queued', 'sent', 'delivered', 'read', 'failed')),
	error_code text,
	error_detail text,
	created_at timestamptz NOT NULL DEFAULT now(),
	FOREIGN KEY (organization_id, conversation_id)
		REFERENCES public.conversations(organization_id, id) ON DELETE CASCADE,
	FOREIGN KEY (organization_id, channel_id)
		REFERENCES public.connected_channels(organization_id, id) ON DELETE CASCADE
);

-- Partial unique index preserves uniqueness when external_message_id exists while allowing queued/failed local messages
CREATE UNIQUE INDEX messages_channel_external_id_uidx
	ON public.messages (channel_id, external_message_id)
	WHERE external_message_id IS NOT NULL;

CREATE INDEX messages_org_conv_created_idx
	ON public.messages (organization_id, conversation_id, created_at DESC);
CREATE INDEX messages_org_channel_idx
	ON public.messages (organization_id, channel_id);
CREATE INDEX messages_sender_user_idx
	ON public.messages (sender_user_id);

-- 6. Pipeline & Deals Tables

-- (12) pipelines
CREATE TABLE public.pipelines (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
	name text NOT NULL DEFAULT 'Pipeline principal',
	is_default boolean NOT NULL DEFAULT true,
	created_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id)
);

CREATE INDEX pipelines_org_idx
	ON public.pipelines (organization_id);

-- (13) pipeline_stages
CREATE TABLE public.pipeline_stages (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
	pipeline_id uuid NOT NULL,
	name text NOT NULL,
	slug text NOT NULL,
	color text NOT NULL DEFAULT '#8E8E86',
	position double precision NOT NULL,
	is_terminal boolean NOT NULL DEFAULT false,
	ai_qualification_hint text NOT NULL DEFAULT '',
	created_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (pipeline_id, slug),
	UNIQUE (organization_id, id),
	FOREIGN KEY (organization_id, pipeline_id)
		REFERENCES public.pipelines(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX pipeline_stages_org_pipeline_pos_idx
	ON public.pipeline_stages (organization_id, pipeline_id, position);

-- (14) deals
CREATE TABLE public.deals (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
	pipeline_id uuid NOT NULL,
	stage_id uuid NOT NULL,
	contact_id uuid NOT NULL,
	conversation_id uuid,
	owner_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
	title text NOT NULL,
	deal_type text NOT NULL DEFAULT 'Servicio',
	value_cents bigint NOT NULL DEFAULT 0 CHECK (value_cents >= 0),
	currency text NOT NULL DEFAULT 'MXN' CHECK (currency IN ('MXN', 'USD')),
	position double precision NOT NULL,
	last_moved_by text NOT NULL DEFAULT 'human' CHECK (last_moved_by IN ('human', 'ai')),
	ai_last_reason text,
	next_step_title text,
	next_step_at timestamptz,
	qualification_data jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	FOREIGN KEY (organization_id, pipeline_id)
		REFERENCES public.pipelines(organization_id, id) ON DELETE CASCADE,
	FOREIGN KEY (organization_id, stage_id)
		REFERENCES public.pipeline_stages(organization_id, id) ON DELETE CASCADE,
	FOREIGN KEY (organization_id, contact_id)
		REFERENCES public.contacts(organization_id, id) ON DELETE CASCADE,
	FOREIGN KEY (organization_id, conversation_id)
		REFERENCES public.conversations(organization_id, id) ON DELETE SET NULL (conversation_id)
);

CREATE INDEX deals_org_stage_pos_idx
	ON public.deals (organization_id, stage_id, position);
CREATE INDEX deals_org_pipeline_idx
	ON public.deals (organization_id, pipeline_id);
CREATE INDEX deals_org_contact_idx
	ON public.deals (organization_id, contact_id);
CREATE INDEX deals_org_conv_idx
	ON public.deals (organization_id, conversation_id);
CREATE INDEX deals_owner_idx
	ON public.deals (owner_user_id);

CREATE TRIGGER deals_set_updated_at
	BEFORE UPDATE ON public.deals
	FOR EACH ROW
	EXECUTE FUNCTION private.set_updated_at();

-- 7. AI Settings, Knowledge Base (RAG) & Usage Metering Tables

-- (15) ai_settings
CREATE TABLE public.ai_settings (
	organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
	enabled boolean NOT NULL DEFAULT true,
	auto_reply_enabled boolean NOT NULL DEFAULT false,
	auto_qualify_enabled boolean NOT NULL DEFAULT true,
	handle_inbound_audio text NOT NULL DEFAULT 'transcribe_and_reply'
		CHECK (handle_inbound_audio IN ('transcribe_and_reply', 'handoff_human')),
	business_context text NOT NULL DEFAULT '',
	tone text NOT NULL DEFAULT 'professional'
		CHECK (tone IN ('friendly', 'professional', 'direct')),
	handoff_rules text NOT NULL DEFAULT '',
	max_ai_replies_per_thread integer NOT NULL DEFAULT 5 CHECK (max_ai_replies_per_thread BETWEEN 1 AND 20),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER ai_settings_set_updated_at
	BEFORE UPDATE ON public.ai_settings
	FOR EACH ROW
	EXECUTE FUNCTION private.set_updated_at();

-- (16) knowledge_documents
CREATE TABLE public.knowledge_documents (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
	title text NOT NULL,
	subtitle text,
	source_type text NOT NULL CHECK (source_type IN ('faq', 'text', 'file', 'url')),
	source_url text,
	storage_path text,
	content_preview text,
	embedding_model text NOT NULL DEFAULT 'gemini-embedding-001',
	status text NOT NULL DEFAULT 'processing'
		CHECK (status IN ('processing', 'ready', 'error')),
	error_detail text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, id)
);

CREATE INDEX knowledge_documents_org_status_idx
	ON public.knowledge_documents (organization_id, status);

CREATE TRIGGER knowledge_documents_set_updated_at
	BEFORE UPDATE ON public.knowledge_documents
	FOR EACH ROW
	EXECUTE FUNCTION private.set_updated_at();

-- (17) knowledge_chunks
CREATE TABLE public.knowledge_chunks (
	id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
	document_id uuid NOT NULL,
	content text NOT NULL,
	fts tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content, ''))) STORED,
	embedding extensions.vector(768),
	created_at timestamptz NOT NULL DEFAULT now(),
	FOREIGN KEY (organization_id, document_id)
		REFERENCES public.knowledge_documents(organization_id, id) ON DELETE CASCADE
);

CREATE INDEX knowledge_chunks_org_doc_idx
	ON public.knowledge_chunks (organization_id, document_id);
CREATE INDEX knowledge_chunks_fts_gin_idx
	ON public.knowledge_chunks USING gin (fts);
CREATE INDEX knowledge_chunks_embedding_hnsw_idx
	ON public.knowledge_chunks USING hnsw (embedding extensions.vector_cosine_ops);

-- (18) org_usage_periods
CREATE TABLE public.org_usage_periods (
	id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
	period_start timestamptz NOT NULL,
	period_end timestamptz NOT NULL,
	included_ai_replies integer NOT NULL CHECK (included_ai_replies >= 0),
	used_ai_replies integer NOT NULL DEFAULT 0 CHECK (used_ai_replies >= 0),
	overage_ai_replies integer NOT NULL DEFAULT 0 CHECK (overage_ai_replies >= 0),
	draft_count integer NOT NULL DEFAULT 0 CHECK (draft_count >= 0),
	test_chat_count integer NOT NULL DEFAULT 0 CHECK (test_chat_count >= 0),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, period_start)
);

CREATE TRIGGER org_usage_periods_set_updated_at
	BEFORE UPDATE ON public.org_usage_periods
	FOR EACH ROW
	EXECUTE FUNCTION private.set_updated_at();

-- (19) ai_usage_ledger
CREATE TABLE public.ai_usage_ledger (
	id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
	usage_period_id bigint REFERENCES public.org_usage_periods(id) ON DELETE SET NULL,
	conversation_id uuid,
	action text NOT NULL CHECK (action IN ('auto_reply', 'draft', 'qualify_only', 'embed', 'test_chat')),
	billable_units integer NOT NULL DEFAULT 0 CHECK (billable_units >= 0),
	model text NOT NULL DEFAULT 'gemini-2.5-flash',
	input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
	output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
	estimated_cost_micros bigint NOT NULL DEFAULT 0 CHECK (estimated_cost_micros >= 0),
	stripe_meter_reported_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now(),
	FOREIGN KEY (organization_id, conversation_id)
		REFERENCES public.conversations(organization_id, id) ON DELETE SET NULL (conversation_id)
);

CREATE INDEX ai_usage_ledger_org_created_idx
	ON public.ai_usage_ledger (organization_id, created_at DESC);
CREATE INDEX ai_usage_ledger_period_idx
	ON public.ai_usage_ledger (usage_period_id);
CREATE INDEX ai_usage_ledger_org_conv_idx
	ON public.ai_usage_ledger (organization_id, conversation_id);
