package `in`.ncl.civilportal.overseer

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.fragment.app.FragmentActivity
import `in`.ncl.civilportal.api.maintenance.models.DevicesAssignableGet200ResponseInner
import `in`.ncl.civilportal.api.maintenance.models.InspectionsQueueGet200Response
import `in`.ncl.civilportal.api.maintenance.models.JobCard
import `in`.ncl.civilportal.api.maintenance.models.JobCardLifecycleRoundsInner
import `in`.ncl.civilportal.api.maintenance.models.JobRoundEvent
import `in`.ncl.civilportal.ui.Moments
import `in`.ncl.civilportal.ui.standing
import `in`.ncl.civilportal.api.maintenance.models.Ticket
import `in`.ncl.civilportal.ui.shortDate
import `in`.ncl.civilportal.ui.theme.CpTokens
import `in`.ncl.civilportal.api.maintenance.models.TicketDetail
import `in`.ncl.civilportal.api.maintenance.models.TicketsIdMaterialsGet200Response
import `in`.ncl.civilportal.photo.CameraScreen
import `in`.ncl.civilportal.photo.Gallery
import `in`.ncl.civilportal.photo.Shot
import `in`.ncl.civilportal.photo.ShotReview
import `in`.ncl.civilportal.ui.AppModel
import `in`.ncl.civilportal.ui.AutoRefresh
import `in`.ncl.civilportal.ui.CardBox
import `in`.ncl.civilportal.ui.Loading
import `in`.ncl.civilportal.ui.Muted
import `in`.ncl.civilportal.ui.Note
import `in`.ncl.civilportal.ui.Primary
import `in`.ncl.civilportal.ui.ProfileScreen
import `in`.ncl.civilportal.ui.Secondary
import `in`.ncl.civilportal.ui.SectionLabel
import `in`.ncl.civilportal.ui.Shell
import `in`.ncl.civilportal.ui.StatusChip
import `in`.ncl.civilportal.ui.Tone
import `in`.ncl.civilportal.ui.contractorSla
import `in`.ncl.civilportal.ui.eventTitle
import `in`.ncl.civilportal.ui.hoursText
import `in`.ncl.civilportal.ui.roundCount
import `in`.ncl.civilportal.ui.toneColors
import `in`.ncl.civilportal.ui.whenText
import kotlinx.coroutines.launch
import java.util.UUID

/* The Civil Overseer's app: the inspection that only a phone can record
   (phase A4, control 1), and since 2026-10-15, at the user's request, the
   pending work of the web's Today page too — verify or reject, assign and
   reassign, close — so a complaint moves while the Overseer is on site.
   Which buttons appear is the server's answer (available_actions); the rest
   of the Overseer's work (materials, pauses, objections) stays on the web. */

private sealed interface O {
    data object Queue : O
    data object Profile : O
    data class Job(val id: UUID) : O
}

@Composable
fun OverseerApp(model: AppModel, activity: FragmentActivity) {
    val repo = remember { OverseerRepository(model.graph.portal, model.graph.photos) }
    val stack = remember { mutableStateListOf<O>(O.Queue) }
    // the tab survives opening a complaint and coming back
    var tab by remember { mutableStateOf(Tab.TODAY) }
    val back: () -> Unit = { if (stack.size > 1) stack.removeAt(stack.lastIndex) }
    BackHandler(enabled = stack.size > 1, onBack = back)
    when (val top = stack.last()) {
        O.Queue -> Queue(repo, tab, { tab = it }) { stack.add(it) }
        O.Profile -> ProfileScreen(model, activity, back)
        is O.Job -> JobScreen(repo, top.id, back)
    }
}

private val STATE_LABEL = mapOf(
    "RAISED" to ("New — to verify" to Tone.INFO), "VERIFIED" to ("Verified — to assign" to Tone.AWAIT),
    "ASSIGNED" to ("With the contractor" to Tone.INFO), "REJECTED" to ("Not accepted" to Tone.BAD),
    "WORK_COMPLETED" to ("Awaiting inspection" to Tone.AWAIT), "INSPECTED_ACCEPTED" to ("Inspected — to close" to Tone.OK),
    "REWORK" to ("Sent back to the contractor" to Tone.BAD), "CLOSED" to ("Closed" to Tone.OK),
    "REOPENED" to ("Reopened" to Tone.REOPEN), "IN_PROGRESS" to ("Work under way" to Tone.INFO),
    "REFERRED_SPECIAL_REPAIR" to ("Special repair" to Tone.AWAIT),
)

/* ------------------------------------------------------------------ today, open, completed */
/* Three tabs (user's request, 2026-10-15, "the app needs to be more useful"):
   Today — what waits for him; Open — every live complaint of the Area by
   stage, so he can see where each stands; Completed — closed work, newest
   first, until it leaves the working screens 30 days after closure. */
private enum class Tab { TODAY, OPEN, DONE }

private class Today(val all: List<Ticket>, val verify: List<Ticket>, val assign: List<Ticket>, val reassign: List<Ticket>,
                    val inspect: InspectionsQueueGet200Response, val close: List<Ticket>) {
    val total get() = verify.size + assign.size + reassign.size + (inspect.items?.size ?: 0) + close.size
    val open get() = all.filter { it.state?.value !in setOf("CLOSED", "REJECTED") }
    val done get() = all.filter { it.state?.value == "CLOSED" }.sortedByDescending { it.closedAt }
}

/** Every live complaint by stage, in the order the work moves. */
private val STAGES = listOf(
    "New — to verify" to setOf("RAISED"), "To assign" to setOf("VERIFIED", "REOPENED"),
    "With the contractor" to setOf("ASSIGNED", "IN_PROGRESS", "REWORK"), "Awaiting inspection" to setOf("WORK_COMPLETED"),
    "Inspected — to close" to setOf("INSPECTED_ACCEPTED"), "Referred for special repair" to setOf("REFERRED_SPECIAL_REPAIR"))

@Composable
private fun Queue(repo: OverseerRepository, tab: Tab, setTab: (Tab) -> Unit, go: (O) -> Unit) {
    var d by remember { mutableStateOf<Today?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var tick by remember { mutableIntStateOf(0) }
    AutoRefresh { tick++ }
    LaunchedEffect(tick) {
        runCatching {
            val list = repo.complaints()
            fun Ticket.can(a: String) = availableActions.orEmpty().contains(a)
            // the same sections and sorting as the web's Today page
            d = Today(all = list,
                verify = list.filter { it.state?.value == "RAISED" && it.can("verify") }.sortedBy { it.raisedAt },
                assign = list.filter { it.state?.value in setOf("VERIFIED", "REOPENED") && it.can("assign") && it.assigneeRoleEnded != true },
                reassign = list.filter { it.assigneeRoleEnded == true && it.can("assign") },
                inspect = repo.queue(),
                close = list.filter { it.state?.value == "INSPECTED_ACCEPTED" && it.can("close") && it.l4RemarkNeeded != true })
            error = null
        }.onFailure { error = it.message }
    }
    val x = d
    val (title, sub) = when (tab) {
        Tab.TODAY -> "Today${x?.let { " · ${it.total}" } ?: ""}" to "What waits for you"
        Tab.OPEN -> "Open${x?.let { " · ${it.open.size}" } ?: ""}" to "Every live complaint, by stage"
        Tab.DONE -> "Completed${x?.let { " · ${it.done.size}" } ?: ""}" to "Closed in the last 30 days"
    }
    Shell(title, sub, actions = {
        IconButton({ go(O.Profile) }) { Icon(Icons.Filled.Person, "Profile and roles", tint = Color.White) }
    }) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf(Tab.TODAY to "Today${x?.let { " · ${it.total}" } ?: ""}", Tab.OPEN to "Open${x?.let { " · ${it.open.size}" } ?: ""}",
                Tab.DONE to "Completed${x?.let { " · ${it.done.size}" } ?: ""}").forEach { (t, l) ->
                FilterChip(tab == t, { setTab(t) }, label = { Text(l) })
            }
        }
        error?.let { Note(it, error = true) }
        if (x == null) { if (error == null) Loading(); return@Shell }
        if (tab == Tab.OPEN) {
            if (x.open.isEmpty()) CardBox { Text("No live complaints", fontWeight = FontWeight.SemiBold) }
            STAGES.forEach { (stage, states) ->
                val rows = x.open.filter { it.state?.value in states }
                Group(stage, rows.size, "") { rows.forEach { t -> TaskCard(t, rowLine(t), alarm = t.assigneeRoleEnded == true) { t.id?.let { go(O.Job(it)) } } } }
            }
            return@Shell
        }
        if (tab == Tab.DONE) {
            if (x.done.isEmpty()) CardBox { Text("Nothing closed in the last 30 days", fontWeight = FontWeight.SemiBold)
                Muted("Older complaints are in Search on the web portal.") }
            x.done.forEach { t -> TaskCard(t, rowLine(t), lateTone = t.completionMet == false) { t.id?.let { go(O.Job(it)) } } }
            if (x.done.isNotEmpty()) Muted("Older complaints are in Search on the web portal.")
            return@Shell
        }
        if (x.total == 0) CardBox { Text("Nothing waiting for you", fontWeight = FontWeight.SemiBold)
            Muted("New complaints to verify, work to assign, claims to inspect and complaints to close appear here.") }

        Group("To verify", x.verify.size, "oldest first") {
            x.verify.forEach { t -> TaskCard(t, "Raised ${whenText(t.raisedAt)}") { t.id?.let { go(O.Job(it)) } } }
        }
        Group("To assign", x.assign.size, "for a contractor supervisor") {
            x.assign.forEach { t -> TaskCard(t, if (t.state?.value == "REOPENED") "Reopened — to be given back"
                else "Verified · due ${shortDate(t.completionDeadlineAt)}") { t.id?.let { go(O.Job(it)) } } }
        }
        Group("To reassign", x.reassign.size, "the supervisor's role has ended", alarm = true) {
            x.reassign.forEach { t -> TaskCard(t, "Supervisor's role has ended — reassign", alarm = true) { t.id?.let { go(O.Job(it)) } } }
        }
        val items = x.inspect.items.orEmpty()
        Group("To inspect", items.size, "in the department's order") {
            x.inspect.oldestPendingHours?.let { h -> if (h.toDouble() >= 48) CardBox {
                Text("Oldest waiting ${h.toInt()} h", color = toneColors(Tone.BAD).fg, fontWeight = FontWeight.SemiBold)
                Muted("Inspections waiting over 48 hours are flagged to the Incharge.")
            } }
            InspectRows(items, go)
        }
        Group("To close", x.close.size, "inspected and accepted") {
            x.close.forEach { t -> TaskCard(t, "Inspected and accepted — to close") { t.id?.let { go(O.Job(it)) } } }
        }
        Muted("Materials, clock pauses, objections and the rest of your work are on the web portal.")
    }
}

/** One section of Today; nothing at all when it is empty. */
@Composable
private fun Group(title: String, n: Int, hint: String, alarm: Boolean = false, rows: @Composable () -> Unit) {
    if (n == 0) return
    Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
        Text("$title · $n", fontWeight = FontWeight.SemiBold, fontSize = 16.sp,
            color = if (alarm) toneColors(Tone.BAD).fg else MaterialTheme.colorScheme.onSurface)
        Muted(hint)
    }
    rows()
}

@Composable
private fun TaskCard(t: Ticket, line: String, alarm: Boolean = false, lateTone: Boolean = false, onClick: () -> Unit) = CardBox(onClick = onClick) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("${t.identifier ?: ""} · ${t.subCategory ?: ""}", fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
        val (lbl, tone) = STATE_LABEL[t.state?.value] ?: ((t.state?.value ?: "") to Tone.NEUTRAL)
        StatusChip(lbl, tone)
    }
    Muted(t.ticketNo ?: "")
    if (t.isEmergency == true) StatusChip("Emergency", Tone.BAD)
    Text(line, fontSize = 13.sp, color = when { alarm || lateTone -> toneColors(Tone.BAD).fg; else -> MaterialTheme.colorScheme.onSurfaceVariant },
        fontWeight = if (alarm) FontWeight.SemiBold else FontWeight.Normal)
}

/** One line under a complaint in Open and Completed: the step it is at and when. */
private fun rowLine(t: Ticket): String = when (t.state?.value) {
    "RAISED" -> "Raised ${whenText(t.raisedAt)}"
    "VERIFIED" -> "Verified · due ${shortDate(t.completionDeadlineAt)}"
    "REOPENED" -> "Reopened — to be given back"
    "ASSIGNED" -> if (t.assigneeRoleEnded == true) "Supervisor's role has ended — reassign" else "Assigned ${whenText(t.assignedAt)} · not started"
    "IN_PROGRESS" -> "Started ${whenText(t.startedAt)}"
    "REWORK" -> "Sent back for rework ${whenText(t.inspectedAt)}"
    "WORK_COMPLETED" -> "Claimed done ${whenText(t.completedClaimAt)}"
    "INSPECTED_ACCEPTED" -> "Accepted ${whenText(t.inspectedAt)}"
    "CLOSED" -> "Closed ${shortDate(t.closedAt)} · " + when (t.completionMet) { true -> "contractor on time"; false -> "contractor late"; null -> "no SLA judged" }
    else -> ""
}

/** The inspection queue, numbered in the department's order exactly as the server gives it (control 8). */
@Composable
private fun InspectRows(items: List<Ticket>, go: (O) -> Unit) {
        items.forEachIndexed { i, t ->
            CardBox(onClick = { t.id?.let { go(O.Job(it)) } }) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("${i + 1}", fontWeight = FontWeight.Bold, fontSize = 18.sp, color = toneColors(Tone.INFO).fg)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text("${t.identifier ?: ""} · ${t.subCategory ?: ""}", fontWeight = FontWeight.SemiBold)
                        Muted(listOfNotNull(t.ticketNo, t.waitingHours?.let { "claimed $it h ago" }).joinToString(" · "))
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            if (t.isEmergency == true) StatusChip("Emergency", Tone.BAD)
                            if (t.inspectionPriority != null) StatusChip("Priority ${t.inspectionPriority}", Tone.RISK)
                            if ((t.objectionCount ?: 0) > 0) StatusChip("Objection", Tone.REOPEN)
                        }
                        t.inspectionPriorityNote?.let { Muted("“$it”") }
                    }
                }
            }
        }
}

/* ------------------------------------------------------------------ one job */
@Composable
private fun JobScreen(repo: OverseerRepository, id: UUID, back: () -> Unit) {
    val scope = rememberCoroutineScope()
    var t by remember { mutableStateOf<TicketDetail?>(null) }
    var mats by remember { mutableStateOf<TicketsIdMaterialsGet200Response?>(null) }
    var load by remember { mutableIntStateOf(0) }
    var error by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var remark by remember { mutableStateOf("") }
    var sendingBack by remember { mutableStateOf(false) }
    var confirm by remember { mutableStateOf<String?>(null) }   // "accept", "close" or "verify"
    var rejecting by remember { mutableStateOf(false) }
    var reason by remember { mutableStateOf("") }
    var sups by remember { mutableStateOf<List<DevicesAssignableGet200ResponseInner>?>(null) }
    var pick by remember { mutableStateOf<DevicesAssignableGet200ResponseInner?>(null) }
    var reassigning by remember { mutableStateOf(false) }
    var card by remember { mutableStateOf<JobCard?>(null) }
    var shooting by remember { mutableStateOf(false) }
    var taken by remember { mutableStateOf<Shot?>(null) }
    var photoError by remember { mutableStateOf<String?>(null) }

    // never while something is being chosen or written
    AutoRefresh { if (!busy && !shooting && confirm == null && !sendingBack && !rejecting && pick == null && reason.isBlank()) load++ }
    LaunchedEffect(load) {
        runCatching {
            t = repo.job(id); mats = runCatching { repo.materials(id) }.getOrNull()
            // the job card exists from the first assignment
            card = if (t?.state?.value in setOf("RAISED", "VERIFIED", "REJECTED")) null else runCatching { repo.jobCard(id) }.getOrNull()
            error = null
        }
            .onFailure { error = it.message }
    }
    fun act(ok: String, block: suspend () -> Unit) = scope.launch {
        busy = true; error = null
        runCatching { block() }
            .onSuccess { notice = ok; remark = ""; reason = ""; sendingBack = false; rejecting = false; reassigning = false; pick = null; sups = null; load++ }
            .onFailure { error = it.message }
        busy = false
    }

    if (shooting) {
        val shot = taken
        if (shot == null) CameraScreen("Inspection — ${t?.identifier ?: ""}", { taken = it; photoError = null }, { shooting = false })
        else ShotReview("Inspection photograph — check it", shot, busy, photoError,
            send = { scope.launch {
                busy = true; photoError = null
                runCatching { repo.photograph(id, shot) }
                    .onSuccess { taken = null; shooting = false; notice = "Inspection photograph sent"; load++ }
                    .onFailure { photoError = it.message }
                busy = false
            } },
            retake = { taken = null; photoError = null },
            cancel = { taken = null; shooting = false; photoError = null })
        BackHandler { if (!busy) { taken = null; shooting = false } }
        return
    }

    val c = t
    Shell(c?.ticketNo ?: "Complaint", c?.subCategory, onBack = back) {
        if (c == null) { error?.let { Note(it, error = true) } ?: Loading(); return@Shell }
        val state = c.state?.value
        val (lbl, tone) = STATE_LABEL[state] ?: ((state ?: "") to Tone.NEUTRAL)
        CardBox {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Column(Modifier.weight(1f)) {
                    Text(c.identifier ?: "", fontWeight = FontWeight.Bold, fontSize = 18.sp)
                    Muted(listOfNotNull(c.category, c.quarterType?.let { "Type $it" }).joinToString(" · "))
                }
                StatusChip(lbl, tone)
            }
            c.description?.let { Text(it) }
            if (c.isEmergency == true) StatusChip("Emergency", Tone.BAD)
            c.workmenAssigned?.let { Muted("Workmen: $it") }
            c.completedClaimAt?.let { Muted("Claimed complete ${whenText(it)}") }
            contractorSla(c.slaCompletionMinutes, c.contractorMinutes, c.contractorWindowStartedAt, state, c.completionMet)?.let { s ->
                Muted("Contractor's time: ${hoursText(s.usedMinutes)} of ${hoursText(s.windowMinutes)}${if (s.leftMinutes < 0) " — late" else ""}")
            }
        }
        notice?.let { CardBox { Text(it, color = toneColors(Tone.OK).fg) } }
        // where it stands now: whose hands it is in, since when, what comes next
        val round = card?.lifecycle?.rounds?.lastOrNull()
        CardBox {
            Muted("Where it stands")
            Text(standing(state, Moments(c.raisedAt, c.verifiedAt, c.assignedAt, c.startedAt, c.completedClaimAt, c.inspectedAt, c.closedAt),
                round?.supervisorName ?: card?.ticket?.supervisorName, card?.ticket?.contractorName, c.workmenAssigned),
                fontWeight = FontWeight.SemiBold)
            if (c.completionDeadlineAt != null && state !in setOf("CLOSED", "REJECTED")) Muted("SLA deadline: ${whenText(c.completionDeadlineAt)}")
        }
        if ((c.objectionCount ?: 0) > 0) CardBox {
            Text("The occupant objected during the work", color = toneColors(Tone.REOPEN).fg, fontWeight = FontWeight.SemiBold)
            c.objections.orEmpty().forEach { o -> Muted("“${o.note ?: ""}” — ${if (o.respondedAt != null) "answered" else "not yet answered"}") }
        }

        val acts = c.availableActions.orEmpty()
        if ("verify" in acts || "reject" in acts) {
            SectionLabel("Check the complaint")
            if (!rejecting) {
                if ("verify" in acts) Primary(if (busy) "Saving…" else "Verify complaint", enabled = !busy) { confirm = "verify" }
                if ("reject" in acts) Secondary("Reject", enabled = !busy) { rejecting = true; error = null }
            } else CardBox {
                Text("Reject this complaint", fontWeight = FontWeight.SemiBold)
                Muted("The occupant sees your reason, and may contest it once.")
                OutlinedTextField(reason, { reason = it.take(500) }, Modifier.fillMaxWidth().heightIn(min = 100.dp),
                    placeholder = { Text("Why it is not taken up") })
                Primary(if (busy) "Saving…" else "Reject complaint", enabled = !busy && reason.trim().length >= 3) {
                    act("Complaint rejected — the occupant is told why") { repo.reject(id, reason) }
                }
                TextButton({ rejecting = false; reason = "" }, enabled = !busy) { Text("Cancel") }
            }
        }
        // a job already with a supervisor is reassigned only on purpose: the form stays
        // folded away unless the supervisor's role has ended (user's finding, 2026-10-15)
        val firstGiving = state in setOf("VERIFIED", "REOPENED") || c.assigneeRoleEnded == true
        if ("assign" in acts && !firstGiving && !reassigning)
            TextButton({ reassigning = true; error = null }, enabled = !busy) { Text("Give it to another supervisor…") }
        if ("assign" in acts && (firstGiving || reassigning)) {
            // giving out again a job already given (not one back from verification or a reopening) needs a reason
            val again = state !in setOf("VERIFIED", "REOPENED")
            LaunchedEffect(c.id) { if (sups == null) runCatching { sups = repo.supervisors() }.onFailure { error = it.message } }
            SectionLabel(if (again) "Reassign the work" else "Assign the work")
            CardBox {
                if (c.assigneeRoleEnded == true) Text("The supervisor's role has ended. Nobody can start or finish this job until it is reassigned.",
                    color = toneColors(Tone.BAD).fg, fontWeight = FontWeight.SemiBold)
                Muted("Contractor supervisors of this Area, with their open jobs.")
                val list = sups
                if (list == null) Loading() else if (list.isEmpty()) Muted("No active contractor supervisor in this Area.")
                list.orEmpty().forEach { sp ->
                    val on = pick?.actorId == sp.actorId
                    Row(Modifier.fillMaxWidth().heightIn(min = 52.dp)
                        .border(if (on) 2.dp else 1.dp, if (on) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant,
                            RoundedCornerShape(CpTokens.radiusInput))
                        .clickable(enabled = !busy) { pick = sp }.padding(horizontal = 8.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically) {
                        RadioButton(on, { pick = sp }, enabled = !busy)
                        Column(Modifier.weight(1f)) {
                            Text(sp.personName ?: "Supervisor", fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal)
                            sp.contractorName?.let { Muted(it) }
                        }
                        Muted("${sp.openJobs ?: 0} open")
                    }
                }
                if (reassigning) TextButton({ reassigning = false; pick = null; reason = "" }, enabled = !busy) { Text("Cancel") }
                if (again) OutlinedTextField(reason, { reason = it.take(300) }, Modifier.fillMaxWidth(),
                    label = { Text("Reason for reassigning") }, placeholder = { Text("e.g. The supervisor has left the contract") })
                val who = pick
                Primary(if (busy) "Assigning…" else who?.let { "Assign to ${it.personName ?: "the supervisor"}" } ?: "Choose a supervisor",
                    enabled = !busy && who?.actorId != null && (!again || reason.isNotBlank())) {
                    act("Work assigned to ${who?.personName ?: "the supervisor"}") { repo.assign(id, who!!.actorId!!, if (again) reason else null) }
                }
            }
        }

        if (state == "WORK_COMPLETED") {
            // the inspecting Overseer's own photograph, taken after this claim (control 2);
            // compulsory only once the HQ System Administrator requires it (2026-10-12)
            val mine = roundCount(c.media.orEmpty().map { it.purpose to it.capturedAt }, "INSPECTION", c.completedClaimAt ?: c.contractorWindowStartedAt)
            val needed = c.photoRules?.inspectionPhotoRequired != false
            SectionLabel("Inspect on site")
            CardBox {
                Text(if (mine > 0) "$mine inspection photograph${if (mine > 1) "s" else ""} taken" else "Inspection photograph", fontWeight = FontWeight.SemiBold)
                Muted(if (needed) "Required before accepting: taken here, now, with the location."
                      else "Optional for now; if you take one, it is taken here, now, with the location.")
                if (mine < 3) Secondary(if (mine == 0) "Take the inspection photograph" else "Take another", enabled = !busy) { shooting = true }
            }
            val ready = !needed || mine > 0
            if (!sendingBack) {
                Primary(if (busy) "Saving…" else "Inspect and accept", enabled = !busy && ready) { confirm = "accept" }
                if (!ready) Text("Take the inspection photograph first.", color = toneColors(Tone.RISK).fg, fontSize = 13.sp)
                Secondary("Send back for rework", enabled = !busy) { sendingBack = true; error = null }
            } else CardBox {
                Text("Send back for rework", fontWeight = FontWeight.SemiBold)
                Muted("The contractor sees your remark; their clock runs again, and the job counts as rework.")
                OutlinedTextField(remark, { remark = it.take(500) }, Modifier.fillMaxWidth().heightIn(min = 100.dp),
                    placeholder = { Text("What is not done properly") })
                Primary(if (busy) "Sending…" else "Send back", enabled = !busy && remark.isNotBlank()) {
                    act("Sent back to the contractor") { repo.sendBack(id, remark) }
                }
                TextButton({ sendingBack = false }, enabled = !busy) { Text("Cancel") }
            }
        }
        if (state == "INSPECTED_ACCEPTED") {
            if (c.l4RemarkNeeded == true) CardBox {
                Text("This complaint reached the GM (level 4). It can be closed only after the Area Civil Staff Officer records a remark.",
                    color = toneColors(Tone.RISK).fg)
            } else Primary(if (busy) "Closing…" else "Close complaint", enabled = !busy) { confirm = "close" }
            Muted("The occupant may still say it is not fixed; that reopens the complaint.")
        }
        error?.let { Note(it, error = true) }

        card?.lifecycle?.rounds?.takeIf { it.isNotEmpty() }?.let { rounds ->
            SectionLabel("Life of the job · ${rounds.size} round${if (rounds.size > 1) "s" else ""}")
            rounds.forEach { RoundCard(it) }
        }
        mats?.items?.takeIf { it.isNotEmpty() }?.let { lines ->
            SectionLabel("Materials claimed")
            CardBox {
                lines.forEach { l ->
                    Text("${l.nameEn ?: l.code} — ${l.qtyClaimed?.stripTrailingZeros()?.toPlainString()} ${l.unit ?: ""}",
                        textDecoration = if (l.withdrawnAt != null) TextDecoration.LineThrough else null)
                    l.qtyVerified?.let { Muted("Verified: ${it.stripTrailingZeros().toPlainString()} ${l.unit ?: ""}") }
                }
                Muted("Verify the quantities on the web portal (Materials, in the complaint panel).")
            }
        }
        SectionLabel("History")
        CardBox {
            c.history.orEmpty().forEach { h ->
                Column(Modifier.padding(vertical = 4.dp)) {
                    Text(eventTitle(h.eventType, h.toState), fontWeight = FontWeight.SemiBold)
                    Muted(listOfNotNull(h.actorRole?.let { WHO[it] ?: it }, h.reason?.let { "“$it”" }).joinToString(" — "))
                    Muted(whenText(h.occurredAt))
                }
            }
        }
        if (!c.media.isNullOrEmpty()) {
            SectionLabel("Photographs")
            Gallery(repo.portal, c.media!!)
        }
    }

    confirm?.let { what ->
        AlertDialog(
            onDismissRequest = { confirm = null },
            title = { Text(when (what) { "accept" -> "Accept the work?"; "verify" -> "Verify the complaint?"; else -> "Close the complaint?" }) },
            text = { Text(when (what) {
                "accept" -> "You inspected it on site and the work is done properly. This records your inspection; the contractor's clock stays stopped."
                "verify" -> "It is a genuine maintenance fault within the contract. The SLA is fixed now, from the SLA table, and cannot be changed afterwards."
                else -> "The complaint is closed. The occupant can still reopen it within 24 hours." }) },
            confirmButton = { TextButton({ confirm = null
                when (what) {
                    "accept" -> act("Inspected and accepted") { repo.accept(id, null) }
                    "verify" -> act("Complaint verified — SLA fixed. Assign it below.") { repo.verify(id) }
                    else -> act("Complaint closed") { repo.close(id) }
                } }) {
                Text(when (what) { "accept" -> "Accept"; "verify" -> "Verify"; else -> "Close it" }) } },
            dismissButton = { TextButton({ confirm = null }) { Text("Not yet") } })
    }
}

private val WHO = mapOf("RESIDENT" to "Occupant", "CUSTODIAN" to "Custodian", "CIVIL_OVERSEER" to "Civil Overseer",
    "MAINTENANCE_INCHARGE" to "Civil Colony Incharge", "CONTRACTOR_SUPERVISOR" to "Contractor",
    "STAFF_OFFICER_CIVIL" to "Staff Officer (Civil)", "SYSTEM" to "System")

/** One round of the job, from the job card: what began it, who did the work, the inspection, the occupant's answers. */
@Composable
private fun RoundCard(r: JobCardLifecycleRoundsInner) = CardBox {
    val cause = r.cause
    Text("Round ${r.n ?: ""} — " + when (cause?.type) {
        JobRoundEvent.Type.SENT_BACK -> "sent back by the Overseer"
        JobRoundEvent.Type.REOPENED -> "reopened by the occupant"
        else -> "assigned"
    } + (cause?.at?.let { ", ${whenText(it)}" } ?: ""), fontWeight = FontWeight.SemiBold)
    (cause?.reason ?: cause?.remark)?.let { Muted("“$it”") }
    r.supervisorName?.let { Muted("Supervisor: $it") }
    Muted(r.startedAt?.let { "Started ${whenText(it)}" + (r.workmen?.let { w -> " · workmen: $w" } ?: "") } ?: "Not started")
    r.materials?.filter { it.withdrawn != true }?.takeIf { it.isNotEmpty() }?.let { m -> Muted("Materials claimed: ${m.size} line${if (m.size > 1) "s" else ""}") }
    r.photos?.let { p -> if ((p.before ?: 0) + (p.after ?: 0) > 0) Muted("Photographs: ${p.before ?: 0} before, ${p.after ?: 0} after") }
    r.claimedAt?.let { Muted("Claimed done ${whenText(it)}") }
    r.inspection?.let { i ->
        if (i.result == JobRoundEvent.Result.SENT_BACK)
            Text("Sent back ${whenText(i.at)}${i.remark?.let { " — “$it”" } ?: ""}", color = toneColors(Tone.BAD).fg, fontSize = 13.sp)
        else Text("Inspected and accepted ${whenText(i.at)}", color = toneColors(Tone.OK).fg, fontSize = 13.sp)
    }
    r.closedAt?.let { Muted("Closed ${whenText(it)}") }
    r.feedback.orEmpty().forEach { f ->
        val ok = f.confirmed == true
        Text((if (ok) "Occupant satisfied" else if (f.confirmed == false) "Occupant not satisfied" else "Occupant did not answer") +
            (f.rating?.let { " · $it/5" } ?: "") + (f.comment?.let { " — “$it”" } ?: ""),
            color = toneColors(if (ok) Tone.OK else Tone.REOPEN).fg, fontSize = 13.sp)
    }
    r.reopened?.let { Text("Reopened ${whenText(it.at)}${it.reason?.let { w -> " — “$w”" } ?: ""}", color = toneColors(Tone.REOPEN).fg, fontSize = 13.sp) }
}
