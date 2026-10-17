package `in`.ncl.civilportal.contractor

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.runtime.saveable.rememberSaveable
import `in`.ncl.civilportal.ui.shortDate
import androidx.fragment.app.FragmentActivity
import `in`.ncl.civilportal.api.maintenance.models.Material
import `in`.ncl.civilportal.api.maintenance.models.MaterialLine
import `in`.ncl.civilportal.api.maintenance.models.TicketDetail
import `in`.ncl.civilportal.api.maintenance.models.TicketsIdMaterialsGet200Response
import `in`.ncl.civilportal.api.maintenance.models.TicketsIdMeasurementsGet200ResponseItemsInner
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
import `in`.ncl.civilportal.ui.SlaRing
import `in`.ncl.civilportal.ui.StatusChip
import `in`.ncl.civilportal.ui.Tone
import `in`.ncl.civilportal.ui.contractorSla
import `in`.ncl.civilportal.ui.eventTitle
import `in`.ncl.civilportal.ui.hoursText
import `in`.ncl.civilportal.ui.roundCount
import `in`.ncl.civilportal.ui.slaText
import `in`.ncl.civilportal.ui.theme.CpTokens
import `in`.ncl.civilportal.ui.toneColors
import `in`.ncl.civilportal.ui.whenText
import kotlinx.coroutines.launch
import java.math.BigDecimal
import java.util.UUID

/* The contractor supervisor's app (design C1–C2, phase A3). The ring is the
   contractor's own clock: time the job has been in their hands, summed over
   every round, against the SLA (decision 2026-09-25). They see no occupant's
   phone number, no objection and no dispute — the server leaves them out. */

private sealed interface C {
    data object Jobs : C
    data object Profile : C
    data class Job(val id: UUID) : C
}

@Composable
fun ContractorApp(model: AppModel, activity: FragmentActivity, firm: Boolean = false) {
    val repo = remember { ContractorRepository(model.graph.portal, model.graph.photos) }
    // the firm's own role reads every job of its contract and changes nothing;
    // who holds each job is named from its supervisors (row security: its contract)
    var names by remember { mutableStateOf<Map<UUID, String>>(emptyMap()) }
    if (firm) LaunchedEffect(Unit) { runCatching { names = repo.supervisors() } }
    val stack = remember { mutableStateListOf<C>(C.Jobs) }
    val back: () -> Unit = { if (stack.size > 1) stack.removeAt(stack.lastIndex) }
    BackHandler(enabled = stack.size > 1, onBack = back)
    when (val top = stack.last()) {
        C.Jobs -> Jobs(repo, firm, names) { stack.add(it) }
        C.Profile -> ProfileScreen(model, activity, back)
        is C.Job -> JobScreen(repo, top.id, back, firm, names)
    }
}

/* The state as the contractor reads it — the web's officer labels (web/src/lib/domain.ts). */
private val LABEL = mapOf(
    "ASSIGNED" to ("Assigned — to start" to Tone.INFO), "IN_PROGRESS" to ("Work under way" to Tone.INFO),
    "REWORK" to ("Sent back — rework" to Tone.BAD), "WORK_COMPLETED" to ("Awaiting inspection" to Tone.AWAIT),
    "INSPECTED_ACCEPTED" to ("Inspected and accepted" to Tone.OK), "CLOSED" to ("Closed" to Tone.OK),
)
private fun label(s: String?) = LABEL[s] ?: ((s ?: "") to Tone.NEUTRAL)

private val GROUPS = listOf("Sent back — rework" to "REWORK", "To start" to "ASSIGNED",
    "In progress" to "IN_PROGRESS", "Awaiting inspection" to "WORK_COMPLETED")

private fun sla(t: TicketDetail) = contractorSla(t.slaCompletionMinutes, t.contractorMinutes, t.contractorWindowStartedAt,
    t.state?.value, t.completionMet)

/* ------------------------------------------------------------------ jobs (C1) */
@Composable
private fun Jobs(repo: ContractorRepository, firm: Boolean, names: Map<UUID, String>, go: (C) -> Unit) {
    var jobs by remember { mutableStateOf<List<TicketDetail>?>(null) }
    var done by remember { mutableStateOf<List<`in`.ncl.civilportal.api.maintenance.models.Ticket>?>(null) }
    var showDone by rememberSaveable { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var tick by remember { mutableIntStateOf(0) }
    AutoRefresh { tick++ }
    LaunchedEffect(tick) {
        runCatching { repo.jobs() }
            // most urgent first: least of the contractor's own time left
            .onSuccess { l -> jobs = l.sortedBy { sla(it)?.leftMinutes ?: Double.MAX_VALUE }; error = null }
            .onFailure { error = it.message }
        runCatching { done = repo.completed() }
    }
    val active = jobs?.count { it.state?.value != "WORK_COMPLETED" } ?: 0
    Shell(if (showDone) "Completed · ${done?.size ?: 0}" else if (firm) "Our jobs · $active" else "Today’s jobs · $active",
          if (showDone) "Accepted or closed, newest first" else if (firm) "Every job of the contract · read only" else "Sorted by your time left", actions = {
        IconButton({ go(C.Profile) }) { Icon(Icons.Filled.Person, "Profile and roles", tint = Color.White) }
    }) {
        // the work finished stays in view (user's request, 2026-10-15)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(!showDone, { showDone = false }, label = { Text("Jobs · $active") })
            FilterChip(showDone, { showDone = true }, label = { Text("Completed · ${done?.size ?: 0}") })
        }
        error?.let { Note(it, error = true) }
        if (showDone) {
            if (done?.isEmpty() == true) CardBox { Text("No completed jobs yet", fontWeight = FontWeight.SemiBold)
                Muted("Jobs accepted on inspection appear here, for 30 days after closure.") }
            done.orEmpty().forEach { t ->
                CardBox(onClick = { t.id?.let { go(C.Job(it)) } }) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("Qtr No. ${t.identifier ?: ""}", fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                        val (lbl, tone) = label(t.state?.value); StatusChip(lbl, tone)
                    }
                    Muted(listOfNotNull(t.subCategory, t.ticketNo).joinToString(" · "))
                    // the contractor's own figure: their time only, every round (README §3)
                    when (t.completionMet) {
                        true -> Text(if (firm) "Within the contractor's time" else "Within your time", color = toneColors(Tone.OK).fg, fontSize = 13.sp)
                        false -> Text(if (firm) "Over the contractor's time" else "Over your time", color = toneColors(Tone.BAD).fg, fontSize = 13.sp)
                        null -> {}
                    }
                    Muted((t.closedAt?.let { "Closed ${shortDate(it)}" } ?: t.inspectedAt?.let { "Accepted ${shortDate(it)}" }) ?: "")
                }
            }
            return@Shell
        }
        when {
            jobs == null && error == null -> Loading()
            jobs?.isEmpty() == true -> CardBox { Text("No jobs assigned", fontWeight = FontWeight.SemiBold); Muted("New work from the civil office will appear here.") }
        }
        GROUPS.forEach { (title, state) ->
            val rows = jobs.orEmpty().filter { it.state?.value == state }
            if (rows.isNotEmpty()) {
                SectionLabel(title)
                rows.forEach { t -> JobCard(t, if (firm) t.assignedTo?.let { names[it] } else null) { t.id?.let { go(C.Job(it)) } } }
            }
        }
    }
}

@Composable
private fun JobCard(t: TicketDetail, supervisor: String? = null, onClick: () -> Unit) {
    val s = sla(t)
    CardBox(onClick = onClick) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            if (s != null && t.state?.value != "WORK_COMPLETED") SlaRing(s.fraction, s.tone, slaText(s.leftMinutes))
            else Icon(Icons.Filled.CheckCircle, null, tint = toneColors(Tone.AWAIT).fg, modifier = Modifier.size(40.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("Qtr No. ${t.identifier ?: ""}", fontWeight = FontWeight.SemiBold)
                Muted(listOfNotNull(t.subCategory, t.ticketNo).joinToString(" · "))
                supervisor?.let { Muted("Supervisor: $it") }
                if (t.isEmergency == true) StatusChip("Emergency", Tone.BAD)
            }
        }
    }
}

/* ------------------------------------------------------------------ one job (C2) */
@Composable
private fun JobScreen(repo: ContractorRepository, id: UUID, back: () -> Unit, firm: Boolean = false, names: Map<UUID, String> = emptyMap()) {
    val scope = rememberCoroutineScope()
    var t by remember { mutableStateOf<TicketDetail?>(null) }
    var mats by remember { mutableStateOf<TicketsIdMaterialsGet200Response?>(null) }
    var measured by remember { mutableStateOf<List<TicketsIdMeasurementsGet200ResponseItemsInner>>(emptyList()) }
    var load by remember { mutableIntStateOf(0) }
    var error by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var workmen by remember { mutableStateOf<String?>(null) }
    var confirming by remember { mutableStateOf(false) }
    // the camera, then the photograph to check before it is sent
    var shooting by remember { mutableStateOf<Boolean?>(null) }   // true = after, false = before
    var taken by remember { mutableStateOf<Shot?>(null) }
    var photoError by remember { mutableStateOf<String?>(null) }

    AutoRefresh { if (!busy && shooting == null && !confirming) load++ }
    LaunchedEffect(load) {
        runCatching {
            val d = repo.job(id)
            t = d
            if (workmen == null) workmen = d.workmenAssigned.orEmpty()
            mats = if (d.state?.value != "ASSIGNED") repo.materials(id) else null
            measured = if (d.state?.value in setOf("INSPECTED_ACCEPTED", "CLOSED")) repo.measured(id) else emptyList()
            error = null
        }.onFailure { error = it.message }
    }

    fun act(ok: String, block: suspend () -> Unit) = scope.launch {
        busy = true; error = null
        runCatching { block() }.onSuccess { notice = ok; load++ }.onFailure { error = it.message }
        busy = false
    }

    shooting?.let { after ->
        val what = if (after) "After" else "Before"
        val shot = taken
        if (shot == null) {
            CameraScreen("$what the work — Qtr ${t?.identifier ?: ""}", { taken = it; photoError = null }, { shooting = null })
        } else {
            ShotReview("$what the work — check the photograph", shot, busy, photoError,
                send = {
                    scope.launch {
                        busy = true; photoError = null
                        runCatching { repo.photograph(id, after, shot) }
                            .onSuccess { taken = null; shooting = null; notice = "$what photograph sent"; load++ }
                            .onFailure { photoError = it.message }
                        busy = false
                    }
                },
                retake = { taken = null; photoError = null },
                cancel = { taken = null; shooting = null; photoError = null })
        }
        BackHandler { if (!busy) { taken = null; shooting = null } }
        return
    }

    val c = t
    Shell(c?.ticketNo ?: "Job", c?.subCategory, onBack = back) {
        if (c == null) { error?.let { Note(it, error = true) } ?: Loading(); return@Shell }
        val state = c.state?.value
        val (lbl, tone) = label(state)
        CardBox {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Column(Modifier.weight(1f)) {
                    Text("Qtr No. ${c.identifier ?: ""}", fontWeight = FontWeight.Bold, fontSize = 18.sp)
                    Muted(c.category ?: "")
                }
                StatusChip(lbl, tone)
            }
            c.description?.let { Text(it) }
            if (c.isEmergency == true) StatusChip("Emergency", Tone.BAD)
            if (firm) c.assignedTo?.let { names[it] }?.let { Muted("Supervisor: $it") }
            if (firm) c.workmenAssigned?.let { Muted("Workmen: $it") }
        }

        sla(c)?.let { s ->
            CardBox {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    SlaRing(s.fraction, s.tone, slaText(s.leftMinutes), 88.dp, if (s.leftMinutes < 0) "late" else "left")
                    Column {
                        Text(if (firm) "The contractor's time on this job" else "Your time on this job", fontWeight = FontWeight.SemiBold)
                        Muted("${hoursText(s.usedMinutes)} used of ${hoursText(s.windowMinutes)} · ${if (s.running) "clock running" else "clock stopped"}")
                        Muted("Counts only while the job is with you. Inspection time is not yours.")
                    }
                }
            }
        }
        notice?.let { CardBox { Text(it, color = toneColors(Tone.OK).fg) } }

        val sentBack = c.history.orEmpty().lastOrNull { it.toState == "REWORK" }
        if (state == "REWORK") CardBox {
            Text("Sent back by the Overseer", color = toneColors(Tone.BAD).fg, fontWeight = FontWeight.SemiBold)
            sentBack?.reason?.let { Text("“$it”") }
            Muted(if (firm) "The supervisor starts the work again." else "Start the work again. Photographs taken before this send-back do not count for this round.")
        }

        if (!firm && (state == "ASSIGNED" || state == "REWORK")) CardBox {
            Text("Workmen allotted", fontWeight = FontWeight.SemiBold)
            OutlinedTextField(workmen.orEmpty(), { workmen = it.take(300) }, Modifier.fillMaxWidth(),
                placeholder = { Text("e.g. Ram Prasad, Sunil Kumar") }, supportingText = { Text("Names of the workmen on this job") })
            Primary(if (busy) "Starting…" else if (state == "REWORK") "Resume work" else "Start work",
                enabled = !busy && (workmen?.trim()?.length ?: 0) >= 3) {
                act(if (state == "REWORK") "Work resumed" else "Work started — your clock is running") { repo.start(id, workmen!!) }
            }
        }

        if (!firm && state == "IN_PROGRESS") {
            // photographs of this round only, at most three of each (database rule)
            val media = c.media.orEmpty().map { it.purpose to it.capturedAt }
            val before = roundCount(media, "BEFORE", c.contractorWindowStartedAt)
            val after = roundCount(media, "COMPLETION", c.contractorWindowStartedAt)
            // compulsory only once the HQ System Administrator requires them (2026-10-12)
            val needed = c.photoRules?.completionPhotosRequired != false
            SectionLabel("Update work")
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                PhotoSlot("Before", before, Modifier.weight(1f), enabled = !busy) { shooting = false }
                PhotoSlot("After", after, Modifier.weight(1f), enabled = !busy) { shooting = true }
            }
            Muted(if (needed) "At least one “before” and one “after” photograph are needed to mark the job complete; up to three of each. Taken with this phone’s camera, with the location."
                  else "Photographs are optional for now; if you take them, up to three “before” and three “after”, with this phone’s camera.")
            val ready = !needed || (before >= 1 && after >= 1)
            Primary(if (busy) "Sending…" else "Mark complete", enabled = !busy && ready) { confirming = true }
            if (!ready) Text("Add at least one before and one after photograph first.", color = toneColors(Tone.RISK).fg, fontSize = 13.sp)
        }
        if (state == "WORK_COMPLETED") CardBox {
            Text(if (firm) "Claimed complete. The contractor's clock has stopped; the Overseer inspects it next."
                 else "Claimed complete. Your clock has stopped; the Overseer inspects it next.", color = toneColors(Tone.AWAIT).fg)
        }
        error?.let { Note(it, error = true) }

        mats?.let { m -> Materials(repo, id, m, busy) { load++ } }
        if (measured.isNotEmpty()) {
            SectionLabel("Measured by Civil")
            CardBox {
                measured.forEach { i ->
                    Text("${i.seq}. ${i.description ?: ""}", fontWeight = FontWeight.Medium)
                    Muted(listOfNotNull("${i.measurement?.qty?.stripTrailingZeros()?.toPlainString()} ${i.unit ?: ""}",
                        i.measurement?.mbNo?.let { "MB $it · p. ${i.measurement?.mbPage ?: ""}" }).joinToString(" · "))
                }
                Muted("Quantities only; no rates are recorded.")
            }
        }
        if (!c.media.isNullOrEmpty()) {
            SectionLabel("Photographs")
            Gallery(repo.portal, c.media!!)
        }
        SectionLabel("History")
        CardBox {
            c.history.orEmpty().forEach { h ->
                Column(Modifier.padding(vertical = 4.dp)) {
                    Text(eventTitle(h.eventType, h.toState), fontWeight = FontWeight.SemiBold)
                    Muted(listOfNotNull((if (firm && h.actorRole == "CONTRACTOR_SUPERVISOR") "Supervisor" else WHO[h.actorRole]) ?: h.actorRole, h.reason?.let { "“$it”" }).joinToString(" — "))
                    Muted(whenText(h.occurredAt))
                }
            }
        }
    }

    if (confirming) AlertDialog(
        onDismissRequest = { confirming = false },
        title = { Text("Mark the job complete?") },
        text = { Text("This is your claim that the work is done. Your clock stops; the Civil Overseer inspects the work and only the Overseer can close it. It cannot be undone from here.") },
        confirmButton = { TextButton({ confirming = false; act("Marked complete — the Overseer will inspect it") { repo.complete(id) } }) { Text("Mark complete") } },
        dismissButton = { TextButton({ confirming = false }) { Text("Not yet") } })
}

/* Who did what, from the contractor's side. */
private val WHO = mapOf("RESIDENT" to "Occupant", "CUSTODIAN" to "Custodian", "CIVIL_OVERSEER" to "Civil Overseer",
    "MAINTENANCE_INCHARGE" to "Civil Colony Incharge", "CONTRACTOR_SUPERVISOR" to "You",
    "STAFF_OFFICER_CIVIL" to "Staff Officer (Civil)", "SYSTEM" to "System")

@Composable
private fun PhotoSlot(title: String, count: Int, modifier: Modifier, enabled: Boolean, take: () -> Unit) {
    val full = count >= 3
    val c = if (count > 0) toneColors(Tone.OK) else null
    val shape = RoundedCornerShape(CpTokens.radiusCard)
    Column(modifier.aspectRatio(1f)
        .border(1.5.dp, c?.fg ?: MaterialTheme.colorScheme.outline, shape)
        .clickable(enabled = enabled && !full, onClick = take).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterVertically), horizontalAlignment = Alignment.CenterHorizontally) {
        Icon(if (count > 0) Icons.Filled.CheckCircle else Icons.Filled.CameraAlt, null,
            tint = c?.fg ?: MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(28.dp))
        Text(title, fontWeight = FontWeight.SemiBold)
        Text("$count of 3", fontSize = 12.sp)
        Text(if (full) "Limit reached" else "Take photo", fontSize = 12.sp, color = MaterialTheme.colorScheme.primary)
    }
}

/* ------------------------------------------------------------------ materials */
@Composable
private fun Materials(repo: ContractorRepository, id: UUID, m: TicketsIdMaterialsGet200Response, busyOuter: Boolean, changed: () -> Unit) {
    val scope = rememberCoroutineScope()
    var adding by remember { mutableStateOf(false) }
    var master by remember { mutableStateOf<List<Material>?>(null) }
    var search by remember { mutableStateOf("") }
    var chosen by remember { mutableStateOf<Material?>(null) }
    var qty by remember { mutableStateOf("") }
    var withdrawing by remember { mutableStateOf<MaterialLine?>(null) }
    var reason by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val canClaim = m.canClaim == true

    fun act(block: suspend () -> Unit) = scope.launch {
        busy = true; error = null
        runCatching { block() }.onSuccess { adding = false; chosen = null; qty = ""; withdrawing = null; reason = ""; changed() }
            .onFailure { error = it.message }
        busy = false
    }

    SectionLabel("Materials used")
    CardBox {
        val lines = m.items.orEmpty()
        if (lines.isEmpty()) Muted(if (canClaim) "None recorded yet." else "None recorded.")
        lines.forEach { l ->
            val gone = l.withdrawnAt != null
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("${l.nameEn ?: l.code} — ${l.qtyClaimed?.stripTrailingZeros()?.toPlainString()} ${l.unit ?: ""}",
                        textDecoration = if (gone) TextDecoration.LineThrough else null, fontWeight = FontWeight.Medium)
                    when {
                        gone -> Muted("Withdrawn: “${l.withdrawalReason ?: ""}”")
                        l.qtyVerified != null -> Text("Verified by Civil: ${l.qtyVerified?.stripTrailingZeros()?.toPlainString()} ${l.unit ?: ""}",
                            color = toneColors(Tone.OK).fg, fontSize = 13.sp)
                        else -> Muted("Civil verifies at inspection")
                    }
                }
                if (canClaim && !gone && l.qtyVerified == null) TextButton({ withdrawing = l; reason = "" }, enabled = !busy && !busyOuter) { Text("Withdraw") }
            }
        }
        if (canClaim && !adding) Secondary("Add material", enabled = !busyOuter) {
            adding = true; error = null
            scope.launch { runCatching { master = repo.master() }.onFailure { error = it.message } }
        }
        if (adding) {
            val pick = chosen
            if (pick == null) {
                OutlinedTextField(search, { search = it }, Modifier.fillMaxWidth(), singleLine = true, label = { Text("Find a material") })
                if (master == null && error == null) Loading()
                master.orEmpty().filter { search.isBlank() || "${it.nameEn} ${it.nameHi} ${it.code}".contains(search.trim(), true) }
                    .take(8).forEach { mat ->
                        Row(Modifier.fillMaxWidth().heightIn(min = 44.dp).clickable { chosen = mat }.padding(vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(mat.nameEn ?: "", fontWeight = FontWeight.Medium)
                                Muted(listOfNotNull(mat.nameHi, mat.unit).joinToString(" · "))
                            }
                        }
                    }
            } else {
                Text(pick.nameEn ?: "", fontWeight = FontWeight.SemiBold)
                OutlinedTextField(qty, { qty = it.filter { ch -> ch.isDigit() || ch == '.' }.take(10) }, Modifier.fillMaxWidth(), singleLine = true,
                    label = { Text("Quantity used (${pick.unit ?: ""})") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
                val q = qty.toBigDecimalOrNull()
                Primary(if (busy) "Saving…" else "Record it", enabled = !busy && q != null && q > BigDecimal.ZERO) {
                    act { repo.claim(id, pick.id!!, q!!) }
                }
                Muted("A line cannot be changed once recorded — withdraw it with a reason and record it again.")
            }
            TextButton({ adding = false; chosen = null; qty = ""; search = "" }, enabled = !busy) { Text("Cancel") }
        }
        if (!canClaim) Muted("Materials are recorded while the work is under way.")
        error?.let { Note(it, error = true) }
    }

    withdrawing?.let { l ->
        AlertDialog(
            onDismissRequest = { if (!busy) withdrawing = null },
            title = { Text("Withdraw ${l.nameEn ?: "this line"}?") },
            text = { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("The line stays on record, marked withdrawn, with your reason.")
                OutlinedTextField(reason, { reason = it.take(300) }, Modifier.fillMaxWidth(), label = { Text("Reason") })
            } },
            confirmButton = { TextButton({ act { repo.withdraw(id, l.id!!, reason) } }, enabled = !busy && reason.isNotBlank()) { Text("Withdraw") } },
            dismissButton = { TextButton({ withdrawing = null }, enabled = !busy) { Text("Keep it") } })
    }
}
