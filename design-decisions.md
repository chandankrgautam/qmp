# Design decisions — web portal build

A running log of how the Claude Design handover (`Design_System/`) was
turned into the working portal (`web/`), and why. Add a line when a
decision is made; do not rewrite history. Business decisions stay in
[README.md](README.md); setup and commands in
[development_logs.md](development_logs.md).

**Rule used throughout:** where the design and the project's own
decisions disagree, the project wins (README §4, §5). The design handover
is the source for look, copy and layout; the project is the source for
behaviour. Controls are enforced by the server and database; the screens
only present them. Nothing in the backend was changed to suit a screen.

---

## 2026-09-25 — first build

### Stack and structure
- **React + TypeScript + Vite, Tailwind v4, Lucide, Recharts**, as the
  handover specifies. shadcn/ui was not generated: the component set is
  small, so `web/src/components/ui/index.tsx` holds hand-written
  components that follow DESIGN_SYSTEM.md §8 exactly (pill buttons with
  verb labels, hairline cards, status as icon + text, 44px targets).
- **A separate frontend beside the existing server**, calling the same
  71-endpoint API through a dev proxy. The old server-rendered screens
  (`src/ui.js`) stay, because the UI walkthrough tests exercise them.
- **Phone screens render in a centred 430px column** on a desktop, so the
  resident and contractor layout reviewed in a browser is the handset
  layout. These stand in for the native apps until they exist.

### One token file for three platforms
- `tokens/tokens.json` is the single source. `node tokens/build-tokens.mjs`
  writes `web/src/styles/tokens.css`, the Compose theme
  (`native/android/.../CpTheme.kt`) and the SwiftUI theme
  (`native/ios/.../CpTheme.swift`). Generated files say so and must not
  be hand-edited.
- A plain script instead of Style Dictionary: the set is small and flat.
- Extends the handover's `tokens.json` with the full status table from
  DESIGN_SYSTEM.md §1.4 (reopened, awaiting, light/dark backgrounds) and
  the hover/pressed values, which the handover file lacked.

### Where the design was overruled by project decisions
| Design | Project decision kept | On screen |
|---|---|---|
| Employee ID + password, or mobile OTP sign-in | The device is the credential; no passwords (decision 13) | Role tabs, then choose a registered device. OTP is used where it belongs: registering a new device. |
| Lifecycle registered → assigned → visited → work_done → verified_by_overseer → accepted_by_incharge | Raised → Verified (Overseer) → Assigned (Incharge) → In progress → Claimed → Inspected & accepted (Overseer) → Closed | Screens follow the project's lifecycle; labels come from `web/src/lib/domain.ts` |
| SLA clock from registration to work done | Contractor clock: time in the contractor's hands, all rounds, less recorded pauses (decision 2026-09-25) | The contractor's ring is their own clock; officers see both the deadline and the contractor figure |
| Scorecard "Deductions due ₹" | Evidence only, no money (control 9) | Left out; the scorecard says penalty decisions rest with the department |
| Complaint ID `CP-NGH-24817` | `JNT/2026/00042` | Project format |
| "Add user" dialog with official email and password | Device registration and approval (decisions 13, 2026-09-25) | Admin has Registrations (approve officers) and Devices (revoke) |
| Report step 3 "Preferred visit time" | No visit-slot field exists | Step 3 is "Check and send" |
| "Non-NCL occupant" radio at sign-in | Not in the project's model | Not shown |
| Custodian registration | Non-residential buildings are under direct departmental control, no occupant device (decision 27) | "Custodian" is not offered at registration; approval always binds a quarter. Officers raise building complaints from "Other buildings". |
| Hero copy "Nothing is closed until you say it's fixed"; "choose when someone can visit"; "see their name and visit time" | The Overseer closes after inspection; the resident can reopen within 24 h; no visit slots | Copy rewritten to say what the system actually does |
| Masked contractor/resident phone numbers | Contractors get no resident personal data; no contractor phone numbers are held | Not shown on either side |

### Frontend-only rules (no backend change needed)
- **A photo is compulsory on reopen** (design rule): the screen takes and
  attaches a photograph before calling reopen.
- **"Not fixed" after acceptance but before closure** records a dispute
  through feedback (confirmed = false), which the server already routes
  to the Overseer; reopen is offered only within 24 h of closure, as the
  server enforces.
- **The inspection photograph is taken before the accept/send-back call**,
  so the database's photo gate (inspecting Overseer's own, after the
  claim) is satisfied in one tap.
- **Contractors are grouped by stage** (rework, to start, in progress,
  awaiting inspection) rather than by colony: the list endpoint does not
  return colony names, and stage is what the contractor acts on.
- **CSV export fetches with the token**, which fixes the old screen's
  broken export link (development_logs.md §8 item 3) without a backend
  change.
- **Area names in the queue come from the sign-in scope**; nothing is
  filtered by Area in the browser — visibility stays the database's
  decision (control 3).

### Photographs in the web demo
- A browser has no trusted camera, so the web slice draws a real JPEG on
  a canvas, stamped "Demo capture" with the time, and sends it through
  the real signed-URL upload and hash check. There is deliberately **no
  gallery picker** (control 2). Inspection photos use the browser's
  location if permitted, otherwise a fixed Singrauli point. The native
  apps replace this with CameraX / AVFoundation capture.

### Signing in during development
- The Vite dev server has a development-only plugin (`web/vite.config.ts`)
  that holds the seeded demo keys and signs the server's challenge, as
  the old screens did. It exists only in `vite dev`, never in a build,
  and must never be deployed.

### Charts and data display
- Indian digit grouping, IST, "relative · absolute" times, `DD MMM YYYY`
  built by hand (the en-GB locale writes "Sept").
- Percentage axes derive from the data but are clamped to 0–100.
- HQ ranks by **SLA compliance**, not complaints per 100 quarters as the
  design asks: the API does not yet expose quarters per Area. Stated on
  the screen. Needs an API field before it can change. *(2026-10-08: the
  executive dashboard shows complaints per 100 quarters beside SLA, and
  still ranks by SLA — see below.)*
- Meeting mode on HQ: large type, rotates every 12 s, pauses on hover or
  focus, never rotates under reduced motion.

### Verified by running (2026-09-25)
Each screen was opened in the browser and compared with its mockup in
`Design_System/screenshots/`; differences were fixed. The full lifecycle
was driven through the new screens: resident reports (3-step sheet) →
Overseer verifies → Incharge bulk-assigns → contractor starts, photographs,
claims → Overseer inspects with a geo-tagged photo (SLA met) → closes →
resident rates 4/5. Dark mode and Hindi category names checked.

Fixed after comparing with the mockups: status card missing on the hero
(timing), brand panel pushed off-screen on sign-in, "Sept" dates, a green
tick on a not-yet-checked complaint, "You" shown to officers in history,
the SLA axis running past 100%, scorecard figure overflowing its ring,
queue table overflowing beside the sidebar, HQ names wrapping, and the
hero sign-in button losing contrast in dark mode.

### Not yet built (deliberately deferred)
- Command palette (Ctrl/⌘K), density toggle, per-user saved filters.
- Offline banner and sync queue — belongs to the native apps.
- Full Hindi for the new screens: only key labels are translated so far
  (`web/src/lib/prefs.tsx`); missing strings fall back to English.
- HQ heatmap, lag split, funnel, rank movement, map and the other charts
  listed in `logic-reference/HQ Overview` — need API support first.
- Complaint slip and monthly performance report (printable).
- Real colony photograph and official NCL / CIL logos (placeholders).

---

## 2026-09-30 — users and roles on the web

The backend changed for these (README §5.5): roles moved from the device
to the person. The screens follow; the earlier rows above that say
"device is the only credential" and "Custodian not offered" are
superseded as noted here.

### Where the design now agrees with the project
| Earlier decision (2026-09-25) | Now | On screen |
|---|---|---|
| No Employee ID + password (design's sign-in overruled) | Employee ID + password on the web for NCL employees; the phone's key in the app | Sign-in has two tabs, "This phone" and "Employee ID", then the role picker. The design's sign-in layout is kept. |
| Custodian not offered at registration | Buildings may have a custodian | Register offers Resident (NCL / Non-NCL), Custodian (building chosen from the list) and Official / contractor (phone only — roles come from the Area HR office) |
| "Add user" dialog left out | Area administrators add people and assign roles | **People and roles** page: people list with role chips, Add person, Assign a role (only roles below one's own rank are offered; quarter or building for occupant roles; contract for contractor roles; designation, acting, validity), Change / End with a reason, Correct details with a reason, Audit trail tab |

### Choices made
- **Role picker, not a role tab at sign-in.** The person signs in once;
  if they hold one role they land straight in it, otherwise they choose.
  Their own home reads "My quarter — D-12", never "Resident", so an
  officer sees at a glance which hat they are wearing.
- **Role switcher in the header** of both shells (web: the name block;
  phone: a button beside the theme toggle). It lists the person's roles,
  marks the current one, and holds Sign out. Switching lands on that
  role's home and says so in a toast.
- **"Inspect and accept" is withheld in a password session** with a
  plain note that it needs the app; "Return for rework" stays available.
  The database refuses it regardless.
- **Assignment lists show the firm** under each supervisor, as an Area
  may now have several contracts.
- **Profile lists the person's roles** and, for an official with no
  quarter recorded, says to ask the Area HR office.
- **Set or reset password** is its own page reached from the Employee ID
  tab: Employee ID + mobile on record → OTP → new password twice.
- The people list relies on row security for who appears; the screen
  does no Area filtering (control 3). Driving this screen is what exposed
  the cross-Area directory leak recorded in development_logs.md.
- **Employee ID fields take 8 digits only** (user's direction): numeric
  keypad, non-digits dropped as typed, input stops at eight, the action
  stays disabled until eight are entered. Help text "8 digits, e.g.
  90229456". The database enforces the same rule.

## 2026-09-30 — work orders

No mockup exists for this screen; it follows the People and roles page
(list of cards beside a detail panel) and the component set.

- **Cards** show firm, contract / LOA and agreement numbers, name of work,
  term, open complaints and supervisors, with the term's state as a status
  chip (days left, amber within 30 days, red past completion, grey once
  handed over). An extended contract says so on the card, with the date
  as awarded.
- **Detail panel** in four sections — Details, Term and extensions,
  Supervisors, Documents — and a History tab that shows each change as
  old → new with the reason in quotes, straight from the database's log.
- **Every write asks for the reason in the same dialog**, and the action
  stays disabled until one is given. The completion date is not in the
  correction dialog at all: "Record extension" is the only way, and the
  dialog says an extension cannot be changed once recorded.
- **Documents use a file picker.** Control 2 (in-app camera, no gallery)
  is about inspection photographs; a contract copy is an office document.
  The SHA-256 fingerprint is shown under each file.
- Write buttons appear only for the Incharge and Staff Officer, and only on
  a live contract. Everyone else, the contractor included, sees the same
  page read-only.
- **Appointing a supervisor** (user's decision): for the Incharge the
  "Name a supervisor" dialog has two tabs, Existing supervisor and New
  supervisor (name, mobile, designation, reason). The toast tells the
  Incharge the next step — the supervisor registers with that mobile, and
  the phone is approved under Registrations. The Staff Officer sees only
  the Existing tab.

## 2026-09-30 — job card

No mockup exists. The card lives where the Overseer already works — a
**Job card** section in the complaint side panel, below the actions — and
has its own list page for the roles above, plus a printable sheet.

- Text fields show "Fill in" when blank and "Correct" once written; a
  correction opens a reason field and Save stays disabled until it has
  one. Items have Change and Withdraw, both asking for a reason; a
  withdrawn item stays, struck through, with who withdrew it and why.
- "Changes" opens the card's own log in the panel (old → new, reason in
  quotes).
- The printable card is an A4 sheet: letterhead, complaint and
  assignment details, scope, site notes, items with an empty "Qty done"
  column and blank rows for handwriting, the no-rates note, and signature
  blocks for the contractor's supervisor, Overseer and Incharge. Printing
  hides the portal's own chrome; two columns on paper and wide screens,
  one on narrow ones.
- Units are suggested (No., Set, Rm, Sqm, Cum, Kg, Litre, Job) but free:
  the materials master in the next phase will settle the list.

## 2026-10-01 — materials

No mockup exists. Built by a subagent against the API contract, then
reviewed and driven in the browser.

- **Contractor (phone):** a "Materials used" card on the job page, below
  the photographs. Add material (pick from the master, quantity, unit
  shown) only while the work is under way; Withdraw on their own
  unverified lines, with a reason, and the button stays disabled until
  one is given. Verified quantities appear once Civil verifies; until
  then "Civil verifies at inspection". The officer's name is not shown
  to the contractor.
- **Officer (complaint panel):** a Materials section after the job card.
  Verify per live line with the claimed quantity prefilled and an
  optional remark; "Verify again" asks for a reason; "Changes" shows the
  log (old → new, reasons in quotes).
- **Materials page:** Consumption (contract and dates, CSV), Anomalies
  grouped by flag with a one-line plain explanation each, row opens the
  complaint, and Master (everyone above the Overseer reads; the
  administrator adds, edits with a reason, deactivates). Every view says
  "Quantities only; no rates are recorded."
- Hindi labels for these screens are not added yet; they fall back to
  English, as elsewhere.

## 2026-10-07 — the life of the job on the job card

User's finding: after a dispute and reopening the card showed only the
latest round.

- A **"Life of the job — N rounds"** block at the foot of the job card, in
  the complaint panel and on the printed card, with the status as a chip:
  work in hand / awaiting the complainant / complainant not satisfied /
  complainant satisfied — job complete.
- One box per round, headed by what began it (Assigned; Sent back by the
  Overseer, with the remark; Reopened by the complainant, with their
  words), then supervisor, start, workmen, materials (claimed and
  verified, withdrawn struck through), completion claim, inspection
  (sent back in red with the remark), closure, the complainant's answers
  (not satisfied in the reopened colour, satisfied in green, with rating
  and words) and the reopening.
- The block is read-only: it is the history, not something to edit. The
  printed card uses absolute dates; the screen uses "relative · absolute".

## 2026-10-07 — disputes and before/after photographs

- **Resident:** a rejected complaint shows "Contest this decision" (reason
  required) once, with a sentence explaining who reviews it. A "Review of
  your complaint" block shows each stage, the officer's note and the Staff
  Officer's decision, attributed by role ("Area Civil Staff Officer"), not
  name — occupants read no officer's record. After a Staff Officer's
  decision every dispute button disappears and the written-complaint
  message takes their place. "Not fixed" before closure is the same reopen
  flow as after closure (photograph compulsory).
- **Officers:** a Disputes section in the complaint panel, after the job
  card: Reinstate / Uphold with a note for the Overseer and Incharge; for
  the Staff Officer, the outcome ("Redo the work", "Close the complaint",
  "Refer for special repair" — or reinstate/uphold for a contest) and the
  written decision, "Record decision" disabled until written, with the
  warning that the occupant cannot dispute again afterwards. A banner
  while a repeated dispute waits: "cannot be reassigned until then". The
  panel's own Close / Refer / Assign buttons are withheld where only that
  decision may act. A **Disputes** page lists what waits for the caller.
- **Contractor:** Before and After slots each say "n of 3"; Mark complete
  stays disabled with a note until there is at least one of each in this
  round.
- **Area dashboard:** the repeat card shows times reported (complaints and
  reopenings) and a "Staff Officer decision pending" chip.

## 2026-10-07 — measurement book

No mockup exists; built like the materials and job card screens.

- **Complaint panel:** a Measurements section after Materials. Each live
  item shows its estimate, then "2 × 1.5 × 0.5 = 1.5 Sqm" (only the
  dimensions given), who measured and when, an "MB 12 · p. 34" chip once
  written into the MB, and the Staff Officer's check with its variance —
  red with a warning when more than the tolerance apart. Measure / Measure
  again (reason; gone once in the MB) / Check (reason when revising). The
  measure dialog greys out Quantity as soon as a dimension is typed and
  shows the product, because the database computes it.
- **Measurement book page:** filters (contract, dates, in MB or not),
  summary tiles with a coverage meter against the 10 % aim, entries grouped
  by complaint in MB columns (Item, Description, Nos, L, B, D/H, Qty, Unit,
  MB ref, Check). Ticking entries not yet in the MB and "Record in MB" asks
  for the MB number and page. CSV, and an A4-landscape print with signature
  blocks for the measuring officer, the check-measuring officer and the
  contractor's representative. A Check-measurement tab lists flagged
  variances and entries not yet checked. Every view says "Quantities only;
  no rates are recorded."
- **Contractor:** a read-only "Measured by Civil" card on the job page —
  quantity and MB reference, nothing about the check.

## 2026-10-08 — HQ executive dashboard

Built from the design reference *HQ Overview* (`Design_System/logic-reference`),
replacing the simpler All-Areas overview at the same address.

| Design | Kept / changed | Why |
|---|---|---|
| Deductions column; "Deductions levied against recovered" | Left out | Control 9 — evidence only. The page says so in a footnote. |
| Map of the Areas across the coalfield | Left out | No survey coordinates; an indicative map would mislead at a meeting. |
| Rank by complaints per 100 quarters | Ranked by SLA compliance; per 100 quarters shown as a column and on the load chart | SLA compliance is what the contract is judged on. Quarters are the registered ones, which grow as registration proceeds. |
| Lag split "who holds it" | Contractor (own clock), department (the rest), paused (recorded occupant / force majeure) | The same rule as the contractor's clock (README §3), so the two never disagree. |

- KPI tiles show the change from the previous month; for reopen rate,
  hours to close and complaints, up is shown as worse.
- Live counts (open, overdue, waiting inspection over 48 h, open at
  level 4) sit in their own strip and turn red above nought.
- "Needs HQ attention" lists critical items first; each opens that Area's
  complaints in Search (`ticket_no=<code>/`, as Search has no Area filter).
- Heatmap: green at or above target, deepening red below it, grey where
  nothing was judged; it opens on the latest month with the codes fixed.
- Rank movement only where the Area has a figure in both months.
- Definitions of every rate sit under the ranking, one line each.
- Meeting mode rotates the ranking and the charts every 12 s, as before.

## 2026-10-08 — passkeys on the web

No mockup exists; the design's sign-in layout is kept and gains one button.

- **Sign-in, Employee ID tab:** "Sign in with a passkey" (fingerprint icon)
  under the password form, shown only where the browser supports passkeys,
  with one line saying what it is and where to add one. It leads to the
  same role picker as the password.
- **Passkeys page**, reached from the role menu (the web shell had no
  profile page): each passkey with its name, when added and last used, or
  removed with the reason; "Add a passkey" asks for a name and the web
  password again, then the browser's own prompt; Remove asks for a reason.
  The card says plainly that accepting an inspection still needs the app.
- **People and roles:** an employee's passkeys in their detail panel, with
  Remove and a reason — for a lost or stolen phone.
- Browser refusals become plain sentences ("The passkey was not added. Try
  again, and approve the prompt with your fingerprint, face or PIN.").

## 2026-10-09 — choosing the Area when HQ assigns a role

- **People and roles, Assign a role:** for the HQ System Administrator,
  whose own scope is all of NCL, choosing a role below HQ adds an **Area**
  field (the thirteen Areas with their codes), and "Assign role" stays
  disabled until one is chosen. The contract list for a contractor role
  narrows to that Area. Area administrators see no change: their roles
  are held in their own Area, as before. Driven in the browser.

## 2026-10-09 — the Android app, first screens

No mockup exists for the native screens yet; they use the generated
Compose theme (`CpTheme`, from `tokens/tokens.json`) so colours and type
match the web portal, and copy in the same plain register.

- **Welcome** says what the app is for and offers one action, "Register
  this phone", with a line for people who have registered elsewhere.
- **Register**: colony, then who you are (Resident — NCL, Resident —
  Non-NCL, Custodian with the building from the list, Official /
  contractor), quarter, name, Employee ID for NCL people, mobile, OTP. The
  development code is filled in, as on the web.
- **Waiting for approval** says who approves which phone, with "Check
  again".
- **Role picker** as on the web: one card per role, an official role asks
  for the fingerprint, face or PIN first; the home for the role lists the
  other roles to switch to.
- "Portal address (development)" appears only in debug builds.

## 2026-10-10 — photographs on every complaint; pages that keep current

User's findings from the first run of the resident's app on the phone.

- **Photographs section** on the officer's complaint panel (after the
  objections), the web resident's complaint page and the contractor's job
  page, and on the phone's complaint page: grouped as the occupant's, with
  the objection, before the work, after the work, the Overseer's inspection
  (with the location it was taken at), each "n" thumbnails in a row; a tap
  opens it full size with what it is and when it was taken. The one-line
  "n photographs on record" note it replaces is gone.
- **Up to three photographs** wherever the occupant takes them: the phone
  shows "n of 3 photographs taken", Take another, Remove the last one; the
  web demo's report button counts 1, 2, 3 and a fourth tap clears.
- **The resident's home keeps a finished job** until it is answered, with
  "Was it fixed? Tap to answer" under its status.
- **Nothing to press to refresh**: pages reload when they come back into
  view and every 30 seconds, never while a form is open.
- Phone: every screen sets its text colour from the theme; the report form
  was black on dark.

## 2026-10-12 — previews, discard, location, the setup screen (phone)

- **Previews on the photograph step**: each photograph appears at once as a
  thumbnail with where it was taken under it and its own Remove; a tap
  shows it full size with "Photograph n of 3 · time", "Taken at …" and
  Remove this one / Keep it.
- **Discard** sits just below the step's main button (Continue, or Report
  problem on the last step) on every step of the report, as a text button
  in the late colour so it never reads as the way forward — first placed in
  the header, moved at the user's direction; it asks "Discard this
  complaint? … Nothing has been sent." with Discard and Keep editing.
- **The camera** shows a strip above the shutter: "Location: 24.11023,
  82.65310 (±5 m)", or "Finding your location — the photograph can be
  taken once it is found"; the shutter stays disabled until then.
- **Location under every photograph** — "24.11023, 82.65310 (±5 m)" in the
  same wording on the phone and the web, "No location recorded" for older
  ones.
- **"Before you start"** (first opening, and whenever something is
  withdrawn): three lines with a tick or an empty circle — Camera, Precise
  location, Location switched on — one button for what is missing (Allow
  camera and location; Open the app's settings once refused for good; Turn
  on location), and a closing note that the gallery is never used.

## 2026-10-12 — photographs optional until HQ requires them

- **Contractor's job page (web):** while before/after photographs are
  optional, "Mark complete" is available without them and the note says
  "Photographs are optional for now; if you take them, up to three 'before'
  and three 'after'". Once required, it returns to the old wording and stays
  disabled until there is one of each.
- **Officer's panel:** beside "Inspect and accept" (which takes the
  photograph first), "Accept without a photograph" while the inspection
  photograph is optional; in the send-back form, "Return without a
  photograph" beside "Return for rework". Both disappear once required.
- **Administration → Settings:** the two settings appear with their plain
  descriptions; only the HQ System Administrator can save them.
- **Phone camera:** if the location is switched off while it is open, a red
  notice says so above the shutter with a "Turn on location" button.

## 2026-10-12 — building complaints: photographs only when added

- "Raise a complaint for a building" gains a **Photographs** field: "Add
  photographs (none attached)", each tap adding one up to three, with the
  note that the web demo generates an image in place of a camera.
- Complaint photographs are headed **"Photographs of the problem"** — no
  longer "The occupant's", as an officer may have raised it.

## 2026-10-12 — ended supervisor roles; whose phone

- **Queue:** under the status of a complaint whose supervisor's role has
  ended, a red line "Supervisor's role has ended — reassign".
- **Complaint panel:** a red notice above the actions: "The supervisor's
  role has ended. Nobody can start or finish this job until it is
  reassigned — use Assign work to give it to a current supervisor."
- **People and roles → End (a supervisor's role):** before the reason
  field, either "This supervisor holds no open jobs" or a red box listing
  each open job (number, premises, fault, state) with the sentence that
  nobody can start or finish them until reassigned from the work queue.
- **Register (web and app):** when the mobile already belongs to someone,
  the confirmation says, in amber, that the phone is registered to that
  person, not the name typed, and to ask the Area office if that is wrong.
- **Demo sign-in list:** each phone is labelled with its owner's name.

## 2026-10-12 — level-4 complaints

- **Complaint panel:** for a complaint at level 4 without the Staff
  Officer's remark, an amber notice replaces "Close complaint": "This
  complaint reached the GM (level 4). It can be closed only after the Area
  Civil Staff Officer records a remark." The Staff Officer sees, inside it,
  a text box and "Record the remark", with "Recorded once; it cannot be
  changed afterwards." Once recorded, "Close complaint" returns for the
  Overseer, and the remark appears in the history.

## 2026-10-12 — "SLA breached — needs decision" tile

- A fifth tile on the work queue, after Open, Due soon, Overdue and To
  inspect / To assign: **"SLA breached — needs decision"**, caption "Whose
  delay, or the level-4 remark". It filters like the others. Unlike them it
  is **red whenever its count is above nought** (the tile's own background,
  not only when selected), so a waiting decision is seen at once.
- The tiles sit five across on wide screens, three on medium, two on narrow.
- Under a complaint's status in the queue, in red: "SLA breach — whose
  delay? Attribute it" and/or "Level 4 — Staff Officer's remark needed".
- Complaint panel: a red note for an unattributed breach with a link,
  "Attribute it on the Area dashboard".

## 2026-10-12 — the contractor supervisor's screens (phone, A3)

Built from the web's contractor pages (design C1–C2), in the phone's shell.

- **Jobs:** "Today's jobs · n", grouped sent back / to start / in progress /
  awaiting inspection; each card has the contractor's own SLA ring, the
  quarter, the fault and the complaint number, "Emergency" where it is one.
- **Job:** status chip in the contractor's words; the ring at 88 dp with
  "n h used of n h · clock running / stopped" and "Inspection time is not
  yours"; a red block with the Overseer's remark when sent back.
- **Before and after:** two square slots, "n of 3", green once one is
  sent. Unlike the web demo, a photograph is **checked before it is sent**:
  full screen, time and location, then Send this photograph / Take it
  again / Cancel — a photograph once sent counts against the three.
- **Mark complete** asks first ("This is your claim that the work is done
  … only the Overseer can close it"), so a claim is never made by a slip.
- **Materials:** a search over the master, then the quantity in its unit;
  Withdraw asks for a reason in a dialog; withdrawn lines stay, struck
  through.

## 2026-10-13 — adding a home (phone and web)

- **Phone, Profile → My homes:** each home held or asked for — quarter or
  building, colony, Resident / Custodian and the Area — with a chip:
  "Waiting for the Incharge", "Approved", "Not accepted" (with the reason
  under it). "Add my home" opens a short form in the same card: Resident of
  a quarter / Custodian of a building, the colony from the list, the quarter
  number (or the building from that colony's list), and the line "Goes to
  the Civil Colony Incharge of that colony … Your phone stays as it is".
  Hidden while a request waits. Once approved, "Show it in my roles" signs in
  again so the new role is offered.
- **Web, Registrations:** a second section, "Homes asked for by people
  already registered", below the phones, with the same card as a new
  resident's (correct the quarter, sector, quarter type) but "Already
  registered — phone approved", their roles in this Area only, and Approve
  home / Refuse home. No site-check button: the person is already known.

## 2026-10-13 — a person's phones

- **People and roles, person panel:** a **Phones** section between Roles and
  Passkeys. Each phone on its own card: "Android phone 1 / 2" (numbered only
  when there are several), a state chip (Approved, Waiting for approval, Not
  approved, Revoked), "Registered 09 Oct 2026 · last used 4 h ago · …", the
  revocation reason once revoked, and **Revoke** for an approved phone. The
  dialog repeats when it was registered and last used, so the right one is
  revoked, and says the person's roles and other phones are not affected.
- **Administration → Devices:** the Role and Quarter columns, which were
  blank, are now the owner's roles and the registration date.

## 2026-10-13 — dialogs keep the cursor where you type

- A dialog puts the cursor in its first field when it opens — usually the
  reason — and leaves it there; before, every letter moved it to the close
  button. Escape still closes.

## 2026-10-13 — phones in another Area

- **Person panel:** "0 approved phones here · 1 in another Area" under the
  name; under Phones, a plain card "1 phone registered in another Area —
  Managed there, or by the HQ System Administrator; its details are not shown
  here. To end [name]'s access in this Area, end the role above." No Revoke.
- **People list:** the phone count beside a name includes phones in other
  Areas, so it agrees with the HQ view.

## 2026-10-15 — the Civil Overseer's inspection (phone, A4)

- **To inspect · n:** the queue numbered 1, 2, 3 in the department's order,
  each with the quarter and fault, the complaint number, "claimed n h ago",
  and chips for Emergency, Priority n and Objection, the priority note in
  quotes; a red card when the oldest has waited 48 hours. A line at the foot
  says verifying and assigning are on the web portal.
- **The job:** the contractor's time ("n h of n h — late"), the occupant's
  objections in the reopened colour, an **Inspect on site** card with "Take
  the inspection photograph" (checked full screen before sending, as the
  contractor's are), then **Inspect and accept** (asked first) and **Send
  back for rework** (a remark the contractor sees, the button disabled until
  written). Once accepted, **Close complaint**, or the level-4 notice.

## 2026-10-15 — the design experiment's UI, ported

A design experiment (tag `experiment/v2`) reworked the look and several
screens in its own sandbox. Ported to the portal with the user's decisions
where it departed from the project's (development_logs.md, 2026-10-15). The
experiment's blueprint codes are kept so each piece can be traced.

**Adopted as built:** F1 entrance motion that moves content and never starts
invisible; F3 theme, row density and colour scheme in the person menu; F4
Noto Sans with Noto Sans Devanagari at line-height 1.6; F5 Hindi on the
resident's screens (drafts for the Rajbhasha cell); R1 the resident's
complaint as a receipt — status card, the Overseer's photograph only when
there is one, details, photographs, the escalation path ("If it is not fixed
in time"), the complaint journey; R4 colony notices; O1 the Inbox (Needs you
/ With the contractor / Waiting on others, ↑ ↓ Enter X, saved views kept in
the browser); O2 a clock on every row saying whose time it is; O3 quieter
tables; H1 the SLA tracker on HQ; H2 the wall display with "since … today";
G1 the GIGW frame (identity strip, skip link, text size A− A A+, language,
accessibility statement, footer); the fresh brick mark (favicon, launcher
icon, loader, the job card's letterhead in grey); seven colour schemes a
person chooses, which never change the status colours; the command palette
(Ctrl/⌘K, through Search, so row security decides what is found); the
closing tick, haptics, view transitions.

**Where the project's decisions won (asked of the user):**

| Experiment | Kept | On screen |
|---|---|---|
| Inbox in place of the five tiles | Both | The tiles, smaller (a count, label and caption in one line), above the sections; "SLA breached — needs decision" red on its own background whenever above nought; a tile filters the sections, "show all" clears it |
| Report: camera first | Fault first | Step 1 what needs fixing (with the colony's notices above), step 2 description and up to three photographs, step 3 Check your answers with Change on each row |
| Today: the inspection route with "Open in the app" | Pending tasks only | Needs a decision, objections to answer, To inspect (numbered, the department's order), To verify, To assign, To reassign, To close — each opens the complaint panel; the list reloads as soon as an action is taken and every 30 s |

**Kept from the portal** where it had moved on since the experiment
branched: the complaint panel (with the experiment's closing tick added),
the dialog's focus, the Photographs section, auto-refresh, the photographs
rule for building complaints.

**Departures from the handover's DESIGN_SYSTEM.md**, noted, not edited
there: Noto Sans in place of the handover's typefaces, sentence-case labels,
the brick mark, and colour schemes beyond the one palette.

## 2026-10-15 — the experiment's look on the phone

- **Profile → Appearance:** three chips (Follow the phone, Light, Dark) and a
  list of the seven schemes, each with four swatches, its name and one line;
  the chosen one outlined and ticked. A closing line says the status colours
  never change. The header and the "Report a problem" hero take the scheme's
  own header, deep and gold colours.
- **Notices** sit above "Report a problem" (title only) and above "What needs
  fixing?" (with the text), in the at-risk colour with "Notice from the civil
  office · until …", as on the web.
- **"If it is not fixed in time"** follows the photographs on the complaint
  page: one box per level, the current level in the at-risk colour, a level
  due but not yet recorded in the late colour, and "Not needed so far" while
  the complaint is within its time.

## 2026-10-15 — the Overseer's Today on the phone

- The Overseer's app opens on **Today · n**, "What waits for you": To verify
  (oldest first), To assign, To reassign (in red), To inspect (numbered, the
  department's order, the 48-hour card), To close — the web's Today sections
  that can be done on a phone; an empty section is not shown. A closing line
  says materials, pauses and objections are on the web.
- **The complaint:** "Check the complaint" with **Verify complaint** (asked
  first: the SLA is fixed now and cannot be changed) and **Reject** (a reason
  the occupant sees, at least three letters). **Assign the work**: the Area's
  supervisors as a radio list with their firm and open jobs, then "Assign to
  [name]"; **Reassign the work** asks for a reason as well, and says in red
  when the supervisor's role has ended. The buttons come from the complaint's
  `available_actions`, so the phone and the web never disagree.

## 2026-10-15 — where a complaint stands; completed work

User's finding: after assigning on the phone, the Overseer's screen still
showed the assignment form ("Reassign the work") as if nothing had happened,
with no status and the history far below.

- **Overseer's app, three tabs** under the header: **Today · n**, **Open · n**
  (every live complaint by stage — new, to assign, with the contractor,
  awaiting inspection, inspected, special repair — each card with its status
  chip and one line: "Assigned 2 h ago · not started", "Claimed done …"),
  **Completed · n** (closed, newest first, "Closed 15 Oct 2026 · contractor on
  time" in red when late; older ones in Search).
- **The complaint:** a **Where it stands** card under the summary — "With R.
  Yadav (M/s Verma) since 3 h ago. Work not started yet." — and the SLA
  deadline. A job already with a supervisor shows only **"Give it to another
  supervisor…"**; the list and reason appear when it is tapped (Cancel folds
  it again). Unless the supervisor's role has ended, when the form is open
  and the line is red.
- **Life of the job · n rounds** from the job card, before the materials: what
  began each round, the supervisor, start and workmen, materials and
  photographs counted, the claim, the inspection (sent back in red with the
  remark, accepted in green), closure, the occupant's answers and any
  reopening. **History** now comes before the photographs.
- **Supervisor's app:** **Jobs · n / Completed · n** chips; a completed job
  says "Within your time" or "Over your time" — their own clock only.
- **Web Inbox:** **Live / Completed · n** beside Quarters / Other buildings;
  Completed is one table, newest first, the clock column reading "Closed 2 h
  ago · contractor on time", the same filters applying.

## 2026-10-15 — the contractor firm on the phone

- The firm's role opens the supervisor's screens **read only**: "Our jobs · n"
  ("Every job of the contract · read only") and "Completed · n"; each live
  job names its supervisor; a job shows the supervisor and workmen, "The
  contractor's time on this job", materials with Civil's verified quantity,
  "Measured by Civil", photographs and history (the supervisor's acts as
  "Supervisor"). No start, photograph, material or claim controls.
- **No web page for contractors**: they sign in only with the phone's key
  (README §5.5), so the supervisor's web page stays a development stand-in.

## 2026-10-16 — contractor staff on the web; CSV; photographs on the job card

Built to the user's answers to a sixteen-question form (development_logs.md,
2026-10-16).

- **Sign-in:** four tabs two by two — This phone, Employee ID, **Contractor**,
  **Supervisor**. The contractor tabs say who they are for and what can be
  done there, then: mobile number → "Send me a code" → the six boxes (the
  development code shown above them) → Sign in; "Change number" and the
  30-second resend as on registration. A firm with several work orders lands
  on the role picker.
- **The firm (web):** **Our jobs** first in its menu, before Scorecard and
  Work orders. Live / Completed with counts; chips "All supervisors" and each
  supervisor; one table — complaint, quarter, fault, supervisor, the
  contractor's time (live) or the result and closing date (completed),
  status; **Download CSV** of what is on screen. A row opens a read-only panel
  like the officer's: supervisor and workmen, the contractor's time,
  materials, measurements, photographs, history — no buttons. A line under
  the table says how to switch work orders.
- **The supervisor (web):** the phone layout, Jobs / Completed. In a web
  session a line under the switch says starting, photographs and marking
  complete are in the app; on a job, a tinted note takes the place of the
  start form and of the photograph slots and Mark complete. Materials work as
  on the phone.
- **Officers:** "· from the web" after the role in a complaint's history, and
  on a material line recorded from the web.
- **CSV:** **Download CSV** in the Inbox's header (the tab in view) and in
  Search's header (the current search). Columns: complaint, Area, quarter,
  category, fault, emergency, state, work order, contractor, supervisor, each
  step's date and time in IST, SLA and the contractor's hours, within time,
  sent back, reopened. No rating, no objection, no money.
- **Job card:** a "Photographs of the job · n" block after the life of the
  job, on the card in the complaint panel and on the printed sheet: four to a
  row (three on narrow screens), each captioned with what it is, when and
  where; "None taken" with the reason when there are none.

## 2026-10-16 — the supervisor's web view, as the Overseer's

User's request: the supervisor on the web should see what the Overseer sees,
with his role's limits. A web (mobile + OTP) supervisor session now opens the
office layout, not the phone layout (which stays for the app's demo stand-in):

- **Side menu:** "My jobs" only; the person menu says "signed in with mobile
  and OTP" and has no Passkeys entry.
- **My jobs**, the firm's page shared: a tinted note that starting,
  photographs and marking complete are done in the app; five tiles as on the
  Inbox — To start, In progress, Sent back, Awaiting inspection, Over my time
  (red on its own background when above nought) — each filtering the table;
  Live / Completed; the table (no Supervisor column, "My time"), most urgent
  first, a breached row hatched as on the Inbox. The firm's page gains the
  same tiles.
- **The panel** at the side, as the officer's: the ring (a tick and "in time"
  or "Late · over time" once the work is finished), quarter, workmen, the
  time, the Overseer's remark when sent back, the in-app note in place of the
  start, photograph and claim controls, materials (recordable while under
  way), measurements, photographs, history. No objections, disputes or job
  card — not the contractor's to see.

## 2026-10-16 — the measurement sheet, the chain and the MB record

- **Complaint panel, Measurements** (officers) / **My measurement sheet** (the
  supervisor, on his web panel): the five steps of the chain at the top, as
  for materials, with the buttons the server allows (Send for review, Pass up
  after review, Reviewed — no change, Send back, Approve). Each item shows
  its estimate and the measurement; **Measure** and **Change** appear only for
  whoever's step it is; an officer's change, and every change after approval,
  asks for a reason. A line under the items says who measures first.
- **MB record** beside Changes opens the job's lines of the contract's MB:
  page, line, item, quantity (Nos × L × B × D = qty), who (role, and the name
  for officers), when and the reason; a line measured again is struck through
  and the later line stands; a Staff Officer's correction after approval is
  marked in red. Officers follow a link to **the contract's whole MB**
  (`/w/mb/book/<contract>`): the index of jobs with their pages (each a link)
  and where each job's measurements stand, then one card per page of 25
  lines, printed one page to a sheet.
- **Job card:** the supervisor sees the card in his panel and fills in or
  corrects it like an officer; Print stays an office page. The "locked" note
  now says whose step it is, or that the MB is approved and only the Staff
  Officer corrects it.
- The "Record in MB" flow on the Measurement book page stays, as a place to
  note the paper MB's own number and page; it no longer freezes an entry.

## 2026-10-16 — the worklist, and finding the MB later

- **Measurement book page** opens on **Worklist**, then **Find in the MB**,
  **MB extract**, **Check-measurement**. The worklist: contract, month the
  work was accepted, Measurements / Materials; six tiles — Waiting for me,
  Below me, Sent back, Approved, Over 7 days (red value when above nought),
  All jobs — each filtering the list (the officer's own step first); a line
  for the sample check per contract ("0 of 1 needed checked — 1 short" in
  red); the list (complaint, quarter and fault, the step as a chip, "sent
  back" under it, days at the step in red when too long, "n changed" in
  amber, "check-measured" in green); and beside it, sticky, the job's review —
  the job card with the life of the job, the materials, and the measurements
  with MB record — where the step's buttons are. ↓ ↑ move through the list;
  there is no select-all and no approve-several: one job at a time.
- **Find in the MB:** one search box (words of an item, complaint number,
  quarter or fault), contract, step, approval dates, MB page; results give
  the MB number with page and lines and open the contract's MB on that page
  with the job's lines tinted.
- **The contract's MB** has a month picker ("2026-10 · page 1 · 1 job"),
  "Go to page (of n)", previous and next page, and says what is shown.
- **Today** (Overseer, Incharge): "Measurements and materials to review",
  each with days at the step, "sent back to you", changes; red past the
  setting; a link to the worklist.
- **Area dashboard:** a red card when sheets have waited over the setting,
  counted by step, opening the worklist.
- **Search:** "MB approved" and "MB pending" chips; an MB column with the
  page(s), linked to the contract's MB.
