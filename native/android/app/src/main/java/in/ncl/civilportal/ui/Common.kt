package `in`.ncl.civilportal.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** A scrolling page with a heading, in the portal's spacing. */
@Composable
fun Page(title: String, sub: String? = null, content: @Composable ColumnScope.() -> Unit) {
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            Modifier.safeDrawingPadding().verticalScroll(rememberScrollState()).padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            Text(title, fontSize = 26.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
            if (sub != null) Text(sub, color = MaterialTheme.colorScheme.onSurfaceVariant)
            content()
        }
    }
}

/* 48 dp: the design's minimum touch target is 44 */
@Composable fun Primary(text: String, enabled: Boolean = true, onClick: () -> Unit) =
    Button(onClick, Modifier.fillMaxWidth().heightIn(min = 48.dp), enabled = enabled) { Text(text) }
@Composable fun Secondary(text: String, enabled: Boolean = true, onClick: () -> Unit) =
    OutlinedButton(onClick, Modifier.fillMaxWidth().heightIn(min = 48.dp), enabled = enabled) { Text(text) }
@Composable fun Quiet(text: String, onClick: () -> Unit) = TextButton(onClick) { Text(text) }

@Composable fun Note(text: String, error: Boolean = false) =
    Text(text, color = if (error) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
        style = MaterialTheme.typography.bodyMedium)
