#!/usr/bin/env python3
"""
NCL Colony Maintenance Portal — exhaustive conformance harness.

Enumerates every role against every event, every policy and every
documented condition across B1, B2 and B3, and checks the observed
behaviour against what the FRS requires.

Expectations are derived from the requirements document, NOT from the
schema — otherwise the test only proves the schema agrees with itself.
"""
import psycopg2, itertools, sys, re
from collections import defaultdict

from pgconn import M, I, SU, SUI

USER_ROLES = ['RESIDENT', 'CUSTODIAN', 'CONTRACTOR_SUPERVISOR', 'CIVIL_OVERSEER',
              'MAINTENANCE_INCHARGE', 'STAFF_OFFICER_CIVIL', 'GM_CIVIL', 'ADMINISTRATOR']
CONTEXTS = ['SYSTEM', 'AUTH', 'RETENTION']

# --- what the FRS requires, stated independently of the schema ----------
# FRS 5.1/5.2: verification and inspection belong to the Overseer;
# assignment to the Incharge; execution to the contractor and stops at a
# completion CLAIM; reopening to the occupant; special repair to the
# Staff Officer.
FRS_TRANSITIONS = {
    ('RAISED', 'VERIFIED'):                       {'CIVIL_OVERSEER'},
    ('RAISED', 'REJECTED'):                       {'CIVIL_OVERSEER'},
    # decision 2026-09-30: the Overseer allots on site as well
    ('VERIFIED', 'ASSIGNED'):                     {'MAINTENANCE_INCHARGE', 'CIVIL_OVERSEER'},
    ('ASSIGNED', 'IN_PROGRESS'):                  {'CONTRACTOR_SUPERVISOR'},
    ('IN_PROGRESS', 'WORK_COMPLETED'):            {'CONTRACTOR_SUPERVISOR'},
    ('WORK_COMPLETED', 'INSPECTED_ACCEPTED'):     {'CIVIL_OVERSEER'},
    ('WORK_COMPLETED', 'REWORK'):                 {'CIVIL_OVERSEER'},
    ('REWORK', 'IN_PROGRESS'):                    {'CONTRACTOR_SUPERVISOR'},
    ('INSPECTED_ACCEPTED', 'CLOSED'):             {'CIVIL_OVERSEER', 'MAINTENANCE_INCHARGE'},
    ('CLOSED', 'REOPENED'):                       {'RESIDENT', 'CUSTODIAN'},
    ('REOPENED', 'ASSIGNED'):                     {'MAINTENANCE_INCHARGE', 'CIVIL_OVERSEER'},
    ('RAISED', 'REFERRED_SPECIAL_REPAIR'):        {'CIVIL_OVERSEER'},
    ('VERIFIED', 'REFERRED_SPECIAL_REPAIR'):      {'MAINTENANCE_INCHARGE'},
    ('IN_PROGRESS', 'REFERRED_SPECIAL_REPAIR'):   {'CIVIL_OVERSEER', 'STAFF_OFFICER_CIVIL'},
    ('REFERRED_SPECIAL_REPAIR', 'CLOSED'):        {'STAFF_OFFICER_CIVIL'},
}
# Transitions that must be refused for EVERYONE (contract-integrity rules)
FORBIDDEN = [
    ('WORK_COMPLETED', 'CLOSED'),      # closure without inspection
    ('IN_PROGRESS', 'CLOSED'),         # contractor shortcut
    ('ASSIGNED', 'WORK_COMPLETED'),    # completion without starting
    ('RAISED', 'CLOSED'),              # straight to closed
    ('RAISED', 'ASSIGNED'),            # assignment without verification
    ('VERIFIED', 'WORK_COMPLETED'),    # skipping the contractor entirely
    ('CLOSED', 'IN_PROGRESS'),         # reanimating a closed ticket
]

PREM_J = '11111111-1111-1111-1111-111111111111'
PREM_N = '22222222-2222-2222-2222-222222222222'
DEV = {
    'RESIDENT':              '11111111-aaaa-1111-1111-111111111111',
    'CUSTODIAN':             '11111111-cccc-1111-1111-111111111111',
    'CONTRACTOR_SUPERVISOR': '77777777-7777-7777-7777-777777777777',
    'CIVIL_OVERSEER':        '88888888-8888-8888-8888-888888888888',
    'MAINTENANCE_INCHARGE':  '88880000-8888-8888-8888-888888888888',
    'STAFF_OFFICER_CIVIL':   '88881111-8888-8888-8888-888888888888',
    'GM_CIVIL':              '55555555-5555-5555-5555-555555555555',
    'ADMINISTRATOR':         '44444444-4444-4444-4444-444444444444',
}
SCOPE = {r: 'ncl.jayant' for r in USER_ROLES}
SCOPE['RESIDENT'] = SCOPE['CUSTODIAN'] = 'ncl.jayant.colony1'
SCOPE['GM_CIVIL'] = SCOPE['ADMINISTRATOR'] = 'ncl'

results = defaultdict(list)


def ctx(cur, role, premises=PREM_J):
    cur.execute("SET search_path TO maint,public")
    cur.execute("SET app.role = %s", (role,))
    cur.execute("SET app.scope_path = %s", (SCOPE.get(role, 'ncl'),))
    cur.execute("SET app.actor_id = %s", (DEV.get(role, DEV['CIVIL_OVERSEER']),))
    cur.execute("SET app.premises_id = %s", (premises,))
    # inspection acceptance needs an app (device-key) session: decision 2026-09-30
    cur.execute("SET app.auth_method = 'device'")


def seed():
    c = psycopg2.connect(**SU); cur = c.cursor()
    cur.execute("SET search_path TO maint,public; SET app.role='SYSTEM'")
    cur.execute("""
        INSERT INTO premises_ref
          (premises_id, area_id, area_code, colony_id, scope_path, identifier,
           premises_type, quarter_type, occupancy_model, inspection_rank) VALUES
         (%s,'aaaa1111-1111-1111-1111-111111111111','JNT',
          'bbbb1111-1111-1111-1111-111111111111',
          'ncl.jayant.colony1','B-234','QUARTER','B','RESIDENT_BOUND',22),
         (%s,'aaaa2222-2222-2222-2222-222222222222','NGH',
          'bbbb2222-2222-2222-2222-222222222222',
          'ncl.nigahi.colony1','C-99','QUARTER','C','RESIDENT_BOUND',21)
        ON CONFLICT DO NOTHING""", (PREM_J, PREM_N))
    cur.execute("""
        INSERT INTO category (id,code,name_en,name_hi,display_order)
        VALUES ('cccc1111-1111-1111-1111-111111111111','WATER','Water','x',1)
        ON CONFLICT DO NOTHING""")
    cur.execute("""
        INSERT INTO sub_category (id,category_id,code,name_en,name_hi,
                                  emergency_eligible,display_order)
        VALUES ('dddd1111-1111-1111-1111-111111111111',
                'cccc1111-1111-1111-1111-111111111111','LEAK','Leak','x',false,1),
               ('dddd2222-2222-2222-2222-222222222222',
                'cccc1111-1111-1111-1111-111111111111','NOWATER','No water','x',true,2)
        ON CONFLICT DO NOTHING""")
    for role, dev in DEV.items():
        # one person per role here, so the actor id doubles as the person id
        cur.execute("""INSERT INTO actor_ref (actor_id,person_id,person_name,role,scope_path,
                       premises_id,status) VALUES (%s,%s,%s,%s,%s,%s,'ACTIVE')
                       ON CONFLICT DO NOTHING""",
                    (dev, dev, role.title(), role, SCOPE.get(role, 'ncl'),
                     PREM_J if role in ('RESIDENT', 'CUSTODIAN') else None))
    c.commit(); c.close()


def make_ticket(state, tid, premises=PREM_J, emergency=False, sub='dddd1111-1111-1111-1111-111111111111'):
    """Create a ticket directly in the given state, as SYSTEM."""
    c = psycopg2.connect(**SU); cur = c.cursor()
    cur.execute("SET search_path TO maint,public; SET app.role='SYSTEM'")
    # the duplicate-open-ticket index permits only one open ticket per
    # premises+subcategory, so the harness clears between cases
    cur.execute("DELETE FROM ticket_event")
    cur.execute("DELETE FROM ticket_media")
    cur.execute("DELETE FROM ticket_objection")
    cur.execute("DELETE FROM ticket_feedback")
    cur.execute("DELETE FROM sla_pause")
    cur.execute("DELETE FROM sla_breach")
    cur.execute("DELETE FROM escalation_event")
    # Job cards, extensions and documents can never be deleted (by design);
    # the harness clears its own fixtures as the superuser with triggers off
    # for this session only, then switches them back on.
    cur.execute("SET session_replication_role = replica; DELETE FROM job_sheet_event; DELETE FROM job_sheet; DELETE FROM job_card_item; DELETE FROM job_card; DELETE FROM contract_document; DELETE FROM contract_extension; SET session_replication_role = DEFAULT; DELETE FROM ticket")
    insp = DEV['CIVIL_OVERSEER'] if state in ('INSPECTED_ACCEPTED', 'CLOSED') else None
    ref = (state == 'REFERRED_SPECIAL_REPAIR')
    scope = 'ncl.jayant.colony1' if premises == PREM_J else 'ncl.nigahi.colony1'
    area = ('aaaa1111-1111-1111-1111-111111111111' if premises == PREM_J
            else 'aaaa2222-2222-2222-2222-222222222222')
    cur.execute("""
        INSERT INTO ticket (id,ticket_no,premises_id,area_id,scope_path,inspection_rank,
                            sub_category_id,raised_by,assigned_to,
                            inspected_by,state,is_emergency,closed_at,
                            referred_special_repair)
        VALUES (%s,%s,%s,%s,%s,22,%s,%s,%s,%s,%s,%s,now(),%s)""",
        (tid, 'T/'+tid[-12:], premises, area, scope, sub,
         DEV['RESIDENT'], DEV['CONTRACTOR_SUPERVISOR'], insp, state, emergency, ref))
    # The photograph gates (enforce_photo_gates) refuse a claim or an
    # inspection without the right evidence, whatever the role. This matrix
    # is about WHICH ROLE may make a move, so the evidence is put in place
    # and authority is the only thing left to decide. The gates themselves
    # are tested in matrix4 and suite 9.
    if state == 'IN_PROGRESS':
        cur.execute("""UPDATE ticket SET contractor_window_started_at = now() - interval '1 hour'
                        WHERE id=%s""", (tid,))
        add_photo(cur, tid, 'BEFORE', DEV['CONTRACTOR_SUPERVISOR'])      # a claim needs both (2026-10-07)
        add_photo(cur, tid, 'COMPLETION', DEV['CONTRACTOR_SUPERVISOR'])
    if state == 'WORK_COMPLETED':
        cur.execute("""UPDATE ticket SET completed_claim_at = now() - interval '1 hour'
                        WHERE id=%s""", (tid,))
        add_photo(cur, tid, 'INSPECTION', DEV['CIVIL_OVERSEER'])
    c.commit(); c.close()


def add_photo(cur, tid, purpose, device):
    """A stored photograph as the app would leave it: in-app, geo-tagged."""
    cur.execute("""
        INSERT INTO ticket_media (ticket_id, purpose, storage_key, content_hash,
            captured_at, latitude, longitude, capture_verified, uploaded_by,
            purge_after, upload_state, size_bytes)
        VALUES (%s, %s, 'k-' || gen_random_uuid(), 'h', now(), 24.11, 82.65, true,
                %s, now() + interval '2 years', 'STORED', 1)""", (tid, purpose, device))


def attempt_transition(role, frm, to):
    tid = '0000eeee-0000-0000-0000-%012d' % (abs(hash((role, frm, to))) % 10**12)
    make_ticket(frm, tid)
    c = psycopg2.connect(**M); cur = c.cursor()
    try:
        ctx(cur, role)
        extra = ""
        if to in ('INSPECTED_ACCEPTED',):
            extra = ", inspected_by='%s'" % DEV['CIVIL_OVERSEER']
        if to == 'CLOSED' and frm == 'REFERRED_SPECIAL_REPAIR':
            extra = ", referred_special_repair=true"

        cur.execute("UPDATE ticket SET state=%%s%s WHERE id=%%s" % extra, (to, tid))
        n = cur.rowcount
        c.commit()
        return n > 0                      # 0 rows == blocked by policy
    except psycopg2.Error:
        c.rollback()
        return False
    finally:
        c.close()


print("=" * 74)
print("PART 1 — ROLE x TRANSITION MATRIX")
print("=" * 74)
seed()
pairs = list(FRS_TRANSITIONS.keys()) + FORBIDDEN
fails = 0
for frm, to in pairs:
    allowed_by_frs = FRS_TRANSITIONS.get((frm, to), set())
    row = []
    for role in USER_ROLES:
        got = attempt_transition(role, frm, to)
        # ADMINISTRATOR is subject to the transition table like every other
        # role: an admin able to move RAISED -> WORK_COMPLETED could
        # fabricate contractor performance, and that record may decide a
        # payment. Only the SYSTEM context bypasses.
        want = role in allowed_by_frs
        ok = (got == want)
        if not ok:
            fails += 1
            results['transition'].append((role, frm, to, want, got))
        row.append(('✓' if got else '·') if ok else ('!' if got else 'X'))
    print(f"  {frm:>24} -> {to:<24} {' '.join(row)}")
print("\n  legend: ✓ allowed as required   · denied as required   "
      "X wrongly denied   ! WRONGLY ALLOWED")
print("  columns:", " ".join(r[:3] for r in USER_ROLES))
print(f"\n  transition mismatches: {fails}")
sys.exit(0 if fails == 0 else 1)
