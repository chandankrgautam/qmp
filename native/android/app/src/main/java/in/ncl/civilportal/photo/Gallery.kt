package `in`.ncl.civilportal.photo

import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import `in`.ncl.civilportal.api.maintenance.models.TicketDetailAllOfMedia
import `in`.ncl.civilportal.net.Portal
import `in`.ncl.civilportal.ui.CardBox
import `in`.ncl.civilportal.ui.Muted
import `in`.ncl.civilportal.ui.whenText
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.UUID

/* Photographs are fetched with the session's token and shown from memory;
   they are never written to the phone's storage or gallery. */
private val cache = LruCache<UUID, ImageBitmap>(24)

private suspend fun load(portal: Portal, id: UUID): ImageBitmap? = cache.get(id) ?: run {
    val r = portal.media.mediaIdImageGet(id)
    if (!r.isSuccessful) return null
    val bytes = withContext(Dispatchers.IO) { r.body()?.bytes() } ?: return null
    withContext(Dispatchers.Default) { decodeUpright(bytes) }
        ?.also { cache.put(id, it) }
}

/** What each kind of photograph is, in the occupant's words; the order they are shown in. */
private val KINDS = listOf(
    "COMPLAINT" to "Photographs of the problem",
    "OBJECTION" to "With your objection",
    "BEFORE" to "Before the work",
    "COMPLETION" to "After the work",
    "INSPECTION" to "The Overseer's inspection",
)

/** The complaint's photographs, grouped by who took them and why; tap one to see it full size. */
@Composable
fun Gallery(portal: Portal, media: List<TicketDetailAllOfMedia>) {
    if (media.isEmpty()) return
    var open by remember { mutableStateOf<TicketDetailAllOfMedia?>(null) }
    CardBox {
        KINDS.forEach { (purpose, label) ->
            val set = media.filter { it.purpose == purpose }
            if (set.isNotEmpty()) {
                Text("$label · ${set.size}", fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(bottom = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    set.forEach { m ->
                        Column(Modifier.size(width = 112.dp, height = 140.dp)) {
                            Thumb(portal, m, 96) { open = m }
                            Text(m.latitude?.let { placeText(it.toDouble(), m.longitude!!.toDouble(), m.gpsAccuracyM?.toDouble()) } ?: "No location recorded",
                                fontSize = 10.sp, lineHeight = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
    }
    open?.let { m ->
        Dialog({ open = null }, DialogProperties(usePlatformDefaultWidth = false)) {
            Column(Modifier.fillMaxSize().background(Color.Black).clickable { open = null }.padding(16.dp),
                verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                Thumb(portal, m, null) { open = null }
                Text(KINDS.toMap()[m.purpose] ?: m.purpose ?: "", color = Color.White, modifier = Modifier.padding(top = 12.dp))
                Text(whenText(m.capturedAt), color = Color.White.copy(alpha = .7f), fontSize = 13.sp)
                Text(m.latitude?.let { "Taken at ${placeText(it.toDouble(), m.longitude!!.toDouble(), m.gpsAccuracyM?.toDouble())}" } ?: "No location recorded with this photograph",
                    color = Color.White.copy(alpha = .7f), fontSize = 13.sp)
                Text("Tap to close", color = Color.White.copy(alpha = .5f), fontSize = 12.sp)
            }
        }
    }
}

@Composable
private fun Thumb(portal: Portal, m: TicketDetailAllOfMedia, sizeDp: Int?, onClick: () -> Unit) {
    val id = m.id ?: return
    var img by remember(id) { mutableStateOf(cache.get(id)) }
    var failed by remember(id) { mutableStateOf(false) }
    LaunchedEffect(id) { if (img == null) runCatching { load(portal, id) }.onSuccess { img = it; failed = it == null }.onFailure { failed = true } }
    val box = (if (sizeDp != null) Modifier.size(sizeDp.dp) else Modifier.fillMaxWidth()).clip(RoundedCornerShape(10.dp))
        .background(MaterialTheme.colorScheme.surfaceVariant).clickable(onClick = onClick)
    Box(box, contentAlignment = Alignment.Center) {
        when {
            img != null -> Image(img!!, null, contentScale = if (sizeDp != null) ContentScale.Crop else ContentScale.Fit,
                modifier = if (sizeDp != null) Modifier.fillMaxSize() else Modifier.fillMaxWidth())
            failed -> Muted("Not available")
            else -> CircularProgressIndicator(Modifier.size(24.dp))
        }
    }
}
