-- Migration 2026-10-15: colony notices (UI v2 port, blueprint R4). The
-- Civil Overseer or Incharge posts a notice for a colony of their Area;
-- its residents and custodians see it; ended with a reason, never edited or
-- deleted; logged by the database. Changes no existing row.
-- Cut from sql/02_maintenance_schema.sql, so a migrated and a fresh database match.
--   psql -h localhost -U postgres -d ncl_maint -v ON_ERROR_STOP=1 -f <this file>

SET search_path TO maint, public;
BEGIN;
-- ============================================================
-- Colony notices (UI v2 port, 2026-10-15; blueprint R4)
-- ============================================================
-- When the water main to a block fails, twenty quarters report the same
-- thing. The Overseer or Incharge posts one notice for the colony, and its
-- residents see it before they report. A notice carries no resident's data.
-- It is ended with a reason, never edited or deleted, and logged by the
-- database. Visibility follows the colony's scope, like everything else
-- (control 3): residents and custodians of that colony, officers whose
-- scope contains it, HQ read-only, contractors not at all.

CREATE TABLE colony_notice (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    area_id         uuid NOT NULL,
    colony_id       uuid NOT NULL,
    scope_path      ltree NOT NULL,          -- the colony's scope
    title           text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 120),
    body            text NOT NULL DEFAULT '' CHECK (length(body) <= 600),
    starts_at       timestamptz NOT NULL DEFAULT now(),
    ends_at         timestamptz NULL,        -- shown until then, or until ended
    posted_by       uuid NOT NULL,           -- the role assignment acted in
    posted_by_role  text NOT NULL,
    posted_at       timestamptz NOT NULL DEFAULT now(),
    ended_at        timestamptz NULL,
    ended_by        uuid NULL,
    end_reason      text NULL,
    CONSTRAINT ended_together CHECK ((ended_at IS NULL) = (ended_by IS NULL) AND (ended_at IS NULL) = (end_reason IS NULL))
);
CREATE INDEX colony_notice_scope ON colony_notice USING gist (scope_path);
CREATE INDEX colony_notice_live ON colony_notice (colony_id) WHERE ended_at IS NULL;

ALTER TABLE colony_notice ENABLE ROW LEVEL SECURITY;
ALTER TABLE colony_notice FORCE ROW LEVEL SECURITY;

CREATE POLICY notice_read ON colony_notice FOR SELECT USING (
    CASE current_role_name()
        WHEN 'RESIDENT'  THEN scope_path @> (SELECT p.scope_path FROM premises_ref p WHERE p.premises_id = current_premises())
        WHEN 'CUSTODIAN' THEN scope_path @> (SELECT p.scope_path FROM premises_ref p WHERE p.premises_id = current_premises())
        WHEN 'CONTRACTOR_SUPERVISOR' THEN false
        WHEN 'CONTRACTOR' THEN false
        WHEN 'GM_CIVIL' THEN true
        WHEN 'HQ_EXECUTIVE' THEN true
        WHEN 'ADMINISTRATOR' THEN true
        WHEN 'SYSTEM' THEN true
        ELSE scope_path <@ current_scope()
    END);
-- only the Overseer and Incharge post or end, inside their own scope
CREATE POLICY notice_post ON colony_notice FOR INSERT WITH CHECK (
    current_role_name() IN ('CIVIL_OVERSEER','MAINTENANCE_INCHARGE') AND scope_path <@ current_scope());
CREATE POLICY notice_end ON colony_notice FOR UPDATE
    USING (current_role_name() IN ('CIVIL_OVERSEER','MAINTENANCE_INCHARGE') AND scope_path <@ current_scope())
    WITH CHECK (current_role_name() IN ('CIVIL_OVERSEER','MAINTENANCE_INCHARGE') AND scope_path <@ current_scope());

CREATE OR REPLACE FUNCTION colony_notice_guard() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'A colony notice is never deleted; end it with a reason';
    END IF;
    IF TG_OP = 'INSERT' THEN
        -- who and when come from the session, never from the request
        NEW.posted_by := current_actor();
        NEW.posted_by_role := current_role_name();
        NEW.posted_at := now();
        NEW.ended_at := NULL; NEW.ended_by := NULL; NEW.end_reason := NULL;
        IF NEW.posted_by IS NULL THEN RAISE EXCEPTION 'No role assignment in this session'; END IF;
        RETURN NEW;
    END IF;
    -- UPDATE: the words, the colony and who posted it are fixed; a notice
    -- may only be ended, once, with a reason
    IF (NEW.title, NEW.body, NEW.colony_id, NEW.area_id, NEW.scope_path, NEW.starts_at, NEW.ends_at,
        NEW.posted_by, NEW.posted_by_role, NEW.posted_at)
       IS DISTINCT FROM
       (OLD.title, OLD.body, OLD.colony_id, OLD.area_id, OLD.scope_path, OLD.starts_at, OLD.ends_at,
        OLD.posted_by, OLD.posted_by_role, OLD.posted_at) THEN
        RAISE EXCEPTION 'A notice is not edited; end it and post a new one';
    END IF;
    IF OLD.ended_at IS NOT NULL THEN RAISE EXCEPTION 'This notice has already ended'; END IF;
    IF NEW.ended_at IS NULL THEN RAISE EXCEPTION 'Nothing to change'; END IF;
    IF length(btrim(coalesce(NEW.end_reason, ''))) = 0 THEN RAISE EXCEPTION 'A reason is required to end a notice'; END IF;
    NEW.ended_at := now();
    NEW.ended_by := current_actor();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER colony_notice_guard_trigger
    BEFORE INSERT OR UPDATE OR DELETE ON colony_notice
    FOR EACH ROW EXECUTE FUNCTION colony_notice_guard();

CREATE OR REPLACE FUNCTION colony_notice_audit() RETURNS trigger AS $$
BEGIN
    INSERT INTO audit_log (event_type, entity_type, entity_id, actor_id, actor_person_id, actor_role,
                           area_id, before_value, after_value, reason)
    VALUES (CASE TG_OP WHEN 'INSERT' THEN 'NOTICE_POSTED' ELSE 'NOTICE_ENDED' END, 'colony_notice', NEW.id,
            current_actor(), current_person(), current_role_name(), NEW.area_id,
            NULL, jsonb_build_object('title', NEW.title, 'colony_id', NEW.colony_id, 'ends_at', NEW.ends_at),
            NEW.end_reason);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER colony_notice_audit_trigger
    AFTER INSERT OR UPDATE ON colony_notice
    FOR EACH ROW EXECUTE FUNCTION colony_notice_audit();

GRANT SELECT, INSERT, UPDATE ON colony_notice TO app_maint;
-- the portal's own login, as a fresh build grants it (src/db-reset.js)
GRANT SELECT, INSERT, UPDATE ON colony_notice TO appconn;
COMMIT;
