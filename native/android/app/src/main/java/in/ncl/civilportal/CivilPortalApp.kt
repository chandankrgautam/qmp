package `in`.ncl.civilportal

import android.app.Application
import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import `in`.ncl.civilportal.auth.AuthRepository
import `in`.ncl.civilportal.net.Portal
import `in`.ncl.civilportal.net.Session
import `in`.ncl.civilportal.photo.Photos
import `in`.ncl.civilportal.security.DeviceKey
import `in`.ncl.civilportal.security.SecretBox

/** The app's few long-lived objects, built once. */
class CivilPortalApp : Application() {
    lateinit var graph: Graph; private set

    override fun onCreate() {
        super.onCreate()
        graph = Graph(this)
    }

    class Graph(context: Context) {
        val prefs = context.getSharedPreferences("civilportal", Context.MODE_PRIVATE)
        val key = DeviceKey()
        val session = Session(prefs, SecretBox())

        /** The portal's address: the build's default, or the one set in Settings (debug builds). */
        var serverUrl: String
            get() = prefs.getString("server", null) ?: Portal.DEFAULT
            set(v) { prefs.edit().putString("server", v.trim().trimEnd('/')).apply(); rebuild() }

        /* The colour scheme and light / dark chosen on Profile (2026-10-15), as on
           the web's person menu. Kept on this phone only; held as Compose state so
           the whole app redraws the moment one is chosen. */
        var scheme by mutableStateOf(prefs.getString("scheme", null)); private set
        var theme by mutableStateOf(prefs.getString("theme", null) ?: "system"); private set
        fun setLook(scheme: String? = this.scheme, theme: String = this.theme) {
            prefs.edit().putString("scheme", scheme).putString("theme", theme).apply()
            this.scheme = scheme; this.theme = theme
        }

        /** Set once this phone's registration has been sent. */
        var registered: Boolean
            get() = prefs.getBoolean("registered", false)
            set(v) { prefs.edit().putBoolean("registered", v).apply() }

        lateinit var portal: Portal; private set
        lateinit var auth: AuthRepository; private set
        lateinit var photos: Photos; private set
        init { rebuild() }

        private fun rebuild() {
            portal = Portal(serverUrl, session)
            auth = AuthRepository(portal, key, session)
            photos = Photos(portal)
        }

        /** Start again as a new phone: key, registration and session all go. */
        fun forgetThisPhone() {
            session.signedOut(); key.delete(); registered = false
        }
    }
}
