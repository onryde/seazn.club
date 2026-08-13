import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { apiJson, addEntrantsViaApi, createStageAndGenerate, expectNoHorizontalScroll, TAG } from "./helpers";

// S11/#420 W9 — one real-browser headline flow per shipped skin (cricket,
// racquet, tennis, football, period), all at 375px. Drives the same dev-only
// harness route S10 built (`/score/harness`, gated on SCOREPAD_V2_HARNESS=1;
// see scorepad-offline.spec.ts for the established patterns this file
// follows).
//
// WHY `?fixture=` MODE, NOT THE NO-FIXTURE IN-PAGE LEDGER THE W9 BRIEF NAMED
// AS PREFERRED: verified by direct reproduction in a real browser before
// writing a line of this file. Every shipped sport module except `generic`
// gates its scoring action(s) on `state.phase === "live"`, which only a
// `core.start` event can produce (cricket.ts/nested/setbased/period kernel.ts,
// each: `if (state.phase !== "pre") wrongPhase(...)` on `core.start`, and the
// scoring actions themselves `wrongPhase` on anything but "live"). No PadSpec,
// for any of the eleven sports, ever declares a `core.start` PadAction —
// core.* lifecycle events are a fixture-lifecycle concern, and the no-fixture
// harness (harness-client.tsx's `localTransport()`) never seeds one either
// (no `initialEvents`, no URL param for it). Concretely: a bare run-tap on a
// fresh `?sport=cricket` (or tennis/volleyball/football/icehockey) harness
// page throws `EngineError: … not allowed in phase "pre"` INSIDE
// `foldClient`'s render-phase useMemo, caught by the nearest error boundary
// ("Something went wrong") — and because the bad event is by then
// permanently in `usePadPipeline`'s `ledgerEvents`, every re-render replays
// and re-throws it: the page is bricked for the rest of that mount. `generic`
// alone tolerates `state.phase === "pre"` for its own `.score` action, which
// is why S10's offline spec could use no-fixture mode — it never had to
// clear this gate.
//
// GETTING A `?fixture=` FIXTURE TO "live" NEEDS AN EXPLICIT `core.start`
// EVENT, NOT JUST DIVISION START: `POST /api/v1/divisions/{id}/start` does
// NOT itself append `core.start` to a fixture's ledger — a premise this file
// briefly got wrong, because scorepad-offline.spec.ts's own success after
// calling only division/start proves nothing (generic.score tolerates BOTH
// "pre" and "live", so it never needed the transition at all). Confirmed
// directly: a tennis fixture set up with division/start alone still 422s
// "point not allowed in phase \"pre\"" on the first submit. Every OTHER e2e
// that needs a live fixture posts `core.start` to the fixture's own ledger
// separately (v6-sports.spec.ts: `sendEvent(request, fixtureId,
// "core.start", {})`; same in scoring.spec.ts/stats.spec.ts/
// me-career.spec.ts) — `setupFixture` below does the same.
//
// THE SECOND, DEEPER HARNESS GAP THIS FILE WORKS AROUND: even with
// `core.start` genuinely on the server's ledger, `harness-client.tsx` never
// fetches it before mounting (`initialEvents` is never passed to
// `PadRenderer`, in EITHER harness mode) — so the CLIENT's own optimistic
// fold still starts from a bare `init()` ("pre" phase) regardless of what
// `?fixture=` points at. A same-tick tap against that stale fold throws in
// the render path exactly as in no-fixture mode. `usePadPipeline`'s own
// realtime subscription (use-fixture-stream.ts) eventually reconciles
// against the server and adopts its real state via `serverOverride` — but
// only once the realtime channel finishes its handshake and its first fetch
// lands, empirically ~15-20s on this dev server (confirmed by instrumenting
// the page's own console/network events during this session — waiting under
// that reproduces the crash every time; waiting 20s does not). Every test
// below waits this out once after the first navigation, before its first
// tap.
//
// A THIRD consequence, also confirmed by instrumentation, not assumed: once
// `serverOverride` is set, `usePadPipeline`'s `foldedState` returns it
// VERBATIM and ignores every later local submit/ack — a scope boundary that
// file's own header documents ("long-run incremental consistency after a
// real concurrent write is not [covered]"), which this harness's missing
// `initialEvents` turns into "true of every submit after the first
// reconcile", not just a rare concurrent-write edge case. The events
// themselves still reach the server correctly — the queue's own 409-retry
// protocol lands them (proven below by reading the REAL ledger, and by the
// SEQ_CONFLICT `current_seq` advancing on every retry when this was
// diagnosed) — but the ON-SCREEN state does not visibly update to show them.
// So every test below performs its FULL action sequence first, waits for
// the queue to drain (proof of delivery), then does ONE full page reload —
// a fresh mount re-runs the same bootstrap, this time against the server's
// now-current state — before asserting on the header. This is the most
// reliable way available through this harness to observe a flow's settled
// result; it is still real, exact-value, server-verified evidence, just
// checked after a refresh rather than instantaneously.
//
// WHY CRICKET HAS NO TEST HERE AT ALL, rather than a weakened one: verified
// the same way, not assumed. EVERY `cricket.ball` event — not only the
// fielder-credited dismissal criterion 1 asks for — requires `striker`,
// `nonStriker` and `bowler` to be real members of the fixture's real batting/
// bowling order (cricket.ts: `invalid(\`batter "${person}" is not in the
// lineup\`)`, `invalid(\`bowler "${payload.bowler}" is not in the fielding
// lineup\`)`). The harness's own client-side lineups
// (harness-client.tsx's `harnessLineups()`, a file this session does not
// own) are HARDCODED synthetic ids ("h-1"/"h-2"/"h-3"/"a-1"/"a-2"/"a-3") —
// the only ids the rendered striker/non-striker/bowler pickers ever offer,
// in EITHER harness mode, because `page.tsx`'s `SearchParams` has a `home`/
// `away` override for the two ENTRANT ids and nothing at the person/squad
// level. A real API-backed fixture's real roster can never contain those
// literal strings (person ids are server-generated), so every single ball —
// not just the wicket — is rejected 422 the instant it reaches the server:
// there is no sequence of taps that scores so much as one run. Football's
// `scorer`/`assist` are the SAME shape of gap (see the football test below)
// but strictly narrower — football's own `by` (a SIDE, not a person) is
// sufficient to record a goal at all, so that flow still delivers a real,
// exact-value assertion; cricket's `striker`/`bowler` are person-level AND
// unconditionally required on every ball, so nothing survives to assert on.
//
// HEADER ASSERTIONS ARE SCOPED, NEVER A BARE PAGE-WIDE `getByText`: every
// skin draws its OWN header BELOW the chassis's own score-headline strip
// (pad-renderer.tsx's `data-role="score-headline"`, a SIBLING of the skin,
// never an ancestor) — and for tennis specifically that chassis headline
// renders the SAME `gameScoreLine`-style vocabulary the skin's own "Points"
// field does (tennis-skin.tsx's own header: "'Ad' is rendered verbatim by
// pad-renderer.tsx's own score headline"), so a bare exact-text match risks
// matching BOTH and failing on Playwright's own strict-mode ambiguity. Each
// test below scopes to the skin's own container (`data-role="football-skin"`
// / `data-role="racquet-header"` / period's own per-field
// `data-role="header-*"`) or, for tennis (which has no such container), to
// the specific field's CAPTION — "Points" never appears as the chassis
// headline's own caption (that one is hardcoded "Score", pad-renderer.tsx's
// own `msg("scorepad.header.score")`), so it is unambiguous even page-wide.
test.use({ viewport: { width: 375, height: 800 } });

interface SportFixture {
  fixtureId: string;
  home: string;
  away: string;
}

/** A fresh, undecided, 2-entrant, LIVE fixture for any sport/variant — the
 *  `?fixture=` precondition every test below needs. Mirrors
 *  scorepad-offline.spec.ts's own `setupGenericFixture` (competition →
 *  division → entrants → stage → generate → start → read home/away),
 *  generalised off the sport/variant rather than hardcoded to generic, plus
 *  the explicit `core.start` append every OTHER multi-sport e2e in this repo
 *  also does (see the file header). Stage kind matches v6-sports.spec.ts's
 *  own precedent for these exact sports (knockout — proven against
 *  tennis/icehockey there).
 *  `entrantKind` defaults to "individual" (tennis, an individual sport); the
 *  team sports (football/volleyball/icehockey) 422 on that ("add entrants"
 *  fails) and need "team" explicitly — confirmed both by a real run against
 *  this file and by v6-sports.spec.ts's own `makeDivision`, which passes
 *  `kind: "team"` for every icehockey call it makes and never overrides it
 *  for tennis. */
async function setupFixture(
  request: APIRequestContext,
  label: string,
  sportKey: string,
  variantKey: string,
  entrantKind: "individual" | "team" = "individual",
): Promise<SportFixture> {
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    name: `Scorepad skins e2e ${label} ${TAG}`,
    ends_on: "2030-12-31",
    visibility: "public",
  });
  expect(comp.status, `create competition: ${comp.error?.message ?? ""}`).toBe(201);
  const competitionId = comp.data!.id;

  const div = await apiJson<{ id: string }>(
    request,
    `/api/v1/competitions/${competitionId}/divisions`,
    "POST",
    { name: sportKey, sport_key: sportKey, variant_key: variantKey, config: {} },
  );
  expect(div.status, `create division: ${div.error?.message ?? ""}`).toBe(201);
  const divisionId = div.data!.id;

  const entrants = await addEntrantsViaApi(request, divisionId, ["Alpha", "Bravo"], entrantKind);
  expect(entrants.status, `add entrants: ${entrants.status}`).toBe(201);

  const { fixtureIds } = await createStageAndGenerate(request, divisionId, { kind: "knockout", name: "Final" });
  expect(fixtureIds.length, "a 2-entrant knockout generates exactly one fixture").toBe(1);
  const fixtureId = fixtureIds[0]!;

  const started = await apiJson(request, `/api/v1/divisions/${divisionId}/start`, "POST");
  expect(started.status, `start division: ${started.error?.message ?? ""}`).toBe(200);

  const coreStart = await apiJson(request, `/api/v1/fixtures/${fixtureId}/events`, "POST", {
    expected_seq: 0,
    type: "core.start",
    payload: {},
  });
  expect(coreStart.status, `core.start: ${coreStart.error?.message ?? ""}`).toBe(201);

  const fx = await apiJson<{ home_entrant_id: string | null; away_entrant_id: string | null }>(
    request,
    `/api/v1/fixtures/${fixtureId}`,
  );
  expect(fx.status, "read fixture").toBe(200);
  const home = fx.data!.home_entrant_id;
  const away = fx.data!.away_entrant_id;
  if (!home || !away) throw new Error(`fixture ${fixtureId} has no home/away entrant`);
  return { fixtureId, home, away };
}

function harnessUrl(fx: SportFixture, sport: string, variant: string): string {
  const p = new URLSearchParams({ fixture: fx.fixtureId, sport, variant, home: fx.home, away: fx.away });
  return `/score/harness?${p.toString()}`;
}

/** Waits out the realtime-reconcile bootstrap this harness needs before its
 *  first genuine tap — see the file header's "SECOND, DEEPER HARNESS GAP"
 *  section for what this is covering and why 20s, empirically, not a
 *  guess. */
async function bootstrapWait(page: Page): Promise<void> {
  await page.waitForTimeout(20_000);
}

/** The value sibling of a header field identified by its own (unambiguous)
 *  caption text — every skin's header renders caption and value as SIBLING
 *  elements under one field wrapper (order varies per skin; sibling-hood
 *  does not), so walking up from the caption to its parent and reading the
 *  parent's own text is robust to that without needing a per-skin selector.
 *  Only used for tennis, whose outer container carries no `data-role` to
 *  scope into directly — see the file header on why "Points" alone is
 *  still unambiguous page-wide. */
function headerField(page: Page, captionExact: string) {
  return page.getByText(captionExact, { exact: true }).locator("..");
}

/** Counts rows in the pad's own durable IndexedDB queue — same oracle
 *  scorepad-offline.spec.ts uses (see that file's header for why this beats
 *  reading the status pill for a NUMBER): a drain to 0 is the queue's own
 *  confirmation that appendEvent resolved "ok" (possibly after a 409
 *  renegotiation — see the file header), not merely that a click didn't
 *  throw. `dbName` matches harness-client.tsx's own
 *  `scorepad-harness-${sportKey}` — the raw `?sport=` value, per sport. */
async function queueRowCount(page: Page, dbName: string): Promise<number> {
  return page.evaluate(
    ({ name, store }) =>
      new Promise<number>((resolve, reject) => {
        const req = indexedDB.open(name, 1);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(store)) {
            db.close();
            resolve(0);
            return;
          }
          const tx = db.transaction(store, "readonly");
          const countReq = tx.objectStore(store).count();
          countReq.onsuccess = () => {
            resolve(countReq.result);
            db.close();
          };
          countReq.onerror = () => reject(countReq.error ?? new Error("count failed"));
        };
        req.onerror = () => reject(req.error ?? new Error("indexedDB.open failed"));
      }),
    { name: dbName, store: "pending-events" },
  );
}

/** The fixture's REAL, server-persisted ledger from seq 0 — since every test
 *  below drives `?fixture=` mode (real API, real session cookie), this is a
 *  strictly stronger "the event reached the ledger" oracle than the
 *  no-fixture harness's in-memory stand-in: a row here means the server's
 *  own zod schema AND every `invalid()`/`wrongPhase()` domain check in the
 *  engine's fold already accepted it, not merely that a local promise
 *  resolved. Seq 0 always includes `setupFixture`'s own `core.start` first —
 *  every ledger assertion below accounts for it. */
async function ledgerOf(
  request: APIRequestContext,
  fixtureId: string,
): Promise<{ seq: number; type: string; payload: unknown }[]> {
  const res = await apiJson<{ seq: number; type: string; payload: unknown }[]>(
    request,
    `/api/v1/fixtures/${fixtureId}/events?since_seq=0`,
  );
  expect(res.status, `GET events: ${res.error?.message ?? ""}`).toBe(200);
  return res.data!;
}

const CORE_START = { type: "core.start", payload: {} };

// Same loud-skip mechanism as scorepad-offline.spec.ts: proves the route is
// absent (a 404) rather than trusting a bare env-var read from this process,
// which says nothing about the server actually under test.
test.beforeAll(async ({ request, baseURL }) => {
  const res = await request.get(`${baseURL ?? ""}/score/harness?sport=generic`);
  if (res.status() === 404) {
    console.warn(
      "[scorepad-skins] SKIPPED: /score/harness returned 404 — this server was started without SCOREPAD_V2_HARNESS=1. None of the skin flows below are covered by this run.",
    );
  }
  test.skip(res.status() === 404, "harness route disabled on this target (SCOREPAD_V2_HARNESS unset)");
});

test("cricket: NOT COVERED — every cricket.ball event requires a real batting/bowling-order match the harness cannot produce", async () => {
  // See this file's header for the full evidence trail (reproduced in a real
  // browser, then confirmed against cricket.ts's own `invalid()` calls): the
  // harness's client-side lineups are permanently synthetic, the server's
  // are always real, and cricket validates striker/non-striker/bowler
  // membership on every single ball — so no run, extra or dismissal can ever
  // be recorded through this harness, in either mode. A weakened version of
  // this test (e.g. asserting the expected 422) would be answering a
  // different question than criterion 1 asks; skipping loudly is the honest
  // report the dispatch brief asks for instead.
  test.skip(
    true,
    'cricket.ball always requires striker/nonStriker/bowler to be real roster members; the harness\'s client lineups are hardcoded synthetic ids ("h-1" etc.) with no way to align them with a real fixture\'s real roster — every ball is rejected 422. No cricket flow is drivable through this harness.',
  );
});

test("tennis: play points to deuce", async ({ page, request }) => {
  test.setTimeout(120_000);
  const fx = await setupFixture(request, "tennis", "tennis", "tour");
  const url = harnessUrl(fx, "tennis", "tour");
  await page.goto(url);
  await bootstrapWait(page);

  // The plain `tennis.point` action is a one-tap Home/Away pair (no
  // expand/confirm step — tennis-skin.tsx's own `renderPrimaryAction`), so
  // reaching deuce is 6 taps: 3 each, alternating, never two of the same
  // side in a row (which would matter if the pipeline's own double-submit
  // guard could confuse it with a repeat — see use-pad-pipeline.ts's
  // DOUBLE_SUBMIT_WINDOW_MS; alternating payloads never collide with it).
  const homeBtn = page.getByRole("button", { name: "Home", exact: true });
  const awayBtn = page.getByRole("button", { name: "Away", exact: true });
  await expect(homeBtn).toBeVisible();
  for (let i = 0; i < 3; i++) {
    await homeBtn.click();
    await awayBtn.click();
  }
  await expect.poll(() => queueRowCount(page, "scorepad-harness-tennis")).toBe(0);

  // See the file header's "THIRD consequence" — a reload forces a fresh
  // bootstrap against the server's now-current state, the reliable way to
  // observe this harness's settled result.
  await page.goto(url);
  await bootstrapWait(page);

  // pointsValue() (tennis-skin.tsx) renders 3-3-no-advantage as this exact
  // en-dash pair — deuce, not a count of "something changed". Scoped to the
  // "Points" field itself (see file header) rather than a bare page-wide
  // match, since the chassis's own score headline can render tennis's same
  // point vocabulary.
  await expect(headerField(page, "Points")).toContainText("40–40");
  await expectNoHorizontalScroll(page);

  const ledger = await ledgerOf(request, fx.fixtureId);
  expect(ledger.map((e) => ({ type: e.type, payload: e.payload }))).toEqual([
    CORE_START,
    { type: "tennis.point", payload: { by: fx.home } },
    { type: "tennis.point", payload: { by: fx.away } },
    { type: "tennis.point", payload: { by: fx.home } },
    { type: "tennis.point", payload: { by: fx.away } },
    { type: "tennis.point", payload: { by: fx.home } },
    { type: "tennis.point", payload: { by: fx.away } },
  ]);
});

// Racquet skin serves volleyball/badminton/tabletennis (racquet-skin.tsx,
// one skin, one action family off setbased/kernel.ts). Driven here as
// VOLLEYBALL — its "indoor" variant is the one already proven by an existing
// e2e (v6-sports.spec.ts) and needs no config beyond the module's own
// defaults.
test("racquet skin (volleyball): a rally and a set summary", async ({ page, request }) => {
  test.setTimeout(120_000);
  const fx = await setupFixture(request, "volleyball", "volleyball", "indoor", "team");
  const url = harnessUrl(fx, "volleyball", "indoor");
  await page.goto(url);
  await bootstrapWait(page);

  // ORDER IS LOAD-BEARING: set summary FIRST, rally SECOND — reversed from
  // this criterion's own wording, for a real domain rule confirmed directly
  // (setbased/kernel.ts's own fold, via the server's actual rejection):
  // "this set is being scored rally-by-rally — a set summary is not allowed
  // for it". A set is scored EITHER rally-by-rally OR by summary, never
  // both — so the only way to drive both actions for real is to close set 1
  // by summary FIRST (before any rally exists for it), then have the rally
  // open and score set 2. Both actions still land as real, distinct,
  // server-accepted events; only their order changed.
  //
  // Set summary — a manual, numbers-only entry (SetSummaryPositional:
  // {home, away, partial?}), no roster/person involved at all, so unlike
  // football/cricket this is fully reachable. 25-20 is a legal indoor-
  // volleyball set win for home, decisive (no `partial`).
  await page.getByRole("button", { name: "Set score", exact: true }).click();
  await page.getByLabel("Home", { exact: true }).fill("25");
  await page.getByLabel("Away", { exact: true }).fill("20");
  await page.locator('[data-role="confirm"]').click();

  // Rally: SideTapAction, one tap, no confirm step (racquet-skin.tsx's own
  // `isSideTapOnly` path) — `{wonBy: <home entrant id>}`. Set 1 is already
  // closed by the summary above, so this opens and scores set 2.
  const rallyHome = page.getByRole("button", { name: "Home", exact: true });
  await expect(rallyHome).toBeVisible();
  await rallyHome.click();
  await expect.poll(() => queueRowCount(page, "scorepad-harness-volleyball")).toBe(0);

  // See the file header's "THIRD consequence" — reload for the settled
  // result rather than trusting the (frozen, post-first-reconcile) live DOM.
  await page.goto(url);
  await bootstrapWait(page);

  // "sets" shows the match tally (1 set won by home, from the summary) and
  // "points" shows set 2's live score (1-0 to home, from the rally) —
  // asserting BOTH pins the exact resulting state of BOTH actions, not just
  // "a number changed somewhere". Scoped to the skin's own header
  // (`data-role="racquet-header"`, racquet-skin.tsx's own `ScoreHeader`)
  // rather than a bare page-wide match — see the file header on the
  // chassis-headline-collision risk.
  const racquetHeader = page.locator('[data-role="racquet-header"]');
  const setsField = racquetHeader.getByText("Sets", { exact: true }).locator("..");
  const pointsField = racquetHeader.getByText("Points", { exact: true }).locator("..");
  await expect(setsField).toContainText("1–0");
  await expect(pointsField).toContainText("1–0");
  await expectNoHorizontalScroll(page);

  const ledger = await ledgerOf(request, fx.fixtureId);
  expect(ledger.length, "core.start + set summary + rally, nothing else").toBe(3);
  expect(ledger[0]).toMatchObject(CORE_START);
  expect(ledger[1]).toMatchObject({ type: "volleyball.set.summary", payload: { home: 25, away: 20 } });
  expect(ledger[2]).toMatchObject({ type: "volleyball.rally", payload: { wonBy: fx.home } });
});

// Football keeps its own skin (football-skin.tsx) — the period pair's
// kernel has no `subs`/`penalties` panels and football has no `setPiece`/
// `shootout`. "11-a-side" is the variant every other football e2e in this
// repo already uses (discipline.spec.ts, stats.spec.ts, me-career.spec.ts).
test("football skin: a goal", async ({ page, request }) => {
  test.setTimeout(120_000);
  const fx = await setupFixture(request, "football", "football", "11-a-side", "team");
  const url = harnessUrl(fx, "football", "11-a-side");
  await page.goto(url);
  await bootstrapWait(page);

  // Scoped to the skin's own container (football-skin.tsx's own
  // `data-role="football-skin"`) rather than a bare page-wide match — see
  // the file header on why the chassis's own score headline is a sibling,
  // not this skin, and can carry similar-looking text.
  const footballSkin = page.locator('[data-role="football-skin"]');
  await expect(footballSkin.getByText("0 - 0", { exact: true })).toBeVisible();

  // QuickActionCard's own rule (football-skin.tsx): both `scorer` and
  // `assist` are OPTIONAL slots, so Confirm is enabled the instant the card
  // opens — tapping it immediately fires `{by: <home entrant id>}`.
  //
  // NOT driven here: assist attribution (criterion 4's "WITH assist
  // attribution"). `applyGoal` (football.ts) validates a supplied `scorer`
  // against `state.squads[by].onPitch` — the REAL fixture's real roster —
  // but the only scorer/assist chips this harness ever renders come from
  // `footballRoster(ctx.state, side)` reading the CLIENT's own optimistic
  // fold, which is seeded from harness-client.tsx's hardcoded synthetic
  // lineups ("h-1"/"h-2"/…), never the real one. Picking either synthetic
  // chip and confirming reproduces a 422 ("scorer \"h-1\" is not on the
  // pitch") every time — verified directly in a real browser before writing
  // this test. The goal itself (side-only) is still real, exact-value
  // evidence; the person-level credit is the one piece this harness cannot
  // produce for any real fixture, for the reason cricket's whole flow can't
  // either (see the file header).
  await page.getByRole("button", { name: "Home · Goal", exact: true }).click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect.poll(() => queueRowCount(page, "scorepad-harness-football")).toBe(0);

  // See the file header's "THIRD consequence".
  await page.goto(url);
  await bootstrapWait(page);

  await expect(footballSkin.getByText("1 - 0", { exact: true })).toBeVisible();
  await expectNoHorizontalScroll(page);

  const ledger = await ledgerOf(request, fx.fixtureId);
  expect(ledger.length, "core.start + one goal, nothing else").toBe(2);
  expect(ledger[0]).toMatchObject(CORE_START);
  expect(ledger[1]).toMatchObject({ type: "football.goal", payload: { by: fx.home } });
});

// Period skin serves hockey/icehockey — both generated by period/kernel.ts
// and byte-identical apart from the key prefix (registry.ts's own header).
// Driven here as ICEHOCKEY: "iihf" is the variant the existing v6-sports.ts
// e2e already exercises for goals, discipline and shoot-outs.
test("period skin (icehockey): a goal and a period advance", async ({ page, request }) => {
  test.setTimeout(120_000);
  const fx = await setupFixture(request, "icehockey", "icehockey", "iihf", "team");
  const url = harnessUrl(fx, "icehockey", "iihf");
  await page.goto(url);
  await bootstrapWait(page);

  // period-skin.tsx is the one skin that tags each header field with its
  // own `data-role="header-<id>"` (renderHeader's own chips/emphasis
  // rendering) — the most precise scope available, used here instead of
  // the football/racquet container-scope or tennis's caption-parent trick.
  const scoreField = page.locator('[data-role="header-score"]');
  const periodField = page.locator('[data-role="header-period"]');
  await expect(scoreField).toContainText("0 – 0"); // en dash — readScoreLine's own fallback format
  // `core.start` (period/kernel.ts) does not pass through a visible "pre"
  // state — its own handler is `pushPeriod(state, periodLabels(cfg)[0])`,
  // landing straight on "P1" (verified directly: asserting "Pre" here
  // failed with the field already reading "P1"). There is no intermediate
  // state to observe between core.start and the first period.
  await expect(periodField).toContainText("P1");

  // Goal: the generic ActionForm path (no QuickActionCard here). `kind` is
  // UI-required (Confirm stays disabled until chosen) even though the
  // engine itself treats it as optional; `by` (side) is attribution and so
  // never blocks Confirm structurally, but omitting it would 422 (a goal
  // needs a side) — picked explicitly here, unlike football's skippable
  // scorer/assist, because "by" is the one attribution item this flow
  // cannot honestly skip.
  await page.getByRole("button", { name: "Goal", exact: true }).click();
  // NOT `{ exact: true }`: a <select>'s computed accessible name concatenates
  // its caption WITH every option's text (confirmed directly — the exact
  // name here is "KindChoose…FgOgPpShPs", not "Kind"), unlike a plain
  // <input>'s label (racquet's "Home"/"Away" number fields above, which
  // exact-match fine) — only enum fields hit this. A substring match on
  // "Kind" alone is still unambiguous on this form.
  const kindSelect = page.getByLabel("Kind");
  await expect(kindSelect).toBeVisible();
  await kindSelect.selectOption({ label: "Fg" });
  await page.locator(`[data-value="${fx.home}"]`).click();
  await page.locator('[data-role="confirm"]').click();

  // Period advance: NOT zero-field — period/kernel.ts's own `advanceAction`
  // declares one required enum field (`to`, no `labelKey`, so ActionForm
  // falls back to a derived caption — confirmed directly: a bare tap only
  // EXPANDS this action's form, it does not auto-submit like football's
  // zero-field period markers). Zero attribution though (period.ts's own
  // comment: "carries no attribution at all — a whistle belongs to neither
  // side"), so no side/person picking needed once `to` is set. `to`'s only
  // legal value from "P1" is "P2" (period/kernel.ts's own `periodLabels`
  // for a 3-period cfg) — selected by value, since (like "Kind" above) the
  // <select>'s accessible NAME concatenates its whole option list.
  await page.getByRole("button", { name: "Advance period", exact: true }).click();
  await page.locator("select").selectOption("P2");
  await page.locator('[data-role="confirm"]').click();
  await expect.poll(() => queueRowCount(page, "scorepad-harness-icehockey")).toBe(0);

  // See the file header's "THIRD consequence".
  await page.goto(url);
  await bootstrapWait(page);

  // IIHF's own scoreboard-ready period labels (period/kernel.ts's
  // `periodLabels`, a 3-period cfg: ["P1","P2","P3"]) — starting on "P1"
  // (core.start, above) means one advance lands on "P2", not "P1" again.
  await expect(scoreField).toContainText("1 – 0");
  await expect(periodField).toContainText("P2");
  await expectNoHorizontalScroll(page);

  const ledger = await ledgerOf(request, fx.fixtureId);
  expect(ledger.length, "core.start + one goal + one period advance").toBe(3);
  expect(ledger[0]).toMatchObject(CORE_START);
  expect(ledger[1]).toMatchObject({ type: "icehockey.goal", payload: { by: fx.home, kind: "fg" } });
  expect(ledger[2]).toMatchObject({ type: "icehockey.period.advance" });
});
