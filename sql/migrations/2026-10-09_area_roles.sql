-- Migration 2026-10-09: a role below HQ is held in one Area (control 3).
-- Found on live data: the HQ portal administrator assigned an Incharge (and,
-- on 7 October, a contractor supervisor) with no Area chosen, and the role
-- took the administrator's own scope, all of NCL. Roles already held that
-- way are NOT changed here: revoke them in People and roles, with a reason,
-- and assign again in the right Area. Matches sql/01_identity_schema.sql
-- (enforce_assignment_authority).
--   psql -h localhost -U postgres -d ncl_identity -v ON_ERROR_STOP=1 -f <this file>

SET search_path TO identity, public;
CREATE OR REPLACE FUNCTION enforce_assignment_authority() RETURNS trigger AS $$
DECLARE
    actor      text    := current_setting('app.role', true);
    my_level   integer := current_level();
    new_level  integer;
BEGIN
    -- Every role below HQ is held in one Area (control 3), whoever writes
    -- it, the system included. Found 2026-10-09 on live data: a role assigned
    -- by the HQ portal administrator with no Area chosen took the
    -- administrator's own scope — an Incharge, and a supervisor, of every
    -- Area. Checked when a role is granted or its scope moves, so a wrong one
    -- already held can still be revoked.
    IF (TG_OP = 'INSERT' OR NEW.scope_path IS DISTINCT FROM OLD.scope_path)
       AND NOT (SELECT hq FROM role_level WHERE role = NEW.role)
       AND NOT EXISTS (SELECT 1 FROM area a WHERE NEW.scope_path <@ a.scope_path) THEN
        RAISE EXCEPTION 'a % role is held in one Area; choose the Area', NEW.role
            USING ERRCODE = 'check_violation';
    END IF;
    IF actor = 'SYSTEM' THEN
        RETURN NEW;
    END IF;
    SELECT level INTO new_level FROM role_level WHERE role = NEW.role;

    IF TG_OP = 'UPDATE' THEN
        IF NEW.role IS DISTINCT FROM OLD.role OR NEW.person_id IS DISTINCT FROM OLD.person_id THEN
            RAISE EXCEPTION 'an assignment''s role and person are fixed; revoke it and assign anew'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
    END IF;

    -- a registration a person submits for themselves: pending, occupant only
    IF TG_OP = 'INSERT' AND NEW.status = 'PENDING' AND actor = 'AUTH' THEN
        IF NEW.role NOT IN ('RESIDENT','CUSTODIAN') THEN
            RAISE EXCEPTION 'only a resident or custodian role can be requested at registration'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.person_id = current_person() THEN
        RAISE EXCEPTION 'nobody may grant, approve or change a role of their own'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- The Incharge verifies occupant registrations within the colony
    -- scope, and — decision 2026-09-30 — creates, changes and ends the
    -- contractor's supervisors on the work orders they keep. That role
    -- only, in their own Area, and always on a work order: a supervisor on
    -- no contract would do work that counts against nobody.
    IF actor = 'MAINTENANCE_INCHARGE' THEN
        IF NEW.role IN ('RESIDENT','CUSTODIAN') AND TG_OP = 'UPDATE' THEN
            RETURN NEW;
        END IF;
        IF NEW.role = 'CONTRACTOR_SUPERVISOR' AND NEW.contract_id IS NOT NULL
           AND NEW.scope_path <@ current_scope() THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'the Incharge approves residents and custodians and appoints contractor supervisors on the Area''s work orders; other roles are assigned by the Area administrators'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF NOT is_area_admin() THEN
        RAISE EXCEPTION 'only an Area administrator assigns roles'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- below their own rank for every change, not only a new grant: an
    -- Area administrator may not extend or revoke a colleague of equal rank
    IF new_level >= my_level THEN
        RAISE EXCEPTION 'a % may assign or change only roles below their own', actor
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF actor <> 'ADMINISTRATOR' AND NOT (NEW.scope_path <@ current_scope()) THEN
        RAISE EXCEPTION 'an Area administrator assigns roles within their own Area only'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
