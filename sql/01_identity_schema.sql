-- =====================================================================
-- NCL Colony Maintenance Portal
-- B2 — DATA MODEL, PART 1 of 2
-- IDENTITY SERVICE  (separate deployable, separate database)
--
-- Owns: org hierarchy, premises master, people, devices, scope.
-- Consumed by: Colony Maintenance service, and later the E&M service.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "ltree";

CREATE SCHEMA IF NOT EXISTS identity;
SET search_path TO identity, public;


-- =====================================================================
-- 1. ENUMERATED TYPES
-- =====================================================================

CREATE TYPE premises_type AS ENUM (
    'QUARTER', 'GUEST_HOUSE', 'HOSTEL', 'UNION_OFFICE',
    'ADMIN_BUILDING', 'CLUB', 'DISPENSARY', 'SCHOOL', 'OTHER');

CREATE TYPE quarter_type AS ENUM ('A', 'B', 'C', 'D', 'MQ');

CREATE TYPE occupancy_model AS ENUM (
    'RESIDENT_BOUND',    -- quarters: bound resident devices, confirmation applies
    'CUSTODIAN_BOUND',   -- a building with a custodian who raises and
                         -- confirms (decision 2026-09-30)
    'DEPARTMENT_ONLY');  -- admin buildings: civil raises directly, no confirmation

CREATE TYPE dept_classification AS ENUM ('CIVIL', 'EM');

-- Roles (decision 2026-09-30). A person may hold several; see
-- role_assignment. CONTRACTOR is the firm's own login; the HQ roles
-- (GM_CIVIL = Civil HOD, HQ_EXECUTIVE = Directors and CMD) see all Areas
-- read-only; ADMINISTRATOR is the HQ portal administrator.
CREATE TYPE principal_role AS ENUM (
    'RESIDENT', 'CUSTODIAN', 'CONTRACTOR', 'CONTRACTOR_SUPERVISOR',
    'CIVIL_OVERSEER', 'MAINTENANCE_INCHARGE', 'STAFF_OFFICER_CIVIL',
    'AREA_HR_ADMIN', 'AREA_SYS_ADMIN',
    'GM_CIVIL', 'HQ_EXECUTIVE', 'ADMINISTRATOR');

CREATE TYPE device_status AS ENUM ('PENDING', 'ACTIVE', 'REJECTED', 'REVOKED');


-- =====================================================================
-- 2. ORGANISATIONAL HIERARCHY
--
-- scope_path (ltree) is the single mechanism for location scoping.
-- Format:  ncl.<area>.<colony>.<sector>
-- Subtree test is one indexed operator:   scope_path <@ 'ncl.jayant'
-- This replaces any directory service. Depth is unbounded.
-- =====================================================================

CREATE TABLE area (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code            text NOT NULL UNIQUE,        -- slug: 'jayant', 'cws', 'nclhq'
    -- The abbreviation the department already uses on files. It appears in
    -- every ticket number, so it is held here rather than derived from the
    -- name: the codes are not uniform in length (BINA) and not all are the
    -- first three letters (NGH for Nigahi, JRD for Jhingurda).
    ticket_code     text NOT NULL UNIQUE,
    name            text NOT NULL,
    scope_path      ltree NOT NULL UNIQUE,       -- 'ncl.jayant'
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX area_scope_gist ON area USING gist (scope_path);

CREATE TABLE colony (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    area_id         uuid NOT NULL REFERENCES area(id),
    code            text NOT NULL,
    name            text NOT NULL,
    scope_path      ltree NOT NULL UNIQUE,       -- 'ncl.jayant.colony1'
    UNIQUE (area_id, code)
);
CREATE INDEX colony_scope_gist ON colony USING gist (scope_path);

-- Sectors are nullable in the premises record: not all colonies have them.
-- Rows here accumulate as the Incharge verifies free-text submissions,
-- which is how free text is later promoted to a dropdown (FRS 4.4).
CREATE TABLE sector (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    colony_id       uuid NOT NULL REFERENCES colony(id),
    name            text NOT NULL,
    scope_path      ltree NOT NULL UNIQUE,
    verified        boolean NOT NULL DEFAULT false,
    UNIQUE (colony_id, name)
);
CREATE INDEX sector_scope_gist ON sector USING gist (scope_path);


-- =====================================================================
-- 3. PREMISES MASTER
--
-- THE primary maintained entity. A quarter is premises_type='QUARTER'.
-- Every ticket, photograph and document in the maintenance service
-- references premises_id. Nothing references a person.
-- =====================================================================

CREATE TABLE premises (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    area_id             uuid NOT NULL REFERENCES area(id),
    colony_id           uuid NOT NULL REFERENCES colony(id),
    sector_id           uuid     NULL REFERENCES sector(id),   -- NULL = "no sector"
    scope_path          ltree NOT NULL,

    identifier          text NOT NULL,            -- quarter number or building name
    premises_type       premises_type NOT NULL,
    quarter_type        quarter_type NULL,        -- only for QUARTER
    occupancy_model     occupancy_model NOT NULL,

    -- Reserved, inert in Phase 1 (FRS 12.2 / 1.3)
    dept_classification dept_classification NOT NULL DEFAULT 'CIVIL',
    current_allottee_id uuid NULL,                -- future Estate module
    allotment_status    text NULL,                -- future Estate module

    verified            boolean NOT NULL DEFAULT false,
    verified_by         uuid NULL,
    verified_at         timestamptz NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT premises_identifier_unique UNIQUE (colony_id, identifier),
    CONSTRAINT quarter_type_only_for_quarters CHECK (
        (premises_type =  'QUARTER' AND quarter_type IS NOT NULL) OR
        (premises_type <> 'QUARTER' AND quarter_type IS NULL)),
    CONSTRAINT resident_bound_only_for_quarters CHECK (
        occupancy_model <> 'RESIDENT_BOUND' OR premises_type = 'QUARTER'),
    -- A building is either under direct Civil Department control (the
    -- Overseer or Incharge raises, inspection is the only check) or has a
    -- custodian who raises and confirms, alongside inspection (decision
    -- 2026-09-30; decision 27 had allowed only the first).
    CONSTRAINT non_residential_occupancy CHECK (
        premises_type = 'QUARTER' OR occupancy_model IN ('DEPARTMENT_ONLY','CUSTODIAN_BOUND'))
);
CREATE INDEX premises_scope_gist ON premises USING gist (scope_path);
CREATE INDEX premises_area       ON premises (area_id);
CREATE INDEX premises_type_idx   ON premises (premises_type, quarter_type);

-- Inspection queue ordering (FRS 5.4): non-residential first,
-- then quarters D -> C -> B -> MQ -> A. Held as data, not code,
-- so the department can re-order without a deployment.
-- quarter_type is NULL for non-residential premises, so it cannot sit in
-- a primary key. UNIQUE NULLS NOT DISTINCT (PG15+) gives the intended
-- one-row-per-combination guarantee while allowing the NULL.
CREATE TABLE inspection_sort_rank (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    premises_type   premises_type NOT NULL,
    quarter_type    quarter_type NULL,
    rank            integer NOT NULL,
    UNIQUE NULLS NOT DISTINCT (premises_type, quarter_type)
);

-- Three tiers rather than "all non-residential first":
--   10s  essential public services — a closed dispensary or school
--        affects hundreds of people at once
--   20s  quarters, in the departmentally fixed order D -> C -> B -> MQ -> A
--   30s  discretionary non-residential — a club or union office does not
--        outrank a household without water
INSERT INTO inspection_sort_rank (premises_type, quarter_type, rank) VALUES
    ('DISPENSARY',     NULL, 10), ('SCHOOL',         NULL, 11),
    ('HOSTEL',         NULL, 12),
    ('QUARTER', 'D',  20), ('QUARTER', 'C',  21), ('QUARTER', 'B',  22),
    ('QUARTER', 'MQ', 23), ('QUARTER', 'A',  24),
    ('ADMIN_BUILDING', NULL, 30), ('GUEST_HOUSE',    NULL, 31),
    ('UNION_OFFICE',   NULL, 32), ('CLUB',           NULL, 33),
    ('OTHER',          NULL, 34);


-- =====================================================================
-- 4. PEOPLE, ROLES AND AUTHENTICATORS  (decision 2026-09-30)
--
-- A USER is a person. What they may do comes from their ROLE ASSIGNMENTS,
-- and a person may hold several at once: an Overseer is also the resident
-- of a quarter, an Incharge may be acting Overseer for a fortnight. How
-- they prove who they are is a separate matter — an approved device
-- (hardware-bound key), or Employee ID + password on the web.
--
-- Every request acts in exactly ONE assignment, chosen after sign-in, so
-- row-level security, the transition table and field authority keep
-- their single-role shape. The assignment id is the actor recorded on
-- every act, so the record says in which capacity something was done.
-- =====================================================================

CREATE TABLE person (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- the Employee ID used at sign-in: NCL's 8-digit number. NULL for
    -- Non-NCL residents and contractor staff, who have none.
    personnel_no    text UNIQUE
                    CONSTRAINT employee_id_8_digits CHECK (personnel_no ~ '^[0-9]{8}$'),
    name            text NOT NULL,
    designation     text NULL,
    grade           text NULL,
    mobile          text NOT NULL,
    email           text NULL,
    is_employee     boolean NOT NULL DEFAULT true,
    resident_category text NOT NULL DEFAULT 'NCL'
                    CHECK (resident_category IN ('NCL','NON_NCL')),
    -- Employee ID + password (web). scrypt; never the password itself.
    password_hash   text NULL,
    password_set_at timestamptz NULL,
    failed_logins   integer NOT NULL DEFAULT 0,
    locked_until    timestamptz NULL,
    hr_synced_at    timestamptz NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- A Non-NCL resident has no Employee ID and uses the app only
    -- (decision 2026-09-30), so they can never hold a web password.
    CONSTRAINT password_needs_employee_id CHECK (
        password_hash IS NULL OR (personnel_no IS NOT NULL AND is_employee))
);
CREATE INDEX person_personnel_no ON person (personnel_no);
CREATE INDEX person_mobile       ON person (mobile);

-- Rank of each role. An Area administrator may assign only roles BELOW
-- their own rank, and only within their own Area.
CREATE TABLE role_level (
    role            principal_role PRIMARY KEY,
    level           integer NOT NULL,
    hq              boolean NOT NULL DEFAULT false,   -- all Areas, read-only on complaints
    accountable     boolean NOT NULL,                  -- needs PIN/biometric in the app (decision 15)
    occupant        boolean NOT NULL DEFAULT false     -- bound to a premises
);
INSERT INTO role_level (role, level, hq, accountable, occupant) VALUES
    ('RESIDENT',              1, false, false, true),
    ('CUSTODIAN',             1, false, false, true),
    ('CONTRACTOR',            2, false, true,  false),
    ('CONTRACTOR_SUPERVISOR', 2, false, true,  false),
    ('CIVIL_OVERSEER',        3, false, true,  false),
    ('MAINTENANCE_INCHARGE',  4, false, true,  false),
    ('STAFF_OFFICER_CIVIL',   5, false, true,  false),
    ('AREA_HR_ADMIN',         6, false, true,  false),
    ('AREA_SYS_ADMIN',        6, false, true,  false),
    ('GM_CIVIL',              8, true,  true,  false),
    ('HQ_EXECUTIVE',          8, true,  true,  false),
    ('ADMINISTRATOR',         9, true,  true,  false);

CREATE TYPE assignment_status AS ENUM ('PENDING', 'ACTIVE', 'REJECTED', 'REVOKED');

CREATE TABLE role_assignment (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    person_id           uuid NOT NULL REFERENCES person(id),
    role                principal_role NOT NULL,
    scope_path          ltree NOT NULL,            -- what this role may see
    premises_id         uuid NULL REFERENCES premises(id),   -- occupant roles
    contract_id         uuid NULL,   -- contractor roles; the contract lives in
                                     -- the maintenance database, so no FK
    designation         text NULL,   -- e.g. "Dy. Manager (Civil)", "Director (Technical)"
    acting              boolean NOT NULL DEFAULT false,   -- covering for another officer
    valid_from          date NOT NULL DEFAULT current_date,
    valid_to            date NULL,                 -- NULL = until revoked
    status              assignment_status NOT NULL DEFAULT 'PENDING',

    -- Registration as submitted, before the Incharge corrects it (FRS 4.4)
    submitted_colony_id uuid NULL REFERENCES colony(id),
    submitted_sector    text NULL,
    submitted_identifier text NULL,

    assigned_by         uuid NULL REFERENCES role_assignment(id),
    reason              text NULL,
    approved_by         uuid NULL REFERENCES role_assignment(id),
    approved_at         timestamptz NULL,
    rejected_reason     text NULL,
    revoked_by          uuid NULL REFERENCES role_assignment(id),
    revoked_at          timestamptz NULL,
    revocation_reason   text NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),

    -- An ACTIVE occupant role must be bound to a premises. A PENDING one
    -- cannot be: the premises record is created when the registration is
    -- approved, which is how the premises master is built. (A rule written
    -- for the final state and applied to the intermediate one made
    -- registration impossible once already.)
    CONSTRAINT occupant_needs_premises CHECK (
        status <> 'ACTIVE' OR role NOT IN ('RESIDENT','CUSTODIAN') OR premises_id IS NOT NULL),
    CONSTRAINT revocation_needs_reason CHECK (
        status <> 'REVOKED' OR revocation_reason IS NOT NULL),
    CONSTRAINT valid_period CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE INDEX assignment_person ON role_assignment (person_id) WHERE status = 'ACTIVE';
CREATE INDEX assignment_scope  ON role_assignment USING gist (scope_path);
CREATE INDEX assignment_prem   ON role_assignment (premises_id) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX assignment_one_active
    ON role_assignment (person_id, role, scope_path, coalesce(premises_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE status IN ('PENDING','ACTIVE');

-- A usable assignment: active and inside its validity period.
CREATE OR REPLACE FUNCTION assignment_in_force(a role_assignment) RETURNS boolean AS $$
    SELECT a.status = 'ACTIVE' AND a.valid_from <= current_date
       AND (a.valid_to IS NULL OR a.valid_to >= current_date);
$$ LANGUAGE sql STABLE;

-- An authenticator. An approved installation of the app holds a
-- hardware-bound key (FRS 4.2); only the public key is stored, so a
-- stolen database row grants nothing. The device proves WHO — roles come
-- from the person's assignments.
CREATE TABLE device (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    public_key          text NOT NULL UNIQUE,
    key_algorithm       text NOT NULL DEFAULT 'ES256',
    platform            text NOT NULL,            -- 'android' | 'ios' | 'web'
    person_id           uuid NOT NULL REFERENCES person(id),
    scope_path          ltree NOT NULL,           -- where it was registered: who approves it
    status              device_status NOT NULL DEFAULT 'PENDING',
    approved_by         uuid NULL REFERENCES role_assignment(id),
    approved_at         timestamptz NULL,
    rejected_reason     text NULL,
    revoked_by          uuid NULL REFERENCES role_assignment(id),
    revoked_at          timestamptz NULL,
    revocation_reason   text NULL,
    last_seen_at        timestamptz NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT revocation_needs_reason CHECK (
        status <> 'REVOKED' OR revocation_reason IS NOT NULL)
);
CREATE INDEX device_scope_gist ON device USING gist (scope_path);
CREATE INDEX device_person     ON device (person_id) WHERE status = 'ACTIVE';

-- Maximum active occupants per premises (FRS 4.2, default 3, configurable).
-- Counted over occupant ASSIGNMENTS now that a person, not a handset, is
-- the resident.
CREATE OR REPLACE FUNCTION enforce_occupant_limit() RETURNS trigger AS $$
DECLARE limit_val integer; current_count integer;
BEGIN
    IF NEW.status <> 'ACTIVE' OR NEW.premises_id IS NULL
       OR NEW.role NOT IN ('RESIDENT','CUSTODIAN') THEN
        RETURN NEW;
    END IF;
    SELECT value::integer INTO limit_val FROM config WHERE key = 'max_active_devices_per_premises';
    SELECT count(*) INTO current_count FROM role_assignment
     WHERE premises_id = NEW.premises_id AND status = 'ACTIVE'
       AND role IN ('RESIDENT','CUSTODIAN') AND id <> NEW.id;
    IF current_count >= coalesce(limit_val, 3) THEN
        RAISE EXCEPTION 'occupant limit reached for premises %', NEW.premises_id
              USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- One-time challenges for signature-based authentication.
CREATE TABLE auth_challenge (
    nonce           text PRIMARY KEY,
    device_id       uuid NOT NULL REFERENCES device(id),
    issued_at       timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    consumed_at     timestamptz NULL
);

-- OTP proves a handset holds a number: at registration, when setting a
-- web password, and for recovery. Never a sign-in method on its own.
CREATE TABLE otp_request (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    mobile          text NOT NULL,
    code_hash       text NOT NULL,
    attempts        integer NOT NULL DEFAULT 0,
    expires_at      timestamptz NOT NULL,
    consumed_at     timestamptz NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    -- the registration token this OTP earned is good for one use: one phone
    -- registered, or one password set (open defect 8, confirmed and closed
    -- by the break-it pass, 2026-10-08)
    token_used_at   timestamptz NULL
);
CREATE INDEX otp_mobile ON otp_request (mobile, created_at DESC);

-- Every sign-in attempt, successful or not: the record that says who got
-- in, how, and who was refused.
CREATE TABLE sign_in_log (
    id              bigserial PRIMARY KEY,
    occurred_at     timestamptz NOT NULL DEFAULT now(),
    person_id       uuid NULL,
    device_id       uuid NULL,
    method          text NOT NULL,     -- device | password | refresh | role-switch
    assignment_id   uuid NULL,
    success         boolean NOT NULL,
    detail          text NULL
);


-- =====================================================================
-- 6. CONFIGURATION  (FRS 15 — nothing operational is hard-coded)
-- =====================================================================

CREATE TABLE config (
    key             text PRIMARY KEY,
    value           text NOT NULL,
    data_type       text NOT NULL,
    description     text NOT NULL,
    updated_by      uuid NULL,
    updated_at      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO config (key, value, data_type, description) VALUES
 ('max_active_devices_per_premises','3','integer','Active occupants per premises'),
 ('access_token_ttl_minutes','15','integer','Access token lifetime'),
 ('otp_ttl_minutes','10','integer','OTP validity'),
 ('otp_max_attempts','5','integer','OTP attempts before lockout'),
 ('password_min_length','10','integer','Minimum web password length'),
 ('password_max_failures','5','integer','Failed password attempts before a lock'),
 ('password_lock_minutes','15','integer','How long a locked account stays locked'),
 ('retention_years','2','integer','Document and audit retention (FRS 13)'),
 ('overseers_per_area','3','integer','Civil Overseer accounts provisioned per Area');

CREATE TRIGGER occupant_limit_check
    BEFORE INSERT OR UPDATE ON role_assignment
    FOR EACH ROW EXECUTE FUNCTION enforce_occupant_limit();


-- =====================================================================
-- 7. AUDIT LOG  — append-only, hash-chained
--
-- FRS 13.3: not editable by ANY role, administrator included.
-- =====================================================================

CREATE TABLE audit_log (
    id              bigserial PRIMARY KEY,
    occurred_at     timestamptz NOT NULL DEFAULT now(),
    actor_id        uuid NULL,          -- the role assignment acted in
    actor_person_id uuid NULL,
    actor_role      principal_role NULL,
    event_type      text NOT NULL,
    entity_type     text NOT NULL,
    entity_id       uuid NULL,
    area_id         uuid NULL,
    before_value    jsonb NULL,
    after_value     jsonb NULL,
    reason          text NULL,
    prev_hash       text NULL,
    row_hash        text NOT NULL
);
CREATE INDEX audit_entity   ON audit_log (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_actor    ON audit_log (actor_person_id, occurred_at DESC);
CREATE INDEX audit_occurred ON audit_log (occurred_at DESC);

CREATE OR REPLACE FUNCTION audit_chain() RETURNS trigger AS $$
DECLARE prev text;
BEGIN
    SELECT row_hash INTO prev FROM audit_log ORDER BY id DESC LIMIT 1;
    NEW.prev_hash := prev;
    NEW.row_hash := encode(digest(
        coalesce(prev,'') || NEW.occurred_at::text || NEW.event_type ||
        NEW.entity_type || coalesce(NEW.entity_id::text,'') ||
        coalesce(NEW.actor_id::text,'') ||
        coalesce(NEW.after_value::text,''), 'sha256'), 'hex');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_chain_trigger
    BEFORE INSERT ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_chain();

-- A REVOKE can be undone by a later blanket GRANT; a trigger cannot.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION '% is append-only and cannot be modified', TG_TABLE_NAME
        USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_immutable
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER sign_in_log_immutable
    BEFORE UPDATE OR DELETE ON sign_in_log
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Reserved event types, unused in Phase 1:
--   ALLOTTED, VACATED, TRANSFERRED, REGULARISED, RECLASSIFIED


-- =====================================================================
-- 8. ROW-LEVEL SECURITY  (FRS 2.4 — isolation below the UI)
--
-- The application sets, per transaction, from the token and nothing else:
--     app.role, app.scope_path, app.actor_id (the assignment),
--     app.person_id, app.premises_id, app.device_id, app.auth_method
-- =====================================================================

CREATE OR REPLACE FUNCTION current_scope() RETURNS ltree AS $$
    SELECT nullif(current_setting('app.scope_path', true), '')::ltree;
$$ LANGUAGE sql STABLE;
CREATE OR REPLACE FUNCTION current_actor() RETURNS uuid AS $$
    SELECT nullif(current_setting('app.actor_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;
CREATE OR REPLACE FUNCTION current_person() RETURNS uuid AS $$
    SELECT nullif(current_setting('app.person_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;
CREATE OR REPLACE FUNCTION current_level() RETURNS integer AS $$
    SELECT level FROM role_level WHERE role::text = current_setting('app.role', true);
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION is_hq() RETURNS boolean AS $$
    SELECT EXISTS (SELECT 1 FROM role_level
                    WHERE role::text = current_setting('app.role', true) AND hq);
$$ LANGUAGE sql STABLE;
CREATE OR REPLACE FUNCTION is_area_admin() RETURNS boolean AS $$
    SELECT current_setting('app.role', true) IN ('AREA_HR_ADMIN','AREA_SYS_ADMIN','ADMINISTRATOR');
$$ LANGUAGE sql STABLE;

ALTER TABLE premises        ENABLE ROW LEVEL SECURITY;
ALTER TABLE device          ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE premises        FORCE ROW LEVEL SECURITY;
ALTER TABLE device          FORCE ROW LEVEL SECURITY;
ALTER TABLE role_assignment FORCE ROW LEVEL SECURITY;

CREATE POLICY premises_scope ON premises
    USING (is_hq() OR current_setting('app.role', true) = 'SYSTEM' OR scope_path <@ current_scope());
-- HQ is read-only on operational data, except the portal administrator.
CREATE POLICY premises_write ON premises
    AS RESTRICTIVE FOR UPDATE
    USING (current_setting('app.role', true) IN ('SYSTEM','ADMINISTRATOR')
           OR (NOT is_hq() AND scope_path <@ current_scope()));
-- Premises records are created at approval or by the Area HR office.
CREATE POLICY premises_write_authority ON premises
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (current_setting('app.role', true)
                IN ('MAINTENANCE_INCHARGE','AREA_HR_ADMIN','AREA_SYS_ADMIN','ADMINISTRATOR','SYSTEM'));

-- A person always sees their own devices and assignments (the role
-- picker needs them); officers see those in their scope.
CREATE POLICY device_scope ON device USING (
    is_hq() OR current_setting('app.role', true) IN ('SYSTEM','AUTH')
    OR person_id = current_person() OR scope_path <@ current_scope());
CREATE POLICY assignment_scope ON role_assignment USING (
    is_hq() OR current_setting('app.role', true) IN ('SYSTEM','AUTH')
    OR person_id = current_person() OR scope_path <@ current_scope());

-- ---------------------------------------------------------------------
-- DEVICE WRITE AUTHORITY
-- Approving, rejecting and revoking a device: the Incharge (for
-- occupants' devices) and the Area administrators. Visibility is not
-- authority — without this a resident could approve their own device.
-- ---------------------------------------------------------------------
CREATE POLICY device_write_authority ON device
    AS RESTRICTIVE FOR UPDATE
    USING (current_setting('app.role', true)
           IN ('MAINTENANCE_INCHARGE','AREA_HR_ADMIN','AREA_SYS_ADMIN','ADMINISTRATOR','SYSTEM','AUTH'));

-- ---------------------------------------------------------------------
-- WHO MAY GRANT WHICH ROLE  (decision 2026-09-30)
--
-- Only Area administrators assign roles, only within their own Area and
-- only BELOW their own rank; the HQ portal administrator assigns the Area
-- administrators and the HQ roles, and — decided 2026-10-09 — any other
-- role below their rank, in a chosen Area, to fill a gap. The one exception is the resident and
-- custodian registration a person makes themselves, which the Incharge
-- verifies (FRS 4.4) — that approves a request, it grants nothing new.
-- Nobody may grant, approve or change a role of their own. Found and
-- enforced here, not in the application, so a new screen cannot forget.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_assignment_authority() RETURNS trigger AS $$
DECLARE
    actor      text    := current_setting('app.role', true);
    my_level   integer := current_level();
    new_level  integer;
BEGIN
    -- Every role below HQ is held in one Area (control 3), whoever writes
    -- it, the system included. Found 2026-10-09 on live data: a role assigned
    -- by the HQ portal administrator with no Area chosen took the
    -- administrator's own scope — an Incharge, and a supervisor, of every
    -- Area. Checked when a role is granted or its scope moves, so a wrong one
    -- already held can still be revoked.
    IF (TG_OP = 'INSERT' OR NEW.scope_path IS DISTINCT FROM OLD.scope_path)
       AND NOT (SELECT hq FROM role_level WHERE role = NEW.role)
       AND NOT EXISTS (SELECT 1 FROM area a WHERE NEW.scope_path <@ a.scope_path) THEN
        RAISE EXCEPTION 'a % role is held in one Area; choose the Area', NEW.role
            USING ERRCODE = 'check_violation';
    END IF;
    IF actor = 'SYSTEM' THEN
        RETURN NEW;
    END IF;
    SELECT level INTO new_level FROM role_level WHERE role = NEW.role;

    IF TG_OP = 'UPDATE' THEN
        IF NEW.role IS DISTINCT FROM OLD.role OR NEW.person_id IS DISTINCT FROM OLD.person_id THEN
            RAISE EXCEPTION 'an assignment''s role and person are fixed; revoke it and assign anew'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
    END IF;

    -- a registration a person submits for themselves: pending, occupant only
    IF TG_OP = 'INSERT' AND NEW.status = 'PENDING' AND actor = 'AUTH' THEN
        IF NEW.role NOT IN ('RESIDENT','CUSTODIAN') THEN
            RAISE EXCEPTION 'only a resident or custodian role can be requested at registration'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.person_id = current_person() THEN
        RAISE EXCEPTION 'nobody may grant, approve or change a role of their own'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    -- The Incharge verifies occupant registrations within the colony
    -- scope, and — decision 2026-09-30 — creates, changes and ends the
    -- contractor's supervisors on the work orders they keep. That role
    -- only, in their own Area, and always on a work order: a supervisor on
    -- no contract would do work that counts against nobody.
    IF actor = 'MAINTENANCE_INCHARGE' THEN
        IF NEW.role IN ('RESIDENT','CUSTODIAN') AND TG_OP = 'UPDATE' THEN
            RETURN NEW;
        END IF;
        IF NEW.role = 'CONTRACTOR_SUPERVISOR' AND NEW.contract_id IS NOT NULL
           AND NEW.scope_path <@ current_scope() THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'the Incharge approves residents and custodians and appoints contractor supervisors on the Area''s work orders; other roles are assigned by the Area administrators'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF NOT is_area_admin() THEN
        RAISE EXCEPTION 'only an Area administrator assigns roles'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- below their own rank for every change, not only a new grant: an
    -- Area administrator may not extend or revoke a colleague of equal rank
    IF new_level >= my_level THEN
        RAISE EXCEPTION 'a % may assign or change only roles below their own', actor
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF actor <> 'ADMINISTRATOR' AND NOT (NEW.scope_path <@ current_scope()) THEN
        RAISE EXCEPTION 'an Area administrator assigns roles within their own Area only'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER assignment_authority
    BEFORE INSERT OR UPDATE ON role_assignment
    FOR EACH ROW EXECUTE FUNCTION enforce_assignment_authority();

-- ---------------------------------------------------------------------
-- WHO MAY APPROVE WHICH DEVICE
-- A device signs in as its person, in any of that person's roles. So a
-- phone belonging to someone who holds an official role is approved only
-- by an Area administrator; the Incharge approves occupants' phones.
-- Otherwise approving a device would be a way round who assigns roles.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_device_approval() RETURNS trigger AS $$
DECLARE actor text := current_setting('app.role', true);
BEGIN
    IF actor IN ('SYSTEM','AUTH') THEN
        RETURN NEW;
    END IF;
    IF NEW.person_id IS DISTINCT FROM OLD.person_id THEN
        RAISE EXCEPTION 'a device belongs to one person for life'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.status = 'PENDING' AND NEW.status = 'ACTIVE' THEN
        IF NEW.person_id = current_person() THEN
            RAISE EXCEPTION 'nobody may approve their own device'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
        -- the Incharge approves only the phones of people whose business
        -- here is theirs: a resident, a custodian, or a supervisor on the
        -- Area's work orders — never a phone with no such role, which an
        -- administrator might later give an official role
        IF actor = 'MAINTENANCE_INCHARGE' AND NOT EXISTS (
            SELECT 1 FROM role_assignment a
             WHERE a.person_id = NEW.person_id AND a.status IN ('ACTIVE','PENDING')
               AND a.role IN ('RESIDENT','CUSTODIAN','CONTRACTOR_SUPERVISOR')
               AND a.scope_path <@ current_scope()) THEN
            RAISE EXCEPTION 'the Incharge approves the phones of residents, custodians and contractor supervisors of the Area only; other phones are approved by the Area administrator'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
        -- the Incharge may approve the phone of a supervisor they appointed,
        -- but not of anyone holding any other official role
        IF NOT is_area_admin() AND EXISTS (
            SELECT 1 FROM role_assignment a
             WHERE a.person_id = NEW.person_id AND a.status = 'ACTIVE'
               AND a.role NOT IN ('RESIDENT','CUSTODIAN')
               AND NOT (actor = 'MAINTENANCE_INCHARGE' AND a.role = 'CONTRACTOR_SUPERVISOR'
                        AND a.scope_path <@ current_scope())) THEN
            RAISE EXCEPTION 'the device of an official or contractor is approved by the Area administrator'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER device_approval_authority
    BEFORE UPDATE ON device
    FOR EACH ROW EXECUTE FUNCTION enforce_device_approval();

-- the RLS insert/update gate that pairs with the trigger above
CREATE POLICY assignment_write ON role_assignment
    AS RESTRICTIVE FOR UPDATE
    USING (current_setting('app.role', true)
           IN ('MAINTENANCE_INCHARGE','AREA_HR_ADMIN','AREA_SYS_ADMIN','ADMINISTRATOR','SYSTEM','AUTH'));


-- ---------------------------------------------------------------------
-- PEOPLE — the directory, including mobile numbers. Visible where the
-- person holds an assignment or device in the caller's scope, or it is
-- the caller's own record. Created and edited by the Area HR office.
--
-- An Area administrator also sees people attached to no Area at all —
-- just entered, no role and no phone yet — or they could not assign the
-- first role. That test must look past row security (an assignment in
-- another Area is invisible, so everyone there would look unattached and
-- the whole company's directory would show; found 2026-09-30).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION person_unattached(p uuid) RETURNS boolean AS $$
    SELECT NOT EXISTS (SELECT 1 FROM identity.role_assignment a WHERE a.person_id = p)
       AND NOT EXISTS (SELECT 1 FROM identity.device d WHERE d.person_id = p);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = identity, public;

-- How many approved phones a person has registered in another Area (user's
-- decision, 2026-10-13). A person with roles in two Areas — a supervisor of
-- one living in the other — has a phone the other Area's administrator
-- cannot see (control 3), and the page read "no phone". This tells them only
-- the number, and only for someone holding a role in their own Area; the
-- phone itself stays with the Area it was registered in, and HQ.
CREATE OR REPLACE FUNCTION phones_elsewhere(p uuid) RETURNS integer AS $$
    SELECT count(*)::int FROM identity.device d
     WHERE d.person_id = p AND d.status = 'ACTIVE'
       AND NOT (d.scope_path <@ identity.current_scope())
       AND EXISTS (SELECT 1 FROM identity.role_assignment a
                    WHERE a.person_id = p AND a.scope_path <@ identity.current_scope());
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = identity, public;

ALTER TABLE person ENABLE ROW LEVEL SECURITY;
ALTER TABLE person FORCE ROW LEVEL SECURITY;

CREATE POLICY person_scope ON person USING (
    is_hq()
    OR current_setting('app.role', true) IN ('SYSTEM','AUTH')
    OR id = current_person()
    OR ((is_area_admin() OR current_setting('app.role', true) = 'MAINTENANCE_INCHARGE')
        AND person_unattached(id))
    OR EXISTS (SELECT 1 FROM role_assignment a WHERE a.person_id = person.id AND a.scope_path <@ current_scope())
    OR EXISTS (SELECT 1 FROM device d WHERE d.person_id = person.id AND d.scope_path <@ current_scope()));
CREATE POLICY person_write ON person
    AS RESTRICTIVE FOR UPDATE
    USING (current_setting('app.role', true) IN ('SYSTEM','AUTH','AREA_HR_ADMIN','AREA_SYS_ADMIN','ADMINISTRATOR'));


-- ---------------------------------------------------------------------
-- AUTHENTICATION INTERNALS — touched only by the sign-in service
-- ---------------------------------------------------------------------
ALTER TABLE otp_request    ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_challenge ENABLE ROW LEVEL SECURITY;
ALTER TABLE sign_in_log    ENABLE ROW LEVEL SECURITY;
ALTER TABLE otp_request    FORCE ROW LEVEL SECURITY;
ALTER TABLE auth_challenge FORCE ROW LEVEL SECURITY;
ALTER TABLE sign_in_log    FORCE ROW LEVEL SECURITY;

CREATE POLICY otp_auth_only       ON otp_request
    USING (current_setting('app.role', true) IN ('AUTH','SYSTEM'));
CREATE POLICY challenge_auth_only ON auth_challenge
    USING (current_setting('app.role', true) IN ('AUTH','SYSTEM'));
CREATE POLICY sign_in_read  ON sign_in_log FOR SELECT USING (
    current_setting('app.role', true) IN ('AUTH','SYSTEM','ADMINISTRATOR','AREA_SYS_ADMIN'));
CREATE POLICY sign_in_write ON sign_in_log FOR INSERT WITH CHECK (true);


-- ---------------------------------------------------------------------
-- AUDIT LOG — scoped by area
-- ---------------------------------------------------------------------
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_scope ON audit_log FOR SELECT USING (
    is_hq()
    OR current_setting('app.role', true) = 'SYSTEM'
    OR (is_area_admin() OR current_setting('app.role', true) = 'STAFF_OFFICER_CIVIL')
       AND area_id IN (SELECT id FROM area WHERE scope_path <@ current_scope()));
CREATE POLICY audit_insert ON audit_log FOR INSERT WITH CHECK (true);


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


-- =====================================================================
-- 9. GRANTS  — the audit log's immutability is enforced here
-- =====================================================================

DO $$ BEGIN
    CREATE ROLE app_identity NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
GRANT USAGE ON SCHEMA identity TO app_identity;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA identity TO app_identity;
REVOKE UPDATE, DELETE ON audit_log, sign_in_log FROM app_identity;
GRANT INSERT, SELECT ON audit_log, sign_in_log TO app_identity;

DO $$ BEGIN
    CREATE ROLE job_retention NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
GRANT DELETE ON audit_log TO job_retention;
