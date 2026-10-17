package `in`.ncl.civilportal.resident

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.StarBorder
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.fragment.app.FragmentActivity
import `in`.ncl.civilportal.api.identity.models.Me
import `in`.ncl.civilportal.api.maintenance.models.Category
import `in`.ncl.civilportal.api.maintenance.models.Review
import `in`.ncl.civilportal.api.maintenance.models.Ticket
import `in`.ncl.civilportal.api.maintenance.models.TicketDetail
import `in`.ncl.civilportal.api.maintenance.models.TicketsIdFeedbackGet200Response
import `in`.ncl.civilportal.photo.CameraScreen
import `in`.ncl.civilportal.photo.Gallery
import `in`.ncl.civilportal.photo.ShotImage
import `in`.ncl.civilportal.ui.dayTime
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.TextButton
import androidx.compose.material3.AlertDialog
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.produceState
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import `in`.ncl.civilportal.ui.AutoRefresh
import `in`.ncl.civilportal.photo.Shot
import `in`.ncl.civilportal.ui.AppModel
import `in`.ncl.civilportal.ui.CardBox
import `in`.ncl.civilportal.ui.Loading
import `in`.ncl.civilportal.ui.Muted
import `in`.ncl.civilportal.ui.Note
import `in`.ncl.civilportal.ui.Primary
import `in`.ncl.civilportal.ui.ProfileScreen
import `in`.ncl.civilportal.ui.ROLE_SHORT
import `in`.ncl.civilportal.ui.Secondary
import `in`.ncl.civilportal.ui.SectionLabel
import `in`.ncl.civilportal.ui.Shell
import `in`.ncl.civilportal.ui.SlaRing
import `in`.ncl.civilportal.ui.StatusChip
import `in`.ncl.civilportal.ui.Tone
import `in`.ncl.civilportal.ui.OPEN_STATES
import `in`.ncl.civilportal.ui.deadlineSla
import `in`.ncl.civilportal.ui.eventTitle
import `in`.ncl.civilportal.ui.shortDate
import `in`.ncl.civilportal.ui.slaText
import `in`.ncl.civilportal.ui.stateOf
import `in`.ncl.civilportal.ui.theme.CpTokens
import `in`.ncl.civilportal.ui.theme.LocalCpBrand
import `in`.ncl.civilportal.api.maintenance.models.ColonyNotice
import `in`.ncl.civilportal.api.maintenance.models.EscalationStep
import `in`.ncl.civilportal.ui.escalationLine
import `in`.ncl.civilportal.ui.ESCALATION_ROLE
import `in`.ncl.civilportal.ui.toneColors
import `in`.ncl.civilportal.ui.whenText
import kotlinx.coroutines.launch
import java.time.Duration
import java.time.OffsetDateTime
import java.util.UUID

/* The resident's and custodian's app (design R1–R4): one dominant action on
   the home, no figures. Screens stack; the phone's back button pops them. */

private sealed interface R {
    data object Home : R
    data object All : R
    data object Report : R
    data object Profile : R
    data class Detail(val id: UUID, val notice: String? = null) : R
}

@Composable
fun ResidentApp(model: AppModel, activity: FragmentActivity) {
    val repo = remember { ResidentRepository(model.graph.portal, model.graph.photos) }
    val stack = remember { mutableStateListOf<R>(R.Home) }
    var refresh by remember { mutableIntStateOf(0) }
    val go: (R) -> Unit = { stack.add(it) }
    val back: () -> Unit = { if (stack.size > 1) stack.removeAt(stack.lastIndex) }
    BackHandler(enabled = stack.size > 1, onBack = back)

    when (val top = stack.last()) {
        R.Home -> Home(repo, refresh, go)
        R.All -> AllComplaints(repo, go, back)
        R.Report -> ReportFlow(repo, back) { id, notice -> refresh++; stack.removeAt(stack.lastIndex); go(R.Detail(id, notice)) }
        R.Profile -> ProfileScreen(model, activity, back)
        is R.Detail -> Detail(repo, top.id, top.notice, back) { refresh++ }
    }
}

/* ------------------------------------------------------------------ home */
@Composable
private fun Home(repo: ResidentRepository, refresh: Int, go: (R) -> Unit) {
    var me by remember { mutableStateOf<Me?>(null) }
    var open by remember { mutableStateOf<List<Pair<TicketDetail, Boolean>>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var tick by remember { mutableIntStateOf(0) }
    AutoRefresh { tick++ }
    LaunchedEffect(refresh, tick) {
        runCatching {
            if (me == null) me = repo.me()
            // full rows: the SLA window lives on the complaint. A finished job
            // stays until the occupant has answered whether it was fixed
            // (user's finding, 2026-10-10) - or the Staff Officer has decided,
            // or it has left the working screens.
            open = repo.complaints().filter { c ->
                c.state?.value in OPEN_STATES || (c.state?.value in setOf("INSPECTED_ACCEPTED", "CLOSED") && c.archivedAt == null)
            }.mapNotNull { it.id }.mapNotNull { id ->
                val d = repo.complaint(id)
                val awaiting = d.state?.value !in OPEN_STATES
                if (awaiting && (d.finalDecision == true || repo.feedback(id) != null)) null else d to awaiting
            }
            error = null
        }.onFailure { error = it.message }
    }
    val first = me?.personName?.replace(Regex("^(Mrs?\\.?|Shri|Smt\\.?)\\s+", RegexOption.IGNORE_CASE), "") ?: ""
    val custodian = me?.role?.value == "CUSTODIAN"
    Shell("Namaste${if (first.isNotEmpty()) ", $first" else ""}", if (custodian) "Custodian" else "Resident", actions = {
        IconButton({ go(R.All) }) { Icon(Icons.AutoMirrored.Filled.List, "All my complaints", tint = Color.White) }
        IconButton({ go(R.Profile) }) { Icon(Icons.Filled.Person, "Profile and roles", tint = Color.White) }
    }) {
        CardBox {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                Box(Modifier.size(48.dp).background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(CpTokens.radiusCard)),
                    contentAlignment = Alignment.Center) { Icon(Icons.Filled.Home, null, tint = MaterialTheme.colorScheme.primary) }
                Column {
                    Muted(if (custodian) "My building" else "My quarter")
                    Text(listOfNotNull(me?.identifier?.let { if (custodian) it else "Qtr No. $it" }, me?.area).joinToString(", "),
                        fontWeight = FontWeight.Bold, fontSize = 17.sp)
                    Muted(listOfNotNull(me?.quarterType?.let { "Type $it" } ?: me?.premisesType, me?.colony).joinToString(" · "))
                }
            }
        }
        Notices(repo, compact = true, tick = tick)
        // the one dominant action (design "boldness budget")
        Row(Modifier.fillMaxWidth().background(Brush.linearGradient(listOf(LocalCpBrand.current.header, LocalCpBrand.current.heroEnd)),
                RoundedCornerShape(CpTokens.radiusCardLarge)).clickable { go(R.Report) }.padding(20.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Box(Modifier.size(56.dp).background(LocalCpBrand.current.gold, CircleShape), contentAlignment = Alignment.Center) {
                Icon(Icons.Filled.Add, null, tint = LocalCpBrand.current.heroEnd, modifier = Modifier.size(28.dp))
            }
            Column {
                Text("Report a problem", color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Bold)
                Text("Takes under a minute", color = Color.White.copy(alpha = .78f), fontSize = 13.sp)
            }
        }
        SectionLabel("My open complaints")
        error?.let { Note(it, error = true) }
        when {
            open == null && error == null -> Loading()
            open?.isEmpty() == true -> CardBox { Text("No open complaints", fontWeight = FontWeight.SemiBold); Muted("Report a problem when something needs fixing.") }
            else -> open?.forEach { (c, awaiting) -> ComplaintCard(c, awaiting) { c.id?.let { id -> go(R.Detail(id)) } } }
        }
    }
}

@Composable
private fun ComplaintCard(c: TicketDetail, awaitingYou: Boolean = false, onClick: () -> Unit) {
    val sla = deadlineSla(c.completionDeadlineAt, c.slaCompletionMinutes, c.state?.value)
    val st = stateOf(c.state?.value)
    CardBox(onClick = onClick) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            when {
                sla != null -> SlaRing(sla.fraction, sla.tone, slaText(sla.leftMinutes))
                c.state?.value == "RAISED" -> SlaRing(0f, Tone.NEUTRAL, "New")
                else -> Icon(Icons.Filled.CheckCircle, null, tint = toneColors(Tone.OK).fg, modifier = Modifier.size(40.dp))
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(c.subCategory ?: "", fontWeight = FontWeight.SemiBold)
                Muted("${c.ticketNo} · ${shortDate(c.raisedAt)}")
                StatusChip(st.resident, st.tone)
                if (awaitingYou) Text("Was it fixed? Tap to answer", color = toneColors(Tone.AWAIT).fg, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

@Composable
private fun AllComplaints(repo: ResidentRepository, go: (R) -> Unit, back: () -> Unit) {
    var list by remember { mutableStateOf<List<Ticket>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { runCatching { list = repo.complaints() }.onFailure { error = it.message } }
    Shell("My complaints", "Open and recent", onBack = back) {
        error?.let { Note(it, error = true) }
        if (list == null && error == null) Loading()
        if (list?.isEmpty() == true) CardBox { Text("Nothing reported yet", fontWeight = FontWeight.SemiBold); Muted("Your complaints will appear here.") }
        list?.forEach { c ->
            val st = stateOf(c.state?.value)
            CardBox(onClick = { c.id?.let { go(R.Detail(it)) } }) {
                Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                    Text(c.subCategory ?: "", fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                    StatusChip(st.resident, st.tone)
                }
                Muted("${c.ticketNo} · ${whenText(c.raisedAt)}")
            }
        }
    }
}

/* ------------------------------------------------------------------ report (R2) */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ReportFlow(repo: ResidentRepository, back: () -> Unit, done: (UUID, String?) -> Unit) {
    val scope = rememberCoroutineScope()
    var cats by remember { mutableStateOf<List<Category>?>(null) }
    var step by remember { mutableIntStateOf(1) }
    var category by remember { mutableStateOf<String?>(null) }
    var sub by remember { mutableStateOf<Category?>(null) }
    var desc by remember { mutableStateOf("") }
    var emergency by remember { mutableStateOf(false) }
    val shots = remember { mutableStateListOf<Shot>() }
    var shooting by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { runCatching { cats = repo.categories() }.onFailure { error = it.message } }

    if (shooting) { CameraScreen("Photograph the problem (${shots.size + 1} of 3)", { shots.add(it); shooting = false }, { shooting = false }); return }
    // Discard on every step, asked first (user's request, 2026-10-12); the
    // back arrow and the phone's back button ask too once anything is entered
    var discarding by remember { mutableStateOf(false) }
    val dirty = category != null || desc.isNotBlank() || shots.isNotEmpty()
    val leave = { if (dirty) discarding = true else back() }
    BackHandler { if (step > 1) step-- else leave() }
    if (discarding) AlertDialog(
        onDismissRequest = { discarding = false },
        title = { Text("Discard this complaint?") },
        text = { Text("What you have entered and the photographs taken will be lost. Nothing has been sent.") },
        confirmButton = { TextButton({ discarding = false; shots.clear(); back() }) { Text("Discard", color = toneColors(Tone.BAD).fg) } },
        dismissButton = { TextButton({ discarding = false }) { Text("Keep editing") } })

    val groups = cats.orEmpty().groupBy { it.category ?: "" }
    val em = sub?.classification?.value == "EM"
    Shell("Report a problem", "Step $step of 3", onBack = { if (step > 1) step-- else leave() }) {
        LinearProgressIndicator(progress = { step / 3f }, modifier = Modifier.fillMaxWidth())
        when (step) {
            1 -> {
                Notices(repo, compact = false)
                Text("What needs fixing?", fontWeight = FontWeight.SemiBold)
                if (cats == null && error == null) Loading()
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    groups.keys.forEach { c ->
                        FilterChip(selected = category == c, onClick = { category = c; sub = null }, label = { Text(c) })
                    }
                }
                category?.let { c ->
                    SectionLabel(c)
                    groups[c].orEmpty().forEach { s ->
                        val chosen = sub?.id == s.id
                        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp)
                            .border(if (chosen) 2.dp else 1.dp, if (chosen) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant,
                                RoundedCornerShape(CpTokens.radiusInput))
                            .clickable { sub = s }.padding(horizontal = 14.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically) {
                            Text(s.nameEn ?: "", Modifier.weight(1f), fontWeight = if (chosen) FontWeight.SemiBold else FontWeight.Normal)
                            if (s.emergencyEligible == true) Text("can be emergency", color = toneColors(Tone.BAD).fg, fontSize = 11.sp)
                        }
                    }
                }
                if (em) CardBox { Text("Electrical work is handled by the E&M Department, not this portal. Please contact your Area E&M office.",
                    color = toneColors(Tone.RISK).fg) }
                Primary("Continue", enabled = sub != null && !em) { emergency = false; step = 2 }
                DiscardButton(enabled = !busy) { leave() }
            }
            2 -> {
                OutlinedTextField(desc, { desc = it.take(500) }, Modifier.fillMaxWidth().heightIn(min = 120.dp),
                    label = { Text("Describe the problem (optional)") },
                    placeholder = { Text("e.g. Kitchen tap leaking since morning; water collecting under the sink") })
                Muted("${desc.length} / 500 · it helps the Overseer and the contractor")
                ShotsPicker(shots, optional = true) { shooting = true }
                if (sub?.emergencyEligible == true) CardBox {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(emergency, { emergency = it })
                        Column {
                            Text("This is an emergency", color = toneColors(Tone.BAD).fg, fontWeight = FontWeight.Bold)
                            Muted("Faster response. Misuse is recorded, and the Overseer may downgrade it.")
                        }
                    }
                }
                Primary("Continue") { step = 3 }
                DiscardButton(enabled = !busy) { leave() }
            }
            else -> {
                Text("Check and send", fontWeight = FontWeight.SemiBold)
                CardBox {
                    Muted("Problem"); Text(sub?.nameEn ?: "", fontWeight = FontWeight.SemiBold)
                    Muted("Description"); Text(desc.ifBlank { "None" })
                    Muted("Photographs"); Text(if (shots.isEmpty()) "None" else "${shots.size} attached")
                    if (emergency) StatusChip("Emergency", Tone.BAD)
                }
                Muted("The Civil Colony Overseer checks it first; the SLA clock is fixed then. You will see every step.")
                error?.let { Note(it, error = true) }
                Primary(if (busy) "Sending…" else "Report problem", enabled = !busy) {
                    scope.launch {
                        busy = true; error = null
                        runCatching { repo.raise(sub!!.id!!, desc, emergency, shots.toList()) }
                            .onSuccess { r ->
                                // the complaint stands even if its photograph failed; the next screen says so
                                done(r.id, if (r.photoError != null) "Complaint ${r.ticketNo} registered, but the photograph did not upload: ${r.photoError}"
                                           else "Complaint registered · ${r.ticketNo}")
                            }
                            .onFailure { error = it.message }
                        busy = false
                    }
                }
                DiscardButton(enabled = !busy) { leave() }
            }
        }
    }
}

/* Just below the step's main button (user's direction, 2026-10-12): a text
   button in the late colour, so it never reads as the way forward. */
@Composable
private fun DiscardButton(enabled: Boolean, onClick: () -> Unit) =
    TextButton(onClick, enabled = enabled, modifier = Modifier.fillMaxWidth()) {
        Text("Discard this complaint", color = toneColors(Tone.BAD).fg)
    }

/* ------------------------------------------------------------------ detail (R3, R4) */
private enum class Mode { OBJECT, REOPEN, CONTEST }

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Detail(repo: ResidentRepository, id: UUID, firstNotice: String?, back: () -> Unit, changed: () -> Unit) {
    val scope = rememberCoroutineScope()
    var t by remember { mutableStateOf<TicketDetail?>(null) }
    var fb by remember { mutableStateOf<TicketsIdFeedbackGet200Response?>(null) }
    var load by remember { mutableIntStateOf(0) }
    var error by remember { mutableStateOf<String?>(null) }
    var notice by remember { mutableStateOf(firstNotice) }
    var mode by remember { mutableStateOf<Mode?>(null) }
    var note by remember { mutableStateOf("") }
    var rating by remember { mutableIntStateOf(0) }
    val reasons = remember { mutableStateListOf<String>() }
    val shots = remember { mutableStateListOf<Shot>() }
    var shooting by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }

    AutoRefresh { if (!busy) load++ }
    LaunchedEffect(load) {
        runCatching { t = repo.complaint(id); fb = repo.feedback(id) }.onFailure { error = it.message }
    }
    if (shooting) { CameraScreen("${if (mode == Mode.REOPEN) "Photograph what is still wrong" else "Photograph the problem"} (${shots.size + 1} of 3)",
        { shots.add(it); shooting = false }, { shooting = false }); return }

    fun act(ok: String, block: suspend () -> Unit) = scope.launch {
        busy = true; error = null
        runCatching { block() }
            .onSuccess { notice = ok; mode = null; note = ""; shots.clear(); load++; changed() }
            .onFailure { error = it.message }
        busy = false
    }

    val c = t
    val state = c?.state?.value
    val final = c?.finalDecision == true
    val canRate = state in setOf("INSPECTED_ACCEPTED", "CLOSED") && fb == null
    // before closure it can be reopened at once; after closure, within 24 hours
    val canReopen = !final && (state == "INSPECTED_ACCEPTED" ||
        (state == "CLOSED" && c?.closedAt != null && Duration.between(c.closedAt, OffsetDateTime.now()).toHours() < 24))

    Shell(c?.subCategory ?: "Complaint", c?.ticketNo, onBack = back) {
        if (c == null) { error?.let { Note(it, error = true) } ?: Loading(); return@Shell }
        val st = stateOf(state)
        val sla = deadlineSla(c.completionDeadlineAt, c.slaCompletionMinutes, state)
        CardBox {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                when {
                    sla != null -> SlaRing(sla.fraction, sla.tone, slaText(sla.leftMinutes), 88.dp, if (sla.leftMinutes < 0) "late" else "left")
                    state == "RAISED" -> SlaRing(0f, Tone.NEUTRAL, "New", 88.dp, "being checked")
                    else -> SlaRing(1f, if (c.completionMet == false) Tone.BAD else Tone.OK, if (c.completionMet == false) "Late" else "✓", 88.dp)
                }
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    StatusChip(st.resident, st.tone)
                    Text(c.identifier?.let { "Qtr No. $it" } ?: "", fontWeight = FontWeight.SemiBold)
                    Muted(c.category ?: "")
                    if (sla != null) Muted("Expected by ${shortDate(c.completionDeadlineAt)}")
                }
            }
        }
        notice?.let { CardBox { Text(it, color = toneColors(Tone.OK).fg) } }
        c.description?.let { CardBox { Text(it) } }
        c.workmenAssigned?.let {
            CardBox { Muted("Workmen"); Text(it); Muted("Contractor contact numbers are not shown; call the Area office helpline if needed.") }
        }

        if (state == "IN_PROGRESS" && mode == null) Secondary("Object to the work") { mode = Mode.OBJECT; error = null }

        if (canRate && !final && mode == null) CardBox {
            Text("Was it fixed properly?", fontWeight = FontWeight.SemiBold)
            Muted("Your answer goes to the civil office. It never replaces the Overseer’s inspection.")
            Row { (1..5).forEach { n ->
                IconButton({ rating = n }) { Icon(if (n <= rating) Icons.Filled.Star else Icons.Filled.StarBorder, "$n of 5", tint = LocalCpBrand.current.gold) }
            } }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("Neat work", "On time", "Polite workmen", "Cleaned up after", "Took too long", "Left a mess").forEach { r ->
                    FilterChip(r in reasons, { if (r in reasons) reasons.remove(r) else reasons.add(r) }, label = { Text(r) })
                }
            }
            Primary(if (busy) "Saving…" else "Yes, it’s fixed", enabled = !busy) {
                act("Thank you — your answer is recorded") { repo.confirm(id, rating.takeIf { it > 0 }, reasons.joinToString(", ").ifBlank { null }) }
            }
            if (canReopen) Secondary("Not fixed, reopen") { mode = Mode.REOPEN; error = null }
        }
        fb?.let { f ->
            CardBox { Text("You ${if (f.confirmed == true) "confirmed the fix" else "said it is not fixed"}${f.rating?.let { " and rated it $it/5" } ?: ""}.") }
            if (canReopen && mode == null) Secondary("Not fixed, reopen") { mode = Mode.REOPEN; error = null }
        }
        if (final) CardBox { Text(c.finalNote ?: "This complaint has been decided by the Area Civil Staff Officer. Further disputes are not taken in the portal; you may write to the Area Civil Office.",
            color = toneColors(Tone.AWAIT).fg) }
        if (c.canContest == true && !final && mode == null) CardBox {
            Text("Not accepted", fontWeight = FontWeight.SemiBold)
            Muted("If you disagree, you may contest this decision once. The Overseer or Incharge reviews it; if they uphold it, the Area Civil Staff Officer decides in writing.")
            Secondary("Contest this decision") { mode = Mode.CONTEST; error = null }
        }

        mode?.let { m ->
            CardBox {
                Text(when (m) { Mode.OBJECT -> "Object while work is under way"; Mode.REOPEN -> "Reopen this complaint"; Mode.CONTEST -> "Contest this decision" },
                    fontWeight = FontWeight.SemiBold)
                Muted(when (m) {
                    Mode.OBJECT -> "Goes to the Overseer and Incharge, not the contractor. The Overseer answers within 24 hours."
                    Mode.REOPEN -> "A photograph of what is still wrong is required. The same complaint reopens; nothing new is created."
                    Mode.CONTEST -> "You can contest once. Say why the complaint should be taken up."
                })
                OutlinedTextField(note, { note = it.take(500) }, Modifier.fillMaxWidth().heightIn(min = 100.dp),
                    placeholder = { Text(if (m == Mode.CONTEST) "Why should this complaint be taken up?" else "Say what is wrong") })
                if (m != Mode.CONTEST) ShotsPicker(shots, optional = m == Mode.OBJECT) { shooting = true }
                error?.let { Note(it, error = true) }
                Primary(when { busy -> "Sending…"; m == Mode.OBJECT -> "Send objection"; m == Mode.REOPEN -> "Reopen complaint"; else -> "Contest decision" },
                    enabled = !busy && note.isNotBlank() && (m != Mode.REOPEN || shots.isNotEmpty())) {
                    when (m) {
                        Mode.OBJECT -> act("Objection sent to the Overseer and Incharge") { repo.object_(id, note, shots.toList()) }
                        Mode.REOPEN -> act("Complaint reopened") { repo.reopen(id, note, shots.toList()) }
                        Mode.CONTEST -> act("Your contest has gone to the Overseer and Incharge") { repo.contest(id, note) }
                    }
                }
                Secondary("Cancel") { mode = null; error = null; shots.clear() }
            }
        }
        if (mode == null) error?.let { Note(it, error = true) }

        if (!c.media.isNullOrEmpty()) {
            SectionLabel("Photographs")
            Gallery(repo.portal, c.media!!)
        }
        EscalationCard(state, c.escalationPath.orEmpty())
        if (!c.reviews.isNullOrEmpty()) {
            SectionLabel("Review of your complaint")
            c.reviews!!.forEach { ReviewCard(it) }
        }
        SectionLabel("Timeline")
        CardBox {
            c.history.orEmpty().forEach { h ->
                Column(Modifier.padding(vertical = 4.dp)) {
                    Text(eventTitle(h.eventType, h.toState), fontWeight = FontWeight.SemiBold)
                    Muted(listOfNotNull(ROLE_SHORT[h.actorRole] ?: h.actorRole, h.reason?.let { "“$it”" }).joinToString(" — "))
                    Muted(whenText(h.occurredAt))
                }
            }
        }
        if (!c.objections.isNullOrEmpty()) {
            SectionLabel("Objections")
            c.objections!!.forEach { o ->
                CardBox {
                    Text(o.note ?: "")
                    Muted(whenText(o.raisedAt))
                    if (o.respondedAt != null) Text("Overseer: ${o.responseNote ?: ""}")
                    else Text("Awaiting the Overseer’s answer", color = toneColors(Tone.RISK).fg, fontSize = 13.sp)
                }
            }
        }
    }
}

@Composable
private fun ReviewCard(r: Review) = CardBox {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(if (r.kind == Review.Kind.REJECTION_CONTEST) "You contested the rejection" else "Repeated reopening",
            fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
        StatusChip(when (r.stage) { Review.Stage.WITH_OFFICERS -> "With the Overseer / Incharge"
            Review.Stage.WITH_STAFF_OFFICER -> "With the Staff Officer"; else -> "Decided" },
            if (r.stage == Review.Stage.DECIDED) Tone.OK else Tone.AWAIT)
    }
    Muted(whenText(r.raisedAt))
    r.raisedReason?.let { Text("“$it”") }
    r.officerOutcome?.let {
        Text("${if (it == Review.OfficerOutcome.REINSTATE) "Reinstated" else "Rejection upheld"}${r.officerNote?.let { n -> " — “$n”" } ?: ""}")
    }
    r.soOutcome?.let {
        val what = mapOf("REINSTATE" to "complaint reinstated", "UPHOLD" to "rejection upheld", "REWORK" to "work to be redone",
            "CLOSE" to "complaint closed", "SPECIAL_REPAIR" to "referred for special repair")[it.value] ?: it.value
        Text("Decision of the Area Civil Staff Officer: $what", fontWeight = FontWeight.SemiBold)
        r.soDecision?.let { d -> Text("“$d”") }
    }
}

/**
 * Up to three photographs, taken with the app's camera (no gallery, control
 * 2), each shown as a preview so the occupant can check it before sending
 * (user's finding, 2026-10-12): tap to see it full size, remove any one.
 */
@Composable
private fun ShotsPicker(shots: MutableList<Shot>, optional: Boolean, take: () -> Unit) {
    var viewing by remember { mutableStateOf<Shot?>(null) }
    CardBox {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(Icons.Filled.CameraAlt, null, tint = MaterialTheme.colorScheme.primary)
            Column(Modifier.weight(1f)) {
                Text(if (shots.isEmpty()) "Take a photograph" else "${shots.size} of 3 photographs taken", fontWeight = FontWeight.SemiBold)
                Muted(if (optional) "Optional · up to three, with this phone's camera" else "At least one, up to three, with this phone's camera")
            }
        }
        if (shots.isNotEmpty()) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            shots.forEach { shot ->
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    ShotImage(shot, 480, Modifier.size(96.dp).clip(RoundedCornerShape(10.dp)).clickable { viewing = shot }, crop = true)
                    Text(shot.place?.text() ?: "No location", fontSize = 10.sp, lineHeight = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(96.dp))
                    TextButton({ shots.remove(shot) }) { Text("Remove", fontSize = 12.sp) }
                }
            }
        }
        if (shots.size < 3) Secondary(if (shots.isEmpty()) "Open the camera" else "Take another") { take() }
    }
    viewing?.let { shot ->
        Dialog({ viewing = null }, DialogProperties(usePlatformDefaultWidth = false)) {
            Column(Modifier.fillMaxSize().background(Color.Black).clickable { viewing = null }.padding(16.dp),
                verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                ShotImage(shot, 1600, Modifier.fillMaxWidth(), crop = false)
                Text("Photograph ${shots.indexOf(shot) + 1} of ${shots.size} · ${dayTime(shot.capturedAt)}", color = Color.White,
                    modifier = Modifier.padding(top = 12.dp))
                Text(shot.place?.let { "Taken at ${it.text()}" } ?: "No location was available when this was taken",
                    color = Color.White.copy(alpha = .75f), fontSize = 13.sp)
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(top = 8.dp)) {
                    TextButton({ shots.remove(shot); viewing = null }) { Text("Remove this one", color = Color.White) }
                    TextButton({ viewing = null }) { Text("Keep it", color = Color.White) }
                }
            }
        }
    }
}

/* ------------------------------------------------------------------ notices, escalation (design experiment R4, R1) */

/**
 * The civil office's notices for this colony (README §5.5, 2026-10-15): one
 * fault that affects many quarters, posted so it is not reported twenty times.
 * Titles only on the home; in full on the report form. Nothing when there is
 * none, or the portal cannot be reached — the home must still open.
 */
@Composable
private fun Notices(repo: ResidentRepository, compact: Boolean, tick: Int = 0) {
    var items by remember { mutableStateOf<List<ColonyNotice>>(emptyList()) }
    LaunchedEffect(tick) { runCatching { items = repo.notices() } }
    val risk = toneColors(Tone.RISK)
    items.forEach { n ->
        Row(Modifier.fillMaxWidth().background(risk.bg, RoundedCornerShape(CpTokens.radiusCard))
            .border(1.dp, risk.fg.copy(alpha = .3f), RoundedCornerShape(CpTokens.radiusCard)).padding(14.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(Icons.Filled.Info, null, tint = risk.fg, modifier = Modifier.size(20.dp))
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("Notice from the civil office${n.endsAt?.let { " · until ${dayTime(it)}" } ?: ""}",
                    color = risk.fg, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                Text(n.title, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurface)
                if (!compact && n.body.isNotBlank()) Text(n.body, fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

/** "If it is not fixed in time": who the complaint reaches at each level, and when. Hidden once the work is accepted. */
@Composable
private fun EscalationCard(state: String?, path: List<EscalationStep>) {
    if (path.isEmpty() || state in setOf("CLOSED", "REJECTED", "INSPECTED_ACCEPTED")) return
    val now = OffsetDateTime.now()
    val top = path.filter { it.reached }.maxOfOrNull { it.level } ?: 0
    CardBox {
        Text("If it is not fixed in time", fontWeight = FontWeight.SemiBold)
        Muted("Your complaint goes up a level by itself when the time allowed passes.")
        path.forEach { x ->
            val pastDue = !x.reached && x.dueAt?.isAfter(now) == false
            val c = when { x.level == top -> toneColors(Tone.RISK); pastDue -> toneColors(Tone.BAD); else -> null }
            Column(Modifier.fillMaxWidth().padding(top = 4.dp)
                .background(c?.bg ?: if (x.reached) MaterialTheme.colorScheme.surfaceVariant else MaterialTheme.colorScheme.surface, RoundedCornerShape(12.dp))
                .border(1.dp, c?.fg?.copy(alpha = .3f) ?: MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(12.dp))
                .padding(horizontal = 12.dp, vertical = 10.dp)) {
                Text("Level ${x.level} · ${ESCALATION_ROLE[x.role.value] ?: x.role.value}", fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                Muted(escalationLine(x.reached, x.reachedAt, x.dueAt, now))
            }
        }
        if (top == 0 && path.first().dueAt?.isAfter(now) == true) Muted("Not needed so far — the complaint is within its time.")
    }
}
