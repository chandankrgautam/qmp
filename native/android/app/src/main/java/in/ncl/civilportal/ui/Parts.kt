package `in`.ncl.civilportal.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import kotlinx.coroutines.delay
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import `in`.ncl.civilportal.ui.theme.CpTokens
import `in`.ncl.civilportal.ui.theme.LocalCpBrand

/** A phone screen in the design's shape: teal header (title, sub-line, back), scrolling body. */
@Composable
fun Shell(title: String, sub: String? = null, onBack: (() -> Unit)? = null, actions: @Composable () -> Unit = {},
          content: @Composable ColumnScope.() -> Unit) {
    // a Surface, not a bare background: it also sets the text colour, which
    // otherwise stays black on the dark theme (seen on the phone, 2026-10-10)
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) { Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().background(LocalCpBrand.current.header).statusBarsPadding().padding(horizontal = 8.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically) {
            if (onBack != null) IconButton(onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back", tint = Color.White) }
            else Box(Modifier.size(12.dp))
            Column(Modifier.weight(1f)) {
                Text(title, color = Color.White, fontSize = 19.sp, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (sub != null) Text(sub, color = Color.White.copy(alpha = .8f), fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            actions()
        }
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).imePadding().navigationBarsPadding().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp), content = content)
    } }
}

/**
 * Keeps a screen current without a push service (that comes in A5): reload
 * when the app comes back to the front, and every half minute while it is
 * open. `tick` is called on the main thread; the caller reloads.
 */
@Composable
fun AutoRefresh(everySeconds: Long = 30, tick: () -> Unit) {
    val current by rememberUpdatedState(tick)
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { current() }
    LaunchedEffect(Unit) { while (true) { delay(everySeconds * 1000); current() } }
}

@Composable
fun CardBox(modifier: Modifier = Modifier, onClick: (() -> Unit)? = null, content: @Composable ColumnScope.() -> Unit) {
    val shape = RoundedCornerShape(CpTokens.radiusCard)
    Surface(modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)
        .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier), shape = shape,
        color = MaterialTheme.colorScheme.surface) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp), content = content)
    }
}

/** Status as a coloured label — colour never alone: the words say it. */
@Composable
fun StatusChip(text: String, tone: Tone) {
    val c = toneColors(tone)
    Text(text, color = c.fg, fontSize = 12.sp, fontWeight = FontWeight.SemiBold,
        modifier = Modifier.background(c.bg, RoundedCornerShape(50)).padding(horizontal = 10.dp, vertical = 4.dp))
}

@Composable
fun SectionLabel(text: String) =
    Text(text.uppercase(), fontSize = 12.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp,
        color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp))

@Composable
fun Muted(text: String) = Text(text, fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)

/** The SLA ring: how much of the window is used, with the time left (or late) in the middle. */
@Composable
fun SlaRing(fraction: Float, tone: Tone, label: String, size: Dp = 56.dp, sub: String? = null) {
    val c = toneColors(tone)
    Box(Modifier.size(size), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(progress = { fraction }, modifier = Modifier.fillMaxSize(), color = c.fg,
            trackColor = c.bg, strokeWidth = 5.dp)
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(label, fontWeight = FontWeight.Bold, color = c.fg, fontSize = if (size > 60.dp) 18.sp else 13.sp)
            if (sub != null) Text(sub, fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
fun Loading() = Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
