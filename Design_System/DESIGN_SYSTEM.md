# Civil Portal: Design System (v4 theme)

This is the single reference for building the web app (React + Tailwind + shadcn/ui), Android (Compose M3) and iOS (SwiftUI). The machine-readable copy is in `tokens.json`; the rationale is in `DESIGN_DECISIONS.md`. The values below match the prototypes in `designs/`.

---

## 1. Colour

### 1.1 Light theme
| Token | Hex | Use |
|---|---|---|
| `bg` | `#F8F6EF` | Page background (warm cream) |
| `surface` | `#FFFFFF` | Cards, tables, dialogs, inputs |
| `muted` | `#EFEDE4` | Chip fill, ghost-button hover, skeleton base |
| `tint` | `#E8F4F4` | Selected row, active tab, selected tile |
| `border` | `#EAE8E0` | Hairline card/table borders |
| `border-strong` | `#DDD9CC` | Inputs, outline buttons, dividers |
| `text` | `#1C2B2B` | Primary text (14.9:1 on bg) |
| `text-muted` | `#617074` | Secondary text, captions (5.0:1 on bg) |
| `primary` | `#0F4C4C` | Primary buttons, links, headings accent, sidebar |
| `primary-hover` | `#0C3F3F` | Primary hover |
| `primary-pressed` | `#0A3333` | Primary pressed; toast bg; text on gold |
| `on-primary` | `#FFFFFF` | Text/icons on primary |
| `sidebar` | `#0F4C4C` | Web sidebar, mobile app bar |

### 1.2 Dark theme
| Token | Hex |
|---|---|
| `bg` | `#0E1A1A` |
| `surface` | `#152424` |
| `muted` | `#1B2E2E` |
| `tint` | `#1D3838` |
| `border` | `#22393A` |
| `border-strong` | `#2E4A4B` |
| `text` | `#E7EDEA` |
| `text-muted` | `#A4B4B3` |
| `primary` (text/icon accent) | `#8FD3CB` |
| `primary-button` (fill) | `#1A6B6B` |
| `primary-button-hover` | `#1F7A7A` |
| `sidebar` | `#0B2626` |

### 1.3 Brand accents
| Token | Hex | Rule |
|---|---|---|
| `gold` | `#C9A96A` | Decorative only: active-nav dot and icon, SLA ring fill, logo ring, hero CTA fill (with `#0A3333` text) |
| `gold-text` | `#B08F4E` | Gold as text, ≥ 18px bold only |
| `secondary` | `#2E7D32` | Success emphasis, "Yes, it's fixed" |
| `em-accent` | `#7A4B1F` | **Reserved** for the future E&M portal, swapping `primary` accents only. Do not use in Civil. |

### 1.4 Status (semantic only; always pair with an icon and a text label)
| Status | Foreground | Light bg | Dark fg | Dark bg | Icon (Lucide) |
|---|---|---|---|---|---|
| Resolved / on time | `#1F6F4A` | `#E6F2EC` | `#7FD3A6` | `#173328` | `check-circle-2` |
| At risk / due soon | `#8A5A00` | `#FBF1DC` | `#E8B25A` | `#33280F` | `clock-alert` |
| Breached / overdue | `#A32A21` | `#FBE7E5` | `#F0877E` | `#3A1C1A` | `alert-octagon` |
| Info / assigned | `#2C5A8A` | `#E6EEF7` | `#8DB6E0` | `#16263A` | `info` |
| Reopened | `#6A3D8F` | `#F1EAF7` | `#C3A3E0` | `#2A1F36` | `rotate-ccw` |
| Awaiting acceptance | `#5B4FA8` | `#ECEAF8` | `#A99FEA` | `#221F3A` | `badge-check` |

### 1.5 Overlays
- Scrim: `rgba(10,51,51,0.50)`
- Hero text scrim: linear `#0A3333` at 92% fading to 0% (left to right)
- Focus ring: `#0F4C4C` (light) / `#8FD3CB` (dark), 2px, 2px offset

**Contrast:** all text is ≥ 4.5:1 on its actual background in both themes. Headline-scale text (≥ 24px) can go down to 3:1.

---

## 2. Typography

**Families**
- UI: **Poppins**, weights 400, 500, 600 and 700
- Hindi: **Noto Sans Devanagari**, weights 400, 500, 600 and 700. It is stacked after Poppins, so mixed strings render correctly.
- Quote: **Playfair Display** 600 italic, used only for hero and login pull-quotes
- Numbers: `font-variant-numeric: tabular-nums` on every KPI, table cell, timer and currency value

Stack: `Poppins, 'Noto Sans Devanagari', system-ui, sans-serif`

**Scale** (px / line-height / weight)
| Style | Size | LH | Weight | Tracking | Use |
|---|---|---|---|---|---|
| Display | 48 | 1.10 | 700 | -0.01em | Hero headline |
| H1 | 30 | 1.20 | 700 | -0.01em | Page title |
| H2 | 22 | 1.30 | 600 | 0 | Section title |
| H3 | 18 | 1.35 | 600 | 0 | Card title, dialog title |
| H4 | 16 | 1.40 | 600 | 0 | Sub-section, mobile card title |
| Body | 14 | 1.55 | 400 | 0 | Default text |
| Body-strong | 14 | 1.55 | 600 | 0 | Emphasis, table primary column |
| Small | 13 | 1.50 | 400 | 0 | Table cells, helper text |
| Caption | 12 | 1.40 | 500 | 0 | Meta, timestamps, chip text |
| Label | 11 | 1.30 | 600 | 0.08em, UPPERCASE | Table headers and section labels only |
| KPI | 30 | 1.10 | 700 | -0.01em | KPI tiles |
| Scorecard hero | 36 | 1.00 | 700 | -0.02em | SLA % inside the ring |

- **Hindi:** keep the same size and add 3–4px of line-height. Never set Devanagari below 12px.
- Mobile: Body 15, H1 24, Display 32. On iOS, map these to Dynamic Type (Body = `.body`, scaling allowed).
- Reading text max width: 72ch.

---

## 3. Spacing (4-pt)
| Token | px |
|---|---|
| `space-0.5` | 2 |
| `space-1` | 4 |
| `space-2` | 8 |
| `space-3` | 12 |
| `space-4` | 16 |
| `space-5` | 20 |
| `space-6` | 24 |
| `space-7` | 28 |
| `space-8` | 32 |
| `space-10` | 40 |
| `space-12` | 48 |
| `space-16` | 64 |

**Layout**
- Web: 12-column grid, 24px gutter, content padding 28px (≥ 1280) and 20px (< 1280). Sidebar 248px, collapsed to 72px.
- Top bar 64px. Page header gap to content 20px. Gap between cards 12–16px.
- Mobile: 16px screen padding, 12px gap between cards, app bar 64px + status bar, bottom tab bar 64px + safe area.
- **Density:** comfortable table rows are 52px with 16px cell x-padding; compact rows are 40px with 12px.

---

## 4. Radius
| Token | px | Applies to |
|---|---|---|
| `radius-xs` | 6 | Checkbox, tiny tags |
| `radius-sm` | 10 | Inputs, selects, textareas, OTP boxes |
| `radius-md` | 14 | Cards, tables, KPI tiles, list items |
| `radius-lg` | 16 | Large cards, mobile quarter card |
| `radius-xl` | 20 | Dialogs, contractor scorecard, login card |
| `radius-sheet` | 24 top only | Bottom sheets |
| `radius-pill` | 999 | Buttons, chips, badges, segmented controls, toasts, avatars |

---

## 5. Elevation
The default is flat: a surface plus a 1px `border`. Shadows are reserved for things that float.
| Level | Value | Use |
|---|---|---|
| `e0` | none + 1px border | Cards, tables, tiles |
| `e1` | `0 1px 2px rgba(10,51,51,.06)` | Hovered interactive card |
| `e2` | `0 8px 24px rgba(10,51,51,.12)` | Menus, popovers, combobox list, command palette |
| `e3` | `0 24px 64px rgba(10,51,51,.28)` | Dialogs |
| `e-sheet` | `0 -12px 32px rgba(0,0,0,.25)` | Bottom sheets, sticky bottom action bars |
| `e-toast` | `0 12px 32px rgba(10,51,51,.30)` | Toasts |
| `e-cta` | `0 8px 20px rgba(15,76,76,.28)` | Mobile "Report a problem" only |

In dark theme, use the same shadows at 1.5× opacity and add a 1px `border` to floating layers.

---

## 6. Motion
| Token | Duration | Easing | Use |
|---|---|---|---|
| `fast` | 150ms | `cubic-bezier(.2,.7,.2,1)` | Hover, press, focus, chip toggle |
| `base` | 240ms | same | Tabs, accordion, row expand, toast in |
| `sheet` | 320ms | same | Bottom sheet, dialog, sidebar collapse |
| `stagger` | 60ms step | same | Dashboard KPI load (once per session) |
| `hero` | 2600ms | same | Hero photo settle (scale 1.06 → 1) |

Under `prefers-reduced-motion: reduce`, all motion becomes instant, the SLA ring and counters show their final values, and nothing auto-rotates.

---

## 7. Iconography
- Web uses Lucide at 24px (UI at 18–20px), stroke 1.8, round caps and joins. Android uses Material Symbols Rounded (weight 400, grade 0). iOS uses SF Symbols (weight regular).
- The user icon library is in `designs/assets/icons/`: dashboard, raise-complaint, my-complaints, quarters, residents-occupants, maintenance-office, schedule-updates, reports, feedback, notifications, user-management, settings, help-support.
- **Category icons.** Always use the same icon for a category:
  - Plumbing: `droplet`
  - Roof & seepage: `house` + drip
  - Masonry: `brick-wall`
  - Doors: `door-closed`
  - Windows: `app-window`
  - Flooring: `grid-2x2`
  - Painting: `paint-roller`
  - Drainage: `waves`
  - Other: `more-horizontal`

---

## 8. Component states

Every interactive component follows the same state model.

| State | Rule |
|---|---|
| Default | As specified below |
| Hover (web) | Background shifts one step (primary → `primary-hover`; ghost → `muted`); `fast` |
| Focus-visible | 2px focus ring, 2px offset; never removed; shown on keyboard focus only |
| Pressed | Primary → `primary-pressed`; others → `tint`; scale .98 on mobile |
| Disabled | 45% opacity, `cursor: not-allowed`, no hover; keeps its label; has a tooltip giving the reason where possible |
| Loading | Label kept; a 16px spinner replaces the leading icon; width locked; `aria-busy` |
| Error | `#A32A21` border + icon + message below: what happened, then how to fix it |

### 8.1 Buttons
All buttons are pills with a 14px/600 label. Heights: 44 (default), 36 (compact web), 56 (mobile primary CTA). X-padding is 20, icon gap 8.
| Variant | Default | Hover | Pressed | Dark default |
|---|---|---|---|---|
| Primary | bg `#0F4C4C`, text `#FFF` | `#0C3F3F` | `#0A3333` | bg `#1A6B6B`, text `#FFF` |
| Secondary (outline) | bg `#FFF`, 1.5px `#DDD9CC`, text `#0F4C4C` | bg `#EFEDE4` | bg `#E8F4F4` | bg `#152424`, border `#2E4A4B`, text `#8FD3CB` |
| Ghost | transparent, text `#0F4C4C` | bg `#EFEDE4` | bg `#E8F4F4` | text `#8FD3CB`, hover `#1B2E2E` |
| Destructive | bg `#A32A21`, text `#FFF` | `#8C231B` | `#751D17` | same |
| Gold (hero only) | bg `#C9A96A`, text `#0A3333` | `#BF9C58` | `#B08F4E` | same |
| Icon-only | 44×44 circle, ghost or `muted` fill, `aria-label` required | | | |

Labels are always a verb and object ("Report problem", "Assign work", "Verify work"). Never use "Submit" or trailing arrows.

### 8.2 Inputs, selects and textareas
- Height 44 (mobile 48). Radius 10. Border 1.5px `#DDD9CC`. bg `#FFF`. Text 14/400. Placeholder `#617074`.
- The label sits above the field at 13/500 `#1C2B2B`. Required fields add ` *`. Helper text below at 12/400 `#617074`.
- States:
  - Hover: border `#C9C4B4`
  - Focus: border `#0F4C4C` + ring
  - Error: border `#A32A21` + message
  - Disabled: bg `#EFEDE4`, text `#617074`
  - Read-only / locked estate fields: bg `#EFEDE4`, lock icon, tooltip "Available when Allotment launches"
- Textarea: min height 110, character counter bottom-right at 12px (`86 / 500`). The counter turns amber at 90% and red at the limit.
- Combobox (quarter lookup): type-ahead after 2 characters. The list is `e2` with rows 44px tall, and the matched text is bold.
- OTP: 6 boxes, each 44×52, radius 10, 20/600 tabular. Focus advances automatically and paste is supported.

### 8.3 Chips and segmented controls
- Filter chip: height 32, pill, 1.5px `#DDD9CC`, text 13/500 `#1C2B2B`. Selected: bg `#0F4C4C`, text `#FFF`, border transparent.
- Reason chip (rating): same, but the selected state uses `tint` bg with a `#0F4C4C` border and text.
- Segmented (EN / हिं, role tabs): a `muted` track with 4px padding. The selected segment is `primary` with white text (or `surface` with primary text on a light track).

### 8.4 Status chip and SLA badge
- Height 24, pill, 12/600, 6px dot or 14px icon plus label. Colours come from §1.4.
- Labels:
  - On time / समय पर
  - Due in 5h / 5 घं. शेष
  - Overdue +2h / 2 घं. विलंब
  - Resolved / हल
  - Reopened / पुनः खोला

### 8.5 SLA timer (signature element)
- Ring: 56px (list), 88px (detail), 150px (scorecard). Stroke 6 / 8 / 12. Track `#EAE8E0` (dark `#22393A`).
- Fill colour by remaining time:
  - more than 25% left: `#1F6F4A`
  - 25% to 0% left: `#8A5A00`
  - breached: `#A32A21`, with the ring full and a `+Xh` label
- The centre label is tabular 700, showing hours left (`5h`) or overdue (`+2h`). It updates every minute. The fill has a `base` transition.

### 8.6 KPI tile
- Surface, `e0`, radius 14, padding 16–20. Label 11 uppercase in `text-muted`, value 30/700 tabular, delta caption with ▲/▼ and a colour (good = resolved green, bad = breached red; direction is per metric). Sparkline is 80×24 with a 1.5px primary stroke.
- Hover (web): `e1` + pointer (the tile drills down to its list).

### 8.7 Contractor scorecard
- Radius 20, padding 28. Background `linear-gradient(150deg,#0F4C4C,#0A3333)`, text `#FFF`, secondary text `rgba(255,255,255,.78)`.
- 150px conic ring in gold `#C9A96A` on a `rgba(255,255,255,.12)` track.
- Grade pill:
  - A: `#7FD3A6`
  - B: `#E8C77A`
  - C: `#F0A08F`
  All grades use `#0A3333` text.
- The metric cells are separated by `rgba(255,255,255,.12)` 1px rules. Every number is a button: hover underline, focus ring `#C9A96A`.

### 8.8 Tables
- Surface, radius 14, 1px `border`, `overflow: auto`.
- Header row: bg `bg`, 11px uppercase label style, sticky.
- Row: 52px (comfortable), bottom border `border`. Hover bg `#FBFAF6` (dark `#182929`). Selected rows use `tint`.
- **Flagged row:** 3px left rule in the status colour + the status-bg tint + the name in the status colour. No extra badge.
- Numbers are right-aligned and tabular. Currency uses `₹` with Indian grouping.
- Bulk-action bar: sticky bottom, `e-sheet`, shown when 1 or more rows are selected, reading "3 selected · Assign work · Export".

### 8.9 Dialogs and bottom sheets
- **Dialog (web):**
  - Max width 640 (form) / 480 (confirm). Radius 20, padding 24, `e3`, scrim.
  - Title H3, with a close icon-button top-right.
  - Actions sit bottom-right: secondary then primary.
  - Esc closes, focus is trapped, and focus returns to the trigger.
- **Bottom sheet (mobile):**
  - Radius 24 top, 40×4 drag handle in `border-strong`, max height 88%, `e-sheet`, `sheet` motion.
  - Swipe down or tapping the scrim closes it. A step progress bar sits under the title.
- **Confirm pattern:** a destructive action needs a dialog that names the object ("Remove user S. P. Mishra?"). Reversible actions skip the dialog and use an undo toast instead.

### 8.10 Toast
- Pill, bg `#0A3333`, text `#FFF` 14/500, padding 12 12 12 20, `e-toast`. Bottom centre, 24px from the edge (above the tab bar on mobile).
- Uses the same verb as the button that triggered it ("Work assigned to Shree Balaji Constructions"). An Undo ghost button in `#C9A96A` appears on reversible actions.
- Auto-dismisses after 5s and pauses on hover or focus. Announced with `role="status"`.

### 8.11 Navigation
- **Sidebar item:**
  - 44px tall, radius 12, icon 20 + label 14/500 at `rgba(255,255,255,.78)`.
  - Hover: `rgba(255,255,255,.06)`.
  - Active: `rgba(255,255,255,.10)` with gold icon, white 600 label and a 6px gold dot on the right.
  - Disabled "Allotment (coming soon)": 45% opacity.
- **Bottom tab bar:** 4 items, 64px, icon 22 + caption 11/500. Active item is `primary` with a gold dot; inactive items are `text-muted`.
- **Breadcrumb:** 13/400 `text-muted`, with `/` separators and the current page in 600 `text`.
- **Command palette (web only):** Ctrl/⌘K. 640 wide, `e3`, radius 16, 48px input, 44px rows, and shortcut hints in 11px tabular `muted` pills.

### 8.12 Rating control
- Five 44×44 stars. Filled `#C9A96A`, empty `#DDD9CC`. Labelled with `aria-label` ("4 of 5").
- Reason chips appear below. When the resident chooses "Not fixed, reopen", a photo is required and the confirm button stays disabled until one is attached.

### 8.13 Photo uploader
- 1:1 tiles, radius 12, 3 columns. Empty tiles: dashed 1.5px `border-strong`, camera icon, caption "Add photo".
- **Uploading:** a progress bar at the bottom of the tile (primary).
- **Failed:** red border, retry icon-button, caption "Upload failed. Tap to retry".
- **Queued (offline):** amber border with the caption "Queued · uploads when online".
- Before and after photos pair side by side, each labelled "Before" or "After" in caption style.

### 8.14 Feedback states
- **Skeleton:** `muted` blocks shaped like the real content, with radii to match. Shimmer runs over 1.2s (static under reduced motion).
- **Empty state:** 48px icon in a `tint` circle, H4 title, one-line body and one primary action ("No open complaints. Report a problem when something needs fixing.").
- **Error state:** a breached icon, a message giving what happened and the fix, and a "Try again" secondary button. No apologies.
- **Offline banner:** bg `#FBF1DC`, text `#8A5A00`, 13/500, wifi-off icon, full width under the app bar ("You are offline. 2 updates will sync automatically."). While offline, primary verbs change to "Save and send later".

### 8.15 Timeline
- The vertical rail is 2px `border` with 12px nodes. Completed nodes are filled `primary`, the current node has a primary ring and pulses once, and future nodes are hollow `border-strong`.
- Each entry has an H4 step name, the actor and role (13 `text-muted`) and the time as relative + absolute ("2 hrs ago · 14 Sep 2026, 10:32 AM").

---

## 9. Formatting and content
- Numbers use Indian grouping (`1,00,000`) via `toLocaleString('en-IN')`. Currency is written `₹ 1,24,500`.
- Dates are `DD MMM YYYY` and times are 12h `hh:mm AM`, all in IST.
- Hour units are `h` (English) and `घं.` (Hindi).
- Copy is sentence case, except the 11px label style.
- Use the terms users know: Qtr No., colony, Area, contractor, MT/AE/Dy. Manager (Civil).
- A missing Hindi string falls back to English, never the raw key.
- Touch targets are ≥ 44×44 and keyboard focus is always visible.

## 10. Platform mapping
| Token | Tailwind | Compose (M3) | SwiftUI |
|---|---|---|---|
| primary | `bg-primary` = `var(--primary)` | `colorScheme.primary` | `Color.cpPrimary` |
| surface | `bg-surface` | `colorScheme.surface` | `Color.cpSurface` |
| bg | `bg-background` | `colorScheme.background` | `Color.cpBackground` |
| text / text-muted | `text-foreground` / `text-muted-foreground` | `onSurface` / `onSurfaceVariant` | `.primary` / `.secondary` overrides |
| status-* | `text-status-breached` etc. | `CpStatusColors` extension | `Color.cpBreached` etc. |
| radius-md | `rounded-card` (14px) | `Shapes.medium = 14.dp` | `RoundedRectangle(cornerRadius: 14)` |
| Poppins | `font-sans` | `FontFamily(Poppins)` | `.custom("Poppins", size:)` relative to Dynamic Type |

Generate all three from `tokens.json` with Style Dictionary, and never hand-edit the platform outputs.
