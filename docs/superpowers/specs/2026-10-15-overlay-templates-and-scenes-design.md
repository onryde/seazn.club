# Overlay templates and compositor scenes: design

**Status:** owner-approved 2026-10-15, with two additions requested at approval: templates must be extendable and updatable (§4.7), and on-air events such as a six, a goal or game point must be covered (§4.8).
**Programme:** Relay Release 2 (compositor). Plan:
`seazn.club.compositor/docs/plans/2026-10-14-r2-compositor-plan.md`.
**Source design:** `Live-Sports-Compositor-Design-Spec-complete.pdf` §4, "Overlay graphics: the HTML
ticker" (decision of 5 Oct 2026).
**Builds on:** `2026-09-05-stream-overlay-design.md` (themes A bar / B bug, approved 2026-09-05),
`2026-09-12-overlay-match-card-layer-design.md` (card layer; it lists the "signal-lost slate" as still
owed), and `2026-09-05-stream-overlay-prompts/_THEMES.md`.

## 1. Goal

Everything the cloud compositor puts on screen is HTML: the score templates **and** the scenes that
viewers see when there is no camera picture. One page serves OBS and the compositor, so a design is
built once and looks the same in both. Organisers pick a template per fixture and see what YouTube will
show before they go live.

## 2. Owner decisions (2026-10-15, verbatim choices)

| # | Question | Decision |
|---|---|---|
| D1 | Same overlay concept, or rebuild graphics natively in Rust for speed? | **Same concept: one HTML page for OBS and the compositor (CEF).** C00 measured CEF at 0.10–0.50 cores, and the full 720p chain at 0.83 of 4 cores. No native graphics. |
| D2 | Scope of "HTML templates" | **B:** slates become HTML scenes in the same page, **plus** the PDF's template system (gallery and picker). |
| D3 | Who makes templates | **A now:** a fixed Seazn library, versioned with the page; organisers pick and never edit. **Next:** per-organisation branding (logo, colours). Custom HTML templates: not planned. |
| D4 | Which scenes | **B:** Starting soon, Reconnecting, and a Final card held ~10 s at the end. |
| D5 | Where the template is chosen | **A:** per fixture, on the stream panel; the default is the sport's default. |
| D6 | Template gallery audience | **C:** a staff gallery (`/admin`, desktop only) **and** organiser picker previews, both from one render function. |
| D7 | Picker on phones | **Yes.** The picker meets the full mobile + desktop bar (320 / 768 / 1280). |
| D8 | Reconnecting look | **A:** a branded night backdrop plus the existing match-card style. |
| D9 | Phone readability | **B:** a readable text floor, and the bar lifted above YouTube's controls, for **both** hosts. |
| D10 | How the page learns the compositor's state | **A:** a loopback endpoint inside the Machine, with **B** (via web) as the fallback. |
| D12 | Templates extendable and updatable | **Yes** (owner, at spec approval). A template is a registry entry behind a fixed contract; adding, changing and retiring one each have a defined path (§4.7). |
| D13 | Events (six, goal, game point…) | **Covered** (owner, at spec approval). The existing moment slabs work in every template and in the compositor (§4.8). |
| D14 | Moments during Starting soon (2026-10-16) | **Fire**, only Final drops them (§4.8). |
| D15 | Stop grace vs the Final hold (2026-10-16) | **`RUNNER_STOP_GRACE_SECONDS` = 20**, so the 10 s hold plus the ~7 s drain fit before the platform's forced kill. |
| D11 | Mockups | Mockups decide layout and behaviour only. **The build uses the house theme** (overlay tokens, `--sport-led`, sport palettes, the stadium-night plate, bundled fonts). |

## 3. What already exists (re-pinned 2026-10-15)

- `/overlay/fixtures/[fixtureId]` takes `?style=bar|bug`, `?lang=` and `?delay=`, resolved server-side
  (`page.tsx:54-72`).
- `theme-registry.ts`: `ThemeId = "bar" | "bug"`, and `defaultThemeFor(sport)` returns cricket → bar,
  everything else → bug.
- `overlay-slate.tsx` is a **card layer**, not a theme. `slateStateOf(model)` returns `warming`
  (Upcoming card), `ended` (Result card) or `live` (no card). The scorebug stays visible underneath.
  It's localised under `overlay.slate.*`.
- The card is **derived** from `data.status` on every render (`overlay-model.ts:~610`), not latched.
  An owner-reported bug (the end card stays after an undo) is being fixed separately and is out of
  this spec.
- R2005 (planned) adds `host=compositor`, `sid`+`st` access, ready/stale signals **from** the page
  **to** the compositor, and the clamp.

## 4. Design

### 4.1 Layers in one page

```
z-order (top first)
  scene layer   host=compositor only: backdrop + scene card   (Starting soon / Reconnecting / Final)
  card layer    existing: warming Upcoming card / ended Result card (unchanged behaviour)
  template      the scorebug: bar | bug (+ future templates); always mounted, never covered by a scene card
  transparent   (OBS) / camera or frozen frame underneath (compositor)
```

- The **scene layer** only exists when `host=compositor`. OBS users never see it, because they have
  their own scenes in OBS.
- The **score bug stays visible over every scene** (spec §1: "slate with the score still on screen"),
  and the scene card is laid out so it never covers the bug.
- A scene card reuses the match-card component and styles. Reconnecting is a new card variant of the
  same component (it fills the 09-12 spec's "signal-lost slate").

### 4.2 Scenes

| Scene | When (compositor state) | Backdrop | Card |
|---|---|---|---|
| **Starting soon** | `programmePhase = waiting` (no first camera frame yet) | Opaque night backdrop (house theme) | The existing **Upcoming** card. If the match is already live or decided, the matching existing card, so the card layer's rules still apply. |
| **Reconnecting** | `programmePhase = reconnecting` (camera lost > 3 s, `SlateKind::Reconnecting`) | Opaque night backdrop | New **Reconnecting** card: entrant names, a "Camera reconnecting, back shortly" line and a pulsing status dot. Localised in 4 languages. |
| **Final** | The organiser ends the session; the compositor holds the programme for `FINAL_HOLD_MS` = **10 000 ms** before EOS | Opaque night backdrop | The existing **Result** card if the match is decided or void. Otherwise a **Stream ended** card variant with the current score. |
| (none) | `live` / `frozen` | none (camera or frozen frame) | Card layer as today |

- **Frozen** (camera lost ≤ 3 s) shows no scene, so a short glitch never flashes a card.
- **Fallback when the overlay renderer is dead** (`graphics: failed`): the compositor's native slate
  (C09) shows **no text**, only the house backdrop colour and the Seazn logo, so the fallback never
  shows untranslated English.

### 4.3 Channel: compositor → page (D10)

- **Primary (A):** the compositor serves `GET http://127.0.0.1:<RELAY_PHASE_PORT>/phase` on loopback
  inside the Machine. It returns `{ phase, seq }` and supports long-poll (`?after=<seq>`, held ≤ 10 s).
  The page uses it only when `host=compositor`.
  - The port is one constant, shared through the R2002 contract docs. It is never exposed outside the
    Machine and is not part of the outbound-only host contract (ADR 0007).
  - **Private Network Access:** the page is https and the endpoint is loopback, so the compositor
    answers the preflight with `Access-Control-Allow-Private-Network: true` and a CORS origin locked
    to the app origin. **CEF 139 behaviour must be verified as C11's first step.** If it's blocked,
    the fallback becomes primary.
- **Fallback (B):** the page reads `programmePhase` from the composed session's latest heartbeat
  through its existing data poll. This is 5–8 s late, so it's acceptable only as a fallback. The page
  switches to B after 3 failed loopback attempts, and logs which channel is active through the R2005
  signal channel, so the heartbeat records it.
- The page debounces nothing; the compositor already applies the thresholds (C03). The page renders
  the phase it is given.

### 4.4 Template system (D2, D3, D5, D6)

- **`?template=<id>`** replaces `?style=`, and **`?style=` stays as an alias forever**, because OBS
  scenes in the wild carry it. Unknown values fall through to the sport default and never 404 (today's
  `resolveTheme` stance).
- The registry becomes the **template registry**: id, label key, component, sports, and the scenes it
  supports. Today's `bar` and `bug` are the first two entries; new templates are new entries plus new
  components, shipped with the page.
- **Per-fixture choice (D5):** the organiser's pick is stored on the fixture's stream settings and
  used in:
  - the OBS URL the panel copies (`?template=`)
  - the composed `overlayUrl` web serves (R2004/R2005)

  An unset value means the sport default. This **amends** the 2026-09-05 ruling "style in URL, not DB":
  the composed path needs the choice server-side, because no human pastes the compositor's URL.
- **One render function**, template × sport × scene × snapshot → preview, feeds:
  - the **staff gallery** `/admin/overlay-gallery`, desktop 1280 only (house rule). It shows every
    template × every sport × every scene against **sample snapshots** (fixtures, no DB). It is the
    review surface and the e2e screenshot source.
  - the **organiser picker** on the fixture stream panel: one thumbnail per template, rendered from
    **that fixture's real data**, with a scene toggle (Live / Starting soon / Reconnecting / Final).
    It meets the **mobile bar**: 320 / 768 / 1280, no horizontal scroll, 44 px tap targets.

### 4.5 Phone readability (D9), both hosts

- **Text floor:** no overlay text below **30 px at 1920×1080**, which is ≈ 13 px at 844 px landscape.
  It applies to the bug's status and context lines, the bar's band, the cards and the scenes.
  Numerals keep their larger sizes.
- **Bar lift:** the bar's bottom edge moves from 54 px to **≥ 150 px**, clear of YouTube's controls
  zone (~14 % of the height).
- Enforced by a test over the computed styles of every template × scene in the gallery: the smallest
  rendered font-size is ≥ 30 px at 1080, and the bar's bottom is ≥ 150 px. Both are anti-vacuous: the
  test reports how many elements it checked, and 0 fails.
- Visual check in the gallery at **390 × 219** (portrait) and **844 × 475** (landscape) frames.

### 4.6 House theme (D11)

The mockups in `.superpowers/brainstorm/` are layout references only. Colours, type, borders,
radii and motion come from `overlay-tokens.ts`, `--sport-led`, `SPORT_PALETTES` and the existing card
styles. Visual sign-off compares the built screens against the house theme. Dispatches load the
frontend-design skill.

### 4.7 Extending and updating templates (D12)

**The template contract.** Every template is one registry entry, `OverlayTemplateDef`:

| Field | Meaning |
|---|---|
| `id` | Stable string, used in `?template=`, in stored choices and in OBS URLs. **It never changes once shipped.** |
| `labelKey` | Picker label (4 locales). |
| `sports` | `"all"` or a list; the picker only offers templates that suit the fixture's sport. |
| `component` | The scorebug component, taking today's `OverlayThemeProps`. |
| `slabPlacement` | Where the moment slab attaches (replaces `slabPlacementFor`). |
| `sceneCardSafeArea` | The box that scene and match cards must keep clear, so a card never covers the scorebug. |
| `retired?` | `{ replacedBy: id }`. |

- **Add a template:** one component file plus one registry entry plus 4-locale label keys. Nothing else changes, because the gallery, the picker, the readability sweep and the scene tests all **enumerate the registry**. So a new template is covered the day it lands, and the sweeps report their counts (0 = fail).
- **Update a template:** templates are versioned with the page, so a deploy updates every fixture using that id, on OBS and in the compositor alike. No per-fixture migration. Each change is reviewed in the staff gallery across every sport × scene; no screenshot baselines are committed (house rule), and structural assertions plus the sweeps carry the regression load.
- **Retire a template:** keep the entry with `retired: { replacedBy }`. Stored choices and OBS URLs resolve to the replacement; nothing 404s and nobody's stream breaks. The picker hides retired ids.
- **Not in this spec:** organisers editing templates (D3) and per-organisation branding (next).

### 4.8 Events on air: moments (D13)

**What exists today** (`lib/overlay-moments.ts`, `MOMENT_RULES`, stream overlay W2):

| Sport | Moments that raise a slab |
|---|---|
| Cricket | six, four, wicket (`cricket.ball`, super over too) |
| Football | goal, card |
| Hockey | goal, card (suspension class) |
| Ice hockey | goal, penalty |
| Tennis | ace, set won, break / set / match point |
| Badminton, table tennis, volleyball | game won, game / match point |
| Board games, carrom, generic | none |

Moments are **sport-owned and template-independent**. The rules decide WHICH events raise a slab; the template only decides WHERE and HOW the slab looks (`slabPlacement`). So every template gets every moment, and a new template cannot drop one.

**What this spec adds:**
- **Compositor parity:** moments render in the composed stream exactly as in OBS. They are timed by the same `delay`, so a six's slab appears with the six on the video, not 3 s before it.
  - Test: the slab's on-screen time is ≥ `delay` after the event, at `host=compositor`.
- **Moments during scenes:**
  - **Reconnecting:** moments **still fire**. With no picture, the slab is the only way a viewer learns a goal happened. The slab sits above the scene card.
  - **Starting soon:** moments **fire** (owner ruling 2026-10-16). A stream can start after the match has begun, and a goal scored before the first camera frame must still reach viewers, the same reasoning as Reconnecting.
  - **Final:** none fire; the deciding moment has already shown, and the Result card carries the outcome.
- **Readability:** slab text meets the §4.5 floor.
- **Gallery:** shows each template × each sport's moments (a sample event per rule, enumerated from `MOMENT_RULES`).
- **Adding a moment later** (e.g. chess check/mate, carrom, a "last over" alert) stays one rule plus 4-locale keys, guarded by the existing `MOMENT_KEYS` dictionary gate. New moment kinds are a product decision per sport, not part of this spec.

## 5. Testing (house rules)

- **Unit:** the template registry and alias resolution (`style`/`template`, unknown → default);
  scene selection from phase × match status; the text-floor and bar-lift sweeps (count > 0).
- **E2E:**
  - the overlay at `host=compositor`, driven through each phase via a fake loopback endpoint
    (Playwright route), with the scene card visible and the score bug visible
  - without `host=compositor`, no scene ever shows (OBS)
  - fallback B engages when loopback is unreachable
  - the picker at 320/768/1280
  - the gallery at 1280
- **Compatibility:** the page is tested in OBS's browser source and in the compositor's `cefsrc` every
  release (PDF §4). The C11/C12 image tests load a scene URL in CEF.
- **Sequence:**
  - live → frozen → reconnecting → live → ending → final hold → exit
  - a second camera loss
  - reconnecting while the match is decided (Result card + backdrop)
  - another sport (cricket bar, badminton bug)
- **Extensibility:** register a throwaway test-only template in the unit test, then assert it appears in the picker list, the gallery matrix and the readability sweep without any other edit. Retired-id resolution: stored choice → replacement; OBS URL → replacement.
- **Moments:** each `MOMENT_RULES` entry × each template renders a slab (enumerated, count > 0); a moment during Reconnecting shows; a moment during Starting soon shows (match already in play); a moment during Final is dropped; slab timing ≥ delay at `host=compositor`.
- **Mutants:**
  - the scene layer mounting without `host=compositor` → RED
  - the text floor drops to 29 px → RED
  - fallback never engages → RED
  - a template's `slabPlacement` ignored → RED
  - moments suppressed during Reconnecting → RED
  - moments suppressed during Starting soon → RED

## 6. Plan changes (R2)

| Task | Change |
|---|---|
| **New R2007**: template system, readability, gallery (web) | Template registry with the `?template=` + `?style=` alias; the text floor and bar lift; `/admin/overlay-gallery`; the shared render function. Depends on nothing in R2, so it can start now. It touches `components/overlay/**`, so it runs **after** the end-card-undo bug fix merges. |
| **R2005** (amend) | Adds the scene layer (§4.1–4.2), the Reconnecting and Stream-ended card variants (4 locales), the loopback client with fallback B (§4.3). Depends on R2007. |
| **R2006** (amend) | Adds the per-fixture template picker with live previews, on mobile and desktop, plus persisting the choice and using it in the OBS URL and the composed `overlayUrl`. |
| **R2004** (amend) | The composed `overlayUrl` carries `template=` from the fixture's stored choice. |
| **C06** (amend) | Adds the final-hold phase: on `Desired::Ending`, hold for `FINAL_HOLD_MS`, with `programmePhase = final`, then drain. Adds `ProgrammePhase::Final` to the merged C03 domain enum (`crates/domain/src/programme.rs:23`); `Final` is terminal and wins over every camera state. |
| **C08/C12** (amend) | Adds the loopback `/phase` endpoint (127.0.0.1 only; CORS + PNA headers; long-poll). |
| **C09** (amend) | The native slate becomes textless (house backdrop + logo); it is used only when graphics have failed. |
| **C11** (amend) | **Step 0:** verify a https page → `127.0.0.1` fetch in CEF 139 with the PNA preflight. Record the result in `_FINDINGS.md`; if it's blocked, R2005 flips to fallback B as primary. |
| **R2002 contract** | Adds `final` to the `programmePhase` enum (a schema addition, follow-up PR). |

## 7. Out of scope

- Per-organisation branding (D3 "next").
- A Break or interval scene (operator-triggered).
- Custom organisation templates.
- Sponsor slots.
- New moment kinds (a per-sport product decision; the path is defined in §4.8).
- The end-card-after-undo bug, which has its own fix in flight.
