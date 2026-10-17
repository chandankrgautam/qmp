package `in`.ncl.civilportal.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import `in`.ncl.civilportal.api.identity.models.MastersBuildingsGet200ResponseInner
import `in`.ncl.civilportal.api.identity.models.MastersColoniesGet200ResponseInner
import `in`.ncl.civilportal.api.identity.models.RegistrationRequest
import kotlinx.coroutines.launch

/** Who is registering this phone. Officials do not choose a role: the Area office assigns it. */
private enum class Kind(val label: String, val help: String) {
    NCL_RESIDENT("NCL resident", "You live in an NCL quarter and have an Employee ID."),
    NON_NCL_RESIDENT("Non-NCL resident", "You live in a quarter but are not an NCL employee."),
    CUSTODIAN("Custodian of a building", "You look after a guest house, hostel or other building."),
    OFFICIAL("Official or contractor", "Your roles come from the Area HR office (supervisors: the Civil Incharge).")
}

/**
 * Registration (decision 13, §5.4): who you are, then the mobile number,
 * proved by an OTP — the number recorded is the one proved — and the phone's
 * public key. The request then waits for approval.
 */
@Composable
fun RegisterScreen(model: AppModel) {
    val scope = rememberCoroutineScope()
    var kind by remember { mutableStateOf(Kind.NCL_RESIDENT) }
    var name by remember { mutableStateOf("") }
    var employeeId by remember { mutableStateOf("") }
    var mobile by remember { mutableStateOf("") }
    var colonies by remember { mutableStateOf<List<MastersColoniesGet200ResponseInner>>(emptyList()) }
    var colony by remember { mutableStateOf<MastersColoniesGet200ResponseInner?>(null) }
    var buildings by remember { mutableStateOf<List<MastersBuildingsGet200ResponseInner>>(emptyList()) }
    var building by remember { mutableStateOf<MastersBuildingsGet200ResponseInner?>(null) }
    var quarter by remember { mutableStateOf("") }
    var pickColony by remember { mutableStateOf(false) }
    var pickBuilding by remember { mutableStateOf(false) }
    var otpSent by remember { mutableStateOf(false) }
    var code by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        runCatching { colonies = model.graph.auth.colonies() }.onFailure { error = it.message }
    }
    LaunchedEffect(colony?.id, kind) {
        building = null
        val id = colony?.id
        if (kind == Kind.CUSTODIAN && id != null) runCatching { buildings = model.graph.auth.buildings(id) }.onFailure { error = it.message }
    }

    val needsEmployeeId = kind == Kind.NCL_RESIDENT
    val formOk = name.isNotBlank() && colony != null && mobile.length == 10 &&
        (!needsEmployeeId || employeeId.length == 8) &&
        when (kind) { Kind.NCL_RESIDENT, Kind.NON_NCL_RESIDENT -> quarter.isNotBlank(); Kind.CUSTODIAN -> building != null; Kind.OFFICIAL -> true }

    Page("Register this phone", "The phone becomes your sign-in: no password to remember.") {
        Kind.entries.forEach { k ->
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable { kind = k }, verticalAlignment = Alignment.CenterVertically) {
                RadioButton(selected = kind == k, onClick = { kind = k })
                Column { Text(k.label); Text(k.help, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
        }
        OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), label = { Text("Your name") }, singleLine = true)
        if (kind == Kind.NCL_RESIDENT || kind == Kind.OFFICIAL) {
            OutlinedTextField(employeeId, { v -> employeeId = v.filter(Char::isDigit).take(8) }, Modifier.fillMaxWidth(),
                label = { Text(if (needsEmployeeId) "Employee ID" else "Employee ID (if an NCL employee)") },
                supportingText = { Text("8 digits, e.g. 90229456") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
        }
        Secondary(colony?.let { "Colony: ${it.name}" } ?: "Choose your colony") { pickColony = true }
        when (kind) {
            Kind.NCL_RESIDENT, Kind.NON_NCL_RESIDENT ->
                OutlinedTextField(quarter, { quarter = it.uppercase() }, Modifier.fillMaxWidth(), label = { Text("Quarter number, e.g. B-234") }, singleLine = true)
            Kind.CUSTODIAN ->
                Secondary(building?.let { "Building: ${it.identifier}" } ?: "Choose the building", enabled = colony != null) { pickBuilding = true }
            Kind.OFFICIAL -> {}
        }
        OutlinedTextField(mobile, { v -> mobile = v.filter(Char::isDigit).take(10); otpSent = false }, Modifier.fillMaxWidth(),
            label = { Text("Mobile number") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone))

        if (!otpSent) {
            Primary("Send OTP", enabled = formOk && !busy) {
                scope.launch {
                    busy = true; error = null
                    runCatching { model.graph.auth.requestOtp(mobile) }
                        .onSuccess { dev -> otpSent = true; if (dev != null) code = dev }
                        .onFailure { error = it.message }
                    busy = false
                }
            }
        } else {
            Note("Enter the code sent to $mobile.")
            OutlinedTextField(code, { v -> code = v.filter(Char::isDigit).take(6) }, Modifier.fillMaxWidth(),
                label = { Text("OTP") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword))
            Primary("Register", enabled = code.length == 6 && !busy) {
                scope.launch {
                    busy = true; error = null
                    runCatching {
                        val token = model.graph.auth.verifyOtp(mobile, code)
                        model.graph.auth.register(token) { pem ->
                            RegistrationRequest(
                                publicKey = pem, platform = RegistrationRequest.Platform.android,
                                colonyId = colony!!.id!!, name = name.trim(),
                                personnelNo = employeeId.ifBlank { null },
                                identifier = when (kind) { Kind.CUSTODIAN -> building?.identifier; Kind.OFFICIAL -> null; else -> quarter.trim() },
                                role = when (kind) { Kind.CUSTODIAN -> RegistrationRequest.Role.CUSTODIAN; Kind.OFFICIAL -> null; else -> RegistrationRequest.Role.RESIDENT },
                                residentCategory = when (kind) { Kind.NON_NCL_RESIDENT -> RegistrationRequest.ResidentCategory.NON_NCL; Kind.OFFICIAL -> null; else -> RegistrationRequest.ResidentCategory.NCL },
                                noSector = colony?.hasSectors != true,
                                premisesType = if (kind == Kind.CUSTODIAN) building?.premisesType else null
                            )
                        }
                    }.onSuccess { reg ->
                        model.graph.registered = true
                        // the phone belongs to whoever owns the proved mobile; say so if that is not the name typed
                        val owner = if (reg.existingPerson == true) " This mobile number is ${reg.name}'s on the portal's records, so the phone is registered to ${reg.name}. If that is wrong, ask the Area office to correct the mobile number." else ""
                        model.screen = Screen.Pending((if (kind == Kind.OFFICIAL)
                            "Sent. The Area administrator approves officials' phones (the Civil Incharge, a supervisor's) and the Area HR office gives you your role."
                            else "Sent. The Civil Colony Incharge checks your quarter or building and approves the phone.") + owner)
                    }.onFailure { error = it.message }
                    busy = false
                }
            }
        }
        error?.let { Note(it, error = true) }
        Quiet("Back") { model.screen = Screen.Welcome }
    }

    if (pickColony) Picker("Your colony", colonies, { "${it.name}${it.area?.let { a -> " · $a" } ?: ""}" }, { colony = it; pickColony = false }) { pickColony = false }
    if (pickBuilding) Picker("The building", buildings, { it.identifier ?: "" }, { building = it; pickBuilding = false }) { pickBuilding = false }
}

@Composable
internal fun <T> Picker(title: String, items: List<T>, label: (T) -> String, onPick: (T) -> Unit, onDismiss: () -> Unit) {
    AlertDialog(onDismissRequest = onDismiss, confirmButton = {}, dismissButton = { Quiet("Cancel", onDismiss) },
        title = { Text(title) },
        text = {
            Column {
                if (items.isEmpty()) Note("Nothing to choose from yet.")
                items.forEach { Text(label(it), Modifier.fillMaxWidth().clickable { onPick(it) }.padding(vertical = 12.dp)) }
            }
        })
}
