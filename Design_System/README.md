# Handoff: Civil Portal — NCL Colony Maintenance Portal (web + Android + iOS)

## Overview
Civil Portal lets residents of about 15,000 Northern Coalfields Limited (NCL) company quarters across 13 Areas report civil-maintenance problems. The civil department assigns each job to the Area's comprehensive-maintenance contractor, an overseer verifies the work, and the resident confirms or reopens it. Every screen answers one question: **was the resident's problem fixed correctly and on time?** Contractor performance (SLA compliance, reopen rate, rating, deductions) is measured from that loop.

Phase 1: individual quarters only. Hostels, guest houses, union offices and admin buildings sit under a separate "Other buildings" tab and are controlled only by the civil department. They have no resident role. Show "Allotment (coming soon)" as a disabled nav item.

## About the design files
The files in `designs/` and `logic-reference/` are **design references built in HTML**. They are prototypes that show the intended look, copy and behaviour. They are **not production code to copy.** Each `.dc.html` opens directly in a browser (it needs `support.js` next to it). Rebuild them in the target stack:

- **Web:** React + TypeScript + Vite, Tailwind (tokens as CSS variables), shadcn/ui (Radix), Lucide React, TanStack Table, Recharts (ECharts for HQ heavy charts), React Hook Form + Zod, Sonner toasts, cmdk palette, date-fns (IST, `DD MMM YYYY`), i18next, Framer Motion (purposeful only).
- **Android:** Kotlin + Jetpack Compose, Material 3 themed from `tokens.json` (never default purple), Coil, CameraX.
- **iOS:** SwiftUI themed from `tokens.json`, SF Symbols, native sheets and navigation, Dynamic Type.
- **Shared:** generate the Tailwind config, Compose theme and SwiftUI theme from `tokens.json` with Style Dictionary.

## Fidelity
**High fidelity.** `designs/` holds the **current visual direction (v4/v5)**: final colours, type, spacing and copy. Recreate it pixel-accurately.
`logic-reference/` holds earlier-theme (v1–v3) screens. Use them **only for business logic, data shape, states and copy**, not for styling. Wherever the two disagree visually, `designs/` wins.

## Roles and home screens
There is one login with role tabs. Sign-in uses Employee ID + password, or mobile + 6-digit OTP.

| Role | Platform | Home |
|---|---|---|
| Resident — NCL employee | Mobile | My quarter + dominant "Report a problem" + open complaints |
| Resident — Non-NCL occupant | Mobile | Same as above; chosen by radio before sign-in; identified by mobile OTP |
| Contractor supervisor | Mobile | Today's jobs sorted by SLA urgency, grouped by colony |
| Civil Colony In-charge (MT / Asst. Manager / Dy. Manager (Civil)) | Web + mobile | Work queue; **assigns** to contractor, **accepts** verified work, **reassigns** flagged work |
| Civil Colony Overseer | Web + mobile | Work queue; **verifies** work or **flags poor quality** (cannot assign) |
| Area Civil In-charge / Project Engineer | Web | Area dashboard + contractor scorecard |
| HQ Civil / management (Chief Manager (Civil) etc.) | Web, large screen | All-Areas overview + meeting mode |
| Administrator | Web | Users & roles, quarter master, categories & SLA rules, translations, audit log |

## Complaint lifecycle (state machine)
`registered → assigned → visited → work_done → verified_by_overseer → accepted_by_incharge → confirmed_by_resident → closed`
- A resident choosing **"Not fixed, reopen"** moves the complaint to `reopened`, then back to `assigned`, and counts toward the reopen rate.
- An overseer choosing **"Return for rework"** (reason required) sends the complaint back to `assigned` with the same contractor.
- Each transition writes an audit entry: actor, role, timestamp (IST) and optional note or photos.
- The SLA clock starts at `registered` and stops at `work_done`. Hours per category come from Admin → SLA rules (sample values for now). Rule edits apply only to complaints registered after saving.
- SLA badge states: `on_time`, `due_soon` (≤ 25% of the window left), `overdue`, `resolved`, `reopened`.

## Screens (current direction: `designs/`)

### 1. Hero landing — `v5 Hero Landing.dc.html`
- Full-viewport hero. The photo sits in the right ~62% (`image-slot id="v5-hero-photo"`, replace with a real colony photo). A teal scrim runs left to right (`#0A3333` to transparent) so white text passes 4.5:1.
- Header: house mark (`assets/brand/favicon.svg`, 44px, in a white circle) + product name, plus NCL and CIL logo slots (120×48, white 92% pill). Nav links and a primary pill "Sign in".
- Headline Poppins 48/1.1 700, white. Sub-copy 18/1.55 in `rgba(255,255,255,.85)`. CTAs are "Report a problem" (gold `#C9A96A` fill, `#0A3333` text) and "Track my complaint" (white outline).
- Stat row: count-up figures in Indian grouping (e.g. "15,000 quarters", "13 Areas").
- Motion, played once: photo scales 1.06 → 1.0 over 2.6s `cubic-bezier(.2,.7,.2,1)`; headline, sub-copy and CTAs fade up with an 80ms stagger; the SLA ring fills and stats count up. **All of this is skipped under `prefers-reduced-motion`.**
- English only for now.

### 2. Landing and login — `v4 Landing and Login.dc.html`
- Split layout: brand panel on the left (teal `#0F4C4C`, logo mark, Playfair pull-quote) and the form card on the right (surface white, radius 20).
- Role tabs are pill segmented, and wrap on narrow screens. Residents get an extra radio: "NCL employee" / "Non-NCL occupant".
- Method toggle: Employee ID + password / Mobile OTP. The OTP is 6 boxes of 44×52 with auto-advance, and resend unlocks after 30s.
- Errors say what happened and how to fix it, e.g. "That OTP has expired. Tap Resend to get a new one."

### 3. Web portal shell — `v4 Web Portal.dc.html` (use the role preview switcher at the top)
- **Sidebar:** 248px, `#0F4C4C` (dark `#0B2626`), collapsible to 72px. Items are 44px tall with a white 78% icon and label. The active item has a white 10% fill, a gold icon and a 6px gold dot. The disabled "Allotment (coming soon)" item sits at 45% opacity.
- **Top bar:** breadcrumb, Ctrl/⌘K search trigger (**web only**), EN/हिं switch, dark-mode toggle (**on every screen, web and mobile**), notifications, avatar.
- **Work queue:** four bucket tiles (Open / Due soon / Overdue / Awaiting verification), each a tinted tile with a count at 30px tabular-nums. Then filter chips (colony, category), a TanStack table with a sticky header, row checkboxes, and a sticky bulk-action bar. **"Assign to contractor"** opens a dialog listing *only the contractors registered in that Area*, each with SLA % and open jobs. Overseers see "Verify work" / "Return for rework" instead of Assign.
- **Area dashboard:** four KPI tiles with a sparkline and "vs last month" delta, then SLA compliance trend (line), category breakdown (bars), top repeat-complaint quarters and colony density grid.
- **Contractor scorecard** (the signature element): 20px-radius card, gradient `#0F4C4C → #0A3333` at 150°. It has a 150px conic SLA ring in gold, a grade pill, and metrics for SLA %, average resolution time, reopen rate, resident rating and deductions due (₹, Indian grouping). **Every number drills down** to a filtered complaint list.
- **HQ overview:** table of all 13 Areas ranked by complaints per 100 quarters (not raw counts), plus the charts listed in `logic-reference/HQ Overview.dc.html`: heatmap, lag split, funnel, scatter, rank movement, matrix, deductions, confirmation rate, indicative map, contractor roll-up. Meeting mode: large type, high contrast, auto-rotating charts every 12s, pause on hover or focus.
- **Users & roles:** table + **Add user dialog**, whose fields change by role:
  - Designation dropdown: MT (Civil), Asst. Manager (Civil), Dy. Manager (Civil), Chief Manager (Civil).
  - **Colony Overseer:** designation is a *free text box*, and official email is *optional*.
  - **All other roles:** official email is *required*.
  - Every **Edit** button opens a pop-up dialog to edit that record's fields.
- **Toast:** `#0A3333` pill, bottom centre, uses the button's verb ("Work assigned to Sharma Constructions") with **Undo** on reversible actions.

### 4. Mobile apps — `v4 Mobile Apps.dc.html` (Android + iOS frames)
- **Resident home:** quarter card (e.g. "Qtr No. C-245, Nigahi") and a full-width "Report a problem" primary button (56px, pill), then the open-complaint cards with an SLA badge.
- **Report a problem:** opens as a **bottom sheet** (radius 24 top, scrim `rgba(10,51,51,.5)`, drag handle) with 3 steps and a progress bar:
  1. Category icon grid (3 columns, 80px tiles)
  2. Describe (textarea, 500-char counter, voice-to-text) + photos
  3. Preferred visit slot, then confirm
  The toast reads "Complaint registered · CP-NGH-24817".
- **Complaint detail:** timeline, masked contractor staff contact, expected completion, SLA ring.
- **Verify and rate:** after-photos, "Yes, it's fixed" or "Not fixed, reopen" (a photo is compulsory on reopen), 5-star rating + reason chips.
- **Contractor app:** jobs grouped by colony, then job detail (directions, masked resident phone, problem photos), then update work (before photo, after photo, materials, mark complete).
- **Offline:** amber banner. The primary verb becomes "Save and send later", actions queue up, and they auto-sync with a count badge.
- Bottom tab bar (4 items, 64px, active item in teal with gold dot). Touch targets ≥ 44px.

### 5. Other references (`logic-reference/`)
- `Complaint Slip` — A4 printable. The top half is the resident copy; the bottom half is the job card with signature lines. It carries an NCL header.
- `Monthly Performance Report` — printable/PDF, laid out for official file noting.
- `Admin Console` — quarter master (estate fields visible but **locked**), categories + SLA hours, a side-by-side EN/HI translation editor with a missing-string flag, and the audit log (2-year retention, export).

## Interactions and behaviour
- **Dark mode:** swap the CSS variables on `:root` (see `tokens.json › color.dark`). The choice persists in localStorage and defaults to the system setting.
- **Command palette (web):** Ctrl/⌘K. Covers navigate, find a quarter/complaint by number, and switch Area.
- **Density:** a comfortable/compact toggle on data tables (row height 52 / 40).
- **Filters** are remembered per user per table. Table headers and long-form action bars are sticky.
- **Time:** always show relative + absolute, e.g. "2 hrs ago · 14 Sep 2026, 10:32 AM", in IST.
- **Numbers:** Indian grouping via `toLocaleString('en-IN')`, and `tabular-nums` in tables and KPIs.
- **Loading:** skeletons shaped like the real content, never a full-page spinner. Updates are optimistic, with undo.
- **Empty states** give one clear next action. **Errors** state the cause and the fix, with no apology copy and no "Something went wrong".
- **Motion:** state changes 150–240ms; sheets 320ms; one orchestrated dashboard load (KPI stagger 60ms). Everything respects reduced motion.
- **Photo upload:** compress to ≤ 1600px long edge, JPEG q0.75 before upload. Shows a preview, retries on failure, and pairs before and after photos.

## i18n
- English is primary and Hindi secondary, switchable at any time. Strings are keys in i18next, loaded from the admin-editable store.
- A missing Hindi string falls back to English, never the raw key.
- Layouts must survive Hindi strings 30–40% longer, so avoid fixed widths on labels. Devanagari line-height is +3–4px.
- Area names, English / Hindi: Amlohri / अमलोरी, Nigahi / निगाही, Jayant / जयंत, Dudhichua / दुधीचुआ, Khadia / खड़िया, Krishnashila / कृष्णशिला, Bina / बीना, Kakri / ककरी, Jhingurda / झिंगुरदा, Block-B / ब्लॉक-बी, Central Workshop / केंद्रीय कार्यशाला, Nehru Shatabdi Chikitsalaya / नेहरू शताब्दी चिकित्सालय, NCL HQ Colony / एनसीएल मुख्यालय कॉलोनी.
- Area codes: AML, NGH, JNT, DCH, KHD, KSL, BINA, KKR, JRD, BLB, CWS, NSC, NCL HQ.

## State and data (suggested)
- `Quarter { id, areaCode, colony, quarterType, quarterNo, occupant?, estate: {…locked} }`
- `Building { id, areaCode, kind: hostel|guest_house|union_office|admin, name }` — no resident
- `Complaint { id: "CP-<AREA>-<n>", quarterId|buildingId, category, description, photos[], preferredSlot, status, slaDueAt, contractorId?, assignedStaff?, history: AuditEvent[], rating?, reopenCount }`
- `Contractor { id, name, areaCodes[], contractPeriod, staff[] }`
- `SlaRule { category, hours, effectiveFrom }`
- `User { id, name, role, designation, designationText?, employeeId?, mobile, officialEmail?, areaCode }` — `officialEmail` is required unless role = overseer
- `AuditEvent { at, actorId, role, action, note?, photos? }`
- Offline queue on mobile: `PendingAction { id, type, payload, createdAt, attempts }`

## Design tokens
See **`tokens.json`** for the full source. Key values:
- **Primary** `#0F4C4C` · **dark** `#0A3333` · **secondary** `#2E7D32` · **gold** `#C9A96A` (decorative) / `#B08F4E` (large text)
- **Background** `#F8F6EF` · **surface** `#FFFFFF` · **borders** `#EAE8E0` / `#DDD9CC` · **text** `#1C2B2B` / `#617074`
- **Status:** resolved `#1F6F4A`, at risk `#8A5A00`, breached `#A32A21`, info `#2C5A8A`. Always paired with an icon and text.
- **E&M reserved accent** `#7A4B1F`
- **Type:** Poppins (UI), Playfair Display (quotes only), Noto Sans Devanagari (Hindi)
- **Radius:** inputs 10, cards 14–16, scorecard/dialog 20, sheet 24 top, buttons and chips pill
- **Spacing:** 4-pt scale · 12-column web grid · reading text max 80ch

## Assets
- `designs/assets/icons/*.svg` — the user-supplied 24px icon library (dashboard, raise-complaint, my-complaints, quarters, residents-occupants, maintenance-office, schedule-updates, reports, feedback, notifications, user-management, settings, help-support). All other icons are Lucide at stroke 1.8. Android maps to Material Symbols, iOS to SF Symbols.
- `designs/assets/brand/civil-colony-logo.svg`, `favicon.svg` — the product mark.
- **Placeholders to replace:** the hero photo, and the official NCL and Coal India logos (get these from NCL Corporate Communications). The Complaint Slip QR code is also a placeholder.
- App icon / splash master: "Seam Shelter", jade palette (see `DESIGN_DECISIONS.md`). Android 12+ splash is icon only on a solid background, with animation ≤ 1s.

## Open items
- Survey coordinates for the 13 Areas (the HQ map is indicative only).
- Real SLA hours per category and penalty/deduction rates.
- Confirm the Area In-charge role title.

## Files
- `designs/` — current direction: `v5 Hero Landing`, `v4 Landing and Login`, `v4 Web Portal`, `v4 Mobile Apps`, plus `support.js` (runtime needed to open the files), `image-slot.js`, the device frames and `assets/`
- `logic-reference/` — business logic, states and copy from v1–v3: Resident Flow, Contractor Field App, JE Work Queue, Area Dashboard, Contractor Scorecard, HQ Overview, Admin Console, Monthly Performance Report, Complaint Slip
- `tokens.json` — design tokens (Style Dictionary)
- `DESIGN_SYSTEM.md` — exact tokens, type/spacing/radius/elevation/motion, and every component's states
- `screenshots/` — 01 hero · 02–04 landing, login, login dark · 05–12 web (In-charge/Overseer queue, Area dashboard, scorecard, HQ, users, Add user dialog, dark) · 13–17 mobile (report sheet, home, detail/verify, contractor jobs, update work). Reference only; the HTML files are the source of truth.
- `DESIGN_DECISIONS.md` — decisions log; read it before changing anything visual
