-- Migration 2026-10-12 (c): the level-4 remark (user's finding). A complaint
-- that reached the GM cannot close without the Area Civil Staff Officer's
-- remark, but nothing let the Staff Officer write it, and anyone who could
-- see the complaint could write it straight into the table. Now the remark
-- is the Staff Officer's alone (POST /tickets/{id}/escalation-remark),
-- escalations are guarded, and the refusal carries its reason.
-- Matches sql/02_maintenance_schema.sql.
--   psql -h localhost -U postgres -d ncl_maint -v ON_ERROR_STOP=1 -f <this file>

SET search_path TO maint, public;
CREATE OR REPLACE FUNCTION check_l4_remark() RETURNS trigger AS $$
BEGIN
    IF NEW.state = 'CLOSED' AND NEW.escalation_level >= 4 THEN
        IF NOT EXISTS (SELECT 1 FROM escalation_event
                        WHERE ticket_id = NEW.id AND level = 4
                          AND remark IS NOT NULL) THEN
            RAISE EXCEPTION 'This complaint reached the GM (level 4): the Area Civil Staff Officer must record a remark before it is closed'
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION escalation_event_guard() RETURNS trigger AS $$
BEGIN
    -- the database superuser loads the schema and clears test fixtures
    IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'An escalation is never deleted' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF current_setting('app.role', true) IS DISTINCT FROM 'SYSTEM' THEN
            RAISE EXCEPTION 'Escalations are raised by the system only' USING ERRCODE = 'insufficient_privilege';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.ticket_id IS DISTINCT FROM OLD.ticket_id OR NEW.level IS DISTINCT FROM OLD.level
       OR NEW.triggered_at IS DISTINCT FROM OLD.triggered_at OR NEW.attribution IS DISTINCT FROM OLD.attribution THEN
        RAISE EXCEPTION 'An escalation''s ticket, level, time and attribution are fixed' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.remark IS DISTINCT FROM OLD.remark THEN
        IF current_setting('app.role', true) IS DISTINCT FROM 'STAFF_OFFICER_CIVIL' OR OLD.level <> 4 THEN
            RAISE EXCEPTION 'The level-4 remark is the Area Civil Staff Officer''s to record' USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF OLD.remark IS NOT NULL THEN
            RAISE EXCEPTION 'The remark has been recorded; it is not changed' USING ERRCODE = 'unique_violation';
        END IF;
        IF NEW.remark IS NULL OR btrim(NEW.remark) = '' THEN
            RAISE EXCEPTION 'The remark must say something' USING ERRCODE = 'check_violation';
        END IF;
        NEW.acknowledged_by := current_actor();
        NEW.acknowledged_at := now();
    ELSIF NEW.acknowledged_by IS DISTINCT FROM OLD.acknowledged_by OR NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at THEN
        RAISE EXCEPTION 'Who acknowledged an escalation is recorded with the remark' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER escalation_event_guard_trigger
    BEFORE INSERT OR UPDATE OR DELETE ON escalation_event
    FOR EACH ROW EXECUTE FUNCTION escalation_event_guard();
