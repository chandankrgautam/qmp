-- =====================================================================
-- LOAD SIMULATION — PART 1: bulk premises
--
-- Builds the estate the portal will actually run against: roughly 15,000
-- quarters across thirteen Areas, plus the non-residential premises each
-- Area holds. Run against a database that already has the reference seed.
--
-- Quarter type mix reflects a coal township: worker quarters dominate,
-- executive quarters are few.
--    A  45%   B  25%   C  15%   MQ 10%   D  5%
-- =====================================================================

SET search_path TO identity, public;
SET app.role = 'SYSTEM';
SET app.scope_path = 'ncl';

\timing on

-- ~1150 quarters per Area across thirteen Areas
INSERT INTO identity.premises
  (area_id, colony_id, scope_path, identifier, premises_type, quarter_type,
   occupancy_model, verified, verified_at)
SELECT col.area_id,
       col.id,
       col.scope_path,
       qt.code || '-' || n,
       'QUARTER',
       qt.code::quarter_type,
       'RESIDENT_BOUND',
       true,
       now() - (random() * interval '180 days')
  FROM identity.colony col
  CROSS JOIN LATERAL (
    VALUES ('A', 519), ('B', 288), ('C', 173), ('MQ', 115), ('D', 58)
  ) AS qt(code, cnt)
  CROSS JOIN LATERAL generate_series(1, qt.cnt) AS n
ON CONFLICT (colony_id, identifier) DO NOTHING;

-- non-residential premises: the three occupancy models must all be exercised
INSERT INTO identity.premises
  (area_id, colony_id, scope_path, identifier, premises_type,
   occupancy_model, verified, verified_at)
SELECT col.area_id, col.id, col.scope_path,
       np.label || CASE WHEN np.cnt > 1 THEN ' ' || n ELSE '' END,
       np.ptype::premises_type, np.occ::occupancy_model, true, now()
  FROM identity.colony col
  -- All under direct Civil Department control: no permanent residents,
  -- so no device to bind and nobody to confirm completion.
  CROSS JOIN LATERAL (
    VALUES ('Guest House',    'GUEST_HOUSE',    'DEPARTMENT_ONLY',  2),
           ('Hostel',         'HOSTEL',         'DEPARTMENT_ONLY',  2),
           ('Dispensary',     'DISPENSARY',     'DEPARTMENT_ONLY',  1),
           ('School',         'SCHOOL',         'DEPARTMENT_ONLY',  1),
           ('Club',           'CLUB',           'DEPARTMENT_ONLY',  1),
           ('Union Office',   'UNION_OFFICE',   'DEPARTMENT_ONLY',  1),
           ('Admin Building', 'ADMIN_BUILDING', 'DEPARTMENT_ONLY',  2)
  ) AS np(label, ptype, occ, cnt)
  CROSS JOIN LATERAL generate_series(1, np.cnt) AS n
ON CONFLICT (colony_id, identifier) DO NOTHING;

-- one resident device per quarter, plus a second on a third of them
-- (family handsets), so notification fan-out is realistic
INSERT INTO identity.person (name, mobile)
SELECT 'Occupant ' || p.id,
       '9' || lpad((random() * 999999999)::bigint::text, 9, '0')
  FROM identity.premises p
 WHERE p.premises_type = 'QUARTER'
   AND NOT EXISTS (SELECT 1 FROM identity.device d WHERE d.premises_id = p.id);

INSERT INTO identity.device
  (public_key, platform, person_id, role, scope_path, premises_id,
   requires_second_factor, status)
SELECT 'simkey-' || p.id, 'android', pe.id, 'RESIDENT', p.scope_path, p.id,
       false, 'ACTIVE'
  FROM identity.premises p
  JOIN identity.person pe ON pe.name = 'Occupant ' || p.id
 WHERE p.premises_type = 'QUARTER'
ON CONFLICT (public_key) DO NOTHING;

INSERT INTO identity.device
  (public_key, platform, person_id, role, scope_path, premises_id,
   requires_second_factor, status)
SELECT 'simkey2-' || p.id, 'android', pe.id, 'RESIDENT', p.scope_path, p.id,
       false, 'ACTIVE'
  FROM identity.premises p
  JOIN identity.person pe ON pe.name = 'Occupant ' || p.id
 WHERE p.premises_type = 'QUARTER'
   AND (hashtext(p.id::text) % 3) = 0
   -- respect the configured maximum; the reference seed already put two
   -- handsets on one quarter, and the limit trigger is not negotiable
   AND (SELECT count(*) FROM identity.device d2
         WHERE d2.premises_id = p.id AND d2.status = 'ACTIVE') < 2
ON CONFLICT (public_key) DO NOTHING;

-- two Overseers, one Incharge, one Staff Officer and one contractor per Area
INSERT INTO identity.person (name, mobile)
SELECT r.role || ' ' || a.name || CASE WHEN r.cnt > 1 THEN ' ' || n ELSE '' END,
       '9' || lpad((random() * 999999999)::bigint::text, 9, '0')
  FROM identity.area a
  CROSS JOIN LATERAL (
    VALUES ('CIVIL_OVERSEER', 2), ('MAINTENANCE_INCHARGE', 1),
           ('STAFF_OFFICER_CIVIL', 1), ('CONTRACTOR_SUPERVISOR', 1)
  ) AS r(role, cnt)
  CROSS JOIN LATERAL generate_series(1, r.cnt) AS n
ON CONFLICT DO NOTHING;

INSERT INTO identity.device
  (public_key, platform, person_id, role, scope_path, requires_second_factor, status)
SELECT 'simstaff-' || pe.id, 'web', pe.id,
       split_part(pe.name, ' ', 1)::principal_role,
       a.scope_path, true, 'ACTIVE'
  FROM identity.person pe
  JOIN identity.area a ON pe.name LIKE '%' || a.name || '%'
 WHERE pe.name ~ '^(CIVIL_OVERSEER|MAINTENANCE_INCHARGE|STAFF_OFFICER_CIVIL|CONTRACTOR_SUPERVISOR) '
ON CONFLICT (public_key) DO NOTHING;

ANALYZE identity.premises;
ANALYZE identity.device;

SELECT 'premises' AS what, count(*) FROM identity.premises
UNION ALL SELECT 'quarters', count(*) FROM identity.premises WHERE premises_type='QUARTER'
UNION ALL SELECT 'non-residential', count(*) FROM identity.premises WHERE premises_type<>'QUARTER'
UNION ALL SELECT 'devices', count(*) FROM identity.device;
