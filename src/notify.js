import { maintPool, withSystem } from './db.js';

/* ------------------------------------------------------------------ *
 * Notification dispatch
 *
 * In-app is authoritative and is always written. Push is best-effort and
 * is not implemented in this slice — nothing is lost by its absence,
 * because the unread badge carries the update at next login.
 *
 * Routing is by ancestor scope: an Incharge at ncl.jayant is notified of
 * a ticket at ncl.jayant.colony1; an Incharge at ncl.nigahi is not.
 * ------------------------------------------------------------------ */
export async function notify({ role, scope, actorId, premisesId, event, en, hi }) {
  return withSystem(maintPool, async (c) => {
    let targets = [];
    if (actorId) {
      targets = [{ actor_id: actorId }];
    } else if (premisesId) {
      targets = (await c.query(`SELECT actor_id FROM occupants_at_premises($1)`,
        [premisesId])).rows;
    } else {
      targets = (await c.query(`SELECT actor_id FROM actors_to_notify($1,$2)`,
        [role, scope])).rows;
    }
    for (const t of targets) {
      await c.query(
        `INSERT INTO notification (actor_id, event_type, title_en, body_en,
                                   title_hi, body_hi)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [t.actor_id, event, en[0], en[1], hi[0], hi[1]]);
    }
    return targets.length;
  });
}

/* ------------------------------------------------------------------ *
 * SLA sweep and escalation
 *
 * Runs in the SYSTEM context, which is the only context that can see
 * every ticket across every Area. An earlier version of the row policy
 * omitted that branch and this job silently processed nothing — no
 * error, no log line — so the first thing it does is assert that it can
 * see tickets at all.
 * ------------------------------------------------------------------ */
/* A cap per run, because a backlog must drain rather than block.
 *
 * Measured at 90,000 tickets with a year of unprocessed breaches: the
 * uncapped sweep took 129 seconds and wrote 110,000 notifications in one
 * transaction. Steady state is 0.4 seconds, so this only bites after
 * downtime or on first run against existing data — which is exactly when
 * a two-minute transaction is least welcome. Capped, the backlog drains
 * over consecutive runs and each run stays short.
 */
export async function runSlaSweep({ quiet = false, maxEscalations = 500 } = {}) {
  return withSystem(maintPool, async (c) => {
    const visible = Number((await c.query(`SELECT count(*) n FROM ticket`)).rows[0].n);

    // 1. record breaches that have not been recorded yet
    const breached = await c.query(`
      INSERT INTO sla_breach (ticket_id, clock, breached_at)
      SELECT t.id, 'COMPLETION', t.completion_deadline_at
        FROM ticket t
       WHERE t.completion_deadline_at < now()
         AND t.state IN ('VERIFIED','ASSIGNED','IN_PROGRESS','REWORK')
         AND NOT EXISTS (SELECT 1 FROM sla_breach b
                          WHERE b.ticket_id = t.id AND b.clock='COMPLETION')
       ORDER BY t.completion_deadline_at
       LIMIT $1
      RETURNING ticket_id`, [maxEscalations]);

    // 2. raise escalation level where the interval for the next level has passed
    const rules = (await c.query(
      `SELECT level, is_emergency, minutes_after_breach, notify_role
         FROM escalation_rule ORDER BY level`)).rows;

    // oldest first, so a backlog drains in the order it accumulated
    const overdue = (await c.query(`
      SELECT t.id, t.ticket_no, t.is_emergency, t.scope_path, t.escalation_level,
             t.completion_deadline_at, t.premises_id,
             round(extract(epoch FROM now() - t.completion_deadline_at)/60) AS mins_over,
             p.identifier
        FROM ticket t JOIN premises_ref p ON p.premises_id = t.premises_id
       WHERE t.completion_deadline_at < now()
         AND t.state IN ('VERIFIED','ASSIGNED','IN_PROGRESS','REWORK')
       ORDER BY t.completion_deadline_at
       LIMIT $1`, [maxEscalations * 2])).rows;

    let raised = 0, sent = 0, deferred = 0;
    for (const t of overdue) {
      if (raised >= maxEscalations) { deferred++; continue; }
      const applicable = rules
        .filter((r) => r.is_emergency === t.is_emergency
                    && Number(t.mins_over) >= r.minutes_after_breach)
        .map((r) => r.level);
      const target = applicable.length ? Math.max(...applicable) : 0;
      if (target <= t.escalation_level) continue;

      for (let lvl = t.escalation_level + 1; lvl <= target; lvl++) {
        const rule = rules.find((r) => r.level === lvl && r.is_emergency === t.is_emergency);
        await c.query(
          `INSERT INTO escalation_event (ticket_id, level) VALUES ($1,$2)`, [t.id, lvl]);
        sent += await notify({
          role: rule.notify_role, scope: t.scope_path,
          event: `SLA_BREACH_L${lvl}`,
          en: [`Overdue: ${t.identifier}`,
               `${t.ticket_no} is past its SLA. Escalation level ${lvl}.`],
          hi: [`समय सीमा पार: ${t.identifier}`,
               `${t.ticket_no} की समय सीमा बीत चुकी है। स्तर ${lvl}।`]
        });
      }
      await c.query(`UPDATE ticket SET escalation_level=$1 WHERE id=$2`, [target, t.id]);
      raised++;

      // The resident sees the escalation. This is what makes it worth trusting.
      await notify({
        premisesId: t.premises_id, event: 'ESCALATED',
        en: ['Your complaint has been escalated',
             `${t.ticket_no} is overdue and has gone to a higher officer.`],
        hi: ['आपकी शिकायत आगे बढ़ाई गई',
             `${t.ticket_no} की समय सीमा बीत गई है, यह वरिष्ठ अधिकारी को भेजी गई है।`]
      });
    }

    // 3. inspection backlog — the system's principal failure indicator
    const backlog = (await c.query(`
      SELECT p.scope_path,
             round(max(extract(epoch FROM now() - t.completed_claim_at)/3600)) AS oldest_hours,
             count(*) AS pending
        FROM ticket t JOIN premises_ref p ON p.premises_id = t.premises_id
       WHERE t.state = 'WORK_COMPLETED'
       GROUP BY p.scope_path`)).rows;
    for (const b of backlog) {
      if (Number(b.oldest_hours) < 48) continue;
      sent += await notify({
        role: 'MAINTENANCE_INCHARGE', scope: b.scope_path,
        event: 'INSPECTION_BACKLOG',
        en: ['Inspection backlog',
             `${b.pending} job(s) waiting, oldest ${b.oldest_hours} hours.`],
        hi: ['निरीक्षण लंबित',
             `${b.pending} कार्य लंबित, सबसे पुराना ${b.oldest_hours} घंटे।`]
      });
    }

    const summary = { tickets_visible: visible, new_breaches: breached.rowCount,
      escalated: raised, notifications: sent, deferred_to_next_run: deferred };
    if (!quiet) console.log('[sla-sweep]', JSON.stringify(summary));
    return summary;
  });
}

/** Started by the server. Interval is short here so behaviour is observable. */
export function startScheduler(intervalMs = 60_000) {
  const tick = () => runSlaSweep({ quiet: true }).catch((e) =>
    console.error('[sla-sweep] failed', e.message));
  tick();
  return setInterval(tick, intervalMs);
}
