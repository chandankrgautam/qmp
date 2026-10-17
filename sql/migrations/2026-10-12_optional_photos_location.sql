-- Migration 2026-10-12: photographs optional until HQ requires them; every
-- photograph located (the location rule is in the API: POST /media/{id}/confirm).
-- User's decisions. The before/after and inspection photographs become
-- compulsory only when the HQ System Administrator switches the settings
-- completion_photos_required / inspection_photo_required on; both start off.
-- Settings are now guarded by the database (HQ System Administrator only)
-- and every change is audit-logged. Matches sql/02_maintenance_schema.sql.
--   psql -h localhost -U postgres -d ncl_maint -v ON_ERROR_STOP=1 -f <this file>

SET search_path TO maint, public;

INSERT INTO maint_config (key, value, data_type, description) VALUES
 ('completion_photos_required','false','boolean',
  'The supervisor must attach a "before" and an "after" photograph to claim completion. Off while the portal is adopted (decision 2026-10-12); switch on when it has matured.'),
 ('inspection_photo_required','false','boolean',
  'The Overseer must take an in-app, located inspection photograph to accept or send back the work. Off while the portal is adopted (decision 2026-10-12); switch on when it has matured.')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION photo_setting(k text) RETURNS boolean AS $$
BEGIN
    RETURN coalesce((SELECT value FROM maint.maint_config WHERE key = k), 'true')::boolean;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = maint, public;

CREATE OR REPLACE FUNCTION enforce_photo_gates() RETURNS trigger AS $$
BEGIN
    IF NEW.state = OLD.state OR current_setting('app.role', true) = 'SYSTEM' THEN
        RETURN NEW;
    END IF;
    -- at least one BEFORE and one AFTER (COMPLETION) photograph of this
    -- round, the assigned supervisor's own (user's direction, 2026-10-07)
    IF NEW.state = 'WORK_COMPLETED' AND photo_setting('completion_photos_required') AND NOT EXISTS (
        SELECT 1 FROM ticket_media m
         WHERE m.ticket_id = NEW.id AND m.purpose = 'COMPLETION'
           AND m.upload_state = 'STORED'
           AND m.uploaded_by = NEW.assigned_to
           AND m.uploaded_at >= OLD.contractor_window_started_at) THEN
        RAISE EXCEPTION 'An "after" photograph taken during this round of work is required'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.state = 'WORK_COMPLETED' AND photo_setting('completion_photos_required') AND NOT EXISTS (
        SELECT 1 FROM ticket_media m
         WHERE m.ticket_id = NEW.id AND m.purpose = 'BEFORE'
           AND m.upload_state = 'STORED'
           AND m.uploaded_by = NEW.assigned_to
           AND m.uploaded_at >= OLD.contractor_window_started_at) THEN
        RAISE EXCEPTION 'A "before" photograph taken during this round of work is required'
            USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.state = 'WORK_COMPLETED' AND NEW.state IN ('INSPECTED_ACCEPTED','REWORK')
       AND photo_setting('inspection_photo_required') AND NOT EXISTS (
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

CREATE OR REPLACE FUNCTION maint_config_guard() RETURNS trigger AS $$
BEGIN
    -- the schema and its migrations are loaded by the database superuser,
    -- who could switch this trigger off anyway; the portal's own login never is
    IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
    END IF;
    IF current_setting('app.role', true) IS DISTINCT FROM 'SYSTEM' THEN
        IF TG_OP <> 'UPDATE' THEN
            RAISE EXCEPTION 'Settings are added and removed only with a release'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF current_setting('app.role', true) IS DISTINCT FROM 'ADMINISTRATOR' THEN
            RAISE EXCEPTION 'Settings are changed only by the HQ System Administrator'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF NEW.key IS DISTINCT FROM OLD.key OR NEW.data_type IS DISTINCT FROM OLD.data_type THEN
            RAISE EXCEPTION 'A setting''s name and type are fixed'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF NEW.data_type = 'boolean' AND NEW.value NOT IN ('true','false') THEN
            RAISE EXCEPTION 'This setting is true or false' USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER maint_config_guard_trigger
    BEFORE INSERT OR UPDATE OR DELETE ON maint_config
    FOR EACH ROW EXECUTE FUNCTION maint_config_guard();

CREATE OR REPLACE FUNCTION maint_config_audit() RETURNS trigger AS $$
BEGIN
    IF NEW.value IS DISTINCT FROM OLD.value THEN
        INSERT INTO audit_log (event_type, entity_type, entity_id, actor_id, actor_person_id,
                               actor_role, before_value, after_value)
        VALUES ('CONFIG_CHANGED', 'maint_config', NULL, current_actor(), current_person(), current_role_name(),
                jsonb_build_object('key', OLD.key, 'value', OLD.value), jsonb_build_object('key', NEW.key, 'value', NEW.value));
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER maint_config_audit_trigger
    AFTER UPDATE ON maint_config
    FOR EACH ROW EXECUTE FUNCTION maint_config_audit();
