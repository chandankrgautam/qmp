-- 2026-10-16: the supervisor's job card and measurement sheet, the
-- measurement chain and the MB reference record — user's decisions, README
-- §5.5 "Materials and measurements after the work" (phases 3 and 4).
-- Cut from sql/02_maintenance_schema.sql. Run as the superuser on ncl_maint:
--   psql -h localhost -U postgres -d ncl_maint -f sql/migrations/2026-10-16c_measurement_chain_mb.sql
BEGIN;
SET LOCAL search_path = maint, public;
-- who changes a job card, and when
CREATE OR REPLACE FUNCTION job_card_editor_check(p_ticket uuid) RETURNS void AS $$
DECLARE
    role  text := current_role_name();
    st    ticket_state := ticket_state_of(p_ticket);
    stage sheet_stage := coalesce(sheet_stage_of(p_ticket, 'MEASUREMENTS'), 'SUPERVISOR');
BEGIN
    IF st = 'REJECTED' THEN
        RAISE EXCEPTION 'the complaint was rejected; its job card is part of the record' USING ERRCODE = 'check_violation';
    END IF;
    IF stage = 'APPROVED' THEN
        IF role IS DISTINCT FROM 'STAFF_OFFICER_CIVIL' THEN
            RAISE EXCEPTION 'the MB is approved: only the Area Civil Staff Officer corrects the job card now' USING ERRCODE = 'check_violation';
        END IF;
        IF job_card_reason() IS NULL THEN
            RAISE EXCEPTION 'give the reason for correcting the job card after the MB approval' USING ERRCODE = 'check_violation';
        END IF;
        RETURN;
    END IF;
    IF stage = 'SUPERVISOR' THEN
        IF role = 'CONTRACTOR_SUPERVISOR' THEN
            IF (SELECT assigned_to FROM ticket WHERE id = p_ticket) IS DISTINCT FROM current_actor() THEN
                RAISE EXCEPTION 'only the supervisor the job is assigned to changes its job card' USING ERRCODE = 'insufficient_privilege';
            END IF;
            RETURN;
        END IF;
        IF role IN ('CIVIL_OVERSEER','MAINTENANCE_INCHARGE') THEN
            IF st = 'CLOSED' THEN
                RAISE EXCEPTION 'after closure the job card reaches you with the measurements, when the supervisor sends them for review'
                    USING ERRCODE = 'check_violation';
            END IF;
            RETURN;
        END IF;
    ELSIF (role, stage) IN (('CIVIL_OVERSEER','OVERSEER'), ('MAINTENANCE_INCHARGE','INCHARGE'), ('STAFF_OFFICER_CIVIL','STAFF_OFFICER')) THEN
        RETURN;
    END IF;
    RAISE EXCEPTION 'the job card is with another step of the chain now' USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
DROP POLICY job_card_read ON job_card;
DROP POLICY job_card_write ON job_card;
DROP POLICY job_card_item_write ON job_card_item;
DROP POLICY job_card_item_insert ON job_card_item;
CREATE POLICY job_card_read ON job_card USING (
    current_role_name() = 'SYSTEM'
    OR (current_role_name() IN ('CIVIL_OVERSEER','MAINTENANCE_INCHARGE','STAFF_OFFICER_CIVIL',
                                'GM_CIVIL','HQ_EXECUTIVE','ADMINISTRATOR')
        AND scope_path <@ current_scope())
    -- the supervisor the job is assigned to reads the whole card (2026-10-16)
    OR (current_role_name() = 'CONTRACTOR_SUPERVISOR' AND EXISTS (SELECT 1 FROM ticket t WHERE t.id = job_card.ticket_id)));
CREATE POLICY job_card_write ON job_card AS RESTRICTIVE FOR UPDATE
    USING (current_role_name() IN ('CIVIL_OVERSEER','MAINTENANCE_INCHARGE','CONTRACTOR_SUPERVISOR','STAFF_OFFICER_CIVIL'));
CREATE POLICY job_card_item_write ON job_card_item AS RESTRICTIVE FOR UPDATE
    USING (current_role_name() IN ('CIVIL_OVERSEER','MAINTENANCE_INCHARGE','CONTRACTOR_SUPERVISOR','STAFF_OFFICER_CIVIL'));
CREATE POLICY job_card_item_insert ON job_card_item AS RESTRICTIVE FOR INSERT
    WITH CHECK (current_role_name() IN ('CIVIL_OVERSEER','MAINTENANCE_INCHARGE','CONTRACTOR_SUPERVISOR','STAFF_OFFICER_CIVIL'));

-- who measures, and when
CREATE OR REPLACE FUNCTION measurement_guard() RETURNS trigger AS $$
DECLARE
    t        record;
    it       record;
    role     text := current_role_name();
    measuring boolean; recording boolean; checking boolean;
    -- the job's measurement sheet: the supervisor's own until he sends it up,
    -- then each officer at their step; after approval the Staff Officer alone
    stage    sheet_stage := coalesce(sheet_stage_locked(NEW.ticket_id, 'MEASUREMENTS'), 'SUPERVISOR');
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
        IF role = 'CONTRACTOR_SUPERVISOR' THEN
            IF t.assigned_to IS DISTINCT FROM current_actor() OR stage <> 'SUPERVISOR' THEN
                RAISE EXCEPTION 'the supervisor the job is assigned to measures it, until he sends the measurements for review'
                    USING ERRCODE = 'insufficient_privilege';
            END IF;
        ELSIF NOT (role, stage) IN (('CIVIL_OVERSEER','OVERSEER'), ('MAINTENANCE_INCHARGE','INCHARGE'),
                                    ('STAFF_OFFICER_CIVIL','STAFF_OFFICER'), ('STAFF_OFFICER_CIVIL','APPROVED')) THEN
            RAISE EXCEPTION 'measurements are the supervisor''s own sheet first; each officer measures again at their own step'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF stage = 'APPROVED' AND job_card_reason() IS NULL THEN
            RAISE EXCEPTION 'give the reason for correcting the MB after its approval' USING ERRCODE = 'check_violation';
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
            -- (an entry is no longer frozen by an MB reference: the approval chain
            -- governs it, and every version takes its own line of the MB record)
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
DROP POLICY measurement_insert ON measurement;
DROP POLICY measurement_update ON measurement;
CREATE POLICY measurement_insert ON measurement AS RESTRICTIVE FOR INSERT
    WITH CHECK (current_role_name() IN ('CIVIL_OVERSEER','MAINTENANCE_INCHARGE','CONTRACTOR_SUPERVISOR','STAFF_OFFICER_CIVIL'));
CREATE POLICY measurement_update ON measurement AS RESTRICTIVE FOR UPDATE
    USING (current_role_name() IN ('CIVIL_OVERSEER','MAINTENANCE_INCHARGE','CONTRACTOR_SUPERVISOR','STAFF_OFFICER_CIVIL'));

-- =====================================================================
-- THE MB REFERENCE RECORD (user's decisions, 2026-10-16)
--
-- The paper Measurement Book stays official; the portal keeps the record it
-- is copied from. One MB number per contract, given at the first entry.
-- Every version of a measurement — the supervisor's, each officer's change,
-- the Staff Officer's correction after approval — takes the next line of
-- the contract's book, on fixed pages of 25 lines. Nothing is rewritten: a
-- later line for the same measurement supersedes the earlier one, which
-- stays. Written by the database as each measurement is taken.
-- =====================================================================
CREATE TABLE mb_book (
    contract_id  uuid PRIMARY KEY,
    mb_no        text NOT NULL UNIQUE,
    next_line    integer NOT NULL DEFAULT 1,
    area_id      uuid NOT NULL,
    scope_path   ltree NOT NULL,
    opened_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mb_line (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id    uuid NOT NULL REFERENCES mb_book(contract_id),
    line_no        integer NOT NULL,
    page           integer NOT NULL,
    ticket_id      uuid NOT NULL,
    measurement_id uuid NOT NULL,
    item_seq       integer NULL,
    description    text NULL,
    unit           text NULL,
    nos            numeric(12,3) NULL,
    length         numeric(12,3) NULL,
    breadth        numeric(12,3) NULL,
    depth          numeric(12,3) NULL,
    qty            numeric(12,3) NOT NULL,
    by_actor       uuid NULL,
    by_person      uuid NULL,
    by_role        text NOT NULL,
    reason         text NULL,
    correction     boolean NOT NULL DEFAULT false,   -- after the MB approval, by the Staff Officer
    at             timestamptz NOT NULL DEFAULT now(),
    area_id        uuid NOT NULL,
    scope_path     ltree NOT NULL,
    UNIQUE (contract_id, line_no)
);
CREATE INDEX mb_line_ticket ON mb_line (ticket_id, line_no);

ALTER TABLE mb_book ENABLE ROW LEVEL SECURITY;
ALTER TABLE mb_book FORCE ROW LEVEL SECURITY;
ALTER TABLE mb_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE mb_line FORCE ROW LEVEL SECURITY;
-- the department in its scope; the contractor for jobs it sees; never an occupant
CREATE POLICY mb_book_read ON mb_book FOR SELECT USING (
    current_role_name() = 'SYSTEM'
    OR (current_role_name() IN ('CIVIL_OVERSEER','MAINTENANCE_INCHARGE','STAFF_OFFICER_CIVIL','GM_CIVIL','HQ_EXECUTIVE','ADMINISTRATOR')
        AND scope_path <@ current_scope())
    OR (current_role_name() = 'CONTRACTOR' AND contract_id = current_contract())
    OR (current_role_name() = 'CONTRACTOR_SUPERVISOR' AND EXISTS (SELECT 1 FROM ticket t WHERE t.contract_id = mb_book.contract_id)));
CREATE POLICY mb_line_read ON mb_line FOR SELECT USING (
    current_role_name() NOT IN ('RESIDENT','CUSTODIAN') AND ticket_is_visible(ticket_id));
CREATE POLICY mb_book_write ON mb_book FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY mb_line_write ON mb_line FOR INSERT WITH CHECK (true);

-- written only by the measurement trigger below; never changed or deleted
CREATE OR REPLACE FUNCTION mb_line_frozen() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF coalesce(current_setting('app.mb_writing', true), '') <> 'on' THEN
            RAISE EXCEPTION 'The MB record is written by the database as measurements are taken' USING ERRCODE = 'insufficient_privilege';
        END IF;
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'A line of the MB record is never changed or deleted; a revision takes a new line' USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER mb_line_frozen_trigger BEFORE INSERT OR UPDATE OR DELETE ON mb_line
    FOR EACH ROW EXECUTE FUNCTION mb_line_frozen();

CREATE OR REPLACE FUNCTION mb_book_guard() RETURNS trigger AS $$
BEGIN
    IF coalesce(current_setting('app.mb_writing', true), '') <> 'on' THEN
        RAISE EXCEPTION 'The MB book is kept by the database' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'An MB book is never deleted' USING ERRCODE = 'insufficient_privilege'; END IF;
    IF TG_OP = 'UPDATE' AND (NEW.contract_id, NEW.mb_no, NEW.opened_at) IS DISTINCT FROM (OLD.contract_id, OLD.mb_no, OLD.opened_at) THEN
        RAISE EXCEPTION 'An MB number is fixed' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER mb_book_guard_trigger BEFORE INSERT OR UPDATE OR DELETE ON mb_book
    FOR EACH ROW EXECUTE FUNCTION mb_book_guard();

-- each version of a measurement takes the next line of its contract's book
CREATE OR REPLACE FUNCTION mb_line_write() RETURNS trigger AS $$
DECLARE
    ct   record;
    i    record;
    ln   integer;
    per  constant integer := 25;     -- lines to a printed page
BEGIN
    -- only a measuring act (a new measurement or a measurement again) is a line
    IF TG_OP = 'UPDATE' AND (NEW.nos, NEW.length, NEW.breadth, NEW.depth, NEW.qty, NEW.remark)
                            IS NOT DISTINCT FROM (OLD.nos, OLD.length, OLD.breadth, OLD.depth, OLD.qty, OLD.remark) THEN
        RETURN NULL;
    END IF;
    PERFORM set_config('app.mb_writing', 'on', true);
    SELECT c.id, c.agreement_no, c.contract_no, t.area_id, t.scope_path
      INTO ct FROM maint.ticket t LEFT JOIN maint.contract c ON c.id = t.contract_id WHERE t.id = NEW.ticket_id;
    IF ct.id IS NULL THEN
        PERFORM set_config('app.mb_writing', '', true);
        RETURN NULL;          -- no contract: nothing to record against
    END IF;
    INSERT INTO maint.mb_book (contract_id, mb_no, area_id, scope_path)
    VALUES (ct.id, 'MB/' || coalesce(nullif(btrim(ct.agreement_no), ''), nullif(btrim(ct.contract_no), ''), ct.id::text), ct.area_id, ct.scope_path)
    ON CONFLICT (contract_id) DO NOTHING;
    UPDATE maint.mb_book SET next_line = next_line + 1 WHERE contract_id = ct.id RETURNING next_line - 1 INTO ln;
    SELECT seq, description, unit INTO i FROM maint.job_card_item WHERE id = NEW.item_id;
    INSERT INTO maint.mb_line (contract_id, line_no, page, ticket_id, measurement_id, item_seq, description, unit,
                               nos, length, breadth, depth, qty, by_actor, by_person, by_role, reason, correction, area_id, scope_path)
    VALUES (ct.id, ln, (ln + per - 1) / per, NEW.ticket_id, NEW.id, i.seq, i.description, i.unit,
            NEW.nos, NEW.length, NEW.breadth, NEW.depth, NEW.qty, current_actor(), current_person(),
            coalesce(current_role_name(), 'SYSTEM'), maint.job_card_reason(),
            maint.sheet_stage_of(NEW.ticket_id, 'MEASUREMENTS') = 'APPROVED', NEW.area_id, NEW.scope_path);
    PERFORM set_config('app.mb_writing', '', true);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = maint, public;

CREATE TRIGGER measurement_mb_line_trigger
    AFTER INSERT OR UPDATE ON measurement
    FOR EACH ROW EXECUTE FUNCTION mb_line_write();

GRANT SELECT, INSERT, UPDATE ON mb_book, mb_line TO app_maint, appconn;
COMMIT;
