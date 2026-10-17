package `in`.ncl.civilportal.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import `in`.ncl.civilportal.api.identity.models.HomeRequest
import `in`.ncl.civilportal.api.identity.models.MastersBuildingsGet200ResponseInner
import `in`.ncl.civilportal.api.identity.models.MastersColoniesGet200ResponseInner
import kotlinx.coroutines.launch

/**
 * "My homes" (user's request, 2026-10-13): someone already signed in — a
 * contractor supervisor of one Area living in another, an official whose
 * quarter is in another colony — asks from this phone for a quarter or a
 * building. No new phone and no new OTP; that Area's Incharge checks it and
 * approves the role, which then appears among the person's roles.
 */
@Composable
fun HomesCard(model: AppModel) {
    val scope = rememberCoroutineScope()
    val current by model.graph.session.current.collectAsState()
    var homes by remember { mutableStateOf<List<HomeRequest>?>(null) }
    var load by remember { mutableIntStateOf(0) }
    var adding by remember { mutableStateOf(false) }
    var custodian by remember { mutableStateOf(false) }
    var colonies by remember { mutableStateOf<List<MastersColoniesGet200ResponseInner>>(emptyList()) }
    var colony by remember { mutableStateOf<MastersColoniesGet200ResponseInner?>(null) }
    var buildings by remember { mutableStateOf<List<MastersBuildingsGet200ResponseInner>>(emptyList()) }
    var building by remember { mutableStateOf<MastersBuildingsGet200ResponseInner?>(null) }
    var quarter by remember { mutableStateOf("") }
    var pickColony by remember { mutableStateOf(false) }
    var pickBuilding by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    AutoRefresh { if (!adding) load++ }
    LaunchedEffect(load) { runCatching { homes = model.graph.auth.myHomes() }.onFailure { error = it.message } }
    LaunchedEffect(adding) { if (adding && colonies.isEmpty()) runCatching { colonies = model.graph.auth.colonies() }.onFailure { error = it.message } }
    LaunchedEffect(colony?.id, custodian) {
        building = null
        val id = colony?.id
        if (custodian && id != null) runCatching { buildings = model.graph.auth.buildings(id) }.onFailure { error = it.message }
    }

    val held = current?.assignments.orEmpty().mapNotNull { it.id }.toSet()
    val waiting = homes.orEmpty().any { it.status == HomeRequest.Status.PENDING }
    SectionLabel("My homes")
    CardBox {
        val list = homes.orEmpty()
        if (homes == null && error == null) Loading()
        if (homes != null && list.isEmpty()) Muted("A quarter or building you live in or look after, in any colony, besides your work.")
        list.forEach { h ->
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                androidx.compose.foundation.layout.Column(Modifier.weight(1f)) {
                    Text("${h.premises ?: h.identifier ?: ""} · ${h.colony ?: ""}", fontWeight = FontWeight.SemiBold)
                    Muted(listOfNotNull(if (h.role == HomeRequest.Role.CUSTODIAN) "Custodian" else "Resident", h.area).joinToString(" · "))
                    h.rejectedReason?.takeIf { h.status == HomeRequest.Status.REJECTED }?.let { Muted("Not accepted: “$it”") }
                }
                when (h.status) {
                    HomeRequest.Status.PENDING -> StatusChip("Waiting for the Incharge", Tone.AWAIT)
                    HomeRequest.Status.ACTIVE -> StatusChip("Approved", Tone.OK)
                    HomeRequest.Status.REJECTED -> StatusChip("Not accepted", Tone.NEUTRAL)
                    else -> StatusChip("Ended", Tone.NEUTRAL)
                }
            }
            // approved since this sign-in: signing in again lists it among the roles
            if (h.status == HomeRequest.Status.ACTIVE && h.id != null && h.id !in held)
                Primary("Show it in my roles") { model.refresh() }
        }
        if (!adding && !waiting && homes != null) Secondary("Add my home") { adding = true; error = null }
        if (adding) {
            Text("Add a home", fontWeight = FontWeight.SemiBold)
            listOf(false to "Resident of a quarter", true to "Custodian of a building").forEach { (c, label) ->
                Row(Modifier.fillMaxWidth().heightIn(min = 44.dp).clickable { custodian = c }, verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(selected = custodian == c, onClick = { custodian = c }); Text(label)
                }
            }
            Secondary(colony?.let { "Colony: ${it.name}${it.area?.let { a -> " · $a" } ?: ""}" } ?: "Choose the colony") { pickColony = true }
            if (custodian) Secondary(building?.let { "Building: ${it.identifier}" } ?: "Choose the building", enabled = colony != null) { pickBuilding = true }
            else OutlinedTextField(quarter, { quarter = it.uppercase().take(20) }, Modifier.fillMaxWidth(), singleLine = true,
                label = { Text("Quarter number, e.g. B-234") })
            Muted("Goes to the Civil Colony Incharge of that colony, who checks it. Your phone stays as it is.")
            val ok = colony != null && if (custodian) building != null else quarter.isNotBlank()
            Primary(if (busy) "Sending…" else "Send for approval", enabled = ok && !busy) {
                scope.launch {
                    busy = true; error = null
                    runCatching {
                        model.graph.auth.addHome(colony!!.id!!, custodian, if (custodian) building!!.identifier!! else quarter.trim(),
                            noSector = colony?.hasSectors != true)
                    }.onSuccess { adding = false; quarter = ""; colony = null; load++ }.onFailure { error = it.message }
                    busy = false
                }
            }
            TextButton({ adding = false; error = null }, enabled = !busy) { Text("Cancel") }
        }
        error?.let { Note(it, error = true) }
    }
    if (pickColony) Picker("The colony", colonies, { "${it.name}${it.area?.let { a -> " · $a" } ?: ""}" }, { colony = it; pickColony = false }) { pickColony = false }
    if (pickBuilding) Picker("The building", buildings, { it.identifier ?: "" }, { building = it; pickBuilding = false }) { pickBuilding = false }
}
