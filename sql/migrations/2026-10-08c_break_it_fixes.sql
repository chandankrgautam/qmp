-- Migration 2026-10-08 (c): the break-it pass — holes closed.
--
--  * pauses and breaches: who paused, resumed and attributed is the
--    session, only departmental officers, never deleted; attribution logged
--    by the database (a contractor's session could forge both);
--  * the time and author of a step change only with that step (a second,
--    racing completion claim rewrote completed_claim_at);
--  * a material claim waits for a completion in flight.
-- Every statement is cut from sql/02_maintenance_schema.sql (by script), so
-- a fresh build and a migrated database end up the same. Run as the owner:
--   psql -h localhost -U postgres -d ncl_maint -v ON_ERROR_STOP=1 -f <this file>

SET search_path TO maint, public;
BEGIN;

CREATE OR REPLACE FUNCTION enforce_field_authority() RETURNS trigger AS $$
DECLARE
    actor text;
    o jsonb := to_jsonb(OLD);
    n jsonb := to_jsonb(NEW);
    r record;
BEGIN
    actor := current_setting('app.role', true);
    IF actor = 'SYSTEM' THEN
        RETURN NEW;                -- SLA engine, escalation job, migrations
    END IF;
    -- Changes made from inside another trigger are the database's own
    -- bookkeeping (SLA snapshot, counters), not a caller's write. Depth is
    -- 1 for a plain statement and higher when a trigger drove the update.
    IF pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;
    IF actor IS NULL THEN
        RAISE EXCEPTION 'app.role is not set; refusing ticket update'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    FOR r IN SELECT column_name, allowed_roles FROM ticket_field_authority LOOP
        IF o -> r.column_name IS DISTINCT FROM n -> r.column_name
           AND NOT (actor = ANY (r.allowed_roles)) THEN
            RAISE EXCEPTION 'role % may not change %', actor, r.column_name
                USING ERRCODE = 'insufficient_privilege';
        END IF;
    END LOOP;
    -- The time and author of a step are written by that step, and only by
    -- it. A same-state update is not a transition (enforce_transition lets
    -- it pass), so without this a second "claim" on a claimed job rewrote
    -- completed_claim_at — found racing two claims (break-it pass,
    -- 2026-10-08). Reassignment (assigned_*) is the one same-state step.
    IF NEW.state IS NOT DISTINCT FROM OLD.state THEN
        FOR r IN SELECT unnest(ARRAY['verified_by','verified_at','started_at','workmen_assigned',
                                     'completed_claim_at','inspected_by','inspected_at','closed_at']) AS column_name LOOP
            IF o -> r.column_name IS DISTINCT FROM n -> r.column_name THEN
                RAISE EXCEPTION '% is written only by the step it records; the complaint is already %', r.column_name, OLD.state
                    USING ERRCODE = 'check_violation';
            END IF;
        END LOOP;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- The same, waiting for any change to the complaint in flight and reading
-- its latest state: a material claimed at the same moment as the completion
-- claim must not slip in behind it (break-it pass, 2026-10-08).
CREATE OR REPLACE FUNCTION ticket_for_claim_locked(p uuid)
RETURNS TABLE (state ticket_state, assigned_to uuid, contract_id uuid, premises_id uuid,
               area_id uuid, scope_path ltree) AS $$
    SELECT state, assigned_to, contract_id, premises_id, area_id, scope_path FROM maint.ticket WHERE id = p FOR SHARE;
$$ LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = maint, public;

CREATE OR REPLACE FUNCTION material_claim_guard() RETURNS trigger AS $$
DECLARE
    t        record;
    role     text := current_role_name();
    verifying boolean;
BEGIN
    SELECT * INTO t FROM ticket_for_claim_locked(NEW.ticket_id);
    IF NOT FOUND THEN
        RAISE EXCEPTION 'no such complaint' USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF TG_OP = 'INSERT' THEN
        -- only the supervisor holding the job, while it is in their hands
        IF role IS DISTINCT FROM 'CONTRACTOR_SUPERVISOR' OR t.assigned_to IS DISTINCT FROM current_actor() THEN
            RAISE EXCEPTION 'materials are claimed by the contractor''s supervisor the job is assigned to'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF t.state NOT IN ('IN_PROGRESS','REWORK') THEN
            RAISE EXCEPTION 'materials are recorded while the work is under way: start the work first, and nothing can be added after the completion claim'
                USING ERRCODE = 'check_violation';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM material m WHERE m.id = NEW.material_id AND m.active) THEN
            RAISE EXCEPTION 'that material is not in use' USING ERRCODE = 'check_violation';
        END IF;
        NEW.seq := coalesce((SELECT max(seq) FROM material_claim WHERE ticket_id = NEW.ticket_id), 0) + 1;
        NEW.claimed_by := current_actor();
        NEW.claimed_by_person := current_person();
        NEW.claimed_at := now();
        NEW.contract_id := t.contract_id;
        NEW.premises_id := t.premises_id;
        NEW.area_id := t.area_id;
        NEW.scope_path := t.scope_path;
        NEW.withdrawn_at := NULL; NEW.withdrawal_reason := NULL;
        NEW.qty_verified := NULL; NEW.verified_by := NULL; NEW.verified_by_person := NULL;
        NEW.verified_at := NULL; NEW.verification_remark := NULL;
        RETURN NEW;
    END IF;

    -- what was claimed is fixed for ever
    IF (NEW.ticket_id, NEW.seq, NEW.material_id, NEW.qty_claimed, NEW.claimed_by, NEW.claimed_by_person,
        NEW.claimed_at, NEW.contract_id, NEW.premises_id, NEW.area_id, NEW.scope_path)
       IS DISTINCT FROM
       (OLD.ticket_id, OLD.seq, OLD.material_id, OLD.qty_claimed, OLD.claimed_by, OLD.claimed_by_person,
        OLD.claimed_at, OLD.contract_id, OLD.premises_id, OLD.area_id, OLD.scope_path) THEN
        RAISE EXCEPTION 'a claim line cannot be changed; withdraw it and claim again'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.withdrawn_at IS NOT NULL THEN
        RAISE EXCEPTION 'a withdrawn line stays as it was withdrawn' USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.withdrawal_reason IS NOT NULL THEN
        -- withdrawal: the supervisor who claimed it, still holding the job, before verification
        IF role IS DISTINCT FROM 'CONTRACTOR_SUPERVISOR' OR OLD.claimed_by IS DISTINCT FROM current_actor()
           OR t.assigned_to IS DISTINCT FROM current_actor() THEN
            RAISE EXCEPTION 'only the supervisor who claimed a line may withdraw it'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF t.state NOT IN ('IN_PROGRESS','REWORK') OR OLD.qty_verified IS NOT NULL THEN
            RAISE EXCEPTION 'a line can be withdrawn only while the work is under way and before it is verified'
                USING ERRCODE = 'check_violation';
        END IF;
        NEW.withdrawn_at := now();
        RETURN NEW;
    END IF;

    -- a verification is an act even when the figures stand: a second
    -- officer confirming a count is recorded as such
    verifying := (NEW.qty_verified, NEW.verification_remark, NEW.verified_at)
                 IS DISTINCT FROM (OLD.qty_verified, OLD.verification_remark, OLD.verified_at);
    IF NOT verifying THEN
        RAISE EXCEPTION 'nothing to change on a claim line' USING ERRCODE = 'check_violation';
    END IF;
    IF role NOT IN ('CIVIL_OVERSEER','MAINTENANCE_INCHARGE') THEN
        RAISE EXCEPTION 'materials are verified by the Civil Overseer or the Civil Incharge'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF t.state NOT IN ('WORK_COMPLETED','INSPECTED_ACCEPTED') THEN
        RAISE EXCEPTION 'materials are verified after the completion claim and before the complaint is closed'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.qty_verified IS NULL THEN
        RAISE EXCEPTION 'give the verified quantity (0 if none was used)' USING ERRCODE = 'check_violation';
    END IF;
    -- two keys: the person who claimed may not verify, whatever role they hold
    IF OLD.claimed_by_person = current_person() THEN
        RAISE EXCEPTION 'the person who claimed the materials cannot verify them'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.qty_verified IS NOT NULL AND job_card_reason() IS NULL THEN
        RAISE EXCEPTION 'give the reason for changing a verified quantity' USING ERRCODE = 'check_violation';
    END IF;
    NEW.verified_by := current_actor();
    NEW.verified_by_person := current_person();
    NEW.verified_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- PAUSES AND BREACHES: WHO MAY RECORD THEM (break-it pass, 2026-10-08)
--
-- The pause table's only defence was a CHECK on paused_by_role — a value
-- the writer supplies. A contractor's session wrote a pause naming itself
-- "CIVIL_OVERSEER" and the check passed; it could also end the
-- department's pause early. The breach table had no write guard at all:
-- the contractor's session rewrote whose delay a breach was (open defect
-- 1, checked only by the API until now). Both are now the database's:
-- who paused, who resumed and who attributed are taken from the session,
-- never from the row, and only a departmental officer may do any of it.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sla_pause_guard() RETURNS trigger AS $$
DECLARE role text := current_setting('app.role', true);
BEGIN
    IF role = 'SYSTEM' THEN RETURN NEW; END IF;
    IF role IS NULL OR role NOT IN ('CIVIL_OVERSEER','MAINTENANCE_INCHARGE','STAFF_OFFICER_CIVIL') THEN
        RAISE EXCEPTION 'only a departmental officer records or ends a pause of the SLA clock'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF TG_OP = 'INSERT' THEN
        -- who paused is the session, whatever the row says
        NEW.paused_by := nullif(current_setting('app.actor_id', true), '')::uuid;
        NEW.paused_by_role := role;
        NEW.paused_at := now();
        NEW.resumed_at := NULL; NEW.resumed_by := NULL;
        IF NEW.paused_by IS NULL THEN
            RAISE EXCEPTION 'a pause is recorded by a named officer' USING ERRCODE = 'insufficient_privilege';
        END IF;
        RETURN NEW;
    END IF;
    IF (NEW.id, NEW.ticket_id, NEW.clock, NEW.attribution, NEW.reason, NEW.paused_at, NEW.paused_by, NEW.paused_by_role)
       IS DISTINCT FROM
       (OLD.id, OLD.ticket_id, OLD.clock, OLD.attribution, OLD.reason, OLD.paused_at, OLD.paused_by, OLD.paused_by_role) THEN
        RAISE EXCEPTION 'a recorded pause cannot be changed; only ended' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.resumed_at IS NOT NULL THEN
        RAISE EXCEPTION 'this pause has already ended' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.resumed_at IS NOT NULL THEN
        NEW.resumed_at := now();          -- the clock restarts now, not at a chosen time
        NEW.resumed_by := nullif(current_setting('app.actor_id', true), '')::uuid;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sla_pause_guard_trigger
    BEFORE INSERT OR UPDATE ON sla_pause
    FOR EACH ROW EXECUTE FUNCTION sla_pause_guard();
CREATE TRIGGER sla_pause_no_delete
    BEFORE DELETE ON sla_pause
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE OR REPLACE FUNCTION sla_breach_guard() RETURNS trigger AS $$
DECLARE role text := current_setting('app.role', true);
BEGIN
    IF role = 'SYSTEM' THEN RETURN NEW; END IF;
    IF TG_OP = 'INSERT' THEN
        RAISE EXCEPTION 'a breach is recorded by the SLA sweep, not by a person'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- the contractor is the party this decides against, so they do not
    -- get to make it; neither does the resident
    IF role IS NULL OR role NOT IN ('CIVIL_OVERSEER','MAINTENANCE_INCHARGE','STAFF_OFFICER_CIVIL','ADMINISTRATOR') THEN
        RAISE EXCEPTION 'only a departmental officer attributes a delay'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF (NEW.id, NEW.ticket_id, NEW.clock, NEW.breached_at) IS DISTINCT FROM (OLD.id, OLD.ticket_id, OLD.clock, OLD.breached_at) THEN
        RAISE EXCEPTION 'a recorded breach cannot be changed; only attributed' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.attribution IS NULL THEN
        RAISE EXCEPTION 'give the attribution' USING ERRCODE = 'check_violation';
    END IF;
    NEW.attributed_by := nullif(current_setting('app.actor_id', true), '')::uuid;
    NEW.attributed_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sla_breach_guard_trigger
    BEFORE INSERT OR UPDATE ON sla_breach
    FOR EACH ROW EXECUTE FUNCTION sla_breach_guard();
CREATE TRIGGER sla_breach_no_delete
    BEFORE DELETE ON sla_breach
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- every attribution is logged by the database, whatever route made it
CREATE OR REPLACE FUNCTION sla_breach_audit() RETURNS trigger AS $$
BEGIN
    IF NEW.attribution IS DISTINCT FROM OLD.attribution OR NEW.note IS DISTINCT FROM OLD.note THEN
        INSERT INTO audit_log (event_type, entity_type, entity_id, actor_id, actor_person_id, actor_role,
                               before_value, after_value, reason)
        VALUES ('DELAY_ATTRIBUTED', 'sla_breach', NEW.id, current_actor(), current_person(), current_role_name(),
                jsonb_build_object('attribution', OLD.attribution), jsonb_build_object('attribution', NEW.attribution),
                NEW.note);
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sla_breach_audit_trigger
    AFTER UPDATE ON sla_breach
    FOR EACH ROW EXECUTE FUNCTION sla_breach_audit();



COMMIT;
