# Fixture-page stream panel, Directory destinations, signal-path redesign — design

**Status:** owner-approved 2026-09-30 in conversation. Design sections 1 and 2, the visual option and every ruling
below are the owner's; this file records them. Branch `feat/fixture-page-stream` (worktree
`.claude/worktrees/fixture-stream`), cut from `main` 770bdca07 (Streaming R1 lane D, #904).

**Mockups of record:** `2026-09-30-fixture-page-stream-mockups/` — `option-a.html` (the panel, five states) and
`directory.html` (the Streaming tab), with 320 and 1280 captures. They are static HTML on the Tailwind CDN and are
the reference for layout, states and copy. They are not code to port.

**Why this exists.** The staging checks on 2026-09-30 proved Stop and delivery to YouTube, and found four product
gaps in one afternoon:

- the organiser could not find the panel (it sits inside a run-sheet row);
- a destination saved with the key's NAME ("TestYouTube") instead of the key could not be edited or removed;
- the panel said **Live** while YouTube received nothing;
- a second match's Go live answered "That destination is already live on another match" without naming the match.

This design fixes all four and gives the panel a look that explains the stream.

## 0. Owner rulings (2026-09-30)

| # | Ruling |
|---|---|
| P1 | The panel moves to the organiser fixture page. On desktop a **Stream** button sits beside the hand-over button in the Scoring header and opens an inline panel. On phone a 44 px stream icon sits beside ⇄ in the header strip. Organisers only. |
| D1 | Destinations are managed **only in Directory**, as a new **Streaming** tab beside Players · Clubs & Teams · Officials · Venues. The fixture panel has a picker plus "Manage destinations"; there is no inline add form. |
| D2 | **Remove = archive**, hidden forever: no "show removed" and no restore UI. History keeps the name. Re-adding the same key brings the old row back. Remove and Replace key are refused while a match is live **or waiting** on the destination, and the refusal names that match. |
| D3 | Phone live, but the destination has not received for **30 s**: amber warning, the stream keeps running, Stop stays one tap away. A hard `rejected` still ends the session, as today. No auto-end, no refund path. |
| D4 | "Hand over device" is renamed **Remote scoring**, both the button and the panel title, in all 4 locales. |
| D5 | Visual design is **Option A, "Signal path"**, with **lime** chain lines (the house theme, lightly). |
| D6 | Destinations are **YouTube and Twitch only**. Facebook, Kick and "Other" (Vimeo, Restream, Cloudflare Stream) are dropped. LinkedIn is still never offered. |
| D7 | **Every QR carries the Seazn logo in the centre** (a standing rule). This branch covers the three fixture-page QRs; the other six follow in a separate PR. |
| D8 | Design section 2 (Directory, server, wiring, tests) is approved. |
| D9 | capture-qr **v2**, with a per-session token, is the web side's to build, in its own branch after this one. v1 minting stops the day v2 ships. This branch only reserves the heartbeat slot on the Phone node (§3.4). |

## 1. Goal, users, success

**Who:** a club owner or admin running a match from its fixture page, often on a phone at the court.

**Job:** send this match to YouTube or Twitch, know at a glance whether viewers are actually receiving it, and stop
it cleanly.

**Success means:**

- The panel is found from the match itself.
- A wrong key is visible ("key ends …ube") and fixable in Directory.
- A stream that is not reaching the destination says so within about 30 s.
- A busy destination names the match holding it and links there.
- Stop is reachable in every gate state.
- Nothing changes at ≥768 except the two header buttons and the panel's new home.

## 2. Placement — the fixture page (P1)

**Route:** `/o/[orgSlug]/c/[compSlug]/d/[divSlug]/f/[no]` (`page.tsx`). The page gains `searchParams` so it can read
the checkout return.

**Who sees Stream.** The page-level `canEdit` from `requireFixturePage` (EDITOR_ROLES, owner or admin), and either:

- the org is streaming-entitled; or
- an active session exists for this fixture.

The second case covers frozen, unentitled and switched-off orgs, and finalized or cancelled fixtures, so **Stop is
always reachable** (today's PhoneStopProbe guarantee moves here). Officials who can only score never see Stream.

Note that the console's own `canEdit` prop (`canScore && !frozen`) is a **different** value and must not be reused.

**Desktop (≥768).** The Scoring header row reads `Scoring … [● Stream] [⇄ Remote scoring]`.

- Stream is a `btn btn-ghost min-h-11` whose dot shows state:
  - no dot when idle;
  - amber while provisioning or warming, or during the D3 warning;
  - red while live.
- Its label is "Stream", or "Live" while live.
- The panel renders inline under the header row, where the hand-over panel renders today.

**Phone (<768).** A 44 × 44 `[●]` icon button sits beside `[⇄]` in the fixture header strip, with the same classes as
`device-handover-phone`. The panel opens at the top of the Scoring card. `consoleScoringEmptyOnPhone` exempts an open
stream panel exactly as it exempts `handoverOpen`.

**One panel open at a time.** `handoverOpen: boolean` becomes `openPanel: "handover" | "stream" | null` in
`fixture-console.tsx`, so opening one closes the other. `detailsOpen` and the PhoneDisclosures stay independent.

**Duplicated controls.** Two controls now exist twice: hand-over (`device-handover` / `device-handover-phone`) and
stream (`fixture-stream` / `fixture-stream-phone`). Each desktop twin carries `max-md:hidden` and each phone twin
`md:hidden`.

This amends `2026-09-02-scorepad-v3-phone-composition-design.md`:

- §2 line 33 "the only control that exists twice";
- §3.1;
- the control-set table.

It also amends AGENTS.md ("Exactly ONE control is duplicated"). Each amendment gets a dated note citing this file.

**Division run sheet.**

- The `fixture-stream-toggle` and the in-row panel are removed (`desk/run-sheet-row.tsx` :192, :433, :497-499,
  :722-729).
- A row whose fixture has an active session shows a small chip, "● Live" or "● Waiting for phone", linking to that
  fixture page with `?stream=open`.
- The division page stops building `StreamPanelContext` and stops mounting the frozen-page PhoneStopProbes. The chip
  is the path to Stop.
- `checkoutReturn`, and any run-sheet filter logic that existed only for it (`runSheetKeeps` /
  `initialRunSheetFilter` from #904's D2), is removed **if** nothing else uses it. Check the callers first; the brief
  is a hypothesis.

**Checkout return.** `api/billing/relay-checkout/route.ts` (:107, :118) builds the return URL for the fixture page:
`…/f/{no}?stream=open&checkout=success&session_id=…`. The fixture page auto-opens the Stream panel on the Phone tab,
strips the params with `router.replace`, and scrolls the panel into view. These are the existing three readers
(fixture-stream-panel.tsx :257-335), re-homed.

**Shared context loader.** A server helper (for example `loadStreamPanelContext(auth, fixture)`) builds
`StreamPanelContext`:

- entitlements;
- relay reconcile;
- the monthly grant;
- credits and currency;
- overlay keys and dict.

Today this lives in the division page (:540-606). One loader means one authority for the context.

## 3. The panel — Option A, "Signal path" (D5)

### 3.1 Frame

- The panel keeps its card inside the Scoring card, with tabs **Phone** first (the default) and **OBS overlay**
  second (today's OBS tab, unchanged).
- The disabled "With scorebug — Coming soon" control is removed.
- The 4-step stepper and the technical health chips are replaced by the chain. fps, Mbps and the heartbeat age move
  into a closed **Details** disclosure.
- Credits collapse to one line under the action: "Uses 1 credit · {n} left · Buy more". The monthly/bought split is
  the line's `title`.
- The no-credit state (the pack tiles) is unchanged.

### 3.2 The chain

Three nodes, **Phone ── Seazn ── {YouTube|Twitch}**:

- each node is a 40 px circle with an icon, its name, and a state word;
- the destination's label sits under its node at ≥768, and on its own line under the chain at <768;
- the chain box has a 2 px lime top border.

**Lime (`--mk-lime` #a3e635) is never used for text.** State words use ink and muted colours.

| Session / signal | Phone node | link 1 | Seazn node | link 2 | Destination node |
|---|---|---|---|---|---|
| idle (Ready) | slate, "Not connected" | slate dashes | slate, "Ready" | slate dashes | slate, "Not live" |
| provisioning / warming | amber ring, "Waiting" | **lime dashes, animated** | amber, "Waiting" | slate dashes | slate, "Not live" |
| live, output ok | **lime ring**, "Connected" | **solid lime 3 px + soft glow** | lime ring, "Receiving" | solid lime + glow | **red ring + dot, "Live"** |
| live, output connecting < 30 s | lime ring | solid lime | lime ring | lime dashes, animated | amber, "Connecting" |
| live, output not ok ≥ 30 s (D3) | lime ring | solid lime | lime ring | **amber dashes** | **amber ring + "!", "Not receiving"** |
| live, phone ingest stale | amber, "No signal" | amber dashes | amber, "Waiting" | as output | as output |
| ending | slate | slate | slate | slate | slate, "Ending…" |

The animation runs only while connecting and respects `prefers-reduced-motion`.

The D3 warning box sits under the chain, in amber: "Live from the phone, but {Platform} isn't receiving it. Check the
stream key in Directory." with an **Open Directory** link.

**Ended and failed** keep today's summary and failure boxes, restyled to the new frame. The chain is not shown in
those two states.

### 3.3 Actions per state

- **Ready:**
  - the destination picker (the platform mark plus the label);
  - "Manage destinations", which opens `/directory?tab=streaming` in a new tab;
  - **Go live** (btn-primary, full width);
  - the credits line.
- **Waiting:** the QR (§7) at ≥320 px on desktop and full width on a phone, the paste code, and Cancel.
- **Live:**
  - "On air" with the elapsed time (Geist Mono, large);
  - a full-width red **Stop stream** with today's confirm dialog;
  - Details.
- **No destinations:** "No destinations yet. Add one in Directory." with a link. Go live is disabled.
- **Destination list failed to load:** an inline error, "Couldn't load your destinations.", with **Retry**. It is
  never shown as "none". This fixes the silent catch at :1025-1026.
- **Destination in use** (the `target_in_use` refusal): "{label} is {live|waiting for a phone} on Match {n} · {court}.
  Stop it there or pick another destination." with an **Open Match {n}** link.

### 3.4 Reserved slot (D9)

The Phone node takes a one-line summary under its state word, for example "🔋 64% · warm". The detail goes in Details.
**This branch renders nothing there.** The capture-v2 branch fills it from the phone heartbeat. The component takes
an optional `phoneStatus` prop, left unset.

## 4. Directory → Streaming tab (D1, D2, D6)

**Where.** `src/app/directory/page.tsx` adds `"streaming"` to `TABS` (:29), with the label key
`directory.tab.streaming` in 4 locales. The panel is a new client component (for example
`stream-destinations-panel.tsx`) following `venues-panel.tsx`:

- inline forms and cards, no modals;
- `useConfirm` for Remove;
- `router.refresh()` after each mutation;
- `apiV1` for every call.

The page keeps its live description copy.

**Who.** Every org member sees the list. Add, Rename, Replace key and Remove render only for `canEdit` (owner or
admin), matching the API's write gate. A frozen seat's writes are refused by the API as today.

**Add form** (open under "+ Add destination"):

- **Platform:** a segmented choice, YouTube | Twitch, each with its brand mark.
- **Name:** 1–80 characters.
- **Stream key:** password-style, with a Show toggle.
- **Watch link:** optional, `https`.
- **No server field.** The server URL is filled per platform (§5.4).
- **Key-shape warning.** It warns and never blocks. A pure function, shared by the client and its tests:
  - YouTube: `^[a-z0-9]{4}(-[a-z0-9]{4}){3,4}$` (case-insensitive). Message: "This looks like a key name, not a key.
    A YouTube key looks like abcd-1234-efgh-5678-ijkl."
  - Twitch: `^live_\d+_[A-Za-z0-9]{20,}$`. The Twitch message has the same shape.

**The list** is one card with divided rows, not a card per row. Each row shows:

- the platform mark;
- the name (semibold);
- a subline, "{Platform} · key ends …{hint} · added {date}". There is no hint when the server returns none (§5.3).
- an optional badge:
  - **"Live on Match {n}"**: red, with a dot;
  - **"Waiting for phone on Match {n}"**: amber;
  - each links to that fixture page.
- actions: **Rename · Replace key · Remove**.

While a badge shows, Replace key and Remove are disabled with "Stop Match {n} first": a tooltip on desktop, and text
inside the menu on phone. On phone the three actions sit in a 44 px ⋯ menu.

- **Rename** is inline, with Save and Cancel.
- **Replace key** is inline: a key field with the same shape warning, then Save.

**Empty state:** "No destinations yet. Add the stream key from YouTube or Twitch once, then pick it on any match."
with **+ Add destination**.

## 5. Server

### 5.1 Migration (next free number at merge; V427 on main today — re-check open branches before committing)

- `org_stream_targets.archived_at timestamptz NULL`.
- Recreate the `(org_id, dest_fingerprint)` unique index as partial `WHERE archived_at IS NULL`, keeping V421's
  existing predicate. Archived rows then never block a new or re-keyed destination.
- `fixture_stream_sessions.target_id` keeps NO ACTION. Archived rows are never deleted, so history and money rows
  keep their destination.

### 5.2 Use-cases and API

These live in `usecases/stream-targets.ts`, with every `rtmp_enc` read or write in `relay/secret-columns.ts`
(enc-boundary.test.ts).

**Create** (POST, existing route): the body becomes `{kind: "youtube"|"twitch", label, streamKey, watchUrl?}`, strict,
with no `rtmpUrl` (§5.4). The order is:

1. If an **active** row has the same fingerprint, return it (today's behaviour).
2. Otherwise, if an **archived** row has it, un-archive the most recent one, set its label and watch link to the
   submitted ones, and return it (D2).
3. Otherwise insert.

**Rename** (`PATCH /api/v1/orgs/{id}/stream-targets/{targetId}`, body `{label}`): allowed at any time, including while
the destination is in use.

**Replace key** (same PATCH, body `{streamKey}`):

- re-seal `rtmp_enc` and recompute the fingerprint;
- 409 `DESTINATION_DUPLICATE`, naming the other destination, if an **active** row already holds the new fingerprint;
- 409 `TARGET_IN_USE` with the holder if the destination is held.

**Remove** (`DELETE …/stream-targets/{targetId}`): sets `archived_at`. It returns 409 `TARGET_IN_USE` with the holder
while held. Removing an already-archived row is a 404.

**Held means** an active session (ACTIVE_STATES) references the target. Replace key, Remove and createSession all take
`SELECT … FOR UPDATE` on the target row in their transaction before checking, so Remove cannot interleave with Go
live. The existing `one_active_target` index stays the backstop.

**createSession** refuses an archived target (`targetBelongsToOrg` adds `archived_at IS NULL`). The error is the
existing not-found shape.

**Auth:** owner or admin write, as the existing routes. Both new methods go in `NEVER_KEY_ROUTES` (key-scopes.ts
:341). OpenAPI `ROUTES` (openapi.ts :223-224, plus the 409 extras). The `stream-contract.test.ts` pin of stream
operations is updated from five to seven.

### 5.3 List shape

`GET …/stream-targets` excludes archived rows and adds two fields to each `StreamTarget`:

- **`keyHint`:** the last 3 characters of the key, or `null` when the key is shorter than 12 characters, so a short
  key is never mostly exposed. It is read from the sealed column inside `relay/secret-columns.ts`; the full key never
  leaves it.
- **`inUse`:** `{sessionId, fixtureId, href, matchLabel, courtName, state: "live"|"waiting"} | null`.
  - `href` is the organiser fixture page.
  - `matchLabel` is "Match {n}".
  - `waiting` covers requested, provisioning and warming. `live` covers live and ending.

The Directory tab reads the same use-case server-side, as `VenuesTab` does.

### 5.4 YouTube and Twitch only (D6)

- The `kind` enum accepted by **create** narrows to `youtube | twitch` (schemas.ts :1306).
- The server fills `url` from the per-platform preset in `lib/stream-destinations.ts`. For YouTube, the value proven
  on staging 2026-09-30 is `rtmp://a.rtmp.youtube.com/live2`; the implementer verifies the preset before trusting it.
- `checkDestination` still runs as a guard.
- Rows of other kinds already stored (staging only; prod has not launched streaming) keep listing and streaming until
  removed. There is no data migration, and the DB `kind` CHECK is untouched.

### 5.5 "In use" names the match

- `targetHolderFor` (stream-sessions.ts :838-855) also returns `s.state`, the holder fixture's number, and the path
  parts for its organiser page.
- `targetInUse()` (:973-982) sends `holder: {fixtureId, href, matchLabel, courtName, label, state}`.
- The index-race `holder: null` path keeps the generic copy.
- Client copy is set in §3.3.

### 5.6 Destination output state reaches the screen (D3)

- `outputState()` (ingest-cf.ts :269-288) distinguishes `connecting` from `unknown`. It already reads the output's
  `status.current.state`.
- The current-session projection (schemas.ts :1323-1326) gains
  `output: {state: "ok"|"connecting"|"rejected"|"unknown", since: string} | null` for passthrough sessions. `since` is
  when the current non-ok state began, taken from the output-state change events the poll already records (:1250-1290).
- The client shows the D3 warning when `state === "live" && output.state !== "ok" && now - since ≥ 30 s`. The 30 s is
  one exported constant.
- `rejected` still fails the session with `target_rejected`, unchanged.

### 5.7 Provider-call rows carry the session

`removeOutput`, `addOutput`, `inputStatus` and `outputState` take an optional `meta: {sessionId}`:

- in the port (ports.ts :73), in `ingest-cf.ts` and in the fake driver;
- every call site in `stream-sessions.ts` passes it, including `releaseOutput` :480.

This closes the NULL `session_id` seen on staging for `removeOutput`.

## 6. Copy and i18n

- Every new or changed string goes in all 4 locale dictionaries (en, es, fr, nl), followed by the `gen-keys` regen.
- D4:
  - `score.handOverDevice` becomes "Remote scoring" (es "Puntuación remota", fr "Score à distance", nl "Scoren op
    afstand").
  - `dlink.title` "Hand this device over" becomes the same string.
  - `fixture-console-authority-band.test.tsx` :257-263 asserts the English text and is updated to the new text.
    Its title stays honest.
- New key families (names indicative): `stream.chain.*` (node names and state words), `stream.output.warning`,
  `stream.dest.*` (picker, manage link, empty state, load error, retry), `stream.inUse.*`, `directory.tab.streaming`,
  `streamDest.*` (the Directory tab: form, shape warnings, row sublines, badges, actions, confirm, empty state).
- The dropped platforms' labels become unused. Remove them if nothing else reads them.

## 7. QR with the Seazn logo (D7)

- One shared helper renders a QR at error-correction **H** with `public/logo-square.png` centred, for example
  `renderSeaznQr(text, {size})` returning a data URL. It is the same geometry as `scorer-sheet-pdf.ts` (:109-121,
  :344).
- **This branch** uses it for the stream capture QR (fixture-stream-panel.tsx :720, today M), the Remote scoring QR
  (device-link-panel.tsx :95) and the check-in QR (checkin-qr.tsx :27).
- The stream QR goes from v16/81 modules at M to **v22/105 modules at H** (measured: 435-byte payload). It renders at
  ≥320 px on desktop and full width on a phone.
- **A real-phone scan before shipping is a gate.** If that QR scans poorly, it alone stays logo-less, recorded as an
  exception in the helper's comment.
- **A follow-up PR** moves the remaining six call sites: `(public)/r/[ref]/page.tsx`, `ticket.png`, the poster page
  and its PDF, `doc-theme.ts`, and `copy-link.tsx`.

## 8. Out of scope

- capture-qr v2, the phone session descriptor, heartbeat ingest and filling §3.4's slot. That is its own branch
  (D9); the capture repo's S1 spec is the source of the shapes.
- YouTube OAuth ("Connect YouTube"), which is ruled as a direction and not scheduled
  (`2026-09-05-stream-overlay-prompts/_OAUTH-youtube-connect.md`). §4's rows take their actions from how the
  destination connects, so a "connected account" row type adds without a redesign.
- Per-court destination defaults.
- The six non-fixture-page QRs (§7 follow-up).
- The recorded follow-ups that stay open:
  - "Now playing" 56 px clip at 320;
  - the `modal.tsx` Close aria-label;
  - the swallowed monthly-grant error;
  - the placeholder/chevron at 320.

## 9. Testing (TEST-STRATEGY.md binds; all four types)

### 9.1 Unit and use-case

Each guard gets a named test, and each guard is mutated once to prove its test catches it:

- the create order: active duplicate, then archived un-archive, then insert;
- Remove and Replace key refused while held, both `live` and each `waiting` state;
- the row lock (a concurrent Remove against Go live);
- Replace key's duplicate refusal;
- the archived target refused at createSession;
- the `keyHint` length floor;
- the create allowlist (Facebook and Kick refused, stored legacy kinds still listed);
- the key-shape functions (YouTube and Twitch, both positive and negative);
- the 30 s threshold (at 29 s and at 30 s);
- `output.since` derivation;
- the `holder` fields;
- provider-call `session_id` on all four operations;
- `openPanel` exclusivity.

**Sequences:**

- remove, then re-add the same key (restores the row);
- replace a key, then go live;
- Remove while waiting (refused), then Stop, then Remove (allowed);
- the in-use message on a second fixture names the first;
- the run-sheet chip after Stop disappears.

**Expected values come from the declarations** (ACTIVE_STATES, the presets, the exported constant), never from typed
tables.

### 9.2 E2E (the walkthrough leg)

- `e2e/walkthrough/stream-relay.spec.ts` and `stream-credits.spec.ts` move to the fixture page. The helpers
  `openFixturesTab`, `rowOf` and `openPhoneTab` become fixture-page helpers. Every case keeps its assertion strength.
- The checkout-return case lands on the fixture page at 320, 768 and 1280.
- `stream-overlay.spec.ts` (the OBS tab) moves with them.
- **New Directory cases:**
  - add with the shape warning;
  - rename;
  - replace key;
  - remove;
  - in-use refusal while waiting and while live;
  - re-add restores;
  - the empty state;
  - the phone ⋯ menu;
  - the "Manage destinations" link from the panel.
- The D3 warning is driven through the fake driver's output state.
- **The whole spec file runs, never a `-g` slice** (AGENTS.md #21).

### 9.3 Controls, phone composition and visuals

- `mobile.spec.ts` control-set checks (:101-117, :215-217) gain the stream twin in both directions.
- These specs are re-run: `scorepad-v3-r7-console-chrome.spec.ts`, `scorer-sheets-handover-panel.spec.ts` and
  `scorer-sheets-print-scan.spec.ts`, which touch device-handover.
- A control-set diff from the live DOM, at 320 against 1280 (AGENTS.md phone composition).
- Screenshots of the fixture page (every panel state) and the Directory tab at 1280, 768 and 320, with no horizontal
  page scroll, compared against the mockups. Screenshots get per-screen verdicts before the PR.

### 9.4 Smoke and regression

- The CI smoke stream-overlay suite is updated for the new placement.
- **Regression cases:**
  - the staging round-1 shape (output stuck `connecting` while the input is live must show the D3 warning);
  - the #904 D2 checkout return, now to the fixture page.
- **The real-phone scan of the H-level logo stream QR** is an owner-visible gate, recorded with the device and the
  result.

### 9.5 Scope rule

Locally, only the specs and tests covering the changed files run (owner, 2026-09-28): scoped vitest paths, the moved
walkthrough files, `mobile.spec.ts` and the directory spec. CI owns the rest, including the OpenAPI drift check.

## 10. Risks

- **The biggest file.** `fixture-stream-panel.tsx` (2007 lines) is restyled while it moves. The plan should split its
  extraction (a move with no behaviour change, walkthroughs green) from the redesign, so a red walkthrough points at
  one of the two.
- **Migration number collision** with in-flight branches (format-matrix W1c). Re-check at merge.
- **Stream QR scannability at H.** Gated in §7.
- **The walkthrough budget:** the fixture page loads more than a run-sheet row. Re-cost `test.setTimeout` from the
  constants (AGENTS.md #20).
