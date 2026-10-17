-- 2026-10-15: objections hidden from the contractor firm as well as its
-- supervisor (README §2). Until now the policy named only the supervisor,
-- so the firm's own role could read the occupant's objections.
-- Cut from sql/02_maintenance_schema.sql. Run as the superuser on ncl_maint:
--   psql -h localhost -U postgres -d ncl_maint -f sql/migrations/2026-10-15b_objections_hidden_from_firm.sql
BEGIN;
SET LOCAL search_path = maint, public;
DROP POLICY IF EXISTS objection_via_ticket ON ticket_objection;
CREATE POLICY objection_via_ticket  ON ticket_objection USING (
    ticket_is_visible(ticket_id)
    AND current_role_name() NOT IN ('CONTRACTOR','CONTRACTOR_SUPERVISOR'));
COMMIT;
