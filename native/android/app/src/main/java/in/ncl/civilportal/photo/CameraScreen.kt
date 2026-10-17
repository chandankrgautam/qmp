package `in`.ncl.civilportal.photo

import android.Manifest
import android.content.pm.PackageManager
import android.util.Size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.unit.sp
import android.view.OrientationEventListener
import android.view.Surface
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import `in`.ncl.civilportal.ui.Page
import `in`.ncl.civilportal.ui.Primary
import `in`.ncl.civilportal.ui.Quiet
import java.io.ByteArrayOutputStream
import java.time.OffsetDateTime

/** A photograph as it left the camera: the JPEG, the moment the shutter closed, and where the phone was (if known). */
class Shot(val jpeg: ByteArray, val capturedAt: OffsetDateTime, val place: Place? = null)

/**
 * The in-app camera. It is the only way a photograph enters the portal from
 * the phone: there is no gallery picker anywhere (control 2), and the time
 * recorded is the shutter's, not the upload's. About 1600 × 1200 at JPEG
 * quality 80 keeps a photograph near the 0.3 MB the storage plan assumes.
 */
@Composable
fun CameraScreen(title: String, onShot: (Shot) -> Unit, onCancel: () -> Unit) {
    val context = LocalContext.current
    var allowed by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
    }
    var asked by remember { mutableStateOf(false) }
    var located by remember { mutableStateOf(hasLocationPermission(context)) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { r ->
        allowed = r[Manifest.permission.CAMERA] ?: allowed
        located = hasLocationPermission(context); asked = true
    }
    val wanted = arrayOf(Manifest.permission.CAMERA, Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
    LaunchedEffect(Unit) { if (!allowed || !located) ask.launch(wanted) }

    if (!allowed) {
        Page("Camera needed", "The portal takes photographs only with this app's camera, so it needs permission to use it. It also records where each photograph was taken, so it asks for the phone's location.") {
            if (asked) Primary("Allow the camera") { ask.launch(wanted) }
            Quiet("Cancel", onCancel)
        }
        return
    }
    val gpsOn by rememberLocationOn()
    val place = rememberPlace(located, gpsOn)

    val owner = LocalLifecycleOwner.current
    val capture = remember {
        ImageCapture.Builder()
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
            .setJpegQuality(80)
            .setResolutionSelector(ResolutionSelector.Builder().setResolutionStrategy(
                ResolutionStrategy(Size(1600, 1200), ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER)).build())
            .build()
    }
    val preview = remember { PreviewView(context) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    // The screen no longer turns with the phone (the activity handles the
    // change itself), so the camera follows the phone's own orientation: a
    // photograph taken sideways is recorded as landscape.
    DisposableEffect(Unit) {
        val listener = object : OrientationEventListener(context) {
            override fun onOrientationChanged(deg: Int) {
                if (deg == ORIENTATION_UNKNOWN) return
                capture.targetRotation = when (deg) {
                    in 45 until 135 -> Surface.ROTATION_270
                    in 135 until 225 -> Surface.ROTATION_180
                    in 225 until 315 -> Surface.ROTATION_90
                    else -> Surface.ROTATION_0
                }
            }
        }
        listener.enable()
        onDispose { listener.disable() }
    }

    DisposableEffect(owner) {
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            val provider = future.get()
            val p = Preview.Builder().build().also { it.surfaceProvider = preview.surfaceProvider }
            runCatching {
                provider.unbindAll()
                provider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, p, capture)
            }.onFailure { error = "The camera could not be opened. ${it.message ?: ""}".trim() }
        }, ContextCompat.getMainExecutor(context))
        onDispose { runCatching { future.get().unbindAll() } }
    }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView({ preview }, Modifier.fillMaxSize())
        Column(Modifier.fillMaxSize().safeDrawingPadding().padding(16.dp), verticalArrangement = Arrangement.SpaceBetween) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onCancel) { Icon(Icons.Filled.Close, "Cancel", tint = Color.White) }
                Text(title, color = Color.White)
            }
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
                error?.let { Text(it, color = Color.White, modifier = Modifier.padding(bottom = 12.dp)) }
                if (!gpsOn) {
                    Text("The phone's location is switched off. Turn it on to take the photograph — every photograph must record where it was taken.",
                        color = Color.White, fontSize = 14.sp, modifier = Modifier.background(Color(0xCCA32A21), RoundedCornerShape(8.dp))
                            .padding(horizontal = 12.dp, vertical = 8.dp))
                    androidx.compose.material3.TextButton({ context.startActivity(android.content.Intent(android.provider.Settings.ACTION_LOCATION_SOURCE_SETTINGS)) }) {
                        Text("Turn on location", color = Color.White, fontSize = 15.sp)
                    }
                }
                Text(place.value?.let { "Location: ${it.place.text()}" }
                        ?: if (!gpsOn) "Waiting for the location to be switched on"
                           else if (located) "Finding your location — the photograph can be taken once it is found"
                           else "Location is not allowed — every photograph must record where it was taken",
                    color = Color.White, fontSize = 13.sp, modifier = Modifier.background(Color.Black.copy(alpha = .45f), RoundedCornerShape(8.dp))
                        .padding(horizontal = 10.dp, vertical = 4.dp))
                androidx.compose.foundation.layout.Spacer(Modifier.size(12.dp))
                FilledIconButton(
                    onClick = {
                        busy = true; error = null
                        val out = ByteArrayOutputStream()
                        val at = OffsetDateTime.now()
                        val where = place.value
                        // the location goes into the photograph itself (EXIF GPS) as well as to the portal
                        val meta = ImageCapture.Metadata().apply { location = where?.fix }
                        capture.takePicture(ImageCapture.OutputFileOptions.Builder(out).setMetadata(meta).build(), ContextCompat.getMainExecutor(context),
                            object : ImageCapture.OnImageSavedCallback {
                                override fun onImageSaved(r: ImageCapture.OutputFileResults) { busy = false; onShot(Shot(out.toByteArray(), at, where?.place)) }
                                override fun onError(e: ImageCaptureException) { busy = false; error = "The photograph was not taken. Try again." }
                            })
                    },
                    // no location, no photograph (user's decision, 2026-10-12)
                    enabled = !busy && place.value != null,
                    modifier = Modifier.size(76.dp),
                    shape = CircleShape,
                    colors = IconButtonDefaults.filledIconButtonColors(containerColor = Color.White)
                ) { if (busy) CircularProgressIndicator(Modifier.size(28.dp)) }
            }
        }
    }
}
