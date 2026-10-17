// GENERATED from tokens/tokens.json by tokens/build-tokens.mjs. Do not edit.
package `in`.ncl.civilportal.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

object CpTokens {
    val lightBg = Color(0xFFF8F6EF)
    val lightSurface = Color(0xFFFFFFFF)
    val lightMuted = Color(0xFFEFEDE4)
    val lightTint = Color(0xFFE8F4F4)
    val lightBorder = Color(0xFFEAE8E0)
    val lightBorderStrong = Color(0xFFDDD9CC)
    val lightText = Color(0xFF1C2B2B)
    val lightTextMuted = Color(0xFF617074)
    val lightPrimary = Color(0xFF0F4C4C)
    val lightPrimaryHover = Color(0xFF0C3F3F)
    val lightPrimaryPressed = Color(0xFF0A3333)
    val lightPrimaryButton = Color(0xFF0F4C4C)
    val lightOnPrimary = Color(0xFFFFFFFF)
    val lightSidebar = Color(0xFF0F4C4C)
    val lightRowHover = Color(0xFFFBFAF6)
    val lightFocus = Color(0xFF0F4C4C)
    val darkBg = Color(0xFF0E1A1A)
    val darkSurface = Color(0xFF152424)
    val darkMuted = Color(0xFF1B2E2E)
    val darkTint = Color(0xFF1D3838)
    val darkBorder = Color(0xFF22393A)
    val darkBorderStrong = Color(0xFF2E4A4B)
    val darkText = Color(0xFFE7EDEA)
    val darkTextMuted = Color(0xFFA4B4B3)
    val darkPrimary = Color(0xFF8FD3CB)
    val darkPrimaryHover = Color(0xFF1F7A7A)
    val darkPrimaryPressed = Color(0xFF0A3333)
    val darkPrimaryButton = Color(0xFF1A6B6B)
    val darkOnPrimary = Color(0xFFFFFFFF)
    val darkSidebar = Color(0xFF0B2626)
    val darkRowHover = Color(0xFF182929)
    val darkFocus = Color(0xFF8FD3CB)
    val primaryDark = Color(0xFF0A3333)
    val secondary = Color(0xFF2E7D32)
    val gold = Color(0xFFC9A96A)
    val goldHover = Color(0xFFBF9C58)
    val goldText = Color(0xFFB08F4E)
    val emSlot = Color(0xFF7A4B1F)
    val radiusXs = 6.dp
    val radiusInput = 10.dp
    val radiusCard = 14.dp
    val radiusCardLarge = 16.dp
    val radiusDialog = 20.dp
    val radiusSheet = 24.dp
    val minTouchTarget = 44.dp
}

/** Status colours carry meaning only; always pair with an icon and a label. */
@Immutable
data class CpStatus(val fg: Color, val bg: Color)

@Immutable
data class CpStatusColors(
    val resolved: CpStatus,
    val atRisk: CpStatus,
    val breached: CpStatus,
    val info: CpStatus,
    val reopened: CpStatus,
    val awaiting: CpStatus
)

private val LightStatus = CpStatusColors(
    resolved = CpStatus(Color(0xFF1F6F4A), Color(0xFFE6F2EC)),
    atRisk = CpStatus(Color(0xFF8A5A00), Color(0xFFFBF1DC)),
    breached = CpStatus(Color(0xFFA32A21), Color(0xFFFBE7E5)),
    info = CpStatus(Color(0xFF2C5A8A), Color(0xFFE6EEF7)),
    reopened = CpStatus(Color(0xFF6A3D8F), Color(0xFFF1EAF7)),
    awaiting = CpStatus(Color(0xFF5B4FA8), Color(0xFFECEAF8))
)
private val DarkStatus = CpStatusColors(
    resolved = CpStatus(Color(0xFF7FD3A6), Color(0xFF173328)),
    atRisk = CpStatus(Color(0xFFE8B25A), Color(0xFF33280F)),
    breached = CpStatus(Color(0xFFF0877E), Color(0xFF3A1C1A)),
    info = CpStatus(Color(0xFF8DB6E0), Color(0xFF16263A)),
    reopened = CpStatus(Color(0xFFC3A3E0), Color(0xFF2A1F36)),
    awaiting = CpStatus(Color(0xFFA99FEA), Color(0xFF221F3A))
)
val LocalCpStatus = staticCompositionLocalOf { LightStatus }

/** The scheme's own colours outside Material's slots: the header, the hero's gradient, gold, links. */
@Immutable
data class CpBrand(val header: Color, val heroEnd: Color, val gold: Color, val link: Color)

@Immutable
class CpScheme(val id: String, val name: String, val note: String,
               val light: ColorScheme, val dark: ColorScheme,
               val lightBrand: CpBrand, val darkBrand: CpBrand, val swatch: List<Color>)

/** Every slot is set from the tokens; never the default Material purple. The first is the default. */
val CpSchemes: List<CpScheme> = listOf(
    CpScheme(
        id = "teal", name = "Colony teal", note = "Deep teal, cream and gold. The portal's own.",
        light = lightColorScheme(
            primary = Color(0xFF0F4C4C), onPrimary = Color(0xFFFFFFFF),
            secondary = CpTokens.secondary, tertiary = Color(0xFFC9A96A),
            background = Color(0xFFF8F6EF), onBackground = Color(0xFF1C2B2B),
            surface = Color(0xFFFFFFFF), onSurface = Color(0xFF1C2B2B),
            surfaceVariant = Color(0xFFEFEDE4), onSurfaceVariant = Color(0xFF617074),
            outline = Color(0xFFDDD9CC), outlineVariant = Color(0xFFEAE8E0),
            error = Color(0xFFA32A21)
        ),
        dark = darkColorScheme(
            primary = Color(0xFF1A6B6B), onPrimary = Color(0xFFFFFFFF),
            secondary = CpTokens.secondary, tertiary = Color(0xFFC9A96A),
            background = Color(0xFF0E1A1A), onBackground = Color(0xFFE7EDEA),
            surface = Color(0xFF152424), onSurface = Color(0xFFE7EDEA),
            surfaceVariant = Color(0xFF1B2E2E), onSurfaceVariant = Color(0xFFA4B4B3),
            outline = Color(0xFF2E4A4B), outlineVariant = Color(0xFF22393A),
            error = Color(0xFFF0877E)
        ),
        lightBrand = CpBrand(header = Color(0xFF0F4C4C), heroEnd = Color(0xFF0A3333), gold = Color(0xFFC9A96A), link = Color(0xFF0F4C4C)),
        darkBrand = CpBrand(header = Color(0xFF0F4C4C), heroEnd = Color(0xFF0A3333), gold = Color(0xFFC9A96A), link = Color(0xFF8FD3CB)),
        swatch = listOf(Color(0xFF0F4C4C), Color(0xFF0F4C4C), Color(0xFFC9A96A), Color(0xFFF8F6EF))
    ),
    CpScheme(
        id = "ember", name = "Coal and ember", note = "Charcoal and ember orange. NCL at a glance.",
        light = lightColorScheme(
            primary = Color(0xFFB54A1B), onPrimary = Color(0xFFFFFFFF),
            secondary = CpTokens.secondary, tertiary = Color(0xFFE8B04A),
            background = Color(0xFFF6F5F3), onBackground = Color(0xFF1F2328),
            surface = Color(0xFFFFFFFF), onSurface = Color(0xFF1F2328),
            surfaceVariant = Color(0xFFEEECE8), onSurfaceVariant = Color(0xFF5E6470),
            outline = Color(0xFFD6D2CB), outlineVariant = Color(0xFFE6E3DE),
            error = Color(0xFFA32A21)
        ),
        dark = darkColorScheme(
            primary = Color(0xFFC2511F), onPrimary = Color(0xFFFFFFFF),
            secondary = CpTokens.secondary, tertiary = Color(0xFFE8B04A),
            background = Color(0xFF121417), onBackground = Color(0xFFECEDEE),
            surface = Color(0xFF1B1E22), onSurface = Color(0xFFECEDEE),
            surfaceVariant = Color(0xFF23272C), onSurfaceVariant = Color(0xFFA3A9B2),
            outline = Color(0xFF3A4048), outlineVariant = Color(0xFF2B3036),
            error = Color(0xFFF0877E)
        ),
        lightBrand = CpBrand(header = Color(0xFF1F2328), heroEnd = Color(0xFF16191D), gold = Color(0xFFE8B04A), link = Color(0xFFB4471A)),
        darkBrand = CpBrand(header = Color(0xFF1F2328), heroEnd = Color(0xFF16191D), gold = Color(0xFFE8B04A), link = Color(0xFFF08A5A)),
        swatch = listOf(Color(0xFF1F2328), Color(0xFFB54A1B), Color(0xFFE8B04A), Color(0xFFF6F5F3))
    ),
    CpScheme(
        id = "indigo", name = "Civic indigo", note = "Indigo with saffron, close to India's government services.",
        light = lightColorScheme(
            primary = Color(0xFF2E3C8C), onPrimary = Color(0xFFFFFFFF),
            secondary = CpTokens.secondary, tertiary = Color(0xFFF2A23A),
            background = Color(0xFFF5F6FA), onBackground = Color(0xFF1A2040),
            surface = Color(0xFFFFFFFF), onSurface = Color(0xFF1A2040),
            surfaceVariant = Color(0xFFECEEF5), onSurfaceVariant = Color(0xFF5A6180),
            outline = Color(0xFFD3D8E8), outlineVariant = Color(0xFFE3E6F0),
            error = Color(0xFFA32A21)
        ),
        dark = darkColorScheme(
            primary = Color(0xFF3A4AA8), onPrimary = Color(0xFFFFFFFF),
            secondary = CpTokens.secondary, tertiary = Color(0xFFF2A23A),
            background = Color(0xFF0E1124), onBackground = Color(0xFFE8EAF6),
            surface = Color(0xFF161B35), onSurface = Color(0xFFE8EAF6),
            surfaceVariant = Color(0xFF1D2342), onSurfaceVariant = Color(0xFFA6ACCB),
            outline = Color(0xFF343C66), outlineVariant = Color(0xFF262D52),
            error = Color(0xFFF0877E)
        ),
        lightBrand = CpBrand(header = Color(0xFF24306E), heroEnd = Color(0xFF1A2350), gold = Color(0xFFF2A23A), link = Color(0xFF2E3C8C)),
        darkBrand = CpBrand(header = Color(0xFF24306E), heroEnd = Color(0xFF1A2350), gold = Color(0xFFF2A23A), link = Color(0xFF9AA8F0)),
        swatch = listOf(Color(0xFF24306E), Color(0xFF2E3C8C), Color(0xFFF2A23A), Color(0xFFF5F6FA))
    ),
    CpScheme(
        id = "laterite", name = "Laterite and sal", note = "Brick-red soil and sal-forest green.",
        light = lightColorScheme(
            primary = Color(0xFF2F5A34), onPrimary = Color(0xFFFFFFFF),
            secondary = CpTokens.secondary, tertiary = Color(0xFFC98A3A),
            background = Color(0xFFF4EFE6), onBackground = Color(0xFF2B1D16),
            surface = Color(0xFFFFFDF9), onSurface = Color(0xFF2B1D16),
            surfaceVariant = Color(0xFFEDE6DA), onSurfaceVariant = Color(0xFF6E5E52),
            outline = Color(0xFFDACDB8), outlineVariant = Color(0xFFE8DFD0),
            error = Color(0xFFA32A21)
        ),
        dark = darkColorScheme(
            primary = Color(0xFF3A6B40), onPrimary = Color(0xFFFFFFFF),
            secondary = CpTokens.secondary, tertiary = Color(0xFFC98A3A),
            background = Color(0xFF1A1310), onBackground = Color(0xFFF1E9E1),
            surface = Color(0xFF251B16), onSurface = Color(0xFFF1E9E1),
            surfaceVariant = Color(0xFF2E231D), onSurfaceVariant = Color(0xFFBBA999),
            outline = Color(0xFF4A3A30), outlineVariant = Color(0xFF3A2C24),
            error = Color(0xFFF0877E)
        ),
        lightBrand = CpBrand(header = Color(0xFF7A2E1E), heroEnd = Color(0xFF5A2116), gold = Color(0xFFC98A3A), link = Color(0xFF2F5A34)),
        darkBrand = CpBrand(header = Color(0xFF7A2E1E), heroEnd = Color(0xFF5A2116), gold = Color(0xFFC98A3A), link = Color(0xFF9DBF6A)),
        swatch = listOf(Color(0xFF7A2E1E), Color(0xFF2F5A34), Color(0xFFC98A3A), Color(0xFFF4EFE6))
    ),
    CpScheme(
        id = "slate", name = "Monsoon slate", note = "Slate blue and leaf green. Quiet for a long day.",
        light = lightColorScheme(
            primary = Color(0xFF22405E), onPrimary = Color(0xFFFFFFFF),
            secondary = CpTokens.secondary, tertiary = Color(0xFF6FBF8E),
            background = Color(0xFFF2F5F7), onBackground = Color(0xFF16222E),
            surface = Color(0xFFFFFFFF), onSurface = Color(0xFF16222E),
            surfaceVariant = Color(0xFFE9EEF2), onSurfaceVariant = Color(0xFF586776),
            outline = Color(0xFFCFD9E2), outlineVariant = Color(0xFFDFE6EC),
            error = Color(0xFFA32A21)
        ),
        dark = darkColorScheme(
            primary = Color(0xFF2B5179), onPrimary = Color(0xFFFFFFFF),
            secondary = CpTokens.secondary, tertiary = Color(0xFF6FBF8E),
            background = Color(0xFF0D1620), onBackground = Color(0xFFE6EDF3),
            surface = Color(0xFF15212D), onSurface = Color(0xFFE6EDF3),
            surfaceVariant = Color(0xFF1B2937), onSurfaceVariant = Color(0xFF9FB0C0),
            outline = Color(0xFF2F4357), outlineVariant = Color(0xFF223243),
            error = Color(0xFFF0877E)
        ),
        lightBrand = CpBrand(header = Color(0xFF22405E), heroEnd = Color(0xFF162C42), gold = Color(0xFF6FBF8E), link = Color(0xFF22405E)),
        darkBrand = CpBrand(header = Color(0xFF22405E), heroEnd = Color(0xFF162C42), gold = Color(0xFF6FBF8E), link = Color(0xFF8FB8DE)),
        swatch = listOf(Color(0xFF22405E), Color(0xFF22405E), Color(0xFF6FBF8E), Color(0xFFF2F5F7))
    ),
    CpScheme(
        id = "contrast", name = "Field contrast", note = "Black and safety yellow. Readable in sunlight.",
        light = lightColorScheme(
            primary = Color(0xFF111111), onPrimary = Color(0xFFFFFFFF),
            secondary = CpTokens.secondary, tertiary = Color(0xFFFFD23F),
            background = Color(0xFFFFFFFF), onBackground = Color(0xFF111111),
            surface = Color(0xFFFFFFFF), onSurface = Color(0xFF111111),
            surfaceVariant = Color(0xFFF2F2F2), onSurfaceVariant = Color(0xFF3D3D3D),
            outline = Color(0xFF111111), outlineVariant = Color(0xFFBDBDBD),
            error = Color(0xFFA32A21)
        ),
        dark = darkColorScheme(
            primary = Color(0xFFFFD23F), onPrimary = Color(0xFF111111),
            secondary = CpTokens.secondary, tertiary = Color(0xFFFFD23F),
            background = Color(0xFF000000), onBackground = Color(0xFFFFFFFF),
            surface = Color(0xFF121212), onSurface = Color(0xFFFFFFFF),
            surfaceVariant = Color(0xFF1C1C1C), onSurfaceVariant = Color(0xFFD0D0D0),
            outline = Color(0xFFEDEDED), outlineVariant = Color(0xFF5A5A5A),
            error = Color(0xFFF0877E)
        ),
        lightBrand = CpBrand(header = Color(0xFF111111), heroEnd = Color(0xFF000000), gold = Color(0xFFFFD23F), link = Color(0xFF111111)),
        darkBrand = CpBrand(header = Color(0xFF111111), heroEnd = Color(0xFF000000), gold = Color(0xFFFFD23F), link = Color(0xFFFFD23F)),
        swatch = listOf(Color(0xFF111111), Color(0xFF111111), Color(0xFFFFD23F), Color(0xFFFFFFFF))
    ),
    CpScheme(
        id = "navy", name = "Navy, tricolour accent", note = "Formal navy; saffron, white and green in the strip.",
        light = lightColorScheme(
            primary = Color(0xFF0B2D5B), onPrimary = Color(0xFFFFFFFF),
            secondary = CpTokens.secondary, tertiary = Color(0xFFFF9933),
            background = Color(0xFFF7F8FA), onBackground = Color(0xFF0F1E33),
            surface = Color(0xFFFFFFFF), onSurface = Color(0xFF0F1E33),
            surfaceVariant = Color(0xFFEEF1F5), onSurfaceVariant = Color(0xFF55627A),
            outline = Color(0xFFD0D7E2), outlineVariant = Color(0xFFE1E5EC),
            error = Color(0xFFA32A21)
        ),
        dark = darkColorScheme(
            primary = Color(0xFF1E4A85), onPrimary = Color(0xFFFFFFFF),
            secondary = CpTokens.secondary, tertiary = Color(0xFFFF9933),
            background = Color(0xFF07142A), onBackground = Color(0xFFE6ECF5),
            surface = Color(0xFF0E1E38), onSurface = Color(0xFFE6ECF5),
            surfaceVariant = Color(0xFF142644), onSurfaceVariant = Color(0xFFA1AFC6),
            outline = Color(0xFF2A3F62), outlineVariant = Color(0xFF1C2E4C),
            error = Color(0xFFF0877E)
        ),
        lightBrand = CpBrand(header = Color(0xFF0B2D5B), heroEnd = Color(0xFF061B38), gold = Color(0xFFFF9933), link = Color(0xFF0B2D5B)),
        darkBrand = CpBrand(header = Color(0xFF0B2D5B), heroEnd = Color(0xFF061B38), gold = Color(0xFFFF9933), link = Color(0xFF8FB3E8)),
        swatch = listOf(Color(0xFF0B2D5B), Color(0xFF0B2D5B), Color(0xFFFF9933), Color(0xFFF7F8FA))
    )
)
fun cpScheme(id: String?): CpScheme = CpSchemes.firstOrNull { it.id == id } ?: CpSchemes[0]

val LocalCpBrand = staticCompositionLocalOf { CpSchemes[0].lightBrand }

private val CpShapes = Shapes(
    small = RoundedCornerShape(CpTokens.radiusInput),
    medium = RoundedCornerShape(CpTokens.radiusCard),
    large = RoundedCornerShape(CpTokens.radiusDialog)
)

@Composable
fun CpTheme(scheme: String? = null, darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val sc = cpScheme(scheme)
    androidx.compose.runtime.CompositionLocalProvider(
        LocalCpStatus provides if (darkTheme) DarkStatus else LightStatus,
        LocalCpBrand provides if (darkTheme) sc.darkBrand else sc.lightBrand
    ) {
        MaterialTheme(
            colorScheme = if (darkTheme) sc.dark else sc.light,
            shapes = CpShapes,
            content = content
        )
    }
}
