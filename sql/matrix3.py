import psycopg2, sys
from pgconn import M, I, SU, SUI
ROLES=['RESIDENT','CUSTODIAN','CONTRACTOR_SUPERVISOR','CIVIL_OVERSEER',
       'MAINTENANCE_INCHARGE','STAFF_OFFICER_CIVIL','GM_CIVIL','ADMINISTRATOR']
DEV={'RESIDENT':'11111111-aaaa-1111-1111-111111111111','CUSTODIAN':'11111111-cccc-1111-1111-111111111111',
 'CONTRACTOR_SUPERVISOR':'77777777-7777-7777-7777-777777777777','CIVIL_OVERSEER':'88888888-8888-8888-8888-888888888888',
 'MAINTENANCE_INCHARGE':'88880000-8888-8888-8888-888888888888','STAFF_OFFICER_CIVIL':'88881111-8888-8888-8888-888888888888',
 'GM_CIVIL':'55555555-5555-5555-5555-555555555555','ADMINISTRATOR':'44444444-4444-4444-4444-444444444444'}
SC={r:'ncl.jayant' for r in ROLES}; SC['RESIDENT']=SC['CUSTODIAN']='ncl.jayant.colony1'
SC['GM_CIVIL']=SC['ADMINISTRATOR']='ncl'
PJ='11111111-1111-1111-1111-111111111111'

# seed one Jayant + one Nigahi row in every scoped table
c=psycopg2.connect(**SU);cur=c.cursor()
cur.execute("SET search_path TO maint,public; SET app.role='SYSTEM'")
# Job cards, extensions and documents can never be deleted (by design);
# the harness clears its own fixtures as the superuser with triggers off
# for this session only, then switches them back on.
cur.execute("SET session_replication_role = replica; DELETE FROM job_sheet_event; DELETE FROM job_sheet; DELETE FROM job_card_item; DELETE FROM job_card; DELETE FROM contract_document; DELETE FROM contract_extension; SET session_replication_role = DEFAULT; DELETE FROM ticket_event;DELETE FROM ticket_media;DELETE FROM ticket_objection;DELETE FROM notification;DELETE FROM contract;DELETE FROM ticket")
for tid,prem,area,scope,tno in [('aa000000-0000-0000-0000-000000000001',PJ,'aaaa1111-1111-1111-1111-111111111111','ncl.jayant.colony1','J/1'),
   ('bb000000-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','aaaa2222-2222-2222-2222-222222222222','ncl.nigahi.colony1','N/1')]:
    cur.execute("""INSERT INTO ticket (id,ticket_no,premises_id,area_id,scope_path,inspection_rank,
      sub_category_id,raised_by,assigned_to,state) VALUES (%s,%s,%s,%s,%s,22,
      'dddd1111-1111-1111-1111-111111111111','11111111-aaaa-1111-1111-111111111111',
      '77777777-7777-7777-7777-777777777777','IN_PROGRESS')""",(tid,tno,prem,area,scope))
    cur.execute("""INSERT INTO ticket_media (ticket_id,purpose,storage_key,content_hash,captured_at,uploaded_by,purge_after)
      VALUES (%s,'COMPLAINT','k/'||%s,'h',now(),'11111111-aaaa-1111-1111-111111111111',now()+interval '2 years')""",(tid,tid))
    cur.execute("""INSERT INTO ticket_objection (ticket_id,raised_by,note,response_deadline_at)
      VALUES (%s,'11111111-aaaa-1111-1111-111111111111','note',now())""",(tid,))
    cur.execute("""INSERT INTO ticket_event (ticket_id,event_type,actor_id,actor_role)
      VALUES (%s,'X','11111111-aaaa-1111-1111-111111111111','RESIDENT')""",(tid,))
cur.execute("""INSERT INTO contract (id,area_id,scope_path,contractor_name,agreement_no,awarded_on,period_years,starts_on,expires_on) VALUES
 ('c0000000-0000-0000-0000-000000000001','aaaa1111-1111-1111-1111-111111111111','ncl.jayant','Jayant Ctr','A/1','2026-01-01',2,'2026-02-01','2028-01-31'),
 ('c0000000-0000-0000-0000-000000000002','aaaa2222-2222-2222-2222-222222222222','ncl.nigahi','Nigahi Ctr','A/2','2026-01-01',2,'2026-02-01','2028-01-31')""")
cur.execute("""INSERT INTO notification (actor_id,event_type,title_en,title_hi,body_en,body_hi) VALUES
 ('11111111-aaaa-1111-1111-111111111111','X','for resident','x','b','x'),
 ('99990000-9999-9999-9999-999999999999','X','for nigahi overseer','x','b','x')""")
c.commit();c.close()

TABLES=['ticket','ticket_media','ticket_objection','ticket_event','premises_ref','actor_ref','contract','notification']
# FRS-derived expected visible counts out of the seeded set
EXP={
 'ticket':            {'RESIDENT':1,'CUSTODIAN':1,'CONTRACTOR_SUPERVISOR':2,'CIVIL_OVERSEER':1,'MAINTENANCE_INCHARGE':1,'STAFF_OFFICER_CIVIL':1,'GM_CIVIL':2,'ADMINISTRATOR':2},
 'ticket_media':      {'RESIDENT':1,'CUSTODIAN':1,'CONTRACTOR_SUPERVISOR':2,'CIVIL_OVERSEER':1,'MAINTENANCE_INCHARGE':1,'STAFF_OFFICER_CIVIL':1,'GM_CIVIL':2,'ADMINISTRATOR':2},
 # FRS 5.5: objections go to the Overseer and Incharge, never the contractor
 'ticket_objection':  {'RESIDENT':1,'CUSTODIAN':1,'CONTRACTOR_SUPERVISOR':0,'CIVIL_OVERSEER':1,'MAINTENANCE_INCHARGE':1,'STAFF_OFFICER_CIVIL':1,'GM_CIVIL':2,'ADMINISTRATOR':2},
 'ticket_event':      {'RESIDENT':1,'CUSTODIAN':1,'CONTRACTOR_SUPERVISOR':2,'CIVIL_OVERSEER':1,'MAINTENANCE_INCHARGE':1,'STAFF_OFFICER_CIVIL':1,'GM_CIVIL':2,'ADMINISTRATOR':2},
 'premises_ref':      {'RESIDENT':1,'CUSTODIAN':1,'CONTRACTOR_SUPERVISOR':1,'CIVIL_OVERSEER':1,'MAINTENANCE_INCHARGE':1,'STAFF_OFFICER_CIVIL':1,'GM_CIVIL':2,'ADMINISTRATOR':2},
 'contract':          {'RESIDENT':0,'CUSTODIAN':0,'CONTRACTOR_SUPERVISOR':1,'CIVIL_OVERSEER':1,'MAINTENANCE_INCHARGE':1,'STAFF_OFFICER_CIVIL':1,'GM_CIVIL':2,'ADMINISTRATOR':2},
 'notification':      {'RESIDENT':1,'CUSTODIAN':0,'CONTRACTOR_SUPERVISOR':0,'CIVIL_OVERSEER':0,'MAINTENANCE_INCHARGE':0,'STAFF_OFFICER_CIVIL':0,'GM_CIVIL':0,'ADMINISTRATOR':2},
}
print("="*78);print("PART 3 — ROLE x TABLE READ VISIBILITY  (seeded: 1 Jayant + 1 Nigahi)");print("="*78)
fails=0
for t in TABLES:
    if t not in EXP: continue
    row=[]
    for role in ROLES:
        c=psycopg2.connect(**M);cur=c.cursor()
        cur.execute("SET search_path TO maint,public")
        cur.execute("SET app.role=%s",(role,));cur.execute("SET app.scope_path=%s",(SC[role],))
        cur.execute("SET app.actor_id=%s",(DEV[role],))
        cur.execute("SET app.premises_id=%s",(PJ,))
        # a contractor reads only their own contract (the Jayant one here)
        cur.execute("SET app.contract_id=%s",('c0000000-0000-0000-0000-000000000001' if role=='CONTRACTOR_SUPERVISOR' else '',))
        cur.execute(f"SELECT count(*) FROM {t}"); got=cur.fetchone()[0]; c.close()
        want=EXP[t][role]
        ok=(got==want)
        if not ok: fails+=1
        row.append(f"{got}" if ok else f"{got}!")
    print(f"  {t:<20} {'  '.join(row)}")
print("\n  columns:"," ".join(r[:3] for r in ROLES))
print(f"  read-visibility mismatches: {fails}   (! marks a value that differs from the FRS expectation)")
# A matrix that cannot fail proves nothing: it used to exit 0 regardless.
sys.exit(1 if fails else 0)
