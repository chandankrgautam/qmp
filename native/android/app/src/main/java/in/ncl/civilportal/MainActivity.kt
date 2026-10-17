package `in`.ncl.civilportal

import android.os.Bundle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import `in`.ncl.civilportal.resident.ResidentApp
import `in`.ncl.civilportal.contractor.ContractorApp
import `in`.ncl.civilportal.overseer.OverseerApp
import androidx.fragment.app.FragmentActivity
import `in`.ncl.civilportal.ui.AppModel
import `in`.ncl.civilportal.ui.HomeScreen
import `in`.ncl.civilportal.ui.PendingScreen
import `in`.ncl.civilportal.ui.PickRoleScreen
import `in`.ncl.civilportal.ui.ProblemScreen
import `in`.ncl.civilportal.ui.RegisterScreen
import `in`.ncl.civilportal.ui.Screen
import `in`.ncl.civilportal.ui.SetupGate
import `in`.ncl.civilportal.ui.SettingsScreen
import `in`.ncl.civilportal.ui.StartScreen
import `in`.ncl.civilportal.ui.UnlockScreen
import `in`.ncl.civilportal.ui.WelcomeScreen
import `in`.ncl.civilportal.ui.theme.CpTheme

/* A FragmentActivity, because the biometric prompt needs one. */
class MainActivity : FragmentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val graph = (application as CivilPortalApp).graph
        setContent {
            val dark = when (graph.theme) { "light" -> false; "dark" -> true; else -> isSystemInDarkTheme() }
            CpTheme(graph.scheme, dark) { SetupGate {
                val model = remember { AppModel(graph) }
                LaunchedEffect(Unit) { model.refresh() }
                BackHandler(enabled = model.screen is Screen.Register || model.screen is Screen.Settings) {
                    model.screen = Screen.Welcome
                }
                when (val s = model.screen) {
                    Screen.Start -> StartScreen()
                    Screen.Welcome -> WelcomeScreen(model)
                    Screen.Register -> RegisterScreen(model)
                    is Screen.Pending -> PendingScreen(model, s.note)
                    is Screen.PickRole -> PickRoleScreen(model, this, s.personToken, s.roles)
                    Screen.Home -> {
                        // the screens follow the role in use; switching role recomposes here
                        val role by graph.session.current.collectAsState()
                        when (role?.role) {
                            "RESIDENT", "CUSTODIAN" -> ResidentApp(model, this)
                            "CONTRACTOR_SUPERVISOR" -> ContractorApp(model, this)
                            // the firm's own role: the same screens, read-only (2026-10-15)
                            "CONTRACTOR" -> ContractorApp(model, this, firm = true)
                            "CIVIL_OVERSEER" -> OverseerApp(model, this)
                            else -> HomeScreen(model, this)
                        }
                    }
                    Screen.Settings -> SettingsScreen(model)
                    Screen.Unlock -> UnlockScreen(model, this)
                    is Screen.Problem -> ProblemScreen(model, s.message)
                }
            } }
        }
    }
}
