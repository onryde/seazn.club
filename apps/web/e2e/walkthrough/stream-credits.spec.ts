// Streaming R1, lane D — the stream CREDITS walkthrough (File B; case list owner-approved 2026-09-29:
// `.superpowers/sdd/2026-09-13-streaming-r1/walkthrough-inventory.md`, cases B1-B6).
//
// A club's match credits, read through the one page that shows them — the division fixtures tab's Phone tab — and
// through the ledger behind it. Every case asserts BOTH: the chip/split/card the organiser reads, and the
// `org_stream_credits` rows by bucket. A number on the screen that the ledger does not hold (or the reverse) is exactly
// the defect class these cases exist for.
//
// THE RULES THIS FILE ENCODES (V426, Task 14b — owner-approved 2026-09-29, restated so a reader need not open the code):
//   * EVERY plan streams, and every plan grants free MONTHLY match credits: `plan_entitlements` row
//     `streaming.credits.monthly`. The expected numbers are READ from that row (overlay-kit `setRigPlan`, or the pass
//     rows directly) — never typed here, so a catalogue edit moves the expectation with it.
//   * The monthly grant is LAZY: the page's read grants it (no cron, no create hook). One grant per org per UTC month,
//     keyed `stream-monthly:{org}:{YYYY-MM}`. Last month's leftover EXPIRES before this month's grant; bought (pack)
//     credits never expire. A mid-month upgrade tops the month up by the DIFFERENCE only.
//   * An Event Pass grants its credits ONCE, into the pack bucket, keyed `stream-pass:{paymentIntent ?? competitionId}`.
//   * A pack bought through the embedded checkout is credited by the signed `checkout.session.completed` webhook,
//     once per Checkout Session.
//
// SETUP MAY REACH A STATE BY SQL/API; EVERY ACTION UNDER TEST IS DONE IN THE BROWSER — here that action is almost
// always "load the Phone tab", because the page's own read IS the grant under test. What is set up by SQL, and why:
//   * the plan flip (`setRigPlan`) — an upgrade through Stripe is not this file's journey;
//   * a spent credit (a `consume` row) — spending one by going live is File A's journey (stream-relay.spec.ts, A1/A2),
//     and B6 reaches LIVE through the API for the same reason;
//   * last month's ledger (B2) — a clock cannot be moved under a production server.
//
// Single-sport (hockey, overlay-kit's `seedOverlayFixture`) by design: every rule here is ORG-level and reads no sport.
//
// Stated gap (inventory): real card entry inside Stripe's iframe is not driven. B4 mounts the REAL sheet on a REAL
// Checkout Session, then replays the completion as a signed webhook built from that session as Stripe returns it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import Stripe from "stripe";
import { apiJson, invalidateOrgEntitlements } from "../helpers";
import { grantRigPackCredits, seedOverlayFixture, setRigPlan, type OverlayRig } from "../overlay-kit";
import { STREAM_CREDIT_PACKS } from "../../src/lib/stream-credit-packs";
import { FAKE_CONNECT_AFTER_MS_DEFAULT, FakeIngest } from "../../src/server/relay/fakes";
import { STREAM_POLL_MS } from "../../src/lib/stream-session-view";
import { MAX_DURATION_MINUTES } from "../../src/server/relay/config";

/** lib/currency.ts `PASS_KEYS`, restated: that module cannot be imported here — it pulls `@/config/stripe-plans.json`
 *  without an import attribute, and the spec then collects ZERO tests. The B1 registry test pins this list against the
 *  catalogue, so a rung added there and not here reds that test rather than going unswept. */
const PASS_KEYS = ["event_pass", "event_pass_l"] as const;
/** Each pass rung's durable Stripe identity, read from the seed `stripe:sync` pushes (src/config/stripe-plans.json,
 *  read as data for the same import-attribute reason) — the lookup key a real pass session's price carries. */
const PASS_LOOKUP_KEYS: Record<string, string | undefined> = Object.fromEntries(
  (
    JSON.parse(readFileSync(fileURLToPath(new URL("../../src/config/stripe-plans.json", import.meta.url)), "utf8")) as {
      passes?: { key: string; price?: { lookup_key?: string } }[];
    }
  ).passes?.map((p) => [p.key, p.price?.lookup_key]) ?? [],
);

// ---------------------------------------------------------------------------------------------------------------------
// Budget — derived, never a flat literal (AGENTS.md class 20). Each test states its own counts as its FIRST act.
// ---------------------------------------------------------------------------------------------------------------------

/** One load of the division fixtures tab under contention (the walkthrough README's `navs × 20_000`). */
const NAV_MS = 20_000;
/** One tap or one assertion round (the README's `acts × 5_000`). */
const ACT_MS = 5_000;
/** `seedOverlayFixture`: an org, a rostered hockey fixture, four events and a PUT, all over the API. */
const SEED_MS = 45_000;
/** One signed webhook POST, through runEvent and the ledger writer. */
const HOOK_MS = 5_000;
/** The fake ingest reads "connected" this long after its input was created (server/relay/fakes.ts). A server started
 *  with FAKE_INGEST_CONNECT_AFTER_MS overrides it — CI sets it on the server AND this process (e2e.yml), so export the
 *  server's value here too. Parsed as strictly as fakes.ts parses it (stream-relay.spec.ts's pattern), so a junk value
 *  fails here rather than budgeting from NaN. */
const FAKE_CONNECT_MS = ((): number => {
  const raw = process.env.FAKE_INGEST_CONNECT_AFTER_MS;
  if (raw === undefined) return FAKE_CONNECT_AFTER_MS_DEFAULT;
  if (!/^\d+$/.test(raw)) throw new Error(`FAKE_INGEST_CONNECT_AFTER_MS must be whole milliseconds, got ${JSON.stringify(raw)}`);
  return Number(raw);
})();
/** The fake's connect delay, then two organiser polls (the one in flight and the one that sees it), plus slack (B6). */
const LIVE_MS = FAKE_CONNECT_MS + 2 * STREAM_POLL_MS + 5_000;
const budget = (c: { seeds: number; navs: number; acts: number; hooks?: number; lives?: number }): number =>
  Math.max(
    60_000,
    c.seeds * SEED_MS + c.navs * NAV_MS + c.acts * ACT_MS + (c.hooks ?? 0) * HOOK_MS + (c.lives ?? 0) * LIVE_MS,
  );

// ---------------------------------------------------------------------------------------------------------------------
// The copy — from the dictionary itself, never typed, so a copy edit moves the expectation with it.
// ---------------------------------------------------------------------------------------------------------------------

const EN_UI = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../src/dictionaries/en/ui.json", import.meta.url)), "utf8"),
) as Record<string, string>;
const en = (key: string, vars: Record<string, number> = {}): string => {
  const raw = EN_UI[key];
  if (raw === undefined) throw new Error(`en/ui.json has no ${key}`);
  return raw.replace(/\{(\w+)\}/g, (_, v: string) => {
    if (!(v in vars)) throw new Error(`en(${key}): no value for {${v}}`);
    return String(vars[v]);
  });
};
const chipText = (n: number): string =>
  n === 1 ? en("stream.phone.credits.one") : en("stream.phone.credits.other", { n });
const monthlyNote = (n: number): string =>
  n === 1 ? en("stream.credits.monthlyNote.one") : en("stream.credits.monthlyNote.other", { n });

// ---------------------------------------------------------------------------------------------------------------------
// The ledger — read straight from the table the page reads (helpers.ts keeps its withDb private; this is the
// stream-credits-admin.spec.ts local copy, same shape).
// ---------------------------------------------------------------------------------------------------------------------

async function withDb<T>(fn: (sql: import("postgres").Sql) => Promise<T>): Promise<T> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required for direct DB setup in e2e");
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl, {
    connection: { search_path: process.env.DB_SCHEMA ?? "seazn_club" },
    ssl: process.env.DATABASE_SSL === "disable" ? false : /@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl) ? false : "require",
    prepare: !dbUrl.includes(":6543"),
    max: 1,
  });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The ONE stream slot this file may hold. Admission weighs the deployment's storage headroom — every ACTIVE session's
// max-duration reservation, across the WHOLE server — before it looks at the fixture's own active session
// (server/relay/domain/session.ts `admit`), so a stream started here while stream-relay.spec.ts (File A) streams on the
// same server can be refused as "storage exhausted", or refuse one of File A's. File A holds the advisory-lock keys
// [7_301_130_000, 7_301_130_000 + CAPACITY - 1) and leaves exactly one slot for any other file; this file takes THAT
// key, for its one live case (B6), and stops the stream in teardown — on a red too — before it lets the key go. The
// capacity is DERIVED the way File A derives it (the fake ingest's storage limit over the config's max duration), so a
// change to either moves both files' key ranges together. No other case here goes live.
// ---------------------------------------------------------------------------------------------------------------------

const STREAM_CAPACITY = Math.floor(new FakeIngest().storage.totalStorageMinutesLimit / MAX_DURATION_MINUTES);
/** stream-relay.spec.ts's `SLOT_LOCK_BASE`, restated (a spec cannot import another spec). */
const FILE_A_SLOT_BASE = 7_301_130_000;
/** The slot File A leaves: the first key past its range. */
const STREAM_SLOT_KEY = FILE_A_SLOT_BASE + STREAM_CAPACITY - 1;
/** Waiting out one other holder of the key: its stream going live and its teardown taking it off the air. */
const SLOT_WAIT_MS = LIVE_MS + NAV_MS;
/** Teardown: the stop, then the organiser poll that ticks the session to completed. */
const TEARDOWN_MS = NAV_MS;

let lease: (() => Promise<void>) | null = null;
const liveRigs: { request: APIRequestContext; orgId: string }[] = [];

/** Take this file's stream slot before going live; held until teardown. */
async function streamSlot(): Promise<void> {
  if (!(STREAM_CAPACITY >= 1)) throw new Error(`the fake ingest holds ${STREAM_CAPACITY} stream(s) — none for this file`);
  if (lease) throw new Error("this file holds at most ONE stream slot, and it is already held");
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL required for the stream-slot lease");
  const { default: postgres } = await import("postgres");
  const sql = postgres(dbUrl, {
    ssl: process.env.DATABASE_SSL === "disable" ? false : /@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl) ? false : "require",
    prepare: !dbUrl.includes(":6543"),
    max: 1,
    idle_timeout: 0,
  });
  const deadline = Date.now() + SLOT_WAIT_MS;
  for (;;) {
    const [row] = await sql<{ ok: boolean }[]>`select pg_try_advisory_lock(${STREAM_SLOT_KEY}::bigint) as ok`;
    if (row?.ok) {
      lease = () => sql.end(); // a session-level advisory lock is released with its connection
      return;
    }
    if (Date.now() > deadline) {
      await sql.end();
      throw new Error(`stream slot ${STREAM_SLOT_KEY} not free after ${SLOT_WAIT_MS} ms`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** Every session the org still holds that is not over. */
async function openSessions(orgId: string): Promise<{ id: string; fixture_id: string }[]> {
  return withDb(
    (sql) => sql<{ id: string; fixture_id: string }[]>`
      select id, fixture_id from fixture_stream_sessions where org_id = ${orgId} and state not in ('completed', 'failed')`,
  );
}

/** Teardown: stop every stream the test went live on, through the product's own Stop as the rig's owner; tick each
 *  with the organiser's poll until it is over; force any that will not end; THEN free the slot — so a red case never
 *  keeps a reservation that refuses File A's next start. */
async function teardownStreams(): Promise<void> {
  try {
    for (const { request, orgId } of liveRigs.splice(0)) {
      const open = await openSessions(orgId);
      for (const s of open) await request.post(`/api/v1/fixtures/${s.fixture_id}/stream-sessions/${s.id}/stop`).catch(() => null);
      if (open.length === 0) continue;
      await expect
        .poll(
          async () => {
            for (const s of open) await request.get(`/api/v1/fixtures/${s.fixture_id}/stream-sessions/current`).catch(() => null);
            return (await openSessions(orgId)).length;
          },
          { timeout: TEARDOWN_MS, intervals: [1_000] },
        )
        .toBe(0)
        .catch(() =>
          withDb((sql) => sql`update fixture_stream_sessions set state = 'failed', fail_reason = 'unknown', ended_at = now()
                               where org_id = ${orgId} and state not in ('completed', 'failed')`),
        );
    }
  } finally {
    const release = lease;
    lease = null;
    await release?.();
  }
}

test.afterEach(async () => {
  await teardownStreams();
});

interface LedgerRow {
  reason: string;
  delta: number;
  bucket: "monthly" | "pack";
  idempotency_key: string | null;
  stripe_event_id: string | null;
  pack_key: string | null;
  balance_after: number;
}

async function ledger(orgId: string): Promise<LedgerRow[]> {
  return withDb(async (sql) => [
    ...(await sql<LedgerRow[]>`
      select reason, delta, bucket, idempotency_key, stripe_event_id, pack_key, balance_after
        from org_stream_credits where org_id = ${orgId} order by created_at, reason`),
  ]);
}

/** The balance by bucket, summed here — the test's own arithmetic over the rows, not the product's. */
async function buckets(orgId: string): Promise<{ monthly: number; pack: number; total: number }> {
  const rows = await ledger(orgId);
  const monthly = rows.filter((r) => r.bucket === "monthly").reduce((s, r) => s + r.delta, 0);
  const pack = rows.filter((r) => r.bucket === "pack").reduce((s, r) => s + r.delta, 0);
  return { monthly, pack, total: monthly + pack };
}

/** The UTC calendar month a date falls in, `YYYY-MM` — V426's period. */
const periodOf = (d: Date): string => d.toISOString().slice(0, 7);
/** V426's monthly grant key: `stream-monthly:{org}:{YYYY-MM}`. */
const monthlyKey = (orgId: string, period: string): string => `stream-monthly:${orgId.toLowerCase()}:${period}`;
/** V426 addendum P's pass grant key: `stream-pass:{paymentIntent ?? competitionId}`. */
const passKeyOf = (anchor: string): string => `stream-pass:${anchor}`;

/** Every expectation in a test names ONE month (its keys, its expire row). A run that straddles a UTC month turn fails
 *  as a rollover defect it is not — so a FAILED test says, on itself, when the month turned under it. A passing test
 *  is left alone: it held its month's keys to the end, so the turn cannot have touched it. */
let startedPeriod = "";
test.beforeEach(() => {
  startedPeriod = periodOf(new Date());
});
test.afterEach(() => {
  const info = test.info();
  if (info.status === info.expectedStatus) return;
  const now = periodOf(new Date());
  if (now !== startedPeriod) {
    info.annotations.push({
      type: "month-turn",
      description: `started in ${startedPeriod}, ended in ${now}: this failure may be the month turning, not a defect — re-run it`,
    });
  }
});

/** Spend ONE free monthly credit — what going live writes (File A drives the real thing). A `consume` row in the
 *  monthly bucket, `balance_after` the org total after it, as every ledger writer keeps it. */
async function spendMonthlyCredit(orgId: string): Promise<void> {
  await withDb(async (sql) => {
    const [row] = await sql<{ monthly: number; total: number }[]>`
      select coalesce(sum(delta) filter (where bucket = 'monthly'), 0)::int as monthly, coalesce(sum(delta), 0)::int as total
        from org_stream_credits where org_id = ${orgId}`;
    if (!row || row.monthly < 1) throw new Error(`spendMonthlyCredit: org ${orgId} holds no free credit to spend`);
    await sql`
      insert into org_stream_credits (org_id, delta, reason, bucket, balance_after, note)
      values (${orgId}, -1, 'consume', 'monthly', ${row.total - 1}, 'e2e: a match streamed on the free credit')`;
  });
}

/** V426's declared credits for a plan or pass key — the SAME row `setRigPlan` reads, for the keys it cannot move a
 *  subscription onto (a pass is not a subscription plan). */
async function declaredCredits(key: string): Promise<number> {
  const [row] = await withDb(
    (sql) => sql<{ n: number | null }[]>`
      select int_value as n from plan_entitlements where plan_key = ${key} and feature_key = 'streaming.credits.monthly'`,
  );
  if (row?.n === null || row?.n === undefined) throw new Error(`plan ${key} declares no streaming.credits.monthly (V426)`);
  return row.n;
}

async function planRig(page: Page, plan: string): Promise<{ rig: OverlayRig; rate: number }> {
  const rig = await seedOverlayFixture(page);
  // The EMPTY case first: the seed never reads a balance, and nothing grants eagerly (no cron, no create hook) — so a
  // fresh org owns no ledger rows until a reader rolls its month.
  expect(await ledger(rig.orgId), "a fresh org owns no ledger rows before any reader").toEqual([]);
  const { monthlyMatchCredits: rate } = await setRigPlan(rig.orgId, plan);
  await invalidateOrgEntitlements(page.request, rig.orgId);
  return { rig, rate };
}

// ---------------------------------------------------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------------------------------------------------

const divisionPath = (rig: OverlayRig): string => `/o/${rig.orgSlug}/c/${rig.compSlug}/d/${rig.divSlug}?tab=fixtures`;

/** Load the division fixtures tab (THE grant under test — the page's read rolls the month) and open the row's panel
 *  on its Phone tab: stream-overlay.spec.ts's open-the-tab pattern. */
async function openPhoneTab(page: Page, rig: OverlayRig): Promise<void> {
  await page.goto(divisionPath(rig));
  await expect(page.locator('[data-testid="run-sheet"]'), "the fixtures tab rendered no run sheet").toHaveCount(1, {
    timeout: NAV_MS,
  });
  // The sheet opens on "Today" on a match day and the seed schedules nothing for today.
  await page.locator('[data-testid="run-sheet-filter"] [data-filter="all"]').click();
  const toggle = page.locator('[data-testid="fixture-stream-toggle"]');
  await expect(toggle, "every plan holds streaming.overlay (V426), so the row offers the panel").toHaveCount(1);
  await toggle.click();
  await page.locator('[data-testid="stream-tab-phone"]').click();
  await expect(page.locator('[data-testid="stream-phone-gate"] [data-phone-body]'), "the Phone tab body").toHaveCount(1, {
    timeout: NAV_MS,
  });
}

/** What the tab says the org holds. ≥ 1: the chip names the number. 0: there is NO chip (fixture-stream-panel.tsx
 *  renders it only at ≥ 1), and an idle tab shows the forced chooser instead — both halves asserted, so "no chip"
 *  can never pass for a tab that simply failed to render. */
async function expectBalance(page: Page, n: number): Promise<void> {
  const chip = page.locator('[data-testid="stream-balance"]');
  if (n >= 1) {
    await expect(chip).toHaveText(chipText(n), { timeout: NAV_MS });
  } else {
    await expect(page.locator(`[data-testid="stream-buy-pack-${STREAM_CREDIT_PACKS[0]!.size}"]`)).toBeVisible({
      timeout: NAV_MS,
    });
    await expect(chip).toHaveCount(0);
  }
}

/** The "{m} free this month · {p} bought" footnote: shown only while BOTH buckets hold credits. */
async function expectSplit(page: Page, split: { monthly: number; pack: number }): Promise<void> {
  const line = page.locator('[data-testid="stream-credits-split"]');
  if (split.monthly > 0 && split.pack > 0) {
    await expect(line).toHaveText(en("stream.credits.split", { m: split.monthly, p: split.pack }));
  } else {
    await expect(line).toHaveCount(0);
  }
}

/** A control a thumb can actually hit: its centre is ITS OWN (elementFromPoint, not the painted box — AGENTS.md
 *  class 2), and below `md` it is at least 44 px each way. */
async function expectTappable(page: Page, loc: Locator, label: string): Promise<void> {
  await loc.scrollIntoViewIfNeeded();
  const probe = await loc.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { own: at !== null && (at === el || el.contains(at)), w: r.width, h: r.height };
  });
  expect(probe.own, `${label}: something else is on top of its centre`).toBe(true);
  const vw = page.viewportSize()?.width ?? 0;
  if (vw < 768) {
    expect(Math.min(probe.w, probe.h), `${label} at ${vw}: ${Math.round(probe.w)}×${Math.round(probe.h)} px`).toBeGreaterThanOrEqual(44);
  }
}

const shot = (page: Page, name: string) => page.screenshot({ path: test.info().outputPath(name), fullPage: true });

/** The "Now playing" strip's accessible name — how the recorded defect below is found, from the dictionary. */
const NOW_PLAYING = en("schedule.nowPlaying");
/** The checkout sheet's close button — the shared `Modal`'s header close, whose accessible name is HARDCODED English
 *  (`components/modal.tsx`: `aria-label="Close"`), not a dictionary key. So there is no dictionary value to read: a key
 *  that happens to say "Close" elsewhere would be a coincidence, not the source. Recorded in walkthrough-report-B.md
 *  (an untranslated screen-reader label in every locale); the day it moves into the dictionaries, read it from there. */
const MODAL_CLOSE_LABEL = "Close";

/** D1's measured geometry: stages-panel.tsx:778-815, clipped by html overflow-x:clip. At 320 px the "Now playing"
 *  strip's content reaches 56 px past the viewport, every run (two `max-w-[9rem]` names in a non-wrapping
 *  `inline-flex` — a bounded width, so a fixed number). The exemption holds for THAT much and no more: a strip that
 *  grows, or a second thing overflowing inside it, reds instead of hiding behind the recorded defect. */
const D1_OVERFLOW_PX = 56;
/** Sub-pixel rounding and font metrics between machines — not room for a second defect. */
const D1_SLACK_PX = 4;

/**
 * No content past the viewport — `helpers.ts expectNoHorizontalScroll`'s measurement and containment rule, with ONE
 * named, CHECKED, CAPPED exemption, and the stream panel held strictly on top.
 *
 * The page cannot actually SCROLL sideways: `html, body { overflow-x: clip }` (globals.css) cuts off anything wider
 * than the viewport. So the measurement lifts the clip for one read — what it finds is content the organiser cannot
 * see, which is the defect class, whether or not a scrollbar would have shown it.
 *
 * DEFECT D1 (walkthrough-report-B.md; pre-existing, NOT this lane's code, and already noticed by
 * stream-overlay.spec.ts's community test): at 320 px the "Now playing" strip's content is clipped by D1_OVERFLOW_PX.
 * Every rig here is a LIVE hockey fixture, so the strip is always on the page. Rather than go red for a strip this
 * file cannot move — or scope the check to the panel and stop seeing the page at all — clipped content is excused
 * ONLY when every uncontained box past the viewport sits inside that strip AND the amount is D1's own (AGENTS.md class
 * 23: an exemption nobody checks hides the next overflow). The day D1 is fixed, the exemption simply stops being used;
 * its use is annotated on the test so a run says when it leaned on it.
 */
async function expectNoPageScroll(page: Page): Promise<void> {
  const seen = await page.evaluate((nowPlaying) => {
    const html = document.documentElement;
    const body = document.body;
    const vw = html.clientWidth;
    const prev = [html.style.overflowX, body.style.overflowX];
    html.style.overflowX = "visible";
    body.style.overflowX = "visible";
    const overflowPx = Math.max(0, html.scrollWidth - vw);
    [html.style.overflowX, body.style.overflowX] = prev;
    const describe = (el: Element) =>
      `${el.tagName.toLowerCase()}[${(el as HTMLElement).dataset.testid ?? ""}] right=${Math.round(el.getBoundingClientRect().right)} "${(el.textContent ?? "").trim().slice(0, 40)}"`;
    const past = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.right > vw + 1;
    };
    // helpers.ts's containment rule: a box inside its own scroller (or a clip) cannot widen the page.
    const uncontained = (el: Element) => {
      for (let n = el.parentElement; n && n !== body; n = n.parentElement) {
        const ox = getComputedStyle(n).overflowX;
        if (ox === "auto" || ox === "scroll" || ox === "hidden") return false;
      }
      return true;
    };
    const offenders = Array.from(body.querySelectorAll("*")).filter((el) => past(el) && uncontained(el));
    const strip = Array.from(document.querySelectorAll("section[aria-label]")).find(
      (s) => s.getAttribute("aria-label") === nowPlaying,
    );
    const panel = document.querySelector('[data-testid="stream-panel"]');
    const panelBoxes = panel ? [panel, ...Array.from(panel.querySelectorAll("*"))] : [];
    return {
      vw,
      overflowPx,
      excused: offenders.filter((el) => strip?.contains(el)).length,
      outside: offenders.filter((el) => !strip?.contains(el)).map(describe),
      panelChecked: panelBoxes.length,
      panelPast: panelBoxes.filter(past).map(describe),
    };
  }, NOW_PLAYING);
  // Anti-vacuity: a check of a panel that is not there is no check.
  expect(seen.panelChecked, `${seen.vw}: no stream panel box was measured`).toBeGreaterThan(10);
  expect(seen.panelPast, `${seen.vw}: a stream panel box reaches past the viewport`).toEqual([]);
  expect(seen.outside, `${seen.vw}: ${seen.overflowPx}px of content is clipped from outside the recorded D1 strip`).toEqual([]);
  if (seen.overflowPx > 1) {
    // Excused only because EVERY offender is in the strip — and there must be one, or the overflow is unexplained.
    expect(seen.excused, `${seen.vw}: ${seen.overflowPx}px of content clipped with no offender found at all`).toBeGreaterThan(0);
    // …and only as much as D1 itself clips: growth is a new defect, not D1.
    expect(
      seen.overflowPx,
      `${seen.vw}: the Now-playing strip clips ${seen.overflowPx}px, more than D1's measured ${D1_OVERFLOW_PX}px`,
    ).toBeLessThanOrEqual(D1_OVERFLOW_PX + D1_SLACK_PX);
    test.info().annotations.push({
      type: "known-defect",
      description: `D1: the Now-playing strip's content is clipped by ${seen.overflowPx}px at ${seen.vw}px (${seen.excused} boxes)`,
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Stripe — signed with the SAME secret the server verifies with (CI: `whsec_e2e_payments`, or the `stripe listen`
// secret e2e.yml swaps in; locally: the server's own .env.local value, exported into the runner).
// ---------------------------------------------------------------------------------------------------------------------

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY ?? "";
/** The webhook route accepts a comma-separated rotation list (api/webhooks/stripe/route.ts); sign with the first. */
const WEBHOOK_SECRET = (process.env.STRIPE_WEBHOOK_SECRET ?? "").split(",")[0]!.trim();
const stripe = new Stripe(STRIPE_KEY || "sk_test_missing");
/** Every host Stripe.js and the embedded sheet talk to. */
const STRIPE_HOST = /(^|\.)stripe\.(com|network)$/;

/** A Stripe event carrying `object`, signed for this server. `id` is the EVENT id — runEvent's claim. */
function signedEvent(type: string, object: unknown, id = `evt_e2e_${randomBytes(8).toString("hex")}`) {
  const payload = JSON.stringify({
    id,
    object: "event",
    api_version: "2024-06-20",
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type,
    data: { object },
  });
  return {
    id,
    payload,
    headers: {
      "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET }),
      "content-type": "application/json",
    },
  };
}

async function deliver(page: Page, ev: ReturnType<typeof signedEvent>): Promise<number> {
  const res = await page.request.post("/api/webhooks/stripe", { headers: ev.headers, data: ev.payload });
  const status = res.status();
  await res.dispose();
  return status;
}

// =====================================================================================================================
// B1 — the monthly grant, per plan
// =====================================================================================================================

/** The plans B1 sweeps, one width each so the three widths are all driven. The PLAN NAMES are the sweep; their
 *  numbers are never typed — each is read from V426's row by `setRigPlan`. The registry test below proves this table
 *  is every subscription plan that declares a rate, so a plan added to the catalogue cannot go unswept. */
const B1_PLANS = [
  { plan: "community", width: 320 },
  { plan: "pro", width: 768 },
  { plan: "enterprise", width: 1280 },
] as const;

test("B1 · the sweep's plan table is EVERY subscription plan V426 declares a monthly rate for (and the pass rungs B5 reads are declared too)", async () => {
  test.setTimeout(budget({ seeds: 0, navs: 0, acts: 2 }));
  const rows = await withDb(
    (sql) => sql<{ plan_key: string }[]>`
      select plan_key from plan_entitlements where feature_key = 'streaming.credits.monthly' order by plan_key`,
  );
  const declared = rows.map((r) => r.plan_key);
  const passes = declared.filter((k) => (PASS_KEYS as readonly string[]).includes(k));
  const subscription = declared.filter((k) => !(PASS_KEYS as readonly string[]).includes(k));
  // Anti-vacuity: an empty catalogue answers "equal" to an empty table.
  expect(subscription.length, "V426 declares no subscription plan rate at all").toBeGreaterThan(0);
  expect(subscription.sort(), "B1_PLANS must name every subscription plan with a monthly rate").toEqual(
    B1_PLANS.map((p) => p.plan).sort(),
  );
  expect(passes.sort(), "B5 reads a declared amount for EVERY pass rung").toEqual([...PASS_KEYS].sort());
});

for (const { plan, width } of B1_PLANS) {
  test(`B1 · ${plan} at ${width}px: the first load of the Phone tab grants the plan's declared free credits — ONE keyed grant; a second load grants nothing, and a credit spent in between stays spent`, async ({
    page,
  }) => {
    test.setTimeout(budget({ seeds: 1, navs: 3, acts: 14 }));
    const period = periodOf(new Date());
    const { rig, rate } = await planRig(page, plan);
    expect(rate, `V426 grants ${plan} at least one free match a month ("every plan streams")`).toBeGreaterThanOrEqual(1);
    await page.setViewportSize({ width, height: 900 });

    // 1. THE FIRST LOAD grants the month — the chip is the plan's rate, and the ledger holds exactly one keyed row.
    await openPhoneTab(page, rig);
    await expectBalance(page, rate);
    await expectSplit(page, { monthly: rate, pack: 0 });
    const grant: LedgerRow = {
      reason: "grant",
      delta: rate,
      bucket: "monthly",
      idempotency_key: monthlyKey(rig.orgId, period),
      stripe_event_id: null,
      pack_key: null,
      balance_after: rate,
    };
    expect(await ledger(rig.orgId), "one monthly grant, keyed to this org and this UTC month").toEqual([grant]);

    // The card says what the chip is made of: "Buy more" opens the chooser, whose note names the SAME rate.
    const buyMore = page.locator('[data-testid="stream-buy-more"]');
    await expectTappable(page, buyMore, "Buy more");
    await buyMore.click();
    await expect(page.locator('[data-testid="stream-credits-monthly"]')).toHaveText(monthlyNote(rate));
    await expectTappable(page, page.locator('[data-testid="stream-credits-close"]'), "the chooser's Close");
    await expectNoPageScroll(page);
    await shot(page, `b1-${plan}-${width}-granted.png`);

    // 2. THE SECOND LOAD (the same call again): nothing more is owed this month, so nothing is written.
    await openPhoneTab(page, rig);
    await expectBalance(page, rate);
    expect(await ledger(rig.orgId), "a second load wrote a second grant").toEqual([grant]);

    // 3. A CREDIT SPENT between loads stays spent. This is the load where re-granting would SHOW: a page that rolled
    //    the month again would put the chip back to the full rate.
    await spendMonthlyCredit(rig.orgId);
    await openPhoneTab(page, rig);
    await expectBalance(page, rate - 1);
    const rows = await ledger(rig.orgId);
    expect(rows.filter((r) => r.reason === "grant"), "still exactly the one grant").toEqual([grant]);
    expect(rows.filter((r) => r.reason === "expire"), "nothing expired inside the month").toEqual([]);
    expect((await buckets(rig.orgId)).total).toBe(rate - 1);
    if (rate - 1 === 0) {
      // Nothing left: the idle tab is the FORCED chooser, and its note still names the month's allowance.
      await expect(page.locator('[data-testid="stream-credits-monthly"]')).toHaveText(monthlyNote(rate));
      await expect(page.locator('[data-testid="stream-go-live"]')).toHaveCount(0);
    } else {
      // Credits left: the idle tab offers Go live, not the forced chooser.
      await expect(page.locator('[data-testid="stream-go-live"]')).toBeVisible();
      await expect(page.locator('[data-testid="stream-credits-monthly"]')).toHaveCount(0);
    }
    await expectNoPageScroll(page);
    await shot(page, `b1-${plan}-${width}-spent.png`);
  });
}

// =====================================================================================================================
// B2 — the month turns
// =====================================================================================================================

test("B2 · a new month at 320px: last month's UNSPENT free credits expire and this month's arrive on the first load — the bought credits are untouched, and a second load moves nothing", async ({
  page,
}) => {
  test.setTimeout(budget({ seeds: 1, navs: 3, acts: 12 }));
  const now = new Date();
  const period = periodOf(now);
  // Pro, because "partly used" needs a rate of at least 2 — the plan is the choice, its number is still V426's.
  const { rig, rate } = await planRig(page, "pro");
  expect(rate, "a PARTLY used month needs a rate of at least 2").toBeGreaterThanOrEqual(2);

  // LAST MONTH, as its own rows would stand: its keyed grant, one match streamed on it. By SQL — a clock cannot be
  // moved under a production server. Mid-month, so no time zone can move either row into this month.
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15, 12));
  const prev = periodOf(lastMonth);
  expect(prev, "last month is a different period").not.toBe(period);
  const used = 1;
  const leftover = rate - used;
  await withDb(async (sql) => {
    await sql`
      insert into org_stream_credits (org_id, delta, reason, bucket, balance_after, note, idempotency_key, created_at)
      values (${rig.orgId}, ${rate}, 'grant', 'monthly', ${rate}, ${"e2e: free match credits for " + prev},
              ${monthlyKey(rig.orgId, prev)}, ${lastMonth})`;
    await sql`
      insert into org_stream_credits (org_id, delta, reason, bucket, balance_after, note, created_at)
      values (${rig.orgId}, ${-used}, 'consume', 'monthly', ${leftover}, 'e2e: a match streamed last month',
              ${new Date(lastMonth.getTime() + 3_600_000)})`;
  });
  // And BOUGHT credits, which never expire.
  const bought = 2;
  expect(await grantRigPackCredits(rig.orgId, bought), "the org total before the month rolls").toBe(leftover + bought);
  const before = await ledger(rig.orgId);
  expect(before.length).toBe(3);

  // THE LOAD under test.
  await page.setViewportSize({ width: 320, height: 900 });
  await openPhoneTab(page, rig);
  // The right answer differs from both wrong ones: no expiry would read leftover + rate + bought; an expiry that
  // swept the pack too would read rate alone.
  await expectBalance(page, rate + bought);
  await expectSplit(page, { monthly: rate, pack: bought });
  await expectNoPageScroll(page);
  await shot(page, "b2-rollover-320.png");

  const after = await ledger(rig.orgId);
  expect(after.slice(0, before.length), "the old rows are never touched — the ledger is append-only").toEqual(before);
  expect(after.slice(before.length), "the roll: last month's leftover expired, then this month's grant").toEqual([
    {
      reason: "expire",
      delta: -leftover,
      bucket: "monthly",
      idempotency_key: null,
      stripe_event_id: null,
      pack_key: null,
      balance_after: bought,
    },
    {
      reason: "grant",
      delta: rate,
      bucket: "monthly",
      idempotency_key: monthlyKey(rig.orgId, period),
      stripe_event_id: null,
      pack_key: null,
      balance_after: rate + bought,
    },
  ]);
  expect(await buckets(rig.orgId), "monthly is this month's rate; the pack is exactly what was bought").toEqual({
    monthly: rate,
    pack: bought,
    total: rate + bought,
  });

  // The second load: the month has rolled, nothing more is owed.
  await openPhoneTab(page, rig);
  await expectBalance(page, rate + bought);
  expect(await ledger(rig.orgId), "a second load rolled the month again").toEqual(after);
});

// =====================================================================================================================
// B3 — an upgrade mid-month
// =====================================================================================================================

test("B3 · an upgrade mid-month at 1280px tops the month up by the DIFFERENCE, not a second full grant — and a reload, a downgrade and a return to the same plan write nothing more", async ({
  page,
}) => {
  test.setTimeout(budget({ seeds: 1, navs: 5, acts: 14 }));
  const period = periodOf(new Date());
  const { rig, rate: lower } = await planRig(page, "community");
  expect(lower, "community's rate must be at least 1, or a full re-grant and the top-up read the same").toBeGreaterThanOrEqual(1);
  await page.setViewportSize({ width: 1280, height: 900 });

  // The month starts on the lower plan, nothing spent.
  await openPhoneTab(page, rig);
  await expectBalance(page, lower);
  const base = monthlyKey(rig.orgId, period);
  const first = await ledger(rig.orgId);
  expect(first.map((r) => [r.reason, r.delta, r.bucket, r.idempotency_key])).toEqual([["grant", lower, "monthly", base]]);

  // THE UPGRADE (a plan flip — the Stripe upgrade is not this journey), then the load under test.
  const { monthlyMatchCredits: higher } = await setRigPlan(rig.orgId, "pro");
  await invalidateOrgEntitlements(page.request, rig.orgId);
  expect(higher, "the upgrade must grant more, or there is nothing to top up").toBeGreaterThan(lower);
  await openPhoneTab(page, rig);
  // The month now holds what the NEW plan grants — not the old grant plus a whole new one (lower + higher).
  await expectBalance(page, higher);
  await page.locator('[data-testid="stream-buy-more"]').click();
  await expect(page.locator('[data-testid="stream-credits-monthly"]')).toHaveText(monthlyNote(higher));
  await expectNoPageScroll(page);
  await shot(page, "b3-upgraded-1280.png");
  const topped = await ledger(rig.orgId);
  expect(topped.length, "one top-up row after the base grant").toBe(2);
  const topUp = topped[1]!;
  expect([topUp.reason, topUp.delta, topUp.bucket]).toEqual(["grant", higher - lower, "monthly"]);
  expect(topUp.idempotency_key, "the top-up is keyed within this month's grant key").toMatch(
    new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:.+`),
  );
  expect(await buckets(rig.orgId)).toEqual({ monthly: higher, pack: 0, total: higher });

  // The second load on the same plan: nothing more.
  await openPhoneTab(page, rig);
  await expectBalance(page, higher);
  expect(await ledger(rig.orgId), "a reload topped the month up again").toEqual(topped);

  // A DOWNGRADE is owed nothing and claws nothing back: the credits already granted this month stay.
  await setRigPlan(rig.orgId, "community");
  await invalidateOrgEntitlements(page.request, rig.orgId);
  await openPhoneTab(page, rig);
  await expectBalance(page, higher);
  expect(await ledger(rig.orgId), "a downgrade wrote a row").toEqual(topped);

  // And a return to the higher plan inside the same month is owed nothing either: the month already holds its rate.
  await setRigPlan(rig.orgId, "pro");
  await invalidateOrgEntitlements(page.request, rig.orgId);
  await openPhoneTab(page, rig);
  await expectBalance(page, higher);
  expect(await ledger(rig.orgId), "a return to the same plan topped the month up twice").toEqual(topped);
});

// =====================================================================================================================
// B4 — a pack bought from the chooser
// =====================================================================================================================

test("B4 · a pack bought from the forced chooser: no Stripe request until the tap, the tap mounts the REAL sheet on the session the route opened, its signed completion credits the pack ONCE (a replay and a redelivery add nothing), and the return lands on the new balance with Go live offered", async ({
  page,
}) => {
  test.setTimeout(budget({ seeds: 1, navs: 4, acts: 28, hooks: 3 }));
  // Skip LOUDLY, never quietly: without a real test key there is no Checkout Session to mount, and without the
  // server's webhook secret there is no completion to sign. CI's non-walkthrough dummy is the usual cause.
  const unusable =
    !/^(sk|rk)_test_/.test(STRIPE_KEY) || STRIPE_KEY === "sk_test_ci_e2e_dummy"
      ? `STRIPE_SECRET_KEY is ${STRIPE_KEY ? "the CI dummy / not a test key" : "unset"}`
      : !WEBHOOK_SECRET
        ? "STRIPE_WEBHOOK_SECRET is unset (it must be the SAME value the server under test booted with)"
        : null;
  if (unusable) console.warn(`::warning::B4 NOT RUN — the match-credit pack purchase was not exercised: ${unusable}`);
  test.skip(unusable !== null, `B4 needs a real Stripe test key and the server's webhook secret: ${unusable}`);

  const { rig, rate } = await planRig(page, "community");
  expect(rate).toBeGreaterThanOrEqual(1);
  // TODAY's match — the one a club buys credits to stream. The seed leaves its fixture untimed, and on a match day the
  // run sheet opens on "Today", which hides an untimed row: the checkout return then has no row to reopen, and the
  // Phone tab never comes back (DEFECT D2, walkthrough-report-B.md — recorded, not fixed here). Timed for now, the row
  // is on the sheet the return lands on, which is the path this case exists to drive.
  await withDb((sql) => sql`update fixtures set scheduled_at = now() where id = ${rig.fixtureId}`);

  // Reach "no credits left": the page's first read grants the month, and the month is then spent.
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPhoneTab(page, rig);
  await expectBalance(page, rate);
  for (let i = 0; i < rate; i++) await spendMonthlyCredit(rig.orgId);
  expect((await buckets(rig.orgId)).total).toBe(0);

  // From here, every request the page makes to Stripe, and every checkout it asks for, is counted.
  const stripeRequests: string[] = [];
  const checkoutPosts: string[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (STRIPE_HOST.test(url.hostname)) stripeRequests.push(req.url());
    if (url.pathname === "/api/billing/relay-checkout" && req.method() === "POST") checkoutPosts.push(req.postData() ?? "");
  });

  await openPhoneTab(page, rig);
  // The FORCED chooser: no chip, no Go live — the tiles and the month's note are the whole tab.
  await expectBalance(page, 0);
  await expect(page.locator('[data-testid="stream-go-live"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="stream-credits-monthly"]')).toHaveText(monthlyNote(rate));
  await expect(page.locator('[data-testid="stream-credits-close"]'), "a forced chooser has nothing behind it to close to").toHaveCount(0);

  // The chooser at every width, BEFORE any hand reaches a tile (a hover warms the sheet's chunk, so the hit-test is
  // elementFromPoint, never a hover — and the pointer is parked in the corner, where no resize can slide a tile
  // under it).
  await page.mouse.move(0, 0);
  let tilesChecked = 0;
  for (const width of [1280, 768, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const pack of STREAM_CREDIT_PACKS) {
      await expectTappable(page, page.locator(`[data-testid="stream-buy-pack-${pack.size}"]`), `the ${pack.size} tile`);
      tilesChecked++;
    }
    await expectNoPageScroll(page);
    await shot(page, `b4-chooser-${width}.png`);
  }
  expect(tilesChecked, "three tiles at three widths").toBe(STREAM_CREDIT_PACKS.length * 3);
  expect(stripeRequests, "Stripe.js must not load until a hand reaches a tile (I2)").toEqual([]);
  expect(checkoutPosts).toEqual([]);

  // THE TAP (at 320 — the Phone tab's own device): the route opens a Checkout Session and the sheet mounts on it.
  const pack = STREAM_CREDIT_PACKS.find((p) => p.popular) ?? STREAM_CREDIT_PACKS[0]!;
  const [opened] = await Promise.all([
    page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/billing/relay-checkout" && r.request().method() === "POST",
      { timeout: NAV_MS },
    ),
    page.locator(`[data-testid="stream-buy-pack-${pack.size}"]`).click(),
  ]);
  expect(opened.status(), "the checkout route opened a session").toBe(200);
  expect(checkoutPosts.length, "one tap, one checkout request").toBe(1);
  expect(JSON.parse(checkoutPosts[0]!)).toEqual({ orgId: rig.orgId, fixtureId: rig.fixtureId, pack: pack.size });
  const clientSecret = ((await opened.json()) as { data?: { client_secret?: string } }).data?.client_secret ?? "";
  const sessionId = clientSecret.split("_secret_")[0]!;
  expect(sessionId, "an embedded Checkout Session's client secret names its session").toMatch(/^cs_test_/);

  const sheet = page.locator('[data-testid="stream-checkout-modal"]');
  await expect(sheet).toBeVisible({ timeout: NAV_MS });
  await expect(
    sheet.locator('iframe[src^="https://js.stripe.com/"], iframe[src^="https://checkout.stripe.com/"]').first(),
    "the sheet mounts Stripe's own embedded checkout frame",
  ).toBeAttached({ timeout: NAV_MS });
  expect(stripeRequests.length, "the tap is what brought Stripe in").toBeGreaterThan(0);
  await expectNoPageScroll(page);
  await shot(page, "b4-sheet-320.png");

  // The session as STRIPE holds it — the route stamped the snapshot the webhook grants from.
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  expect(session.metadata, "the session's own metadata: this org, this row, this pack, its credits").toMatchObject({
    kind: "stream_credits",
    org_id: rig.orgId,
    fixture_id: rig.fixtureId,
    pack: String(pack.size),
    credits: String(pack.credits),
  });
  expect(session.return_url, "Stripe returns the buyer to this row's Phone tab").toBeTruthy();

  // Stripe COMPLETES it (the card entry inside the frame is the stated gap): its `checkout.session.completed`,
  // built from the session exactly as Stripe returned it, settled, and signed.
  const completed = { ...session, status: "complete", payment_status: "paid", payment_intent: `pi_e2e_${randomBytes(6).toString("hex")}` };
  const first = signedEvent("checkout.session.completed", completed);
  expect(await deliver(page, first), "the webhook accepted the completion").toBe(200);
  const purchases = async () => (await ledger(rig.orgId)).filter((r) => r.reason === "purchase");
  const bought: Partial<LedgerRow>[] = [
    { reason: "purchase", delta: pack.credits, bucket: "pack", stripe_event_id: sessionId, pack_key: pack.lookupKey, balance_after: pack.credits },
  ];
  expect(await purchases(), "one purchase row, in the never-expiring pack bucket").toMatchObject(bought);

  // The SAME event again (Stripe's retry): runEvent's claim answers it, nothing is written.
  expect(await deliver(page, first)).toBe(200);
  expect(await purchases(), "a replayed event credited the pack twice").toMatchObject(bought);
  // A NEW event for the SAME session (a redelivery past the claim — the webhook and a reconcile racing): the session
  // id is the ledger's key, so still one row.
  expect(await deliver(page, signedEvent("checkout.session.completed", completed))).toBe(200);
  expect((await purchases()).length, "a redelivered session credited the pack twice").toBe(1);
  expect(await buckets(rig.orgId)).toEqual({ monthly: 0, pack: pack.credits, total: pack.credits });

  // THE RETURN, as Stripe sends the buyer back: the session's own return_url with its id filled in.
  const back = session.return_url!.replace("{CHECKOUT_SESSION_ID}", sessionId);
  expect(new URL(back).searchParams.get("session_id")).toBe(sessionId);
  await page.goto(back);
  // The return names this row, so its panel opens by itself on the Phone tab — nothing is tapped to get there.
  await expect(page.locator('[data-testid="stream-phone-gate"] [data-phone-body]'), "the return reopens the Phone tab").toHaveCount(1, {
    timeout: NAV_MS,
  });
  await expectBalance(page, pack.credits);
  await expectSplit(page, { monthly: 0, pack: pack.credits });
  await expect(page.locator('[data-testid="stream-go-live"]'), "credits in hand: the tab offers Go live").toBeVisible();
  await expect(
    page.locator(`[data-testid="stream-buy-pack-${STREAM_CREDIT_PACKS[0]!.size}"]`),
    "no longer forced to buy",
  ).toHaveCount(0);
  await expectNoPageScroll(page);
  await shot(page, "b4-returned-320.png");
  // No "the return credited it twice" check here, deliberately: the session is still OPEN at Stripe (no card was
  // entered), so the return's reconcile has nothing to credit whatever its guard does — such a check cannot fail.
  // The return path's own idempotency is a stated gap (walkthrough-report-B.md).
});

// =====================================================================================================================
// B5 — the Event Pass grant
// =====================================================================================================================

test("B5 · an Event Pass grants its rung's declared credits into the bought bucket ONCE per pass — the same event replayed and the same payment redelivered grant nothing more; a no-intent (promotion-code) pass is keyed on its competition; the tab shows the sum", async ({
  page,
}) => {
  test.setTimeout(budget({ seeds: 1, navs: 2, acts: 14, hooks: 7 }));
  const rig = await seedOverlayFixture(page);
  // A SECOND competition in the same org, for the second rung — a competition holds one pass. Created on the seed's
  // plan, before the move below.
  const second = await apiJson<{ id: string }>(page.request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `Pass L ${rig.orgSlug}`,
    visibility: "public",
  });
  expect(second.status, `POST /api/v1/competitions -> ${JSON.stringify(second.error)}`).toBeLessThan(300);
  const secondCompetitionId = second.data!.id;
  const { monthlyMatchCredits: rate } = await setRigPlan(rig.orgId, "community");
  await invalidateOrgEntitlements(page.request, rig.orgId);
  const [m, l] = [await declaredCredits("event_pass"), await declaredCredits("event_pass_l")];
  expect(m, "the M rung grants at least one match").toBeGreaterThanOrEqual(1);
  expect(l, "the L rung grants at least one match").toBeGreaterThanOrEqual(1);

  // The month first, so the pass lands on a ledger that already has a monthly bucket to stay apart from.
  await page.setViewportSize({ width: 768, height: 900 });
  await openPhoneTab(page, rig);
  await expectBalance(page, rate);

  // THE PRICE THE SESSION WAS BUILT ON — the mint guard (lib/billing.ts `passSessionRungMatchesPrice`) compares the
  // session's one line item against the rung's `plans.stripe_price_id_onetime` before any pass or credit is minted.
  // The line item is built from THAT row and the seed's lookup key, so the price-checked path is the one exercised: a
  // session with no expanded line items would make the server ask Stripe for them, and Stripe answers 404 for a
  // hand-built session id — the guard then logs "minting … unverified" and mints unchecked (its fail-open branch).
  // That branch is only a server log line, invisible from here; what IS visible is the check itself, below.
  const priceRows = await withDb(
    (sql) => sql<{ key: string; price_id: string | null }[]>`
      select key, stripe_price_id_onetime as price_id from plans where key in ${sql([...PASS_KEYS])}`,
  );
  const priceOf = (passKey: string) => priceRows.find((r) => r.key === passKey)?.price_id ?? null;
  // Unconfigured (no `stripe:sync` into this database — a laptop; CI syncs the walkthrough leg): the guard returns
  // before it reads a line item, so no price is compared on this run. Said on the test, not assumed.
  const priced = PASS_KEYS.every((k) => priceOf(k) !== null);
  if (!priced) {
    console.warn("::warning::B5: plans.stripe_price_id_onetime is unset here — the pass price check was NOT exercised");
    test.info().annotations.push({ type: "price-check-unconfigured", description: "run stripe:sync into this database to exercise the pass price check" });
  }
  // `priceRung` is the rung whose PRICE the session was built on — its id and its lookup key together, as Stripe
  // returns a real price. It defaults to the rung the metadata names; the refusal case below builds a mismatch.
  const passSession = (competitionId: string, passKey: string, paymentIntent: string | null, priceRung = passKey) => ({
    id: `cs_e2e_${randomBytes(8).toString("hex")}`,
    object: "checkout.session",
    mode: "payment",
    status: "complete",
    // A 100%-off promotion code settles with nothing to collect and NO payment intent (billing-events.ts).
    payment_status: paymentIntent ? "paid" : "no_payment_required",
    payment_intent: paymentIntent,
    customer: null,
    currency: "gbp",
    amount_total: paymentIntent ? 1 : 0,
    metadata: { org_id: rig.orgId, competition_id: competitionId, pass_key: passKey },
    // Exactly one line item, as buildPassCheckoutParams builds it — carried expanded, so the guard reads it here.
    ...(priceOf(priceRung)
      ? {
          line_items: {
            object: "list",
            has_more: false,
            data: [{ object: "item", quantity: 1, price: { id: priceOf(priceRung), lookup_key: PASS_LOOKUP_KEYS[priceRung] ?? null } }],
          },
        }
      : {}),
  });
  // EVERY bought-bucket grant the org holds — not only rows carrying the pass key's shape, so a grant written under
  // the wrong key (or none) is still counted, and a double shows as two rows whatever it is keyed on.
  const passRows = async () => (await ledger(rig.orgId)).filter((r) => r.reason === "grant" && r.bucket === "pack");

  // The check is LIVE (priced databases only — see above): M's metadata on a session built on L's price — the $44.99
  // charge filed under the cheaper rung — is REFUSED: no pass, no credit, one refusal row naming L's price. The
  // unverified fail-open branch would have minted it. (Not a made-up price id with M's lookup key: the guard accepts a
  // price whose lookup key names the rung, by design — a stale `plans` row after a `stripe:sync` price replacement.)
  if (priced) {
    const wrongIntent = `pi_e2e_${randomBytes(6).toString("hex")}`;
    const wrong = passSession(rig.competitionId, "event_pass", wrongIntent, "event_pass_l");
    expect(priceOf("event_pass_l"), "the two rungs are two different prices").not.toBe(priceOf("event_pass"));
    expect(await deliver(page, signedEvent("checkout.session.completed", wrong)), "a refused pass is still ACKed").toBe(200);
    expect(await passRows(), "a pass on the wrong price minted credits").toEqual([]);
    const refused = await withDb(
      (sql) => sql<{ pass_key: string; reason: string; actual_price_id: string | null }[]>`
        select pass_key, reason, actual_price_id from pass_mint_refusals where stripe_ref = ${wrongIntent}`,
    );
    expect(refused, "the refusal is recorded, naming the price it saw").toEqual([
      { pass_key: "event_pass", reason: "price_mismatch", actual_price_id: priceOf("event_pass_l") },
    ]);
  }

  // The M rung, paid by card: keyed on its payment intent.
  const intent = `pi_e2e_${randomBytes(6).toString("hex")}`;
  const mSession = passSession(rig.competitionId, "event_pass", intent);
  const mEvent = signedEvent("checkout.session.completed", mSession);
  expect(await deliver(page, mEvent), "the pass webhook was accepted").toBe(200);
  const mRow = { reason: "grant", delta: m, bucket: "pack", idempotency_key: passKeyOf(intent) };
  expect(await passRows(), "the M pass's credits, once, in the pack bucket").toMatchObject([mRow]);
  // The same event again — runEvent's claim.
  expect(await deliver(page, mEvent)).toBe(200);
  expect(await passRows(), "a replayed pass event granted twice").toMatchObject([mRow]);
  // The same PAYMENT in a new event — past the claim, into recordPassPurchase's same-intent heal, which re-runs the
  // grant: only the pass key stops a second one.
  expect(await deliver(page, signedEvent("checkout.session.completed", mSession))).toBe(200);
  expect(await passRows(), "a redelivered pass payment granted twice").toMatchObject([mRow]);

  // The L rung, on a promotion code covering the price: no payment intent, so the key falls back to the competition.
  const lSession = passSession(secondCompetitionId, "event_pass_l", null);
  expect(await deliver(page, signedEvent("checkout.session.completed", lSession))).toBe(200);
  const lRow = { reason: "grant", delta: l, bucket: "pack", idempotency_key: passKeyOf(secondCompetitionId) };
  expect(await passRows()).toMatchObject([mRow, lRow]);
  expect(await deliver(page, signedEvent("checkout.session.completed", lSession))).toBe(200);
  expect(await passRows(), "a redelivered no-intent pass granted twice").toMatchObject([mRow, lRow]);

  // Both passes are recorded as passes (the grant rides on a pass that exists).
  const passes = await withDb(
    (sql) => sql<{ competition_id: string; pass_key: string }[]>`
      select competition_id, pass_key from competition_passes where org_id = ${rig.orgId} order by pass_key`,
  );
  expect(passes.map((p) => [p.competition_id, p.pass_key])).toEqual([
    [rig.competitionId, "event_pass"],
    [secondCompetitionId, "event_pass_l"],
  ]);
  // The month is untouched; the passes are bought credits.
  expect(await buckets(rig.orgId)).toEqual({ monthly: rate, pack: m + l, total: rate + m + l });

  // THE TAB shows the sum, and the split names which are which.
  await openPhoneTab(page, rig);
  await expectBalance(page, rate + m + l);
  await expectSplit(page, { monthly: rate, pack: m + l });
  await expectNoPageScroll(page);
  await shot(page, "b5-passes-768.png");
});

// =====================================================================================================================
// B6 — the checkout sheet's code cannot load, mid-stream
// =====================================================================================================================

test("B6 · mid-stream at 320px, a checkout sheet whose code cannot load says so, sends NO checkout request, and leaves Stop reachable — the next tap fetches the code again, once it loads the request goes out, and Stop still stops", async ({
  page,
}) => {
  test.setTimeout(budget({ seeds: 1, navs: 2, acts: 22, lives: 1 }) + SLOT_WAIT_MS + TEARDOWN_MS);
  // Pro: going live spends one credit, and "Buy more" shows mid-stream only while at least one is left.
  const { rig, rate } = await planRig(page, "pro");
  expect(rate, "a credit must remain after going live for Buy more to show").toBeGreaterThanOrEqual(2);

  // LIVE, reached through the API (A1 drives the tapped version): a destination, a start, the organiser's poll. The
  // slot first, and the rig registered for teardown BEFORE the start, so a red after it still takes the stream down.
  await streamSlot();
  expect(
    await withDb(async (sql) => (await sql<{ ok: boolean }[]>`select pg_try_advisory_lock(${STREAM_SLOT_KEY}::bigint) as ok`)[0]?.ok),
    "the slot is HELD — a second holder is refused it",
  ).toBe(false);
  liveRigs.push({ request: page.request, orgId: rig.orgId });
  const target = await apiJson<{ id: string }>(page.request, `/api/v1/orgs/${rig.orgId}/stream-targets`, "POST", {
    kind: "youtube",
    label: "B6 channel",
    rtmpUrl: "rtmp://a.rtmp.youtube.com/live2",
    streamKey: `b6-${randomBytes(6).toString("hex")}`,
  });
  expect(target.status, `POST stream-targets -> ${JSON.stringify(target.error)}`).toBeLessThan(300);
  const started = await apiJson(page.request, `/api/v1/fixtures/${rig.fixtureId}/stream-sessions`, "POST", {
    mode: "passthrough",
    targetId: target.data!.id,
  });
  expect(started.status, `POST stream-sessions -> ${JSON.stringify(started.error)}`).toBeLessThan(300);
  await expect
    .poll(
      async () =>
        (await apiJson<{ state: string }>(page.request, `/api/v1/fixtures/${rig.fixtureId}/stream-sessions/current`)).data
          ?.state,
      { timeout: LIVE_MS, intervals: [1_000] },
    )
    .toBe("live");

  await page.setViewportSize({ width: 320, height: 800 });
  await openPhoneTab(page, rig);
  const stop = page.locator('[data-testid="stream-stop"]');
  await expect(stop, "the tab opens on the live session").toBeVisible({ timeout: NAV_MS });
  await expectBalance(page, rate - 1);

  // Block the sheet's code — and only it: any chunk fetched from here on whose body carries the sheet's own marker.
  const blocked: string[] = [];
  const checkoutPosts: string[] = [];
  page.on("request", (req) => {
    if (new URL(req.url()).pathname === "/api/billing/relay-checkout" && req.method() === "POST") checkoutPosts.push(req.url());
  });
  const CHUNKS = "**/_next/static/chunks/**";
  await page.route(CHUNKS, async (route) => {
    const res = await route.fetch();
    const body = await res.body();
    if (body.includes("stream-checkout-modal")) {
      blocked.push(route.request().url());
      return route.abort("failed");
    }
    return route.fulfill({ response: res, body });
  });

  await page.locator('[data-testid="stream-buy-more"]').click();
  const tile = page.locator(`[data-testid="stream-buy-pack-${STREAM_CREDIT_PACKS[0]!.size}"]`);
  await expectTappable(page, tile, "a credit tile");
  await tile.click();
  const error = page.locator('[data-testid="stream-checkout-error"]');
  await expect(error, "the sheet that cannot load says checkout did not open").toHaveText(en("stream.credits.error.unknown"), {
    timeout: NAV_MS,
  });
  expect(blocked.length, "the block must have FIRED — else this proves nothing").toBeGreaterThan(0);
  expect(checkoutPosts, "no code, no Checkout Session (R5a)").toEqual([]);
  // Stop survives it: visible, enabled, and its centre is its own.
  await expect(stop).toBeEnabled();
  await expectTappable(page, stop, "Stop");
  await expect(page.locator('[data-testid="stream-state-pill"]')).toBeVisible();
  await expectNoPageScroll(page);
  await shot(page, "b6-sheet-failed-320.png");

  // The SECOND tap fetches the code again (the loader forgot the failure) — and is refused the same way.
  const firstBlocks = blocked.length;
  await expect(tile, "the purchase lock was freed").toBeEnabled();
  await tile.click();
  await expect.poll(() => blocked.length, { timeout: NAV_MS }).toBeGreaterThan(firstBlocks);
  await expect(error).toBeVisible();
  expect(checkoutPosts, "still no Checkout Session").toEqual([]);

  // The positive half of "no request": with the code reachable again, the same tap DOES ask for a session.
  await page.unroute(CHUNKS);
  const [answered] = await Promise.all([
    page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/billing/relay-checkout" && r.request().method() === "POST",
      { timeout: NAV_MS },
    ),
    tile.click(),
  ]);
  expect(checkoutPosts.length, "the code loaded, so the tap asked for exactly one session").toBe(1);
  if (answered.ok()) {
    // A real key: the sheet opens over the tab. Close it to get back to Stop.
    await expect(page.locator('[data-testid="stream-checkout-modal"]')).toBeVisible({ timeout: NAV_MS });
    await page.getByRole("dialog").getByRole("button", { name: MODAL_CLOSE_LABEL }).click();
    await expect(page.locator('[data-testid="stream-checkout-modal"]')).toHaveCount(0);
  } else {
    // The CI dummy key: Stripe refuses, and the tab says so in the same words.
    await expect(error).toHaveText(en("stream.credits.error.unknown"));
  }

  // And Stop still STOPS — the tap, the confirm, the session leaves the air.
  await stop.click();
  await page.getByRole("alertdialog").getByRole("button", { name: en("stream.phone.stop") }).click();
  await expect(
    page.locator('[data-testid="stream-ending"], [data-testid="stream-ended"]').first(),
    "the tab follows the session off the air",
  ).toBeVisible({ timeout: NAV_MS });
  await expect
    .poll(
      async () =>
        (await withDb(
          (sql) => sql<{ state: string }[]>`
            select state from fixture_stream_sessions where fixture_id = ${rig.fixtureId} order by created_at desc limit 1`,
        ))[0]?.state,
      { timeout: NAV_MS },
    )
    .toMatch(/^(ending|completed)$/);
  await expect(stop).toHaveCount(0, { timeout: NAV_MS });
  await shot(page, "b6-stopped-320.png");
});
