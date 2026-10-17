-- 2026-10-13 — a person's phones registered in another Area, counted only.
-- Apply to the identity database (cut from sql/01_identity_schema.sql):
--   psql -h localhost -U postgres -d ncl_identity -v ON_ERROR_STOP=1 -f sql/migrations/2026-10-13_phones_elsewhere.sql
-- Back up first (../Archive/db_backups/). Adds one function; changes no data.
SET search_path = identity, public;
BEGIN;
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
COMMIT;
