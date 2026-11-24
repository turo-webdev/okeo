-- Okeo RLS, Private Auth Helpers, Hybrid RAG Function, Storage Buckets & Realtime

-- 1. Least-privilege table/sequence grants in public
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon;

GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;

GRANT SELECT, UPDATE ON public.profiles TO authenticated;
GRANT SELECT, UPDATE ON public.organizations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON
	public.organization_members,
	public.organization_invitations,
	public.connected_channels,
	public.contacts,
	public.contact_identities,
	public.contact_notes,
	public.conversations,
	public.messages,
	public.pipelines,
	public.pipeline_stages,
	public.deals,
	public.ai_settings,
	public.knowledge_documents,
	public.knowledge_chunks
TO authenticated;
GRANT SELECT ON public.org_usage_periods, public.ai_usage_ledger TO authenticated;
REVOKE ALL ON TABLE public.stripe_webhook_events FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- 2. Private RBAC Helpers (never exposed via PostgREST)
CREATE OR REPLACE FUNCTION private.role_rank(p_role text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
	SELECT CASE p_role
		WHEN 'viewer' THEN 1
		WHEN 'agent' THEN 2
		WHEN 'admin' THEN 3
		WHEN 'owner' THEN 4
		ELSE 0
	END;
$$;

CREATE OR REPLACE FUNCTION private.user_org_ids(min_role text DEFAULT 'viewer')
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
	SELECT om.organization_id
	FROM public.organization_members om
	WHERE om.user_id = (select auth.uid())
	  AND private.role_rank(om.role) >= private.role_rank(min_role);
$$;

CREATE OR REPLACE FUNCTION private.is_org_member(target_org_id uuid, min_role text DEFAULT 'viewer')
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
	SELECT EXISTS (
		SELECT 1
		FROM public.organization_members om
		WHERE om.organization_id = target_org_id
		  AND om.user_id = (select auth.uid())
		  AND private.role_rank(om.role) >= private.role_rank(min_role)
	);
$$;

REVOKE ALL ON FUNCTION private.role_rank(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.role_rank(text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION private.user_org_ids(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.user_org_ids(text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION private.is_org_member(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.is_org_member(uuid, text) TO authenticated, service_role;

-- Atomic AI reply quota consumer for Cloudflare Queue consumer / backend workers
CREATE OR REPLACE FUNCTION private.consume_ai_reply(p_org_id uuid)
RETURNS TABLE (
	allowed boolean,
	usage_period_id bigint,
	used_ai_replies integer,
	included_ai_replies integer,
	overage_ai_replies integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
	v_overage_enabled boolean;
	v_period public.org_usage_periods%ROWTYPE;
BEGIN
	SELECT o.ai_overage_enabled
	INTO v_overage_enabled
	FROM public.organizations o
	WHERE o.id = p_org_id;

	IF NOT FOUND THEN
		RETURN QUERY SELECT false, NULL::bigint, 0, 0, 0;
		RETURN;
	END IF;

	SELECT *
	INTO v_period
	FROM public.org_usage_periods u
	WHERE u.organization_id = p_org_id
	ORDER BY u.period_start DESC
	LIMIT 1
	FOR UPDATE;

	IF NOT FOUND THEN
		RETURN QUERY SELECT false, NULL::bigint, 0, 0, 0;
		RETURN;
	END IF;

	IF v_period.used_ai_replies < v_period.included_ai_replies THEN
		UPDATE public.org_usage_periods
		SET used_ai_replies = used_ai_replies + 1,
			updated_at = now()
		WHERE id = v_period.id
		RETURNING * INTO v_period;

		RETURN QUERY SELECT true, v_period.id, v_period.used_ai_replies, v_period.included_ai_replies, v_period.overage_ai_replies;
	ELSIF v_overage_enabled THEN
		UPDATE public.org_usage_periods
		SET used_ai_replies = used_ai_replies + 1,
			overage_ai_replies = overage_ai_replies + 1,
			updated_at = now()
		WHERE id = v_period.id
		RETURNING * INTO v_period;

		RETURN QUERY SELECT true, v_period.id, v_period.used_ai_replies, v_period.included_ai_replies, v_period.overage_ai_replies;
	ELSE
		RETURN QUERY SELECT false, v_period.id, v_period.used_ai_replies, v_period.included_ai_replies, v_period.overage_ai_replies;
	END IF;
END;
$$;

REVOKE ALL ON FUNCTION private.consume_ai_reply(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.consume_ai_reply(uuid) TO service_role;

-- Hybrid RAG search (FTS 'simple' + pgvector HNSW iterative_scan)
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
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
	v_safe_limit integer := pg_catalog.least(pg_catalog.greatest(coalesce(p_limit, 5), 1), 10);
BEGIN
	IF current_user <> 'service_role' AND NOT private.is_org_member(p_org_id, 'viewer') THEN
		RAISE EXCEPTION 'Acceso denegado a la base de conocimiento del workspace';
	END IF;

	-- Prevents losing recall on filtered tenant queries (pgvector >= 0.8)
	SET LOCAL hnsw.iterative_scan = relaxed_order;

	RETURN QUERY
	WITH ts_query AS (
		SELECT pg_catalog.websearch_to_tsquery('simple', coalesce(p_query_text, '')) AS q
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

-- 3. Enable RLS on all 19 public tables
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connected_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pipelines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pipeline_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_usage_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_usage_ledger ENABLE ROW LEVEL SECURITY;

-- 4. RLS Policies (explicit TO authenticated + InitPlan subselects + WITH CHECK)

-- profiles
CREATE POLICY profiles_select_own_or_coworker
	ON public.profiles FOR SELECT
	TO authenticated
	USING (
		id = (select auth.uid())
		OR id IN (
			SELECT om.user_id
			FROM public.organization_members om
			WHERE om.organization_id IN (SELECT private.user_org_ids('viewer'))
		)
	);

CREATE POLICY profiles_update_own
	ON public.profiles FOR UPDATE
	TO authenticated
	USING (id = (select auth.uid()))
	WITH CHECK (id = (select auth.uid()));

-- organizations
CREATE POLICY organizations_select_member
	ON public.organizations FOR SELECT
	TO authenticated
	USING (id IN (SELECT private.user_org_ids('viewer')));

CREATE POLICY organizations_update_admin
	ON public.organizations FOR UPDATE
	TO authenticated
	USING (id IN (SELECT private.user_org_ids('admin')))
	WITH CHECK (id IN (SELECT private.user_org_ids('admin')));

-- organization_members
CREATE POLICY organization_members_select_member
	ON public.organization_members FOR SELECT
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('viewer')));

CREATE POLICY organization_members_insert_admin
	ON public.organization_members FOR INSERT
	TO authenticated
	WITH CHECK (organization_id IN (SELECT private.user_org_ids('admin')));

CREATE POLICY organization_members_update_admin
	ON public.organization_members FOR UPDATE
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('admin')))
	WITH CHECK (organization_id IN (SELECT private.user_org_ids('admin')));

CREATE POLICY organization_members_delete_admin
	ON public.organization_members FOR DELETE
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('admin')));

-- organization_invitations
CREATE POLICY organization_invitations_select_admin
	ON public.organization_invitations FOR SELECT
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('admin')));

CREATE POLICY organization_invitations_insert_admin
	ON public.organization_invitations FOR INSERT
	TO authenticated
	WITH CHECK (organization_id IN (SELECT private.user_org_ids('admin')));

CREATE POLICY organization_invitations_update_admin
	ON public.organization_invitations FOR UPDATE
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('admin')))
	WITH CHECK (organization_id IN (SELECT private.user_org_ids('admin')));

CREATE POLICY organization_invitations_delete_admin
	ON public.organization_invitations FOR DELETE
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('admin')));

-- stripe_webhook_events (explicit deny for client roles; service_role bypasses RLS)
CREATE POLICY stripe_webhook_events_deny_authenticated
	ON public.stripe_webhook_events FOR ALL
	TO authenticated
	USING (false)
	WITH CHECK (false);

-- connected_channels
CREATE POLICY connected_channels_select_member
	ON public.connected_channels FOR SELECT
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('viewer')));

CREATE POLICY connected_channels_insert_admin
	ON public.connected_channels FOR INSERT
	TO authenticated
	WITH CHECK (organization_id IN (SELECT private.user_org_ids('admin')));

CREATE POLICY connected_channels_update_admin
	ON public.connected_channels FOR UPDATE
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('admin')))
	WITH CHECK (organization_id IN (SELECT private.user_org_ids('admin')));

CREATE POLICY connected_channels_delete_admin
	ON public.connected_channels FOR DELETE
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('admin')));

-- contacts
CREATE POLICY contacts_select_member
	ON public.contacts FOR SELECT
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('viewer')));

CREATE POLICY contacts_insert_agent
	ON public.contacts FOR INSERT
	TO authenticated
	WITH CHECK (organization_id IN (SELECT private.user_org_ids('agent')));

CREATE POLICY contacts_update_agent
	ON public.contacts FOR UPDATE
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('agent')))
	WITH CHECK (organization_id IN (SELECT private.user_org_ids('agent')));

CREATE POLICY contacts_delete_admin
	ON public.contacts FOR DELETE
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('admin')));

-- contact_identities
CREATE POLICY contact_identities_select_member
	ON public.contact_identities FOR SELECT
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('viewer')));

CREATE POLICY contact_identities_insert_agent
	ON public.contact_identities FOR INSERT
	TO authenticated
	WITH CHECK (organization_id IN (SELECT private.user_org_ids('agent')));

CREATE POLICY contact_identities_update_agent
	ON public.contact_identities FOR UPDATE
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('agent')))
	WITH CHECK (organization_id IN (SELECT private.user_org_ids('agent')));

CREATE POLICY contact_identities_delete_admin
	ON public.contact_identities FOR DELETE
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('admin')));

-- contact_notes
CREATE POLICY contact_notes_select_member
	ON public.contact_notes FOR SELECT
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('viewer')));

CREATE POLICY contact_notes_insert_agent
	ON public.contact_notes FOR INSERT
	TO authenticated
	WITH CHECK (organization_id IN (SELECT private.user_org_ids('agent')));

CREATE POLICY contact_notes_update_author_or_admin
	ON public.contact_notes FOR UPDATE
	TO authenticated
	USING (
		organization_id IN (SELECT private.user_org_ids('admin'))
		OR (
			author_user_id = (select auth.uid())
			AND organization_id IN (SELECT private.user_org_ids('agent'))
		)
	)
	WITH CHECK (
		organization_id IN (SELECT private.user_org_ids('admin'))
		OR (
			author_user_id = (select auth.uid())
			AND organization_id IN (SELECT private.user_org_ids('agent'))
		)
	);

CREATE POLICY contact_notes_delete_author_or_admin
	ON public.contact_notes FOR DELETE
	TO authenticated
	USING (
		organization_id IN (SELECT private.user_org_ids('admin'))
		OR (
			author_user_id = (select auth.uid())
			AND organization_id IN (SELECT private.user_org_ids('agent'))
		)
	);

-- conversations
CREATE POLICY conversations_select_member
	ON public.conversations FOR SELECT
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('viewer')));

CREATE POLICY conversations_insert_agent
	ON public.conversations FOR INSERT
	TO authenticated
	WITH CHECK (organization_id IN (SELECT private.user_org_ids('agent')));

CREATE POLICY conversations_update_agent
	ON public.conversations FOR UPDATE
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('agent')))
	WITH CHECK (organization_id IN (SELECT private.user_org_ids('agent')));

CREATE POLICY conversations_delete_admin
	ON public.conversations FOR DELETE
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('admin')));

-- messages
CREATE POLICY messages_select_member
	ON public.messages FOR SELECT
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('viewer')));

CREATE POLICY messages_insert_agent
	ON public.messages FOR INSERT
	TO authenticated
	WITH CHECK (organization_id IN (SELECT private.user_org_ids('agent')));

CREATE POLICY messages_update_agent
	ON public.messages FOR UPDATE
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('agent')))
	WITH CHECK (organization_id IN (SELECT private.user_org_ids('agent')));

CREATE POLICY messages_delete_admin
	ON public.messages FOR DELETE
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('admin')));

-- pipelines
CREATE POLICY pipelines_select_member
	ON public.pipelines FOR SELECT
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('viewer')));

CREATE POLICY pipelines_insert_admin
	ON public.pipelines FOR INSERT
	TO authenticated
	WITH CHECK (organization_id IN (SELECT private.user_org_ids('admin')));

CREATE POLICY pipelines_update_admin
	ON public.pipelines FOR UPDATE
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('admin')))
	WITH CHECK (organization_id IN (SELECT private.user_org_ids('admin')));

CREATE POLICY pipelines_delete_admin
	ON public.pipelines FOR DELETE
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('admin')));

-- pipeline_stages
CREATE POLICY pipeline_stages_select_member
	ON public.pipeline_stages FOR SELECT
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('viewer')));

CREATE POLICY pipeline_stages_insert_admin
	ON public.pipeline_stages FOR INSERT
	TO authenticated
	WITH CHECK (organization_id IN (SELECT private.user_org_ids('admin')));

CREATE POLICY pipeline_stages_update_admin
	ON public.pipeline_stages FOR UPDATE
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('admin')))
	WITH CHECK (organization_id IN (SELECT private.user_org_ids('admin')));

CREATE POLICY pipeline_stages_delete_admin
	ON public.pipeline_stages FOR DELETE
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('admin')));

-- deals
CREATE POLICY deals_select_member
	ON public.deals FOR SELECT
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('viewer')));

CREATE POLICY deals_insert_agent
	ON public.deals FOR INSERT
	TO authenticated
	WITH CHECK (organization_id IN (SELECT private.user_org_ids('agent')));

CREATE POLICY deals_update_agent
	ON public.deals FOR UPDATE
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('agent')))
	WITH CHECK (organization_id IN (SELECT private.user_org_ids('agent')));

CREATE POLICY deals_delete_admin
	ON public.deals FOR DELETE
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('admin')));

-- ai_settings
CREATE POLICY ai_settings_select_member
	ON public.ai_settings FOR SELECT
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('viewer')));

CREATE POLICY ai_settings_insert_admin
	ON public.ai_settings FOR INSERT
	TO authenticated
	WITH CHECK (organization_id IN (SELECT private.user_org_ids('admin')));

CREATE POLICY ai_settings_update_admin
	ON public.ai_settings FOR UPDATE
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('admin')))
	WITH CHECK (organization_id IN (SELECT private.user_org_ids('admin')));

-- knowledge_documents
CREATE POLICY knowledge_documents_select_member
	ON public.knowledge_documents FOR SELECT
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('viewer')));

CREATE POLICY knowledge_documents_insert_admin
	ON public.knowledge_documents FOR INSERT
	TO authenticated
	WITH CHECK (organization_id IN (SELECT private.user_org_ids('admin')));

CREATE POLICY knowledge_documents_update_admin
	ON public.knowledge_documents FOR UPDATE
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('admin')))
	WITH CHECK (organization_id IN (SELECT private.user_org_ids('admin')));

CREATE POLICY knowledge_documents_delete_admin
	ON public.knowledge_documents FOR DELETE
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('admin')));

-- knowledge_chunks
CREATE POLICY knowledge_chunks_select_member
	ON public.knowledge_chunks FOR SELECT
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('viewer')));

CREATE POLICY knowledge_chunks_insert_admin
	ON public.knowledge_chunks FOR INSERT
	TO authenticated
	WITH CHECK (organization_id IN (SELECT private.user_org_ids('admin')));

CREATE POLICY knowledge_chunks_update_admin
	ON public.knowledge_chunks FOR UPDATE
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('admin')))
	WITH CHECK (organization_id IN (SELECT private.user_org_ids('admin')));

CREATE POLICY knowledge_chunks_delete_admin
	ON public.knowledge_chunks FOR DELETE
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('admin')));

-- org_usage_periods & ai_usage_ledger (read-only for workspace viewers+; mutated by service_role)
CREATE POLICY org_usage_periods_select_member
	ON public.org_usage_periods FOR SELECT
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('viewer')));

CREATE POLICY ai_usage_ledger_select_member
	ON public.ai_usage_ledger FOR SELECT
	TO authenticated
	USING (organization_id IN (SELECT private.user_org_ids('viewer')));

-- 5. Private Storage Buckets & Path-Scoped RLS (dm-media, knowledge-files)
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES
	('dm-media', 'dm-media', false, 26214400),
	('knowledge-files', 'knowledge-files', false, 26214400)
ON CONFLICT (id) DO UPDATE
	SET public = false,
		file_size_limit = EXCLUDED.file_size_limit;

-- Storage objects require SELECT + INSERT + UPDATE for uploads/upserts (supabase/SKILL.md)
CREATE POLICY okeo_storage_select_member
	ON storage.objects FOR SELECT
	TO authenticated
	USING (
		bucket_id IN ('dm-media', 'knowledge-files')
		AND (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		AND ((storage.foldername(name))[1])::uuid IN (SELECT private.user_org_ids('viewer'))
	);

CREATE POLICY okeo_storage_dm_media_insert_agent
	ON storage.objects FOR INSERT
	TO authenticated
	WITH CHECK (
		bucket_id = 'dm-media'
		AND (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		AND ((storage.foldername(name))[1])::uuid IN (SELECT private.user_org_ids('agent'))
	);

CREATE POLICY okeo_storage_dm_media_update_agent
	ON storage.objects FOR UPDATE
	TO authenticated
	USING (
		bucket_id = 'dm-media'
		AND (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		AND ((storage.foldername(name))[1])::uuid IN (SELECT private.user_org_ids('agent'))
	)
	WITH CHECK (
		bucket_id = 'dm-media'
		AND (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		AND ((storage.foldername(name))[1])::uuid IN (SELECT private.user_org_ids('agent'))
	);

CREATE POLICY okeo_storage_kb_insert_admin
	ON storage.objects FOR INSERT
	TO authenticated
	WITH CHECK (
		bucket_id = 'knowledge-files'
		AND (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		AND ((storage.foldername(name))[1])::uuid IN (SELECT private.user_org_ids('admin'))
	);

CREATE POLICY okeo_storage_kb_update_admin
	ON storage.objects FOR UPDATE
	TO authenticated
	USING (
		bucket_id = 'knowledge-files'
		AND (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		AND ((storage.foldername(name))[1])::uuid IN (SELECT private.user_org_ids('admin'))
	)
	WITH CHECK (
		bucket_id = 'knowledge-files'
		AND (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		AND ((storage.foldername(name))[1])::uuid IN (SELECT private.user_org_ids('admin'))
	);

CREATE POLICY okeo_storage_delete_admin
	ON storage.objects FOR DELETE
	TO authenticated
	USING (
		bucket_id IN ('dm-media', 'knowledge-files')
		AND (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
		AND ((storage.foldername(name))[1])::uuid IN (SELECT private.user_org_ids('admin'))
	);

-- 6. Supabase Realtime publication for Inbox & Pipeline tables
DO $$
DECLARE
	v_tbl text;
	v_tables text[] := ARRAY['conversations', 'messages', 'connected_channels', 'deals'];
BEGIN
	IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
		FOREACH v_tbl IN ARRAY v_tables LOOP
			IF NOT EXISTS (
				SELECT 1
				FROM pg_publication_tables
				WHERE pubname = 'supabase_realtime'
				  AND schemaname = 'public'
				  AND tablename = v_tbl
			) THEN
				EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', v_tbl);
			END IF;
		END LOOP;
	END IF;
END;
$$;
