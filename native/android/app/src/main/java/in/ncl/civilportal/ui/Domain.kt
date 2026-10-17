package `in`.ncl.civilportal.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import `in`.ncl.civilportal.ui.theme.CpStatus
import `in`.ncl.civilportal.ui.theme.LocalCpStatus
import java.time.Duration
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToInt

/* The project's lifecycle as the occupant reads it — the same words as the
   web portal (web/src/lib/domain.ts), so the phone and the web never
   describe a complaint differently. */

enum class Tone { OK, RISK, BAD, INFO, REOPEN, AWAIT, NEUTRAL }

class StateInfo(val resident: String, val tone: Tone)

val STATE = mapOf(
    "RAISED" to StateInfo("Waiting to be checked", Tone.INFO),
    "VERIFIED" to StateInfo("Checked — passed to the office", Tone.INFO),
    "ASSIGNED" to StateInfo("Given to the contractor", Tone.INFO),
    "IN_PROGRESS" to StateInfo("Work under way", Tone.INFO),
    "WORK_COMPLETED" to StateInfo("Contractor says done — inspection due", Tone.AWAIT),
    "INSPECTED_ACCEPTED" to StateInfo("Inspected and accepted", Tone.OK),
    "CLOSED" to StateInfo("Closed", Tone.OK),
    "REJECTED" to StateInfo("Not accepted", Tone.NEUTRAL),
    "REWORK" to StateInfo("Sent back to the contractor", Tone.BAD),
    "REFERRED_SPECIAL_REPAIR" to StateInfo("Referred for special repair", Tone.NEUTRAL),
    "REOPENED" to StateInfo("Reopened", Tone.REOPEN),
)
fun stateOf(s: String?) = STATE[s] ?: StateInfo(s ?: "", Tone.INFO)

val OPEN_STATES = setOf("RAISED", "VERIFIED", "ASSIGNED", "IN_PROGRESS", "WORK_COMPLETED", "REWORK", "REOPENED")

@Composable @ReadOnlyComposable
fun toneColors(t: Tone): CpStatus {
    val s = LocalCpStatus.current
    return when (t) {
        Tone.OK -> s.resolved; Tone.RISK -> s.atRisk; Tone.BAD -> s.breached
        Tone.REOPEN -> s.reopened; Tone.AWAIT -> s.awaiting; Tone.INFO, Tone.NEUTRAL -> s.info
    }
}

/** The complaint against its deadline (verification + SLA); null once it is out of the open states or not yet verified. */
class Sla(val leftMinutes: Double, val fraction: Float, val tone: Tone)

fun deadlineSla(deadline: OffsetDateTime?, windowMinutes: Int?, state: String?, now: OffsetDateTime = OffsetDateTime.now()): Sla? {
    if (deadline == null || state !in OPEN_STATES) return null
    val left = Duration.between(now, deadline).seconds / 60.0
    val w = (windowMinutes ?: 0).toDouble()
    val tone = when { left < 0 -> Tone.BAD; w > 0 && left <= w * 0.25 -> Tone.RISK; else -> Tone.OK }
    val fraction = if (w > 0) (1 - left / w).coerceIn(0.0, 1.0) else if (left < 0) 1.0 else 0.5
    return Sla(left, fraction.toFloat(), tone)
}

/** "5h", "3d", or "+2h" once late. */
fun slaText(leftMinutes: Double): String {
    val h = abs(leftMinutes) / 60
    val v = if (h >= 48) "${(h / 24).roundToInt()}d" else "${maxOf(1, h.roundToInt())}h"
    return if (leftMinutes < 0) "+$v" else v
}

/* Dates in IST, as the department reads them. Locale.ENGLISH: en-GB writes "Sept". */
private val IST = ZoneId.of("Asia/Kolkata")
private val DAY = DateTimeFormatter.ofPattern("dd MMM yyyy", Locale.ENGLISH)
private val DAY_TIME = DateTimeFormatter.ofPattern("dd MMM yyyy, h:mm a", Locale.ENGLISH)
fun shortDate(t: OffsetDateTime?) = t?.atZoneSameInstant(IST)?.format(DAY) ?: ""
fun dayTime(t: OffsetDateTime?) = t?.atZoneSameInstant(IST)?.format(DAY_TIME) ?: ""

/** "3 h ago · 09 Oct 2026, 2:15 PM" — relative and absolute, as on the web. */
fun whenText(t: OffsetDateTime?, now: OffsetDateTime = OffsetDateTime.now()): String {
    if (t == null) return ""
    val m = Duration.between(t, now).toMinutes()
    val rel = when {
        m < 1 -> "just now"; m < 60 -> "$m min ago"; m < 48 * 60 -> "${m / 60} h ago"; else -> "${m / 1440} days ago"
    }
    return "$rel · ${dayTime(t)}"
}

/** Who each level of escalation reaches, in the words of the web's receipt. */
val ESCALATION_ROLE = mapOf(
    "CIVIL_OVERSEER" to "Civil Overseer", "MAINTENANCE_INCHARGE" to "Civil Colony Incharge",
    "STAFF_OFFICER_CIVIL" to "Area Civil Staff Officer", "GM_CIVIL" to "GM (Civil), HQ",
)

/**
 * One level of "If it is not fixed in time" (design experiment R1): alerted,
 * due now (its time has passed; the escalation sweep records it on its next
 * run), the time it is due, or not yet timed before verification. The same
 * wording as the web (`EscalationCard` in web/src/pages/Receipt.tsx).
 */
fun escalationLine(reached: Boolean, reachedAt: OffsetDateTime?, dueAt: OffsetDateTime?, now: OffsetDateTime = OffsetDateTime.now()): String = when {
    reached -> "Alerted ${dayTime(reachedAt)}"
    dueAt != null && !dueAt.isAfter(now) -> "Due now — time passed ${dayTime(dueAt)}"
    dueAt != null -> "If not fixed by ${dayTime(dueAt)}"
    else -> "Timed once the complaint is checked"
}

/** The moments of a complaint that say where it stands (from the complaint itself). */
class Moments(val raised: OffsetDateTime? = null, val verified: OffsetDateTime? = null, val assigned: OffsetDateTime? = null,
              val started: OffsetDateTime? = null, val claimed: OffsetDateTime? = null, val inspected: OffsetDateTime? = null,
              val closed: OffsetDateTime? = null)

/**
 * Where a complaint stands, for an officer, in one sentence: whose hands it is
 * in and since when, and what comes next (user's finding, 2026-10-15: after
 * assigning, the Overseer's phone showed no current status). `supervisor` and
 * `firm` come from the job card, which the officer may read.
 */
fun standing(state: String?, m: Moments, supervisor: String?, firm: String?, workmen: String?,
             now: OffsetDateTime = OffsetDateTime.now()): String {
    val who = listOfNotNull(supervisor, firm?.let { "($it)" }).joinToString(" ").ifBlank { "the contractor" }
    fun at(t: OffsetDateTime?) = whenText(t, now).substringBefore(" · ")
    return when (state) {
        "RAISED" -> "New, raised ${at(m.raised)}. Check it, then verify or reject."
        "VERIFIED" -> "Verified ${at(m.verified)}. Waiting to be assigned to a contractor supervisor."
        "REOPENED" -> "Reopened by the occupant. To be given back to a contractor supervisor."
        "ASSIGNED" -> "With $who since ${at(m.assigned)}. Work not started yet."
        "IN_PROGRESS" -> "Work under way since ${at(m.started)} — $who${workmen?.let { ". Workmen: $it" } ?: ""}."
        "REWORK" -> "Sent back for rework; with $who to redo."
        "WORK_COMPLETED" -> "$who says the work is done (${at(m.claimed)}). Waiting for your inspection on site."
            .replaceFirstChar { it.uppercase() }
        "INSPECTED_ACCEPTED" -> "Inspected and accepted ${at(m.inspected)}. Ready to close."
        "CLOSED" -> "Closed ${at(m.closed)}."
        "REJECTED" -> "Not accepted. The occupant has been told why."
        "REFERRED_SPECIAL_REPAIR" -> "Referred for special repair, with the Area Civil Staff Officer."
        else -> state ?: ""
    }
}

/** History events in the occupant's words. */
val EVENT_TITLE = mapOf(
    "RAISED" to "Complaint registered", "VERIFIED" to "Checked by the Overseer", "REJECTED" to "Not accepted",
    "ASSIGNED" to "Given to the contractor", "STARTED" to "Work started",
    "COMPLETION_CLAIMED" to "Contractor says the work is done", "INSPECTED" to "Inspected by the Overseer",
    "CLOSED" to "Closed", "REOPENED" to "Reopened", "REFERRED_SPECIAL_REPAIR" to "Referred for special repair",
    "REJECTION_CONTESTED" to "You contested the decision", "CONTEST_REINSTATED" to "Complaint reinstated after review",
    "CONTEST_UPHELD" to "Rejection upheld, sent to the Staff Officer",
    "REFERRED_TO_STAFF_OFFICER" to "Referred to the Area Civil Staff Officer",
    "STAFF_OFFICER_DECIDED" to "Decided by the Area Civil Staff Officer",
    "OCCUPANT_CONFIRMED" to "Occupant confirmed the work", "OCCUPANT_DISPUTED" to "Occupant says it is not fixed",
    "L4_REMARK_RECORDED" to "Staff Officer's remark recorded",
)
val ROLE_SHORT = mapOf(
    "RESIDENT" to "You / your household", "CUSTODIAN" to "Custodian", "CIVIL_OVERSEER" to "Civil Overseer",
    "MAINTENANCE_INCHARGE" to "Civil Colony Incharge", "CONTRACTOR_SUPERVISOR" to "Contractor",
    "STAFF_OFFICER_CIVIL" to "Staff Officer (Civil)", "SYSTEM" to "System",
)
fun eventTitle(type: String?, toState: String?): String = when {
    type == "INSPECTED" -> if (toState == "REWORK") "Sent back for rework" else "Inspected and accepted"
    type?.startsWith("CLOCK_PAUSED") == true -> "Clock paused"
    type?.startsWith("CLOCK_RESUMED") == true -> "Clock resumed"
    else -> EVENT_TITLE[type] ?: type ?: ""
}

/**
 * The contractor's own clock (decision 2026-09-25): only the time the job is
 * in their hands counts, summed over every round, against the SLA fixed at
 * verification. `minutes` is the closed rounds' total; `windowStartedAt` is
 * set while a round is running. Null where no SLA is fixed yet. The same rule
 * as the web (`contractorSla` in web/src/lib/domain.ts).
 */
class ContractorSla(val windowMinutes: Double, val usedMinutes: Double, val leftMinutes: Double,
                    val fraction: Float, val tone: Tone, val running: Boolean)

fun contractorSla(windowMinutes: Int?, minutes: Int?, windowStartedAt: OffsetDateTime?, state: String?,
                  completionMet: Boolean?, now: OffsetDateTime = OffsetDateTime.now()): ContractorSla? {
    val w = (windowMinutes ?: 0).toDouble()
    if (w <= 0) return null
    val running = windowStartedAt?.let { Duration.between(it, now).seconds / 60.0 } ?: 0.0
    val used = (minutes ?: 0) + running
    val left = w - used
    val tone = when (completionMet) {
        true -> Tone.OK; false -> Tone.BAD
        else -> if (left < 0) Tone.BAD else if (left <= w * 0.25) Tone.RISK else Tone.OK
    }
    return ContractorSla(w, used, left, (used / w).coerceIn(0.0, 1.0).toFloat(), tone, windowStartedAt != null)
}

/** Photographs of one purpose taken in this round (from `roundStart`); one with no time recorded counts, as on the web. */
fun roundCount(media: List<Pair<String?, OffsetDateTime?>>, purpose: String, roundStart: OffsetDateTime?): Int =
    media.count { (p, at) -> p == purpose && (roundStart == null || at == null || !at.isBefore(roundStart)) }

/** "3 h 20 min", for the contractor's time used and window. */
fun hoursText(minutes: Double): String {
    val m = abs(minutes).roundToInt()
    return when { m < 60 -> "$m min"; m % 60 == 0 || m >= 48 * 60 -> "${m / 60} h"; else -> "${m / 60} h ${m % 60} min" }
}
