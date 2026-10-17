-- Migration 2026-10-07: disputes the department must decide, before/after
-- photographs, repeat complaints, search by fault name.
--
-- Brings a database built from the schema as of commit 01373ef up to the
-- schema of this change, keeping its data. Every statement below is cut
-- from sql/02_maintenance_schema.sql itself (by build script), so a fresh
-- build and a migrated database end up the same; compare with
-- pg_dump --schema-only after running it. Run as the database owner:
--   psql -h localhost -U postgres -d ncl_maint -v ON_ERROR_STOP=1 -f <this file>

SET search_path TO maint, public;
BEGIN;

INSERT INTO ticket_transition VALUES
    ('INSPECTED_ACCEPTED','REOPENED','RESIDENT'),
    ('INSPECTED_ACCEPTED','REOPENED','CUSTODIAN'),
    ('REJECTED','RAISED','CIVIL_OVERSEER'),
    ('REJECTED','RAISED','MAINTENANCE_INCHARGE'),
    ('REJECTED','RAISED','STAFF_OFFICER_CIVIL'),
    ('REOPENED','CLOSED','STAFF_OFFICER_CIVIL'),
    ('REOPENED','REFERRED_SPECIAL_REPAIR','STAFF_OFFICER_CIVIL'),
    ('REOPENED','ASSIGNED','MAINTENANCE_INCHARGE'),
    ('REOPENED','ASSIGNED','CIVIL_OVERSEER')
ON CONFLICT DO NOTHING;

DROP POLICY media_purpose_authority ON ticket_media;
CREATE POLICY media_purpose_authority ON ticket_media AS RESTRICTIVE FOR INSERT
    WITH CHECK (current_role_name() = 'SYSTEM' OR (
        uploaded_by = current_actor() AND CASE purpose
            WHEN 'COMPLETION' THEN current_role_name() = 'CONTRACTOR_SUPERVISOR'
            WHEN 'BEFORE'     THEN current_role_name() = 'CONTRACTOR_SUPERVISOR'
            WHEN 'INSPECTION' THEN current_role_name() = 'CIVIL_OVERSEER'
            WHEN 'OBJECTION'  THEN current_role_name() IN ('RESIDENT','CUSTODIAN')
            WHEN 'COMPLAINT'  THEN current_role_name() IN
                ('RESIDENT','CUSTODIAN','CIVIL_OVERSEER','MAINTENANCE_INCHARGE')
            ELSE false END));

CREATE OR REPLACE FUNCTION enforce_photo_gates() RETURNS trigger AS $$
BEGIN
    IF NEW.state = OLD.state OR current_setting('app.role', true) = 'SYSTEM' THEN
        RETURN NEW;
    END IF;
    -- at least one BEFORE and one AFTER (COMPLETION) photograph of this
    -- round, the assigned supervisor's own (user's direction, 2026-10-07)
    IF NEW.state = 'WORK_COMPLETED' AND NOT EXISTS (
        SELECT 1 FROM ticket_media m
         WHERE m.ticket_id = NEW.id AND m.purpose = 'COMPLETION'
           AND m.upload_state = 'STORED'
           AND m.uploaded_by = NEW.assigned_to
           AND m.uploaded_at >= OLD.contractor_window_started_at) THEN
        RAISE EXCEPTION 'An "after" photograph taken during this round of work is required'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.state = 'WORK_COMPLETED' AND NOT EXISTS (
        SELECT 1 FROM ticket_media m
         WHERE m.ticket_id = NEW.id AND m.purpose = 'BEFORE'
           AND m.upload_state = 'STORED'
           AND m.uploaded_by = NEW.assigned_to
           AND m.uploaded_at >= OLD.contractor_window_started_at) THEN
        RAISE EXCEPTION 'A "before" photograph taken during this round of work is required'
            USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.state = 'WORK_COMPLETED' AND NEW.state IN ('INSPECTED_ACCEPTED','REWORK')
       AND NOT EXISTS (
        SELECT 1 FROM ticket_media m
         WHERE m.ticket_id = NEW.id AND m.purpose = 'INSPECTION'
           AND m.upload_state = 'STORED' AND m.capture_verified
           AND m.uploaded_by = current_actor()
           AND m.uploaded_at >= OLD.completed_claim_at) THEN
        RAISE EXCEPTION 'An inspection photograph you took in the app, after the completion claim, is required'
            USING ERRCODE = 'check_violation';
    END IF;
    -- Acceptance only from the app (decision 2026-09-30): a session signed
    -- in with the device's hardware key, where the geo-tagging camera is.
    -- A password on an office PC cannot accept an inspection.
    IF NEW.state = 'INSPECTED_ACCEPTED'
       AND current_setting('app.auth_method', true) IS DISTINCT FROM 'device' THEN
        RAISE EXCEPTION 'Inspection can be accepted only from the app on your registered phone'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER ticket_search_trigger ON ticket;
CREATE OR REPLACE FUNCTION ticket_search_words(p_premises uuid, p_sub uuid) RETURNS text AS $$
    SELECT coalesce((SELECT identifier || ' ' || replace(identifier, '-', ' ')
                       FROM maint.premises_ref WHERE premises_id = p_premises), '') || ' ' ||
           coalesce((SELECT s.name_en || ' ' || s.name_hi || ' ' || c.name_en || ' ' || c.name_hi
                       FROM maint.sub_category s JOIN maint.category c ON c.id = s.category_id
                      WHERE s.id = p_sub), '');
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = maint, public;

CREATE OR REPLACE FUNCTION ticket_search_update() RETURNS trigger AS $$
BEGIN
    NEW.search_vector :=
        to_tsvector('simple', coalesce(NEW.ticket_no,'') || ' ' ||
                              coalesce(NEW.description,'') || ' ' ||
                              ticket_search_words(NEW.premises_id, NEW.sub_category_id));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ticket_search_trigger
    BEFORE INSERT OR UPDATE OF description, sub_category_id ON ticket
    FOR EACH ROW EXECUTE FUNCTION ticket_search_update();

INSERT INTO maint_config (key, value, data_type, description) VALUES
 ('reopens_before_staff_officer','3','integer',
  'Reopenings of one complaint after which the Area Civil Staff Officer must decide it')
ON CONFLICT (key) DO NOTHING;
-- =====================================================================
-- DISPUTES THE DEPARTMENT MUST DECIDE (user's findings, 2026-10-07)
--
-- Two kinds, one table:
--  REJECTION_CONTEST  the occupant contests a rejection, once. The Overseer
--                     or Incharge reinstates it or upholds the rejection;
--                     upheld, it goes to the Area Civil Staff Officer, who
--                     must decide in writing.
--  REPEAT_DISPUTE     a complaint reopened for the third time goes to the
--                     Staff Officer, who must decide in writing: redo the
--                     work, close it, or refer it for special repair.
-- After a Staff Officer's decision the occupant can neither contest nor
-- reopen that complaint again; further disputes go on paper to the Area
-- Civil Office. Each step is fixed once taken and written into the
-- complaint's history.
-- =====================================================================

CREATE TABLE ticket_review (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id       uuid NOT NULL REFERENCES ticket(id),
    kind            text NOT NULL CHECK (kind IN ('REJECTION_CONTEST','REPEAT_DISPUTE')),
    stage           text NOT NULL CHECK (stage IN ('WITH_OFFICERS','WITH_STAFF_OFFICER','DECIDED')),
    raised_at       timestamptz NOT NULL DEFAULT now(),
    raised_by       uuid NULL,
    raised_reason   text NULL,
    officer_outcome text NULL CHECK (officer_outcome IN ('REINSTATE','UPHOLD')),
    officer_note    text NULL,
    officer_by      uuid NULL,
    officer_role    text NULL,              -- shown to the occupant, who reads no officer's record
    officer_at      timestamptz NULL,
    so_outcome      text NULL CHECK (so_outcome IN ('REINSTATE','UPHOLD','REWORK','CLOSE','SPECIAL_REPAIR')),
    so_decision     text NULL,
    so_by           uuid NULL,
    so_at           timestamptz NULL,
    area_id         uuid NOT NULL,
    scope_path      ltree NOT NULL,
    UNIQUE (ticket_id, kind),
    CONSTRAINT outcome_fits_kind CHECK (
        so_outcome IS NULL
        OR (kind = 'REJECTION_CONTEST' AND so_outcome IN ('REINSTATE','UPHOLD'))
        OR (kind = 'REPEAT_DISPUTE' AND so_outcome IN ('REWORK','CLOSE','SPECIAL_REPAIR')))
);

-- whoever asks: has a Staff Officer decided a dispute on this complaint?
CREATE OR REPLACE FUNCTION ticket_final_decision(p uuid) RETURNS boolean AS $$
    SELECT EXISTS (SELECT 1 FROM maint.ticket_review WHERE ticket_id = p AND so_outcome IS NOT NULL);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = maint, public;

CREATE OR REPLACE FUNCTION ticket_where(p uuid) RETURNS TABLE (area_id uuid, scope_path ltree) AS $$
    SELECT area_id, scope_path FROM maint.ticket WHERE id = p;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = maint, public;

CREATE OR REPLACE FUNCTION ticket_review_guard() RETURNS trigger AS $$
DECLARE role text := current_role_name(); w record;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT * INTO w FROM ticket_where(NEW.ticket_id);
        NEW.area_id := w.area_id; NEW.scope_path := w.scope_path;
        NEW.raised_at := now();
        NEW.officer_outcome := NULL; NEW.officer_note := NULL; NEW.officer_by := NULL; NEW.officer_role := NULL; NEW.officer_at := NULL;
        NEW.so_outcome := NULL; NEW.so_decision := NULL; NEW.so_by := NULL; NEW.so_at := NULL;
        IF current_setting('app.review_system', true) = 'on' THEN
            NEW.stage := 'WITH_STAFF_OFFICER';                -- referred by the system
            RETURN NEW;
        END IF;
        IF NEW.kind <> 'REJECTION_CONTEST' OR role NOT IN ('RESIDENT','CUSTODIAN') THEN
            RAISE EXCEPTION 'only the occupant may contest a rejection' USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF ticket_state_of(NEW.ticket_id) IS DISTINCT FROM 'REJECTED' THEN
            RAISE EXCEPTION 'only a rejected complaint can be contested' USING ERRCODE = 'check_violation';
        END IF;
        IF ticket_final_decision(NEW.ticket_id) THEN
            RAISE EXCEPTION 'this complaint has been decided by the Area Civil Staff Officer' USING ERRCODE = 'check_violation';
        END IF;
        IF coalesce(btrim(NEW.raised_reason), '') = '' THEN
            RAISE EXCEPTION 'say why the rejection is wrong' USING ERRCODE = 'check_violation';
        END IF;
        NEW.stage := 'WITH_OFFICERS';
        NEW.raised_by := current_actor();
        RETURN NEW;
    END IF;

    IF (NEW.ticket_id, NEW.kind, NEW.raised_at, NEW.raised_by, NEW.raised_reason, NEW.area_id, NEW.scope_path)
       IS DISTINCT FROM (OLD.ticket_id, OLD.kind, OLD.raised_at, OLD.raised_by, OLD.raised_reason, OLD.area_id, OLD.scope_path) THEN
        RAISE EXCEPTION 'what was raised is fixed' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.stage = 'DECIDED' THEN
        RAISE EXCEPTION 'this dispute has been decided' USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.stage = 'WITH_OFFICERS' THEN
        IF role NOT IN ('CIVIL_OVERSEER','MAINTENANCE_INCHARGE') THEN
            RAISE EXCEPTION 'a contested rejection is reviewed first by the Overseer or the Civil Incharge'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF NEW.officer_outcome IS NULL OR coalesce(btrim(NEW.officer_note), '') = '' THEN
            RAISE EXCEPTION 'give the outcome and a note' USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.so_outcome IS NOT NULL OR NEW.so_decision IS NOT NULL THEN
            RAISE EXCEPTION 'the Staff Officer''s stage has not been reached' USING ERRCODE = 'check_violation';
        END IF;
        NEW.officer_by := current_actor(); NEW.officer_role := role; NEW.officer_at := now();
        NEW.stage := CASE NEW.officer_outcome WHEN 'REINSTATE' THEN 'DECIDED' ELSE 'WITH_STAFF_OFFICER' END;
        RETURN NEW;
    END IF;

    -- WITH_STAFF_OFFICER
    IF role IS DISTINCT FROM 'STAFF_OFFICER_CIVIL' THEN
        RAISE EXCEPTION 'this dispute is for the Area Civil Staff Officer to decide'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF (NEW.officer_outcome, NEW.officer_note, NEW.officer_by, NEW.officer_role, NEW.officer_at)
       IS DISTINCT FROM (OLD.officer_outcome, OLD.officer_note, OLD.officer_by, OLD.officer_role, OLD.officer_at) THEN
        RAISE EXCEPTION 'the officers'' review is fixed' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.so_outcome IS NULL OR coalesce(btrim(NEW.so_decision), '') = '' THEN
        RAISE EXCEPTION 'a written decision is required' USING ERRCODE = 'check_violation';
    END IF;
    NEW.so_by := current_actor(); NEW.so_at := now();
    NEW.stage := 'DECIDED';
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ticket_review_guard_trigger
    BEFORE INSERT OR UPDATE ON ticket_review
    FOR EACH ROW EXECUTE FUNCTION ticket_review_guard();
CREATE TRIGGER ticket_review_no_delete
    BEFORE DELETE ON ticket_review
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- every step into the complaint's own history, which the occupant reads
CREATE OR REPLACE FUNCTION ticket_review_history() RETURNS trigger AS $$
DECLARE ev text; why text;
BEGIN
    IF TG_OP = 'INSERT' THEN
        ev := CASE NEW.kind WHEN 'REJECTION_CONTEST' THEN 'REJECTION_CONTESTED' ELSE 'REFERRED_TO_STAFF_OFFICER' END;
        why := NEW.raised_reason;
    ELSIF NEW.so_outcome IS NOT NULL AND OLD.so_outcome IS NULL THEN
        ev := 'STAFF_OFFICER_DECIDED'; why := NEW.so_decision;
    ELSIF NEW.officer_outcome = 'REINSTATE' THEN
        ev := 'CONTEST_REINSTATED'; why := NEW.officer_note;
    ELSE
        ev := 'CONTEST_UPHELD'; why := NEW.officer_note;
    END IF;
    INSERT INTO ticket_event (ticket_id, event_type, actor_id, actor_role, reason, detail)
    VALUES (NEW.ticket_id, ev, coalesce(current_actor(), '00000000-0000-0000-0000-000000000000'),
            coalesce(current_role_name(), 'SYSTEM'), why,
            jsonb_build_object('review_id', NEW.id, 'kind', NEW.kind, 'stage', NEW.stage,
                               'officer_outcome', NEW.officer_outcome, 'so_outcome', NEW.so_outcome));
    IF ev = 'CONTEST_UPHELD' THEN
        INSERT INTO ticket_event (ticket_id, event_type, actor_id, actor_role, reason, detail)
        VALUES (NEW.ticket_id, 'REFERRED_TO_STAFF_OFFICER', coalesce(current_actor(), '00000000-0000-0000-0000-000000000000'),
                coalesce(current_role_name(), 'SYSTEM'), 'Rejection upheld on review; for the Area Civil Staff Officer to decide',
                jsonb_build_object('review_id', NEW.id, 'kind', NEW.kind));
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = maint, public;

CREATE TRIGGER ticket_review_history_trigger
    AFTER INSERT OR UPDATE ON ticket_review
    FOR EACH ROW EXECUTE FUNCTION ticket_review_history();

-- The complaint moves only as its disputes allow.
CREATE OR REPLACE FUNCTION ticket_review_gate() RETURNS trigger AS $$
BEGIN
    IF NEW.state = OLD.state OR current_role_name() = 'SYSTEM' THEN
        RETURN NEW;
    END IF;
    IF NEW.state = 'REOPENED' AND ticket_final_decision(NEW.id) THEN
        RAISE EXCEPTION 'This complaint has been decided by the Area Civil Staff Officer. Further disputes are not taken in the portal; you may write to the Area Civil Office.'
            USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.state = 'REJECTED' AND NEW.state = 'RAISED' AND NOT EXISTS (
        SELECT 1 FROM ticket_review r WHERE r.ticket_id = NEW.id AND r.kind = 'REJECTION_CONTEST'
           AND ((r.officer_outcome = 'REINSTATE' AND r.officer_at = now())
             OR (r.so_outcome = 'REINSTATE' AND r.so_at = now()))) THEN
        RAISE EXCEPTION 'a rejected complaint is reinstated only on review of the occupant''s contest'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.state = 'REOPENED' AND NEW.state = 'ASSIGNED' AND EXISTS (
        SELECT 1 FROM ticket_review r WHERE r.ticket_id = NEW.id AND r.kind = 'REPEAT_DISPUTE'
           AND (r.so_outcome IS NULL OR r.so_outcome <> 'REWORK')) THEN
        RAISE EXCEPTION 'Waiting for the Area Civil Staff Officer''s decision — this complaint cannot be reassigned until then'
            USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.state = 'REOPENED' AND NEW.state IN ('CLOSED','REFERRED_SPECIAL_REPAIR') AND NOT EXISTS (
        SELECT 1 FROM ticket_review r WHERE r.ticket_id = NEW.id AND r.kind = 'REPEAT_DISPUTE'
           AND r.so_at = now()
           AND r.so_outcome = CASE NEW.state WHEN 'CLOSED' THEN 'CLOSE' ELSE 'SPECIAL_REPAIR' END) THEN
        RAISE EXCEPTION 'a reopened complaint is closed or referred only by the Staff Officer''s decision on it'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ticket_review_gate_trigger
    BEFORE UPDATE OF state ON ticket
    FOR EACH ROW EXECUTE FUNCTION ticket_review_gate();

-- The third reopening refers the complaint to the Staff Officer.
CREATE OR REPLACE FUNCTION refer_repeat_dispute(p uuid) RETURNS boolean AS $$
DECLARE made integer;
BEGIN
    PERFORM set_config('app.review_system', 'on', true);
    INSERT INTO maint.ticket_review (ticket_id, kind, stage, raised_reason)
    SELECT p, 'REPEAT_DISPUTE', 'WITH_STAFF_OFFICER',
           'Reopened ' || t.reopened_count || ' times by the occupant'
      FROM maint.ticket t WHERE t.id = p
    ON CONFLICT (ticket_id, kind) DO NOTHING;
    GET DIAGNOSTICS made = ROW_COUNT;
    PERFORM set_config('app.review_system', '', true);
    RETURN made = 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = maint, public;

CREATE OR REPLACE FUNCTION ticket_repeat_referral() RETURNS trigger AS $$
BEGIN
    IF NEW.reopened_count >= coalesce((SELECT value::integer FROM maint.maint_config
                                         WHERE key = 'reopens_before_staff_officer'), 3) THEN
        PERFORM refer_repeat_dispute(NEW.id);
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = maint, public;

CREATE TRIGGER ticket_repeat_referral_trigger
    AFTER UPDATE OF state ON ticket
    FOR EACH ROW WHEN (NEW.state = 'REOPENED' AND OLD.state IS DISTINCT FROM 'REOPENED')
    EXECUTE FUNCTION ticket_repeat_referral();

-- At most three BEFORE and three AFTER photographs in a round.
CREATE OR REPLACE FUNCTION ticket_window_of(p uuid) RETURNS timestamptz AS $$
    SELECT contractor_window_started_at FROM maint.ticket WHERE id = p;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = maint, public;

CREATE OR REPLACE FUNCTION media_round_limit() RETURNS trigger AS $$
DECLARE since timestamptz;
BEGIN
    IF NEW.purpose IN ('BEFORE','COMPLETION') AND NEW.upload_state = 'STORED'
       AND OLD.upload_state IS DISTINCT FROM 'STORED' THEN
        since := coalesce(ticket_window_of(NEW.ticket_id), '-infinity'::timestamptz);
        IF (SELECT count(*) FROM ticket_media m
             WHERE m.ticket_id = NEW.ticket_id AND m.purpose = NEW.purpose AND m.id <> NEW.id
               AND m.upload_state = 'STORED' AND m.uploaded_at >= since) >= 3 THEN
            RAISE EXCEPTION 'At most three % photographs for each round of work',
                CASE NEW.purpose WHEN 'BEFORE' THEN '"before"' ELSE '"after"' END
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER media_round_limit_trigger
    BEFORE UPDATE ON ticket_media
    FOR EACH ROW EXECUTE FUNCTION media_round_limit();

ALTER TABLE ticket_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_review FORCE ROW LEVEL SECURITY;
-- the occupant and officers of the complaint read it; never the contractor
CREATE POLICY ticket_review_read ON ticket_review USING (
    current_role_name() NOT IN ('CONTRACTOR','CONTRACTOR_SUPERVISOR')
    AND ticket_is_visible(ticket_id));
CREATE POLICY ticket_event_no_disputes_for_contractor ON ticket_event AS RESTRICTIVE FOR SELECT USING (
    current_role_name() NOT IN ('CONTRACTOR','CONTRACTOR_SUPERVISOR')
    OR event_type NOT IN ('REJECTION_CONTESTED','CONTEST_REINSTATED','CONTEST_UPHELD','REINSTATED',
                          'REFERRED_TO_STAFF_OFFICER','STAFF_OFFICER_DECIDED',
                          'OCCUPANT_CONFIRMED','OCCUPANT_DISPUTED','OCCUPANT_NO_RESPONSE'));
CREATE POLICY ticket_review_insert ON ticket_review AS RESTRICTIVE FOR INSERT
    WITH CHECK (current_role_name() IN ('RESIDENT','CUSTODIAN','SYSTEM'));
CREATE POLICY ticket_review_update ON ticket_review AS RESTRICTIVE FOR UPDATE
    USING (current_role_name() IN ('CIVIL_OVERSEER','MAINTENANCE_INCHARGE','STAFF_OFFICER_CIVIL'));


GRANT SELECT, INSERT, UPDATE ON ticket_review TO app_maint;
GRANT SELECT, INSERT, UPDATE ON ticket_review TO appconn;

-- existing complaints: index the fault names and premises too
SET LOCAL session_replication_role = replica;
UPDATE ticket SET search_vector = to_tsvector('simple', coalesce(ticket_no,'') || ' ' ||
    coalesce(description,'') || ' ' || ticket_search_words(premises_id, sub_category_id));
SET LOCAL session_replication_role = DEFAULT;

-- complaints already reopened three or more times and waiting: to the Staff Officer
SELECT ticket_no, refer_repeat_dispute(id) AS referred FROM ticket
 WHERE state = 'REOPENED' AND reopened_count >= 3;

COMMIT;
