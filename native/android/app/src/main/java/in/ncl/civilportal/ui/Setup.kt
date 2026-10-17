package `in`.ncl.civilportal.ui

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.LocationManager
import android.net.Uri
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect

/* Camera and location are compulsory (user's decision, 2026-10-12): every
   photograph is taken with this app's camera and must record where it was
   taken. Android asks for permissions while the app runs, never at install,
   so the app asks on first opening and goes no further until both are
   granted and the phone's location is switched on — checked again every
   time it comes back to the front, in case either was withdrawn.
   Gallery access is deliberately not asked for: the app never reads the
   gallery (control 2). */

private val NEEDED = arrayOf(Manifest.permission.CAMERA, Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)

private fun granted(c: Context, p: String) = ContextCompat.checkSelfPermission(c, p) == PackageManager.PERMISSION_GRANTED
private fun locationOn(c: Context) = c.getSystemService(LocationManager::class.java)?.let { LocationManagerCompat.isLocationEnabled(it) } ?: false

@Composable
fun SetupGate(content: @Composable () -> Unit) {
    val context = LocalContext.current
    var check by remember { mutableIntStateOf(0) }
    var askedOnce by remember { mutableStateOf(false) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { check++ }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { askedOnce = true; check++ }

    // re-read the phone's state on every return to the front and after asking
    val (camera, location, gps) = remember(check) {
        Triple(granted(context, Manifest.permission.CAMERA), granted(context, Manifest.permission.ACCESS_FINE_LOCATION), locationOn(context))
    }
    if (camera && location && gps) { content(); return }

    // once refused with "don't ask again", only the app's settings page can grant it
    val blocked = askedOnce && NEEDED.take(2).any { !granted(context, it) &&
        !ActivityCompat.shouldShowRequestPermissionRationale(context as Activity, it) }

    Page("Before you start", "This app needs the camera and your precise location, and the phone's location switched on. Every photograph in the portal is taken with this app and records where it was taken.") {
        Need("Camera", "To take photographs of the problem and the work", camera)
        Need("Precise location", "Recorded with every photograph", location)
        Need("Location switched on", "The phone's location setting", gps)
        if (!camera || !location) {
            if (blocked) {
                Note("Permission was refused. Open the app's settings, choose Permissions, and allow Camera and Location (precise).")
                Primary("Open the app's settings") {
                    context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)))
                }
            } else Primary("Allow camera and location") { ask.launch(NEEDED) }
        } else if (!gps) {
            Primary("Turn on location") { context.startActivity(Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)) }
        }
        Note("Photographs are never taken from the phone's gallery, so the app does not ask for it.")
    }
}

@Composable
private fun Need(title: String, why: String, ok: Boolean) =
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Icon(if (ok) Icons.Filled.CheckCircle else Icons.Filled.RadioButtonUnchecked, null,
            tint = if (ok) toneColors(Tone.OK).fg else MaterialTheme.colorScheme.onSurfaceVariant)
        androidx.compose.foundation.layout.Column {
            Text(title, fontWeight = FontWeight.SemiBold)
            Muted(why)
        }
    }
