-- Migration 2026-10-08 (b): passkeys on the web — the identity database.
--
-- Brings an identity database at commit 5060283 up to this change, keeping
-- its data. The section is cut from sql/01_identity_schema.sql (by build
-- script), so a fresh build and a migrated database end up the same;
-- compare with pg_dump --schema-only after running it. Run as the owner:
--   psql -h localhost -U postgres -d ncl_identity -v ON_ERROR_STOP=1 -f <this file>

SET search_path TO identity, public;
BEGIN;

-- =====================================================================
-- PASSKEYS (phase 8, decision 2026-09-30: "passkeys on the web")
--
-- A passkey is a key held by an employee's phone, laptop or security key,
-- unlocked by their fingerprint, face or PIN, in place of typing the web
-- password. Only the sign-in service adds one, after proving the
-- authenticator's response and the person's password; it is removed with
-- a reason, never deleted; its key and owner never change; its signature
-- counter only rises (a counter going backwards means a copied key).
-- =====================================================================

INSERT INTO config (key, value, data_type, description) VALUES
 ('passkeys_max_per_person','5','integer','Live passkeys one employee may hold for web sign-in')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE passkey (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id         uuid NOT NULL REFERENCES person(id),
    credential_id     text NOT NULL UNIQUE,          -- base64url, as the browser sends it
    public_key        bytea NOT NULL,                -- COSE key
    counter           bigint NOT NULL DEFAULT 0 CHECK (counter >= 0),
    transports        text[] NULL,
    aaguid            text NULL,
    name              text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
    created_at        timestamptz NOT NULL DEFAULT now(),
    last_used_at      timestamptz NULL,
    removed_at        timestamptz NULL,
    removed_by_person uuid NULL,
    removed_by_role   text NULL,
    removal_reason    text NULL,
    CONSTRAINT removal_has_reason CHECK (
        (removed_at IS NULL) = (removal_reason IS NULL)
        AND (removal_reason IS NULL OR length(btrim(removal_reason)) > 0))
);
CREATE INDEX passkey_person ON passkey (person_id) WHERE removed_at IS NULL;

-- The registration and sign-in challenges: single use, five minutes.
CREATE TABLE webauthn_challenge (
    challenge   text PRIMARY KEY,
    purpose     text NOT NULL CHECK (purpose IN ('register','authenticate')),
    person_id   uuid NULL REFERENCES person(id),
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz NULL
);

-- A person's Area, for the audit entry's scope, whoever is acting
CREATE OR REPLACE FUNCTION person_area(p uuid) RETURNS uuid AS $$
    SELECT ar.id FROM identity.role_assignment a
      JOIN identity.area ar ON a.scope_path <@ ar.scope_path
     WHERE a.person_id = p ORDER BY a.valid_from, a.id LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = identity, public;

CREATE OR REPLACE FUNCTION person_is_employee(p uuid) RETURNS boolean AS $$
    SELECT EXISTS (SELECT 1 FROM identity.person WHERE id = p AND is_employee AND personnel_no IS NOT NULL);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = identity, public;

CREATE OR REPLACE FUNCTION passkey_guard() RETURNS trigger AS $$
DECLARE
    role text := current_setting('app.role', true);
    service boolean := role IN ('AUTH','SYSTEM');
    max_live integer;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NOT service THEN
            RAISE EXCEPTION 'a passkey is added only by the sign-in service, after the authenticator is proved'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF NOT person_is_employee(NEW.person_id) THEN
            RAISE EXCEPTION 'passkeys are for NCL employees, who sign in on the web'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
        max_live := coalesce((SELECT value::int FROM config WHERE key = 'passkeys_max_per_person'), 5);
        IF (SELECT count(*) FROM passkey WHERE person_id = NEW.person_id AND removed_at IS NULL) >= max_live THEN
            RAISE EXCEPTION 'at most % passkeys; remove one first', max_live USING ERRCODE = 'unique_violation';
        END IF;
        NEW.counter := coalesce(NEW.counter, 0);
        NEW.created_at := now();
        NEW.last_used_at := NULL;
        NEW.removed_at := NULL; NEW.removed_by_person := NULL; NEW.removed_by_role := NULL; NEW.removal_reason := NULL;
        RETURN NEW;
    END IF;

    IF (NEW.id, NEW.person_id, NEW.credential_id, NEW.public_key, NEW.transports, NEW.aaguid, NEW.name, NEW.created_at)
       IS DISTINCT FROM
       (OLD.id, OLD.person_id, OLD.credential_id, OLD.public_key, OLD.transports, OLD.aaguid, OLD.name, OLD.created_at) THEN
        RAISE EXCEPTION 'a passkey''s owner, key and name are fixed' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.removed_at IS NOT NULL THEN
        RAISE EXCEPTION 'this passkey has been removed' USING ERRCODE = 'unique_violation';
    END IF;

    IF NEW.removal_reason IS NOT NULL THEN
        -- removal: the person themselves, or an administrator who can see them
        -- (row security has already settled who can see the row)
        IF NOT service AND current_setting('app.person_id', true) IS DISTINCT FROM OLD.person_id::text
           AND role NOT IN ('AREA_HR_ADMIN','AREA_SYS_ADMIN','ADMINISTRATOR') THEN
            RAISE EXCEPTION 'only the owner or an Area administrator removes a passkey'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF (NEW.counter, NEW.last_used_at) IS DISTINCT FROM (OLD.counter, OLD.last_used_at) THEN
            RAISE EXCEPTION 'removal changes nothing else' USING ERRCODE = 'check_violation';
        END IF;
        NEW.removed_at := now();
        NEW.removed_by_person := nullif(current_setting('app.person_id', true), '')::uuid;
        NEW.removed_by_role := role;
        RETURN NEW;
    END IF;

    -- a sign-in: the service records the use and the authenticator's counter
    IF NOT service THEN
        RAISE EXCEPTION 'a passkey is used only through sign-in' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.counter < OLD.counter OR (NEW.counter = OLD.counter AND OLD.counter > 0) THEN
        RAISE EXCEPTION 'the signature counter went backwards: a copied key' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER passkey_guard_trigger
    BEFORE INSERT OR UPDATE ON passkey
    FOR EACH ROW EXECUTE FUNCTION passkey_guard();

CREATE OR REPLACE FUNCTION passkey_audit() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.removed_at IS DISTINCT FROM OLD.removed_at THEN
        INSERT INTO audit_log (event_type, entity_type, entity_id, actor_id, actor_person_id, actor_role,
                               area_id, after_value, reason)
        VALUES (CASE WHEN TG_OP = 'INSERT' THEN 'PASSKEY_ADDED' ELSE 'PASSKEY_REMOVED' END,
                'person', NEW.person_id,
                nullif(current_setting('app.actor_id', true), '')::uuid,
                coalesce(nullif(current_setting('app.person_id', true), '')::uuid, NEW.person_id),
                CASE WHEN current_setting('app.role', true) IN ('AUTH','SYSTEM') THEN NULL
                     ELSE current_setting('app.role', true)::principal_role END,
                person_area(NEW.person_id),
                jsonb_build_object('passkey', NEW.id, 'name', NEW.name),
                NEW.removal_reason);
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER passkey_audit_trigger
    AFTER INSERT OR UPDATE ON passkey
    FOR EACH ROW EXECUTE FUNCTION passkey_audit();
CREATE TRIGGER passkey_no_delete
    BEFORE DELETE ON passkey
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE passkey            ENABLE ROW LEVEL SECURITY;
ALTER TABLE passkey            FORCE ROW LEVEL SECURITY;
ALTER TABLE webauthn_challenge ENABLE ROW LEVEL SECURITY;
ALTER TABLE webauthn_challenge FORCE ROW LEVEL SECURITY;
-- one's own; an Area administrator's people (the person policy decides
-- which people those are); the sign-in service
CREATE POLICY passkey_read ON passkey USING (
    current_setting('app.role', true) IN ('AUTH','SYSTEM')
    OR person_id = current_person()
    OR (is_area_admin() AND EXISTS (SELECT 1 FROM person p WHERE p.id = passkey.person_id)));
CREATE POLICY passkey_insert ON passkey AS RESTRICTIVE FOR INSERT
    WITH CHECK (current_setting('app.role', true) IN ('AUTH','SYSTEM'));
CREATE POLICY challenge_service_only ON webauthn_challenge
    USING (current_setting('app.role', true) IN ('AUTH','SYSTEM'));


GRANT SELECT, INSERT, UPDATE ON passkey, webauthn_challenge TO app_identity;
GRANT SELECT, INSERT, UPDATE ON passkey, webauthn_challenge TO appconn;

COMMIT;
