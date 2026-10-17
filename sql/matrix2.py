import psycopg2, sys
from pgconn import M, SU
TID='aaaa0000-0000-0000-0000-000000000001'
ROLES=['RESIDENT','CUSTODIAN','CONTRACTOR_SUPERVISOR','CIVIL_OVERSEER',
       'MAINTENANCE_INCHARGE','STAFF_OFFICER_CIVIL','GM_CIVIL','ADMINISTRATOR']
DEV={'RESIDENT':'11111111-aaaa-1111-1111-111111111111','CUSTODIAN':'11111111-cccc-1111-1111-111111111111',
 'CONTRACTOR_SUPERVISOR':'77777777-7777-7777-7777-777777777777','CIVIL_OVERSEER':'88888888-8888-8888-8888-888888888888',
 'MAINTENANCE_INCHARGE':'88880000-8888-8888-8888-888888888888','STAFF_OFFICER_CIVIL':'88881111-8888-8888-8888-888888888888',
 'GM_CIVIL':'55555555-5555-5555-5555-555555555555','ADMINISTRATOR':'44444444-4444-4444-4444-444444444444'}
SC={r:'ncl.jayant' for r in ROLES}; SC['RESIDENT']=SC['CUSTODIAN']='ncl.jayant.colony1'
SC['GM_CIVIL']=SC['ADMINISTRATOR']='ncl'
# FRS-derived: who may change each field
# verified_by, inspected_by and workmen_assigned record a step and are
# written only together with it (break-it pass, 2026-10-08): a bare write,
# as here with the state unchanged, is refused for every role. Their
# authors are tested with the step itself by the transition matrix.
EXPECT={
 'verified_by':set(), 'assigned_to':{'MAINTENANCE_INCHARGE','CIVIL_OVERSEER'},
 'inspected_by':set(), 'workmen_assigned':set(),
 'is_emergency':{'CIVIL_OVERSEER'}, 'completion_deadline_at':set(),
 'sla_completion_minutes':set(), 'escalation_level':set(), 'objection_count':set(),
 'reopened_count':set(), 'rework_count':set(), 'ticket_no':set(), 'premises_id':set(),
 'description':set(), 'raised_by':set(), 'sub_category_id':set(),
 'original_completion_deadline_at':set(), 'response_met':set(),
}
VALS={'verified_by':"'99990000-9999-9999-9999-999999999999'",
 'assigned_to':"'66666666-6666-6666-6666-666666666666'",
 'inspected_by':"'99990000-9999-9999-9999-999999999999'",
 'workmen_assigned':"'Ram, Shyam'", 'is_emergency':'false',
 'completion_deadline_at':"now()+interval '99 days'", 'sla_completion_minutes':'99999',
 'escalation_level':'0','objection_count':'0','reopened_count':'0','rework_count':'0',
 'ticket_no':"'HACKED/1'",'premises_id':"'22222222-2222-2222-2222-222222222222'",
 'description':"'rewritten'",'raised_by':"'66666666-6666-6666-6666-666666666666'",
 'sub_category_id':"'dddd2222-2222-2222-2222-222222222222'",
 'original_completion_deadline_at':"now()+interval '99 days'",'response_met':'true'}

def reset():
    c=psycopg2.connect(**SU);cur=c.cursor()
    cur.execute("SET search_path TO maint,public; SET app.role='SYSTEM'")
    # Job cards, extensions and documents can never be deleted (by design);
    # the harness clears its own fixtures as the superuser with triggers off
    # for this session only, then switches them back on.
    cur.execute("SET session_replication_role = replica; DELETE FROM job_sheet_event; DELETE FROM job_sheet; DELETE FROM job_card_item; DELETE FROM job_card; DELETE FROM contract_document; DELETE FROM contract_extension; SET session_replication_role = DEFAULT; DELETE FROM ticket_event; DELETE FROM ticket")
    cur.execute("""INSERT INTO ticket (id,ticket_no,premises_id,area_id,scope_path,inspection_rank,
     sub_category_id,raised_by,assigned_to,verified_by,inspected_by,
     state,is_emergency,description,completion_deadline_at,original_completion_deadline_at,
     sla_completion_minutes,escalation_level,objection_count,reopened_count,rework_count,response_met)
     VALUES (%s,'PROBE/1','11111111-1111-1111-1111-111111111111',
     'aaaa1111-1111-1111-1111-111111111111','ncl.jayant.colony1',22,
     'dddd1111-1111-1111-1111-111111111111','11111111-aaaa-1111-1111-111111111111',
     '77777777-7777-7777-7777-777777777777','88888888-8888-8888-8888-888888888888',
     '88888888-8888-8888-8888-888888888888','ASSIGNED',true,'original text',
     now()+interval '1 hour',now()+interval '1 hour',120,2,1,1,1,false)""",(TID,))
    c.commit();c.close()

print("="*78); print("PART 2 — ROLE x FIELD WRITE AUTHORITY"); print("="*78)
fails=0
for col,allowed in EXPECT.items():
    row=[]
    for role in ROLES:
        reset()
        c=psycopg2.connect(**M);cur=c.cursor()
        try:
            cur.execute("SET search_path TO maint,public")
            cur.execute("SET app.role=%s",(role,)); cur.execute("SET app.scope_path=%s",(SC[role],))
            cur.execute("SET app.actor_id=%s",(DEV[role],))
            cur.execute("SET app.premises_id='11111111-1111-1111-1111-111111111111'")
            cur.execute(f"UPDATE ticket SET {col}={VALS[col]} WHERE id='{TID}'")
            got=cur.rowcount>0; c.commit()
        except psycopg2.Error:
            got=False; c.rollback()
        c.close()
        want=role in allowed
        ok=(got==want)
        if not ok: fails+=1
        row.append(('✓' if got else '·') if ok else ('!' if got else 'X'))
    print(f"  {col:<34} {' '.join(row)}")
print("\n  columns:"," ".join(r[:3] for r in ROLES))
print(f"  field-authority mismatches: {fails}")
# A matrix that cannot fail proves nothing: it used to exit 0 regardless.
sys.exit(1 if fails else 0)
