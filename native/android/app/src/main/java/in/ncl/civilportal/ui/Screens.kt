package `in`.ncl.civilportal.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import `in`.ncl.civilportal.BuildConfig
import `in`.ncl.civilportal.api.identity.models.TokenResponseAssignmentsInner
import `in`.ncl.civilportal.auth.Roles
import `in`.ncl.civilportal.security.Unlock
import kotlinx.coroutines.launch
import androidx.lifecycle.withResumed

@Composable
fun StartScreen() = Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }

@Composable
fun WelcomeScreen(model: AppModel) = Page(
    "NCL Colony Maintenance",
    "Report a problem in your quarter, follow it to the end, and see who is doing what. Officials and contractors work from here too."
) {
    Primary("Register this phone") { model.screen = Screen.Register }
    Note("Already registered on another phone? Each phone registers on its own; an NCL employee may also use the web portal with the Employee ID.")
    if (BuildConfig.DEBUG) Quiet("Portal address (development)") { model.screen = Screen.Settings }
}

@Composable
fun PendingScreen(model: AppModel, note: String) {
    Page("Waiting for approval", note) {
        Primary("Check again") { model.refresh() }
        ForgetPhone(model, "Register again as a new phone")
    }
}

/**
 * Forgetting the phone deletes its key from the Keystore for good: the phone
 * can never sign in as that registration again, and must register anew and
 * be approved. Asked first, plainly (found 2026-10-13: a phone's registration
 * was lost, most likely by this button pressed below "Save").
 */
@Composable
private fun ForgetPhone(model: AppModel, label: String) {
    var asking by remember { mutableStateOf(false) }
    Quiet(label) { asking = true }
    if (asking) androidx.compose.material3.AlertDialog(
        onDismissRequest = { asking = false },
        title = { Text("Forget this phone's registration?") },
        text = { Text("This phone's key is deleted for good. It will no longer sign in, and must be registered again and approved by the Area office. Your roles are not affected.") },
        confirmButton = { androidx.compose.material3.TextButton({ asking = false; model.graph.forgetThisPhone(); model.screen = Screen.Welcome }) {
            Text("Forget it", color = MaterialTheme.colorScheme.error) } },
        dismissButton = { androidx.compose.material3.TextButton({ asking = false }) { Text("Keep it") } })
}

@Composable
fun ProblemScreen(model: AppModel, message: String) {
    Page("Something is not right", message) {
        Primary("Try again") { model.refresh() }
        if (BuildConfig.DEBUG) Quiet("Portal address (development)") { model.screen = Screen.Settings }
    }
}

/**
 * The person's one role is official: the PIN, fingerprint or face first
 * (decision 15), then sign in. The prompt is asked only once the app is on
 * screen (asked while the phone slept, Android never showed it and nothing
 * could be pressed — found 2026-10-13), and the button asks again at any time.
 */
@Composable
fun UnlockScreen(model: AppModel, activity: FragmentActivity) {
    var refused by remember { mutableStateOf(false) }
    var attempt by remember { mutableStateOf(0) }
    LaunchedEffect(attempt) {
        refused = false
        activity.lifecycle.withResumed { }
        if (Unlock.ask(activity, "Open the portal", "Confirm it is you")) model.refresh(secondFactor = true) else refused = true
    }
    Page("Confirm it is you", "Your role is an official one, so it opens only after your PIN, fingerprint or face.") {
        if (refused) Note("Not confirmed.", error = true)
        Primary("Confirm with PIN or fingerprint") { attempt++ }
    }
}

/**
 * The role picker (decision 2026-09-30): one phone, several roles. An
 * official role asks for the PIN or biometric first (decision 15).
 */
@Composable
fun PickRoleScreen(model: AppModel, activity: FragmentActivity, personToken: String, roles: List<TokenResponseAssignmentsInner>) {
    val scope = rememberCoroutineScope()
    var error by remember { mutableStateOf<String?>(null) }
    Page("Choose how you are working", "You hold more than one role. You can switch at any time.") {
        roles.forEach { a ->
            RoleCard(a) {
                scope.launch {
                    error = null
                    val unlocked = !Roles.needsUnlock(a) ||
                        Unlock.ask(activity, "Open ${Roles.name(a.role?.value)}", "Confirm it is you")
                    if (!unlocked) { error = "An official role opens only after your PIN, fingerprint or face."; return@launch }
                    runCatching { model.graph.auth.selectRole(personToken, a.id!!, secondFactor = Roles.needsUnlock(a)) }
                        .onSuccess { model.screen = Screen.Home }
                        .onFailure { error = it.message }
                }
            }
        }
        error?.let { Note(it, error = true) }
    }
}

@Composable
private fun RoleCard(a: TokenResponseAssignmentsInner, current: Boolean = false, onClick: () -> Unit) {
    Card(Modifier.fillMaxWidth().clickable(onClick = onClick)) {
        Column(Modifier.padding(16.dp)) {
            Text(Roles.label(a), fontWeight = FontWeight.SemiBold)
            listOfNotNull(a.designation, a.colony, if (current) "In use now" else null).takeIf { it.isNotEmpty() }?.let {
                Text(it.joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

/**
 * Home for a role whose screens are not built yet (A3, A4): who is signed
 * in and in what capacity, proof the maintenance service answers, and the
 * way to another role.
 */
@Composable
fun HomeScreen(model: AppModel, activity: FragmentActivity) {
    val current by model.graph.session.current.collectAsState()
    var visible by remember { mutableStateOf<String?>(null) }
    val me = current?.assignments?.find { it.id?.toString() == current?.actorId }

    LaunchedEffect(current?.actorId) {
        runCatching { model.graph.portal.tickets.ticketsGet() }
            .onSuccess { r -> visible = if (r.isSuccessful) "${r.body()?.total ?: r.body()?.items?.size ?: 0} complaints visible to this role" else "The portal answered ${r.code()}" }
            .onFailure { visible = it.message }
    }
    Page(me?.let { Roles.label(it) } ?: Roles.name(current?.role), "Signed in with this phone. The app's screens for this role come next; the web portal has them meanwhile.") {
        visible?.let { Note(it) }
        RoleSwitcher(model, activity)
    }
}

/** Profile: the roles this person holds, switching between them, and signing out. */
@Composable
fun ProfileScreen(model: AppModel, activity: FragmentActivity, back: () -> Unit) {
    val current by model.graph.session.current.collectAsState()
    val me = current?.assignments?.find { it.id?.toString() == current?.actorId }
    Shell("Profile", me?.let { Roles.label(it) }, onBack = back) { RoleSwitcher(model, activity); HomesCard(model); AppearanceCard(model) }
}

/** The person's other roles, each opened with the PIN or biometric if official (decision 15), and Sign out. */
@Composable
fun RoleSwitcher(model: AppModel, activity: FragmentActivity) {
    val scope = rememberCoroutineScope()
    val current by model.graph.session.current.collectAsState()
    var error by remember { mutableStateOf<String?>(null) }
    val others = current?.assignments.orEmpty().filter { it.id?.toString() != current?.actorId }
    if (others.isNotEmpty()) {
        Text("Switch role", fontWeight = FontWeight.SemiBold)
        others.forEach { a ->
            RoleCard(a) {
                scope.launch {
                    error = null
                    val unlocked = !Roles.needsUnlock(a) || Unlock.ask(activity, "Open ${Roles.name(a.role?.value)}", "Confirm it is you")
                    if (!unlocked) { error = "An official role opens only after your PIN, fingerprint or face."; return@launch }
                    runCatching { model.graph.auth.switchRole(a.id!!, Roles.needsUnlock(a)) }.onFailure { error = it.message }
                }
            }
        }
    }
    error?.let { Note(it, error = true) }
    Secondary("Sign out") { model.graph.auth.signOut(); model.screen = Screen.Problem("Signed out. Open the app again to sign in with this phone.") }
}

/** Debug builds only: point the app at a portal (for example this PC over `adb reverse`). */
@Composable
fun SettingsScreen(model: AppModel) {
    var url by remember { mutableStateOf(model.graph.serverUrl) }
    Page("Portal address", "Development builds only. With the phone on USB, `adb reverse tcp:3000 tcp:3000` makes http://127.0.0.1:3000 this PC.") {
        OutlinedTextField(url, { url = it }, Modifier.fillMaxWidth(), label = { Text("Address") }, singleLine = true)
        Primary("Save") { model.graph.serverUrl = url; model.refresh() }
        ForgetPhone(model, "Forget this phone's registration")
    }
}
