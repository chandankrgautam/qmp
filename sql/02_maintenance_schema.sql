-- =====================================================================
-- NCL Colony Maintenance Portal
-- B2 — DATA MODEL, PART 2 of 2
-- COLONY MAINTENANCE SERVICE  (separate database from identity)
--
-- Cross-service references (premises_id, actor ids) are uuid columns
-- WITHOUT foreign keys: they point into the identity database. See
-- premises_ref below for how joins and RLS still work.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "ltree";

CREATE SCHEMA IF NOT EXISTS maint;
SET search_path TO maint, public;


-- =====================================================================
-- 1. TYPES
-- =====================================================================

CREATE TYPE ticket_state AS ENUM (
    'RAISED', 'VERIFIED', 'ASSIGNED', 'IN_PROGRESS', 'WORK_COMPLETED',
    'INSPECTED_ACCEPTED', 'CLOSED', 'REJECTED', 'REWORK',
    'REFERRED_SPECIAL_REPAIR', 'REOPENED');

CREATE TYPE delay_attribution AS ENUM (
    'CONTRACTOR', 'DEPARTMENT', 'OCCUPANT', 'FORCE_MAJEURE');

CREATE TYPE clock_kind AS ENUM ('RESPONSE', 'COMPLETION');

CREATE TYPE premises_type AS ENUM (
    'QUARTER','GUEST_HOUSE','HOSTEL','UNION_OFFICE','ADMIN_BUILDING',
    'CLUB','DISPENSARY','SCHOOL','OTHER');

CREATE TYPE dept_classification AS ENUM ('CIVIL','EM');


-- =====================================================================
-- 2. PREMISES REFERENCE  (read-only projection from identity service)
--
-- WHY THIS EXISTS: row-level security must evaluate scope inside the
-- transaction, and it cannot reach across a database boundary to do it.
-- So the identity service pushes a minimal, read-only projection here.
--
-- Only the fields needed for scoping, routing and sorting. Never written
-- by this service. Kept current by event, with a periodic reconciliation
-- sweep as a backstop.
-- =====================================================================

CREATE TABLE premises_ref (
    premises_id         uuid PRIMARY KEY,
    area_id             uuid NOT NULL,
    area_code           text NOT NULL DEFAULT '',   -- AML, NGH, JNT, BINA…
    colony_id           uuid NOT NULL,
    scope_path          ltree NOT NULL,
    identifier          text NOT NULL,
    premises_type       premises_type NOT NULL,
    quarter_type        text NULL,
    occupancy_model     text NOT NULL,
    inspection_rank     integer NOT NULL,
    synced_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX premises_ref_scope ON premises_ref USING gist (scope_path);
CREATE INDEX premises_ref_rank  ON premises_ref (inspection_rank);


-- =====================================================================
-- 2A. ACTOR REFERENCE  (read-only projection from identity service)
--
-- An ACTOR is a role assignment: a person acting in one role (decision
-- 2026-09-30). Every act in this database — raising, verifying,
-- assigning, inspecting, photographing — is recorded against the actor,
-- so the record always says who did it AND in which capacity. The same
-- person as Resident and as Overseer is two actors.
--
-- Same contract as premises_ref: written only by the identity service,
-- maintained by logical replication, never written here.
-- =====================================================================

CREATE TABLE actor_ref (
    actor_id        uuid PRIMARY KEY,          -- identity.role_assignment.id
    person_id       uuid NOT NULL,
    person_name     text NULL,
    role            text NOT NULL,
    scope_path      ltree NOT NULL,
    premises_id     uuid NULL,
    contract_id     uuid NULL,
    status          text NOT NULL,
    language        text NOT NULL DEFAULT 'en',   -- picks the notification language
    synced_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX actor_ref_scope  ON actor_ref USING gist (scope_path);
CREATE INDEX actor_ref_role   ON actor_ref (role) WHERE status = 'ACTIVE';
CREATE INDEX actor_ref_prem   ON actor_ref (premises_id) WHERE status = 'ACTIVE';
CREATE INDEX actor_ref_person ON actor_ref (person_id);

-- Notification routing: every ACTIVE actor holding a given role whose
-- scope is an ancestor of (or equal to) the ticket's scope.
CREATE OR REPLACE FUNCTION actors_to_notify(p_role text, p_scope ltree)
RETURNS TABLE (actor_id uuid, language text) AS $$
    SELECT a.actor_id, a.language
      FROM actor_ref a
     WHERE a.status = 'ACTIVE'
       AND a.role = p_role
       AND p_scope <@ a.scope_path;
$$ LANGUAGE sql STABLE;

-- Occupants of a premises — every household member hears about it.
CREATE OR REPLACE FUNCTION occupants_at_premises(p_premises uuid)
RETURNS TABLE (actor_id uuid, language text) AS $$
    SELECT a.actor_id, a.language
      FROM actor_ref a
     WHERE a.status = 'ACTIVE'
       AND a.premises_id = p_premises
       AND a.role IN ('RESIDENT','CUSTODIAN');
$$ LANGUAGE sql STABLE;


-- =====================================================================
-- 3. CATEGORY MASTER  (FRS 7 — fully admin-editable)
-- =====================================================================

CREATE TABLE category (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code            text NOT NULL UNIQUE,
    name_en         text NOT NULL,
    name_hi         text NOT NULL,          -- editable at admin level (FRS 16.1)
    classification  dept_classification NOT NULL DEFAULT 'CIVIL',
    display_order   integer NOT NULL,
    active          boolean NOT NULL DEFAULT true
);

CREATE TABLE sub_category (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    category_id         uuid NOT NULL REFERENCES category(id),
    code                text NOT NULL UNIQUE,
    name_en             text NOT NULL,
    name_hi             text NOT NULL,
    classification      dept_classification NOT NULL DEFAULT 'CIVIL',
    emergency_eligible  boolean NOT NULL DEFAULT false,   -- FRS 8 control 1
    photo_required      boolean NOT NULL DEFAULT true,
    special_repair_path boolean NOT NULL DEFAULT false,   -- structural risk
    display_order       integer NOT NULL,
    active              boolean NOT NULL DEFAULT true
);
CREATE INDEX sub_category_cat ON sub_category (category_id) WHERE active;

-- SLA resolves per (sub_category, premises_type). A row with NULL
-- premises_type is the default; a typed row overrides it (FRS 7).
CREATE TABLE sla_rule (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sub_category_id     uuid NOT NULL REFERENCES sub_category(id),
    premises_type       premises_type NULL,
    response_minutes    integer NOT NULL,
    completion_minutes  integer NOT NULL,
    effective_from      timestamptz NOT NULL DEFAULT now(),
    changed_by          uuid NOT NULL,
    previous_response_minutes   integer NULL,
    previous_completion_minutes integer NULL,
    UNIQUE (sub_category_id, premises_type, effective_from)
);

-- Every SLA edit notifies the Staff Officer (Civil) and is flagged on the
-- contract performance report for the affected period, so a figure cannot
-- be revised mid-contract without the supervising officer seeing it.
--
-- SLA edits by the Incharge apply PROSPECTIVELY ONLY (FRS 7).
-- A ticket captures its SLA at verification; later edits cannot reach it.
-- effective_from + the snapshot on ticket make this structural, not
-- a matter of application discipline.


-- =====================================================================
-- 4. CONTRACTS  (FRS 10 — performance monitoring, not billing)
-- =====================================================================

-- The work order (decision 2026-09-30): filled in by the Civil Incharge.
-- An Area may have several at once; a complaint counts against the
-- contract of the supervisor it was assigned to (derived, never chosen).
CREATE TABLE contract (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    area_id             uuid NOT NULL,
    scope_path          ltree NOT NULL,
    contractor_name     text NOT NULL,          -- the firm
    firm_address        text NULL,
    contract_no         text NULL UNIQUE,       -- LOA / work order number
    agreement_no        text NOT NULL UNIQUE,
    work_name           text NULL,
    awarded_on          date NOT NULL,
    period_years        smallint NULL CHECK (period_years IN (1,2)),
    site_handover_on    date NULL,              -- site handed to the contractor
    starts_on           date NOT NULL,
    -- expires_on is the completion date in force: the date as awarded,
    -- moved only by a recorded extension. original_expires_on keeps the
    -- date as awarded for ever, so an extended contract can always be
    -- shown against its original term.
    expires_on          date NOT NULL,
    original_expires_on date NOT NULL,          -- filled by trigger at award
    remarks             text NULL,
    handover_cutoff_at  timestamptz NULL,   -- freezes performance record
    active              boolean NOT NULL DEFAULT true,
    CONSTRAINT completion_after_start CHECK (expires_on >= starts_on)
);
CREATE INDEX contract_area ON contract (area_id) WHERE active;


-- =====================================================================
-- 5. TICKET
--
-- SLA CLOCK DESIGN — the one genuinely awkward part of this model.
--
-- Elapsed time cannot be derived from timestamps, because the clock
-- pauses for occupant refusal and force majeure (FRS 9.3). Two candidate
-- designs:
--
--   (a) store pause segments, compute elapsed by summing them
--   (b) store a deadline and PUSH IT FORWARD when a pause ends
--
-- (b) is chosen. Reason: the most frequent query in the entire system is
-- "which tickets are overdue", run by the escalation job every few
-- minutes across all tickets. Under (a) that is a per-row aggregate over
-- a child table. Under (b) it is  WHERE deadline_at < now()  on a plain
-- btree index.
--
-- Pause segments are still recorded in sla_pause, but for audit and
-- attribution reporting, never for computing whether a ticket is late.
-- =====================================================================

CREATE TABLE ticket (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Format: <AREA>/<YYYY>/<NNNNN>  e.g. JAY/2026/04182
    -- Area code first (sayable over a telephone, identifies the office),
    -- calendar year second (matches government file convention),
    -- 5-digit sequence per area per year, reset each January.
    ticket_no           text NOT NULL UNIQUE,

    premises_id         uuid NOT NULL REFERENCES premises_ref(premises_id),
    area_id             uuid NOT NULL,
    scope_path          ltree NOT NULL,            -- denormalised for RLS
    inspection_rank     integer NOT NULL,          -- denormalised for queue sort

    sub_category_id     uuid NOT NULL REFERENCES sub_category(id),
    classification      dept_classification NOT NULL DEFAULT 'CIVIL',  -- FRS 12.2
    description         text NULL,                 -- free text, ~500 chars, searchable
    is_emergency        boolean NOT NULL DEFAULT false,

    state               ticket_state NOT NULL DEFAULT 'RAISED',
    contract_id         uuid NULL REFERENCES contract(id),

    -- actors (role assignments), so each act records its capacity
    raised_by           uuid NOT NULL,
    verified_by         uuid NULL,
    assigned_to         uuid NULL,                 -- contractor supervisor
    inspected_by        uuid NULL,

    raised_at           timestamptz NOT NULL DEFAULT now(),
    verified_at         timestamptz NULL,          -- BOTH SLA clocks start here
    assigned_at         timestamptz NULL,
    started_at          timestamptz NULL,
    completed_claim_at  timestamptz NULL,
    inspected_at        timestamptz NULL,
    closed_at           timestamptz NULL,

    -- SLA snapshot taken at verification. Immune to later SLA edits.
    sla_response_minutes    integer NULL,
    sla_completion_minutes  integer NULL,
    -- Original deadlines are IMMUTABLE. The *_deadline_at columns move when
    -- a pause resumes; these preserve what was promised at verification,
    -- so "was this late against the original commitment?" stays answerable.
    original_response_deadline_at   timestamptz NULL,
    original_completion_deadline_at timestamptz NULL,
    response_deadline_at    timestamptz NULL,
    completion_deadline_at  timestamptz NULL,
    total_paused_minutes    integer NOT NULL DEFAULT 0,
    response_met            boolean NULL,
    completion_met          boolean NULL,

    escalation_level    smallint NOT NULL DEFAULT 0,  -- 0..4
    reopened_count      smallint NOT NULL DEFAULT 0,
    objection_count     smallint NOT NULL DEFAULT 0,
    rework_count        smallint NOT NULL DEFAULT 0,
    referred_special_repair boolean NOT NULL DEFAULT false,

    -- Departmental override of inspection order. NULL = normal position.
    -- Lower value inspected sooner. Settable only by the Civil Overseer
    -- and the Maintenance Incharge (see ticket_field_authority): the
    -- contractor must never influence the order in which their own work
    -- is inspected.
    inspection_priority smallint NULL CHECK (inspection_priority BETWEEN 1 AND 9),
    inspection_priority_note text NULL,

    -- Archiving. A closed ticket leaves the working views after a
    -- configurable period, so dashboards and queues carry only live work
    -- and do not grow without bound. The row itself is NEVER moved or
    -- deleted: the premises file is the long-term asset, and every
    -- archived ticket remains retrievable through search.
    archived_at         timestamptz NULL,

    -- Contractor supervisor records the workmen allotted to this job.
    -- Free text by departmental decision; changes traced in ticket_event.
    workmen_assigned    text NULL,

    -- THE CONTRACTOR'S CLOCK (departmental decision, 2026-09-25).
    -- The contractor is measured only on time the job is in their hands:
    -- from assignment, from a send-back for rework, or from reassignment
    -- after a reopening, until their completion claim. Every round is
    -- added up, recorded occupant and force-majeure pauses inside those
    -- rounds are taken out, and the total is compared with the SLA fixed
    -- at verification. Time waiting on the department — verification,
    -- assignment, inspection — never counts against them. Both columns
    -- are maintained by trigger and belong to no human role.
    contractor_window_started_at timestamptz NULL,   -- NULL = not with the contractor
    contractor_minutes  integer NOT NULL DEFAULT 0,  -- completed rounds, net of pauses

    search_vector       tsvector,

    CONSTRAINT emergency_must_be_eligible CHECK (
        NOT is_emergency OR sub_category_id IS NOT NULL),
    -- Two-key rule. Special-repair work leaves the maintenance contract
    -- and is closed out by the Staff Officer, not by contractor
    -- inspection, so it is the one closure that carries no inspector.
    CONSTRAINT closed_requires_inspection CHECK (
        state <> 'CLOSED'
        OR inspected_by IS NOT NULL
        OR referred_special_repair),
    -- The two-key rule requires TWO keys. Checking only that the field is
    -- populated let a contractor name their own device as inspector.
    -- This checks the actor; the PERSON check (two roles, one person) is
    -- the trigger two_key_person below.
    CONSTRAINT inspector_is_not_the_contractor CHECK (
        inspected_by IS NULL
        OR assigned_to IS NULL
        OR inspected_by <> assigned_to)
);

-- The escalation job's hot path: one index, no aggregates.
CREATE INDEX ticket_overdue ON ticket (completion_deadline_at)
    WHERE state IN ('VERIFIED','ASSIGNED','IN_PROGRESS','REWORK');
CREATE INDEX ticket_response_overdue ON ticket (response_deadline_at)
    WHERE state IN ('VERIFIED','ASSIGNED');

-- The Overseer's inspection queue (FRS 5.4).
--
-- EVERY SORT TERM IS DEPARTMENTALLY CONTROLLED. The previous tiebreaker
-- was completed_claim_at — the moment the CONTRACTOR clicks "complete" —
-- which let the contractor order the Overseer's working day: claim the
-- trivial jobs first and they are inspected and closed first.
--
--   1  is_emergency          Overseer (downgrade authority)
--   2  inspection_priority   Overseer / Incharge, explicit override
--   3  inspection_rank       premises type, admin configuration
--   4  verified_at           when the OVERSEER verified the complaint
--
-- verified_at also makes the queue fairer to residents: oldest complaint
-- first, not oldest completion claim. NULLS LAST puts unprioritised work
-- after anything the department has explicitly pulled forward.
CREATE INDEX ticket_inspection_queue
    ON ticket (is_emergency DESC, inspection_priority NULLS LAST,
               inspection_rank, verified_at)
    WHERE state = 'WORK_COMPLETED';

CREATE INDEX ticket_scope    ON ticket USING gist (scope_path);
-- The GM's cross-area dashboard aggregates every open ticket in twelve
-- Areas. Measured at 90,000 tickets it sequential-scanned in 143 ms and
-- would grow linearly with history; this keeps it on the open tail.
-- Live work only: dashboards and queues never touch archived rows.
CREATE INDEX ticket_open_by_area ON ticket (area_id, state)
    WHERE archived_at IS NULL AND state NOT IN ('CLOSED','REJECTED');

-- Archive sweep: closed long enough to leave the working views.
CREATE INDEX ticket_archivable ON ticket (closed_at)
    WHERE archived_at IS NULL AND state IN ('CLOSED','REJECTED');

-- ---------------------------------------------------------------------
-- SEARCH INDEXES
--
-- Search covers EVERY ticket, archived or not. Archiving removes rows
-- from the working views; it must never remove them from the record.
-- These indexes support the filters the department asked for.
-- ---------------------------------------------------------------------
CREATE INDEX ticket_search_premises ON ticket (premises_id, raised_at DESC);
CREATE INDEX ticket_search_area     ON ticket (area_id, raised_at DESC);
CREATE INDEX ticket_search_subcat   ON ticket (sub_category_id, raised_at DESC);
CREATE INDEX ticket_search_state    ON ticket (state, raised_at DESC);
CREATE INDEX ticket_search_raised   ON ticket (raised_at DESC);
CREATE INDEX ticket_search_contract ON ticket (contract_id, raised_at DESC);
CREATE INDEX ticket_search_assigned ON ticket (assigned_to, raised_at DESC);
CREATE INDEX ticket_search_emergency ON ticket (is_emergency, raised_at DESC)
    WHERE is_emergency;
CREATE INDEX ticket_premises ON ticket (premises_id, raised_at DESC);
CREATE INDEX ticket_contract ON ticket (contract_id, state);
CREATE INDEX ticket_search   ON ticket USING gin (search_vector);

-- Duplicate detection (FRS 5.3): one open ticket per premises+subcategory.
CREATE UNIQUE INDEX ticket_no_duplicates
    ON ticket (premises_id, sub_category_id)
    WHERE state IN ('RAISED','VERIFIED','ASSIGNED','IN_PROGRESS','REWORK');


-- Per-area, per-year ticket sequence. The row is locked for the duration
-- of the allocating transaction, keeping numbering gapless under load.
-- Allocation MUST occur inside the ticket insert transaction, so a
-- rolled-back ticket does not consume a number.
CREATE TABLE ticket_sequence (
    area_code       text NOT NULL,
    year            smallint NOT NULL,
    last_value      integer NOT NULL DEFAULT 0,
    PRIMARY KEY (area_code, year)
);


-- =====================================================================
-- 6. SLA PAUSES AND DELAY ATTRIBUTION
--
-- "Awaiting material" is deliberately absent: material is the
-- contractor's obligation under the comprehensive contract (FRS 9.3).
-- =====================================================================

CREATE TABLE sla_pause (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id       uuid NOT NULL REFERENCES ticket(id),
    clock           clock_kind NOT NULL,
    attribution     delay_attribution NOT NULL,
    reason          text NOT NULL,
    paused_at       timestamptz NOT NULL DEFAULT now(),
    paused_by       uuid NOT NULL,
    resumed_at      timestamptz NULL,
    resumed_by      uuid NULL,
    paused_by_role  text NOT NULL,
    CONSTRAINT only_pausing_attributions CHECK (
        attribution IN ('OCCUPANT','FORCE_MAJEURE')),
    -- The contractor must never be able to stop a clock they are measured
    -- against. Only a departmental officer may record a pause.
    CONSTRAINT pause_by_department_only CHECK (
        paused_by_role IN ('CIVIL_OVERSEER','MAINTENANCE_INCHARGE',
                           'STAFF_OFFICER_CIVIL'))
);
CREATE INDEX sla_pause_open ON sla_pause (ticket_id) WHERE resumed_at IS NULL;

-- On resume, push the deadline forward by the paused duration.
CREATE OR REPLACE FUNCTION resume_sla_clock() RETURNS trigger AS $$
DECLARE paused interval;
BEGIN
    IF OLD.resumed_at IS NULL AND NEW.resumed_at IS NOT NULL THEN
        paused := NEW.resumed_at - NEW.paused_at;
        IF NEW.clock = 'RESPONSE' THEN
            UPDATE ticket
               SET response_deadline_at = response_deadline_at + paused,
                   total_paused_minutes = total_paused_minutes
                                        + (extract(epoch FROM paused)/60)::integer
             WHERE id = NEW.ticket_id;
        ELSE
            UPDATE ticket
               SET completion_deadline_at = completion_deadline_at + paused,
                   total_paused_minutes = total_paused_minutes
                                        + (extract(epoch FROM paused)/60)::integer
             WHERE id = NEW.ticket_id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sla_resume AFTER UPDATE ON sla_pause
    FOR EACH ROW EXECUTE FUNCTION resume_sla_clock();

-- Attribution recorded at each breach, for contract reporting (FRS 9.3).
CREATE TABLE sla_breach (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id       uuid NOT NULL REFERENCES ticket(id),
    clock           clock_kind NOT NULL,
    breached_at     timestamptz NOT NULL DEFAULT now(),
    attribution     delay_attribution NULL,     -- set by Overseer/Incharge
    attributed_by   uuid NULL,
    attributed_at   timestamptz NULL,
    note            text NULL
);
CREATE INDEX sla_breach_ticket ON sla_breach (ticket_id);
CREATE INDEX sla_breach_unattributed ON sla_breach (breached_at)
    WHERE attribution IS NULL;


-- =====================================================================
-- 7. TICKET EVENTS, OBJECTIONS, MEDIA
-- =====================================================================

CREATE TABLE ticket_event (
    id              bigserial PRIMARY KEY,
    ticket_id       uuid NOT NULL REFERENCES ticket(id),
    from_state      ticket_state NULL,
    to_state        ticket_state NULL,
    event_type      text NOT NULL,
    actor_id        uuid NOT NULL,          -- the role assignment acted in
    actor_role      text NOT NULL,
    reason          text NULL,                  -- mandatory on reject/downgrade
    -- What the complaint looked like at this step, kept with the step: the
    -- workmen named when work started, the supervisor it went to, the
    -- occupant's answer. The ticket row only holds the latest of these, so
    -- without this a reopened job lost its earlier rounds (found 2026-10-07).
    detail          jsonb NULL,
    -- How the session that acted signed in: 'device' (the app), 'password' or
    -- 'passkey' (an officer on the web), 'otp' (contractor staff on the web).
    -- Set from the session, never by the caller; officers see "from the web"
    -- (user's decision, 2026-10-16).
    via             text NULL DEFAULT nullif(current_setting('app.auth_method', true), ''),
    occurred_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ticket_event_ticket ON ticket_event (ticket_id, occurred_at);

-- FRS 5.5 — raised WHILE work is in progress, notified to Overseer and
-- Incharge but NOT the contractor. Does not change ticket state.
CREATE TABLE ticket_objection (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id           uuid NOT NULL REFERENCES ticket(id),
    raised_by           uuid NOT NULL,
    note                text NOT NULL,
    raised_at           timestamptz NOT NULL DEFAULT now(),
    response_deadline_at timestamptz NOT NULL,  -- 24 hr departmental SLA
    responded_by        uuid NULL,
    responded_at        timestamptz NULL,
    response_note       text NULL
);
CREATE INDEX objection_open ON ticket_objection (response_deadline_at)
    WHERE responded_at IS NULL;

-- Photographs. Geo-tag and timestamp are embedded AT CAPTURE by the app
-- and verified server-side; gallery upload is refused (FRS 5.4, 16.3).
CREATE TABLE ticket_media (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id       uuid NOT NULL REFERENCES ticket(id),
    objection_id    uuid NULL REFERENCES ticket_objection(id),
    purpose         text NOT NULL,      -- COMPLAINT | COMPLETION | INSPECTION | OBJECTION
    storage_key     text NOT NULL,      -- MinIO object key
    content_hash    text NOT NULL,      -- SHA-256, detects substitution
    captured_at     timestamptz NOT NULL,
    latitude        numeric(9,6) NULL,
    longitude       numeric(9,6) NULL,
    gps_accuracy_m  numeric(6,2) NULL,
    capture_verified boolean NOT NULL DEFAULT false,
    uploaded_by     uuid NOT NULL,
    uploaded_at     timestamptz NOT NULL DEFAULT now(),
    purge_after     timestamptz NOT NULL,    -- 2-year retention (FRS 13)

    -- Upload lifecycle. A row is created when the pre-signed URL is
    -- issued and only becomes usable once the bytes have arrived and been
    -- checked, so a client cannot claim a photograph it never uploaded.
    upload_state    text NOT NULL DEFAULT 'PENDING'
                    CHECK (upload_state IN ('PENDING','STORED','FAILED')),
    size_bytes      integer NULL,

    -- The bytes are the expensive part and are purged on their own
    -- schedule. The row survives with its hash, geo-tag and timestamp:
    -- the record that an inspection happened, where and when, outlives
    -- the image itself.
    bytes_purged_at timestamptz NULL,
    -- The geo-tag is required of a STORED inspection photograph. A PENDING
    -- row is created when the upload URL is issued, before any image or
    -- coordinates exist, so applying this to every row made an inspection
    -- photograph impossible to begin uploading.
    CONSTRAINT inspection_needs_geotag CHECK (
        upload_state <> 'STORED'
        OR purpose <> 'INSPECTION'
        OR (latitude IS NOT NULL AND longitude IS NOT NULL AND capture_verified)),
    -- A stored photograph must know how big it is; a pending one cannot.
    CONSTRAINT stored_has_size CHECK (
        upload_state <> 'STORED' OR size_bytes IS NOT NULL)
);
-- Only a STORED photograph counts: the lifecycle gates that check the
-- presence of an image must not be satisfied by an upload that never
-- completed.
CREATE INDEX media_ticket ON ticket_media (ticket_id, purpose)
    WHERE upload_state = 'STORED';
CREATE INDEX media_purge  ON ticket_media (purge_after)
    WHERE bytes_purged_at IS NULL;
CREATE UNIQUE INDEX media_storage_key ON ticket_media (storage_key);

-- Resident/custodian confirmation and rating. Absent for DEPARTMENT_ONLY.
CREATE TABLE ticket_feedback (
    ticket_id       uuid PRIMARY KEY REFERENCES ticket(id),
    confirmed       boolean NULL,           -- NULL = no response, auto-closed
    disputed        boolean NOT NULL DEFAULT false,
    rating          smallint NULL CHECK (rating BETWEEN 1 AND 5),
    comment         text NULL,
    actor_id        uuid NOT NULL,
    submitted_at    timestamptz NOT NULL DEFAULT now(),
    reopen_window_ends_at timestamptz NOT NULL   -- 1 day (FRS 5.1)
);


-- =====================================================================
-- 8. ESCALATION  (FRS 9.2 — four levels, repeats until acted on)
-- =====================================================================

CREATE TABLE escalation_rule (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    level           smallint NOT NULL CHECK (level BETWEEN 1 AND 4),
    is_emergency    boolean NOT NULL,
    minutes_after_breach integer NOT NULL,
    notify_role     text NOT NULL,
    UNIQUE (level, is_emergency)
);

INSERT INTO escalation_rule (level, is_emergency, minutes_after_breach, notify_role) VALUES
    (1, true,     0, 'CIVIL_OVERSEER'),      (1, false,     0, 'CIVIL_OVERSEER'),
    (2, true,   120, 'MAINTENANCE_INCHARGE'),(2, false,  1440, 'MAINTENANCE_INCHARGE'),
    (3, true,   360, 'STAFF_OFFICER_CIVIL'), (3, false,  4320, 'STAFF_OFFICER_CIVIL'),
    (4, true,   720, 'GM_CIVIL'),            (4, false, 10080, 'GM_CIVIL');

CREATE TABLE escalation_event (
    id              bigserial PRIMARY KEY,
    ticket_id       uuid NOT NULL REFERENCES ticket(id),
    level           smallint NOT NULL,
    triggered_at    timestamptz NOT NULL DEFAULT now(),
    attribution     delay_attribution NULL,
    acknowledged_by uuid NULL,
    acknowledged_at timestamptz NULL,
    remark          text NULL               -- mandatory at L4 before closure
);
CREATE INDEX escalation_ticket ON escalation_event (ticket_id, level);

-- A ticket that reached L4 cannot close without a Staff Officer remark.
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

CREATE TRIGGER l4_remark_check BEFORE UPDATE ON ticket
    FOR EACH ROW EXECUTE FUNCTION check_l4_remark();

-- Escalations are the system's record (user's finding, 2026-10-12: anyone
-- who could see a complaint could write the Staff Officer's level-4 remark
-- straight into the table, and nothing in the portal let the Staff Officer
-- write it at all). Only the system raises one; the level-4 remark is the
-- Area Civil Staff Officer's, written once, with who and when from the
-- session; nothing else in a row changes, and no row is ever deleted.
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


-- =====================================================================
-- 8A. STATE TRANSITION AUTHORITY
--
-- RLS decides what a role may SEE. It does not decide what a role may
-- DO. Without this table a resident could self-verify their own
-- complaint and a contractor could inspect and close their own work,
-- because a permissive row policy allows any UPDATE to a visible row.
--
-- Every transition must be listed here with the role entitled to make it.
-- =====================================================================

CREATE TABLE ticket_transition (
    from_state      ticket_state NOT NULL,
    to_state        ticket_state NOT NULL,
    allowed_role    text NOT NULL,
    PRIMARY KEY (from_state, to_state, allowed_role)
);

INSERT INTO ticket_transition VALUES
    -- verification is the Overseer's alone
    ('RAISED','VERIFIED','CIVIL_OVERSEER'),
    ('RAISED','REJECTED','CIVIL_OVERSEER'),
    ('RAISED','REFERRED_SPECIAL_REPAIR','CIVIL_OVERSEER'),
    -- assignment is the Incharge's
    ('VERIFIED','ASSIGNED','MAINTENANCE_INCHARGE'),
    -- the Overseer allots on site too (decision 2026-09-30)
    ('VERIFIED','ASSIGNED','CIVIL_OVERSEER'),
    ('VERIFIED','REFERRED_SPECIAL_REPAIR','MAINTENANCE_INCHARGE'),
    -- execution is the contractor's, and stops at a completion CLAIM
    ('ASSIGNED','IN_PROGRESS','CONTRACTOR_SUPERVISOR'),
    ('IN_PROGRESS','WORK_COMPLETED','CONTRACTOR_SUPERVISOR'),
    ('REWORK','IN_PROGRESS','CONTRACTOR_SUPERVISOR'),
    ('ASSIGNED','ASSIGNED','MAINTENANCE_INCHARGE'),          -- reassignment
    ('ASSIGNED','ASSIGNED','CIVIL_OVERSEER'),
    -- inspection and closure are the Overseer's alone
    ('WORK_COMPLETED','INSPECTED_ACCEPTED','CIVIL_OVERSEER'),
    ('WORK_COMPLETED','REWORK','CIVIL_OVERSEER'),
    ('INSPECTED_ACCEPTED','CLOSED','CIVIL_OVERSEER'),
    ('INSPECTED_ACCEPTED','CLOSED','MAINTENANCE_INCHARGE'),
    -- reopening belongs to the occupant
    ('CLOSED','REOPENED','RESIDENT'),
    ('CLOSED','REOPENED','CUSTODIAN'),
    -- a dispute after acceptance but before closure reopens it too: the
    -- Overseer must not close work the occupant says is not done
    -- (user's finding, 2026-10-07)
    ('INSPECTED_ACCEPTED','REOPENED','RESIDENT'),
    ('INSPECTED_ACCEPTED','REOPENED','CUSTODIAN'),
    -- a contested rejection reinstated; only through a review (ticket_review_gate)
    ('REJECTED','RAISED','CIVIL_OVERSEER'),
    ('REJECTED','RAISED','MAINTENANCE_INCHARGE'),
    ('REJECTED','RAISED','STAFF_OFFICER_CIVIL'),
    -- the Staff Officer's decision on a repeatedly disputed complaint
    ('REOPENED','CLOSED','STAFF_OFFICER_CIVIL'),
    ('REOPENED','REFERRED_SPECIAL_REPAIR','STAFF_OFFICER_CIVIL'),
    ('REOPENED','ASSIGNED','MAINTENANCE_INCHARGE'),
    ('REOPENED','ASSIGNED','CIVIL_OVERSEER'),
    -- special repair referral escalates out of the contract
    ('IN_PROGRESS','REFERRED_SPECIAL_REPAIR','CIVIL_OVERSEER'),
    ('IN_PROGRESS','REFERRED_SPECIAL_REPAIR','STAFF_OFFICER_CIVIL'),
    ('REFERRED_SPECIAL_REPAIR','CLOSED','STAFF_OFFICER_CIVIL');

CREATE OR REPLACE FUNCTION enforce_transition() RETURNS trigger AS $$
DECLARE actor text;
BEGIN
    IF NEW.state = OLD.state THEN
        RETURN NEW;                       -- field edit, not a transition
    END IF;
    actor := current_setting('app.role', true);
    -- Fails CLOSED: an unset role is blocked, not waved through. Migration
    -- scripts and the escalation job must set app.role='SYSTEM' explicitly,
    -- which makes trusted context a deliberate act rather than an omission.
    -- ADMINISTRATOR deliberately does NOT bypass this check. An admin who
    -- can move a ticket from RAISED straight to WORK_COMPLETED can
    -- fabricate contractor performance, and that record may decide a
    -- payment. Corrections go through the normal sequence, audited.
    IF actor = 'SYSTEM' THEN
        RETURN NEW;
    END IF;
    IF actor IS NULL THEN
        RAISE EXCEPTION 'app.role is not set; refusing state change'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM ticket_transition
                    WHERE from_state = OLD.state
                      AND to_state   = NEW.state
                      AND allowed_role = actor) THEN
        RAISE EXCEPTION
          'role % may not move ticket from % to %', actor, OLD.state, NEW.state
          USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ticket_transition_check
    BEFORE UPDATE OF state ON ticket
    FOR EACH ROW EXECUTE FUNCTION enforce_transition();


-- ---------------------------------------------------------------------
-- 8B. FIELD-LEVEL WRITE AUTHORITY
--
-- The transition trigger guards the `state` column and nothing else, so
-- every other column was writable by any role that could see the row.
-- Demonstrated consequences before this was added:
--
--   a contractor extended their own completion deadline by a year
--   a contractor rewrote the SLA snapshot on their own ticket
--   a contractor erased their own escalation level and objection count
--   a contractor downgraded an emergency they were measured against
--   a resident reassigned the ticket to a different contractor
--   a resident back-dated a deadline to force a breach
--
-- Each of those silently falsifies the contract performance record. The
-- table below states who may change what; the trigger enforces it.
-- ---------------------------------------------------------------------

CREATE TABLE ticket_field_authority (
    column_name     text PRIMARY KEY,
    allowed_roles   text[] NOT NULL
);

-- ADMINISTRATOR is absent from every row below for the same reason it no
-- longer bypasses the transition table.
INSERT INTO ticket_field_authority VALUES
    -- columns that accompany a transition: same role as the transition
    ('verified_by',         '{CIVIL_OVERSEER}'),
    ('verified_at',         '{CIVIL_OVERSEER}'),
    ('assigned_to',         '{CIVIL_OVERSEER,MAINTENANCE_INCHARGE}'),
    ('assigned_at',         '{CIVIL_OVERSEER,MAINTENANCE_INCHARGE}'),
    ('started_at',          '{CONTRACTOR_SUPERVISOR}'),
    ('workmen_assigned',    '{CONTRACTOR_SUPERVISOR}'),
    ('completed_claim_at',  '{CONTRACTOR_SUPERVISOR}'),
    ('inspected_by',        '{CIVIL_OVERSEER}'),
    ('inspected_at',        '{CIVIL_OVERSEER}'),
    ('closed_at',           '{CIVIL_OVERSEER,MAINTENANCE_INCHARGE,STAFF_OFFICER_CIVIL}'),
    -- emergency downgrade is the Overseer's alone (FRS 8, control 3)
    ('is_emergency',        '{CIVIL_OVERSEER}'),
    -- inspection order is a departmental decision, never the contractor's
    ('inspection_priority',      '{CIVIL_OVERSEER,MAINTENANCE_INCHARGE}'),
    ('inspection_priority_note', '{CIVIL_OVERSEER,MAINTENANCE_INCHARGE}'),
    ('inspection_rank',     '{}'),
    -- the SLA record belongs to the system. No human writes these.
    ('sla_response_minutes',            '{}'),
    ('sla_completion_minutes',          '{}'),
    ('response_deadline_at',            '{}'),
    ('completion_deadline_at',          '{}'),
    ('original_response_deadline_at',   '{}'),
    ('original_completion_deadline_at', '{}'),
    ('total_paused_minutes',            '{}'),
    ('response_met',                    '{}'),
    ('completion_met',                  '{}'),
    -- performance counters are evidence, not editable fields
    ('escalation_level',    '{}'),
    ('archived_at',         '{}'),
    ('reopened_count',      '{}'),
    ('objection_count',     '{}'),
    ('rework_count',        '{}'),
    -- identity of the ticket: immutable once raised
    ('ticket_no',           '{}'),
    ('premises_id',         '{}'),
    ('area_id',             '{}'),
    ('scope_path',          '{}'),
    ('sub_category_id',     '{}'),
    ('raised_by',           '{}'),
    ('raised_at',           '{}'),
    ('description',         '{}'),
    ('contract_id',         '{}'),
    ('classification',      '{}'),
    -- the contractor's clock: evidence, derived by trigger
    ('contractor_window_started_at', '{}'),
    ('contractor_minutes',  '{}');

CREATE OR REPLACE FUNCTION enforce_field_authority() RETURNS trigger AS $$
DECLARE
    actor text;
    o jsonb := to_jsonb(OLD);
    n jsonb := to_jsonb(NEW);
    r record;
BEGIN
    actor := current_setting('app.role', true);
    IF actor = 'SYSTEM' THEN
        RETURN NEW;                -- SLA engine, escalation job, migrations
    END IF;
    -- Changes made from inside another trigger are the database's own
    -- bookkeeping (SLA snapshot, counters), not a caller's write. Depth is
    -- 1 for a plain statement and higher when a trigger drove the update.
    IF pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;
    IF actor IS NULL THEN
        RAISE EXCEPTION 'app.role is not set; refusing ticket update'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    FOR r IN SELECT column_name, allowed_roles FROM ticket_field_authority LOOP
        IF o -> r.column_name IS DISTINCT FROM n -> r.column_name
           AND NOT (actor = ANY (r.allowed_roles)) THEN
            RAISE EXCEPTION 'role % may not change %', actor, r.column_name
                USING ERRCODE = 'insufficient_privilege';
        END IF;
    END LOOP;
    -- The time and author of a step are written by that step, and only by
    -- it. A same-state update is not a transition (enforce_transition lets
    -- it pass), so without this a second "claim" on a claimed job rewrote
    -- completed_claim_at — found racing two claims (break-it pass,
    -- 2026-10-08). Reassignment (assigned_*) is the one same-state step.
    IF NEW.state IS NOT DISTINCT FROM OLD.state THEN
        FOR r IN SELECT unnest(ARRAY['verified_by','verified_at','started_at','workmen_assigned',
                                     'completed_claim_at','inspected_by','inspected_at','closed_at']) AS column_name LOOP
            IF o -> r.column_name IS DISTINCT FROM n -> r.column_name THEN
                RAISE EXCEPTION '% is written only by the step it records; the complaint is already %', r.column_name, OLD.state
                    USING ERRCODE = 'check_violation';
            END IF;
        END LOOP;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ticket_field_authority_check
    BEFORE UPDATE ON ticket
    FOR EACH ROW EXECUTE FUNCTION enforce_field_authority();


-- ---------------------------------------------------------------------
-- 8C. DERIVED FIELDS
--
-- The SLA snapshot, the met/missed flags and the performance counters are
-- computed here rather than sent by the caller. Two reasons: they are
-- evidence, so no API client should be able to supply them; and
-- ticket_field_authority assigns them to no human role, so a handler that
-- tried to write them would be refused.
--
-- The trigger name sorts after ticket_field_authority_check deliberately.
-- BEFORE triggers fire in name order, so authority sees the row exactly as
-- the caller submitted it, and these values are applied afterwards.
-- ---------------------------------------------------------------------

-- Minutes of one contractor round, less any COMPLETION pause recorded
-- inside it. A pause still open counts up to the end of the round.
CREATE OR REPLACE FUNCTION contractor_round_minutes(
    p_ticket uuid, p_from timestamptz, p_to timestamptz) RETURNS integer AS $$
    SELECT greatest(0, round((
        extract(epoch FROM p_to - p_from)
        - coalesce((SELECT sum(extract(epoch FROM
                        least(coalesce(sp.resumed_at, p_to), p_to)
                        - greatest(sp.paused_at, p_from)))
                      FROM sla_pause sp
                     WHERE sp.ticket_id = p_ticket
                       AND sp.clock = 'COMPLETION'
                       AND sp.paused_at < p_to
                       AND coalesce(sp.resumed_at, p_to) > p_from), 0)
        ) / 60))::integer;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION ticket_derived_fields() RETURNS trigger AS $$
DECLARE
    r record;
    -- the states in which the job is in the contractor's hands
    with_contractor constant ticket_state[] :=
        ARRAY['ASSIGNED','IN_PROGRESS','REWORK']::ticket_state[];
BEGIN
    IF NEW.state = 'VERIFIED' AND OLD.state IS DISTINCT FROM 'VERIFIED'
       AND NEW.verified_at IS NOT NULL AND NEW.sla_completion_minutes IS NULL THEN
        SELECT sr.response_minutes, sr.completion_minutes INTO r
          FROM premises_ref p
          JOIN sla_rule sr ON sr.sub_category_id = NEW.sub_category_id
                          AND (sr.premises_type = p.premises_type OR sr.premises_type IS NULL)
         WHERE p.premises_id = NEW.premises_id
         ORDER BY sr.premises_type NULLS LAST, sr.effective_from DESC
         LIMIT 1;
        IF FOUND THEN
            NEW.sla_response_minutes   := r.response_minutes;
            NEW.sla_completion_minutes := r.completion_minutes;
            NEW.response_deadline_at   := NEW.verified_at + (r.response_minutes   || ' minutes')::interval;
            NEW.completion_deadline_at := NEW.verified_at + (r.completion_minutes || ' minutes')::interval;
            NEW.original_response_deadline_at   := NEW.response_deadline_at;
            NEW.original_completion_deadline_at := NEW.completion_deadline_at;
        END IF;
    END IF;

    -- The contractor's clock opens when the job reaches them and closes
    -- when it leaves them, normally at their completion claim.
    IF NEW.state IS DISTINCT FROM OLD.state THEN
        IF NEW.state = ANY (with_contractor) AND NOT (OLD.state = ANY (with_contractor)) THEN
            NEW.contractor_window_started_at := now();
        ELSIF OLD.state = ANY (with_contractor) AND NOT (NEW.state = ANY (with_contractor)) THEN
            NEW.contractor_minutes := OLD.contractor_minutes
                + contractor_round_minutes(OLD.id, OLD.contractor_window_started_at, now());
            NEW.contractor_window_started_at := NULL;
        END IF;
    END IF;

    -- Judged on the contractor's own time across every round, not on the
    -- date the Overseer accepted it. Previously this compared the moment
    -- of ACCEPTANCE with a deadline running from verification, so a slow
    -- inspection or a slow assignment counted against the contractor — a
    -- figure the contractor would rightly win in a dispute.
    IF NEW.state = 'INSPECTED_ACCEPTED' AND OLD.state IS DISTINCT FROM 'INSPECTED_ACCEPTED' THEN
        NEW.completion_met := (NEW.sla_completion_minutes IS NULL
                               OR NEW.contractor_minutes <= NEW.sla_completion_minutes);
        NEW.response_met   := (NEW.response_deadline_at IS NULL
                               OR NEW.started_at IS NULL
                               OR NEW.started_at <= NEW.response_deadline_at);
    END IF;

    -- The contract a ticket counts against is the one the assigned
    -- contractor holds. Derived here so no caller can attribute work to a
    -- contract that did not do it.
    IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to
       AND NEW.assigned_to IS NOT NULL THEN
        SELECT d.contract_id INTO NEW.contract_id
          FROM actor_ref d WHERE d.actor_id = NEW.assigned_to;
    END IF;

    IF NEW.state = 'REOPENED'  AND OLD.state IS DISTINCT FROM 'REOPENED'  THEN
        NEW.reopened_count := OLD.reopened_count + 1;
    END IF;
    IF NEW.state = 'REWORK'    AND OLD.state IS DISTINCT FROM 'REWORK'    THEN
        NEW.rework_count := OLD.rework_count + 1;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ticket_zz_derived_fields
    BEFORE UPDATE ON ticket
    FOR EACH ROW EXECUTE FUNCTION ticket_derived_fields();


-- ---------------------------------------------------------------------
-- 8C-bis. PHOTOGRAPH GATES
--
-- The completion claim and the inspection each need a photograph. These
-- were checked in the application, and only for "a photograph of this
-- purpose exists on this ticket". Found 2026-09-24:
--
--   * anyone who could see the ticket, contractor included, could supply
--     the "inspection" photograph, so an Overseer could accept from a desk
--   * after a send-back, the photographs of the rejected round still
--     satisfied both gates, so redone work was claimed and accepted with
--     no new evidence at all
--
-- Now enforced here, so every route to these states obeys it: the
-- completion photograph must be the assigned contractor's and taken in
-- the current round; the inspection photograph must be the inspecting
-- Overseer's own and taken after the claim being inspected.
--
-- uploaded_at is the server's time when the upload was requested, never a
-- time the client supplies.
--
-- Named to sort after ticket_transition_check: a role that may not make
-- the transition at all is told that, not that a photograph is missing.
-- ---------------------------------------------------------------------
--
-- OPTIONAL FOR NOW (user's decision, 2026-10-12): to ease adoption, the
-- before/after photographs and the inspection photograph are required only
-- once the HQ System Administrator switches the settings
-- completion_photos_required and inspection_photo_required on. This relaxes
-- controls 1 and 2 until then, deliberately and on record (README §5.5).
-- A photograph that IS attached is held to every rule regardless: the
-- taker's own, in the app, located, three at most per round.
-- plpgsql, not sql: the settings table is created further down this file
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

CREATE TRIGGER ticket_u_photo_gates
    BEFORE UPDATE OF state ON ticket
    FOR EACH ROW EXECUTE FUNCTION enforce_photo_gates();

-- Contractor staff on the web (user's decisions, 2026-10-16). A session signed
-- in with the mobile and an OTP reads and records materials, but starting the
-- work and the completion claim stay acts from the site, on the phone; and no
-- photograph enters except through the app's camera (control 2).
CREATE OR REPLACE FUNCTION enforce_web_contractor_limits() RETURNS trigger AS $$
BEGIN
    IF current_setting('app.auth_method', true) = 'otp' AND NEW.state IN ('IN_PROGRESS', 'WORK_COMPLETED') THEN
        RAISE EXCEPTION 'Starting the work and marking it complete are done in the app on your phone'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

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

CREATE TRIGGER ticket_media_web_contractor_limits
    BEFORE INSERT ON ticket_media
    FOR EACH ROW EXECUTE FUNCTION media_web_contractor_limits();


-- ---------------------------------------------------------------------
-- TWO-KEY, BY PERSON  (decision 2026-09-30)
--
-- A person may now hold several roles, so "the inspector is not the
-- assigned contractor" must compare PEOPLE, not role assignments: one
-- person holding a contractor supervisor role and an Overseer role on two
-- phones would otherwise pass the actor check above.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_two_key_person() RETURNS trigger AS $$
BEGIN
    IF NEW.inspected_by IS NOT NULL AND NEW.assigned_to IS NOT NULL
       AND (SELECT person_id FROM actor_ref WHERE actor_id = NEW.inspected_by)
         = (SELECT person_id FROM actor_ref WHERE actor_id = NEW.assigned_to) THEN
        RAISE EXCEPTION 'The person who did the work cannot inspect it'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
-- definer: the two people must be compared even when the caller's own
-- row policy could not see the other actor; the search path is pinned so
-- the elevated function cannot be pointed at a look-alike table
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = maint, public;

CREATE TRIGGER ticket_v_two_key_person
    BEFORE UPDATE ON ticket
    FOR EACH ROW EXECUTE FUNCTION enforce_two_key_person();

-- Objection count is bookkeeping too, and belongs with the objection.
CREATE OR REPLACE FUNCTION bump_objection_count() RETURNS trigger AS $$
BEGIN
    UPDATE ticket SET objection_count = objection_count + 1 WHERE id = NEW.ticket_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER objection_counter
    AFTER INSERT ON ticket_objection
    FOR EACH ROW EXECUTE FUNCTION bump_objection_count();


-- =====================================================================
-- 8D. CONFIGURATION AND THE GM DASHBOARD
--
-- The dashboard is configurable rather than fixed: the department decides
-- which measures appear, in what order, and at what point a figure turns
-- from normal to warning to critical. Changing the GM's view is an
-- administrative act, not a release.
-- =====================================================================

CREATE TABLE maint_config (
    key             text PRIMARY KEY,
    value           text NOT NULL,
    data_type       text NOT NULL,
    description     text NOT NULL,
    updated_by      uuid NULL,
    updated_at      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO maint_config (key, value, data_type, description) VALUES
 ('reopens_before_staff_officer','3','integer',
  'Reopenings of one complaint after which the Area Civil Staff Officer must decide it'),
 ('hq_sla_target_percent','90','integer',
  'SLA compliance the HQ dashboard measures every Area against'),
 ('overseers_per_area','3','integer',
  'Civil Overseer accounts provisioned per Area'),
 ('archive_after_days','30','integer',
  'Days after closure before a ticket leaves the working views'),
 ('gm_dashboard_open_only','true','boolean',
  'GM dashboard shows live work only; archived tickets are reached through search'),
 ('sla_sweep_max_escalations','500','integer',
  'Escalations processed per sweep, so a backlog drains rather than blocks'),
 ('inspection_backlog_warn_hours','48','integer',
  'Inspection backlog age at which the Incharge is warned'),
 ('reopen_window_hours','24','integer',
  'Hours after closure during which the occupant may reopen the original ticket'),
 ('bulk_assign_max','200','integer','Tickets assignable in one action'),
 ('batch_inspect_max','50','integer','Inspections acceptable from one visit'),
 ('media_retention_years','2','integer',
  'Years a photograph''s bytes are kept. The media record, with its hash, '
  'location and timestamp, outlives the image.'),
 ('completion_photos_required','false','boolean',
  'The supervisor must attach a "before" and an "after" photograph to claim completion. Off while the portal is adopted (decision 2026-10-12); switch on when it has matured.'),
 ('inspection_photo_required','false','boolean',
  'The Overseer must take an in-app, located inspection photograph to accept or send back the work. Off while the portal is adopted (decision 2026-10-12); switch on when it has matured.');

-- Settings decide whether some controls are in force (the photograph
-- requirements above), so they are the HQ System Administrator's alone,
-- refused by the database to anyone else, never added or removed by a
-- person, and every change is logged with the old and new value. Until
-- 2026-10-12 only the API checked who wrote them.
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

-- ---------------------------------------------------------------------
-- EXCLUDED SCOPE NOTICE
--
-- What the portal does not handle, in both languages, with the Area
-- contact numbers beside it. Held as data because the boundary will move
-- as community works and E&M are added, and because the department
-- maintains the wording.
-- ---------------------------------------------------------------------
CREATE TABLE excluded_scope (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    heading_en      text NOT NULL,
    heading_hi      text NOT NULL,
    body_en         text NOT NULL,
    body_hi         text NOT NULL,
    display_order   integer NOT NULL,
    active          boolean NOT NULL DEFAULT true
);

INSERT INTO excluded_scope (heading_en, heading_hi, body_en, body_hi, display_order) VALUES
 ('Colony common areas','कॉलोनी के सार्वजनिक क्षेत्र',
  'Colony roads and pathways, street drains and nallahs, parks, playgrounds and community halls, boundary walls of the colony, common-area horticulture and tree cutting.',
  'कॉलोनी की सड़कें और रास्ते, नालियाँ और नाले, पार्क, खेल मैदान और सामुदायिक भवन, कॉलोनी की चारदीवारी, सार्वजनिक क्षेत्र की बागवानी और पेड़ कटाई।',1),
 ('Sanitation services','सफाई सेवाएँ',
  'Garbage collection, colony sweeping and cleaning, drain cleaning in common areas, fogging and pest control.',
  'कूड़ा उठाव, कॉलोनी की सफाई, सार्वजनिक क्षेत्रों की नाली सफाई, फॉगिंग और कीट नियंत्रण।',2),
 ('Water services','जल सेवाएँ',
  'Water tanker supply and scheduling, overhead tank supply at colony level, pump and motor faults including starters and control panels.',
  'पानी का टैंकर और उसका समय, कॉलोनी स्तर की टंकी आपूर्ति, पंप और मोटर की खराबी सहित स्टार्टर और कंट्रोल पैनल।',3),
 ('Electrical — E&M Department','विद्युत — ई एंड एम विभाग',
  'Quarter wiring, switches, fans and fittings, street lights, colony electrical supply. Please contact the E&M Department.',
  'क्वार्टर की वायरिंग, स्विच, पंखे और फिटिंग, स्ट्रीट लाइट, कॉलोनी विद्युत आपूर्ति। कृपया ई एंड एम विभाग से संपर्क करें।',4),
 ('Estate matters','आवास संबंधी मामले',
  'Quarter allotment, transfer, vacation, retention and licence fee. Please contact your Area Estate Office.',
  'क्वार्टर आवंटन, स्थानांतरण, खाली करना, रिटेंशन और लाइसेंस शुल्क। कृपया क्षेत्रीय आवास कार्यालय से संपर्क करें।',5),
 ('Major structural repair','बड़ी संरचनात्मक मरम्मत',
  'Work assessed as beyond the scope of the maintenance contract is referred for special repair and is dealt with separately by the Area Civil Maintenance Office.',
  'जो कार्य अनुरक्षण संविदा के दायरे से बाहर पाया जाता है, उसे विशेष मरम्मत हेतु भेजा जाता है और क्षेत्रीय सिविल अनुरक्षण कार्यालय द्वारा अलग से देखा जाता है।',6);

CREATE TABLE area_contact (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    area_id         uuid NOT NULL,
    scope_path      ltree NOT NULL,
    label_en        text NOT NULL,
    label_hi        text NOT NULL,
    phone           text NOT NULL,
    display_order   integer NOT NULL DEFAULT 1,
    active          boolean NOT NULL DEFAULT true
);
CREATE INDEX area_contact_scope ON area_contact USING gist (scope_path);

CREATE TABLE dashboard_card (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    role            text NOT NULL,
    key             text NOT NULL,
    label_en        text NOT NULL,
    label_hi        text NOT NULL,
    display_order   integer NOT NULL,
    warn_above      numeric NULL,
    critical_above  numeric NULL,
    active          boolean NOT NULL DEFAULT true,
    UNIQUE (role, key)
);

INSERT INTO dashboard_card
  (role, key, label_en, label_hi, display_order, warn_above, critical_above) VALUES
 ('GM_CIVIL','open_complaints','Open complaints','लंबित शिकायतें',1,NULL,NULL),
 ('GM_CIVIL','overdue','Past SLA','समय सीमा पार',2,50,150),
 ('GM_CIVIL','awaiting_inspection','Awaiting inspection','निरीक्षण लंबित',3,100,300),
 ('GM_CIVIL','inspection_backlog_hours','Oldest inspection waiting (hours)',
  'सबसे पुराना निरीक्षण (घंटे)',4,48,96),
 ('GM_CIVIL','escalated_l4','At level 4','स्तर 4 पर',5,0,3),
 ('GM_CIVIL','open_objections','Open objections','लंबित आपत्तियाँ',6,10,30),
 ('MAINTENANCE_INCHARGE','to_verify','To check','जाँच बाकी',1,20,60),
 ('MAINTENANCE_INCHARGE','to_assign','To give out','सौंपना बाकी',2,20,60),
 ('MAINTENANCE_INCHARGE','awaiting_inspection','Awaiting inspection','निरीक्षण लंबित',3,30,80),
 ('MAINTENANCE_INCHARGE','overdue','Past SLA','समय सीमा पार',4,10,30),
 ('CIVIL_OVERSEER','to_verify','To check','जाँच बाकी',1,15,40),
 ('CIVIL_OVERSEER','awaiting_inspection','To inspect','निरीक्षण करना है',2,25,60),
 ('CIVIL_OVERSEER','inspection_backlog_hours','Oldest waiting (hours)',
  'सबसे पुराना (घंटे)',3,48,96),
 ('CIVIL_OVERSEER','open_objections','Objections to answer','उत्तर देने योग्य आपत्तियाँ',4,3,10),
 ('STAFF_OFFICER_CIVIL','overdue','Past SLA','समय सीमा पार',1,25,75),
 ('STAFF_OFFICER_CIVIL','escalated_l3','At level 3 or above','स्तर 3 या ऊपर',2,5,20),
 ('STAFF_OFFICER_CIVIL','special_repair','Referred for special repair',
  'विशेष मरम्मत हेतु भेजे',3,NULL,NULL);


-- =====================================================================
-- 9. NOTIFICATIONS  (FRS 11 — in-app authoritative, push best-effort)
-- =====================================================================

CREATE TABLE notification (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id        uuid NOT NULL,          -- the inbox of one role of one person
    event_type      text NOT NULL,
    ticket_id       uuid NULL REFERENCES ticket(id),
    title_en        text NOT NULL,
    title_hi        text NOT NULL,
    body_en         text NOT NULL,
    body_hi         text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    read_at         timestamptz NULL,
    push_attempted_at timestamptz NULL,
    push_delivered  boolean NULL,           -- best-effort; in-app still stands
    suppressed_quiet_hours boolean NOT NULL DEFAULT false
);
-- Drives the unread badge (FRS 11.3)
CREATE INDEX notification_unread ON notification (actor_id, created_at DESC)
    WHERE read_at IS NULL;

CREATE TABLE push_token (
    device_id       uuid PRIMARY KEY,
    fcm_token       text NOT NULL,
    updated_at      timestamptz NOT NULL DEFAULT now()
);


-- =====================================================================
-- 10. ROW-LEVEL SECURITY
-- =====================================================================

CREATE OR REPLACE FUNCTION current_scope() RETURNS ltree AS $$
    SELECT nullif(current_setting('app.scope_path', true), '')::ltree;
$$ LANGUAGE sql STABLE;

-- nullif is essential: an unset setting is '' and casting '' to uuid
-- raises rather than yielding NULL, which once made every policy that
-- referenced these helpers fail at run time.
CREATE OR REPLACE FUNCTION current_device() RETURNS uuid AS $$
    -- the authenticator used for this session (push tokens are per handset)
    SELECT nullif(current_setting('app.device_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;
CREATE OR REPLACE FUNCTION current_actor() RETURNS uuid AS $$
    -- the role assignment acted in: what every act is recorded against
    SELECT nullif(current_setting('app.actor_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;
CREATE OR REPLACE FUNCTION current_person() RETURNS uuid AS $$
    SELECT nullif(current_setting('app.person_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;
CREATE OR REPLACE FUNCTION current_contract() RETURNS uuid AS $$
    SELECT nullif(current_setting('app.contract_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

-- Premises binding from the device's SERVER-VALIDATED token claim.
-- Occupant visibility is scoped to the PREMISES, not the handset: a family
-- member's device must see a ticket raised by another device at the same
-- quarter, otherwise multiple devices per premises is pointless (FRS 4.2).
-- SECURITY: app.premises_id must never be set from a client parameter.
CREATE OR REPLACE FUNCTION current_premises() RETURNS uuid AS $$
    SELECT nullif(current_setting('app.premises_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION current_role_name() RETURNS text AS $$
    SELECT current_setting('app.role', true);
$$ LANGUAGE sql STABLE;

ALTER TABLE ticket ENABLE ROW LEVEL SECURITY;

-- Occupants see only their own premises. Contractors see only their
-- assigned jobs. Civil users see their scope subtree. HQ sees all.
CREATE POLICY ticket_visibility ON ticket USING (
    CASE current_role_name()
        WHEN 'RESIDENT'  THEN premises_id = current_premises()
        WHEN 'CUSTODIAN' THEN premises_id = current_premises()
        WHEN 'CONTRACTOR_SUPERVISOR' THEN assigned_to = current_actor()
        -- the firm sees the work under its own contract, nothing else
        WHEN 'CONTRACTOR' THEN contract_id = current_contract()
        WHEN 'GM_CIVIL'  THEN true
        WHEN 'HQ_EXECUTIVE' THEN true
        WHEN 'ADMINISTRATOR' THEN true
        -- Background work: the escalation job, the SLA sweep and the
        -- notification dispatcher run with no scope and must see every
        -- ticket. Omitting this branch sent them to the ELSE, where
        -- current_scope() is NULL and every row evaluates NULL — so they
        -- silently processed nothing at all, with no error to notice.
        WHEN 'SYSTEM'    THEN true
        ELSE scope_path <@ current_scope()
    END);

-- GM is read-only on tickets (FRS 3.1).
-- MUST be RESTRICTIVE: permissive policies are OR-ed together, so a
-- second permissive policy can only ever widen access, never narrow it.
-- As a permissive policy this silently granted GM full write access.
CREATE POLICY ticket_no_hq_write ON ticket
    AS RESTRICTIVE FOR UPDATE
    USING (current_role_name() NOT IN ('GM_CIVIL','HQ_EXECUTIVE','CONTRACTOR'));

-- Who may RAISE a complaint: the occupant, or the Overseer or Incharge for
-- a departmental building (decision 27). "Read-only" above covered
-- updates only, so until 2026-09-30 an HQ role could insert one. Anyone
-- else with a quarter raises it from their resident role.
CREATE POLICY ticket_who_raises ON ticket
    AS RESTRICTIVE FOR INSERT
    WITH CHECK (current_role_name() IN
        ('RESIDENT','CUSTODIAN','CIVIL_OVERSEER','MAINTENANCE_INCHARGE','SYSTEM'));

-- FORCE applies policies even to the table owner.
ALTER TABLE ticket FORCE ROW LEVEL SECURITY;


-- ---------------------------------------------------------------------
-- CHILD TABLES
--
-- Protecting `ticket` alone protects nothing. Photographs, objections,
-- feedback, history, SLA records and escalations all carry the same data
-- by another route, and were readable across areas until this was added.
--
-- The pattern below is one line per table: visibility derives from the
-- parent ticket. Because `ticket` is itself under RLS, the EXISTS
-- subquery is evaluated with the caller's policy applied — so a row is
-- visible here exactly when its ticket is visible, with no duplicated
-- scope logic to drift.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ticket_is_visible(t uuid) RETURNS boolean AS $$
    SELECT EXISTS (SELECT 1 FROM ticket WHERE id = t);
$$ LANGUAGE sql STABLE SECURITY INVOKER;

ALTER TABLE ticket_media     ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_objection ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_feedback  ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_event     ENABLE ROW LEVEL SECURITY;
ALTER TABLE sla_pause        ENABLE ROW LEVEL SECURITY;
ALTER TABLE sla_breach       ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalation_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_media     FORCE ROW LEVEL SECURITY;
ALTER TABLE ticket_objection FORCE ROW LEVEL SECURITY;
ALTER TABLE ticket_feedback  FORCE ROW LEVEL SECURITY;
ALTER TABLE ticket_event     FORCE ROW LEVEL SECURITY;
ALTER TABLE sla_pause        FORCE ROW LEVEL SECURITY;
ALTER TABLE sla_breach       FORCE ROW LEVEL SECURITY;
ALTER TABLE escalation_event FORCE ROW LEVEL SECURITY;

CREATE POLICY media_via_ticket      ON ticket_media     USING (ticket_is_visible(ticket_id));
-- Seeing a ticket is not authority to put evidence on it. Each purpose
-- belongs to the role whose act it records, and a photograph is always
-- recorded as the uploader's own. RESTRICTIVE, so it narrows the
-- visibility policy above rather than being OR-ed with it.
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
-- An objection is the occupant's word to the department, never to the
-- contractor (README §2), and so is its photograph. Found 2026-10-10: the
-- complaint's photograph list and the image link served it to them.
CREATE POLICY media_no_objection_for_contractor ON ticket_media AS RESTRICTIVE FOR SELECT
    USING (purpose <> 'OBJECTION' OR current_role_name() NOT IN ('CONTRACTOR','CONTRACTOR_SUPERVISOR'));
-- Only the uploader completes their own upload; the purge runs as SYSTEM.
CREATE POLICY media_own_update ON ticket_media AS RESTRICTIVE FOR UPDATE
    USING (current_role_name() = 'SYSTEM' OR uploaded_by = current_actor());

-- What a photograph is evidence OF is fixed when it is requested: the
-- ticket, the purpose, who took it and when. Otherwise an uploader could
-- relabel a completion photograph as an inspection one, or move it to a
-- later round, and walk straight round the photograph gates.
CREATE OR REPLACE FUNCTION freeze_media_identity() RETURNS trigger AS $$
BEGIN
    IF current_setting('app.role', true) IS DISTINCT FROM 'SYSTEM' AND (
         NEW.ticket_id   IS DISTINCT FROM OLD.ticket_id
      OR NEW.purpose     IS DISTINCT FROM OLD.purpose
      OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by
      OR NEW.uploaded_at IS DISTINCT FROM OLD.uploaded_at
      OR NEW.storage_key IS DISTINCT FROM OLD.storage_key) THEN
        RAISE EXCEPTION 'a photograph''s ticket, purpose, uploader and time cannot be changed'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER media_identity_frozen
    BEFORE UPDATE ON ticket_media
    FOR EACH ROW EXECUTE FUNCTION freeze_media_identity();
-- Objections are deliberately NOT visible to the contractor (FRS 5.5).
-- They are raised while that contractor's work is under way and go to the
-- Overseer and Incharge; letting the contractor read them turns a quality
-- signal into a dispute with the resident. Inheriting ticket visibility
-- would have exposed them, since the contractor can see their own jobs.
-- Both contractor roles: the firm's own role read them until 2026-10-15,
-- when only the supervisor was named here (found building the firm's screens).
CREATE POLICY objection_via_ticket  ON ticket_objection USING (
    ticket_is_visible(ticket_id)
    AND current_role_name() NOT IN ('CONTRACTOR','CONTRACTOR_SUPERVISOR'));
CREATE POLICY feedback_via_ticket   ON ticket_feedback  USING (ticket_is_visible(ticket_id));
CREATE POLICY event_via_ticket      ON ticket_event     USING (ticket_is_visible(ticket_id));
CREATE POLICY pause_via_ticket      ON sla_pause        USING (ticket_is_visible(ticket_id));
CREATE POLICY breach_via_ticket     ON sla_breach       USING (ticket_is_visible(ticket_id));
CREATE POLICY escalation_via_ticket ON escalation_event USING (ticket_is_visible(ticket_id));


-- ---------------------------------------------------------------------
-- PREMISES PROJECTION — was readable across every area
-- ---------------------------------------------------------------------
ALTER TABLE premises_ref ENABLE ROW LEVEL SECURITY;
ALTER TABLE premises_ref FORCE ROW LEVEL SECURITY;

CREATE POLICY premises_ref_scope ON premises_ref USING (
    CASE current_role_name()
        WHEN 'RESIDENT'  THEN premises_id = current_premises()
        WHEN 'CUSTODIAN' THEN premises_id = current_premises()
        WHEN 'GM_CIVIL'      THEN true
        WHEN 'HQ_EXECUTIVE'  THEN true
        WHEN 'ADMINISTRATOR' THEN true
        WHEN 'SYSTEM'        THEN true
        WHEN 'CONTRACTOR_SUPERVISOR' THEN scope_path <@ current_scope()
        ELSE scope_path <@ current_scope()
    END);


-- ---------------------------------------------------------------------
-- ACTOR PROJECTION — same scoping as premises_ref
-- ---------------------------------------------------------------------
ALTER TABLE actor_ref ENABLE ROW LEVEL SECURITY;
ALTER TABLE actor_ref FORCE ROW LEVEL SECURITY;

CREATE POLICY actor_ref_scope ON actor_ref USING (
    person_id = current_person()          -- one's own roles, for the switcher
    OR CASE current_role_name()
        WHEN 'RESIDENT'  THEN premises_id = current_premises()
        WHEN 'CUSTODIAN' THEN premises_id = current_premises()
        WHEN 'CONTRACTOR_SUPERVISOR' THEN actor_id = current_actor()
        WHEN 'CONTRACTOR' THEN contract_id = current_contract()
        WHEN 'GM_CIVIL'      THEN true
        WHEN 'HQ_EXECUTIVE'  THEN true
        WHEN 'ADMINISTRATOR' THEN true
        WHEN 'SYSTEM'        THEN true
        ELSE scope_path <@ current_scope()
    END);


-- ---------------------------------------------------------------------
-- NOTIFICATIONS — one role's inbox must not be another's
-- ---------------------------------------------------------------------
ALTER TABLE notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification FORCE ROW LEVEL SECURITY;
ALTER TABLE push_token   ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_token   FORCE ROW LEVEL SECURITY;

CREATE POLICY notification_own ON notification USING (
    actor_id = current_actor()
    OR current_role_name() IN ('ADMINISTRATOR','SYSTEM'));
CREATE POLICY push_token_own ON push_token USING (
    device_id = current_device()
    OR current_role_name() IN ('ADMINISTRATOR','SYSTEM'));


-- ---------------------------------------------------------------------
-- CONTRACTS — a contractor must not read a rival's agreement or
-- performance record
-- ---------------------------------------------------------------------
ALTER TABLE contract ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract FORCE ROW LEVEL SECURITY;

CREATE POLICY contract_scope ON contract USING (
    current_role_name() IN ('GM_CIVIL','HQ_EXECUTIVE','ADMINISTRATOR','SYSTEM')
    OR (current_role_name() IN ('CONTRACTOR','CONTRACTOR_SUPERVISOR') AND id = current_contract())
    OR (current_role_name() NOT IN ('CONTRACTOR','CONTRACTOR_SUPERVISOR','RESIDENT','CUSTODIAN')
        AND scope_path <@ current_scope()));



-- =====================================================================
-- 11. FULL-TEXT SEARCH  (FRS 13.2 — role-scoped, RLS does the scoping)
-- =====================================================================

-- Words people search with are mostly the fault's own name ("water",
-- "leak", "WC") and the quarter, not the free text, which is often empty.
-- So the category and sub-category names (English and Hindi) and the
-- premises go into the index too (user's finding, 2026-10-07).
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


-- =====================================================================
-- 12. CONTRACT PERFORMANCE  (FRS 10.2)
--
-- A view, not a table: always current, nothing to keep in step.
-- Frozen at handover by filtering on handover_cutoff_at.
-- =====================================================================

-- A ticket can carry more than one breach — a response breach and a
-- completion breach — so joining sla_breach directly multiplied the row
-- and inflated EVERY figure in this report, including tickets_received.
-- Breaches are therefore aggregated per ticket first.
--
-- Rate definitions are stated explicitly, because "rejection rate" can
-- mean either share of tickets or events per ticket, and a contractor
-- will read it the way that favours them:
--   rejection_rate_pct  share of tickets sent back at least once
--   objection_rate_pct  share of tickets that drew at least one objection
--   reopen_rate_pct     share of tickets the occupant reopened at least once
CREATE VIEW contract_performance AS
WITH breach AS (
    SELECT ticket_id,
           count(*) FILTER (WHERE attribution = 'CONTRACTOR')    AS contractor_delays,
           count(*) FILTER (WHERE attribution = 'DEPARTMENT')    AS department_delays,
           count(*) FILTER (WHERE attribution = 'OCCUPANT')      AS occupant_delays,
           count(*) FILTER (WHERE attribution = 'FORCE_MAJEURE') AS force_majeure_delays,
           count(*) FILTER (WHERE attribution IS NULL)           AS unattributed_breaches
      FROM sla_breach
     GROUP BY ticket_id
)
SELECT
    c.id                             AS contract_id,
    c.contractor_name,
    c.agreement_no,
    c.area_id,
    date_trunc('month', t.raised_at) AS month,

    count(*)                                                    AS tickets_received,
    count(*) FILTER (WHERE t.state = 'CLOSED')                  AS tickets_closed,
    count(*) FILTER (WHERE t.state NOT IN ('CLOSED','REJECTED')) AS tickets_open,
    count(*) FILTER (WHERE t.is_emergency)                      AS emergencies,

    round(100.0 * count(*) FILTER (WHERE t.completion_met)
          / nullif(count(*) FILTER (WHERE t.completion_met IS NOT NULL), 0), 1)
                                                                AS sla_compliance_pct,
    round(avg(extract(epoch FROM t.closed_at - t.verified_at) / 3600)::numeric, 1)
                                                                AS avg_closure_hours,

    round(100.0 * count(*) FILTER (WHERE t.rework_count > 0)
          / nullif(count(*), 0), 1)                             AS rejection_rate_pct,
    round(100.0 * count(*) FILTER (WHERE t.objection_count > 0)
          / nullif(count(*), 0), 1)                             AS objection_rate_pct,
    round(100.0 * count(*) FILTER (WHERE t.reopened_count > 0)
          / nullif(count(*), 0), 1)                             AS reopen_rate_pct,

    count(*) FILTER (WHERE fb.rating IS NOT NULL)               AS ratings_given,
    round(avg(fb.rating)::numeric, 2)                           AS avg_rating,

    coalesce(sum(b.contractor_delays), 0)                       AS contractor_delays,
    coalesce(sum(b.department_delays), 0)                       AS department_delays,
    coalesce(sum(b.occupant_delays), 0)                         AS occupant_delays,
    coalesce(sum(b.force_majeure_delays), 0)                    AS force_majeure_delays,
    coalesce(sum(b.unattributed_breaches), 0)                   AS unattributed_breaches
FROM contract c
JOIN ticket t ON t.contract_id = c.id
             -- the outgoing contractor's record is frozen at handover and
             -- cannot be affected by anything that happens afterwards
             AND (c.handover_cutoff_at IS NULL
                  OR t.raised_at < c.handover_cutoff_at)
LEFT JOIN ticket_feedback fb ON fb.ticket_id = t.id   -- one row per ticket
LEFT JOIN breach b           ON b.ticket_id  = t.id   -- pre-aggregated
GROUP BY c.id, c.contractor_name, c.agreement_no, c.area_id,
         date_trunc('month', t.raised_at);


-- =====================================================================
-- 13. AUDIT LOG  (same append-only, hash-chained design as identity)
-- =====================================================================

CREATE TABLE audit_log (
    id              bigserial PRIMARY KEY,
    occurred_at     timestamptz NOT NULL DEFAULT now(),
    actor_id        uuid NULL,          -- the role assignment acted in
    actor_person_id uuid NULL,
    actor_role      text NULL,
    event_type      text NOT NULL,
    entity_type     text NOT NULL,
    entity_id       uuid NULL,
    area_id         uuid NULL,
    before_value    jsonb NULL,
    after_value     jsonb NULL,
    reason          text NULL,
    prev_hash       text NULL,
    row_hash        text NOT NULL,
    purge_after     timestamptz NULL      -- defaulted by trigger
);
CREATE INDEX maint_audit_entity ON audit_log (entity_type, entity_id, occurred_at DESC);
CREATE INDEX maint_audit_purge  ON audit_log (purge_after);

-- Hash chain. This trigger was absent in an earlier draft, which made every
-- audit insert fail on the NOT NULL row_hash. Caught in B2 testing.
CREATE OR REPLACE FUNCTION maint_audit_chain() RETURNS trigger AS $$
DECLARE prev text;
BEGIN
    SELECT row_hash INTO prev FROM audit_log ORDER BY id DESC LIMIT 1;
    NEW.prev_hash := prev;
    NEW.row_hash := encode(digest(
        coalesce(prev,'') || NEW.occurred_at::text || NEW.event_type ||
        NEW.entity_type || coalesce(NEW.entity_id::text,'') ||
        coalesce(NEW.actor_id::text,'') ||
        coalesce(NEW.after_value::text,''), 'sha256'), 'hex');
    IF NEW.purge_after IS NULL THEN
        NEW.purge_after := NEW.occurred_at + interval '2 years';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER maint_audit_chain_trigger
    BEFORE INSERT ON audit_log
    FOR EACH ROW EXECUTE FUNCTION maint_audit_chain();

-- A REVOKE is undone by any later blanket GRANT ... ON ALL TABLES.
-- A trigger is not.
-- Append-only, with exactly one exception: the retention purge.
--
-- The trigger and the job_retention grant previously contradicted each
-- other — DELETE was granted and then refused, so the 2-year retention
-- could never run and the audit log would have grown without limit.
--
-- The exception is deliberately narrow: only the RETENTION context, only
-- DELETE, and only rows whose purge_after has already passed. A row
-- inside its retention window cannot be removed by anyone.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
DECLARE expiry timestamptz;
BEGIN
    -- The table test must be a nested IF, not another AND. PostgreSQL does
    -- not guarantee short-circuit evaluation, so referencing OLD.purge_after
    -- in the same condition raised "record old has no field purge_after"
    -- on ticket_event, which has no such column — blocking the delete, but
    -- with a misleading error instead of the intended privilege refusal.
    IF TG_OP = 'DELETE' AND TG_TABLE_NAME = 'audit_log'
       AND current_setting('app.role', true) = 'RETENTION' THEN
        expiry := (to_jsonb(OLD) ->> 'purge_after')::timestamptz;
        IF expiry IS NOT NULL AND expiry < now() THEN
            RETURN OLD;
        END IF;
    END IF;
    RAISE EXCEPTION '% is append-only and cannot be modified', TG_TABLE_NAME
        USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_immutable
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER ticket_event_immutable
    BEFORE UPDATE OR DELETE ON ticket_event
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------
-- AUDIT LOG — scoped by area. Readable, never writable (see triggers).
-- ---------------------------------------------------------------------
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_delete ON audit_log FOR DELETE USING (
    current_role_name() = 'RETENTION' AND purge_after < now());
CREATE POLICY audit_scope ON audit_log FOR SELECT USING (
    current_role_name() IN ('GM_CIVIL','HQ_EXECUTIVE','ADMINISTRATOR','SYSTEM','RETENTION')
    -- officers and Area administrators in their Area; never occupants or
    -- contractors (open defect 2, closed 2026-09-30)
    OR (current_role_name() NOT IN ('RESIDENT','CUSTODIAN','CONTRACTOR','CONTRACTOR_SUPERVISOR')
        AND area_id IN (SELECT area_id FROM premises_ref)));
CREATE POLICY audit_insert ON audit_log FOR INSERT WITH CHECK (true);


-- =====================================================================
-- WORK ORDERS — who changes a contract, and the record of every change
-- (decision 2026-09-30, item 6)
--
-- A work order is evidence in a dispute about the contractor's term, so
-- its changes are held to the same standard as a ticket's: only the
-- Incharge (and the Staff Officer above them) write it, every change
-- carries a reason, and the log of it is written by the database, not by
-- whichever screen made the change.
-- =====================================================================

CREATE TABLE contract_extension (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id         uuid NOT NULL REFERENCES contract(id),
    seq                 smallint NOT NULL,          -- Extension 1, 2, …
    previous_expires_on date NOT NULL,
    extended_to         date NOT NULL,
    order_no            text NULL,
    granted_on          date NULL,
    reason              text NOT NULL CHECK (length(btrim(reason)) > 0),
    recorded_by         uuid NULL,                  -- role assignment
    recorded_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (contract_id, seq)
);

-- The contract copy and other orders. Kept for the life of the record:
-- the retention purge applies to complaint photographs, not to these.
CREATE TABLE contract_document (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    contract_id     uuid NOT NULL REFERENCES contract(id),
    kind            text NOT NULL DEFAULT 'CONTRACT_COPY'
                    CHECK (kind IN ('CONTRACT_COPY','EXTENSION_ORDER','OTHER')),
    file_name       text NOT NULL,
    content_type    text NOT NULL CHECK (content_type IN ('application/pdf','image/jpeg')),
    storage_key     text NOT NULL,
    content_hash    text NOT NULL,       -- SHA-256; checked again on every download
    size_bytes      integer NOT NULL,
    note            text NULL,
    uploaded_by     uuid NULL,           -- role assignment, set by trigger
    uploaded_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contract_document_of ON contract_document (contract_id, uploaded_at);

CREATE OR REPLACE FUNCTION contract_guard() RETURNS trigger AS $$
DECLARE actor text := current_setting('app.role', true);
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.original_expires_on := coalesce(NEW.original_expires_on, NEW.expires_on);
        RETURN NEW;
    END IF;
    -- fixed at award, for everyone
    IF NEW.area_id IS DISTINCT FROM OLD.area_id OR NEW.scope_path IS DISTINCT FROM OLD.scope_path
       OR NEW.original_expires_on IS DISTINCT FROM OLD.original_expires_on THEN
        RAISE EXCEPTION 'the Area and the completion date as awarded are fixed at award'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- expiry, handover and the extension trigger run as the system
    IF actor = 'SYSTEM' THEN
        RETURN NEW;
    END IF;
    IF NEW.expires_on IS DISTINCT FROM OLD.expires_on
       AND current_setting('app.via_extension', true) IS DISTINCT FROM 'on' THEN
        RAISE EXCEPTION 'the completion date moves only by a recorded extension'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.active IS DISTINCT FROM OLD.active
       OR NEW.handover_cutoff_at IS DISTINCT FROM OLD.handover_cutoff_at THEN
        RAISE EXCEPTION 'a contract ends only by handover or expiry'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF coalesce(btrim(current_setting('app.reason', true)), '') = '' THEN
        RAISE EXCEPTION 'every change to a work order needs a reason'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER contract_guard_trigger
    BEFORE INSERT OR UPDATE ON contract
    FOR EACH ROW EXECUTE FUNCTION contract_guard();

-- Written by the database for every award and change, with only the
-- fields that moved, so the log cannot be forgotten by a new screen.
CREATE OR REPLACE FUNCTION contract_audit() RETURNS trigger AS $$
DECLARE b jsonb := '{}'; a jsonb := '{}'; k text; ev text;
BEGIN
    IF TG_OP = 'INSERT' THEN
        ev := 'CONTRACT_AWARDED';
        a := to_jsonb(NEW) - 'id' - 'scope_path';
    ELSE
        FOR k IN SELECT jsonb_object_keys(to_jsonb(NEW)) LOOP
            IF to_jsonb(NEW) -> k IS DISTINCT FROM to_jsonb(OLD) -> k THEN
                b := b || jsonb_build_object(k, to_jsonb(OLD) -> k);
                a := a || jsonb_build_object(k, to_jsonb(NEW) -> k);
            END IF;
        END LOOP;
        IF a = '{}' THEN RETURN NULL; END IF;
        ev := CASE WHEN current_setting('app.via_extension', true) = 'on' THEN 'CONTRACT_EXTENDED'
                   ELSE 'CONTRACT_CHANGED' END;
    END IF;
    INSERT INTO audit_log (event_type, entity_type, entity_id, actor_id, actor_person_id,
                           actor_role, area_id, before_value, after_value, reason)
    VALUES (ev, 'contract', NEW.id, current_actor(), current_person(), current_role_name(),
            NEW.area_id, CASE WHEN b = '{}' THEN NULL ELSE b END, a,
            nullif(btrim(current_setting('app.reason', true)), ''));
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER contract_audit_trigger
    AFTER INSERT OR UPDATE ON contract
    FOR EACH ROW EXECUTE FUNCTION contract_audit();

-- An extension is numbered, must move the date forward, and moves the
-- contract's completion date itself — the only way that date moves.
CREATE OR REPLACE FUNCTION contract_extension_before() RETURNS trigger AS $$
DECLARE ct record;
BEGIN
    SELECT id, expires_on, handover_cutoff_at INTO ct FROM contract WHERE id = NEW.contract_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'contract not visible' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF ct.handover_cutoff_at IS NOT NULL THEN
        RAISE EXCEPTION 'this contract has been handed over' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.extended_to <= ct.expires_on THEN
        RAISE EXCEPTION 'an extension must run beyond the present completion date (%)', ct.expires_on
            USING ERRCODE = 'check_violation';
    END IF;
    NEW.seq := coalesce((SELECT max(seq) FROM contract_extension WHERE contract_id = NEW.contract_id), 0) + 1;
    NEW.previous_expires_on := ct.expires_on;
    NEW.recorded_by := current_actor();
    NEW.recorded_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION contract_extension_after() RETURNS trigger AS $$
BEGIN
    PERFORM set_config('app.via_extension', 'on', true);
    PERFORM set_config('app.reason', format('Extension %s%s: %s', NEW.seq,
        coalesce(' (' || NEW.order_no || ')', ''), NEW.reason), true);
    UPDATE contract SET expires_on = NEW.extended_to WHERE id = NEW.contract_id;
    PERFORM set_config('app.via_extension', '', true);
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER contract_extension_number
    BEFORE INSERT ON contract_extension
    FOR EACH ROW EXECUTE FUNCTION contract_extension_before();
CREATE TRIGGER contract_extension_apply
    AFTER INSERT ON contract_extension
    FOR EACH ROW EXECUTE FUNCTION contract_extension_after();
CREATE TRIGGER contract_extension_immutable
    BEFORE UPDATE OR DELETE ON contract_extension
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE OR REPLACE FUNCTION contract_document_before() RETURNS trigger AS $$
BEGIN
    NEW.uploaded_by := current_actor();
    NEW.uploaded_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER contract_document_owner
    BEFORE INSERT ON contract_document
    FOR EACH ROW EXECUTE FUNCTION contract_document_before();
CREATE TRIGGER contract_document_immutable
    BEFORE UPDATE OR DELETE ON contract_document
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Who writes. Reading follows the contract's own policy (contract_scope).
CREATE POLICY contract_write_insert ON contract AS RESTRICTIVE FOR INSERT
    WITH CHECK (current_role_name() IN ('MAINTENANCE_INCHARGE','STAFF_OFFICER_CIVIL','SYSTEM'));
CREATE POLICY contract_write_update ON contract AS RESTRICTIVE FOR UPDATE
    USING (current_role_name() IN ('MAINTENANCE_INCHARGE','STAFF_OFFICER_CIVIL','SYSTEM'));

ALTER TABLE contract_extension ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_extension FORCE ROW LEVEL SECURITY;
ALTER TABLE contract_document  ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_document  FORCE ROW LEVEL SECURITY;
CREATE POLICY extension_follows_contract ON contract_extension
    USING (EXISTS (SELECT 1 FROM contract c WHERE c.id = contract_id));
CREATE POLICY extension_write ON contract_extension AS RESTRICTIVE FOR INSERT
    WITH CHECK (current_role_name() IN ('MAINTENANCE_INCHARGE','STAFF_OFFICER_CIVIL','SYSTEM'));
CREATE POLICY document_follows_contract ON contract_document
    USING (EXISTS (SELECT 1 FROM contract c WHERE c.id = contract_id));
CREATE POLICY document_write ON contract_document AS RESTRICTIVE FOR INSERT
    WITH CHECK (current_role_name() IN ('MAINTENANCE_INCHARGE','STAFF_OFFICER_CIVIL','SYSTEM'));


-- =====================================================================
-- JOB CARD (decision 2026-09-30, item 5)
--
-- Prepared by the database the first time a complaint is assigned, so no
-- assignment can leave without one. The complaint's own details are read
-- live from the ticket; the card holds what the Overseer adds — scope of
-- work, site notes, work items with estimated quantities (no rates:
-- control 9). Read by the Overseer and everyone above; changed only by the
-- Overseer or the Civil Incharge; every change logged by the database;
-- locked once the complaint is closed or rejected.
-- =====================================================================

CREATE TABLE job_card (
    ticket_id       uuid PRIMARY KEY REFERENCES ticket(id),
    jc_no           text NOT NULL UNIQUE,        -- JC/<ticket number>
    area_id         uuid NOT NULL,
    scope_path      ltree NOT NULL,              -- denormalised for RLS
    prepared_at     timestamptz NOT NULL DEFAULT now(),
    scope_of_work   text NULL,
    site_notes      text NULL,
    updated_at      timestamptz NULL,
    updated_by      uuid NULL                    -- role assignment
);

CREATE TABLE job_card_item (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id         uuid NOT NULL REFERENCES job_card(ticket_id),
    seq               smallint NOT NULL,
    description       text NOT NULL CHECK (length(btrim(description)) > 0),
    unit              text NOT NULL CHECK (length(btrim(unit)) > 0),
    qty_estimated     numeric(12,3) NULL CHECK (qty_estimated >= 0),
    added_by          uuid NULL,
    added_at          timestamptz NOT NULL DEFAULT now(),
    -- an item is withdrawn, never deleted: the card shows what was once
    -- intended as well as what stands
    withdrawn_at      timestamptz NULL,
    withdrawn_by      uuid NULL,
    withdrawal_reason text NULL,
    UNIQUE (ticket_id, seq),
    CONSTRAINT withdrawal_has_reason CHECK (
        (withdrawn_at IS NULL) = (withdrawal_reason IS NULL)
        AND (withdrawal_reason IS NULL OR length(btrim(withdrawal_reason)) > 0))
);

-- the ticket's state, whoever asks (the guards must not depend on what
-- the caller happens to be able to see)
CREATE OR REPLACE FUNCTION ticket_state_of(p uuid) RETURNS ticket_state AS $$
    SELECT state FROM maint.ticket WHERE id = p;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = maint, public;

-- The approval chain after the work (2026-10-16): the step a job's materials
-- or measurements sheet is at. Defined here, as the job card and materials
-- rules use it.
CREATE TYPE sheet_kind  AS ENUM ('MATERIALS', 'MEASUREMENTS');
CREATE TYPE sheet_stage AS ENUM ('SUPERVISOR', 'OVERSEER', 'INCHARGE', 'STAFF_OFFICER', 'APPROVED');

-- Who changes a job card, and when (user's decisions, 2026-10-16). The card
-- follows the job's measurement sheet: at the supervisor's step the supervisor
-- the job is assigned to, and — up to closure, as before — the Overseer or
-- Incharge; at each later step the officer whose step it is; once the MB is
-- approved only the Staff Officer, with a reason. A rejected complaint's card
-- is part of the record.
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

CREATE OR REPLACE FUNCTION job_card_reason() RETURNS text AS $$
    SELECT nullif(btrim(current_setting('app.reason', true)), '');
$$ LANGUAGE sql STABLE;

-- Prepared on the first assignment, as the system: whoever assigned it,
-- the card exists. Later assignments (rework, reopening) keep the card.
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

CREATE TRIGGER ticket_prepares_job_card
    AFTER UPDATE OF state ON ticket
    FOR EACH ROW WHEN (NEW.state = 'ASSIGNED' AND OLD.state IS DISTINCT FROM 'ASSIGNED')
    EXECUTE FUNCTION job_card_prepare();

CREATE OR REPLACE FUNCTION job_card_guard() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF current_setting('app.jc_prepare', true) IS DISTINCT FROM 'on' THEN
            RAISE EXCEPTION 'a job card is prepared by the system when the complaint is assigned'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.ticket_id IS DISTINCT FROM OLD.ticket_id OR NEW.jc_no IS DISTINCT FROM OLD.jc_no
       OR NEW.area_id IS DISTINCT FROM OLD.area_id OR NEW.scope_path IS DISTINCT FROM OLD.scope_path
       OR NEW.prepared_at IS DISTINCT FROM OLD.prepared_at THEN
        RAISE EXCEPTION 'a job card''s number and complaint are fixed'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    PERFORM job_card_editor_check(NEW.ticket_id);
    -- filling a blank needs no reason; rewriting what is written does
    IF job_card_reason() IS NULL AND (
         (coalesce(btrim(OLD.scope_of_work), '') <> '' AND NEW.scope_of_work IS DISTINCT FROM OLD.scope_of_work)
      OR (coalesce(btrim(OLD.site_notes), '')   <> '' AND NEW.site_notes   IS DISTINCT FROM OLD.site_notes)) THEN
        RAISE EXCEPTION 'give the reason for correcting what is already on the job card'
            USING ERRCODE = 'check_violation';
    END IF;
    NEW.updated_at := now();
    NEW.updated_by := current_actor();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER job_card_guard_trigger
    BEFORE INSERT OR UPDATE ON job_card
    FOR EACH ROW EXECUTE FUNCTION job_card_guard();

CREATE OR REPLACE FUNCTION job_card_audit() RETURNS trigger AS $$
DECLARE b jsonb := '{}'; a jsonb := '{}'; k text;
BEGIN
    FOREACH k IN ARRAY ARRAY['scope_of_work','site_notes'] LOOP
        IF to_jsonb(NEW) -> k IS DISTINCT FROM to_jsonb(OLD) -> k THEN
            b := b || jsonb_build_object(k, to_jsonb(OLD) -> k);
            a := a || jsonb_build_object(k, to_jsonb(NEW) -> k);
        END IF;
    END LOOP;
    IF a = '{}' THEN RETURN NULL; END IF;
    INSERT INTO audit_log (event_type, entity_type, entity_id, actor_id, actor_person_id, actor_role,
                           area_id, before_value, after_value, reason)
    VALUES ('JOB_CARD_CHANGED', 'job_card', NEW.ticket_id, current_actor(), current_person(),
            current_role_name(), NEW.area_id, b, a, job_card_reason());
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER job_card_audit_trigger
    AFTER UPDATE ON job_card
    FOR EACH ROW EXECUTE FUNCTION job_card_audit();

CREATE OR REPLACE FUNCTION job_card_item_guard() RETURNS trigger AS $$
BEGIN
    PERFORM job_card_editor_check(NEW.ticket_id);
    IF TG_OP = 'INSERT' THEN
        NEW.seq := coalesce((SELECT max(seq) FROM job_card_item WHERE ticket_id = NEW.ticket_id), 0) + 1;
        NEW.added_by := current_actor();
        NEW.added_at := now();
        NEW.withdrawn_at := NULL; NEW.withdrawn_by := NULL; NEW.withdrawal_reason := NULL;
        RETURN NEW;
    END IF;
    IF NEW.ticket_id IS DISTINCT FROM OLD.ticket_id OR NEW.seq IS DISTINCT FROM OLD.seq
       OR NEW.added_by IS DISTINCT FROM OLD.added_by OR NEW.added_at IS DISTINCT FROM OLD.added_at THEN
        RAISE EXCEPTION 'an item''s place on the card and who added it are fixed'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.withdrawn_at IS NOT NULL THEN
        RAISE EXCEPTION 'a withdrawn item stays as it was withdrawn'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.withdrawal_reason IS NOT NULL THEN          -- withdrawing
        NEW.withdrawn_at := now();
        NEW.withdrawn_by := current_actor();
    ELSIF (NEW.description, NEW.unit, NEW.qty_estimated) IS DISTINCT FROM (OLD.description, OLD.unit, OLD.qty_estimated)
          AND job_card_reason() IS NULL THEN
        RAISE EXCEPTION 'give the reason for changing a work item'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER job_card_item_guard_trigger
    BEFORE INSERT OR UPDATE ON job_card_item
    FOR EACH ROW EXECUTE FUNCTION job_card_item_guard();

CREATE OR REPLACE FUNCTION job_card_item_audit() RETURNS trigger AS $$
DECLARE ev text; b jsonb; area uuid;
BEGIN
    SELECT area_id INTO area FROM job_card WHERE ticket_id = NEW.ticket_id;
    IF TG_OP = 'INSERT' THEN
        ev := 'JOB_CARD_ITEM_ADDED';
    ELSIF NEW.withdrawn_at IS NOT NULL THEN
        ev := 'JOB_CARD_ITEM_WITHDRAWN';
        b := jsonb_build_object('description', OLD.description, 'unit', OLD.unit, 'qty_estimated', OLD.qty_estimated);
    ELSE
        ev := 'JOB_CARD_ITEM_CHANGED';
        b := jsonb_build_object('description', OLD.description, 'unit', OLD.unit, 'qty_estimated', OLD.qty_estimated);
    END IF;
    INSERT INTO audit_log (event_type, entity_type, entity_id, actor_id, actor_person_id, actor_role,
                           area_id, before_value, after_value, reason)
    VALUES (ev, 'job_card', NEW.ticket_id, current_actor(), current_person(), current_role_name(), area, b,
            jsonb_build_object('item', NEW.seq, 'description', NEW.description, 'unit', NEW.unit,
                               'qty_estimated', NEW.qty_estimated),
            coalesce(NEW.withdrawal_reason, job_card_reason()));
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER job_card_item_audit_trigger
    AFTER INSERT OR UPDATE ON job_card_item
    FOR EACH ROW EXECUTE FUNCTION job_card_item_audit();

CREATE TRIGGER job_card_no_delete
    BEFORE DELETE ON job_card
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER job_card_item_no_delete
    BEFORE DELETE ON job_card_item
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Readers: the Overseer and everyone above, in their scope. Never the
-- occupant or the contractor.
ALTER TABLE job_card      ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_card      FORCE ROW LEVEL SECURITY;
ALTER TABLE job_card_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_card_item FORCE ROW LEVEL SECURITY;
CREATE POLICY job_card_read ON job_card USING (
    current_role_name() = 'SYSTEM'
    OR (current_role_name() IN ('CIVIL_OVERSEER','MAINTENANCE_INCHARGE','STAFF_OFFICER_CIVIL',
                                'GM_CIVIL','HQ_EXECUTIVE','ADMINISTRATOR')
        AND scope_path <@ current_scope())
    -- the supervisor the job is assigned to reads the whole card (2026-10-16)
    OR (current_role_name() = 'CONTRACTOR_SUPERVISOR' AND EXISTS (SELECT 1 FROM ticket t WHERE t.id = job_card.ticket_id)));
CREATE POLICY job_card_write ON job_card AS RESTRICTIVE FOR UPDATE
    USING (current_role_name() IN ('CIVIL_OVERSEER','MAINTENANCE_INCHARGE','CONTRACTOR_SUPERVISOR','STAFF_OFFICER_CIVIL'));
CREATE POLICY job_card_insert ON job_card AS RESTRICTIVE FOR INSERT
    WITH CHECK (current_role_name() = 'SYSTEM');
CREATE POLICY job_card_item_read ON job_card_item USING (
    EXISTS (SELECT 1 FROM job_card jc WHERE jc.ticket_id = job_card_item.ticket_id));
CREATE POLICY job_card_item_write ON job_card_item AS RESTRICTIVE FOR UPDATE
    USING (current_role_name() IN ('CIVIL_OVERSEER','MAINTENANCE_INCHARGE','CONTRACTOR_SUPERVISOR','STAFF_OFFICER_CIVIL'));
CREATE POLICY job_card_item_insert ON job_card_item AS RESTRICTIVE FOR INSERT
    WITH CHECK (current_role_name() IN ('CIVIL_OVERSEER','MAINTENANCE_INCHARGE','CONTRACTOR_SUPERVISOR','STAFF_OFFICER_CIVIL'));


-- =====================================================================
-- MATERIALS (decision 2026-09-30, item 9) — a record, never a bill
--
-- Under the comprehensive contract the contractor supplies the materials.
-- The portal records what the contractor says was used on each job and
-- what Civil verified at inspection, so consumption can be compared and
-- odd patterns flagged. No rate, price or amount exists anywhere here
-- (control 9). Every rule is the database's: the screens only follow.
-- =====================================================================

CREATE TABLE material (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code              text NOT NULL UNIQUE,
    name_en           text NOT NULL CHECK (length(btrim(name_en)) > 0),
    name_hi           text NOT NULL CHECK (length(btrim(name_hi)) > 0),
    unit              text NOT NULL CHECK (length(btrim(unit)) > 0),
    category          text NULL,
    -- the most one job would normally need; above it the job is flagged
    norm_max_per_job  numeric(12,3) NULL CHECK (norm_max_per_job > 0),
    active            boolean NOT NULL DEFAULT true,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NULL
);


CREATE TABLE material_claim (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id           uuid NOT NULL REFERENCES ticket(id),
    seq                 smallint NOT NULL,
    material_id         uuid NOT NULL REFERENCES material(id),
    qty_claimed         numeric(12,3) NOT NULL CHECK (qty_claimed > 0),
    claimed_by          uuid NULL,              -- role assignment
    claimed_by_person   uuid NULL,
    claimed_at          timestamptz NOT NULL DEFAULT now(),
    -- how the claiming session signed in (see ticket_event.via): a supervisor
    -- may record materials from the web since 2026-10-16
    claimed_via         text NULL DEFAULT nullif(current_setting('app.auth_method', true), ''),
    withdrawn_at        timestamptz NULL,
    withdrawal_reason   text NULL,
    qty_verified        numeric(12,3) NULL CHECK (qty_verified >= 0),
    verified_by         uuid NULL,
    verified_by_person  uuid NULL,
    verified_at         timestamptz NULL,
    verification_remark text NULL,
    -- copied from the ticket when claimed: reports and row security
    contract_id         uuid NULL,
    premises_id         uuid NOT NULL,
    area_id             uuid NOT NULL,
    scope_path          ltree NOT NULL,
    UNIQUE (ticket_id, seq),
    CONSTRAINT claim_withdrawal_has_reason CHECK (
        (withdrawn_at IS NULL) = (withdrawal_reason IS NULL)
        AND (withdrawal_reason IS NULL OR length(btrim(withdrawal_reason)) > 0)),
    CONSTRAINT withdrawn_is_not_verified CHECK (withdrawn_at IS NULL OR qty_verified IS NULL)
);
CREATE INDEX material_claim_ticket   ON material_claim (ticket_id, seq);
CREATE INDEX material_claim_report   ON material_claim (contract_id, claimed_at);
CREATE INDEX material_claim_premises ON material_claim (premises_id, material_id, claimed_at);

CREATE OR REPLACE FUNCTION material_guard() RETURNS trigger AS $$
BEGIN
    IF current_role_name() IS DISTINCT FROM 'ADMINISTRATOR' AND current_role_name() IS DISTINCT FROM 'SYSTEM' THEN
        RAISE EXCEPTION 'the materials master is kept by the HQ System Administrator'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF NEW.code IS DISTINCT FROM OLD.code OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
            RAISE EXCEPTION 'a material''s code is fixed; add a new material instead'
                USING ERRCODE = 'check_violation';
        END IF;
        IF current_role_name() <> 'SYSTEM' AND job_card_reason() IS NULL THEN
            RAISE EXCEPTION 'give the reason for changing the materials master'
                USING ERRCODE = 'check_violation';
        END IF;
        NEW.updated_at := now();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER material_guard_trigger
    BEFORE INSERT OR UPDATE ON material
    FOR EACH ROW EXECUTE FUNCTION material_guard();

CREATE OR REPLACE FUNCTION material_audit() RETURNS trigger AS $$
DECLARE b jsonb := '{}'; a jsonb := '{}'; k text;
BEGIN
    IF TG_OP = 'INSERT' THEN
        a := to_jsonb(NEW) - 'id' - 'created_at' - 'updated_at';
    ELSE
        FOR k IN SELECT jsonb_object_keys(to_jsonb(NEW) - 'updated_at') LOOP
            IF to_jsonb(NEW) -> k IS DISTINCT FROM to_jsonb(OLD) -> k THEN
                b := b || jsonb_build_object(k, to_jsonb(OLD) -> k);
                a := a || jsonb_build_object(k, to_jsonb(NEW) -> k);
            END IF;
        END LOOP;
        IF a = '{}' THEN RETURN NULL; END IF;
    END IF;
    INSERT INTO audit_log (event_type, entity_type, entity_id, actor_id, actor_person_id, actor_role,
                           before_value, after_value, reason)
    VALUES (CASE WHEN TG_OP = 'INSERT' THEN 'MATERIAL_ADDED' ELSE 'MATERIAL_CHANGED' END,
            'material', NEW.id, current_actor(), current_person(), current_role_name(),
            CASE WHEN b = '{}' THEN NULL ELSE b END, a, job_card_reason());
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER material_audit_trigger
    AFTER INSERT OR UPDATE ON material
    FOR EACH ROW EXECUTE FUNCTION material_audit();

-- The ticket as the claim rules need it, whoever asks.
CREATE OR REPLACE FUNCTION ticket_for_claim(p uuid)
RETURNS TABLE (state ticket_state, assigned_to uuid, contract_id uuid, premises_id uuid,
               area_id uuid, scope_path ltree) AS $$
    SELECT state, assigned_to, contract_id, premises_id, area_id, scope_path FROM maint.ticket WHERE id = p;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = maint, public;

-- The same, waiting for any change to the complaint in flight and reading
-- its latest state: a material claimed at the same moment as the completion
-- claim must not slip in behind it (break-it pass, 2026-10-08).
CREATE OR REPLACE FUNCTION ticket_for_claim_locked(p uuid)
RETURNS TABLE (state ticket_state, assigned_to uuid, contract_id uuid, premises_id uuid,
               area_id uuid, scope_path ltree) AS $$
    SELECT state, assigned_to, contract_id, premises_id, area_id, scope_path FROM maint.ticket WHERE id = p FOR SHARE;
$$ LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = maint, public;

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

CREATE TRIGGER material_claim_guard_trigger
    BEFORE INSERT OR UPDATE ON material_claim
    FOR EACH ROW EXECUTE FUNCTION material_claim_guard();

CREATE OR REPLACE FUNCTION material_claim_audit() RETURNS trigger AS $$
DECLARE ev text; b jsonb := NULL; a jsonb; m record;
BEGIN
    SELECT code, name_en, unit INTO m FROM material WHERE id = NEW.material_id;
    a := jsonb_build_object('line', NEW.seq, 'code', m.code, 'name_en', m.name_en, 'unit', m.unit,
                            'qty_claimed', NEW.qty_claimed);
    IF TG_OP = 'INSERT' THEN
        ev := 'MATERIAL_CLAIMED';
    ELSIF NEW.withdrawn_at IS NOT NULL THEN
        ev := 'MATERIAL_CLAIM_WITHDRAWN';
    ELSE
        ev := CASE WHEN OLD.qty_verified IS NULL THEN 'MATERIAL_VERIFIED' ELSE 'MATERIAL_REVERIFIED' END;
        IF OLD.qty_verified IS NOT NULL THEN
            b := jsonb_build_object('qty_verified', OLD.qty_verified, 'verification_remark', OLD.verification_remark);
        END IF;
        a := a || jsonb_build_object('qty_verified', NEW.qty_verified, 'verification_remark', NEW.verification_remark);
    END IF;
    INSERT INTO audit_log (event_type, entity_type, entity_id, actor_id, actor_person_id, actor_role,
                           area_id, before_value, after_value, reason)
    VALUES (ev, 'material_claim', NEW.ticket_id, current_actor(), current_person(), current_role_name(),
            NEW.area_id, b, a, coalesce(NEW.withdrawal_reason, job_card_reason()));
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER material_claim_audit_trigger
    AFTER INSERT OR UPDATE ON material_claim
    FOR EACH ROW EXECUTE FUNCTION material_claim_audit();

CREATE TRIGGER material_no_delete
    BEFORE DELETE ON material
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER material_claim_no_delete
    BEFORE DELETE ON material_claim
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- The master is read by everyone, written by the administrator only.
ALTER TABLE material       ENABLE ROW LEVEL SECURITY;
ALTER TABLE material       FORCE ROW LEVEL SECURITY;
CREATE POLICY material_read ON material USING (true);
CREATE POLICY material_write_insert ON material AS RESTRICTIVE FOR INSERT
    WITH CHECK (current_role_name() IN ('ADMINISTRATOR','SYSTEM'));
CREATE POLICY material_write_update ON material AS RESTRICTIVE FOR UPDATE
    USING (current_role_name() IN ('ADMINISTRATOR','SYSTEM'));

-- Claim lines follow the complaint's own visibility (Area, the
-- supervisor's own jobs, the firm's own contract), and are never shown to
-- the occupant.
ALTER TABLE material_claim ENABLE ROW LEVEL SECURITY;
ALTER TABLE material_claim FORCE ROW LEVEL SECURITY;
CREATE POLICY material_claim_read ON material_claim USING (
    current_role_name() NOT IN ('RESIDENT','CUSTODIAN')
    AND EXISTS (SELECT 1 FROM ticket t WHERE t.id = material_claim.ticket_id));
-- the supervisor claims; in the approval chain after the work an officer adds
-- a missed line or changes a quantity at their own step, the Staff Officer
-- included (2026-10-16) — material_claim_guard decides whose step it is
CREATE POLICY material_claim_insert ON material_claim AS RESTRICTIVE FOR INSERT
    WITH CHECK (current_role_name() IN ('CONTRACTOR_SUPERVISOR','CIVIL_OVERSEER','MAINTENANCE_INCHARGE','STAFF_OFFICER_CIVIL'));
CREATE POLICY material_claim_update ON material_claim AS RESTRICTIVE FOR UPDATE
    USING (current_role_name() IN ('CONTRACTOR_SUPERVISOR','CIVIL_OVERSEER','MAINTENANCE_INCHARGE','STAFF_OFFICER_CIVIL'));


-- =====================================================================
-- THE WHOLE LIFE OF A JOB (user's finding, 2026-10-07)
--
-- A job may go round several times — sent back by the Overseer, disputed
-- and reopened by the occupant — and the record must show every round from
-- the first, not just the latest. Two things were being lost: the workmen
-- (overwritten on the ticket at each start) and the occupant's answer
-- (feedback updated in place, so a dispute vanished once they were later
-- satisfied). Both are now written into the append-only ticket history by
-- the database, whichever route made the change.
-- =====================================================================

CREATE OR REPLACE FUNCTION ticket_snapshot(p uuid) RETURNS jsonb AS $$
    SELECT jsonb_build_object('assigned_to', assigned_to, 'contract_id', contract_id,
                              'workmen_assigned', workmen_assigned, 'inspected_by', inspected_by)
      FROM maint.ticket WHERE id = p;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = maint, public;

CREATE OR REPLACE FUNCTION ticket_event_detail() RETURNS trigger AS $$
DECLARE snap jsonb;
BEGIN
    IF NEW.detail IS NULL AND NEW.to_state IN ('ASSIGNED','IN_PROGRESS','WORK_COMPLETED',
                                               'INSPECTED_ACCEPTED','REWORK') THEN
        snap := ticket_snapshot(NEW.ticket_id);
        NEW.detail := CASE NEW.to_state
            WHEN 'ASSIGNED'    THEN jsonb_build_object('assigned_to', snap->'assigned_to', 'contract_id', snap->'contract_id')
            WHEN 'IN_PROGRESS' THEN jsonb_build_object('assigned_to', snap->'assigned_to', 'workmen_assigned', snap->'workmen_assigned')
            ELSE jsonb_build_object('assigned_to', snap->'assigned_to', 'inspected_by', snap->'inspected_by')
        END;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ticket_event_detail_trigger
    BEFORE INSERT ON ticket_event
    FOR EACH ROW EXECUTE FUNCTION ticket_event_detail();

-- Every answer the occupant gives is a fact of its own: the ticket_feedback
-- row keeps only the latest, the history keeps them all.
CREATE OR REPLACE FUNCTION ticket_feedback_history() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND (NEW.confirmed, NEW.rating, NEW.comment)
                            IS NOT DISTINCT FROM (OLD.confirmed, OLD.rating, OLD.comment) THEN
        RETURN NULL;
    END IF;
    INSERT INTO ticket_event (ticket_id, event_type, actor_id, actor_role, reason, detail)
    VALUES (NEW.ticket_id,
            CASE WHEN NEW.confirmed THEN 'OCCUPANT_CONFIRMED'
                 WHEN NEW.confirmed = false THEN 'OCCUPANT_DISPUTED'
                 ELSE 'OCCUPANT_NO_RESPONSE' END,
            coalesce(current_actor(), NEW.actor_id), coalesce(current_role_name(), 'SYSTEM'),
            NEW.comment,
            jsonb_build_object('confirmed', NEW.confirmed, 'rating', NEW.rating, 'comment', NEW.comment));
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ticket_feedback_history_trigger
    AFTER INSERT OR UPDATE ON ticket_feedback
    FOR EACH ROW EXECUTE FUNCTION ticket_feedback_history();


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

-- At most three BEFORE and three AFTER photographs in a round; and at most
-- three of the occupant's (COMPLAINT, OBJECTION) at each step of the
-- complaint (user's finding, 2026-10-10) — counted from the last change of
-- state, so raising, each reopening and the work under way each allow three.
-- A reopening's photograph is taken before the reopening is recorded, so it
-- falls in the step it reopens, which is what is wanted.
-- Whether the supervisor a complaint is assigned to still holds that role
-- (user's finding, 2026-10-12: complaints sat with ended roles, where nobody
-- could start them). Definer, so the queue can say so to every officer even
-- where the caller's row policy hides the supervisor's own record; it
-- answers yes or no and nothing more.
CREATE OR REPLACE FUNCTION assignee_role_ended(a uuid) RETURNS boolean AS $$
    SELECT a IS NOT NULL AND coalesce((SELECT status <> 'ACTIVE' FROM maint.actor_ref WHERE actor_id = a), true);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = maint, public;

CREATE OR REPLACE FUNCTION ticket_window_of(p uuid) RETURNS timestamptz AS $$
    SELECT contractor_window_started_at FROM maint.ticket WHERE id = p;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = maint, public;

CREATE OR REPLACE FUNCTION ticket_step_began(p uuid) RETURNS timestamptz AS $$
    SELECT max(occurred_at) FROM maint.ticket_event WHERE ticket_id = p AND to_state IS NOT NULL;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = maint, public;

CREATE OR REPLACE FUNCTION media_round_limit() RETURNS trigger AS $$
DECLARE since timestamptz;
BEGIN
    IF NEW.upload_state = 'STORED' AND OLD.upload_state IS DISTINCT FROM 'STORED'
       AND NEW.purpose IN ('BEFORE','COMPLETION','COMPLAINT','OBJECTION') THEN
        since := coalesce(CASE WHEN NEW.purpose IN ('BEFORE','COMPLETION') THEN ticket_window_of(NEW.ticket_id)
                               ELSE ticket_step_began(NEW.ticket_id) END, '-infinity'::timestamptz);
        IF (SELECT count(*) FROM ticket_media m
             WHERE m.ticket_id = NEW.ticket_id AND m.purpose = NEW.purpose AND m.id <> NEW.id
               AND m.upload_state = 'STORED' AND m.uploaded_at >= since) >= 3 THEN
            RAISE EXCEPTION '%', CASE NEW.purpose
                WHEN 'BEFORE' THEN 'At most three "before" photographs for each round of work'
                WHEN 'COMPLETION' THEN 'At most three "after" photographs for each round of work'
                ELSE 'At most three photographs at a time' END
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
  'Difference between measured and check-measured quantity beyond which an entry is flagged'),
 ('sheet_waiting_days','7','integer',
  'Days a job''s materials or measurements may wait at one step of the approval chain before it is flagged')
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
    WITH CHECK (current_role_name() IN ('CIVIL_OVERSEER','MAINTENANCE_INCHARGE','CONTRACTOR_SUPERVISOR','STAFF_OFFICER_CIVIL'));
CREATE POLICY measurement_update ON measurement AS RESTRICTIVE FOR UPDATE
    USING (current_role_name() IN ('CIVIL_OVERSEER','MAINTENANCE_INCHARGE','CONTRACTOR_SUPERVISOR','STAFF_OFFICER_CIVIL'));

-- ---------------------------------------------------------------------
-- PAUSES AND BREACHES: WHO MAY RECORD THEM (break-it pass, 2026-10-08)
--
-- The pause table's only defence was a CHECK on paused_by_role — a value
-- the writer supplies. A contractor's session wrote a pause naming itself
-- "CIVIL_OVERSEER" and the check passed; it could also end the
-- department's pause early. The breach table had no write guard at all:
-- the contractor's session rewrote whose delay a breach was (open defect
-- 1, checked only by the API until now). Both are now the database's:
-- who paused, who resumed and who attributed are taken from the session,
-- never from the row, and only a departmental officer may do any of it.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sla_pause_guard() RETURNS trigger AS $$
DECLARE role text := current_setting('app.role', true);
BEGIN
    IF role = 'SYSTEM' THEN RETURN NEW; END IF;
    IF role IS NULL OR role NOT IN ('CIVIL_OVERSEER','MAINTENANCE_INCHARGE','STAFF_OFFICER_CIVIL') THEN
        RAISE EXCEPTION 'only a departmental officer records or ends a pause of the SLA clock'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF TG_OP = 'INSERT' THEN
        -- who paused is the session, whatever the row says
        NEW.paused_by := nullif(current_setting('app.actor_id', true), '')::uuid;
        NEW.paused_by_role := role;
        NEW.paused_at := now();
        NEW.resumed_at := NULL; NEW.resumed_by := NULL;
        IF NEW.paused_by IS NULL THEN
            RAISE EXCEPTION 'a pause is recorded by a named officer' USING ERRCODE = 'insufficient_privilege';
        END IF;
        RETURN NEW;
    END IF;
    IF (NEW.id, NEW.ticket_id, NEW.clock, NEW.attribution, NEW.reason, NEW.paused_at, NEW.paused_by, NEW.paused_by_role)
       IS DISTINCT FROM
       (OLD.id, OLD.ticket_id, OLD.clock, OLD.attribution, OLD.reason, OLD.paused_at, OLD.paused_by, OLD.paused_by_role) THEN
        RAISE EXCEPTION 'a recorded pause cannot be changed; only ended' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.resumed_at IS NOT NULL THEN
        RAISE EXCEPTION 'this pause has already ended' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.resumed_at IS NOT NULL THEN
        NEW.resumed_at := now();          -- the clock restarts now, not at a chosen time
        NEW.resumed_by := nullif(current_setting('app.actor_id', true), '')::uuid;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sla_pause_guard_trigger
    BEFORE INSERT OR UPDATE ON sla_pause
    FOR EACH ROW EXECUTE FUNCTION sla_pause_guard();
CREATE TRIGGER sla_pause_no_delete
    BEFORE DELETE ON sla_pause
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE OR REPLACE FUNCTION sla_breach_guard() RETURNS trigger AS $$
DECLARE role text := current_setting('app.role', true);
BEGIN
    IF role = 'SYSTEM' THEN RETURN NEW; END IF;
    IF TG_OP = 'INSERT' THEN
        RAISE EXCEPTION 'a breach is recorded by the SLA sweep, not by a person'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- the contractor is the party this decides against, so they do not
    -- get to make it; neither does the resident
    IF role IS NULL OR role NOT IN ('CIVIL_OVERSEER','MAINTENANCE_INCHARGE','STAFF_OFFICER_CIVIL','ADMINISTRATOR') THEN
        RAISE EXCEPTION 'only a departmental officer attributes a delay'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF (NEW.id, NEW.ticket_id, NEW.clock, NEW.breached_at) IS DISTINCT FROM (OLD.id, OLD.ticket_id, OLD.clock, OLD.breached_at) THEN
        RAISE EXCEPTION 'a recorded breach cannot be changed; only attributed' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.attribution IS NULL THEN
        RAISE EXCEPTION 'give the attribution' USING ERRCODE = 'check_violation';
    END IF;
    NEW.attributed_by := nullif(current_setting('app.actor_id', true), '')::uuid;
    NEW.attributed_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sla_breach_guard_trigger
    BEFORE INSERT OR UPDATE ON sla_breach
    FOR EACH ROW EXECUTE FUNCTION sla_breach_guard();
CREATE TRIGGER sla_breach_no_delete
    BEFORE DELETE ON sla_breach
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- every attribution is logged by the database, whatever route made it
CREATE OR REPLACE FUNCTION sla_breach_audit() RETURNS trigger AS $$
BEGIN
    IF NEW.attribution IS DISTINCT FROM OLD.attribution OR NEW.note IS DISTINCT FROM OLD.note THEN
        INSERT INTO audit_log (event_type, entity_type, entity_id, actor_id, actor_person_id, actor_role,
                               before_value, after_value, reason)
        VALUES ('DELAY_ATTRIBUTED', 'sla_breach', NEW.id, current_actor(), current_person(), current_role_name(),
                jsonb_build_object('attribution', OLD.attribution), jsonb_build_object('attribution', NEW.attribution),
                NEW.note);
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sla_breach_audit_trigger
    AFTER UPDATE ON sla_breach
    FOR EACH ROW EXECUTE FUNCTION sla_breach_audit();


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


-- =====================================================================
-- THE APPROVAL CHAIN AFTER THE WORK (user's decisions, 2026-10-16;
-- README §5.5 "Materials and measurements after the work")
--
-- Each job has a sheet for its materials and one for its measurements.
-- A sheet moves up contractor supervisor -> Civil Overseer -> Civil Colony
-- Incharge -> Area Civil Staff Officer, who approves it; any step may send
-- it back one step with a remark. No step is skipped. Who may move it, and
-- when, is decided here, not by the screens; every move is a fact in
-- job_sheet_event, never changed or deleted. Quantities only (control 9).
-- =====================================================================
-- (the types sheet_kind and sheet_stage are defined before the materials tables)

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


DO $$ BEGIN
    CREATE ROLE app_maint NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;   -- roles are cluster-wide
END $$;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA maint TO app_maint;
REVOKE UPDATE, DELETE ON audit_log FROM app_maint;
REVOKE UPDATE, DELETE ON ticket_event FROM app_maint;   -- events are facts
GRANT INSERT, SELECT ON audit_log, ticket_event TO app_maint;
