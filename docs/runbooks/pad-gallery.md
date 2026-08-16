# Running the ScoringPad gallery capture harness

`apps/web/e2e/gallery.capture.ts` (v3/R1 Task 10) walks every sport's real
fixture console through five states — `01-pre`, `02-live`, `03-scored`,
`04-dock`, `05-devicelink` — at three widths (320 / 768 / 1280), and writes
one PNG per (sport, state, width) plus a local `index.html` and
`manifest.json` into `GALLERY_DIR`. It is the tool the wave sign-off gate
(`_RULES.md` §1 "VISUAL SIGN-OFF IS A MERGE GATE") runs on — every wave from
here on (R2 cricket, R3 football, … R8) reuses it unchanged, pointed at
whichever sports that wave converted.

It is guarded twice so it can never run by accident: the file is named
`.capture.ts`, not `.spec.ts`, so no other Playwright project's default
`testMatch` ever selects it, and its own `test.skip(!process.env.GALLERY_DIR)`
no-ops the dedicated `gallery` project (`playwright.config.ts`) whenever the
env var is unset.

---

## 1. Server and database bring-up

Same recipe as `docs/runbooks/e2e-local.md` and the `seazn-local-env` skill —
summarised here with nothing new, so a fresh session can run the gate from
this file alone.

```bash
# 1. A migrated, disposable Postgres (never the shared dev DB):
initdb -D <scratch>/pg -U postgres --no-locale -E UTF8
pg_ctl -D <scratch>/pg -l <scratch>/pg.log \
  -o "-p <port> -c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp/<short>-sock" start
createdb -h 127.0.0.1 -p <port> -U postgres <dbname>
DATABASE_URL="postgresql://postgres@127.0.0.1:<port>/<dbname>" DATABASE_SSL=disable npm run db:apply
DATABASE_URL="postgresql://postgres@127.0.0.1:<port>/<dbname>" DATABASE_SSL=disable npm run sync:sports
# Confirm it is yours before trusting the port:
psql -h 127.0.0.1 -p <port> -U postgres -Atc "show data_directory"   # must equal <scratch>/pg

# 2. Build, from the repo/worktree ROOT:
rm -rf apps/web/.next
npm run build

# 3. Stage the standalone tree (next.config sets output: standalone;
#    `next start` silently serves the WRONG tree — see e2e-local.md §4):
cd apps/web
rm -rf .next/standalone/apps/web/.next/static
cp -R .next/static .next/standalone/apps/web/.next/
cp -R public       .next/standalone/apps/web/
cd .next/standalone/apps/web

# 4. Start it DETACHED — a foreground/attached background shell command can
#    be reaped by an unrelated session hiccup mid-run, silently taking a
#    12-sport sweep down partway through (observed in this session: the
#    server died between two runs with no error surfaced until the next
#    request). nohup + disown survives that.
nohup env PORT=<port> HOSTNAME=127.0.0.1 \
  DATABASE_URL="postgresql://postgres@127.0.0.1:<port>/<dbname>" \
  DATABASE_SSL=disable \
  E2E_PROD_TARGET=1 \
  node --env-file=<worktree>/apps/web/.env.local server.js \
  > server.log 2>&1 < /dev/null &
disown
```

Verify before trusting the port — a squatted port answers 200 with someone
else's app, and a missing static copy still answers 200 for the HTML:

```bash
lsof -nP -iTCP:<port> -sTCP:LISTEN                 # must be YOUR pid
curl -s http://localhost:<port>/                    # HTTP 200
curl -s -o /dev/null -w "%{http_code}\n" \
  "http://localhost:<port>$(curl -s http://localhost:<port>/ | grep -oE '/_next/static/[^"]+\.js' | head -1)"   # 200
```

## 2. The command line

Run from `apps/web/`. `GALLERY_DIR` is the ONLY thing that arms the harness
— everything else is the standard local-e2e env plus the port above.

```bash
GALLERY_DIR=/absolute/path/to/output-dir \
PLAYWRIGHT_BASE=http://localhost:<port> \
E2E_PROD_TARGET=1 \
DATABASE_URL="postgresql://postgres@127.0.0.1:<port>/<dbname>" \
DATABASE_SSL=disable \
npx playwright test e2e/gallery.capture.ts --project=gallery \
  --reporter=json --output=test-results/gallery-run \
  > /tmp/gallery-run.json
```

Judge the result the same way as every other suite in this repo — never a
wrapper summary:

```bash
jq '{total:.stats.expected+.stats.unexpected, passed:.stats.expected, failed:.stats.unexpected}' /tmp/gallery-run.json
```

**`localhost`, never `127.0.0.1`** — the secure-cookie flag on the session
cookie 401s against the bare IP. A single sport (`-g "Cricket \(T20\)"`, the
test title minus special-regex characters) is the fast loop while iterating
on a new sport's recipe; drop `-g` for the full 12.

### What each test does

Per sport: `armCookieBypass` (an `addInitScript` localStorage flag — must run
before the FIRST navigation, unlike `auth.setup.ts`'s post-navigation
version, because this harness screenshots that very first load) → `loginUi`
(mints a DB login row directly under `E2E_PROD_TARGET=1`, never the
rate-limited `/api/auth/magic-link` route — safe to call once per sport,
twelve times in one run) → `setOrgPlanBySql(..., "pro")` (device links are
Pro-only) → `seedRosteredFixture` via `page.request` (the standalone
`request` fixture has its own cookie jar and 401s) → capture `01-pre` →
"Start match" → capture `02-live` → one real UI tap sequence (`scoreOne`) →
capture `03-scored` → open a multi-field panel without confirming it
(`openDock`) → capture `04-dock` → mint a device link, open it in a **fresh,
unauthenticated browser context** → capture `05-devicelink`.

At 320px only, every capture also reads `document.documentElement.scrollWidth`
vs `clientWidth` (with the SAME clip-lift `expectNoHorizontalScroll` in
`helpers.ts` uses — `globals.css`'s `overflow-x: clip` on `html, body` pins a
naive `scrollWidth` read to the viewport regardless of real overflow, the
repo's own documented #325 false-green) and asserts no horizontal page
overflow. This is the measurement Tasks 6 and 8 deferred here as debt; the
numbers land in `console.log` output and in `GALLERY_DIR/manifest.json`
(`measurements320` per sport).

## 3. Output

```
GALLERY_DIR/
  index.html            # local browsing manifest — grouped by sport/state/width
  manifest.json          # per sport: dockPanelOpened + measurements320
  cricket/
    01-pre-320.png  01-pre-768.png  01-pre-1280.png
    02-live-320.png … 03-scored-… 04-dock-… 05-devicelink-…
  football/
    …
  … one directory per sport (12 total: the 11 engine sports + tennis-doubles)
```

`04-dock` reuses the `03-scored` image, unchanged, for any sport whose
legacy pad has no separate multi-field entry surface today (cricket, tennis,
tennis-doubles, at last count — `index.html` marks each such state
explicitly; `manifest.json`'s `dockPanelOpened: false` is the machine-
readable form). That is an honest capture of today's UI, not a harness gap.

## 4. The sign-off gate (`_RULES.md` §1, merge-blocking)

1. **Run the harness** for the wave's sports (§2 above). Confirm the pass
   count and `GALLERY_DIR` file count before moving on — a partial run still
   writes `index.html`/`manifest.json` for whatever finished, so check the
   JSON reporter's counts, not just that files exist.
2. **Publish the gallery.** The harness cannot do this step itself — it has
   no access to the Artifact tool, and 12 sports × 5 states × 3 widths of
   full-resolution PNGs (well past the 16MB single-artifact budget once
   base64-inlined) cannot go into one page unmodified. The agent running the
   gate curates: typically one Artifact per wave showing the CHANGED
   sport(s) at all three widths across all five states (the unconverted
   sports are evidence-by-omission — "everything else is untouched," provable
   by diffing this run's screenshots against the previous wave's), with a
   link back to `GALLERY_DIR`'s own `index.html` for the full set if the
   owner wants to browse everything locally.
3. **Collect the owner's per-screen verdicts.** Record them in
   `docs/superpowers/specs/2026-08-15-scoringpad-v3-prompts/_INDEX.md`'s
   decision log, one line per wave, same as every other ruling in that file.
4. **Offer the live walkthrough**: server up (§1), a login link minted
   (`loginUi`/`mintLoginPathBySql` pattern, or a real magic-link email if the
   server is not `E2E_PROD_TARGET`), the owner drives the actual pad.
5. A wave whose PR merges without recorded verdicts is a broken gate, the
   same severity as red tests (`_RULES.md` §1).

## 5. Known capture caveats — read before filing any of these as defects

- **A full-page screenshot paints the sticky nav a second time, mid-image.**
  Chromium's `fullPage: true` capture scrolls and stitches a page taller
  than the viewport; a `position: sticky` header gets drawn again at its
  sticky offset partway down the stitched image. Cosmetic to the capture
  only — not present in a real, single-viewport view of the page.
- **R1's gallery is all legacy pad, on purpose.** R1 converts no sport
  (`v3/registry.ts`: `V3_SKINS = {}`) — every screen captured against the R1
  build should look identical to whatever the previous wave captured. That
  sameness IS the evidence for R1's sign-off, not a bug in the harness.
- **`04-dock` has no real content for cricket, tennis and tennis-doubles.**
  No multi-field entry panel exists in today's pad for these three (cricket's
  "This over" pickers are a persistent row, not a tap-to-open panel; tennis's
  scoring is a single tap). The harness does not invent one — it reuses the
  `03-scored` capture and marks the state accordingly. A future wave that
  ships one of these sports' v3 dock replaces this fallback with a real
  capture, which is the intended before/after comparison.
- **Cricket never drives a wicket dismissal.** That flow wedged the page
  during the session that produced this programme's baseline gallery
  (recorded in `_RULES.md` §2's capture traps). The harness stays on plain
  run-scoring taps for cricket for exactly that reason — this is deliberate
  scope, not missing coverage.
- **Boardgame had no e2e precedent anywhere in this repo** (confirmed by
  search) when this harness was first written, and its recipe went through
  three live iterations before it worked: a generic DOM prober clicked
  "Result" without confirming it (no ledger growth); a hand-written "Draw /
  no result" recipe filled "Moves" as a text string when the field is
  `type="number"`; the working version selects "Method" (`index: 1`), fills
  "Moves" with `"40"`, then confirms. This paragraph previously claimed
  boardgame was "now live-verified" with a quoted `{"total":12,
  "expected":12,"unexpected":0}` result — that quote was NOT backed by any
  inspectable run: the session that wrote it recorded its own gallery output
  in a session-scratchpad path that no longer exists, and Task 10's own
  progress ledger for this wave says plainly that boardgame's third recipe
  fix landed UNVERIFIED, with only `01-pre`/`02-live` actually captured at
  the time. Task 11 (2026-08-16) re-ran the full harness into a stable,
  non-scratchpad `GALLERY_DIR` specifically to settle this: **boardgame now
  genuinely passes 5/5 states in a clean, full 12-sport run**
  (`{"expected":12,"unexpected":0,"flaky":0,"skipped":0}`), including its own
  320px measurements (`scrollWidth=320 clientWidth=320 overflowPx=0` on all
  five states — `manifest.json`'s boardgame entry). If a future edit touches
  boardgame's pad UI, re-verify this recipe the same way: read the actual
  failure screenshot, don't guess a second time, and don't accept a
  "live-verified" claim in this file without a run whose output directory
  still exists.
- **Badminton and table tennis reuse volleyball's "Set score" panel by
  construction** — all three share `racquet-skin.tsx`. Same caveat as
  boardgame's applies to the "also now live-verified" claim this paragraph
  used to make here: Task 11's 2026-08-16 re-run is the first inspectable
  confirmation of it (all three pass 5/5 states in the clean run cited
  above), not merely verified-by-analogy. If a future skin split (R5)
  changes that component per-sport, re-verify these two specifically.

## 6. Failure modes worth knowing

| Symptom | Cause |
| --- | --- |
| `net::ERR_CONNECTION_REFUSED` on a `/magic-link?token=…` goto | The server died between runs — a plain background shell command tied to this session can be reaped by an unrelated interruption. Restart it with `nohup … & disown` (§1 step 4), not a bare `&`. |
| `expect(locator).toBeVisible()` failed on `[data-testid="score-pad"]` for `05-devicelink` only | That testid is minted ONLY by `fixture-console.tsx` (the console route). The device-link route (`app/score/[token]/page.tsx` → `DeviceScorePad`) carries no such testid — the harness instead waits for the constant tail of the `device.courtsideFooter` dictionary string ("… link active today only"), which is sport-agnostic; do not reintroduce a `score-pad` wait on that page. |
| A sport's `scoreOne`/`openDock` times out on a button name | Every sport's recipe in `gallery.capture.ts` passed cleanly as of Task 11's 2026-08-16 run (§5), so a fresh timeout means something in the pad's copy or flow changed since — open the pad for that sport by hand (`loginUi` + `seedRosteredFixture` + navigate) and read the real button/label text before changing the recipe. Boardgame and the badminton/tabletennis pair (§5) are worth checking first; they took the most iterations to get right. |
| `GALLERY_DIR` party-empty after a red run | Expected — each sport writes its own files as it completes; `index.html`/`manifest.json` are written once in `test.afterAll`, covering whichever sports finished. Read the JSON reporter for the real pass/fail split before treating a short file list as the harness's fault. |
| Two Playwright workers both writing `manifest.json` | Should not happen — the `gallery` project sets `fullyParallel: false` specifically so this one file's 12 tests never split across workers. If you see it, something changed that setting; put it back. |

## 7. Config note

`playwright.config.ts` carries one dedicated project for this file:

```ts
{
  name: "gallery",
  testMatch: /gallery\.capture\.ts/,
  fullyParallel: false,
  use: { ...devices["Desktop Chrome"] },
},
```

Additive only — it does not change `testMatch`/`testIgnore` for any other
project, and every other project already ignores this file by construction
(default `testMatch` requires `test`/`spec` in the filename, which
`gallery.capture.ts` deliberately does not have). Without this project the
harness cannot be invoked via `npx playwright test` at all — confirmed via
`--list` before adding it (zero tests found in any project).
