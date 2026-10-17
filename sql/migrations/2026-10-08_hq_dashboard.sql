-- Migration 2026-10-08: HQ executive dashboard — one setting, the SLA target
-- the dashboard measures every Area against. Nothing else in the schema
-- changes; the dashboard reads the record as it stands.
--   psql -h localhost -U postgres -d ncl_maint -v ON_ERROR_STOP=1 -f <this file>

SET search_path TO maint, public;
INSERT INTO maint_config (key, value, data_type, description) VALUES
 ('hq_sla_target_percent','90','integer',
  'SLA compliance the HQ dashboard measures every Area against')
ON CONFLICT (key) DO NOTHING;
