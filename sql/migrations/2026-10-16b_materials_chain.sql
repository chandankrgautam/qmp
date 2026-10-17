-- 2026-10-16: the approval chain for materials (and the sheets for the
-- measurements, used from the next phase) after the work — user's decisions,
-- README §5.5 "Materials and measurements after the work".
-- Cut from sql/02_maintenance_schema.sql. Run as the superuser on ncl_maint:
--   psql -h localhost -U postgres -d ncl_maint -f sql/migrations/2026-10-16b_materials_chain.sql
BEGIN;
SET LOCAL search_path = maint, public;

CREATE TYPE sheet_kind  AS ENUM ('MATERIALS', 'MEASUREMENTS');
CREATE TYPE sheet_stage AS ENUM ('SUPERVISOR', 'OVERSEER', 'INCHARGE', 'STAFF_OFFICER', 'APPROVED');

CREATE TABLE job_sheet (
    ticket_id    uuid NOT NULL REFERENCES ticket(id),
    kind         sheet_kind NOT NULL,
    stage        sheet_stage NOT NULL DEFAULT 'SUPERVISOR',
    stage_since  timestamptz NOT NULL DEFAULT now(),   -- how long it has waited at this step
    approved_at  timestamptz NULL,
    approved_by  uuid NULL,
    area_id      uuid NOT NULL,
    scope_path   ltree NOT NULL,
    PRIMARY KEY (ticket_id, kind)
);
CREATE INDEX job_sheet_waiting ON job_sheet (stage, stage_since) WHERE stage <> 'APPROVED';

CREATE TABLE job_sheet_event (
    id           bigserial PRIMARY KEY,
    ticket_id    uuid NOT NULL,
    kind         sheet_kind NOT NULL,
    action       text NOT NULL CHECK (action IN ('SUBMIT','PASS','PASS_NO_CHANGE','RETURN','APPROVE','REOPEN')),
    from_stage   sheet_stage NOT NULL,
    to_stage     sheet_stage NOT NULL,
    actor_id     uuid NOT NULL,          -- the role assignment acted in
    actor_person uuid NULL,
    actor_role   text NOT NULL,
    remark       text NULL,
    via          text NULL DEFAULT nullif(current_setting('app.auth_method', true), ''),
    at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_sheet_event_ticket ON job_sheet_event (ticket_id, kind, id);

ALTER TABLE job_sheet       ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_sheet       FORCE ROW LEVEL SECURITY;
ALTER TABLE job_sheet_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_sheet_event FORCE ROW LEVEL SECURITY;

-- read with the job, by the officers and the contractor; never by an occupant
CREATE POLICY job_sheet_read ON job_sheet FOR SELECT USING (
    current_role_name() NOT IN ('RESIDENT','CUSTODIAN') AND ticket_is_visible(ticket_id));
CREATE POLICY job_sheet_move ON job_sheet FOR UPDATE
    USING (current_role_name() NOT IN ('RESIDENT','CUSTODIAN') AND ticket_is_visible(ticket_id));
CREATE POLICY job_sheet_event_read ON job_sheet_event FOR SELECT USING (
    current_role_name() NOT IN ('RESIDENT','CUSTODIAN') AND ticket_is_visible(ticket_id));
-- written only by the database's own triggers, which the guards below check
CREATE POLICY job_sheet_prepare ON job_sheet FOR INSERT WITH CHECK (true);
CREATE POLICY job_sheet_event_write ON job_sheet_event FOR INSERT WITH CHECK (true);

-- the step a job's materials sheet is at (looked past row security: the
-- materials rule needs it whoever is acting); NULL before the first assignment
CREATE OR REPLACE FUNCTION sheet_stage_of(t uuid, k sheet_kind) RETURNS sheet_stage AS $$
    SELECT stage FROM maint.job_sheet WHERE ticket_id = t AND kind = k;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = maint, public;

-- the same, waiting for a move in flight and reading the step it leaves behind:
-- a material line racing "Send for review" is refused, never slipped in
CREATE OR REPLACE FUNCTION sheet_stage_locked(t uuid, k sheet_kind) RETURNS sheet_stage AS $$
    SELECT stage FROM maint.job_sheet WHERE ticket_id = t AND kind = k FOR SHARE;
$$ LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = maint, public;

-- the action being taken and its remark come from the session, set by the API
CREATE OR REPLACE FUNCTION job_sheet_guard() RETURNS trigger AS $$
DECLARE
    role   text := current_role_name();
    action text := nullif(current_setting('app.sheet_action', true), '');
    remark text := job_card_reason();
    t      record;
    holder text;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'A sheet is never deleted' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF TG_OP = 'INSERT' THEN
        -- prepared by the database with the job card, at the supervisor's step
        IF coalesce(current_setting('app.jc_prepare', true), '') <> 'on' AND role IS DISTINCT FROM 'SYSTEM' THEN
            RAISE EXCEPTION 'A sheet is prepared by the database when the job is assigned' USING ERRCODE = 'insufficient_privilege';
        END IF;
        NEW.stage := 'SUPERVISOR'; NEW.stage_since := now(); NEW.approved_at := NULL; NEW.approved_by := NULL;
        RETURN NEW;
    END IF;
    IF (NEW.ticket_id, NEW.kind, NEW.area_id, NEW.scope_path) IS DISTINCT FROM (OLD.ticket_id, OLD.kind, OLD.area_id, OLD.scope_path) THEN
        RAISE EXCEPTION 'A sheet belongs to its job for ever' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.stage = OLD.stage THEN
        RAISE EXCEPTION 'Nothing to change' USING ERRCODE = 'check_violation';
    END IF;
    SELECT state, assigned_to INTO t FROM ticket WHERE id = NEW.ticket_id;
    holder := CASE OLD.stage WHEN 'SUPERVISOR' THEN 'CONTRACTOR_SUPERVISOR' WHEN 'OVERSEER' THEN 'CIVIL_OVERSEER'
                             WHEN 'INCHARGE' THEN 'MAINTENANCE_INCHARGE' ELSE 'STAFF_OFFICER_CIVIL' END;
    -- only the person at this step moves it: never out of turn
    IF role IS DISTINCT FROM holder OR (holder = 'CONTRACTOR_SUPERVISOR' AND t.assigned_to IS DISTINCT FROM current_actor()) THEN
        RAISE EXCEPTION 'This sheet is with the %, not you', lower(replace(holder, '_', ' '))
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF action = 'SUBMIT' AND OLD.stage = 'SUPERVISOR' AND NEW.stage = 'OVERSEER' THEN
        IF NEW.kind = 'MATERIALS' AND t.state NOT IN ('WORK_COMPLETED','INSPECTED_ACCEPTED','CLOSED') THEN
            RAISE EXCEPTION 'The materials are sent for review once the work is claimed complete' USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.kind = 'MEASUREMENTS' AND t.state NOT IN ('INSPECTED_ACCEPTED','CLOSED') THEN
            RAISE EXCEPTION 'The measurements are sent for review once the Overseer has accepted the work' USING ERRCODE = 'check_violation';
        END IF;
    ELSIF action IN ('PASS','PASS_NO_CHANGE') AND (OLD.stage, NEW.stage) IN (('OVERSEER','INCHARGE'), ('INCHARGE','STAFF_OFFICER')) THEN
        NULL;
    ELSIF action = 'RETURN' AND (OLD.stage, NEW.stage) IN (('OVERSEER','SUPERVISOR'), ('INCHARGE','OVERSEER'), ('STAFF_OFFICER','INCHARGE')) THEN
        IF remark IS NULL THEN RAISE EXCEPTION 'Say why it is sent back' USING ERRCODE = 'check_violation'; END IF;
    ELSIF action = 'APPROVE' AND OLD.stage = 'STAFF_OFFICER' AND NEW.stage = 'APPROVED' THEN
        NEW.approved_at := now(); NEW.approved_by := current_actor();
    ELSIF action = 'REOPEN' AND OLD.stage = 'APPROVED' AND NEW.stage = 'INCHARGE' THEN
        -- approved materials go back down until the MB is approved, their final lock
        IF NEW.kind <> 'MATERIALS' THEN
            RAISE EXCEPTION 'An approved MB is changed only by the Staff Officer''s recorded corrections' USING ERRCODE = 'check_violation';
        END IF;
        IF sheet_stage_of(NEW.ticket_id, 'MEASUREMENTS') = 'APPROVED' THEN
            RAISE EXCEPTION 'The MB is approved, which locks the materials too; correct a line with a reason instead' USING ERRCODE = 'check_violation';
        END IF;
        IF remark IS NULL THEN RAISE EXCEPTION 'Say why it is sent back' USING ERRCODE = 'check_violation'; END IF;
        NEW.approved_at := NULL; NEW.approved_by := NULL;
    ELSE
        RAISE EXCEPTION 'That move is not allowed from this step' USING ERRCODE = 'check_violation';
    END IF;
    NEW.stage_since := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER job_sheet_guard_trigger
    BEFORE INSERT OR UPDATE OR DELETE ON job_sheet
    FOR EACH ROW EXECUTE FUNCTION job_sheet_guard();

-- every move is written by the database, as the step it was
CREATE OR REPLACE FUNCTION job_sheet_record() RETURNS trigger AS $$
BEGIN
    PERFORM set_config('app.sheet_recording', 'on', true);
    INSERT INTO maint.job_sheet_event (ticket_id, kind, action, from_stage, to_stage, actor_id, actor_person, actor_role, remark)
    VALUES (NEW.ticket_id, NEW.kind, current_setting('app.sheet_action', true), OLD.stage, NEW.stage,
            current_actor(), current_person(), current_role_name(), maint.job_card_reason());
    PERFORM set_config('app.sheet_recording', '', true);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = maint, public;

CREATE TRIGGER job_sheet_record_trigger
    AFTER UPDATE ON job_sheet
    FOR EACH ROW EXECUTE FUNCTION job_sheet_record();

CREATE OR REPLACE FUNCTION job_sheet_event_frozen() RETURNS trigger AS $$
BEGIN
    -- a move is recorded by the database as it happens, never written by hand
    IF TG_OP = 'INSERT' THEN
        IF coalesce(current_setting('app.sheet_recording', true), '') <> 'on' THEN
            RAISE EXCEPTION 'The record of a sheet is written by the database' USING ERRCODE = 'insufficient_privilege';
        END IF;
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'The record of a sheet is never changed or deleted' USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER job_sheet_event_frozen_trigger
    BEFORE INSERT OR UPDATE OR DELETE ON job_sheet_event
    FOR EACH ROW EXECUTE FUNCTION job_sheet_event_frozen();

DROP POLICY IF EXISTS material_claim_insert ON material_claim;
DROP POLICY IF EXISTS material_claim_update ON material_claim;
CREATE POLICY material_claim_insert ON material_claim AS RESTRICTIVE FOR INSERT
    WITH CHECK (current_role_name() IN ('CONTRACTOR_SUPERVISOR','CIVIL_OVERSEER','MAINTENANCE_INCHARGE','STAFF_OFFICER_CIVIL'));
CREATE POLICY material_claim_update ON material_claim AS RESTRICTIVE FOR UPDATE
    USING (current_role_name() IN ('CONTRACTOR_SUPERVISOR','CIVIL_OVERSEER','MAINTENANCE_INCHARGE','STAFF_OFFICER_CIVIL'));

CREATE OR REPLACE FUNCTION material_claim_guard() RETURNS trigger AS $$
DECLARE
    t        record;
    role     text := current_role_name();
    verifying boolean;
    -- the step the job's materials sheet is at (the approval chain after the
    -- work, 2026-10-16); before it exists the job is at the supervisor's step
    -- read with a lock, so a line cannot slip in behind a hand-over in flight
    stage    sheet_stage := coalesce(sheet_stage_locked(NEW.ticket_id, 'MATERIALS'), 'SUPERVISOR');
    at_step  boolean := (role, stage) IN (('CIVIL_OVERSEER','OVERSEER'), ('MAINTENANCE_INCHARGE','INCHARGE'),
                                          ('STAFF_OFFICER_CIVIL','STAFF_OFFICER'), ('STAFF_OFFICER_CIVIL','APPROVED'));
BEGIN
    SELECT * INTO t FROM ticket_for_claim_locked(NEW.ticket_id);
    IF NOT FOUND THEN
        RAISE EXCEPTION 'no such complaint' USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF role = 'CONTRACTOR_SUPERVISOR' THEN
            -- the supervisor holding the job: while the work is under way, and
            -- after it until he sends the sheet for review (2026-10-16)
            IF t.assigned_to IS DISTINCT FROM current_actor() THEN
                RAISE EXCEPTION 'materials are claimed by the contractor''s supervisor the job is assigned to'
                    USING ERRCODE = 'insufficient_privilege';
            END IF;
            IF NOT (t.state IN ('IN_PROGRESS','REWORK')
                    OR (t.state IN ('WORK_COMPLETED','INSPECTED_ACCEPTED','CLOSED') AND stage = 'SUPERVISOR')) THEN
                RAISE EXCEPTION 'materials are recorded once the work has started, and after it until the sheet is sent for review'
                    USING ERRCODE = 'check_violation';
            END IF;
        ELSIF at_step THEN
            -- an officer adds a line the supervisor missed, at their own step;
            -- after approval only the Staff Officer, with a reason
            IF stage = 'APPROVED' AND job_card_reason() IS NULL THEN
                RAISE EXCEPTION 'give the reason for adding a line after approval' USING ERRCODE = 'check_violation';
            END IF;
        ELSE
            RAISE EXCEPTION 'materials are claimed by the contractor''s supervisor the job is assigned to, or added by the officer whose step the sheet is at'
                USING ERRCODE = 'insufficient_privilege';
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
        IF OLD.qty_verified IS NOT NULL OR NOT (t.state IN ('IN_PROGRESS','REWORK')
               OR (t.state IN ('WORK_COMPLETED','INSPECTED_ACCEPTED','CLOSED') AND stage = 'SUPERVISOR')) THEN
            RAISE EXCEPTION 'a line can be withdrawn only before it is verified, and before the sheet is sent for review'
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
    IF at_step THEN
        -- in the approval chain: the officer whose step it is changes a quantity,
        -- with a reason whenever it differs; after approval the Staff Officer
        -- alone, always with a reason (2026-10-16)
        IF job_card_reason() IS NULL AND (stage = 'APPROVED'
              OR NEW.qty_verified IS DISTINCT FROM coalesce(OLD.qty_verified, OLD.qty_claimed)) THEN
            RAISE EXCEPTION 'give the reason for the change' USING ERRCODE = 'check_violation';
        END IF;
    ELSE
        -- up to closure, as before: the Overseer or Incharge, after the claim
        IF role NOT IN ('CIVIL_OVERSEER','MAINTENANCE_INCHARGE') THEN
            RAISE EXCEPTION 'materials are verified by the Civil Overseer or the Civil Incharge, and in the chain by the officer whose step it is'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF stage <> 'SUPERVISOR' THEN
            RAISE EXCEPTION 'the materials sheet is with another step now; it reaches you in turn'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF t.state NOT IN ('WORK_COMPLETED','INSPECTED_ACCEPTED') THEN
            RAISE EXCEPTION 'after closure the materials reach you when the supervisor sends them for review'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    IF NEW.qty_verified IS NULL THEN
        RAISE EXCEPTION 'give the verified quantity (0 if none was used)' USING ERRCODE = 'check_violation';
    END IF;
    -- two keys: the person who claimed may not verify, whatever role they hold
    IF OLD.claimed_by_person = current_person() THEN
        RAISE EXCEPTION 'the person who claimed the materials cannot verify them'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT at_step AND OLD.qty_verified IS NOT NULL AND job_card_reason() IS NULL THEN
        RAISE EXCEPTION 'give the reason for changing a verified quantity' USING ERRCODE = 'check_violation';
    END IF;
    NEW.verified_by := current_actor();
    NEW.verified_by_person := current_person();
    NEW.verified_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION job_card_prepare() RETURNS trigger AS $$
DECLARE made integer;
BEGIN
    PERFORM set_config('app.jc_prepare', 'on', true);
    INSERT INTO maint.job_card (ticket_id, jc_no, area_id, scope_path)
    VALUES (NEW.id, 'JC/' || NEW.ticket_no, NEW.area_id, NEW.scope_path)
    ON CONFLICT (ticket_id) DO NOTHING;
    GET DIAGNOSTICS made = ROW_COUNT;
    -- and its two sheets for the approval chain after the work (2026-10-16)
    INSERT INTO maint.job_sheet (ticket_id, kind, area_id, scope_path)
    VALUES (NEW.id, 'MATERIALS', NEW.area_id, NEW.scope_path), (NEW.id, 'MEASUREMENTS', NEW.area_id, NEW.scope_path)
    ON CONFLICT (ticket_id, kind) DO NOTHING;
    PERFORM set_config('app.jc_prepare', '', true);
    IF made = 1 THEN
        INSERT INTO maint.audit_log (event_type, entity_type, entity_id, actor_id, actor_person_id,
                                     actor_role, area_id, after_value)
        VALUES ('JOB_CARD_PREPARED', 'job_card', NEW.id, current_actor(), current_person(),
                current_role_name(), NEW.area_id,
                jsonb_build_object('jc_no', 'JC/' || NEW.ticket_no, 'assigned_to', NEW.assigned_to));
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = maint, public;

GRANT SELECT, INSERT, UPDATE ON job_sheet, job_sheet_event TO app_maint, appconn;
GRANT USAGE, SELECT ON SEQUENCE job_sheet_event_id_seq TO app_maint, appconn;

-- every job already assigned gets its two sheets, at the supervisor's step
SELECT set_config('app.jc_prepare', 'on', true);
INSERT INTO job_sheet (ticket_id, kind, area_id, scope_path)
SELECT t.id, k.kind, t.area_id, t.scope_path
  FROM ticket t JOIN job_card j ON j.ticket_id = t.id
 CROSS JOIN (VALUES ('MATERIALS'::sheet_kind), ('MEASUREMENTS'::sheet_kind)) AS k(kind)
ON CONFLICT (ticket_id, kind) DO NOTHING;
SELECT set_config('app.jc_prepare', '', true);
COMMIT;
