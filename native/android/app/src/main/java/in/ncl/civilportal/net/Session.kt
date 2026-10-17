package `in`.ncl.civilportal.net

import android.content.SharedPreferences
import `in`.ncl.civilportal.api.identity.models.TokenResponse
import `in`.ncl.civilportal.api.identity.models.TokenResponseAssignmentsInner
import `in`.ncl.civilportal.security.SecretBox
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * The signed-in role. The access token lives in memory only; the refresh
 * token is sealed by the Keystore before it touches storage, so a copied
 * preferences file signs no one in.
 */
class Session(private val prefs: SharedPreferences, private val box: SecretBox) {
    data class Current(
        val role: String, val actorId: String?, val scopePath: String?,
        val premisesId: String?, val assignments: List<TokenResponseAssignmentsInner>
    )

    @Volatile var accessToken: String? = null; private set
    private val _current = MutableStateFlow<Current?>(null)
    val current: StateFlow<Current?> = _current

    val refreshToken: String?
        get() = prefs.getString(KEY_REFRESH, null)?.let(box::open)

    fun signedIn(t: TokenResponse) {
        accessToken = t.token
        t.refreshToken?.let { prefs.edit().putString(KEY_REFRESH, box.seal(it)).apply() }
        _current.value = Current(
            role = t.role?.value ?: "", actorId = t.actorId?.toString(), scopePath = t.scopePath,
            premisesId = t.premisesId?.toString(), assignments = t.assignments ?: emptyList())
    }

    fun signedOut() {
        accessToken = null
        prefs.edit().remove(KEY_REFRESH).apply()
        _current.value = null
    }

    private companion object { const val KEY_REFRESH = "refresh_sealed" }
}
