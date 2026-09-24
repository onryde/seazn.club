// A Playwright spec that no CI project selects is not coverage — it is a file
// that goes green by never running.
//
// `playwright.config.ts` has claimed since #597 that "apps/web/src/lib/
// __tests__/e2e-ci-wiring.test.ts pins that property". IT DID NOT EXIST. The
// claim was written beside the carve-out it describes and read as true by
// every session since; R3/task D found it while confirming a new spec joins a
// CI project that actually runs. This file is that pin, written to the
// properties the config's own comment asserts.
//
// WHAT CAN GO WRONG, and why each is worth a test rather than a comment:
//
//  1. `e2e.yml` runs the `parallel` project as THREE jobs — one "heavy" leg
//     naming a handful of expensive files, and two "rest" legs sharding
//     everything else. "rest" is a CATCH-ALL by construction (it ignores
//     PARALLEL_HEAVY and nothing else), which is the ONLY reason a new spec
//     file joins CI without anybody editing a list. Turn that into three
//     explicit per-shard file lists and a new spec silently runs nowhere.
//  2. A TYPO inside PARALLEL_HEAVY costs nothing visible: the heavy leg simply
//     selects fewer files and passes, while the mistyped file runs on the
//     "rest" legs it was carved out of for being slow. The balance the carve-
//     out exists for quietly stops holding.
//  3. A spec added to `SERIAL_SPECS` but never removed from the parallel
//     project's ignore list — or vice versa — is either run twice against
//     shared org state or not at all.
//
// Sibling of db-suite-ci-wiring.test.ts / redis-suite-ci-wiring.test.ts and
// deliberately the same shape: pure (no DB, no network, no browser), so it
// runs in every job and can never self-skip — the property that makes a
// wiring guard worth having at all.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** apps/web — this file lives at apps/web/src/lib/__tests__/. */
const WEB = resolve(import.meta.dirname, "../../..");
const E2E_DIR = join(WEB, "e2e");
const REPO_ROOT = resolve(WEB, "../..");

type Pattern = RegExp | string | (RegExp | string)[] | undefined;

interface ProjectLike {
  name?: string;
  testMatch?: Pattern;
  testIgnore?: Pattern;
}

function asRegExps(pattern: Pattern): RegExp[] {
  if (pattern === undefined) return [];
  const list = Array.isArray(pattern) ? pattern : [pattern];
  return list.map((p) => (p instanceof RegExp ? p : new RegExp(p)));
}

/**
 * Playwright's own file selection, applied to a bare filename.
 *
 * `testMatch` ABSENT is not the same as `testMatch: undefined` handed to the
 * runner — the config spreads the key in conditionally for exactly that
 * reason — and an absent one falls back to the runner's default, which is what
 * makes "rest" a catch-all. Reimplemented here rather than driving the real
 * runner because the whole point is to check the CONFIG's selection, in a pure
 * unit test that needs no browser and no server.
 */
const DEFAULT_TEST_MATCH = /\.(spec|test)\.[cm]?[jt]sx?$/;

function selects(project: ProjectLike, file: string): boolean {
  // Playwright matches against the file's ABSOLUTE path, so a pattern may be
  // anchored on a directory (`/e2e/walkthrough/`) and not merely a basename.
  // `file` arrives relative to e2e/, so put the segment back before testing —
  // otherwise a directory-anchored pattern silently matches nothing here and
  // this guard reports selection that the real runner does not perform.
  const path = `/e2e/${file}`;
  if (asRegExps(project.testIgnore).some((re) => re.test(path))) return false;
  const match = asRegExps(project.testMatch);
  return match.length === 0 ? DEFAULT_TEST_MATCH.test(path) : match.some((re) => re.test(path));
}

/** The config is built at MODULE EVALUATION from `process.env
 *  .E2E_PARALLEL_SLICE`, so each slice needs its own fresh evaluation. */
async function configFor(slice: string | undefined): Promise<{ projects: ProjectLike[] }> {
  vi.resetModules();
  if (slice === undefined) vi.stubEnv("E2E_PARALLEL_SLICE", "");
  else vi.stubEnv("E2E_PARALLEL_SLICE", slice);
  // An empty string is falsy for the config's `=== "heavy"` / `=== "rest"`
  // comparisons, which is exactly the unset behaviour, but delete it outright
  // so the unset case is genuinely unset.
  if (slice === undefined) delete process.env.E2E_PARALLEL_SLICE;
  const mod = (await import("../../../playwright.config")) as { default: { projects: ProjectLike[] } };
  return mod.default;
}

function projectNamed(config: { projects: ProjectLike[] }, name: string): ProjectLike {
  const found = config.projects.find((p) => p.name === name);
  if (!found) throw new Error(`playwright.config.ts declares no "${name}" project`);
  return found;
}

/** Every e2e spec file, by bare filename. `auth.setup.ts` and the
 *  `*.capture.ts` harnesses (`gallery.capture.ts`, and W2's
 *  `overlay-moments.capture.ts`) are deliberately NOT specs — none carries
 *  `spec`/`test` in its name, which is how the default `testMatch` keeps them
 *  from ever being selected by accident. The `gallery` project's own
 *  `testMatch` is `/\.capture\.ts$/`, so adding a harness needs no config
 *  change; before W2 widened it, a second harness matched NO project and could
 *  not be invoked at all. */
function specFiles(): string[] {
  // RECURSIVE, and returns paths RELATIVE TO e2e/ — both load-bearing since
  // the walkthrough specs moved into e2e/walkthrough/.
  //
  // A bare `readdirSync` does not descend, so every spec in a subdirectory
  // becomes invisible to `orphans` below and this guard goes green while
  // those specs run nowhere — which is the exact failure it exists to catch,
  // reintroduced by a directory move rather than a config edit. And the paths
  // must stay relative rather than bare basenames, because a project that
  // selects or ignores a DIRECTORY (`/walkthrough\//`) can only be tested
  // against a path that still contains it.
  const walk = (dir: string, prefix: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(dir, entry.name), `${prefix}${entry.name}/`)
        : entry.name.endsWith(".spec.ts")
          ? [`${prefix}${entry.name}`]
          : [],
    );
  return walk(E2E_DIR, "").sort();
}

/**
 * THE WALKTHROUGH INVENTORY — deliberately manual, and deliberately brittle.
 *
 * Every other assertion in this file is a COUNT or a SHAPE: "more than 50 spec
 * files exist", "the walkthrough project selects at least one", "nothing is
 * orphaned". Not one of them can witness the loss of a NAMED spec. Delete the
 * two scheduling walkthroughs and the floors read 127 and 20 — still green.
 * `orphans` cannot see it either: a file that no longer exists cannot be
 * orphaned. The only remaining signal would be a CI leg that runs on push to
 * `main` alone, i.e. AFTER the merge that lost the coverage.
 *
 * So the walkthrough specs are listed here BY NAME. The brittleness is the
 * feature, not a cost to be engineered away: deleting a spec reds this test
 * until somebody consciously deletes its line, and adding one reds it until
 * somebody consciously adds one. A count floor would buy the convenience back
 * at the price of the only property worth having — the alternative to a
 * brittle list is not a robust list, it is silence.
 *
 * These are the suite's product-level proofs, and each is expensive to lose
 * quietly: the money specs are the only places in the suite that move real
 * value through Stripe, and the rest each play a whole match or a whole
 * organiser's day by hand.
 *
 * SCOPE: existence and SELECTION only. Whether a spec SKIPS at runtime (no
 * Stripe key, no CONNECT_WALKTHROUGH, no Redis) is a different question and
 * deliberately not this one's — a spec that skips was still dispatched; a spec
 * that vanished was not.
 *
 * Grouped by programme, NOT alphabetically, so a whole programme going missing
 * reads as a block. Bare filenames; `walkthrough/` is prefixed at the use site.
 */
const WALKTHROUGH_SPECS: string[] = [
  // Scheduling — the organiser's day end to end, and the officials hand-off.
  "scheduling-officials-handoff.spec.ts",
  "scheduling-organiser-day.spec.ts",
  // The competition board's Publish all, carried through to the spectator:
  // "Time TBD" under Unscheduled on the public hub before, a real kick-off
  // time after, and a division the gate blocked still hidden beside it. It is
  // the only test anywhere that crosses that seam — the banner's own suite
  // renders it outside the page that mounts it, and the use-case's suite never
  // meets the button or the hub, so both stay green if the wiring between them
  // dies.
  "publish-all-releases-public-times.spec.ts",

  // MONEY. The only specs in the suite that put real value through Stripe;
  // each already degrades to a silent skip without its secrets, so losing the
  // FILE would look exactly like the skip that CI already tolerates.
  "registration-connect.spec.ts",
  "rs007-invite-pay-cancel.spec.ts",
  "rs007-money-matrix.spec.ts",
  "event-pass.spec.ts",

  // Registration — the entrant-facing journeys.
  "rs007-registration-journey.spec.ts",
  "rs010-registration-cross-flow.spec.ts",
  "rs011-eligibility-gates.spec.ts",
  "rs012-solo-signup-pool.spec.ts",

  // ScoringPad v3 — a whole match played by hand, per sport and per decider.
  "scorepad-v3-badminton-match.spec.ts",
  "scorepad-v3-boardgame-result.spec.ts",
  "scorepad-v3-carrom-match.spec.ts",
  "scorepad-v3-deciders-byhand.spec.ts",
  "scorepad-v3-deciders-fullmatch.spec.ts",
  "scorepad-v3-honest-recording.spec.ts",
  "scorepad-v3-period-pair.spec.ts",
  "scorepad-v3-r7-console-chrome.spec.ts",
  "scorepad-v3-soft-commit-visual.spec.ts",
  "scorepad-v3-tabletennis-match.spec.ts",
  "scorepad-v3-tennis-mtb.spec.ts",
  "scorepad-v3-volleyball-match.spec.ts",
  "scorepad-v3-cricket-icc-picks.spec.ts",

  // The organiser desks.
  "competition-desk-organiser.spec.ts",
  "settings-admin.spec.ts",

  // Settings W2 — the organisation and news panels, the four people-facing
  // tabs (team, api, preferences, account), and the five-org support cap.
  "settings-org-tabs.spec.ts",
  "settings-people-tabs.spec.ts",
  "settings-support-smoke.spec.ts",

  // Settings W3 — the gating matrix: role gates, entitlement gates, and
  // ownership/last-actor cases (leave-org, delete-account, transfer).
  "settings-entitlement-gates.spec.ts",
  "settings-ownership.spec.ts",
  "settings-role-gates.spec.ts",

  // Settings W4 — connect/credits/add-ons, the billing panels the existing
  // suites leave uncovered, and the sponsor monetize half.
  "settings-connect-gates.spec.ts",
  "settings-add-ons-drive.spec.ts",
  "settings-billing-panels.spec.ts",
  // Runs for REAL in CI, on every push to `main`: it sells, invoices, charges
  // and refunds a sponsor package through real Stripe test mode. Not opt-out
  // there — `STRIPE_SECRET_KEY` and `STRIPE_CONNECT_TEST_ACCOUNT` are both
  // configured repo secrets, and e2e.yml maps them onto the `walkthrough`
  // matrix leg alone, then exports `CONNECT_WALKTHROUGH=1` and a freshly minted
  // `STRIPE_WEBHOOK_SECRET` through `$GITHUB_ENV` before the server boots, so
  // runner and server verify against the same secret. Locally it is opt-in and
  // skips loudly without those exported. Listed here because the inventory's
  // job is to notice a DELETED spec, whatever the run state of the leg.
  "settings-sponsor-monetize.spec.ts",

  // Settings W5 — competition settings (`/o/{org}/c/{comp}/settings`), the
  // surface the suite never navigated to before this wave: general/branding
  // drive+persist, the showcase opt-in and its auto-clear (case #10), and the
  // youth-consent interstitial.
  "settings-competition-drive.spec.ts",
  // The gating half of the same surface: the `competitions.max_active` freeze
  // (case #4) and its bare-status escape hatch, the `discovery.branding` /
  // `discovery.listed` / `dashboard.theme` entitlements, a viewer's read-only
  // render and 403, and the date-order refusal (case #18).
  "settings-competition-gates.spec.ts",

  // Settings W6 — the division `settings`/`constraints` schedule tabs
  // (`/o/{org}/c/{comp}/d/{div}/schedule`), zero e2e coverage before this
  // wave: matchMinutes/gapMinutes/perEntrantMinRest and startAt/endAt
  // drive+persist, the `tz` omit-means-untouched contract, the constraints
  // tab's noBackToBack toggle, and case #17 (the play-hours client-side
  // guard that blocks the PUT before it ever fires).
  "settings-schedule-drive.spec.ts",
  // The bounds half of the same surface (Task 2): matchMinutes 0/1441
  // (case #15), gapMinutes/perEntrantMinRest/constraints.restMin negative
  // (case #16), endAt-before-startAt and a blackout to-before-from
  // (case #18's division half), and courts above the 50 cap (case #22).
  // Entirely API-only — no `page` in this file.
  "settings-schedule-bounds.spec.ts",

  // Settings W7 — the registration hub's row-click config panel
  // (`/o/{org}/c/{comp}/registration`, Settings tab), for the three CLIENT
  // behaviours no API-only spec can see: the card-fee-minimum gate refusing
  // before any network write (case #20), a real double-tap on Save firing one
  // save cycle (case #24), and the two-endpoint save reporting a genuine half
  // landing — PATCH ok, PUT refused by the plan's entrant cap (case #23).
  "settings-registration-client-guards.spec.ts",
  // The server half of the same surface (Task 2), API-only: the age-cutoff
  // bounds matrix on `PATCH /divisions/{id}` — an impossible day per short
  // month, both-or-neither, the schema's own 1-12/1-31 ranges — and the
  // card-fee minimum proved on the SERVER with the panel's client gate
  // bypassed, behind the Connect precondition that gates it.
  "settings-registration-bounds.spec.ts",

  // The directory — the organiser's own records, driven through the screens
  // that own them: club import caps, the import paywall preview, officials'
  // roles against the upgrade gate, player identity and its duplicate queue,
  // and a venue carrying three courts.
  "directory-clubs-import-limits.spec.ts",
  "directory-import-paywall-preview.spec.ts",
  "directory-officials-roles.spec.ts",
  "directory-player-identity.spec.ts",
  "directory-venues-courts.spec.ts",

  // Spectator surface W1 (Task 15) — the anonymous match centre. Split
  // across two files so each stays under budget: cricket matches A (tapped
  // through the real v3 pad) and B (finished) in one; football, tennis,
  // consent, the control-set diff, axe, screens and locale in the other.
  // Replaces the deleted w0-spectator-capture.spec.ts (never itself
  // registered here — its job moved into these two before this inventory
  // and the feature branch ever met).
  "spectator-public-2.spec.ts",
  "spectator-public.spec.ts",

  // Spectator surface W2 (Task 17) — the competition hub's tabs, the org
  // home's chips and order, and the player card, one file each so a red seed
  // hides only its own surface.
  "spectator-hub.spec.ts",
  "spectator-org-home.spec.ts",
  "spectator-player.spec.ts",

  // Per-stage match rules — one organiser's path through the three things that
  // branch shipped, in the order they happen to them: a stage given its own
  // Best-of while its neighbour keeps the division's, the Start-tournament
  // confirmation and the four consequences it states, and the parent
  // competition moving published → live as the division starts. It is also the
  // only spec that drives BOTH directions of the per-stage format lock (a
  // played stage refuses, the stage beside it still saves), which is the half
  // a refusal-only test cannot distinguish from a lock that refuses
  // everything.
  "stage-rules-start-promotion.spec.ts",

  // The draw's own words. One organiser builds a League + Finals draw through
  // the wizard, reads who feeds each seat of the final on BOTH the bracket
  // tree and the draw list under it, confirms the seeding, and watches one of
  // those named seats become a real person as the semi that feeds it is
  // decided. The three states are the point: a label that is right at setup
  // and stale after the draw is the same defect one screen later, and no
  // single-surface slice can see it.
  "draw-feeder-labels.spec.ts",
  // The other side of the same tab: an entrant leaves mid-tournament. The
  // organiser is not offered her in a ladder challenge nor able to seed her
  // into a bracket, her standings row stays and is MARKED rather than
  // vanishing, and the draw she was qualified for resolves her line as a
  // walkover instead of reseeding around her. Four refusals that are only
  // trustworthy together — each one alone is satisfied by a product that
  // simply deleted her.
  "withdrawn-entrant-organiser.spec.ts",
  // Swiss shell hardening (Task 1.0, and the eager pre-Start extension) — one
  // organiser lays a three-round Swiss out BEFORE Start, pins a court and a
  // time on a LATER round's TBD shell, then changes the field the way a club
  // night changes it (people arrive, somebody drops out) and Pairs. Two
  // directions, because a bye appearing and a bye disappearing are different
  // branches: 6→9 (even→odd, a board minted) and 9→6 (odd→even, the surplus
  // board and the bye deleted while the pinned `b1` survives). No unit test can
  // see the part that matters — that rounds 2 AND 3 come back SCHEDULABLE for
  // the field the organiser now has, rather than for the one that was there
  // when the shells were minted.
  "swiss-pre-start-field-change.spec.ts",
  // Swiss round-1 pairing — a Swiss Knockout (stored as Neighbours) paired
  // from the desk's split button: a plain Pair next seats top-vs-bottom, Unpair,
  // the ▾ Neighbours pick seats neighbours for that one press, the round-2 menu
  // is read-only, and round 2 pairs off the table. It is the only test that
  // proves the pick reaches the POST body — the unit suite cannot press it.
  "swiss-round-one-pairing.spec.ts",

  // Device-link write path W1 — the realtime propagation flows §6b of the
  // design surveyed and found uncovered: a courtside device's goal reaching
  // the organiser's SCREEN, and the organiser's goal reaching a device pad
  // that is already mounted. It is the only walkthrough that holds two pads
  // open on one fixture at once, and the only one anywhere that asserts a
  // propagation arrived FASTER than the pad's polling fallback — without that
  // clause every such test is satisfied by the 15-second poll.
  "console-device-live-sync.spec.ts",
  // Device-link write path W2 — durable idempotency (design §6). A rally is
  // tapped, the write commits, the RESPONSE is lost, and the pad's own request
  // is replayed on the wire. It is the only test anywhere that proves the PAD
  // sends an idempotency key rather than that the server honours one: it never
  // constructs a request, it replays what the pad itself sent. The API-level
  // cases beside it (`e2e/scoring-idempotency.spec.ts`) mint their own keys and
  // so cannot witness that seam at all.
  "scoring-idempotency-retry.spec.ts",
  // Device-link write path W3 — the console's own refresh floor. Drives the
  // console with its pad's realtime door aborted AND its 15s poll fallback
  // aborted, so the chrome is proven to refresh WITHOUT the pad's pipeline
  // rather than merely alongside it. No unit test can see any of this:
  // apps/web vitest is environment "node", so there is no document, no
  // visibilitychange, and no way to observe the listener at all.
  "console-stalled-pipeline.spec.ts",
  // Device-link write path, G1 (a standalone fix W3's whole-branch review
  // found, not a fourth wave) — the SAME floor on the console's twin, the
  // courtside device-link pad. Same cursor discrimination: the pad's realtime
  // door and its poll are aborted for the whole run, the chrome's own
  // `since_seq=0` read is let through, so the header is proven to refresh on a
  // tab return WITHOUT the pad's pipeline. The unit suite can invoke the
  // registered handler against a stubbed document; only this sees a browser
  // deliver the event.
  "device-pad-stalled-pipeline.spec.ts",
  // Device-link pad, owner-reported: the chrome's "Void my last entry" names
  // the rally by the SERVER's row id, and the inner pad — which held it under
  // its own client-minted key and polls strictly past its count — never
  // reverted. Read off the PAD's own scoreboard, never the chrome's header
  // (which was right all along). No unit test can see the two writers meet.
  "device-pad-foreign-void.spec.ts",

  // Entrant rename (2026-09-22, reported from production: a pair swapped a
  // partner and kept the old partner's name). One organiser renames one pair
  // three ways — a roster save that re-derives its name, the Name field saved
  // together with a roster edit, and a player's ✎ in the directory — and reads
  // each rename back from the entrant row, the fixtures tab, the standings and
  // the public division page, inside the public cache's lifetime. The slices
  // are in e2e/entrant-rename.spec.ts; this is the only test that carries one
  // pair through all three, each starting from what the last one left.
  "entrant-rename-walkthrough.spec.ts",

  // Knockout void un-fill (2026-09-23, owner report: voiding a decided
  // knockout result left the voided winner seated in the final). One organiser
  // decides R1·1 on the pad, voids it from the console, scores it the other
  // way, and reads the final's own console after each step: the old winner,
  // "Winner of R1·1" again, then the new winner. Once the final has started
  // the void is refused, and the refusal reaches the screen in French naming
  // the next match — the seam from the 409's `next_match` to the console copy
  // that no unit test drives end to end.
  "knockout-void-unfill.spec.ts",

  // Printable scorer sheets, Task 3 — the console's device hand-over panel
  // once links are durable: Show QR re-shows the SAME secret (a printed sheet
  // keeps working), Revoke & reissue and Revoke both ask first, Keep sends no
  // DELETE and a confirm sends exactly one (counted off the wire), a reissued
  // secret no longer opens a pad, a finalized match's REAL 422 renders the
  // localised refusal in en and fr, and the Rebuild confirm names printed
  // sheets only when the stage has device links. The panel's unit suite
  // drives a double and can see none of the wire.
  "scorer-sheets-handover-panel.spec.ts",
  // Scorer sheets §4.5 — the carried-forward seam, driven from its real
  // producer (a courtside INNER-pad tap) to its real consumer (the chrome's
  // View-only screen). No unit test can see the pipeline → registry → chrome hop.
  "device-pad-carried-forward.spec.ts",
  // Scorer sheets §4.5 (Task 6) — every scan screen, en + fr, at 320/768/1280:
  // a final's sheet scanned early waits, then moves to Confirm BY ITSELF when
  // the semis are decided (a real side fill, zero events on the final); Start
  // opens the pad; a cancel with no event reaches the phone through its HTTP
  // cache (an unrouted page — the body-digest ETag). No unit test can see the
  // server page re-render under a mounted Waiting, or the browser's cache.
  "scorer-sheets-scan-screens.spec.ts",
];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("e2e CI wiring", () => {
  it("has spec files to check at all", () => {
    // Guards the guard: an empty list would make every assertion below
    // vacuously true, which is the failure mode a directory rename produces.
    expect(specFiles().length).toBeGreaterThan(50);
  });

  it("runs every spec file in at least one CI leg", async () => {
    // The three legs e2e.yml actually dispatches for `--project=parallel`,
    // plus the two projects it runs whole.
    const heavy = projectNamed(await configFor("heavy"), "parallel");
    const rest = projectNamed(await configFor("rest"), "parallel");
    const unset = await configFor(undefined);
    const serial = projectNamed(unset, "serial");
    const walkthrough = projectNamed(unset, "walkthrough");
    const mobile = unset.projects.filter((p) => p.name?.startsWith("mobile-") || p.name?.startsWith("tablet-"));

    const orphans = specFiles().filter(
      (file) =>
        !selects(heavy, file) &&
        !selects(rest, file) &&
        !selects(serial, file) &&
        !selects(walkthrough, file) &&
        !mobile.some((p) => selects(p, file)),
    );
    expect(orphans, "a spec no CI leg selects runs nowhere and can never fail").toEqual([]);
  });

  it("splits the parallel project into heavy + rest with nothing lost and nothing run twice", async () => {
    const whole = projectNamed(await configFor(undefined), "parallel");
    const heavy = projectNamed(await configFor("heavy"), "parallel");
    const rest = projectNamed(await configFor("rest"), "parallel");
    const files = specFiles();

    const inWhole = files.filter((f) => selects(whole, f));
    const inHeavy = files.filter((f) => selects(heavy, f));
    const inRest = files.filter((f) => selects(rest, f));

    // The split is a PARTITION of the unsliced project: their union is it, and
    // their intersection is empty. Either half failing means CI runs something
    // twice or not at all, while a local `npm run test:e2e` still looks right.
    expect([...inHeavy, ...inRest].sort()).toEqual(inWhole);
    expect(inHeavy.filter((f) => inRest.includes(f))).toEqual([]);
    expect(inHeavy.length).toBeGreaterThan(0);

    // The partition covers the parallel project only. The walkthrough specs
    // are ignored by all three slices and belong to their own project — if
    // they ever leak back in they would run twice, once here and once there.
    expect(files.filter((f) => f.startsWith("walkthrough/")).filter((f) => selects(whole, f))).toEqual([]);
  });

  it("gives the walkthrough specs a project of their own, and it is not empty", async () => {
    // These are the suite's product-level proofs — a whole match played by
    // hand through the decider. They are also the specs most likely to be
    // moved or renamed, and a walkthrough project that selects nothing is
    // indistinguishable from a green one.
    const unset = await configFor(undefined);
    const walkthrough = projectNamed(unset, "walkthrough");
    const selected = specFiles().filter((f) => selects(walkthrough, f));
    expect(selected.length, "the walkthrough project selects no specs at all").toBeGreaterThan(0);
    expect(
      selected.every((f) => f.startsWith("walkthrough/")),
      "the walkthrough project selected something outside e2e/walkthrough/",
    ).toBe(true);
  });

  // The two assertions the floors above cannot make. See WALKTHROUGH_SPECS for
  // why the list is manual. Both messages NAME the file: "expected 22, got 21"
  // sends the reader hunting, which is most of the reason a count floor is not
  // a substitute for an inventory.
  it("still has every walkthrough spec the inventory names, and CI still selects it", async () => {
    const walkthrough = projectNamed(await configFor(undefined), "walkthrough");
    const present = new Set(specFiles());

    const gone = WALKTHROUGH_SPECS.filter((name) => !present.has(`walkthrough/${name}`));
    expect(
      gone,
      "these specs are named in WALKTHROUGH_SPECS and no longer exist under e2e/walkthrough/. If the deletion was deliberate, delete the line here too. If it was not, this is the coverage loss the inventory exists to announce — nothing else in this file can see it",
    ).toEqual([]);

    // Existence is not selection: the project is directory-anchored today, but
    // an explicit per-file testMatch or a new testIgnore would leave these
    // files on disk and running nowhere — failure mode 1 in this file's header,
    // one level down.
    const unselected = WALKTHROUGH_SPECS.filter((name) => !selects(walkthrough, `walkthrough/${name}`));
    expect(
      unselected,
      "these walkthrough specs exist but the `walkthrough` project no longer selects them, so no CI leg runs them",
    ).toEqual([]);
  });

  it("names every walkthrough spec on disk in the inventory", () => {
    const listed = new Set(WALKTHROUGH_SPECS);
    const unlisted = specFiles()
      .filter((f) => f.startsWith("walkthrough/"))
      .map((f) => f.slice("walkthrough/".length))
      .filter((name) => !listed.has(name));
    expect(
      unlisted,
      "these walkthrough specs are not named in WALKTHROUGH_SPECS. Add each one — a spec absent from the inventory can be deleted later without anything going red, which is the whole defect this list exists to close",
    ).toEqual([]);
  });

  it("names only REAL files in the heavy carve-out", async () => {
    const heavy = projectNamed(await configFor("heavy"), "parallel");
    const sources = asRegExps(heavy.testMatch).map((re) => re.source);
    expect(sources, "the heavy slice must carve out by an explicit testMatch").toHaveLength(1);

    // `(a|b|c)\.spec\.ts` — the alternation is the hand-maintained half, so
    // this is where a typo lands. A mistyped name costs nothing visible
    // otherwise: the heavy leg just selects fewer files and goes green.
    const alternation = /\(([^)]+)\)/.exec(sources[0]!);
    expect(alternation, `unexpected PARALLEL_HEAVY shape: ${sources[0]}`).not.toBeNull();
    const named = alternation![1]!.split("|");
    const present = specFiles();
    for (const name of named) {
      expect(present, `PARALLEL_HEAVY names "${name}.spec.ts", which does not exist`).toContain(`${name}.spec.ts`);
    }

    // And the leg must actually select one file per name — a regex that parses
    // but matches nothing is the same defect wearing a different hat.
    expect(present.filter((f) => selects(heavy, f))).toHaveLength(named.length);
  });

  it("is dispatched by e2e.yml with exactly the slices this config understands", () => {
    const yml = readFileSync(join(REPO_ROOT, ".github/workflows/e2e.yml"), "utf8")
      // YAML comments stripped: the workflow's own prose names "heavy" and
      // "rest" in the block above the matrix, so a raw substring search would
      // stay green with the `slice:` keys deleted — precisely the failure this
      // exists to catch.
      .split("\n")
      .map((line) => line.replace(/(^|\s)#.*$/, ""))
      .join("\n");

    expect(yml, "e2e.yml must still pass the slice through to the config").toContain("E2E_PARALLEL_SLICE");
    for (const slice of ["heavy", "rest"]) {
      expect(yml, `e2e.yml dispatches no "${slice}" leg`).toContain(`slice: ${slice}`);
    }
    // A project declared in the config but never dispatched runs nowhere —
    // the same orphan defect one level up, at the workflow rather than the
    // spec. The matrix carries the project name per leg for this reason.
    expect(yml, "e2e.yml dispatches no walkthrough leg").toContain("project: walkthrough");
    expect(yml, "the matrix must pass its project through to Playwright").toContain("--project=${{ matrix.project }}");
    // The two "rest" legs shard between themselves; the heavy leg does not.
    expect(yml).toContain("--shard=1/2");
    expect(yml).toContain("--shard=2/2");
  });

  // RS007. The Connect walkthrough is the ONLY place in the suite that
  // genuinely produces `checkout.session.completed`, and it can only do so
  // with a real key AND a webhook forwarder — the webhook is registrations'
  // sole fulfilment path, so without a forwarder a paid entry stays `pending`.
  // Both halves are asserted here because either one missing degrades the leg
  // to a silent skip, which reads in the summary exactly like a leg that ran.
  it("wires the Connect walkthrough's real key and its webhook forwarder", () => {
    const yml = readFileSync(join(REPO_ROOT, ".github/workflows/e2e.yml"), "utf8");

    // Comments are NOT stripped here, unlike the slice test above: this
    // assertion is about wiring that only the walkthrough leg may receive, and
    // the surrounding prose is what stops the next reader handing the real key
    // to every leg.
    expect(
      yml,
      "the walkthrough leg no longer receives a real STRIPE_SECRET_KEY — the Connect walkthrough cannot reach checkout.stripe.com with the dummy",
    ).toContain("matrix.project == 'walkthrough' && secrets.STRIPE_SECRET_KEY");
    expect(
      yml,
      "STRIPE_CONNECT_TEST_ACCOUNT is not wired — a fabricated account id is rejected by Stripe as a transfer destination",
    ).toContain("STRIPE_CONNECT_TEST_ACCOUNT");
    expect(
      yml,
      "no `stripe listen` forwarder — without it a paid entry stays `pending` and the spec fails at the webhook wait",
    ).toContain("stripe listen");
    // The forwarder must publish the session's own secret to LATER steps: the
    // server reads STRIPE_WEBHOOK_SECRET at boot, so a forwarder started after
    // it, or one that never exports, silently verifies against the wrong key.
    expect(
      yml,
      "the forwarder does not export STRIPE_WEBHOOK_SECRET to subsequent steps",
    ).toContain('echo "STRIPE_WEBHOOK_SECRET=$secret" >> "$GITHUB_ENV"');
    expect(
      yml,
      "nothing enables CONNECT_WALKTHROUGH, so the spec skips even when the secrets are present",
    ).toContain("CONNECT_WALKTHROUGH=1");
    // A missing secret must ANNOUNCE that the money path went unexercised,
    // rather than leaving a green leg that proves nothing about fulfilment.
    expect(
      yml,
      "an unconfigured Connect walkthrough skips silently — no ::warning:: telling the reader the money path was not exercised",
    ).toMatch(/::warning::Connect walkthrough NOT run/);

    // ORDER IS LOAD-BEARING, and asserting only on content missed it (review
    // finding 6): `$GITHUB_ENV` applies to SUBSEQUENT steps, and the server
    // reads STRIPE_WEBHOOK_SECRET at boot. A forwarder started after the
    // server would leave the app verifying signatures against the job-level
    // dummy while Stripe signs with the session secret — every webhook
    // rejected, the entry stuck `pending`, and the failure surfacing as a
    // timeout in the spec rather than as anything naming the real cause.
    // Anchor on the STEP NAMES, not on `stripe listen` — the prose above the
    // step mentions the command too, and that comment does not move when the
    // steps do. Written the obvious way first, this assertion survived a
    // mutation that swapped the two steps: it was matching the comment.
    const forwarderAt = yml.indexOf("- name: Start Stripe webhook forwarder");
    const serverAt = yml.indexOf("- name: Start server");
    expect(forwarderAt, "no Stripe forwarder step at all").toBeGreaterThan(-1);
    expect(serverAt, "no `Start server` step at all").toBeGreaterThan(-1);
    expect(
      forwarderAt,
      "the Stripe forwarder starts AFTER the server — the server would boot with the wrong webhook secret and reject every event",
    ).toBeLessThan(serverAt);
  });

  // RS007 follow-up. Two reviewers independently claimed the job-level `env:
  // STRIPE_WEBHOOK_SECRET: whsec_e2e_payments` above is re-applied to every
  // step and therefore clobbers the forwarder's `$GITHUB_ENV` write, so
  // `Start server` would always boot with the placeholder. Checked against
  // the actions/runner source (StepsRunner.cs / JobExtension.cs /
  // FileCommandManager.cs, actions/runner@1d8e0dd6): the job-level `env:`
  // block is folded into the job's one shared env dictionary EXACTLY ONCE,
  // at job init, before any step runs. Every step then rebuilds its own env
  // context fresh FROM that same shared, mutable dictionary, and a
  // `$GITHUB_ENV` write mutates it in place — nothing ever re-applies the
  // static job-level value afterward. So the claim is FALSE: the forwarder's
  // write wins for every step that follows it, exactly as the comment above
  // the forwarder step already says. The one thing that WOULD still shadow
  // it is a STEP-LEVEL `env:` key on the step that actually reads the secret
  // at boot — the real precedence rules give a step's own `env:` priority
  // over the job's shared dictionary for that step alone. That is the one
  // shape of "shadowing" that can really happen, so it is what this guards.
  it("does not let a step-level env on `Start server` shadow the forwarder's dynamic secret", () => {
    const yml = readFileSync(join(REPO_ROOT, ".github/workflows/e2e.yml"), "utf8");
    const serverAt = yml.indexOf("- name: Start server");
    const nextStepAt = yml.indexOf("- name: Run Playwright e2e");
    expect(serverAt, "no `Start server` step at all").toBeGreaterThan(-1);
    expect(nextStepAt, "no step follows `Start server`").toBeGreaterThan(serverAt);
    const serverStep = yml.slice(serverAt, nextStepAt);
    expect(
      serverStep,
      "`Start server` declares its own STRIPE_WEBHOOK_SECRET — a step-level env key wins over whatever the forwarder wrote to $GITHUB_ENV for THIS step, so the server would boot verifying against the wrong secret",
    ).not.toContain("STRIPE_WEBHOOK_SECRET");
  });

  // Overlay #782: Actions strips job-env vars whose NAME contains
  // PRIVATE_KEY, so the mint key lives as SUPABASE_JWT_SIGNING_KEY_B64.
  // The value is a CI-only dummy (kid e2e-ci-dummy-es256) — enough to mint
  // ES256 against stub.supabase.co, never a real JWKS. The previous inlined
  // JWK was rotated out. Job env alone is not the whole story: Start server
  // and Playwright each declare their own env: block, and a missing key on
  // those steps is how a rename to PRIVATE_KEY would go dark again.
  it("keeps a dummy ES256 signing JWK on every e2e job, Start server, and Playwright step", () => {
    const yml = readFileSync(join(REPO_ROOT, ".github/workflows/e2e.yml"), "utf8");

    const assigned = yml.match(/^\s*SUPABASE_JWT_[A-Z0-9_]+:/gm) ?? [];
    expect(
      assigned.some((line) => /PRIVATE_KEY/.test(line)),
      "an assignment named *PRIVATE_KEY* is stripped by Actions and never reaches the job",
    ).toBe(false);

    const signing = [...yml.matchAll(/^\s+SUPABASE_JWT_SIGNING_KEY_B64: (.+)$/gm)].map(
      (m) => m[1]!.trim(),
    );
    const literals = signing.filter((v) => !v.startsWith("${{"));
    const passthroughs = signing.filter((v) =>
      v.includes("env.SUPABASE_JWT_SIGNING_KEY_B64"),
    );
    expect(literals.length, "one dummy JWK per e2e job").toBe(3);
    expect(
      passthroughs.length,
      "Start server + Playwright, three jobs — the processes that mint / drive mint",
    ).toBe(6);
    expect(new Set(literals).size, "all three jobs must share the same dummy").toBe(1);

    const jwk = JSON.parse(Buffer.from(literals[0]!, "base64").toString("utf8")) as {
      kty?: string;
      crv?: string;
      alg?: string;
      kid?: string;
      d?: string;
      use?: string;
    };
    expect(jwk).toMatchObject({
      kty: "EC",
      crv: "P-256",
      alg: "ES256",
      kid: "e2e-ci-dummy-es256",
      use: "sig",
    });
    expect(typeof jwk.d, "private JWK — mint needs d").toBe("string");

    // Public-x prefix of the previous inlined JWK (kid e2e-ci-es256).
    expect(yml, "previous inlined signing JWK must not return").not.toContain(
      "Ka1hMRlRLQkZtY05a",
    );

    const startServers = [...yml.matchAll(/- name: Start server\n([\s\S]*?)(?=\n      - name: )/g)];
    expect(startServers.length, "three e2e jobs each start a server").toBe(3);
    for (const [, body] of startServers) {
      expect(body).toContain("SUPABASE_JWT_SIGNING_KEY_B64:");
    }

    const playwrightSteps = [
      ...yml.matchAll(/- name: Run Playwright e2e[^\n]*\n([\s\S]*?)(?=\n      - name: )/g),
    ];
    expect(playwrightSteps.length, "three Playwright run steps").toBe(3);
    for (const [, body] of playwrightSteps) {
      expect(body).toContain("SUPABASE_JWT_SIGNING_KEY_B64:");
    }
  });

  // Application log flood at the default info level buries the failure in
  // Actions. warn (web pino) / WARNING (placement structlog) keep refusals
  // and faults; silent/CRITICAL would hide the only signal on a real red.
  it("quiets web and placement application logs on every e2e server and solver", () => {
    const yml = readFileSync(join(REPO_ROOT, ".github/workflows/e2e.yml"), "utf8");

    const startServers = [...yml.matchAll(/- name: Start server\n([\s\S]*?)(?=\n      - name: )/g)];
    expect(startServers.length, "three e2e jobs each start a server").toBe(3);
    for (const [, body] of startServers) {
      expect(body, "LOG_LEVEL must be on the server process, not Playwright").toMatch(
        /^\s+LOG_LEVEL:\s*warn\s*$/m,
      );
    }

    const placementStarts = [
      ...yml.matchAll(/- name: Start the placement service\n([\s\S]*?)(?=\n      - name: )/g),
    ];
    expect(placementStarts.length, "three e2e jobs each start placement").toBe(3);
    for (const [, body] of placementStarts) {
      expect(body).toContain("-e PLACEMENT_LOG_LEVEL=WARNING");
    }
  });

  // Run 33315548699 reported itself as testing 4c606a302 while three of its
  // eight jobs had actually checked out 203395b6a -- "P9.5 -- one
  // court-availability function (#638)", weeks old. The checkout pinned
  // `ref: refs/heads/main`, a BRANCH NAME, which each job resolves for itself
  // against Blacksmith's git proxy; that mirror was serving a stale tip.
  //
  // Nothing caught it for as long as it had been happening, because every
  // other step exists in both trees and passes either way. It surfaced only
  // when a step whose SCRIPT postdates the stale commit ran from YAML that
  // came from the new one -- `npm error Missing script: "check:build-chunks"`.
  // A green e2e run is worth nothing if it cannot say which commit it ran.
  //
  // `github.sha` is immutable, so a stale mirror fails to produce the object
  // and the job dies loudly instead of quietly testing old code. This does not
  // make the mirror fresher; it makes staleness impossible to mistake for a
  // pass. (Line 88's concurrency group keeps `github.ref` on purpose --
  // grouping by SHA would stop a superseded run from cancelling its
  // predecessor.)
  it("pins every checkout to an immutable SHA, never a branch name", () => {
    const yml = readFileSync(join(REPO_ROOT, ".github/workflows/e2e.yml"), "utf8");
    const refs = yml.match(/^\s*ref: \$\{\{.*$/gm) ?? [];
    expect(refs.length, "no `ref:` on any checkout — has the workflow changed shape?").toBe(3);
    for (const ref of refs) {
      expect(
        ref,
        "a checkout resolves a BRANCH NAME, so jobs in one run can test different commits (and did: run 33315548699)",
      ).not.toMatch(/github\.ref/);
      expect(ref, "a checkout is not pinned to github.sha").toContain("github.sha");
    }
  });

  // The spec moved out of e2e/ into e2e/walkthrough/ (RS007). The project is
  // directory-anchored, so the move is what enrols it — but a rename or a
  // revert would leave the wiring above pointing at nothing.
  it("keeps the Connect walkthrough inside the walkthrough project", async () => {
    const unset = await configFor(undefined);
    const walkthrough = projectNamed(unset, "walkthrough");
    const selected = specFiles().filter((f) => selects(walkthrough, f));
    expect(
      selected,
      "registration-connect.spec.ts is not selected by the walkthrough project",
    ).toContain("walkthrough/registration-connect.spec.ts");
  });
});
