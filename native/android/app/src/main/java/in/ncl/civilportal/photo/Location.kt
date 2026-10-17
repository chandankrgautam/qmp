package `in`.ncl.civilportal.photo

import android.Manifest
import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Looper
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat
import java.util.Locale

/** Where the phone was when a photograph was taken (user's request, 2026-10-12: on every photograph). */
class Place(val latitude: Double, val longitude: Double, val accuracyM: Double) {
    fun text() = placeText(latitude, longitude, accuracyM)
}

/** "24.11023, 82.65310 (±5 m)" — the same wording wherever a location is shown. */
fun placeText(lat: Double, lon: Double, accuracyM: Double?) =
    String.format(Locale.ENGLISH, "%.5f, %.5f", lat, lon) + (accuracyM?.let { " (±${it.toInt()} m)" } ?: "")

class Fix(val fix: Location) { val place = Place(fix.latitude, fix.longitude, fix.accuracy.toDouble()) }

fun hasLocationPermission(c: Context) =
    ContextCompat.checkSelfPermission(c, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
        ContextCompat.checkSelfPermission(c, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

/**
 * The phone's location while the camera is open: satellite and network
 * fixes, keeping the better of the two, starting from a recent last-known
 * one so the first photograph rarely waits. Stops when the camera closes.
 * A fix older than two minutes is not trusted for a photograph.
 */
@SuppressLint("MissingPermission")
@Composable
fun rememberPlace(allowed: Boolean, switchedOn: Boolean = true): State<Fix?> {
    val context = LocalContext.current
    val state = remember { mutableStateOf<Fix?>(null) }
    DisposableEffect(allowed, switchedOn) {
        val lm = context.getSystemService(LocationManager::class.java)
        // a fix from before the location was switched off is not reused
        if (!switchedOn) state.value = null
        if (!allowed || !switchedOn || lm == null) return@DisposableEffect onDispose { }
        fun offer(l: Location?) {
            if (l == null || System.currentTimeMillis() - l.time > 120_000) return
            val cur = state.value?.fix
            if (cur == null || l.accuracy <= cur.accuracy || l.time - cur.time > 15_000) state.value = Fix(l)
        }
        val listener = LocationListener { offer(it) }
        val providers = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER).filter { runCatching { lm.isProviderEnabled(it) }.getOrDefault(false) }
        providers.forEach { p ->
            runCatching { offer(lm.getLastKnownLocation(p)) }
            runCatching { lm.requestLocationUpdates(p, 1000L, 0f, listener, Looper.getMainLooper()) }
        }
        onDispose { runCatching { lm.removeUpdates(listener) } }
    }
    return state
}

/**
 * Whether the phone's location is switched on, followed live: the occupant
 * may switch it off with the camera open (user's finding, 2026-10-12), and
 * the camera must then say so rather than just grey out the shutter.
 */
@Composable
fun rememberLocationOn(): State<Boolean> {
    val context = LocalContext.current
    fun now() = context.getSystemService(LocationManager::class.java)?.let { LocationManagerCompat.isLocationEnabled(it) } ?: false
    val state = remember { mutableStateOf(now()) }
    DisposableEffect(Unit) {
        val receiver = object : BroadcastReceiver() { override fun onReceive(c: Context, i: Intent) { state.value = now() } }
        ContextCompat.registerReceiver(context, receiver, IntentFilter(LocationManager.PROVIDERS_CHANGED_ACTION), ContextCompat.RECEIVER_NOT_EXPORTED)
        state.value = now()
        onDispose { runCatching { context.unregisterReceiver(receiver) } }
    }
    return state
}
