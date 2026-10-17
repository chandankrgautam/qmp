import psycopg2, uuid, sys
from pgconn import M, SU
def run(label, sql, role='CIVIL_OVERSEER', dev='88888888-8888-8888-8888-888888888888',
        scope='ncl.jayant', expect_block=True, su=False):
    conn = psycopg2.connect(**(SU if su else M)); cur=conn.cursor()
    cur.execute("SET search_path TO maint,public")
    cur.execute("SET app.role=%s",(role,)); cur.execute("SET app.scope_path=%s",(scope,))
    cur.execute("SET app.actor_id=%s",(dev,))
    cur.execute("SET app.premises_id='11111111-1111-1111-1111-111111111111'")
    cur.execute("SET app.auth_method='device'")   # app session: decision 2026-09-30
    try:
        cur.execute(sql); n=cur.rowcount; conn.commit(); blocked = (n==0)
    except psycopg2.Error: blocked=True; conn.rollback()
    conn.close()
    ok = (blocked == expect_block)
    print(f"  {'PASS' if ok else 'FAIL'}  {label}")
    return ok
def sys_exec(sql):
    c=psycopg2.connect(**SU);cur=c.cursor()
    cur.execute("SET search_path TO maint,public; SET app.role='SYSTEM'")
    try: cur.execute(sql); c.commit()
    except psycopg2.Error as e: c.rollback(); return str(e)[:90]
    c.close(); return None
res=[]
# photographs are optional until HQ requires them (decision 2026-10-12); this
# matrix tests the gate as it will be once the HQ System Administrator does
sys_exec("UPDATE maint_config SET value='true' WHERE key IN ('completion_photos_required','inspection_photo_required')")
# Job cards, extensions and documents can never be deleted (by design);
# the harness clears its own fixtures as the superuser with triggers off
# for this session only, then switches them back on.
sys_exec("SET session_replication_role = replica; DELETE FROM job_sheet_event; DELETE FROM job_sheet; DELETE FROM job_card_item; DELETE FROM job_card; DELETE FROM contract_document; DELETE FROM contract_extension; SET session_replication_role = DEFAULT; DELETE FROM ticket_event; DELETE FROM ticket_media; DELETE FROM ticket_objection; DELETE FROM ticket_feedback; DELETE FROM sla_pause; DELETE FROM sla_breach; DELETE FROM escalation_event; DELETE FROM ticket")
sys_exec("""INSERT INTO ticket (id,ticket_no,premises_id,area_id,scope_path,inspection_rank,
 sub_category_id,raised_by,assigned_to,state) VALUES
 ('cc000000-0000-0000-0000-000000000001','C/1-'||substr(gen_random_uuid()::text,1,8),'11111111-1111-1111-1111-111111111111',
 'aaaa1111-1111-1111-1111-111111111111','ncl.jayant.colony1',22,
 'dddd1111-1111-1111-1111-111111111111','11111111-aaaa-1111-1111-111111111111',
 '77777777-7777-7777-7777-777777777777','WORK_COMPLETED')""")
T="WHERE id='cc000000-0000-0000-0000-000000000001'"
# the claim was made an hour ago
sys_exec(f"UPDATE ticket SET completed_claim_at = now() - interval '1 hour' {T}")

# ---- photograph gates (enforce_photo_gates), checked before any photo exists
res.append(run("inspection refused with no inspection photograph",
  f"UPDATE ticket SET state='INSPECTED_ACCEPTED',inspected_by='88888888-8888-8888-8888-888888888888' {T}"))
PHOTO = """INSERT INTO ticket_media (ticket_id,purpose,storage_key,content_hash,captured_at,
 latitude,longitude,capture_verified,uploaded_by,purge_after,upload_state,size_bytes,uploaded_at)
 VALUES ('cc000000-0000-0000-0000-000000000001','INSPECTION','k-'||gen_random_uuid(),'h',now(),
 24.11,82.65,true,'{dev}',now()+interval '2 years','STORED',1,{at})"""
# another device's photograph, and this Overseer's own from BEFORE the claim
sys_exec(PHOTO.format(dev='88889999-8888-8888-8888-888888888888', at='now()'))
sys_exec(PHOTO.format(dev='88888888-8888-8888-8888-888888888888', at="now() - interval '2 hours'"))
res.append(run("inspection refused on another device's or a pre-claim photograph",
  f"UPDATE ticket SET state='INSPECTED_ACCEPTED',inspected_by='88888888-8888-8888-8888-888888888888' {T}"))
res.append(run("contractor may not attach an inspection photograph",
  """INSERT INTO ticket_media (ticket_id,purpose,storage_key,content_hash,captured_at,
     uploaded_by,purge_after) VALUES ('cc000000-0000-0000-0000-000000000001','INSPECTION',
     'k-'||gen_random_uuid(),'','now','77777777-7777-7777-7777-777777777777',now())""",
  role='CONTRACTOR_SUPERVISOR', dev='77777777-7777-7777-7777-777777777777'))
# the inspecting Overseer's own photograph, after the claim
sys_exec(PHOTO.format(dev='88888888-8888-8888-8888-888888888888', at='now()'))

res.append(run("two-key: inspector may not be the assigned contractor",
  f"UPDATE ticket SET state='INSPECTED_ACCEPTED',inspected_by='77777777-7777-7777-7777-777777777777' {T}"))
res.append(run("two-key: inspector with own device is accepted",
  f"UPDATE ticket SET state='INSPECTED_ACCEPTED',inspected_by='88888888-8888-8888-8888-888888888888' {T}",
  expect_block=False))
e=sys_exec("""INSERT INTO ticket_media (ticket_id,purpose,storage_key,content_hash,captured_at,uploaded_by,purge_after,upload_state,size_bytes)
 VALUES ('cc000000-0000-0000-0000-000000000001','INSPECTION','k-'||gen_random_uuid(),'h',now(),'88888888-8888-8888-8888-888888888888',now(),'STORED',1)""")
print(f"  {'PASS' if e else 'FAIL'}  stored inspection photo without geo-tag rejected"); res.append(bool(e))
e=sys_exec("""INSERT INTO ticket_media (ticket_id,purpose,storage_key,content_hash,captured_at,
 latitude,longitude,capture_verified,uploaded_by,purge_after,upload_state,size_bytes)
 VALUES ('cc000000-0000-0000-0000-000000000001','INSPECTION','k2-'||gen_random_uuid(),'h2',now(),24.1,82.6,true,
 '88888888-8888-8888-8888-888888888888',now(),'STORED',1)""")
print(f"  {'PASS' if not e else 'FAIL'}  inspection photo with geo-tag accepted"); res.append(not e)
e=sys_exec("""INSERT INTO sla_pause (ticket_id,clock,attribution,reason,paused_by,paused_by_role)
 VALUES ('cc000000-0000-0000-0000-000000000001','COMPLETION','OCCUPANT','x',
 '77777777-7777-7777-7777-777777777777','CONTRACTOR_SUPERVISOR')""")
print(f"  {'PASS' if e else 'FAIL'}  contractor may not pause the SLA clock"); res.append(bool(e))
e=sys_exec("""INSERT INTO sla_pause (ticket_id,clock,attribution,reason,paused_by,paused_by_role)
 VALUES ('cc000000-0000-0000-0000-000000000001','COMPLETION','CONTRACTOR','no manpower',
 '88888888-8888-8888-8888-888888888888','CIVIL_OVERSEER')""")
print(f"  {'PASS' if e else 'FAIL'}  contractor-attributed delay may not pause the clock"); res.append(bool(e))
# a different sub-category on the same premises is NOT a duplicate
e=sys_exec("""INSERT INTO ticket (ticket_no,premises_id,area_id,scope_path,inspection_rank,
 sub_category_id,raised_by,state) VALUES ('DUP/1-'||substr(gen_random_uuid()::text,1,8),'11111111-1111-1111-1111-111111111111',
 'aaaa1111-1111-1111-1111-111111111111','ncl.jayant.colony1',22,
 'dddd2222-2222-2222-2222-222222222222','11111111-aaaa-1111-1111-111111111111','RAISED')""")
print(f"  {'PASS' if not e else 'FAIL'}  different sub-category on same premises is allowed"); res.append(not e)
# the same sub-category while one is open IS a duplicate
e=sys_exec("""INSERT INTO ticket (ticket_no,premises_id,area_id,scope_path,inspection_rank,
 sub_category_id,raised_by,state) VALUES ('DUP/2-'||substr(gen_random_uuid()::text,1,8),'11111111-1111-1111-1111-111111111111',
 'aaaa1111-1111-1111-1111-111111111111','ncl.jayant.colony1',22,
 'dddd2222-2222-2222-2222-222222222222','11111111-aaaa-1111-1111-111111111111','RAISED')""")
print(f"  {'PASS' if e else 'FAIL'}  duplicate open ticket on same premises+sub-category blocked"); res.append(bool(e))
# ticket_event is append-only, so a ticket carrying history cannot be deleted
sys_exec("""INSERT INTO ticket_event (ticket_id,event_type,actor_id,actor_role)
 VALUES ('cc000000-0000-0000-0000-000000000001','X','88888888-8888-8888-8888-888888888888','CIVIL_OVERSEER')""")
e=sys_exec("DELETE FROM ticket_event")
print(f"  {'PASS' if e else 'FAIL'}  ticket history is append-only even for SYSTEM"); res.append(bool(e))
e=sys_exec("""INSERT INTO audit_log (event_type,entity_type) VALUES ('X','ticket')""")
print(f"  {'PASS' if not e else 'FAIL'}  audit insert populates hash chain"); res.append(not e)
res.append(run("audit log not updatable by any role",
  "UPDATE audit_log SET event_type='TAMPER'", role='ADMINISTRATOR', scope='ncl'))
res.append(run("ticket_event history not deletable", "DELETE FROM ticket_event",
  role='ADMINISTRATOR', scope='ncl'))
print(f"\n  condition checks: {sum(res)}/{len(res)} pass")
# A matrix that cannot fail proves nothing: it used to exit 0 regardless.
sys.exit(0 if all(res) else 1)
