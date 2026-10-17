package `in`.ncl.civilportal.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import `in`.ncl.civilportal.ui.theme.CpSchemes
import `in`.ncl.civilportal.ui.theme.CpTokens
import `in`.ncl.civilportal.ui.theme.cpScheme

/**
 * Profile → Appearance (2026-10-15): light or dark, and one of the seven
 * colour schemes of the web's person menu, from the same token file. A scheme
 * changes the header, buttons and surfaces only; the status colours — on time,
 * at risk, late — are the same in every scheme, because they carry meaning.
 * The choice stays on this phone.
 */
@Composable
fun AppearanceCard(model: AppModel) {
    val g = model.graph
    val current = cpScheme(g.scheme).id
    CardBox {
        Text("Appearance", fontWeight = FontWeight.SemiBold)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("system" to "Follow the phone", "light" to "Light", "dark" to "Dark").forEach { (id, label) ->
                FilterChip(g.theme == id, { g.setLook(theme = id) }, label = { Text(label) })
            }
        }
        Muted("Colour scheme")
        CpSchemes.forEach { sc ->
            val on = sc.id == current
            val shape = RoundedCornerShape(CpTokens.radiusInput)
            Row(Modifier.fillMaxWidth().heightIn(min = 56.dp)
                .border(if (on) 2.dp else 1.dp, if (on) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant, shape)
                .clickable { g.setLook(scheme = sc.id) }
                .semantics { role = Role.RadioButton; selected = on }
                .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy((-6).dp)) {
                    sc.swatch.forEach { c ->
                        Box(Modifier.size(22.dp).background(c, CircleShape).border(1.dp, MaterialTheme.colorScheme.outline, CircleShape))
                    }
                }
                Column(Modifier.weight(1f)) {
                    Text(sc.name, fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal)
                    Text(sc.note, fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (on) Icon(Icons.Filled.CheckCircle, "Chosen", tint = MaterialTheme.colorScheme.primary)
            }
        }
        Muted("Status colours — on time, at risk, late — stay the same in every scheme.")
    }
}
