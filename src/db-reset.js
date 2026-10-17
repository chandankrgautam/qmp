import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dropdb, createdb, psqlFile, psqlCommand } from './pgadmin.js';

// fileURLToPath, not URL.pathname: on Windows .pathname gives /C:/..., which
// psql then reads as C:\C:\...
const sql = fileURLToPath(new URL('../sql', import.meta.url));

const IDENTITY_DB = process.env.IDENTITY_DB || 'ncl_identity';
const MAINT_DB = process.env.MAINT_DB || 'ncl_maint';
for (const db of [IDENTITY_DB, MAINT_DB]) { dropdb(db); createdb(db); }
psqlFile(IDENTITY_DB, path.join(sql, '01_identity_schema.sql'));
psqlFile(MAINT_DB, path.join(sql, '02_maintenance_schema.sql'));
for (const [db, sch] of [[IDENTITY_DB, 'identity'], [MAINT_DB, 'maint']]) {
  psqlCommand(db, `GRANT USAGE ON SCHEMA ${sch} TO appconn; ` +
    `GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA ${sch} TO appconn; ` +
    `GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${sch} TO appconn;`);
}
console.log(`databases reset (${IDENTITY_DB}, ${MAINT_DB})`);
