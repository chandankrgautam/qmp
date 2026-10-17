\set ON_ERROR_STOP off
SET search_path TO maint, public;

-- seed
INSERT INTO premises_ref VALUES
 ('11111111-1111-1111-1111-111111111111','aaaa1111-1111-1111-1111-111111111111',
  'bbbb1111-1111-1111-1111-111111111111','ncl.jayant.colony1','B-234','QUARTER','B','RESIDENT_BOUND',22);
INSERT INTO category (id,code,name_en,name_hi,display_order) VALUES
 ('cccc1111-1111-1111-1111-111111111111','WATER','Water supply','जल आपूर्ति',1);
INSERT INTO sub_category (id,category_id,code,name_en,name_hi,emergency_eligible,display_order) VALUES
 ('dddd1111-1111-1111-1111-111111111111','cccc1111-1111-1111-1111-111111111111',
  'LEAK_TAP','Leaking tap','टपकता नल',false,1);

-- ticket verified now, 48h completion SLA
INSERT INTO ticket (id,ticket_no,premises_id,area_id,scope_path,inspection_rank,
                    sub_category_id,raised_by_device,verified_at,
                    sla_completion_minutes,completion_deadline_at,state)
VALUES ('eeee1111-1111-1111-1111-111111111111','JAY-2026-000001',
        '11111111-1111-1111-1111-111111111111','aaaa1111-1111-1111-1111-111111111111',
        'ncl.jayant.colony1',22,'dddd1111-1111-1111-1111-111111111111',
        '99999999-9999-9999-9999-999999999999',
        '2026-09-11 09:00:00+00','2880','2026-09-13 09:00:00+00','IN_PROGRESS');

\echo '--- TEST 1: SLA clock pauses for occupant refusal, deadline pushed ---'
SELECT completion_deadline_at AS before_pause FROM ticket WHERE ticket_no='JAY-2026-000001';
INSERT INTO sla_pause (id,ticket_id,clock,attribution,reason,paused_at,paused_by)
VALUES ('ffff1111-1111-1111-1111-111111111111','eeee1111-1111-1111-1111-111111111111',
        'COMPLETION','OCCUPANT','Quarter locked, no access','2026-09-11 10:00:00+00',
        '99999999-9999-9999-9999-999999999999');
UPDATE sla_pause SET resumed_at='2026-09-11 16:00:00+00',
       resumed_by='99999999-9999-9999-9999-999999999999'
 WHERE id='ffff1111-1111-1111-1111-111111111111';
SELECT completion_deadline_at AS after_6h_pause FROM ticket WHERE ticket_no='JAY-2026-000001';

\echo '--- TEST 2: contractor delay may NOT pause the clock ---'
INSERT INTO sla_pause (ticket_id,clock,attribution,reason,paused_by)
VALUES ('eeee1111-1111-1111-1111-111111111111','COMPLETION','CONTRACTOR',
        'no manpower','99999999-9999-9999-9999-999999999999');

\echo '--- TEST 3: duplicate open ticket on same premises+subcategory blocked ---'
INSERT INTO ticket (ticket_no,premises_id,area_id,scope_path,inspection_rank,
                    sub_category_id,raised_by_device,state)
VALUES ('JAY-2026-000002','11111111-1111-1111-1111-111111111111',
        'aaaa1111-1111-1111-1111-111111111111','ncl.jayant.colony1',22,
        'dddd1111-1111-1111-1111-111111111111',
        '99999999-9999-9999-9999-999999999999','RAISED');

\echo '--- TEST 4: contractor cannot close (two-key rule) ---'
UPDATE ticket SET state='CLOSED' WHERE ticket_no='JAY-2026-000001';

\echo '--- TEST 5: L4 ticket cannot close without Staff Officer remark ---'
UPDATE ticket SET escalation_level=4, inspected_by_device='88888888-8888-8888-8888-888888888888'
 WHERE ticket_no='JAY-2026-000001';
INSERT INTO escalation_event (ticket_id,level) VALUES
 ('eeee1111-1111-1111-1111-111111111111',4);
UPDATE ticket SET state='CLOSED' WHERE ticket_no='JAY-2026-000001';

\echo '--- TEST 6: with remark, closure succeeds ---'
UPDATE escalation_event SET remark='Delay due to pipeline replacement, noted'
 WHERE ticket_id='eeee1111-1111-1111-1111-111111111111' AND level=4;
UPDATE ticket SET state='CLOSED', closed_at=now() WHERE ticket_no='JAY-2026-000001';
SELECT ticket_no, state FROM ticket WHERE ticket_no='JAY-2026-000001';

\echo '--- TEST 7: inspection photo without geotag rejected ---'
INSERT INTO ticket_media (ticket_id,purpose,storage_key,content_hash,captured_at,uploaded_by,purge_after)
VALUES ('eeee1111-1111-1111-1111-111111111111','INSPECTION','k1','h1',now(),
        '88888888-8888-8888-8888-888888888888',now()+interval '2 years');
\set ON_ERROR_STOP off
SET search_path TO identity, public;

INSERT INTO area (id,code,name,scope_path) VALUES
 ('aaaa1111-1111-1111-1111-111111111111','jayant','Jayant','ncl.jayant');
INSERT INTO colony (id,area_id,code,name,scope_path) VALUES
 ('bbbb1111-1111-1111-1111-111111111111','aaaa1111-1111-1111-1111-111111111111',
  'c1','Jayant Colony','ncl.jayant.colony1');
INSERT INTO premises (id,area_id,colony_id,scope_path,identifier,premises_type,quarter_type,occupancy_model)
VALUES ('11111111-1111-1111-1111-111111111111','aaaa1111-1111-1111-1111-111111111111',
        'bbbb1111-1111-1111-1111-111111111111','ncl.jayant.colony1','B-234','QUARTER','B','RESIDENT_BOUND');
INSERT INTO person (id,name,mobile) VALUES
 ('99999999-9999-9999-9999-999999999999','Test Resident','9999999999');

\echo '--- TEST 8: non-residential premises cannot be RESIDENT_BOUND ---'
INSERT INTO premises (area_id,colony_id,scope_path,identifier,premises_type,occupancy_model)
VALUES ('aaaa1111-1111-1111-1111-111111111111','bbbb1111-1111-1111-1111-111111111111',
        'ncl.jayant.colony1','Guest House 1','GUEST_HOUSE','RESIDENT_BOUND');

\echo '--- TEST 9: quarter_type mandatory for QUARTER, forbidden otherwise ---'
INSERT INTO premises (area_id,colony_id,scope_path,identifier,premises_type,quarter_type,occupancy_model)
VALUES ('aaaa1111-1111-1111-1111-111111111111','bbbb1111-1111-1111-1111-111111111111',
        'ncl.jayant.colony1','Dispensary','DISPENSARY','B','CUSTODIAN_BOUND');

\echo '--- TEST 10: Overseer device MUST require second factor ---'
INSERT INTO device (public_key,platform,role,scope_path,requires_second_factor,status)
VALUES ('key-overseer','android','CIVIL_OVERSEER','ncl.jayant',false,'ACTIVE');

\echo '--- TEST 11: device limit of 3 per premises enforced ---'
INSERT INTO device (public_key,platform,person_id,role,scope_path,premises_id,requires_second_factor,status)
SELECT 'key-res-'||g,'android','99999999-9999-9999-9999-999999999999','RESIDENT',
       'ncl.jayant.colony1','11111111-1111-1111-1111-111111111111',false,'ACTIVE'
FROM generate_series(1,3) g;
SELECT count(*) AS active_devices FROM device WHERE premises_id='11111111-1111-1111-1111-111111111111';
INSERT INTO device (public_key,platform,person_id,role,scope_path,premises_id,requires_second_factor,status)
VALUES ('key-res-4','android','99999999-9999-9999-9999-999999999999','RESIDENT',
        'ncl.jayant.colony1','11111111-1111-1111-1111-111111111111',false,'ACTIVE');

\echo '--- TEST 12: revocation without reason blocked ---'
UPDATE device SET status='REVOKED' WHERE public_key='key-res-1';

\echo '--- TEST 13: audit hash chain links and detects tampering ---'
INSERT INTO audit_log (event_type,entity_type,entity_id,after_value)
VALUES ('DEVICE_APPROVED','device','11111111-1111-1111-1111-111111111111','{"status":"ACTIVE"}'),
       ('TICKET_CLOSED','ticket','11111111-1111-1111-1111-111111111111','{"state":"CLOSED"}');
SELECT id, event_type, left(prev_hash,12) AS prev, left(row_hash,12) AS hash FROM audit_log ORDER BY id;

\echo '--- TEST 14: ltree subtree scoping ---'
SELECT identifier FROM premises WHERE scope_path <@ 'ncl.jayant';
SELECT count(*) AS outside_scope FROM premises WHERE scope_path <@ 'ncl.nigahi';
\set ON_ERROR_STOP off
SET search_path TO maint, public;
INSERT INTO premises_ref VALUES
 ('11111111-1111-1111-1111-111111111111','aaaa1111-1111-1111-1111-111111111111',
  'bbbb1111-1111-1111-1111-111111111111','ncl.jayant.colony1','B-234','QUARTER','B','RESIDENT_BOUND',22);
INSERT INTO category (id,code,name_en,name_hi,display_order) VALUES
 ('cccc1111-1111-1111-1111-111111111111','WATER','Water supply','जल आपूर्ति',1);
INSERT INTO sub_category (id,category_id,code,name_en,name_hi,display_order) VALUES
 ('dddd1111-1111-1111-1111-111111111111','cccc1111-1111-1111-1111-111111111111','LEAK','Leaking tap','टपकता नल',1);
INSERT INTO ticket (id,ticket_no,premises_id,area_id,scope_path,inspection_rank,sub_category_id,
                    raised_by_device,verified_at,completion_deadline_at,original_completion_deadline_at,state)
VALUES ('eeee1111-1111-1111-1111-111111111111','JAY/2026/00001',
 '11111111-1111-1111-1111-111111111111','aaaa1111-1111-1111-1111-111111111111','ncl.jayant.colony1',22,
 'dddd1111-1111-1111-1111-111111111111','99999999-9999-9999-9999-999999999999',
 '2026-09-11 09:00:00+00','2026-09-13 09:00:00+00','2026-09-13 09:00:00+00','IN_PROGRESS');

\echo '--- TEST 15: contractor CANNOT pause the SLA clock ---'
INSERT INTO sla_pause (ticket_id,clock,attribution,reason,paused_by,paused_by_role)
VALUES ('eeee1111-1111-1111-1111-111111111111','COMPLETION','OCCUPANT','locked',
        '77777777-7777-7777-7777-777777777777','CONTRACTOR_SUPERVISOR');

\echo '--- TEST 16: Overseer CAN pause; original deadline preserved ---'
INSERT INTO sla_pause (id,ticket_id,clock,attribution,reason,paused_at,paused_by,paused_by_role)
VALUES ('ffff1111-1111-1111-1111-111111111111','eeee1111-1111-1111-1111-111111111111','COMPLETION',
        'OCCUPANT','Quarter locked','2026-09-11 10:00:00+00',
        '88888888-8888-8888-8888-888888888888','CIVIL_OVERSEER');
UPDATE sla_pause SET resumed_at='2026-09-11 16:00:00+00' WHERE id='ffff1111-1111-1111-1111-111111111111';
SELECT original_completion_deadline_at AS promised, completion_deadline_at AS effective,
       total_paused_minutes FROM ticket WHERE ticket_no='JAY/2026/00001';

\echo '--- TEST 17: workmen names recorded by contractor ---'
UPDATE ticket SET workmen_assigned='Ram Prasad (mason), Sunil Kumar (helper)'
 WHERE ticket_no='JAY/2026/00001';
SELECT workmen_assigned FROM ticket WHERE ticket_no='JAY/2026/00001';

\echo '--- TEST 18: gapless per-area-per-year ticket numbering ---'
INSERT INTO ticket_sequence (area_code,year,last_value) VALUES ('JAY',2026,0);
UPDATE ticket_sequence SET last_value=last_value+1 WHERE area_code='JAY' AND year=2026
 RETURNING 'JAY/2026/'||lpad(last_value::text,5,'0') AS next_ticket_no;
SET search_path TO maint, public;
INSERT INTO premises_ref VALUES
 ('11111111-1111-1111-1111-111111111111','aaaa1111-1111-1111-1111-111111111111',
  'bbbb1111-1111-1111-1111-111111111111','ncl.jayant.colony1','B-234','QUARTER','B','RESIDENT_BOUND',22),
 ('22222222-2222-2222-2222-222222222222','aaaa2222-2222-2222-2222-222222222222',
  'bbbb2222-2222-2222-2222-222222222222','ncl.nigahi.colony1','C-99','QUARTER','C','RESIDENT_BOUND',21);
INSERT INTO category (id,code,name_en,name_hi,display_order) VALUES
 ('cccc1111-1111-1111-1111-111111111111','WATER','Water','जल',1);
INSERT INTO sub_category (id,category_id,code,name_en,name_hi,display_order) VALUES
 ('dddd1111-1111-1111-1111-111111111111','cccc1111-1111-1111-1111-111111111111','LEAK','Leak','रिसाव',1);
-- ticket in Jayant raised by device R1; second ticket in Nigahi
INSERT INTO ticket (id,ticket_no,premises_id,area_id,scope_path,inspection_rank,sub_category_id,raised_by_device,state)
VALUES ('eeee1111-1111-1111-1111-111111111111','JAY/2026/00001',
 '11111111-1111-1111-1111-111111111111','aaaa1111-1111-1111-1111-111111111111','ncl.jayant.colony1',22,
 'dddd1111-1111-1111-1111-111111111111','11111111-aaaa-1111-1111-111111111111','RAISED'),
('eeee2222-2222-2222-2222-222222222222','NIG/2026/00001',
 '22222222-2222-2222-2222-222222222222','aaaa2222-2222-2222-2222-222222222222','ncl.nigahi.colony1',21,
 'dddd1111-1111-1111-1111-111111111111','22222222-aaaa-2222-2222-222222222222','RAISED');
\set ON_ERROR_STOP on
SET search_path TO maint, public;
INSERT INTO contract (id,area_id,scope_path,contractor_name,agreement_no,awarded_on,period_years,starts_on,expires_on)
VALUES ('c0c01111-1111-1111-1111-111111111111','aaaa1111-1111-1111-1111-111111111111','ncl.jayant',
        'M/s Verma Constructions','NCL/JAY/CIV/2026/07','2026-01-15',2,'2026-02-01','2028-01-31') ON CONFLICT DO NOTHING;
INSERT INTO ticket_sequence VALUES ('JAY',2026,0) ON CONFLICT DO NOTHING;

-- allocate number
UPDATE ticket_sequence SET last_value=last_value+1 WHERE area_code='JAY' AND year=2026;

-- RAISED
INSERT INTO ticket (id,ticket_no,premises_id,area_id,scope_path,inspection_rank,sub_category_id,
                    description,raised_by_device,contract_id,state)
VALUES ('a0a01111-1111-1111-1111-111111111111',
        'JAY/2026/'||lpad((SELECT last_value FROM ticket_sequence WHERE area_code='JAY')::text,5,'0'),
        '11111111-1111-1111-1111-111111111111','aaaa1111-1111-1111-1111-111111111111',
        'ncl.jayant.colony1',22,'dddd1111-1111-1111-1111-111111111111',
        'Bathroom tap leaking since two days','11111111-aaaa-1111-1111-111111111111',
        'c0c01111-1111-1111-1111-111111111111','RAISED');

-- VERIFIED: snapshot SLA, set both deadline pairs
UPDATE ticket SET state='VERIFIED', verified_at=now(),
   verified_by_device='88888888-8888-8888-8888-888888888888',
   sla_response_minutes=1440, sla_completion_minutes=2880,
   response_deadline_at=now()+interval '1440 min',
   completion_deadline_at=now()+interval '2880 min',
   original_response_deadline_at=now()+interval '1440 min',
   original_completion_deadline_at=now()+interval '2880 min'
 WHERE id='a0a01111-1111-1111-1111-111111111111';

UPDATE ticket SET state='ASSIGNED', assigned_at=now(),
   assigned_to_device='77777777-7777-7777-7777-777777777777'
 WHERE id='a0a01111-1111-1111-1111-111111111111';
UPDATE ticket SET state='IN_PROGRESS', started_at=now(),
   workmen_assigned='Ram Prasad (plumber), Sunil Kumar (helper)'
 WHERE id='a0a01111-1111-1111-1111-111111111111';

-- objection during work
INSERT INTO ticket_objection (ticket_id,raised_by_device,note,response_deadline_at)
VALUES ('a0a01111-1111-1111-1111-111111111111','11111111-bbbb-1111-1111-111111111111',
        'Old washer refitted instead of replaced', now()+interval '24 hours');
UPDATE ticket SET objection_count=objection_count+1 WHERE id='a0a01111-1111-1111-1111-111111111111';

UPDATE ticket SET state='WORK_COMPLETED', completed_claim_at=now()
 WHERE id='a0a01111-1111-1111-1111-111111111111';
INSERT INTO ticket_media (ticket_id,purpose,storage_key,content_hash,captured_at,uploaded_by,purge_after)
VALUES ('a0a01111-1111-1111-1111-111111111111','COMPLETION','k/c1','h1',now(),
        '77777777-7777-7777-7777-777777777777',now()+interval '2 years');

-- inspection with geotag
INSERT INTO ticket_media (ticket_id,purpose,storage_key,content_hash,captured_at,
                          latitude,longitude,gps_accuracy_m,capture_verified,uploaded_by,purge_after)
VALUES ('a0a01111-1111-1111-1111-111111111111','INSPECTION','k/i1','h2',now(),
        24.1234,82.6543,6.5,true,'88888888-8888-8888-8888-888888888888',now()+interval '2 years');
UPDATE ticket SET state='INSPECTED_ACCEPTED', inspected_at=now(),
   inspected_by_device='88888888-8888-8888-8888-888888888888',
   completion_met=true, response_met=true
 WHERE id='a0a01111-1111-1111-1111-111111111111';
UPDATE ticket SET state='CLOSED', closed_at=now() WHERE id='a0a01111-1111-1111-1111-111111111111';

INSERT INTO ticket_feedback (ticket_id,confirmed,rating,comment,device_id,reopen_window_ends_at)
VALUES ('a0a01111-1111-1111-1111-111111111111',true,4,'Done properly after objection',
        '11111111-aaaa-1111-1111-111111111111', now()+interval '1 day');

\echo '--- TEST 27: full lifecycle completed end to end ---'
SELECT ticket_no, state, objection_count, left(workmen_assigned,28) AS workmen FROM ticket
 WHERE id='a0a01111-1111-1111-1111-111111111111';
\echo '--- TEST 28: contract_performance view computes ---'
SELECT contractor_name, tickets_received, tickets_closed, sla_compliance_pct,
       objection_rate_pct, avg_rating FROM contract_performance;
\echo '--- TEST 29: escalation rules seeded for both emergency and normal ---'
SELECT level, is_emergency, minutes_after_breach, notify_role FROM escalation_rule ORDER BY is_emergency DESC, level;
SET search_path TO maint, public;
INSERT INTO premises_ref VALUES
 ('11111111-1111-1111-1111-111111111111','aaaa1111-1111-1111-1111-111111111111',
  'bbbb1111-1111-1111-1111-111111111111','ncl.jayant.colony1','B-234','QUARTER','B','RESIDENT_BOUND',22),
 ('22222222-2222-2222-2222-222222222222','aaaa2222-2222-2222-2222-222222222222',
  'bbbb2222-2222-2222-2222-222222222222','ncl.nigahi.colony1','C-99','QUARTER','C','RESIDENT_BOUND',21);
INSERT INTO category (id,code,name_en,name_hi,display_order) VALUES
 ('cccc1111-1111-1111-1111-111111111111','WATER','Water','जल',1);
INSERT INTO sub_category (id,category_id,code,name_en,name_hi,display_order) VALUES
 ('dddd1111-1111-1111-1111-111111111111','cccc1111-1111-1111-1111-111111111111','LEAK','Leak','रिसाव',1);
INSERT INTO ticket (id,ticket_no,premises_id,area_id,scope_path,inspection_rank,sub_category_id,
                    raised_by_device,assigned_to_device,state)
VALUES ('eeee1111-1111-1111-1111-111111111111','JAY/2026/00001',
 '11111111-1111-1111-1111-111111111111','aaaa1111-1111-1111-1111-111111111111','ncl.jayant.colony1',22,
 'dddd1111-1111-1111-1111-111111111111','11111111-aaaa-1111-1111-111111111111',
 '77777777-7777-7777-7777-777777777777','RAISED');
SET search_path TO maint,public;
\echo '--- 36: OVERSEER verifies ---'
SET app.role='CIVIL_OVERSEER'; SET app.scope_path='ncl.jayant';
UPDATE ticket SET state='VERIFIED', verified_by_device='88888888-8888-8888-8888-888888888888'
 WHERE ticket_no='JAY/2026/00001';
\echo '--- 37: INCHARGE assigns ---'
SET app.role='MAINTENANCE_INCHARGE';
UPDATE ticket SET state='ASSIGNED' WHERE ticket_no='JAY/2026/00001';
\echo '--- 38: CONTRACTOR starts and claims completion ---'
SET app.role='CONTRACTOR_SUPERVISOR'; SET app.device_id='77777777-7777-7777-7777-777777777777';
UPDATE ticket SET state='IN_PROGRESS', workmen_assigned='Ram Prasad, Sunil Kumar'
 WHERE ticket_no='JAY/2026/00001';
UPDATE ticket SET state='WORK_COMPLETED' WHERE ticket_no='JAY/2026/00001';
\echo '--- 39: contractor tries to close own work (must fail) ---'
UPDATE ticket SET state='INSPECTED_ACCEPTED',
  inspected_by_device='77777777-7777-7777-7777-777777777777' WHERE ticket_no='JAY/2026/00001';
\echo '--- 40: OVERSEER naming contractor device as inspector (must fail) ---'
SET app.role='CIVIL_OVERSEER'; SET app.scope_path='ncl.jayant';
UPDATE ticket SET state='INSPECTED_ACCEPTED',
  inspected_by_device='77777777-7777-7777-7777-777777777777' WHERE ticket_no='JAY/2026/00001';
\echo '--- 41: OVERSEER inspects with own device, closes ---'
UPDATE ticket SET state='INSPECTED_ACCEPTED',
  inspected_by_device='88888888-8888-8888-8888-888888888888' WHERE ticket_no='JAY/2026/00001';
UPDATE ticket SET state='CLOSED', closed_at=now() WHERE ticket_no='JAY/2026/00001';
SELECT ticket_no,state,left(workmen_assigned,22) workmen FROM ticket WHERE ticket_no='JAY/2026/00001';
\echo '--- 42: RESIDENT reopens within window ---'
SET app.role='RESIDENT'; SET app.device_id='11111111-aaaa-1111-1111-111111111111';
SET app.premises_id='11111111-1111-1111-1111-111111111111';
UPDATE ticket SET state='REOPENED', reopened_count=reopened_count+1 WHERE ticket_no='JAY/2026/00001';
SELECT ticket_no,state,reopened_count FROM ticket WHERE ticket_no='JAY/2026/00001';
SET search_path TO identity,public;
SET app.role='SYSTEM';
INSERT INTO area (id,code,name,scope_path) VALUES
 ('aaaa1111-1111-1111-1111-111111111111','jayant','Jayant','ncl.jayant'),
 ('aaaa2222-2222-2222-2222-222222222222','nigahi','Nigahi','ncl.nigahi');
INSERT INTO colony (id,area_id,code,name,scope_path) VALUES
 ('bbbb1111-1111-1111-1111-111111111111','aaaa1111-1111-1111-1111-111111111111','c1','JC','ncl.jayant.colony1'),
 ('bbbb2222-2222-2222-2222-222222222222','aaaa2222-2222-2222-2222-222222222222','c1','NC','ncl.nigahi.colony1');
INSERT INTO premises (area_id,colony_id,scope_path,identifier,premises_type,quarter_type,occupancy_model) VALUES
 ('aaaa1111-1111-1111-1111-111111111111','bbbb1111-1111-1111-1111-111111111111','ncl.jayant.colony1','B-234','QUARTER','B','RESIDENT_BOUND'),
 ('aaaa2222-2222-2222-2222-222222222222','bbbb2222-2222-2222-2222-222222222222','ncl.nigahi.colony1','C-99','QUARTER','C','RESIDENT_BOUND');
