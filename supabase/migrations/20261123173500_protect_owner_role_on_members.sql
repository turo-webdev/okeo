-- Protect owner role from non-owner escalation/removal and enforce last-owner invariant

ALTER POLICY organization_members_insert_admin
	ON public.organization_members
	WITH CHECK (
		(
			role IN ('admin', 'agent', 'viewer')
			AND organization_id IN (SELECT private.user_org_ids('admin'))
		)
		OR (
			role = 'owner'
			AND organization_id IN (SELECT private.user_org_ids('owner'))
		)
	);

ALTER POLICY organization_members_update_admin
	ON public.organization_members
	USING (
		(
			role <> 'owner'
			AND organization_id IN (SELECT private.user_org_ids('admin'))
		)
		OR (
			role = 'owner'
			AND organization_id IN (SELECT private.user_org_ids('owner'))
		)
	)
	WITH CHECK (
		(
			role IN ('admin', 'agent', 'viewer')
			AND organization_id IN (SELECT private.user_org_ids('admin'))
		)
		OR (
			role = 'owner'
			AND organization_id IN (SELECT private.user_org_ids('owner'))
		)
	);

ALTER POLICY organization_members_delete_admin
	ON public.organization_members
	USING (
		(
			role <> 'owner'
			AND organization_id IN (SELECT private.user_org_ids('admin'))
		)
		OR (
			role = 'owner'
			AND organization_id IN (SELECT private.user_org_ids('owner'))
		)
	);

-- Ensure at least one owner remains unless the parent organization itself is being deleted
CREATE OR REPLACE FUNCTION private.prevent_removing_last_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
	v_org_exists boolean;
	v_has_other_owner boolean;
BEGIN
	IF OLD.role = 'owner' AND (TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND NEW.role <> 'owner')) THEN
		SELECT EXISTS (
			SELECT 1
			FROM public.organizations o
			WHERE o.id = OLD.organization_id
		) INTO v_org_exists;

		-- Allow ON DELETE CASCADE when deleting the organization itself
		IF NOT v_org_exists THEN
			IF TG_OP = 'DELETE' THEN
				RETURN OLD;
			END IF;
			RETURN NEW;
		END IF;

		SELECT EXISTS (
			SELECT 1
			FROM public.organization_members om
			WHERE om.organization_id = OLD.organization_id
			  AND om.role = 'owner'
			  AND om.user_id <> OLD.user_id
		) INTO v_has_other_owner;

		IF NOT v_has_other_owner THEN
			RAISE EXCEPTION 'El workspace debe conservar al menos un propietario (owner).'
				USING ERRCODE = 'check_violation';
		END IF;
	END IF;

	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.prevent_removing_last_owner() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER organization_members_keep_last_owner
	BEFORE UPDATE OR DELETE ON public.organization_members
	FOR EACH ROW
	EXECUTE FUNCTION private.prevent_removing_last_owner();
