# Colony Maintenance Portal

**Northern Coalfields Limited — Civil Department**

This file describes what the application is and records the business
decisions behind it. How to set up, run, test and change it is in
[development_logs.md](development_logs.md).

---

## 1. What it is

Residents of NCL colonies raise maintenance complaints through the portal.
The Area Civil Maintenance Office routes them, the maintenance contractor
does the work, and the Civil Overseer physically inspects it before the
complaint is closed.

It is **not mainly a work-assignment tool.** Comprehensive civil
maintenance is awarded to one contractor in each Area, so every complaint
is evidence of whether that contractor is meeting the contract. The
portal exists to produce a **contract performance record that holds up in
a dispute.** Every design choice follows from that: if a control protects
the integrity of that record, it is not given up for convenience.

**The portal produces evidence, never financial decisions.** It computes
no penalty, no liquidated damages and no bill. That judgement stays with
the department.

### Scale

- 13 Areas, each with its own colony, its own Civil Maintenance Office and
  its own separately awarded maintenance contract
- About 15,000 quarters plus about 130 non-residential buildings
- One deployment for all Areas, not an Area-by-Area rollout

| Code | Area | Code | Area |
|---|---|---|---|
| AML | Amlohri | BINA | Bina |
| NGH | Nigahi | KKR | Kakri |
| JNT | Jayant | JRD | Jhingurda |
| DCH | Dudhichua | BLB | Block-B |
| KHD | Khadia | CWS | Central Workshop |
| KSL | Krishnashila | NSC | Nehru Shatabdi Chikitsalaya |
| | | NHQ | NCL HQ Colony |

The code is the abbreviation the department already uses on files. It
appears in every ticket number, for example `JNT/2026/00042`: Area,
calendar year, then a five-digit number that restarts each January.

---

## 2. Who uses it

Roles belong to **people**, not to phones (decision 2026-09-30). One
person may hold several roles and switches between them on the same phone
or web session — an Overseer who lives in D-12 is both "Civil Colony
Overseer · Jayant" and "My quarter — D-12". Every act is recorded against
the role it was done in *and* the person.

| Role | Rank | Sees | Does |
|---|---|---|---|
| **Resident** (NCL or Non-NCL) | 1 | Own quarter only | Raises, tracks, objects, confirms, rates, reopens |
| **Custodian** | 1 | One non-residential building | The same, for that building |
| **Contractor** (the firm) | 2 | Its own contract only | Reads its own record and scorecard |
| **Contractor Supervisor** | 2 | Only jobs assigned to them | Starts work, names workmen, **claims** completion with a photograph |
| **Civil Colony Overseer** | 3 | Own Area | Verifies, assigns, answers objections, **physically inspects every completed job**, closes |
| **Civil Colony Incharge** | 4 | Own Area | Approves resident and custodian registrations, assigns work, keeps the work orders, **appoints contractor supervisors** and approves their phones, first escalation point |
| **Area Civil Staff Officer** | 5 | Own Area | Second escalation point, contract oversight, special repair |
| **Area HR Administrator** / **Area System Administrator** | 6 | Own Area | Enter people, assign roles below their own rank, approve officials' phones |
| **HQ — Civil HOD (GM Civil)** | 8 | All Areas, **read-only** on complaints | Cross-Area monitoring |
| **HQ — Directors, CMD** | 8 | All Areas, read-only | Executive dashboard |
| **HQ System Administrator** | 9 | System-wide | Masters, settings, SLA figures, dashboards, Area administrators |

Every official has their own resident page as a separate role, once the
Area HR office records their quarter. A contractor or supervisor has one
only if allotted a quarter. Non-NCL residents use the app only.

Escalation runs **Overseer → Incharge → Staff Officer → GM.**

The contractor is an **external, untrusted user**. They cannot close a
job, cannot downgrade an emergency, cannot see objections raised against
their work, and lose access automatically when their contract ends.

---

## 3. How a complaint moves

```
Raised            resident, or an officer for a departmental building
  ↓
Verified          Civil Overseer — the SLA figures are fixed here
  ↓
Assigned          Incharge gives it to the contractor
  ↓
In Progress       contractor, naming the workmen
  ↓
Work Completed    contractor CLAIMS completion, with a photograph
  ↓
Inspected         Civil Overseer, on site, with an in-app geo-tagged photograph
  ↓
Closed            resident may confirm, rate, or reopen within 24 hours
```

Other states: **Rejected** (reason required, the resident sees it),
**Rework** (inspection failed, back to the contractor, counted against
them), **Referred for Special Repair** (beyond the contract, goes to the
Staff Officer), **Reopened** (the same ticket, never a new one).

A resident may also raise an **objection while work is under way**. It
goes to the Overseer and Incharge, not the contractor, and the Overseer
must answer within 24 hours.

### The contractor's SLA clock

The contractor is judged only on the time the job is **in their hands**:

- from **assignment** to their **completion claim**;
- if the Overseer sends the work back, from the **send-back** to the next
  claim, **added** to the first period;
- if the resident reopens it, from **reassignment** to the next claim,
  added again — and so on for every round;
- less any **occupant or force-majeure pause** recorded inside those
  periods.

The total is compared with the SLA figure fixed when the complaint was
verified. Time spent waiting for the department — verification,
assignment, inspection — never counts against the contractor; it is the
department's own delay and is measured against the departmental SLAs.

---

## 4. Controls that must not be weakened

Each was chosen deliberately, several after a defect proved it was needed.
A change that relaxes any of them needs a departmental decision first.

1. **Two-key closure.** The contractor may only *claim* completion. Only
   the Civil Overseer closes, and only after physical inspection. The
   inspecting **person** may never be the person the work was assigned
   to, whichever roles they hold. Inspection is accepted **only from the
   app on a registered phone** (device-key session), never from a
   password session on the web.
   *Relaxed for now (user's decision, 2026-10-12, to ease adoption): the
   inspection photograph that evidences the visit is required only once the
   HQ System Administrator switches it on — see control 2 and §5.5.*
2. **Inspection photographs are taken in the app**, with the location and
   time embedded when the photograph is taken. No upload from the gallery,
   anywhere. The photograph must be **the inspecting Overseer's own**,
   taken **after the completion claim** being inspected; after a send-back
   both the contractor and the Overseer need fresh photographs. This is
   what makes the inspection gate real rather than a tick-box.
   *Relaxed for now (user's decision, 2026-10-12, to ease adoption): the
   Overseer's inspection photograph and the contractor's before and after
   photographs are optional until the HQ System Administrator switches each
   requirement on. Any photograph that is attached is still held to every
   rule above, and must record where it was taken.*
3. **Area isolation is enforced by the database itself**, not by screens
   or filters. An officer in Jayant cannot see Nigahi's data by any route,
   and a mistake in the application cannot leak it.
4. **Who may change what is fixed per field.** SLA figures, deadlines and
   every performance counter (escalations, objections, rework, reopenings)
   can be changed by **no person at all**, administrator included. They
   are computed by the system.
5. **Every state change is checked against a table of who may make it**,
   and anything not explicitly allowed is refused.
6. **Only two things pause the SLA clock**: the occupant (quarter locked,
   access refused) and force majeure. Only a departmental officer may
   record a pause. **Want of material and want of labour are the
   contractor's obligation** under the comprehensive contract.
7. **The audit log and ticket history can never be edited or deleted.**
   The only exception is the automatic purge of entries older than the
   two-year retention period.
8. **The order of the inspection queue is set by the department**:
   emergencies, then any priority the Overseer or Incharge sets, then
   premises type, then the date the Overseer verified the complaint.
   Never the contractor's completion claim, which would let the contractor
   plan the Overseer's day.
9. **Evidence only.** No penalty, damages or bill is calculated.

---

## 5. Decisions taken

### 5.1 At requirements stage

| # | Point | Decision |
|---|---|---|
| 1 | Sub-category list | Approved. Administrator may add, delete and rename. |
| 2 | SLA figures | Approved. **Editable by the Incharge** as well as the administrator. Every edit is audit-logged with the old value, and applies **to new complaints only**, never to ones already open. |
| 3 | Emergency categories | The 11 listed are confirmed; administrator-editable. |
| 4 | Escalation | Approved as listed. **Level 4 reaches the GM for normal complaints as well as emergencies.** |
| 5 | Excluded-scope notice | Approved, with Area contact numbers displayed and editable. |
| 6 | Pumps and motors | **No pump or motor sub-category** — quarters have no separate pumps or motors. |
| 7 | Platform | **Native Android and iOS apps, plus a web application.** |
| 8 | Hindi | Supplied with the build; corrected by the administrator afterwards. |
| 10 | Special repair on the notice | Yes. |
| 11 | Retention | **2 years** for documents, photographs and the audit log, matching the longest contract period. Configurable. |

### 5.2 At design stage

| # | Point | Decision |
|---|---|---|
| 12 | What is maintained | **Premises**, with the quarter as one type. Non-residential buildings follow the same lifecycle. |
| 13 | Access | **The device is the credential.** No username or password. An approved installation holds a key that cannot be copied off the handset. *Extended 2026-09-30: the device is one authenticator of a person; NCL employees may also sign in on the web with Employee ID and password.* |
| 14 | Devices per premises | Up to **3 active**, configurable. Family members register their own phones. |
| 15 | Second factor | **PIN or biometric on app open** for Overseer, Incharge, Staff Officer, GM, Administrator and Contractor Supervisor. Not for residents. |
| 16 | Objection during work | **Adopted**, notified to the Overseer and Incharge, not the contractor. |
| 17 | Directory service | **None.** NCL runs no Active Directory. |
| 18 | Inspection order | **Departmental supervisors alone** decide it (control 8). |
| 23 | Overseers per Area | **Three**, split by sector, configurable. Replaces decision 9, which had two. |
| 24 | Dashboards | **Configurable**: which figures, in what order, and when they turn amber or red. **Live work only**; history is reached through search. |
| 25 | Archiving | Closed and rejected complaints leave the working screens **30 days** after closure. Nothing is moved or deleted; search reaches all of it. |
| 26 | Areas | **Thirteen**, NCL HQ Colony included, each with its own contract. |
| 27 | Non-residential buildings | **Direct Civil Department control.** No resident, so the Overseer or Incharge raises the complaint, no occupant confirms it, and the Overseer's inspection is the only check. *Revised 2026-09-30: a building may have a custodian, who raises and confirms like a resident; buildings without one stay as described.* |

### 5.3 Decisions made during the build

- **The SLA deadline is set by the system at verification**, from the SLA
  table. No one can supply or change it afterwards. A later change to
  the SLA table never reaches an open complaint.
- **Counters are computed, never entered.** Reopen, rework and objection
  counts are raised by the database itself.
- **A complaint in another Area answers "not found", not "forbidden"**, so
  the portal cannot be used to confirm that a complaint exists elsewhere.
- **Every photograph must record where it was taken** — the occupant's,
  the contractor's before and after, the objection's and the inspection's.
  *Changed 2026-10-12 by the user's decision; until then only the
  inspection photograph needed a location.* The inspection photograph must
  also be taken in the app (control 2).
- **A complaint counts against the contract of the supervisor it was
  assigned to.** The system works this out; nobody chooses it. (Until
  2026-09-30 an Area could have only one live contract; it may now have
  several — §5.5.)
- **Contract handover** moves open complaints to the incoming contractor
  with a clean cut-off. The outgoing contractor's record is frozen at that
  moment: they inherit neither blame nor credit from what follows.
- **Contract expiry** warns 30 days ahead and cuts off the supervisor's
  devices on the day.
- **Rates in the performance report count complaints, not events.**
  "Rejection rate" is the share of complaints sent back at least once; the
  same for objection and reopen rates. The definition is stated because a
  contractor will otherwise read it whichever way suits them.
- **Photographs are kept two years, then the image is deleted — but the
  record of it stays.** The location, time and fingerprint of an
  inspection photograph outlive the picture, so an old inspection can
  still be shown to have happened, where and when.
- **Resident confirmation runs alongside the Overseer's inspection, never
  instead of it.** A resident disputing accepted work is flagged to the
  Overseer as a quality signal.

### 5.4 Decisions taken on 2026-09-25

| Point | Decision |
|---|---|
| **When the contractor's SLA is met** | Judged on the contractor's own time only: every period from assignment, send-back or reassignment to their completion claim, added up across all rounds of the complaint, less recorded occupant and force-majeure pauses, compared with the SLA fixed at verification. Replaces judging it at the Overseer's acceptance, which counted inspection delay against the contractor. See section 3. |
| **Who approves which device** | As the requirements say (§4.2): the **Incharge** approves residents and custodians; the **Administrator** approves Overseers, Incharges, Staff Officers and Contractor Supervisors, scoped to the whole Area. **GM and Administrator cannot be registered at all** — they are set up centrally. The role requested is shown on the approval screen. |
| **Mobile verification** | Registration **requires the OTP** to the handset (requirements §4.4 step 2). The mobile number recorded is the one proved, not one typed into the form. |
| **Who takes which photograph** | Completion photograph: the assigned contractor. Inspection photograph: the Civil Overseer. Objection photograph: the occupant. Complaint photograph: the occupant, or the Overseer or Incharge for a departmental building. Nobody else can attach one. |

### 5.5 Decisions taken on 2026-09-30

| Point | Decision |
|---|---|
| **Users and roles** | Roles move from the device to the person. A person holds any number of role assignments, each with its Area, designation, acting flag and validity. Only **Area administrators** assign roles, only **within their Area** and only **below their own rank**, never to themselves — with one exception: the **Civil Incharge appoints contractor supervisors** (see Work orders). Every assignment and change carries a reason and is audit-logged. Enforced by the database. |
| **Role switch** | One phone, several roles. Sign in once, choose the role; switch from the header. Each switch issues a token for that one role, and an official role asks for the PIN or biometric again. |
| **Resident pages for officials** | Every official has their own resident page (a Resident role on their quarter). Contractors and supervisors only if allotted a quarter. |
| **Sign-in** | Device key (the app), or **Employee ID + password** on the web for NCL employees — the Employee ID is NCL's **8-digit number**, nothing else (five wrong attempts lock it for 15 minutes). OTP only for registering a phone and setting or resetting a password. Passkeys on the web are planned. *(Built 2026-10-08 — see Passkeys on the web, below.)* |
| **Non-NCL residents** | App only; their phone is verified by the registering authority. They cannot hold a web password. |
| **Inspection acceptance** | Only from the app (device-key session). Every other officer action may be done on the web. |
| **Two-key by person** | The inspector may not be the person the work was assigned to, whatever role either holds. |
| **"Nobody handles their own complaint"** | **Not adopted.** Not workable in NCL's staffing; an officer's own complaint follows the normal route. |
| **HQ System Administrator** | Inside the portal, still bound by controls 4 and 5: cannot move a complaint or edit SLA figures or counters. Server and database access is infrastructure access, to be a separately logged **break-glass** procedure, not an app role. |
| **Assignment of work** | Both the Overseer and the Incharge may assign to a contractor. Several contractors per Area are allowed; each supervisor belongs to one contract. |
| **Custodians** | A building may have a custodian, whose confirmation runs alongside the inspection as a resident's does. |
| **Work orders** | Filled in by the **Civil Incharge** (the Staff Officer may too): firm and address, contract / LOA no., agreement no., name of work, award, site-handover, start and completion dates, remarks, and the contractor's supervisors. Several per Area. **Every change needs a reason** and is logged by the database with the old and new value. The completion date moves **only by a numbered extension** (order no., date, reason), which cannot be edited afterwards; the date as awarded is kept for ever. The contract copy and orders are attached as PDF or scanned JPEG, fingerprinted and never altered. Everyone else in the Area, HQ and the contractor (its own only) read. |
| **Who keeps the work orders** (confirmed by the user) | The **Incharge and the Staff Officer (Civil)** both write work orders, and **both may hand a contract over** to its successor. |
| **Contractor supervisors** (confirmed by the user) | The **Incharge appoints a contractor supervisor directly** on a live work order of their Area — entering the person if new — approves that supervisor's phone and ends the role, each with a reason, audit-logged. **That role only**: every other role stays with the Area administrators. The database refuses the Incharge any other role, any other Area, a supervisor on no work order, and any phone whose owner is not a resident, custodian or supervisor of the Area. A mobile belonging to someone outside the Area is refused rather than taken over. |
| **Job card** | Prepared **by the database** the first time a complaint is assigned (`JC/JNT/2026/00042`), and kept through rework and reopening. It shows the complaint, premises, contract and supervisor read live, plus what the Overseer adds: scope of work, site notes and work items with **estimated quantities, no rates**. **Read** by the Overseer and every role above; **not** by the occupant or the contractor. **Changed** only by the Overseer or the Civil Incharge. Filling a blank needs no reason; correcting what is written, changing or withdrawing an item does. Items are withdrawn, never deleted. Every change is logged by the database. **Locked once the complaint is closed or rejected.** Prints on one A4 page with signature blocks. *Since 2026-10-16 (user's request) the card, on screen and printed, shows every photograph taken in the job — the problem, before, after, the inspection — with when and where each was taken.* |
| **The whole life of the job** (user's finding, 2026-10-07) | The job card records **every round from the first** — a round begins at assignment, at each send-back by the Overseer, and at each reassignment after the complainant reopens it. For each round: the supervisor, when work started, **the workmen named**, **the materials claimed and verified in that round**, the completion claim, the inspection (accepted, or sent back with the remark), the closure, and **every answer of the complainant** (satisfied or not, rating, their words) and their reason for reopening. **The job ends only when the complainant is satisfied**; the card's status says so — work in hand, awaiting the complainant, complainant not satisfied, complainant satisfied (or closed with no dispute within the reopen window; closed on inspection where there is no occupant). The workmen and the complainant's answers are now kept in the permanent history at each step: before, the next round overwrote the first round's workmen, and a later "satisfied" erased an earlier dispute. |
| **Materials** | **A record, never a bill** — no rate, price or amount anywhere. **Master** of materials (code, English and Hindi names, unit, category, the most one job normally needs), kept by the **HQ System Administrator** only; never deleted, deactivated instead; every change with a reason. **Claim lines**: the supervisor the job is assigned to records what was used, **only while the work is under way** (not before starting, not after the completion claim). A line can never be changed — it is **withdrawn** with a reason and claimed again. **Verification**: the **Overseer or Incharge**, after the completion claim and before closure, records the quantity verified (it may be less, or 0) — **never the person who claimed**, whatever role they hold; re-verifying needs a reason; a second officer's confirmation is recorded too. **Reports** for the Overseer and above: consumption by material (claimed, verified, not yet verified, variance) for a contract and period, with CSV; and **anomaly flags** — claimed more than verified, more than a job normally needs, same material at the same premises within 90 days, passed inspection without the materials being verified. Anomalies are departmental signals, never shown to contractors. The contractor sees its own lines and the verified quantities, but not which officer verified. Everything logged by the database. |
| **Contesting a rejection** (user's findings, 2026-10-07) | The occupant may **contest a rejection once**. It goes to the **Overseer and the Civil Incharge**, either of whom reinstates the complaint (it returns for verification) or upholds the rejection, with a note the occupant sees. **Upheld, it goes automatically to the Area Civil Staff Officer, who must decide in writing** (reinstate or uphold). |
| **Disputing before closure** | If the Overseer has accepted the work but not closed it and the occupant says it is not fixed, the complaint is **reopened** exactly as after closure. The Overseer can no longer close it over the occupant's head. |
| **Repeated disputes** | When a complaint is **reopened for the third time**, the database refers it to the **Area Civil Staff Officer**; until the Staff Officer decides **in writing** — redo the work, close it, or refer it for special repair — **nobody can reassign it**. The decision is shown to the occupant, Overseer and Incharge. |
| **After a Staff Officer's decision** | The occupant can **neither contest nor reopen that complaint again** in the portal, and is told: "This complaint has been decided by the Area Civil Staff Officer. Further disputes are not taken in the portal; you may write to the Area Civil Office." Disputes and decisions are never shown to the contractor. |
| **Before and after photographs** | *(Optional since 2026-10-12 until the HQ System Administrator requires them — see below.)* A completion claim needs **at least one "before" and one "after" photograph** of that round of work, the assigned supervisor's own; **at most three of each per round**. A new round (send-back or reopening) needs fresh photographs. The job card shows the count per round. |
| **Repeat complaints** | The "same quarter, same fault (3 or more)" list counts **every report**: each complaint and each reopening of it, so one complaint reopened three times appears, flagged while the Staff Officer's decision is pending. |
| **Search** | Finds complaints by the **fault's own names** (category and sub-category, English and Hindi), the **quarter**, the description and the complaint number, and by **word beginnings** ("leak" finds "leaking" and "leakage"). |
| **Measurement book** (2026-10-07) | **Quantities only; no bill** (control 9). Once the Overseer has accepted the work, the **Overseer or Incharge measures each job-card item** — Nos × length × breadth × depth/height, the database working out the quantity, or a quantity alone — and may continue after closure, because the MB is written later. Measuring again needs a reason. The **MB-ready extract** lays out every measurement of a contract and period as MB entries (with the materials verified on each job), on screen, printed and as CSV. When entries are **written into the department's Measurement Book**, the MB number and page are recorded and **the entry is frozen**. The **Area Civil Staff Officer check-measures** entries, never one they measured themselves; the extract shows how many are checked against an aim of **10 %** and flags any check more than **5 %** from the measurement (both settings). The contractor sees what was measured on its own jobs and the MB reference, but not the job card's estimates or the check-measurement. Every step is logged by the database; nothing is deleted. *Assumed in building it, to be confirmed by the department: the 10 % and 5 % figures, and that only job-card items are measured.* |
| **HQ executive dashboard** (2026-10-08) | For the **GM (Civil), Directors and CMD** (and the HQ System Administrator); nobody else. Read-only, all thirteen Areas, computed from the record: KPIs this month against the previous month; every Area ranked by SLA compliance with its movement; SLA by Area and month; the trend against the **target (90 %, a setting)**; **where the time goes** — contractor, department, and occupant / force-majeure pauses; the complaint funnel; load (complaints per 100 quarters per month) against performance; category concentration; contractors across Areas, flagged when below target in more than one; and **what needs HQ attention** (SLA below target, inspections waiting over 48 h, complaints open at level 4, contracts ending within 30 days, disputes awaiting the Staff Officer). The definitions are on the screen — a rate is stated so it cannot be read two ways. **Evidence only**: the design's deductions column and panel are left out (control 9), and so is its map, as no survey coordinates exist. CSV of the ranking. |
| **Break-glass** (2026-10-08) | Emergency access to the databases is **not an application role**. It is a procedure run on the server with the database superuser's credentials: it opens a **named, temporary database login for one person** — operator, **approver (never the operator)**, approval reference and a reason in a sentence — **read-only by default**, for **5 to 240 minutes**, after which PostgreSQL itself refuses the login. It reads across Areas (row security is bypassed — that is usually why it is needed) but can **never delete, truncate or restructure** anything, and the database's own rules still hold: history stays append-only, and nothing changes on a complaint unless the operator states the capacity they act in. **Every statement it runs goes to the server's log.** Every opening, closing and expiry goes to a **separate register** the portal cannot read or alter — append-only, hash-chained, copied to a file — and is **announced in the portal to the GM (Civil) and the HQ System Administrator**. Runbook: development_logs.md §10. |
| **Passkeys on the web** (2026-10-08) | An NCL employee may sign in on the web with a **passkey** — a key held by their phone, laptop or security key and unlocked by **fingerprint, face or PIN** (always required) — instead of typing the password; no Employee ID to type either. **Adding one asks for the web password again**, so a screen left signed in cannot be used to plant a lasting way in; at most **5** per person (a setting). A passkey session is still the **web**: accepting an inspection still needs the app (control 1). The owner, or an **Area administrator** for a person in their Area (a lost or stolen phone), **removes** one **with a reason**; it stays listed as removed, is refused at once, and its sessions cannot be renewed. A key whose signature counter goes backwards — the sign of a copy — is refused and logged. Every sign-in, addition and removal is logged. Non-NCL residents and contractor staff stay app-only. |
| **What the contractor sees of a reopening** (confirmed by the user, 2026-10-08) | The contractor **sees that a job was reopened, and why** — it comes back to them to redo. The occupant's confirmations, ratings and words, disputes and the Staff Officer's decisions **stay hidden** from them. |
| **Closing a complaint that reached the GM** (2026-10-12) | A complaint escalated to level 4 is closed only after the **Area Civil Staff Officer records a remark** on it — written once, never changed, with who and when kept by the database, and shown in its history. The remark is the Staff Officer's alone; the database refuses it from anyone else. (The rule was in the original design; the means to record the remark was missing, so such complaints could not be closed.) |
| **Jobs left with an ended supervisor role** (user's request, 2026-10-12) | When a supervisor's role is ended, the jobs it still holds are **listed in the ending dialog** first, and afterwards **every such complaint is marked in red** in the queue and on the complaint — "Supervisor's role has ended — reassign" — until the Overseer or Incharge reassigns it. Ending the role is not refused. |
| **A phone belongs to the owner of the mobile proved** (2026-10-12) | A phone registered with a mobile already on record joins that person, whatever name is typed, because the OTP proved the mobile. The registrant is now told so in the person's name, and approvers see the real name. |
| **Photographs optional until HQ requires them** (user's decision, 2026-10-12) | To ease adoption, the contractor supervisor's before and after photographs and the Civil Overseer's inspection photograph are **optional**, as the occupant's are. Two settings, **both off to begin with**, make them compulsory again: *completion_photos_required* and *inspection_photo_required*. **Only the HQ System Administrator** switches them, when the portal has matured; the database refuses anyone else and logs every change with the old and new value. **Everything else is unchanged**: a photograph that is attached must still be the taker's own, taken in the app, located, after the claim (inspection), three at most per round; inspection is still accepted only from the app; the inspector is never the person who did the work. This relaxes controls 1 and 2 while the settings are off (§4). |
| **Location on every photograph; camera and location compulsory** (user's decisions, 2026-10-12) | **Every photograph records where it was taken**, and the server refuses one without a location. The app fires the shutter only once it has a location fix, writes the location into the photograph itself as well, and shows it under every photograph, on the phone and on the web. **Camera and precise location are compulsory**: Android asks for permissions while an app runs, never at install, so the app asks when first opened and goes no further until both are granted and the phone's location is switched on — checked again whenever it is reopened. **Gallery access is not asked for**: the app never reads the gallery (control 2), and the user confirmed it is not required. |
| **The occupant's photographs** (user's findings, 2026-10-10) | The occupant may attach **up to three photographs at each step** — when raising, with each reopening (at least one), and with an objection while work is under way — as the contractor takes up to three before and three after in each round. **An objection's photograph is never shown to the contractor**, as the objection itself is not (§2). Every photograph is **shown with the complaint** to those who may see it: the occupant (their own, the contractor's before and after, the inspection), the officers, and the contractor (all but the objection's). |
| **Adding a home, already signed in** (user's request, 2026-10-13) | Someone whose phone is already approved — a contractor supervisor of one Area who lives, as a Non-NCL resident, in another; an official whose quarter is in another colony — **asks from the app** (Profile → My homes → Add my home) for a quarter or a building in any colony. No new phone and no new OTP: the phone and the mobile are already proven. The request goes to **that colony's Civil Colony Incharge** (or Area administrator), who checks the quarter and approves **the role alone**, as for a new resident; it then appears among the person's roles on the same phone. Only a resident's or custodian's role can be asked for; official roles stay with the Area administrators. One request waits at a time; nobody approves their own; refusal needs a reason, which the person sees. **Area isolation holds**: the approving Incharge sees the person and the quarter asked for, never their roles in another Area. Before, such a person was stuck: their phone could not register again, the other Area's Incharge was refused by the database (an official role elsewhere), and its administrator could not see them. |
| **A phone registered in another Area** (user's decision, 2026-10-13) | A phone belongs to the records of the Area it was registered in. Where its owner also holds a role in another Area, that Area's administrators are told **how many** such phones there are — never their details — and **cannot revoke them**: revoking a phone stops all the person's roles, so it rests with the Area of registration and the HQ System Administrator. To end the person's access in their own Area, they end the role that is theirs. |
| **Colony notices** (adopted from the design experiment, 2026-10-15) | When one fault affects many quarters — the water main to a block — the **Civil Colony Overseer or Incharge posts a notice** for a colony of their Area, so its residents see it **before they report** and need not raise the same complaint twenty times. Residents and custodians of that colony see it on their home and on the report form; officers of the Area and HQ read it; **contractors do not**. A notice is **ended with a reason, never edited or deleted**; who posted and ended it, as a role, and when, are set by the database and logged (`NOTICE_POSTED`, `NOTICE_ENDED`). It carries no resident's data. |
| **The Overseer's pending work on the phone** (user's request, 2026-10-15) | So that work moves while the Overseer is in the colony, the app offers what the web's Today page lists: **verify or reject** a new complaint, **assign** it to a contractor supervisor (and **reassign** one whose supervisor's role has ended, with a reason), inspect, and close. Which of these appears is the server's answer for that complaint and role, as on the web; nothing is relaxed — the SLA is still fixed by the database at verification, a rejection still needs the reason the occupant sees, and inspection is still accepted only from the phone. Materials, clock pauses and objections stay on the web. *Extended the same day at the user's finding:* the app opens on three tabs — **Today**, **Open** (every live complaint of the Area by stage) and **Completed** (closed work) — and each complaint says **where it stands** (whose hands it is in, since when) with the **life of the job** round by round and its history; a job already with a supervisor is reassigned only on purpose. The contractor supervisor's app and the web Inbox gained a **Completed** tab too, which says whether the contractor was within their own time (README §3). |
| **The contractor firm's jobs on the phone** (user's request, 2026-10-15) | The firm's own role (rank 2, its own contract only) opens on **Our jobs** and **Completed** in the app: every job of its contract, who holds it, the contractor's own time, materials and their verified quantities, what Civil measured, photographs and history — **read only**. Contractor staff stay **app-only** (they hold no web sign-in), so there is no web page for them. As for the supervisor, the occupant's objections, answers, ratings and disputes stay hidden. *Building it found the firm's role could read the occupant's objections* — the rule named only the supervisor; now both (§9). |
| **Contractor staff on the web** (user's decisions, 2026-10-16) | Replaces "contractor staff stay app-only" (Sign-in, Passkeys and the firm's row above). The sign-in page has two more tabs, **Contractor** (the firm) and **Supervisor**: the **mobile number and an OTP, every time** — no password — and **only for someone whose phone is already approved in the app** (the mobile was proved, and the person checked, when that phone registered). One OTP signs in once; the same limits as today (five wrong codes, three requests an hour). The session reaches **only the role of its tab**: a supervisor who is also a Non-NCL resident cannot reach the resident's home from the web. It **ends with the phone or the role**: revoked, or the contract ended, and it is refused at its next renewal (within 15 minutes). **The firm on the web reads only**: its jobs live and completed, who holds each (filter by supervisor), the scorecard and work orders, and a **CSV** of its jobs. A firm with several work orders holds **one role per work order** and switches between them (user's choice, so Area isolation is unchanged). **The supervisor on the web reads its jobs and records or withdraws materials**, in the same office layout as the Overseer's (user's request, the same day) — side menu, tiles, Live / Completed, the complaint panel; **starting work, the completion claim and every photograph stay in the app** — refused by the database from a web session (control 2 unchanged). The OTP at sign-in is the second factor. **Every act records how its session signed in**, and officers see "from the web" in the history and on material lines. Nobody is notified of a web sign-in; the sign-in log keeps it. *The OTP is shown on screen in development; the department arranges an SMS gateway before go-live.* |
| **CSV for the department** (user's request, 2026-10-16) | The Overseer, Incharge, Staff Officer, HQ officers and the HQ System Administrator download complaints as CSV **from the Inbox** (Live or Completed) **and from Search** (the results of any search, archived ones included). Row security decides every row. Residents and supervisors are not given it; the firm has its own. |
| **Materials and measurements after the work: the approval chain** (user's decisions, 2026-10-16; all of it built the same day, the phone excepted) | **Up to closure nothing changes**: materials claimed while the work is under way, and the Overseer's or Incharge's verification before closure, stay as decided above. **After the work, each job's materials and each job's measurements go up a chain** — **contractor supervisor → Civil Overseer → Civil Colony Incharge → Area Civil Staff Officer** — approved **separately**, each by the Staff Officer. *Materials* may be added by the supervisor **while the work is under way and after it** (after the completion claim and after closure too); *measurements* are **the supervisor's own measurement sheet**, from when the Overseer has accepted the work, measured **against the job card**, which the supervisor now sees **in full** (scope, site notes, items with estimates, changes) and may change or add to, every change recorded with who and when. **Hand-over**: the supervisor presses *Send for review* and can change nothing after unless it is sent back. **Overseer and Incharge**: each may change any quantity (with a reason, recorded) or add a missed item, then pass it up — or send it back one step with a remark; *Reviewed — no change* is recorded as their review; **no step is skipped** (an Area without an Incharge appoints an acting one). **Staff Officer**: approve, or change (with a reason) and approve, or send it back; he may approve what he changed himself, the record showing it. **Locks**: the materials are approved on their own, but **the MB approval is the final lock for the job's materials too** — until then the Staff Officer may send approved materials back down; the job card may be changed by the chain **until the MB is approved**. **After approval only the Staff Officer** changes anything, each change with a reason, the old and new values, a correction reference, shown to the Overseer and Incharge. **Who sees what**: officers see every change with the person's name and time; the supervisor and the firm see each change, its reason and the step **by role, never by name**. **The paper Measurement Book stays official**: the portal keeps a **reference record** for it — **one MB number per contract**, entries running on **fixed-size printed pages** from the first entry, each job **indexed** in it, a revision **appended, never rewritten** — opened per job and per contract and printed. **Sample check**: the Staff Officer chooses which jobs to check-measure on site, **at least 1 in 10 a month per contract**; the portal counts and flags a shortfall; **approval does not wait** for it. A job **waiting more than 7 days at one step** is flagged on Today and the Area dashboard (a setting). **Quantities only** (control 9). Replaces: materials only while the work is under way; measurements by the Overseer or Incharge alone; an MB entry frozen once written, with the Staff Officer's one-in-ten check before; the job card hidden from the contractor and changed by officers only. |
| **Working through a month's MB; finding it years later** (user's decisions, 2026-10-16) | With a hundred jobs a month, each officer of the chain works from **one worklist** on the Measurement book page, not from a hundred complaints: for a contract and month, how many jobs wait at **their own step**, how many are still below them, sent back, approved, and waiting over 7 days; one row per job (changes made in the chain marked), and beside it the job's **review** — job-card items and estimates, the supervisor's measurement, each change with its reason (the MB lines), the materials claimed against verified, the record of moves — with the actions of their step. The Overseer and Incharge get the same page for their steps, and their waiting jobs on Today. **One job at a time**: there is no approving several together, so every approval is a considered act on that job's evidence. **Each job's approval is the only sign-off**; there is no monthly confirmation on top. **Finding it later**: the contract's MB opens by month and page (never all at once), with the index of jobs; an **MB search** across a contract or the Area's contracts by complaint number, quarter, fault, words of an item, MB page, approval dates or stage, each result opening the page with the job's lines marked; the portal's Search shows a closed job's MB reference and filters to approved ones. The archive takes jobs off the working screens, never out of the MB. *Assumed, to be confirmed by the department: the MB record is kept for the life of the contract records and not purged with photographs and the audit log after two years, as the contract copy is not.* |
| **A role is held in one Area** (2026-10-09) | Every role below HQ — Overseer, Incharge, Staff Officer, Area administrators, contractors, occupants — is held **inside one Area**, whoever assigns it, the HQ System Administrator included, who must choose the Area. The database refuses anything else (control 3). **The HQ System Administrator may assign any role below their rank in any Area**, to fill a gap such as an Area with no Incharge (decided by the user, 2026-10-09; may be narrowed to Area administrators and HQ roles later). |
| **Coming phases** | All the phases decided on 2026-09-30 are built. Next: the deliberate attempt to break the system (§9). |

---

## 6. What the load simulation measured

Run against the real database with 15,000 quarters, 123 non-residential
buildings and 20,000 devices across 13 Areas.

**Inspection capacity** — three Overseers per Area, 12 minutes per
inspection, four hours a day actually in the field, 26 working days:

| Complaints per quarter per month | Per Overseer per day | Field time used |
|---|---|---|
| 0.25 | 3.7 | 18% |
| **0.50** (planning figure) | 7.4 | 37% |
| 0.75 | 11.1 | 55% |
| 1.00 (provision for this) | 14.8 | 74% — tight |
| 1.25 | 18.5 | 92% — at the limit |
| 1.50 | 22.2 | 111% — **not feasible** |

Above about 1.25 it stops being a software question: the choice is a
fourth Overseer in the heavier Areas, a longer inspection SLA, or
rethinking mandatory inspection for the lowest-risk categories. Nobody
knows the real complaint rate yet; expect it to rise sharply at first
because the portal is easier than the paper register. Watch the
**inspection backlog** figure in the first two months; it already warns
the Incharge at 48 hours.

**Photograph storage** — 3.7 photographs per complaint at about 0.32 MB
each. At the planning rate the store settles at **about 214 GB** under the
two-year retention and stays there. Without the purge it would grow
forever, so the purge is essential, not housekeeping.

**The database is not the bottleneck.** At 90,000 complaints every
everyday query took under 25 ms.

**Worth knowing:** because the queue orders D → C → B → MQ → A and Type A
is the largest group, the largest resident population is inspected last
by design. Revisit if satisfaction by quarter type diverges.

---

## 7. Out of scope

Colony common areas (roads, drains, parks, boundary walls), sanitation
services, water tankers and colony-level supply, **electrical work (E&M
Department)**, estate matters (allotment, transfer, licence fee) and major
structural repair beyond the contract. The resident-facing notice lists
these in English and Hindi with each Area's contact number.

The shared identity service (devices, people, premises) is built to be
reused by the future E&M portal.

---

## 8. Decisions still needed from the department

1. **SLA for non-residential premises.** Should a dispensary or school
   have shorter times than a quarter for the same fault? The system
   supports it; today all premises share one set of figures.
2. **Sign-off** of the design decisions above by the Civil Maintenance
   Incharge, Staff Officer (Civil) and GM (Civil).

---

## 9. Where it stands

- **Web application and server: working.** 153 API endpoints, 2,025
  automated tests in twenty-seven suites and four permission matrices all pass
  on this machine.
- **Done 2026-10-16:** materials and measurements after the work (§5.5) —
  the approval chain for each job's materials and measurements, the
  supervisor's view and changes of the job card, his own measurement sheet,
  and the MB reference record (one MB number per contract, pages of 25
  lines, revisions appended), viewed per job and per contract and printed.
  The same day: each officer's worklist on the Measurement book page with
  the job's review beside it, the 7-day flag on Today and the Area
  dashboard, the sample check, and finding a job's MB later (by month and
  page, an MB search, the MB reference in Search). Next: the same on the
  phone.
- **Done 2026-10-16:** contractor staff on the web — the Contractor and
  Supervisor sign-in tabs (mobile and OTP), the firm's read-only Jobs page,
  the supervisor's materials on the web, "from the web" in the record, CSV
  for the firm and the department, and the job's photographs on the job card
  (§5.5).
- **Done 2026-10-15:** the web portal's new look and screens from the design
  experiment (design-decisions.md): the brick mark, Noto Sans, seven colour
  schemes, the GIGW frame, the command palette, the officer's Inbox and
  Today, the resident's complaint as a receipt, colony notices (§5.5), the
  HQ tracker and wall display.
- **Done 2026-09-30:** work orders (§5.5) — several contractors per Area,
  filled in by the Incharge, reasons compulsory, extensions, supervisors,
  contract copy, full history.
- **Done 2026-09-30:** users and roles (above, §5.5) — people with
  several roles, role picker and switcher, Employee ID + password on the
  web, Area administrators' People and roles screen, resident pages for
  officials, custodians for buildings, inspection acceptance from the app
  only, two-key by person.
- **Done 2026-09-25:** the four control gaps found on review — self-chosen
  roles at registration, anyone's photograph passing the inspection gate,
  old photographs passing after rework, and the contractor's SLA being
  judged at the wrong moment — are closed, each with tests.
- **Done 2026-09-25:** the web portal, built from the Claude Design
  handover (hero, sign-in, resident, contractor, work queue, Area
  dashboard, scorecard, HQ, administration). Where the design disagreed
  with a decision above, the decision was kept — see
  [design-decisions.md](design-decisions.md).
- **Done 2026-09-30:** the job card (§5.5).
- **Done 2026-10-01:** materials (§5.5).
- **Done 2026-10-07:** the job card records the whole life of the job,
  every round, until the complainant is satisfied (§5.5).
- **Done 2026-10-07:** contested rejections and repeated disputes decided
  in writing by the Staff Officer, disputes before closure, before/after
  photographs, the repeat-complaints list and search (§5.5).
- **Done 2026-10-07:** the measurement book — measurements, MB-ready
  extract, MB references and the Staff Officer's check-measurement (§5.5).
- **Done 2026-10-08:** the HQ executive dashboard (§5.5).
- **Done 2026-10-08:** the break-glass procedure (§5.5, runbook in
  development_logs.md §10).
- **Done 2026-10-08:** passkeys on the web (§5.5).
- **Done 2026-10-08:** the deliberate attempt to break the system from
  all three sides — a **contractor gaming the record** (78 attacks),
  **officers exceeding their authority** (96) and a **resident gaming the
  queue** (97), each kept as a permanent suite. The resident side found the
  most serious hole of all: **an OTP could be guessed without limit** (the
  five-attempt count was undone with each refusal), which left phone
  registration and web-password resets open; and **one OTP registered any
  number of phones** (open defect 8). Both closed. Five real holes were found and closed in the database:
  a contractor's session could forge an SLA pause and rewrite whose delay a
  breach was; a second, racing completion claim rewrote the claim time; a
  material claim could slip in behind a completion claim; and a stored
  photograph could be swapped through its upload link and served. Two
  smaller leaks to contractors were closed (the occupant's own rating and
  words, the verifying officer's field).
- **Done 2026-10-09:** a role below HQ is held in one Area, whoever
  assigns it (§5.5). Found testing on live data: a role given by the HQ
  System Administrator with no Area chosen became a role in every Area.
- **Begun 2026-10-09: the Android app.** Phase A1 — registering the phone
  with OTP, its key kept in the Android Keystore, signing in with it, the
  role picker and the PIN or fingerprint for official roles — works on a
  real phone against this machine's portal. A2, the resident's screens,
  runs on the phone and is being retested. A3, the contractor supervisor's
  screens (start with the workmen, before and after photographs, materials,
  the completion claim), is built (2026-10-12) and awaits its test on the
  phone. For testing, debug builds install as three separate phones on one
  handset (2026-10-13). A4, the Civil Overseer's inspection — the queue in
  the department's order, the inspection photograph taken on site with its
  location, accept or send back with a remark, close — is built
  (2026-10-15) and awaits its test on the phone. The web's colour schemes,
  colony notices and escalation path reached the app the same day. Then: A5 push, offline,
  attestation, Hindi.
- **Then:** production hardening — deployment, backup and tested restore,
  secrets, rate limiting, monitoring of the three background sweeps (a
  sweep that silently stopped has happened once already).
- **The largest remaining piece: the Android and iOS apps.** They carry
  the control everything else depends on: camera capture with the
  location embedded at the moment of the photograph, and keys that cannot
  leave the handset.
- **Rollout:** premises register built up through registration, Area by
  Area; training material for Area offices.

### Outside the software, with a real deadline

**Contractor use of the portal must be written into the next
comprehensive maintenance tender** as a contractual obligation.
Introduced mid-contract as a request, it will not be complied with. Area
contracts run on independent one- and two-year cycles, so **a tender
floated without the clause locks that Area out for up to two years.** The
clause should be drafted and sent to all thirteen Area offices now.

Resident adoption is the other deciding factor: a portal nobody uses
only moves the paper register onto a screen. The notice board, visible
escalation and reliable response matter more than they appear to.
