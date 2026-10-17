/**
 * One token file, three platforms.
 *
 *   node tokens/build-tokens.mjs        (or: npm run tokens, from web/)
 *
 * Reads tokens/tokens.json and writes the web CSS variables, the Android
 * Compose theme and the iOS SwiftUI theme. The three outputs are generated
 * and must never be edited by hand: a colour changed in one platform only
 * is how three apps drift apart.
 *
 * A plain script rather than Style Dictionary: the token set is small and
 * flat, and one readable file is easier to keep right than a build config.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const t = JSON.parse(fs.readFileSync(path.join(root, 'tokens/tokens.json'), 'utf8'));
const kebab = (s) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
const banner = 'GENERATED from tokens/tokens.json by tokens/build-tokens.mjs. Do not edit.';
const write = (rel, text) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  console.log('  wrote', rel);
};

/* ------------------------------ web ------------------------------ */
const vars = (mode) => {
  const c = t.color[mode];
  const lines = Object.entries(c).map(([k, v]) => `  --${kebab(k)}: ${v};`);
  for (const [k, v] of Object.entries(t.color.status)) {
    lines.push(`  --status-${kebab(k)}: ${mode === 'dark' ? v.darkFg : v.fg};`);
    lines.push(`  --status-${kebab(k)}-bg: ${mode === 'dark' ? v.darkBg : v.bg};`);
  }
  return lines.join('\n');
};
const brand = Object.entries(t.color.brand).map(([k, v]) => `  --${kebab(k)}: ${v};`).join('\n');
write('web/src/styles/tokens.css', `/* ${banner} */
:root {
${brand}
  --scrim: ${t.color.scrim};
${Object.entries(t.radius).map(([k, v]) => `  --radius-${kebab(k)}: ${v}px;`).join('\n')}
  --ease: cubic-bezier(${t.motion.easing.join(',')});
  --fast: ${t.motion.fast}ms; --base: ${t.motion.base}ms; --sheet: ${t.motion.sheet}ms; --hero: ${t.motion.hero}ms;
${vars('light')}
}
/* dark: the user's choice wins; otherwise follow the system */
:root[data-theme="dark"] {
${vars('dark')}
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
${vars('dark').replace(/^/gm, '  ')}
  }
}
`);

/* -------------------------- web: schemes -------------------------- */
/* A person may choose a colour scheme (data-scheme on <html>). A scheme
   overrides the brand and surface colours only; status colours never
   change. The selectors outrank the defaults above in every case: an
   explicit theme, or the system's when none is chosen. */
const decl = (o) => Object.entries(o).map(([k, v]) => `  --${kebab(k)}: ${v};`).join('\n');
const schemes = Object.entries(t.schemes || {}).filter(([k, v]) => k[0] !== '$' && v.light);
let css = '';
for (const [id, sc] of schemes) {
  const light = decl({ ...sc.light, ...sc.brand }) + `\n  --scrim: ${sc.scrim};`;
  const dark = decl({ ...sc.dark, ...sc.brand }) + `\n  --scrim: ${sc.scrim};`;
  css += `\n/* ${sc.name} */\n:root[data-scheme="${id}"]:not([data-theme="dark"]) {\n${light}\n}\n` +
    `:root[data-scheme="${id}"][data-theme="dark"] {\n${dark}\n}\n` +
    `@media (prefers-color-scheme: dark) {\n  :root[data-scheme="${id}"]:not([data-theme="light"]) {\n${dark.replace(/^/gm, '  ')}\n  }\n}\n`;
}
write('web/src/styles/schemes.css', `/* ${banner} */\n${css}`);
fs.writeFileSync(path.join(root, 'web/src/lib/schemes.json'), JSON.stringify(Object.fromEntries(
  Object.entries(t.schemes || {}).filter(([k]) => k[0] !== '$').map(([id, sc]) => [id, {
    name: sc.name, note: sc.note,
    swatch: [sc.light?.sidebar || t.color.light.sidebar, sc.light?.primaryButton || t.color.light.primaryButton,
      sc.brand?.gold || t.color.brand.gold, sc.light?.bg || t.color.light.bg]
  }])), null, 2) + '\n');
console.log('  wrote web/src/lib/schemes.json');

/* ---------------------------- Android ---------------------------- */
const hex = (h) => `Color(0xFF${h.slice(1).toUpperCase()})`;
const kColors = (mode, prefix) => Object.entries(t.color[mode])
  .map(([k, v]) => `    val ${prefix}${k[0].toUpperCase()}${k.slice(1)} = ${hex(v)}`).join('\n');
/* Colour schemes (2026-10-15): the same seven as the web's, chosen on the
   phone's Profile. A scheme overrides the brand and surface colours only;
   the status colours above never change, in any scheme. */
const allSchemes = Object.entries(t.schemes || {}).filter(([k]) => k[0] !== '$');
const merged = (sc, mode) => ({ ...t.color[mode], ...(sc[mode] || {}) });
const brandOf = (sc) => ({ ...t.color.brand, ...(sc.brand || {}) });
const kScheme = (sc, mode) => {
  const c = merged(sc, mode), br = brandOf(sc);
  return `${mode}ColorScheme(
            primary = ${hex(c.primaryButton)}, onPrimary = ${hex(c.onPrimary)},
            secondary = CpTokens.secondary, tertiary = ${hex(br.gold)},
            background = ${hex(c.bg)}, onBackground = ${hex(c.text)},
            surface = ${hex(c.surface)}, onSurface = ${hex(c.text)},
            surfaceVariant = ${hex(c.muted)}, onSurfaceVariant = ${hex(c.textMuted)},
            outline = ${hex(c.borderStrong)}, outlineVariant = ${hex(c.border)},
            error = ${hex(mode === 'dark' ? t.color.status.breached.darkFg : t.color.status.breached.fg)}
        )`;
};
const kBrand = (sc, mode) => {
  const c = merged(sc, mode), l = merged(sc, 'light'), br = brandOf(sc);
  // the header keeps the scheme's own colour in dark mode too, as the web's sidebar does
  return `CpBrand(header = ${hex(l.sidebar)}, heroEnd = ${hex(br.primaryDark)}, gold = ${hex(br.gold)}, link = ${hex(c.primary)})`;
};
const kStr = (x) => JSON.stringify(x || '');
const kSchemes = allSchemes.map(([id, sc]) => `    CpScheme(
        id = ${kStr(id)}, name = ${kStr(sc.name)}, note = ${kStr(sc.note)},
        light = ${kScheme(sc, 'light')},
        dark = ${kScheme(sc, 'dark')},
        lightBrand = ${kBrand(sc, 'light')},
        darkBrand = ${kBrand(sc, 'dark')},
        swatch = listOf(${[merged(sc, 'light').sidebar, merged(sc, 'light').primaryButton, brandOf(sc).gold, merged(sc, 'light').bg].map(hex).join(', ')})
    )`).join(',\n');

write('native/android/app/src/main/java/in/ncl/civilportal/ui/theme/CpTheme.kt', `// ${banner}
package \`in\`.ncl.civilportal.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

object CpTokens {
${kColors('light', 'light')}
${kColors('dark', 'dark')}
${Object.entries(t.color.brand).map(([k, v]) => `    val ${k} = ${hex(v)}`).join('\n')}
${Object.entries(t.radius).filter(([k]) => k !== 'pill').map(([k, v]) => `    val radius${k[0].toUpperCase()}${k.slice(1)} = ${v}.dp`).join('\n')}
    val minTouchTarget = ${t.touch.minTarget}.dp
}

/** Status colours carry meaning only; always pair with an icon and a label. */
@Immutable
data class CpStatus(val fg: Color, val bg: Color)

@Immutable
data class CpStatusColors(
${Object.keys(t.color.status).map((k) => `    val ${k}: CpStatus`).join(',\n')}
)

private val LightStatus = CpStatusColors(
${Object.entries(t.color.status).map(([k, v]) => `    ${k} = CpStatus(${hex(v.fg)}, ${hex(v.bg)})`).join(',\n')}
)
private val DarkStatus = CpStatusColors(
${Object.entries(t.color.status).map(([k, v]) => `    ${k} = CpStatus(${hex(v.darkFg)}, ${hex(v.darkBg)})`).join(',\n')}
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
${kSchemes}
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
`);

/* ------------------------------ iOS ------------------------------ */
const sw = (h) => {
  const n = parseInt(h.slice(1), 16);
  const f = (x) => +(x / 255).toFixed(4);
  return `Color(red: ${f((n >> 16) & 255)}, green: ${f((n >> 8) & 255)}, blue: ${f(n & 255)})`;
};
const adaptive = (name, light, dark) =>
  `    static let cp${name[0].toUpperCase()}${name.slice(1)} = Color(light: ${sw(light)}, dark: ${sw(dark)})`;
write('native/ios/CivilPortal/Theme/CpTheme.swift', `// ${banner}
import SwiftUI
import UIKit

extension Color {
    /// A colour that follows the system light/dark setting.
    init(light: Color, dark: Color) {
        self.init(UIColor { $0.userInterfaceStyle == .dark ? UIColor(dark) : UIColor(light) })
    }

${Object.keys(t.color.light).map((k) => adaptive(k, t.color.light[k], t.color.dark[k])).join('\n')}
${Object.entries(t.color.brand).map(([k, v]) => `    static let cp${k[0].toUpperCase()}${k.slice(1)} = ${sw(v)}`).join('\n')}
    // Status: meaning only, always with an SF Symbol and a label.
${Object.entries(t.color.status).map(([k, v]) => adaptive(k, v.fg, v.darkFg) + '\n' + adaptive(k + 'Bg', v.bg, v.darkBg)).join('\n')}
}

enum CpRadius {
${Object.entries(t.radius).map(([k, v]) => `    static let ${k}: CGFloat = ${v}`).join('\n')}
}

enum CpSpace {
${Object.entries(t.space).map(([k, v]) => `    static let s${k}: CGFloat = ${v}`).join('\n')}
}

enum CpFont {
    /// Poppins, scaled with Dynamic Type relative to the matching text style.
${Object.entries(t.type).map(([k, v]) => `    static let ${k} = Font.custom("${t.font.ui}", size: ${v.size}, relativeTo: .${{ display: 'largeTitle', h1: 'title', h2: 'title2', h3: 'title3', h4: 'headline', body: 'body', small: 'subheadline', caption: 'caption', label: 'caption2', kpi: 'title' }[k]}).weight(.${{ 400: 'regular', 500: 'medium', 600: 'semibold', 700: 'bold' }[v.weight]})`).join('\n')}
}

enum CpTouch {
    static let minTarget: CGFloat = ${t.touch.minTarget}
}
`);
console.log('tokens built');
