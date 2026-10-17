# Civil Portal — design decisions log

Keep this short. Add a line when a decision is made; never rewrite history.

## Tokens
- **Accent** deep teal `#0F5C63` (7.4:1 on white). Not SaaS blue; reads mineral/institutional. Dark theme uses `#3FA7AE`.
- **Status** colours carry meaning only: resolved `#1F6F4A`, at risk `#8A5A00`, breached `#A32A21`, info `#2C5A8A`. Always paired with icon + text.
- **E&M slot** `#7A4B1F` reserved and unused. The sister portal swaps only this token.
- **Type** IBM Plex Sans + Plex Sans Devanagari + Plex Mono (IDs, quarter refs, money in tables). Devanagari runs +3–4px line-height at the same size.
- **Radius** 4 inputs/chips · 8 cards/buttons · 14 sheets/dialogs/scorecard. Full radius only on avatars, dots and the SLA ring.
- **Elevation** hairline borders by default. Shadow only on toasts, dialogs, the scorecard and the mobile primary CTA.

## Boldness budget
- Spent in two places only: the **SLA ring/timer** and the **contractor scorecard** (dark coal card, 30px tabular figures). Everything else is hairlines.
- Resident home has **no KPIs** — one dominant "Report a problem" action.

## Behaviour
- Toasts reuse the button's verb ("Assign work" → "Work assigned…") and always offer Undo on reversible actions.
- Toast text is stored as a **key**, resolved at render time, so switching language mid-toast re-translates it.
- Offline: banner + the primary button changes verb ("Save and send later"); updates land in a sync queue, never fail.
- A missing Hindi string falls back to English on screen, never the key. Admin translation editor shows the English as the input placeholder.
- SLA rule edits apply only to complaints registered after saving.
- Estate/allotment fields exist in the quarter record now, visible but disabled, so no migration when Allotment ships.
- "Allotment (coming soon)" appears disabled in every sidebar.

## Data display
- Indian digit grouping everywhere (`toLocaleString('en-IN')`), IST, "relative · absolute" time pairs.
- Hour unit follows language (`h` / `घं.`).
- Area names in Hindi: अमलोरी (Amlohri) — confirmed by user.
- HQ compares Areas on **complaints per 100 quarters**, not raw counts.
- Charts derive their axis domains from the data; never hardcode ranges.
- Co-located map markers (CWS · NSC · NCL HQ) cluster into one marker rather than being displaced.
- Map positions are **indicative**, labelled as such until survey coordinates arrive.

## Flagging
- Row-level warnings use a coloured left rule + tinted row + coloured name — no inline badges competing for column width.

## Accessibility
- Text ≥ 4.5:1 on its actual background, including heatmap cells (ink chosen per band).
- Touch targets ≥ 44px on mobile; `prefers-reduced-motion` disables all animation.

## Brand mark (chosen 23 Sep 2026)
- **Seam Shelter, jade palette.** A gable made of four coal strata, with the third lit. Tile `#161C21`; slabs `#B9C2C8 · #86919A · #34C7B0 (seam) · #5C6770`.
- Replaces the CP monogram everywhere: sidebars, sign-in, style guide, favicon.
- E&M sibling keeps the gable and swaps only the seam to ochre `#C98A3E`.
- Android 12+ splash: icon only on a solid anthracite background, animation ≤ 1 s, no branding image.
- Master files: `App Icon and Splash v3`, `Splash v3` (video), `App Icon v3 3D` (GLB/OBJ).

## Files
- `Civil Portal Style Guide` — tokens and components, light/dark, EN/हिं
- `Resident Flow` — sign-in → home → report (3 steps) → detail → verify & rate → history
- `Contractor Field App` — today's jobs, job detail, update work, sync queue, offline toggle
- `JE Work Queue` — In-charge / Overseer switch, bulk assign, contractor picker
- `Area Dashboard` — KPIs, scorecard, trend, categories, repeat quarters, colony density
- `HQ Overview` — 13-Area table, heatmap, lag split, funnel, scatter, rank movement, matrix, deductions, confirmation rate, map, contractor roll-up, meeting mode
- `Admin Console` — users & roles, quarter master, categories & SLA rules, translations, audit log

## Open
- Survey coordinates for the 13 Areas (map).
- Real SLA hours per category and penalty rates (currently sample values).
- Ageing-bucket chart for HQ (data present, not yet surfaced).


## v4 — Figma template theme (25 Sep 2026)
- Source: uploads/Civil-Colony-Portal-Handover (Figma Make "Design-template-with-icons"). Theme only; business logic from v1–v3 kept.
- Tokens: primary #0F4C4C, dark #0A3333, secondary #2E7D32, gold #C9A96A (text-safe gold #B08F4E), cream bg #F8F6EF, surface #FFF, border #EAE8E0/#DDD9CC, text #1C2B2B, muted #617074.
- Type: Poppins UI, Playfair Display only for quotes, Noto Sans Devanagari for Hindi. Uppercase letter-spaced section labels (template convention, overrides earlier sentence-case rule).
- Shape: pill buttons/chips, 14–16px cards, 20px dialogs; teal sidebar with gold icon + gold dot for active item; tinted KPI tiles.
- Icons: Lucide-style 1.8 stroke. Logo: template LogoMark (gold ring, teal house, mosaic windows, leaf).
- Dark mode via CSS variables set on :root (web) / palette object (mobile); toggle on every screen. Ctrl/⌘K palette on web only.
- Files: v4 Landing and Login, v4 Web Portal (role preview switcher), v4 Mobile Apps.

## v5 Hero (25 Sep 2026)
- File: v5 Hero Landing.dc.html. English only, warm/community copy. Motion: 2.6s photo settle, staggered headline fade-up, SLA ring + stat count-up once; all skipped under prefers-reduced-motion.
- User icon library in assets/icons (24px SVG), brand in assets/brand.
