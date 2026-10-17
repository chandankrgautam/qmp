-- 2026-10-16: contractor staff on the web (user's decisions; README §5.5).
-- How each act's session signed in (officers see "from the web"), and the
-- database refusing a contractor's web session the acts that stay on the
-- phone: starting work, the completion claim, photographs (control 2).
-- Cut from sql/02_maintenance_schema.sql. Run as the superuser on ncl_maint:
--   psql -h localhost -U postgres -d ncl_maint -f sql/migrations/2026-10-16_contractor_web.sql
BEGIN;
SET LOCAL search_path = maint, public;

ALTER TABLE ticket_event   ADD COLUMN IF NOT EXISTS via text NULL DEFAULT nullif(current_setting('app.auth_method', true), '');
ALTER TABLE material_claim ADD COLUMN IF NOT EXISTS claimed_via text NULL DEFAULT nullif(current_setting('app.auth_method', true), '');

CREATE OR REPLACE FUNCTION enforce_web_contractor_limits() RETURNS trigger AS $$
BEGIN
    IF current_setting('app.auth_method', true) = 'otp' AND NEW.state IN ('IN_PROGRESS', 'WORK_COMPLETED') THEN
        RAISE EXCEPTION 'Starting the work and marking it complete are done in the app on your phone'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ticket_u_web_contractor_limits ON ticket;
CREATE TRIGGER ticket_u_web_contractor_limits
    BEFORE UPDATE OF state ON ticket
    FOR EACH ROW EXECUTE FUNCTION enforce_web_contractor_limits();

CREATE OR REPLACE FUNCTION media_web_contractor_limits() RETURNS trigger AS $$
BEGIN
    IF current_setting('app.auth_method', true) = 'otp' THEN
        RAISE EXCEPTION 'Photographs are taken only with the app''s camera on your phone'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ticket_media_web_contractor_limits ON ticket_media;
CREATE TRIGGER ticket_media_web_contractor_limits
    BEFORE INSERT ON ticket_media
    FOR EACH ROW EXECUTE FUNCTION media_web_contractor_limits();
COMMIT;
