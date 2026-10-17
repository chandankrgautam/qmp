package `in`.ncl.civilportal.photo

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import `in`.ncl.civilportal.ui.Loading
import `in`.ncl.civilportal.ui.Primary
import `in`.ncl.civilportal.ui.Secondary
import `in`.ncl.civilportal.ui.dayTime
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** A photograph still on the phone (not yet sent), decoded upright off the main thread. */
@Composable
fun ShotImage(shot: Shot, maxSide: Int, modifier: Modifier, crop: Boolean) {
    val img by produceState<ImageBitmap?>(null, shot) { value = withContext(Dispatchers.Default) { decodeUpright(shot.jpeg, maxSide) } }
    Box(modifier.background(MaterialTheme.colorScheme.surfaceVariant), contentAlignment = Alignment.Center) {
        img?.let { Image(it, "Photograph taken", contentScale = if (crop) ContentScale.Crop else ContentScale.Fit,
            modifier = if (crop) Modifier.fillMaxSize() else Modifier.fillMaxWidth()) } ?: Loading()
    }
}

/**
 * The photograph just taken, full screen, before it is sent: where and when
 * it was taken, then send it or take it again. Nothing leaves the phone
 * until "Send" — a photograph once sent counts against the three allowed.
 */
@Composable
fun ShotReview(title: String, shot: Shot, busy: Boolean, error: String?, send: () -> Unit, retake: () -> Unit, cancel: () -> Unit) {
    Column(Modifier.fillMaxSize().background(Color.Black).statusBarsPadding().navigationBarsPadding().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(title, color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.Bold)
        ShotImage(shot, 1600, Modifier.fillMaxWidth().weight(1f), crop = false)
        Text(dayTime(shot.capturedAt), color = Color.White)
        Text(shot.place?.let { "Taken at ${it.text()}" } ?: "No location", color = Color.White.copy(alpha = .75f), fontSize = 13.sp)
        error?.let { Text(it, color = Color(0xFFFF8A80)) }
        Primary(if (busy) "Sending…" else "Send this photograph", enabled = !busy, onClick = send)
        Secondary("Take it again", enabled = !busy, onClick = retake)
        Secondary("Cancel", enabled = !busy, onClick = cancel)
    }
}
