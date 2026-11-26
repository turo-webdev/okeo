-- Server-side OAuth / Headless Channel Connect Sessions (Hito 1)
-- Holds short-lived state and AES-256-GCM encrypted temporary provider tokens strictly for service_role.

CREATE TABLE IF NOT EXISTS public.channel_connect_sessions (
	id text PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
	user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
	platform text NOT NULL CHECK (platform IN ('whatsapp', 'instagram', 'facebook')),
	target_channel_id uuid NULL,
	status text NOT NULL DEFAULT 'initiated'
		CHECK (status IN ('initiated', 'pending_selection', 'completing', 'completed', 'cancelled', 'failed', 'expired')),
	encrypted_provider_payload text NULL,
	connected_channel_id uuid NULL,
	error_code text NULL,
	expires_at timestamptz NOT NULL,
	completed_at timestamptz NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT channel_connect_sessions_target_channel_fk
		FOREIGN KEY (organization_id, target_channel_id)
		REFERENCES public.connected_channels(organization_id, id)
		ON DELETE SET NULL (target_channel_id),
	CONSTRAINT channel_connect_sessions_connected_channel_fk
		FOREIGN KEY (organization_id, connected_channel_id)
		REFERENCES public.connected_channels(organization_id, id)
		ON DELETE SET NULL (connected_channel_id)
);

CREATE INDEX IF NOT EXISTS channel_connect_sessions_org_status_exp_idx
	ON public.channel_connect_sessions (organization_id, status, expires_at);

CREATE INDEX IF NOT EXISTS channel_connect_sessions_user_org_idx
	ON public.channel_connect_sessions (user_id, organization_id);

CREATE TRIGGER channel_connect_sessions_set_updated_at
	BEFORE UPDATE ON public.channel_connect_sessions
	FOR EACH ROW
	EXECUTE FUNCTION private.set_updated_at();

ALTER TABLE public.channel_connect_sessions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.channel_connect_sessions FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.channel_connect_sessions TO service_role;

CREATE POLICY channel_connect_sessions_deny_authenticated
	ON public.channel_connect_sessions FOR ALL
	TO authenticated
	USING (false)
	WITH CHECK (false);
