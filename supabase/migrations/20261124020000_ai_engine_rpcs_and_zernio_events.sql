-- AI Engine Atomic RPCs, Persistent Zernio Webhook Deduplication, and Hybrid RAG RPC

-- 1. Persistent Zernio webhook idempotency table (service_role only, survives CF Worker cold starts)
CREATE TABLE IF NOT EXISTS public.zernio_webhook_events (
	event_id text PRIMARY KEY,
	event_type text NOT NULL,
	processed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.zernio_webhook_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.zernio_webhook_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.zernio_webhook_events TO service_role;

CREATE POLICY zernio_webhook_events_deny_authenticated
	ON public.zernio_webhook_events FOR ALL
	TO authenticated
	USING (false)
	WITH CHECK (false);

-- 2. Index for descending message ID lookup during debounce & lease checks
CREATE INDEX IF NOT EXISTS messages_org_conv_id_idx
	ON public.messages (organization_id, conversation_id, id DESC);

-- 3. Ensure current org usage period exists before atomic quota consumption
CREATE OR REPLACE FUNCTION private.ensure_current_usage_period(p_org_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
	v_org public.organizations%ROWTYPE;
	v_period_id bigint;
	v_included integer;
BEGIN
	SELECT *
	INTO v_org
	FROM public.organizations o
	WHERE o.id = p_org_id;

	IF NOT FOUND THEN
		RETURN NULL;
	END IF;

	SELECT u.id
	INTO v_period_id
	FROM public.org_usage_periods u
	WHERE u.organization_id = p_org_id
	ORDER BY u.period_start DESC
	LIMIT 1;

	IF v_period_id IS NOT NULL THEN
		RETURN v_period_id;
	END IF;

	v_included := CASE
		WHEN v_org.billing_mode = 'trial' THEN 100
		ELSE greatest(1, v_org.channel_slots) * v_org.included_ai_replies_per_channel
	END;

	INSERT INTO public.org_usage_periods (
		organization_id,
		period_start,
		period_end,
		included_ai_replies,
		used_ai_replies,
		overage_ai_replies,
		draft_count,
		test_chat_count
	)
	VALUES (
		p_org_id,
		v_org.current_period_start,
		v_org.current_period_end,
		v_included,
		0,
		0,
		0,
		0
	)
	ON CONFLICT (organization_id, period_start) DO NOTHING;

	SELECT u.id
	INTO v_period_id
	FROM public.org_usage_periods u
	WHERE u.organization_id = p_org_id
	ORDER BY u.period_start DESC
	LIMIT 1;

	RETURN v_period_id;
END;
$$;

REVOKE ALL ON FUNCTION private.ensure_current_usage_period(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.ensure_current_usage_period(uuid) TO service_role;

-- Unified atomic AI quota consumer RPC in public (service_role only)
CREATE OR REPLACE FUNCTION public.consume_ai_quota_rpc(
	p_org_id uuid,
	p_action text DEFAULT 'auto_reply'
)
RETURNS TABLE (
	allowed boolean,
	reason text,
	usage_period_id bigint,
	used_ai_replies integer,
	included_ai_replies integer,
	overage_ai_replies integer,
	draft_count integer,
	test_chat_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
	v_org public.organizations%ROWTYPE;
	v_period_id bigint;
	v_period public.org_usage_periods%ROWTYPE;
	v_test_cap integer;
BEGIN
	IF p_action NOT IN ('auto_reply', 'draft', 'test_chat') THEN
		RETURN QUERY SELECT false, 'invalid_action', NULL::bigint, 0, 0, 0, 0, 0;
		RETURN;
	END IF;

	SELECT *
	INTO v_org
	FROM public.organizations o
	WHERE o.id = p_org_id;

	IF NOT FOUND THEN
		RETURN QUERY SELECT false, 'org_not_found', NULL::bigint, 0, 0, 0, 0, 0;
		RETURN;
	END IF;

	IF v_org.subscription_status IN ('past_due', 'canceled', 'expired')
		OR (v_org.billing_mode = 'trial' AND v_org.trial_ends_at IS NOT NULL AND v_org.trial_ends_at < now()) THEN
		RETURN QUERY SELECT false, 'subscription_inactive', NULL::bigint, 0, 0, 0, 0, 0;
		RETURN;
	END IF;

	v_period_id := private.ensure_current_usage_period(p_org_id);
	IF v_period_id IS NULL THEN
		RETURN QUERY SELECT false, 'usage_period_missing', NULL::bigint, 0, 0, 0, 0, 0;
		RETURN;
	END IF;

	SELECT *
	INTO v_period
	FROM public.org_usage_periods u
	WHERE u.id = v_period_id
	FOR UPDATE;

	IF p_action = 'test_chat' THEN
		v_test_cap := CASE
			WHEN v_org.billing_mode = 'trial' THEN 50
			ELSE greatest(1, v_org.channel_slots) * 200
		END;

		IF v_period.test_chat_count >= v_test_cap THEN
			RETURN QUERY SELECT
				false,
				'test_chat_limit_reached',
				v_period.id,
				v_period.used_ai_replies,
				v_period.included_ai_replies,
				v_period.overage_ai_replies,
				v_period.draft_count,
				v_period.test_chat_count;
			RETURN;
		END IF;

		UPDATE public.org_usage_periods u
		SET test_chat_count = u.test_chat_count + 1,
			updated_at = now()
		WHERE u.id = v_period.id
		RETURNING * INTO v_period;

		RETURN QUERY SELECT
			true,
			'ok',
			v_period.id,
			v_period.used_ai_replies,
			v_period.included_ai_replies,
			v_period.overage_ai_replies,
			v_period.draft_count,
			v_period.test_chat_count;
		RETURN;
	END IF;

	IF v_period.used_ai_replies < v_period.included_ai_replies THEN
		UPDATE public.org_usage_periods u
		SET used_ai_replies = u.used_ai_replies + 1,
			draft_count = CASE WHEN p_action = 'draft' THEN u.draft_count + 1 ELSE u.draft_count END,
			updated_at = now()
		WHERE u.id = v_period.id
		RETURNING * INTO v_period;

		RETURN QUERY SELECT
			true,
			'ok',
			v_period.id,
			v_period.used_ai_replies,
			v_period.included_ai_replies,
			v_period.overage_ai_replies,
			v_period.draft_count,
			v_period.test_chat_count;
		RETURN;
	ELSIF v_org.ai_overage_enabled THEN
		UPDATE public.org_usage_periods u
		SET used_ai_replies = u.used_ai_replies + 1,
			overage_ai_replies = u.overage_ai_replies + 1,
			draft_count = CASE WHEN p_action = 'draft' THEN u.draft_count + 1 ELSE u.draft_count END,
			updated_at = now()
		WHERE u.id = v_period.id
		RETURNING * INTO v_period;

		RETURN QUERY SELECT
			true,
			'overage',
			v_period.id,
			v_period.used_ai_replies,
			v_period.included_ai_replies,
			v_period.overage_ai_replies,
			v_period.draft_count,
			v_period.test_chat_count;
		RETURN;
	ELSE
		RETURN QUERY SELECT
			false,
			'quota_exhausted',
			v_period.id,
			v_period.used_ai_replies,
			v_period.included_ai_replies,
			v_period.overage_ai_replies,
			v_period.draft_count,
			v_period.test_chat_count;
		RETURN;
	END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_ai_quota_rpc(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_ai_quota_rpc(uuid, text) TO service_role;

-- 4. Atomic conversation lease & pre-send concurrency guardrails (service_role only)
CREATE OR REPLACE FUNCTION public.acquire_conversation_ai_lease_rpc(
	p_org_id uuid,
	p_conversation_id uuid,
	p_message_id bigint,
	p_lease_seconds integer DEFAULT 30
)
RETURNS TABLE (
	acquired boolean,
	reason text,
	latest_inbound_id bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
	v_conv public.conversations%ROWTYPE;
	v_latest_inbound bigint;
	v_safe_seconds integer;
BEGIN
	SELECT *
	INTO v_conv
	FROM public.conversations c
	WHERE c.id = p_conversation_id
	  AND c.organization_id = p_org_id
	FOR UPDATE;

	IF NOT FOUND THEN
		RETURN QUERY SELECT false, 'not_found', NULL::bigint;
		RETURN;
	END IF;

	SELECT coalesce(max(m.id), 0)
	INTO v_latest_inbound
	FROM public.messages m
	WHERE m.organization_id = p_org_id
	  AND m.conversation_id = p_conversation_id
	  AND m.direction = 'inbound';

	IF v_latest_inbound > p_message_id THEN
		RETURN QUERY SELECT false, 'superseded_by_newer_message', v_latest_inbound;
		RETURN;
	END IF;

	IF v_conv.last_processed_inbound_message_id IS NOT NULL
		AND v_conv.last_processed_inbound_message_id >= p_message_id THEN
		RETURN QUERY SELECT false, 'already_processed', v_latest_inbound;
		RETURN;
	END IF;

	IF v_conv.ai_processing_locked_until IS NOT NULL
		AND v_conv.ai_processing_locked_until > now() THEN
		RETURN QUERY SELECT false, 'locked', v_latest_inbound;
		RETURN;
	END IF;

	v_safe_seconds := greatest(5, least(coalesce(p_lease_seconds, 30), 120));

	UPDATE public.conversations c
	SET ai_processing_locked_until = now() + pg_catalog.make_interval(secs => v_safe_seconds)
	WHERE c.id = p_conversation_id
	  AND c.organization_id = p_org_id;

	RETURN QUERY SELECT true, 'ok', v_latest_inbound;
END;
$$;

REVOKE ALL ON FUNCTION public.acquire_conversation_ai_lease_rpc(uuid, uuid, bigint, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acquire_conversation_ai_lease_rpc(uuid, uuid, bigint, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.verify_conversation_ready_for_ai_send_rpc(
	p_org_id uuid,
	p_conversation_id uuid,
	p_expected_inbound_message_id bigint
)
RETURNS TABLE (
	ready boolean,
	reason text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
	v_conv public.conversations%ROWTYPE;
	v_newer_exists boolean;
BEGIN
	SELECT *
	INTO v_conv
	FROM public.conversations c
	WHERE c.id = p_conversation_id
	  AND c.organization_id = p_org_id
	FOR UPDATE;

	IF NOT FOUND THEN
		RETURN QUERY SELECT false, 'not_found';
		RETURN;
	END IF;

	IF v_conv.ai_paused THEN
		RETURN QUERY SELECT false, 'ai_paused';
		RETURN;
	END IF;

	IF v_conv.last_inbound_at IS NULL OR v_conv.last_inbound_at < now() - interval '24 hours' THEN
		RETURN QUERY SELECT false, 'meta_24h_closed';
		RETURN;
	END IF;

	SELECT EXISTS (
		SELECT 1
		FROM public.messages m
		WHERE m.organization_id = p_org_id
		  AND m.conversation_id = p_conversation_id
		  AND m.id > p_expected_inbound_message_id
	)
	INTO v_newer_exists;

	IF v_newer_exists THEN
		RETURN QUERY SELECT false, 'newer_message_arrived';
		RETURN;
	END IF;

	RETURN QUERY SELECT true, 'ok';
END;
$$;

REVOKE ALL ON FUNCTION public.verify_conversation_ready_for_ai_send_rpc(uuid, uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_conversation_ready_for_ai_send_rpc(uuid, uuid, bigint) TO service_role;

CREATE OR REPLACE FUNCTION public.release_conversation_ai_lease_rpc(
	p_org_id uuid,
	p_conversation_id uuid,
	p_processed_message_id bigint DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
	UPDATE public.conversations c
	SET ai_processing_locked_until = NULL,
		last_processed_inbound_message_id = CASE
			WHEN p_processed_message_id IS NOT NULL THEN
				greatest(coalesce(c.last_processed_inbound_message_id, 0), p_processed_message_id)
			ELSE c.last_processed_inbound_message_id
		END
	WHERE c.id = p_conversation_id
	  AND c.organization_id = p_org_id;
END;
$$;

REVOKE ALL ON FUNCTION public.release_conversation_ai_lease_rpc(uuid, uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_conversation_ai_lease_rpc(uuid, uuid, bigint) TO service_role;

-- 5. Fix private.search_knowledge_hybrid (SECURITY INVOKER + SQL greatest/least) & expose public wrapper
CREATE OR REPLACE FUNCTION private.search_knowledge_hybrid(
	p_org_id uuid,
	p_query_text text,
	p_query_embedding extensions.vector(768),
	p_limit integer DEFAULT 5
)
RETURNS TABLE (
	chunk_id bigint,
	document_id uuid,
	document_title text,
	content text,
	score double precision
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
	v_safe_limit integer := least(greatest(coalesce(p_limit, 5), 1), 10);
BEGIN
	IF current_user NOT IN ('service_role', 'postgres') AND NOT private.is_org_member(p_org_id, 'viewer') THEN
		RAISE EXCEPTION 'Acceso denegado a la base de conocimiento del workspace';
	END IF;

	-- Prevents losing recall on filtered tenant queries (pgvector >= 0.8)
	SET LOCAL hnsw.iterative_scan = relaxed_order;

	RETURN QUERY
	WITH ts_query AS (
		SELECT pg_catalog.websearch_to_tsquery('pg_catalog.simple'::pg_catalog.regconfig, coalesce(p_query_text, '')) AS q
	),
	scored AS (
		SELECT
			kc.id AS chunk_id,
			kc.document_id,
			kd.title AS document_title,
			kc.content,
			(
				CASE
					WHEN p_query_embedding IS NOT NULL AND kc.embedding IS NOT NULL
						THEN (1.0 - (kc.embedding OPERATOR(extensions.<=>) p_query_embedding)) * 0.7
					ELSE 0.0
				END
				+
				CASE
					WHEN coalesce(trim(p_query_text), '') <> ''
						THEN pg_catalog.ts_rank_cd(kc.fts, (SELECT q FROM ts_query)) * 0.3
					ELSE 0.0
				END
			)::double precision AS combined_score
		FROM public.knowledge_chunks kc
		JOIN public.knowledge_documents kd
		  ON kd.organization_id = kc.organization_id
		 AND kd.id = kc.document_id
		WHERE kc.organization_id = p_org_id
		  AND kd.status = 'ready'
	)
	SELECT s.chunk_id, s.document_id, s.document_title, s.content, s.combined_score
	FROM scored s
	ORDER BY s.combined_score DESC, s.chunk_id ASC
	LIMIT v_safe_limit;
END;
$$;

REVOKE ALL ON FUNCTION private.search_knowledge_hybrid(uuid, text, extensions.vector(768), integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.search_knowledge_hybrid(uuid, text, extensions.vector(768), integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.search_knowledge_hybrid_rpc(
	p_org_id uuid,
	p_query_text text,
	p_query_embedding extensions.vector(768) DEFAULT NULL,
	p_limit integer DEFAULT 5
)
RETURNS TABLE (
	chunk_id bigint,
	document_id uuid,
	document_title text,
	content text,
	score double precision
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
	RETURN QUERY
	SELECT *
	FROM private.search_knowledge_hybrid(p_org_id, p_query_text, p_query_embedding, p_limit);
END;
$$;

REVOKE ALL ON FUNCTION public.search_knowledge_hybrid_rpc(uuid, text, extensions.vector(768), integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_knowledge_hybrid_rpc(uuid, text, extensions.vector(768), integer) TO authenticated, service_role;
