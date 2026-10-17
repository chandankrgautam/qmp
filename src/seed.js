import { identityPool, maintPool, withSystem } from './db.js';
import { generateDeviceKeypair } from './auth.js';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

/* Thirteen Areas with colonies. The ticket code is the abbreviation the
   department already uses on files — not uniform in length, and not always
   the first three letters. */
const AREAS = [
  ['amlohri',      'AML',  'Amlohri'],
  ['nigahi',       'NGH',  'Nigahi'],
  ['jayant',       'JNT',  'Jayant'],
  ['dudhichua',    'DCH',  'Dudhichua'],
  ['khadia',       'KHD',  'Khadia'],
  ['krishnashila', 'KSL',  'Krishnashila'],
  ['bina',         'BINA', 'Bina'],
  ['kakri',        'KKR',  'Kakri'],
  ['jhingurda',    'JRD',  'Jhingurda'],
  ['blockb',       'BLB',  'Block-B'],
  ['cws',          'CWS',  'Central Workshop'],
  ['nsc',          'NSC',  'Nehru Shatabdi Chikitsalaya'],
  ['nclhq',        'NHQ',  'NCL HQ Colony']
];

const CATEGORIES = [
  ['WATER', 'Water supply and plumbing', 'जल आपूर्ति एवं नलसाजी', 1, [
    ['NOWATER','No water supply — whole quarter','पूरे क्वार्टर में पानी नहीं',true,120,480],
    ['BURST','Burst or leaking main pipeline','मुख्य पाइपलाइन फटना',true,120,720],
    ['TAP','Leaking tap, valve or fitting','टपकता नल',false,1440,2880],
    ['INTPIPE','Internal pipe leakage or blockage','आंतरिक पाइप रिसाव',false,1440,4320]]],
  ['SANI', 'Sanitary and sewerage', 'स्वच्छता एवं मलजल', 2, [
    ['SEWAGE','Sewage overflow inside quarter','क्वार्टर में मलजल',true,120,480],
    ['MANHOLE','Manhole cover broken or missing','मैनहोल ढक्कन टूटा',true,240,1440],
    ['WCBLOCK','WC or pan blocked','शौचालय अवरुद्ध',false,1440,2880]]],
  ['STRUCT','Structure and masonry','संरचना एवं चिनाई', 3, [
    ['CRACK','Structural crack or collapse risk','संरचनात्मक दरार',true,120,10080],
    ['CEILING','Ceiling plaster falling','छत का प्लास्टर गिरना',true,240,4320],
    ['ROOF','Roof leakage','छत से रिसाव',false,1440,10080],
    ['SEEP','Wall seepage or dampness','दीवार में सीलन',false,2880,14400]]],
  ['CARP','Carpentry and fittings','बढ़ईगीरी', 4, [
    ['DOOR','Door damaged or not closing','दरवाजा क्षतिग्रस्त',false,1440,4320],
    ['WINDOW','Window or shutter damage','खिड़की क्षतिग्रस्त',false,2880,7200]]],
  ['FINISH','Finishing','फिनिशिंग', 5, [
    ['WHITEWASH','Whitewash or distemper','सफेदी',false,10080,43200]]],
  ['ELEC','Electrical','विद्युत', 6, [
    ['WIRING','Wiring, switches, fans','वायरिंग, स्विच, पंखे',false,1440,2880]]]
];


/* People and their roles (decision 2026-09-30). A person may hold several
   roles; every official also has a resident page for their quarter. Each
   person gets one demo device, and devices.json has one key per
   (role, person), all of a person's keys sharing that one device — which
   is how one phone switches between roles.
   [name, employee id, category, [[role, scope, premises, extra]...]] */
const DEMO_PASSWORD = 'Portal@2026';   // development only — see development_logs.md
const PEOPLE = [
  ['R. K. Singh',        '90221001', 'NCL',     [['RESIDENT', 'ncl.jayant.colony1', 'B-234']]],
  ['Mrs S. Singh',       null,           'NCL',     [['RESIDENT', 'ncl.jayant.colony1', 'B-234']]],
  ['M/s Verma — Supr',   null,           'NON_NCL', [['CONTRACTOR_SUPERVISOR', 'ncl.jayant', null, { contract: 'jayant' }]]],
  ['M/s Jayant Constructions', null,     'NON_NCL', [['CONTRACTOR', 'ncl.jayant', null, { contract: 'jayant' }]]],
  ['A. K. Dubey',        '90222001', 'NCL',     [['CIVIL_OVERSEER', 'ncl.jayant', null, { designation: 'Civil Overseer' }],
                                                     ['RESIDENT', 'ncl.jayant.colony1', 'D-12']]],
  ['P. N. Mishra',       '90222002', 'NCL',     [['MAINTENANCE_INCHARGE', 'ncl.jayant', null, { designation: 'Dy. Manager (Civil)' }],
                                                     ['RESIDENT', 'ncl.jayant.colony1', 'D-14']]],
  ['S. Tiwari',          '90222003', 'NCL',     [['STAFF_OFFICER_CIVIL', 'ncl.jayant', null, { designation: 'Chief Manager (Civil)' }],
                                                     ['RESIDENT', 'ncl.jayant.colony1', 'A-3']]],
  ['R. Kumar',           '90222004', 'NCL',     [['AREA_HR_ADMIN', 'ncl.jayant', null, { designation: 'Sr. Manager (Personnel)' }],
                                                     ['RESIDENT', 'ncl.jayant.colony1', 'MQ-7']]],
  ['V. Sharma',          '90222005', 'NCL',     [['AREA_SYS_ADMIN', 'ncl.jayant', null, { designation: 'Manager (Systems)' }]]],
  ['Guest House Custodian', '90222006', 'NCL',  [['CUSTODIAN', 'ncl.jayant.colony1', 'GH-1']]],
  ['GM (Civil)',         '90229001', 'NCL',     [['GM_CIVIL', 'ncl', null, { designation: 'GM (Civil) — HOD' }]]],
  ['Director (Technical)', '90229002', 'NCL',   [['HQ_EXECUTIVE', 'ncl', null, { designation: 'Director (Technical)' }]]],
  ['CMD',                '90229003', 'NCL',     [['HQ_EXECUTIVE', 'ncl', null, { designation: 'Chairman-cum-Managing Director' }]]],
  ['Nigahi Overseer',    '90223001', 'NCL',     [['CIVIL_OVERSEER', 'ncl.nigahi', null, { designation: 'Civil Overseer' }]]],
  ['Nigahi resident',    '90223002', 'NCL',     [['RESIDENT', 'ncl.nigahi.colony1', 'C-99']]],
  ['System Admin',       '90229900', 'NCL',     [['ADMINISTRATOR', 'ncl', null, { designation: 'HQ System Administrator' }]]]
];

const MATERIALS = [
  ['CEM-OPC43',  'Cement, OPC 43 grade',          'सीमेंट, ओपीसी 43 ग्रेड',     'Bag',   'Civil',     4],
  ['SAND-CRS',   'Coarse sand',                    'मोटी रेत',                    'Cum',   'Civil',     0.5],
  ['BRICK-1CL',  'Bricks, first class',            'ईंट, प्रथम श्रेणी',            'No.',   'Civil',     200],
  ['PLM-PCOCK15','CP pillar cock, 15 mm',          'सीपी पिलर कॉक, 15 मिमी',      'No.',   'Plumbing',  2],
  ['PLM-PVC20',  'PVC pipe, 20 mm',                'पीवीसी पाइप, 20 मिमी',        'Rm',    'Plumbing',  12],
  ['PLM-GI15',   'GI pipe, 15 mm',                 'जीआई पाइप, 15 मिमी',          'Rm',    'Plumbing',  12],
  ['PLM-WASHER', 'Washer set',                     'वॉशर सेट',                    'Set',   'Plumbing',  4],
  ['SAN-WCSEAT', 'WC seat cover',                  'डब्ल्यूसी सीट कवर',           'No.',   'Plumbing',  1],
  ['PNT-PUTTY',  'Wall putty',                     'वॉल पुट्टी',                  'Kg',    'Painting',  40],
  ['PNT-DIST',   'Oil-bound distemper',            'ऑयल बाउंड डिस्टेंपर',         'Litre', 'Painting',  20],
  ['PNT-ENAMEL', 'Synthetic enamel paint',         'सिंथेटिक इनेमल पेंट',          'Litre', 'Painting',  8],
  ['GLZ-PANE4',  'Glass pane, 4 mm',               'कांच, 4 मिमी',                'Sqm',   'Glazing',   2],
  ['CRP-HINGE',  'Door hinge, 100 mm',             'दरवाज़े का कब्ज़ा, 100 मिमी',   'No.',   'Carpentry', 6],
  ['CRP-TBOLT',  'Tower bolt, 150 mm',             'टावर बोल्ट, 150 मिमी',        'No.',   'Carpentry', 4],
  ['FLR-TILE',   'Vitrified floor tile',           'विट्रीफाइड फ़र्श टाइल',          'Sqm',   'Flooring',  10]
];

async function main() {
  // The load simulation rebuilds only the maintenance database between
  // runs, so identity seeding is skippable.
  const maintOnly = process.argv.includes('--maint-only');
  const { hashPassword } = await import('./auth.js');

  if (!maintOnly) await withSystem(identityPool, async (c) => {
    for (const [code, ticketCode, name] of AREAS) {
      await c.query(`INSERT INTO identity.area (code,ticket_code,name,scope_path)
        VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO NOTHING`, [code, ticketCode, name, `ncl.${code}`]);
      await c.query(`INSERT INTO identity.colony (area_id,code,name,scope_path)
        SELECT id,'colony1',$2,$3 FROM identity.area WHERE code=$1
        ON CONFLICT DO NOTHING`, [code, `${name} Colony`, `ncl.${code}.colony1`]);
    }
    // A handful of premises in Jayant and Nigahi, including non-residential
    const premises = [
      ['jayant','B-234','QUARTER','B','RESIDENT_BOUND'],
      ['jayant','D-12','QUARTER','D','RESIDENT_BOUND'],
      ['jayant','D-14','QUARTER','D','RESIDENT_BOUND'],
      ['jayant','A-3','QUARTER','A','RESIDENT_BOUND'],
      ['jayant','MQ-7','QUARTER','MQ','RESIDENT_BOUND'],
      // a building with a custodian, who raises and confirms (decision 2026-09-30)
      ['jayant','GH-1','GUEST_HOUSE',null,'CUSTODIAN_BOUND'],
      // buildings under direct Civil Department control
      ['jayant','Hostel-1','HOSTEL',null,'DEPARTMENT_ONLY'],
      ['jayant','Union Office','UNION_OFFICE',null,'DEPARTMENT_ONLY'],
      ['jayant','Civil Office','ADMIN_BUILDING',null,'DEPARTMENT_ONLY'],
      ['nigahi','C-99','QUARTER','C','RESIDENT_BOUND']
    ];
    for (const [area, ident, ptype, qtype, occ] of premises) {
      await c.query(
        `INSERT INTO identity.premises (area_id, colony_id, scope_path, identifier,
            premises_type, quarter_type, occupancy_model, verified)
         SELECT a.id, col.id, col.scope_path, $2, $3, $4, $5, true
           FROM identity.area a JOIN identity.colony col ON col.area_id = a.id
          WHERE a.code = $1
         ON CONFLICT (colony_id, identifier) DO NOTHING`, [area, ident, ptype, qtype, occ]);
    }
  });

  await withSystem(maintPool, async (c) => {
    for (const [code, en, hi, order, subs] of CATEGORIES) {
      const cat = await c.query(
        `INSERT INTO category (code,name_en,name_hi,display_order,classification)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (code) DO UPDATE SET name_en=EXCLUDED.name_en RETURNING id`,
        [code, en, hi, order, code === 'ELEC' ? 'EM' : 'CIVIL']);
      let i = 0;
      for (const [scode, sen, shi, emerg, resp, comp] of subs) {
        i++;
        const sc = await c.query(
          `INSERT INTO sub_category (category_id,code,name_en,name_hi,
                emergency_eligible,display_order,classification)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (code) DO UPDATE SET name_en=EXCLUDED.name_en RETURNING id`,
          [cat.rows[0].id, scode, sen, shi, emerg, i, code === 'ELEC' ? 'EM' : 'CIVIL']);
        await c.query(
          `INSERT INTO sla_rule (sub_category_id, premises_type, response_minutes,
                completion_minutes, changed_by)
           VALUES ($1,NULL,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [sc.rows[0].id, resp, comp, '00000000-0000-0000-0000-000000000000']);
      }
    }
  });

  // Area contact numbers for the excluded-scope notice
  await withSystem(maintPool, async (c) => {
    const areas = await withSystem(identityPool, (ic) => ic.query(`SELECT id, name, scope_path::text FROM identity.area`));
    for (const a of areas.rows) {
      await c.query(
        `INSERT INTO area_contact (area_id, scope_path, label_en, label_hi, phone)
         SELECT $1, $2::ltree, $3, $4, $5
          WHERE NOT EXISTS (SELECT 1 FROM area_contact WHERE area_id=$1)`,
        [a.id, a.scope_path, `${a.name} Civil Maintenance Office`, `${a.name} सिविल अनुरक्षण कार्यालय`,
         '07805-26' + String(1000 + Math.floor(Math.random() * 8999)).slice(0, 4)]);
    }
  });

  if (maintOnly) {
    console.log('seeded: categories and SLA rules only');
    await identityPool.end(); await maintPool.end();
    return;
  }

  // The materials master (decision 2026-09-30): what contractors claim
  // against. Quantities and norms only — no rates (control 9).
  await withSystem(maintPool, async (c) => {
    for (const [code, en, hi, unit, cat, norm] of MATERIALS) {
      await c.query(
        `INSERT INTO material (code, name_en, name_hi, unit, category, norm_max_per_job)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (code) DO NOTHING`, [code, en, hi, unit, cat, norm]);
    }
  });

  // One contract per Area to begin with; an Area may have several.
  const contracts = {};
  await withSystem(maintPool, async (c) => {
    const areas = await withSystem(identityPool, (ic) => ic.query(
      `SELECT id, code, ticket_code, name, scope_path::text FROM identity.area`));
    for (const a of areas.rows) {
      const ct = await c.query(
        `INSERT INTO contract (area_id, scope_path, contractor_name, firm_address, contract_no, agreement_no,
             work_name, awarded_on, period_years, site_handover_on, starts_on, expires_on)
         VALUES ($1, $2::ltree, $3, 'Singrauli, Madhya Pradesh', $4, $5, $6,
                 current_date - 200, 2, current_date - 180, current_date - 180, current_date + 550)
         ON CONFLICT (agreement_no) DO UPDATE SET contractor_name = EXCLUDED.contractor_name
         RETURNING id`,
        [a.id, a.scope_path, `M/s ${a.name} Constructions`, `LOA/${a.ticket_code}/CIV/2025/01`,
         `NCL/${a.ticket_code}/CIV/2026/01`, `Comprehensive civil maintenance of ${a.name} Colony`]);
      contracts[a.code] = ct.rows[0].id;
    }
  });

  // People, their roles and one demo device each
  const keys = {};
  await withSystem(identityPool, async (c) => {
    for (const [name, empId, cat, roles] of PEOPLE) {
      const person = (await c.query(
        `INSERT INTO identity.person (name, personnel_no, mobile, is_employee, resident_category, designation, password_hash, password_set_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $7::text IS NULL THEN NULL ELSE now() END) RETURNING id`,
        [name, empId, '9' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0'), !!empId, cat,
         roles[0][3]?.designation ?? null, empId ? hashPassword(DEMO_PASSWORD) : null])).rows[0];
      const kp = generateDeviceKeypair();
      const device = (await c.query(
        `INSERT INTO identity.device (public_key, platform, person_id, scope_path, status, approved_at)
         VALUES ($1,'web',$2,$3,'ACTIVE',now()) RETURNING id`, [kp.publicKey, person.id, roles[0][1]])).rows[0];
      for (const [role, scope, premIdent, extra = {}] of roles) {
        const prem = premIdent ? (await c.query(
          `SELECT id FROM identity.premises WHERE identifier=$1 AND scope_path <@ $2::ltree LIMIT 1`, [premIdent, scope])).rows[0] : null;
        const a = (await c.query(
          `INSERT INTO identity.role_assignment (person_id, role, scope_path, premises_id, contract_id,
               designation, status, approved_at, reason)
           VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE',now(),'seeded') RETURNING id`,
          [person.id, role, scope, prem?.id ?? null, extra.contract ? contracts[extra.contract] : null,
           extra.designation ?? null])).rows[0];
        keys[`${role}:${name}`] = { device_id: device.id, person_id: person.id, actor_id: a.id, employee_id: empId,
          publicKey: kp.publicKey, privateKey: kp.privateKey, role, name, scope };
      }
    }
  });

  // Projections the maintenance service reads. Production keeps these
  // current by logical replication; the build syncs them explicitly.
  await syncProjections();

  fs.writeFileSync(process.env.DEVICES_FILE || new URL('../devices.json', import.meta.url), JSON.stringify(keys, null, 2));
  console.log(`seeded: ${AREAS.length} areas, ${PEOPLE.length} people, ${Object.keys(keys).length} roles`);
  console.log(`device keys written to devices.json; web password for employees: ${DEMO_PASSWORD}`);
  await identityPool.end(); await maintPool.end();
}

export async function syncProjections() {
  const prem = await withSystem(identityPool, (c) => c.query(
    `SELECT p.id, p.area_id, a.ticket_code, p.colony_id, p.scope_path, p.identifier,
            p.premises_type, p.quarter_type, p.occupancy_model,
            coalesce(r.rank, 99) AS rank
       FROM identity.premises p
       JOIN identity.area a ON a.id = p.area_id
       LEFT JOIN identity.inspection_sort_rank r
              ON r.premises_type = p.premises_type
             AND (r.quarter_type = p.quarter_type
                  OR (r.quarter_type IS NULL AND p.quarter_type IS NULL))`));
  const actors = await withSystem(identityPool, (c) => c.query(
    `SELECT a.id, a.person_id, pe.name, a.role::text, a.scope_path::text, a.premises_id, a.contract_id,
            CASE WHEN identity.assignment_in_force(a) THEN 'ACTIVE' ELSE a.status::text END AS status
       FROM identity.role_assignment a JOIN identity.person pe ON pe.id = a.person_id`));
  await withSystem(maintPool, async (c) => {
    for (const p of prem.rows) {
      await c.query(
        `INSERT INTO premises_ref (premises_id, area_id, area_code, colony_id, scope_path,
              identifier, premises_type, quarter_type, occupancy_model, inspection_rank)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (premises_id) DO UPDATE SET
              identifier=EXCLUDED.identifier, area_code=EXCLUDED.area_code,
              occupancy_model=EXCLUDED.occupancy_model, inspection_rank=EXCLUDED.inspection_rank`,
        [p.id, p.area_id, p.ticket_code, p.colony_id, p.scope_path, p.identifier,
         p.premises_type, p.quarter_type, p.occupancy_model, p.rank]);
    }
    for (const a of actors.rows) {
      await c.query(
        `INSERT INTO actor_ref (actor_id, person_id, person_name, role, scope_path, premises_id, contract_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (actor_id) DO UPDATE SET status=EXCLUDED.status, contract_id=EXCLUDED.contract_id`,
        [a.id, a.person_id, a.name, a.role, a.scope_path, a.premises_id, a.contract_id, a.status]);
    }
  });
}

// pathToFileURL, not a hand-built file:// string: on Windows the two never
// matched, so the seed exited having done nothing and said nothing.
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
