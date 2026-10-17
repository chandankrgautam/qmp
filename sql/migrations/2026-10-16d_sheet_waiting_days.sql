-- 2026-10-16: the setting behind the flag for a job's materials or measurements
-- waiting too long at one step of the approval chain — user's decisions, README
-- §5.5 "Working through a month's MB; finding it years later" (phase 5).
-- Cut from sql/02_maintenance_schema.sql. Run as the superuser on ncl_maint:
--   psql -h localhost -U postgres -d ncl_maint -f sql/migrations/2026-10-16d_sheet_waiting_days.sql
BEGIN;
SET LOCAL search_path = maint, public;
SET LOCAL app.role = 'SYSTEM';
INSERT INTO maint_config (key, value, data_type, description) VALUES
 ('sheet_waiting_days','7','integer',
  'Days a job''s materials or measurements may wait at one step of the approval chain before it is flagged')
ON CONFLICT (key) DO NOTHING;
COMMIT;
