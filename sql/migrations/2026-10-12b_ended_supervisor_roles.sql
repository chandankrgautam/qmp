-- Migration 2026-10-12 (b): complaints held by a supervisor whose role has
-- ended are marked for reassignment (user's finding). Matches
-- sql/02_maintenance_schema.sql (assignee_role_ended).
--   psql -h localhost -U postgres -d ncl_maint -v ON_ERROR_STOP=1 -f <this file>

SET search_path TO maint, public;
CREATE OR REPLACE FUNCTION assignee_role_ended(a uuid) RETURNS boolean AS $$
    SELECT a IS NOT NULL AND coalesce((SELECT status <> 'ACTIVE' FROM maint.actor_ref WHERE actor_id = a), true);
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = maint, public;
