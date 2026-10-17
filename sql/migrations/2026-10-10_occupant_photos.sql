-- Migration 2026-10-10: the occupant's photographs (user's finding).
-- At most three COMPLAINT and three OBJECTION photographs at each step of a
-- complaint (as the contractor's three before / three after per round), and
-- an objection's photograph is never shown to the contractor (README §2).
-- Matches sql/02_maintenance_schema.sql (ticket_step_began,
-- media_round_limit, media_no_objection_for_contractor).
--   psql -h localhost -U postgres -d ncl_maint -v ON_ERROR_STOP=1 -f <this file>

SET search_path TO maint, public;
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

CREATE POLICY media_no_objection_for_contractor ON ticket_media AS RESTRICTIVE FOR SELECT
    USING (purpose <> 'OBJECTION' OR current_role_name() NOT IN ('CONTRACTOR','CONTRACTOR_SUPERVISOR'));
