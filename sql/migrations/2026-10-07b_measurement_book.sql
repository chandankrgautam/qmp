-- Migration 2026-10-07 (b): measurement book — measurements of job-card
-- items, MB references, the Staff Officer's check-measurement.
--
-- Brings a database at commit fb78101 up to this change, keeping its data.
-- The section below is cut from sql/02_maintenance_schema.sql itself (by
-- build script), so a fresh build and a migrated database end up the same;
-- compare with pg_dump --schema-only after running it. Run as the owner:
--   psql -h localhost -U postgres -d ncl_maint -v ON_ERROR_STOP=1 -f <this file>

SET search_path TO maint, public;
BEGIN;

-- =====================================================================
-- MEASUREMENT BOOK (phase 5, decision 2026-09-30) — quantities only
--
-- Civil measures each job-card work item once the work is accepted; the
-- entries are laid out as MB entries for a contract and period, written
-- into the department's Measurement Book (number and page recorded, after
-- which the entry is frozen), and check-measured by the Area Civil Staff
-- Officer. The bill stays with the department: no rate, price or amount
-- exists here (control 9).
-- =====================================================================

INSERT INTO maint_config (key, value, data_type, description) VALUES
 ('check_measure_target_percent','10','integer',
  'Share of measurement entries the Area Civil Staff Officer aims to check-measure'),
 ('check_measure_tolerance_percent','5','integer',
  'Difference between measured and check-measured quantity beyond which an entry is flagged')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE measurement (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id           uuid NOT NULL REFERENCES job_card(ticket_id),
    item_id             uuid NOT NULL UNIQUE REFERENCES job_card_item(id),
    nos                 numeric(12,3) NULL CHECK (nos > 0),
    length              numeric(12,3) NULL CHECK (length > 0),
    breadth             numeric(12,3) NULL CHECK (breadth > 0),
    depth               numeric(12,3) NULL CHECK (depth > 0),
    qty                 numeric(12,3) NOT NULL CHECK (qty >= 0),
    remark              text NULL,
    measured_by         uuid NULL,              -- role assignment
    measured_by_person  uuid NULL,
    measured_at         timestamptz NOT NULL DEFAULT now(),
    -- written into the department's Measurement Book: frozen from then on
    mb_no               text NULL,
    mb_page             text NULL,
    mb_recorded_at      timestamptz NULL,
    mb_recorded_by      uuid NULL,
    -- the Area Civil Staff Officer's check-measurement
    check_qty           numeric(12,3) NULL CHECK (check_qty >= 0),
    check_remark        text NULL,
    checked_by          uuid NULL,
    checked_by_person   uuid NULL,
    checked_at          timestamptz NULL,
    -- copied from the complaint when measured: reports and row security
    contract_id         uuid NULL,
    premises_id         uuid NOT NULL,
    area_id             uuid NOT NULL,
    scope_path          ltree NOT NULL,
    CONSTRAINT mb_reference_whole CHECK (
        (mb_no IS NULL) = (mb_page IS NULL) AND (mb_no IS NULL) = (mb_recorded_at IS NULL)
        AND (mb_no IS NULL OR (length(btrim(mb_no)) > 0 AND length(btrim(mb_page)) > 0)))
);
CREATE INDEX measurement_ticket ON measurement (ticket_id);
CREATE INDEX measurement_report ON measurement (contract_id, measured_at);

-- a work item as the measurement rules need it, whoever asks
CREATE OR REPLACE FUNCTION job_item_of(p uuid) RETURNS TABLE (ticket_id uuid, withdrawn boolean) AS $$
    SELECT ticket_id, withdrawn_at IS NOT NULL FROM maint.job_card_item WHERE id = p;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = maint, public;

CREATE OR REPLACE FUNCTION measurement_guard() RETURNS trigger AS $$
DECLARE
    t        record;
    it       record;
    role     text := current_role_name();
    measuring boolean; recording boolean; checking boolean;
BEGIN
    SELECT * INTO t FROM ticket_for_claim(NEW.ticket_id);
    IF NOT FOUND THEN
        RAISE EXCEPTION 'no such complaint' USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF (NEW.ticket_id, NEW.item_id, NEW.measured_by, NEW.measured_by_person, NEW.measured_at,
            NEW.contract_id, NEW.premises_id, NEW.area_id, NEW.scope_path)
           IS DISTINCT FROM
           (OLD.ticket_id, OLD.item_id, OLD.measured_by, OLD.measured_by_person, OLD.measured_at,
            OLD.contract_id, OLD.premises_id, OLD.area_id, OLD.scope_path) THEN
            RAISE EXCEPTION 'what was measured, by whom and when is fixed'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
        measuring := (NEW.nos, NEW.length, NEW.breadth, NEW.depth, NEW.qty, NEW.remark)
                     IS DISTINCT FROM (OLD.nos, OLD.length, OLD.breadth, OLD.depth, OLD.qty, OLD.remark);
        recording := (NEW.mb_no, NEW.mb_page, NEW.mb_recorded_at, NEW.mb_recorded_by)
                     IS DISTINCT FROM (OLD.mb_no, OLD.mb_page, OLD.mb_recorded_at, OLD.mb_recorded_by);
        checking  := (NEW.check_qty, NEW.check_remark, NEW.checked_at, NEW.checked_by, NEW.checked_by_person)
                     IS DISTINCT FROM (OLD.check_qty, OLD.check_remark, OLD.checked_at, OLD.checked_by, OLD.checked_by_person);
        IF (measuring::int + recording::int + checking::int) = 0 THEN
            RAISE EXCEPTION 'nothing to change on the measurement' USING ERRCODE = 'check_violation';
        END IF;
        IF (measuring::int + recording::int + checking::int) > 1 THEN
            RAISE EXCEPTION 'measure, record in the MB and check-measure are separate acts'
                USING ERRCODE = 'check_violation';
        END IF;
    ELSE
        measuring := true; recording := false; checking := false;
    END IF;

    IF measuring THEN
        IF role NOT IN ('CIVIL_OVERSEER','MAINTENANCE_INCHARGE') THEN
            RAISE EXCEPTION 'measurements are taken by the Civil Overseer or the Civil Incharge'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF t.state NOT IN ('INSPECTED_ACCEPTED','CLOSED') THEN
            RAISE EXCEPTION 'work is measured once it has been inspected and accepted'
                USING ERRCODE = 'check_violation';
        END IF;
        IF TG_OP = 'INSERT' THEN
            SELECT * INTO it FROM job_item_of(NEW.item_id);
            IF NOT FOUND OR it.ticket_id IS DISTINCT FROM NEW.ticket_id THEN
                RAISE EXCEPTION 'that work item is not on this complaint''s job card'
                    USING ERRCODE = 'check_violation';
            END IF;
            IF it.withdrawn THEN
                RAISE EXCEPTION 'a withdrawn work item is not measured' USING ERRCODE = 'check_violation';
            END IF;
            NEW.measured_by := current_actor();
            NEW.measured_by_person := current_person();
            NEW.measured_at := now();
            NEW.contract_id := t.contract_id;
            NEW.premises_id := t.premises_id;
            NEW.area_id := t.area_id;
            NEW.scope_path := t.scope_path;
            NEW.mb_no := NULL; NEW.mb_page := NULL; NEW.mb_recorded_at := NULL; NEW.mb_recorded_by := NULL;
            NEW.check_qty := NULL; NEW.check_remark := NULL; NEW.checked_at := NULL;
            NEW.checked_by := NULL; NEW.checked_by_person := NULL;
        ELSE
            IF OLD.mb_no IS NOT NULL THEN
                RAISE EXCEPTION 'this entry is written in MB % page %; it cannot be changed', OLD.mb_no, OLD.mb_page
                    USING ERRCODE = 'check_violation';
            END IF;
            IF job_card_reason() IS NULL THEN
                RAISE EXCEPTION 'give the reason for measuring again' USING ERRCODE = 'check_violation';
            END IF;
        END IF;
        -- the quantity follows the dimensions whenever there are any
        IF NEW.length IS NOT NULL OR NEW.breadth IS NOT NULL OR NEW.depth IS NOT NULL THEN
            NEW.qty := round(coalesce(NEW.nos, 1) * coalesce(NEW.length, 1)
                           * coalesce(NEW.breadth, 1) * coalesce(NEW.depth, 1), 3);
        ELSIF NEW.qty IS NULL AND NEW.nos IS NOT NULL THEN
            NEW.qty := NEW.nos;
        END IF;
        IF NEW.qty IS NULL THEN
            RAISE EXCEPTION 'give the quantity, or the number and dimensions' USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF recording THEN
        IF role NOT IN ('CIVIL_OVERSEER','MAINTENANCE_INCHARGE') THEN
            RAISE EXCEPTION 'entries are written into the MB by the Civil Overseer or the Civil Incharge'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF OLD.mb_no IS NOT NULL THEN
            RAISE EXCEPTION 'this entry is already written in MB % page %', OLD.mb_no, OLD.mb_page
                USING ERRCODE = 'unique_violation';
        END IF;
        IF coalesce(btrim(NEW.mb_no), '') = '' OR coalesce(btrim(NEW.mb_page), '') = '' THEN
            RAISE EXCEPTION 'give the MB number and page' USING ERRCODE = 'check_violation';
        END IF;
        NEW.mb_no := btrim(NEW.mb_no);
        NEW.mb_page := btrim(NEW.mb_page);
        NEW.mb_recorded_at := now();
        NEW.mb_recorded_by := current_actor();
        RETURN NEW;
    END IF;

    -- check-measurement
    IF role IS DISTINCT FROM 'STAFF_OFFICER_CIVIL' THEN
        RAISE EXCEPTION 'check-measurement is done by the Area Civil Staff Officer'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.check_qty IS NULL THEN
        RAISE EXCEPTION 'give the check-measured quantity (0 if none)' USING ERRCODE = 'check_violation';
    END IF;
    -- two keys: whoever measured may not check it, whatever role they hold
    IF OLD.measured_by_person = current_person() THEN
        RAISE EXCEPTION 'the person who measured an entry cannot check-measure it'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.check_qty IS NOT NULL AND job_card_reason() IS NULL THEN
        RAISE EXCEPTION 'give the reason for revising a check-measurement' USING ERRCODE = 'check_violation';
    END IF;
    NEW.checked_by := current_actor();
    NEW.checked_by_person := current_person();
    NEW.checked_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER measurement_guard_trigger
    BEFORE INSERT OR UPDATE ON measurement
    FOR EACH ROW EXECUTE FUNCTION measurement_guard();

CREATE OR REPLACE FUNCTION measurement_audit() RETURNS trigger AS $$
DECLARE ev text; b jsonb := NULL; a jsonb; i record;
BEGIN
    SELECT seq, description, unit INTO i FROM job_card_item WHERE id = NEW.item_id;
    a := jsonb_build_object('item', i.seq, 'description', i.description, 'unit', i.unit,
                            'nos', NEW.nos, 'length', NEW.length, 'breadth', NEW.breadth,
                            'depth', NEW.depth, 'qty', NEW.qty, 'remark', NEW.remark);
    IF TG_OP = 'INSERT' THEN
        ev := 'MEASURED';
    ELSIF NEW.mb_no IS DISTINCT FROM OLD.mb_no THEN
        ev := 'MB_RECORDED';
        a := a || jsonb_build_object('mb_no', NEW.mb_no, 'mb_page', NEW.mb_page);
    ELSIF NEW.checked_at IS DISTINCT FROM OLD.checked_at THEN
        ev := CASE WHEN OLD.check_qty IS NULL THEN 'CHECK_MEASURED' ELSE 'CHECK_REVISED' END;
        IF OLD.check_qty IS NOT NULL THEN
            b := jsonb_build_object('check_qty', OLD.check_qty, 'check_remark', OLD.check_remark);
        END IF;
        a := a || jsonb_build_object('check_qty', NEW.check_qty, 'check_remark', NEW.check_remark);
    ELSE
        ev := 'REMEASURED';
        b := jsonb_build_object('nos', OLD.nos, 'length', OLD.length, 'breadth', OLD.breadth,
                                'depth', OLD.depth, 'qty', OLD.qty, 'remark', OLD.remark);
    END IF;
    INSERT INTO audit_log (event_type, entity_type, entity_id, actor_id, actor_person_id, actor_role,
                           area_id, before_value, after_value, reason)
    VALUES (ev, 'measurement', NEW.ticket_id, current_actor(), current_person(), current_role_name(),
            NEW.area_id, b, a, job_card_reason());
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER measurement_audit_trigger
    AFTER INSERT OR UPDATE ON measurement
    FOR EACH ROW EXECUTE FUNCTION measurement_audit();

CREATE TRIGGER measurement_no_delete
    BEFORE DELETE ON measurement
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Departmental officers in their scope; the contractor on complaints it can
-- see (the API leaves out the check-measurement for them); never occupants.
ALTER TABLE measurement ENABLE ROW LEVEL SECURITY;
ALTER TABLE measurement FORCE ROW LEVEL SECURITY;
CREATE POLICY measurement_read ON measurement USING (
    current_role_name() = 'SYSTEM'
    OR (current_role_name() IN ('CIVIL_OVERSEER','MAINTENANCE_INCHARGE','STAFF_OFFICER_CIVIL',
                                'GM_CIVIL','HQ_EXECUTIVE','ADMINISTRATOR')
        AND scope_path <@ current_scope())
    OR (current_role_name() IN ('CONTRACTOR','CONTRACTOR_SUPERVISOR')
        AND EXISTS (SELECT 1 FROM ticket t WHERE t.id = measurement.ticket_id)));
CREATE POLICY measurement_insert ON measurement AS RESTRICTIVE FOR INSERT
    WITH CHECK (current_role_name() IN ('CIVIL_OVERSEER','MAINTENANCE_INCHARGE'));
CREATE POLICY measurement_update ON measurement AS RESTRICTIVE FOR UPDATE
    USING (current_role_name() IN ('CIVIL_OVERSEER','MAINTENANCE_INCHARGE','STAFF_OFFICER_CIVIL'));

GRANT SELECT, INSERT, UPDATE ON measurement TO app_maint;
GRANT SELECT, INSERT, UPDATE ON measurement TO appconn;

COMMIT;
