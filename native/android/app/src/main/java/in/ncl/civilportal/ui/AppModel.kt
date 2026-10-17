package `in`.ncl.civilportal.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import `in`.ncl.civilportal.CivilPortalApp
import `in`.ncl.civilportal.api.identity.models.TokenResponseAssignmentsInner
import `in`.ncl.civilportal.net.PortalError
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.launch

/** Where the app is. One screen at a time; the phone's back button returns to Start. */
sealed interface Screen {
    data object Start : Screen                       // checking this phone with the portal
    data object Welcome : Screen                     // not registered: register or settings
    data object Register : Screen
    data class Pending(val note: String) : Screen    // registered, waiting for approval
    data class PickRole(val personToken: String, val roles: List<TokenResponseAssignmentsInner>) : Screen
    data object Home : Screen
    data object Settings : Screen
    data object Unlock : Screen                      // one official role: PIN or biometric before signing in
    data class Problem(val message: String) : Screen
}

class AppModel(val graph: CivilPortalApp.Graph) {
    var screen by mutableStateOf<Screen>(Screen.Start)

    /* Signing in replaces the screen it was started from, so it must not run
       in that screen's own coroutine scope: leaving the screen would cancel
       it half-way (seen on the first phone test as "cannot reach the portal"). */
    private val scope = MainScope()

    /** Sign in with this phone and land on the right screen; `secondFactor` once the PIN or biometric is given. */
    fun refresh(secondFactor: Boolean = false) { scope.launch { start(secondFactor) } }

    private suspend fun start(secondFactor: Boolean) {
        if (!graph.registered || !graph.auth.registeredKey) { screen = Screen.Welcome; return }
        screen = Screen.Start
        screen = try {
            val t = graph.auth.signIn(secondFactor = secondFactor)
            if (t.token != null) Screen.Home
            else Screen.PickRole(t.personToken ?: "", t.assignments ?: emptyList())
        } catch (e: PortalError) {
            when {
                // a person whose only role is official signs straight into it, so
                // the PIN or biometric is asked here, not on the role picker (found
                // 2026-10-13: a supervisor's phone stuck on "Something is not right")
                e.message?.contains("PIN or biometric", true) == true && !secondFactor -> Screen.Unlock
                e.message?.contains("not registered", true) == true -> { graph.registered = false; Screen.Welcome }
                e.message?.contains("pending", true) == true ->
                    Screen.Pending("Your phone is waiting for approval. Residents and custodians are approved by the Civil Colony Incharge; officials' and contractors' phones by the Area administrator.")
                e.message?.contains("rejected", true) == true || e.message?.contains("revoked", true) == true ->
                    Screen.Problem("This phone is ${e.message?.substringAfter("is ")}. Register again, or ask your Area office.")
                else -> Screen.Problem(e.message ?: "The portal refused")
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Screen.Problem("Cannot reach the portal at ${graph.serverUrl}. ${e.message ?: ""}".trim())
        }
    }
}
