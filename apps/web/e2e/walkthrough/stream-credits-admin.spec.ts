// Streaming R1, Task 7A (owner ruling 15; Revision 4 — the OPTION-B panel, owner's word "B",
// 2026-09-27) — the staff "Match credits" panel on /admin/orgs/[id], driven through the REAL page
// and the REAL route. Without this panel Task 7's grantCredits / refundCredits / revokeCredits have
// no production caller (AGENTS.md class 1); this spec is the seam's producer→consumer proof: a
// click → the modal → the route → Task 7's ledger row and audit row → the server re-read → the
// DOM, including the page's own Adjustments log.
//
// OPTION B's shape, which every step below depends on: the closed panel is a balance, ONE "Adjust
// credits" button and the ledger rail. The kind, amount, note and (refund only) session live in a
// Modal that opens on that button. A resolved submission CLOSES the modal; a FAILED one keeps it
// open with its message inside, which is what makes the lost-response retry drivable at all.
//
// Every user and org is minted fresh by SQL. The staff bit is never borrowed from the shared Pro
// user (billing-states.spec.ts must restore that one in afterEach), so nothing here can leak into
// another spec and the tests run fully parallel. A refund ADDS credits and a revoke removes them
// (Task 7): grant 1, refund 1, refund 1, revoke 1 reads 1 → 2 → 3 → 2.
import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { TAG, expectNoHorizontalScroll, overflowingIn } from "../helpers";
import { signInAs } from "../overlay-kit";

/** helpers.ts's withDb is module-private — the settings-admin.spec.ts local copy, same shape. */
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

interface Rig { orgId: string; orgName: string; userEmail: string; userId: string }

const minted: string[] = [];

/** A fresh user (staff at `role`, a plain user when null) and a fresh target org the user is NOT a member of. */
async function seedRig(role: "support" | "superadmin" | null): Promise<Rig> {
  const tag = `${TAG}-${randomBytes(4).toString("hex")}`;
  const userEmail = `delivered+sca-${tag}@resend.dev`;
  minted.push(userEmail);
  return withDb(async (sql) => {
    const [{ id: userId }] = await sql<{ id: string }[]>`
      insert into users (email, display_name, email_verified, is_staff, staff_role)
      values (${userEmail}, ${"Credits Staff " + tag}, true, ${role !== null}, ${role}) returning id`;
    const orgName = "Credits Org " + tag;
    // overlay-kit.ts's organizations insert shape (status 'active'); the staff user is NOT a member.
    const [{ id: orgId }] = await sql<{ id: string }[]>`
      insert into organizations (name, slug, status)
      values (${orgName}, ${"sca-org-" + tag}, 'active') returning id`;
    return { orgId, orgName, userEmail, userId };
  });
}

/** A real stream session in `rig`'s org that CONSUMED one credit, plus the purchase that funded
 *  it — the precondition a LINKED refund needs (review M4).
 *
 *  By SQL, because it cannot be anything else here: the vitest rig
 *  (server/relay/__tests__/_session-rig.ts) and Task 7's own `consumeForSession` both sit behind
 *  `import "server-only"`, which only vitest aliases away (vitest.config.ts:178-179) — a Playwright
 *  spec that imports such a module collects ZERO tests (e2e/price-kit.ts:160-177).
 *
 *  The consume row is what makes the refund legal at all: stream-credits.ts:265-272 caps a linked
 *  refund at what THAT session consumed, so without it the modal's submit is a 422
 *  refund_exceeds_consumed rather than the 200 this case exists to drive. `fixture_id` is null and
 *  the admission snapshot columns (sport_key / competition_id / division_id, V410:199-201) carry no
 *  FKs, so no fixture, division or competition is needed to make a session row legal. */
async function consumedSession(rig: Rig): Promise<string> {
  return withDb(async (sql) => {
    const [{ id: targetId }] = await sql<{ id: string }[]>`
      insert into org_stream_targets (org_id, kind, label, rtmp_enc)
      values (${rig.orgId}, 'youtube', 'Walkthrough rig', ${Buffer.from("not-a-real-envelope")}) returning id`;
    const [{ id: sessionId }] = await sql<{ id: string }[]>`
      insert into fixture_stream_sessions (org_id, mode, state, target_id, created_by,
                                           sport_key, competition_id, division_id, entitlement_via_override)
      values (${rig.orgId}, 'passthrough', 'completed', ${targetId}, ${rig.userId},
              'badminton', gen_random_uuid(), gen_random_uuid(), false) returning id`;
    await sql`insert into org_stream_credits (org_id, delta, reason, balance_after, note)
              values (${rig.orgId}, 1, 'purchase', 1, 'walkthrough: the pack that funded it')`;
    await sql`insert into org_stream_credits (org_id, delta, reason, session_id, balance_after, note)
              values (${rig.orgId}, -1, 'consume', ${sessionId}, 0, 'walkthrough: the stream that failed')`;
    return sessionId;
  });
}

type LedgerRow = { reason: string; delta: number; balance_after: number; note: string | null; created_by: string | null; session_id: string | null };
const ledgerSql = (orgId: string) =>
  withDb(async (sql) => [
    ...(await sql<LedgerRow[]>`
      select reason, delta, balance_after, note, created_by, session_id
        from org_stream_credits where org_id = ${orgId} order by created_at`),
  ]);
const auditSql = (orgId: string) =>
  withDb(async (sql) => [
    ...(await sql<{ actor_id: string; action: string }[]>`
      select actor_id, action from staff_audit_log where target_id = ${orgId} order by created_at`),
  ]);

const shot = (page: Page, name: string) =>
  page.screenshot({ path: join(process.env.VISUAL_DIR ?? test.info().outputDir, name), fullPage: true });

/** Open the modal and assert what it OPENS AT — every time, not just the first (AGENTS.md class
 *  19, and mutant M1: a panel that reopened a dirty form would pass an assertion made once). */
async function openAdjust(page: Page): Promise<void> {
  const panel = page.getByTestId("stream-credits-panel");
  await panel.getByTestId("stream-credits-adjust").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("stream-credits-kind")).toHaveValue("grant");
  await expect(page.getByTestId("stream-credits-amount")).toHaveValue("1");
  await expect(page.getByTestId("stream-credits-note")).toHaveValue("");
  // The session field is a REFUND's, so a freshly opened modal does not carry it at all.
  await expect(page.getByTestId("stream-credits-session")).toHaveCount(0);
  await expect(page.getByTestId("stream-credits-submit")).toBeDisabled();
  await expect(page.getByTestId("stream-credits-cancel")).toBeVisible();
}

// afterAll runs on a timeout; an in-test finally does not.
test.afterAll(async () => {
  if (minted.length) await withDb((sql) => sql`update users set is_staff = false, staff_role = null where email = any(${minted})`);
});

test("staff grant, refund and revoke through the real Adjust-credits modal — a grant the server applied but the browser lost, retried with a double-click, replays its key (ONE row); a refund the server applied but the browser lost, EDITED and resubmitted, is a 409 that resets the modal and shows what landed, and the next refund gets a NEW key; a revoke above the balance is refused in the modal; the bodies are what the route expects; every row and audit row is the staff user's", async ({ page }) => {
  test.setTimeout(180_000);
  const rig = await seedRig("support");   // support suffices: the route's guard is requireStaff
  const path = `/api/admin/orgs/${rig.orgId}/stream-credits`;
  const posts: Record<string, unknown>[] = [];
  const lose = new Set<string>(["grant", "refund"]);
  // Every panel POST passes through here, so the BODIES are pinned. The FIRST grant and the FIRST
  // refund each reach the server (route.fetch) and their responses are then thrown away
  // (route.abort): the server applied them and the browser saw a network failure, which is
  // exactly the retry the key exists for.
  await page.route(`**${path}`, async (route) => {
    const req = route.request();
    if (req.method() !== "POST") return route.continue();
    const body = JSON.parse(req.postData() ?? "null") as Record<string, unknown>;
    posts.push(body);
    if (lose.delete(String(body.kind))) {
      await route.fetch();
      return route.abort("connectionreset");
    }
    return route.continue();
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await signInAs(page, rig.userEmail);
  await page.goto(`/admin/orgs/${rig.orgId}`);
  // The PAGE rendered for this bare org (page.tsx's <h1>{org.name}</h1>) — so the pre-mount red
  // (Step 15) is "no panel", never a page that crashed on an org with no plan, members or wallet.
  await expect(page.getByRole("heading", { level: 1, name: rig.orgName })).toBeVisible({ timeout: 30_000 });

  const panel = page.getByTestId("stream-credits-panel");
  const balance = panel.getByTestId("stream-credits-balance");
  const rows = panel.getByTestId("stream-credits-row");
  const error = page.getByTestId("stream-credits-error");        // inside the dialog
  const replayed = panel.getByTestId("stream-credits-replayed"); // in the panel, after the close
  await expect(balance).toHaveText("0", { timeout: 30_000 });
  await expect(panel.getByTestId("stream-credits-empty")).toBeVisible();
  // CLOSED means closed: none of the modal's controls exist until the opener is clicked. This is
  // the assertion that makes every "opens at" claim below non-vacuous.
  for (const id of ["stream-credits-kind", "stream-credits-amount", "stream-credits-note", "stream-credits-submit"]) {
    await expect(page.getByTestId(id), id).toHaveCount(0);
  }

  // 1. Grant 1: the server applies it, the browser loses the answer. The modal STAYS OPEN with the
  //    message inside it and the fields untouched — that is what a retry needs.
  await openAdjust(page);
  await page.getByTestId("stream-credits-note").fill("e2e: pilot grant");
  await expect(page.getByTestId("stream-credits-submit")).toBeEnabled();   // the note gate's OPEN direction
  await page.getByTestId("stream-credits-submit").click();
  await expect(error).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("dialog")).toBeVisible();                     // a failure does not close it
  await expect(page.getByTestId("stream-credits-note")).toHaveValue("e2e: pilot grant");
  await expect(balance).toHaveText("0");
  await expect.poll(async () => (await ledgerSql(rig.orgId)).length, { timeout: 15_000 }).toBe(1);   // the server DID apply it

  // 2. Retry with a DOUBLE-click, same open modal: ONE request carrying the SAME key →
  //    applied:false, still one row, and the modal closes on the resolved answer.
  await page.getByTestId("stream-credits-submit").dblclick();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
  await expect(replayed).toBeVisible();
  await expect(balance).toHaveText("1", { timeout: 30_000 });
  await expect(rows).toHaveCount(1);
  await expect(error).toHaveCount(0);

  // 3. Refund 1 with no session: a NEW open, so a NEW key. The server applies it (a refund ADDS),
  //    the browser loses the answer. `openAdjust` re-asserts the opening values (M1).
  await openAdjust(page);
  await expect(replayed).toHaveCount(0);                                    // opening clears the notice
  await page.getByTestId("stream-credits-kind").selectOption("refund");
  await expect(page.getByTestId("stream-credits-session")).toHaveValue("");  // the refund-only field appeared, empty
  await page.getByTestId("stream-credits-note").fill("e2e: failed stream refund");
  await page.getByTestId("stream-credits-submit").click();
  await expect(error).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("stream-credits-note")).toHaveValue("e2e: failed stream refund");
  await expect(balance).toHaveText("1");
  await expect.poll(async () => (await ledgerSql(rig.orgId)).length, { timeout: 15_000 }).toBe(2);   // the server DID apply it

  // 4. The staff user EDITS the amount before retrying: the SAME key with a different delta is
  //    Task 7's 409 idempotency_key_reused. The modal drops its key and resets to its OPENING
  //    state — kind back to grant, so the session field goes away and the action is re-chosen
  //    deliberately (deviation f) — the page re-reads, and the ledger shows the refund of 1 that
  //    landed, not the 2 that was typed.
  await page.getByTestId("stream-credits-amount").fill("2");
  await page.getByTestId("stream-credits-submit").click();
  await expect(error).toContainText("already landed", { timeout: 30_000 });
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(balance).toHaveText("2", { timeout: 30_000 });   // router.refresh() on the 409 (K4)
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveAttribute("data-reason", "refund");   // newest first
  await expect(rows.first()).toHaveAttribute("data-delta", "1");
  await expect(page.getByTestId("stream-credits-kind")).toHaveValue("grant");
  await expect(page.getByTestId("stream-credits-amount")).toHaveValue("1");
  await expect(page.getByTestId("stream-credits-note")).toHaveValue("");
  await expect(page.getByTestId("stream-credits-session")).toHaveCount(0);
  await expect(page.getByTestId("stream-credits-submit")).toBeDisabled();
  await expect(replayed).toHaveCount(0);
  expect(await ledgerSql(rig.orgId)).toHaveLength(2);   // the 409 wrote nothing

  // 5. A new, deliberate refund of 1 from the reset modal: the key was dropped, so `submit` mints
  //    a fresh one (K3) and it APPLIES — 2 → 3, no notice, no error.
  await page.getByTestId("stream-credits-kind").selectOption("refund");
  await page.getByTestId("stream-credits-note").fill("e2e: a second, deliberate refund");
  await page.getByTestId("stream-credits-submit").click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
  await expect(balance).toHaveText("3", { timeout: 30_000 });
  await expect(rows).toHaveCount(3);
  await expect(replayed).toHaveCount(0);
  await expect(error).toHaveCount(0);

  // 6. Revoke 1: 3 → 2, a NEGATIVE row.
  await openAdjust(page);
  await page.getByTestId("stream-credits-kind").selectOption("revoke");
  await expect(page.getByTestId("stream-credits-session")).toHaveCount(0);   // revoke has no session either
  await page.getByTestId("stream-credits-note").fill("e2e: reverse one");
  await page.getByTestId("stream-credits-submit").click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
  await expect(balance).toHaveText("2", { timeout: 30_000 });
  await expect(rows).toHaveCount(4);
  await expect(rows.first()).toHaveAttribute("data-reason", "revoke");
  await expect(rows.first()).toHaveAttribute("data-delta", "-1");

  // 7. Revoke 5 of 2: Task 7's 422 insufficient_credits, shown IN the modal; nothing moves.
  await openAdjust(page);
  await page.getByTestId("stream-credits-kind").selectOption("revoke");
  await page.getByTestId("stream-credits-amount").fill("5");
  await page.getByTestId("stream-credits-note").fill("e2e: too many");
  await page.getByTestId("stream-credits-submit").click();
  await expect(error).toContainText("below zero", { timeout: 30_000 });
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(balance).toHaveText("2");
  await expect(rows).toHaveCount(4);
  await page.getByTestId("stream-credits-cancel").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Persistence through the READ path, not client state, and the page's OWN Adjustments log reading
  // Task 7's audit rows (allowlisted there, so no page edit was needed).
  await page.reload();
  await expect(balance).toHaveText("2", { timeout: 30_000 });
  await expect(rows).toHaveCount(4);
  const log = page.getByRole("region", { name: "Adjustments log" });
  for (const [label, n] of [["Match credits granted", 1], ["Match credits refunded", 2], ["Match credits revoked", 1]] as const) {
    await expect(log.getByText(label, { exact: true }), label).toHaveCount(n);
  }

  expect(await ledgerSql(rig.orgId)).toEqual([
    { reason: "grant", delta: 1, balance_after: 1, note: "e2e: pilot grant", created_by: rig.userId, session_id: null },
    { reason: "refund", delta: 1, balance_after: 2, note: "e2e: failed stream refund", created_by: rig.userId, session_id: null },
    { reason: "refund", delta: 1, balance_after: 3, note: "e2e: a second, deliberate refund", created_by: rig.userId, session_id: null },
    { reason: "revoke", delta: -1, balance_after: 2, note: "e2e: reverse one", created_by: rig.userId, session_id: null },
  ]);
  expect(await auditSql(rig.orgId)).toEqual([
    { actor_id: rig.userId, action: "stream_credit_grant" },
    { actor_id: rig.userId, action: "stream_credit_refund" },
    { actor_id: rig.userId, action: "stream_credit_refund" },
    { actor_id: rig.userId, action: "stream_credit_revoke" },
  ]);
  // The request BODIES, pinned: a client that normalised a field would hide the server's guard, and
  // a double-click that sent twice would make eight. Each retry carries its LOST attempt's key (the
  // edited refund included: that is what the 409 compares); every other submission has its own.
  // Note `session_id` appears on the refund bodies ONLY — the route's body is a strict
  // discriminated union and a grant carrying one is a 400.
  expect(posts.map((b) => ({ ...b, idempotency_key: undefined }))).toEqual([   // toEqual skips undefined keys
    { kind: "grant", delta: 1, note: "e2e: pilot grant" },                                    // 0 lost
    { kind: "grant", delta: 1, note: "e2e: pilot grant" },                                    // 1 exact replay
    { kind: "refund", delta: 1, session_id: null, note: "e2e: failed stream refund" },          // 2 lost
    { kind: "refund", delta: 2, session_id: null, note: "e2e: failed stream refund" },          // 3 edited → 409
    { kind: "refund", delta: 1, session_id: null, note: "e2e: a second, deliberate refund" },   // 4 new key
    { kind: "revoke", delta: 1, note: "e2e: reverse one" },                                   // 5
    { kind: "revoke", delta: 5, note: "e2e: too many" },                                      // 6 → 422
  ]);
  for (const b of posts) expect(String(b.idempotency_key)).toMatch(/^[\w-]{8,200}$/);
  expect(posts[1]!.idempotency_key).toBe(posts[0]!.idempotency_key);
  expect(posts[3]!.idempotency_key).toBe(posts[2]!.idempotency_key);
  expect(new Set([1, 3, 4, 5, 6].map((i) => posts[i]!.idempotency_key)).size).toBe(5);
  await shot(page, "stream-credits-flow-1280.png");
});

/** PAGE-level horizontal scroll is claimed only where the page's own baseline is clean.
 *
 *  Measured on this branch BEFORE the panel was mounted (plan Step 15), so nothing below is this
 *  task's: at 320px `/admin/orgs/[id]` already overflows the viewport, and the offender is the
 *  `/admin` LAYOUT header — `app/admin/layout.tsx:13` is `flex items-center gap-6` with no wrap,
 *  and its right-hand identity row (`:31-37`: `<span>{staff.display_name}</span>` + the role badge
 *  + "← App") cannot fit beside "Staff Console" and the twelve-link nav. The overhang scales with
 *  the signed-in staff member's display name (8px for a short one, 49px for this spec's seeded
 *  name). 768 and 1280 measured CLEAN in the same pre-mount run.
 *
 *  The layout is outside this task's files, so the finding is routed to the orchestrator rather
 *  than patched here (RULES.md: fix inline unless the blast radius widens). The PANEL-scoped
 *  `overflowingIn` claims below run at EVERY width, closed and open — they are what this task owes. */
const PAGE_LEVEL_CLEAN_WIDTHS = new Set<number>([768, 1280]);

for (const width of [320, 768, 1280] as const) {
  test(`at ${width}px with ledger rows present: no horizontal page scroll closed OR with the Adjust-credits modal open, nothing clipped inside the panel, and its only closed-state scroller is the focusable ledger rail`, async ({ page }) => {
    test.setTimeout(120_000);
    const rig = await seedRig("superadmin");
    await page.setViewportSize({ width, height: 900 });
    await signInAs(page, rig.userEmail);
    // Two real rows through the REAL route (this context's staff cookie), one with a note that must wrap.
    const key = () => `e2e-${randomBytes(8).toString("hex")}`;
    for (const data of [
      { kind: "grant", delta: 5, note: `e2e: ${"a long pilot-league note that has to wrap ".repeat(6)}`, idempotency_key: key() },
      { kind: "revoke", delta: 1, note: "e2e: revoke", idempotency_key: key() },
    ]) {
      const res = await page.request.post(`/api/admin/orgs/${rig.orgId}/stream-credits`, { data });
      expect(res.status(), JSON.stringify(data)).toBe(200);
    }
    await page.goto(`/admin/orgs/${rig.orgId}`);
    // Page-level, measured BEFORE waiting on the panel: on the pre-mount red run (Step 15) this
    // call IS the page's own baseline, so an overflow it names there is attributable without the panel.
    // Skipped at 320, where that baseline is already red on the /admin layout header — see
    // PAGE_LEVEL_CLEAN_WIDTHS above.
    if (PAGE_LEVEL_CLEAN_WIDTHS.has(width)) await expectNoHorizontalScroll(page);
    await expect(page.getByTestId("stream-credits-row")).toHaveCount(2, { timeout: 30_000 });
    // The claim that counts: after the panel painted its rows, the page is no wider than it was.
    if (PAGE_LEVEL_CLEAN_WIDTHS.has(width)) await expectNoHorizontalScroll(page);
    const closed = await overflowingIn(page, '[data-testid="stream-credits-panel"]', "*", "stream-credits-panel is not on the page");
    expect(closed.clipped, `clipped inside the panel at ${width}px`).toEqual([]);
    expect(closed.truncatedByDesign).toEqual([]);
    // Hold the exemption to something: the only reachable overflow in the CLOSED state is the
    // tabindex=0 ledger rail. An overflow whose extra content is reachable is a feature; one
    // inside an overflow-hidden box is a defect, and only computed overflow-x tells them apart
    // (AGENTS.md class 23 — overflowingIn already splits on it).
    for (const s of closed.scrollable) expect(s, `unexpected closed-state scroller at ${width}px`).toMatch(/^div \d+px content in \d+px tabindex=0$/);
    await shot(page, `stream-credits-${width}.png`);

    // The phone bar with the modal OPEN — the state option B puts every control into, and the one
    // a closed-panel scan cannot see at all. The dialog is a DOM descendant of the panel section,
    // so the panel-scoped scan WIDENS here: that is expected, and any new scroller it names must
    // be the dialog's own body (modal.tsx's overflow-y-auto, a Y scroller, so overflowingIn should
    // not report it at all) or the ledger rail. Write down what you saw; never widen the regex to
    // make a new entry pass.
    await page.getByTestId("stream-credits-adjust").click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("stream-credits-note")).toHaveValue("");
    // The phone-bar claim with the modal OPEN, under the SAME pre-existing-baseline guard and for
    // the same reason: the /admin header row that overflows at 320 is there whether the modal is
    // open or not. The panel-scoped scan below is unguarded and carries the width claim at 320.
    if (PAGE_LEVEL_CLEAN_WIDTHS.has(width)) await expectNoHorizontalScroll(page);
    const open = await overflowingIn(page, '[data-testid="stream-credits-panel"]', "*", "stream-credits-panel is not on the page");
    expect(open.clipped, `clipped with the modal open at ${width}px`).toEqual([]);
    expect(open.truncatedByDesign).toEqual([]);
    for (const s of open.scrollable) expect(s, `unexpected modal-open scroller at ${width}px`).toMatch(/tabindex=0$/);
    // Both footer buttons are inside the sheet at this width, not pushed under its edge.
    for (const id of ["stream-credits-cancel", "stream-credits-submit"]) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box, `${id} has no box at ${width}px`).not.toBeNull();
      expect(box!.x + box!.width, `${id} runs past ${width}px`).toBeLessThanOrEqual(width);
    }
    await shot(page, `stream-credits-${width}-modal.png`);
  });
}

test("a LINKED refund driven through the real modal: the session field carries a real session id into the route's refund member, and Task 7's ledger row is STAMPED with that session — the linked-refund path's only producer→consumer proof (review M4)", async ({ page }) => {
  test.setTimeout(120_000);
  const rig = await seedRig("support");
  const sessionId = await consumedSession(rig);
  const posts: Record<string, unknown>[] = [];
  await page.route(`**/api/admin/orgs/${rig.orgId}/stream-credits`, async (route) => {
    const req = route.request();
    if (req.method() === "POST") posts.push(JSON.parse(req.postData() ?? "null") as Record<string, unknown>);
    return route.continue();
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await signInAs(page, rig.userEmail);
  await page.goto(`/admin/orgs/${rig.orgId}`);

  const panel = page.getByTestId("stream-credits-panel");
  const balance = panel.getByTestId("stream-credits-balance");
  const rows = panel.getByTestId("stream-credits-row");
  // The seeded pair is ON SCREEN first: a purchase of 1 spent by a consume of 1, balance 0. The
  // session column is what a staff member copies the id OUT of, so the rail has to be showing it
  // before the refund is typed — this is the read the panel exists to serve.
  await expect(balance).toHaveText("0", { timeout: 30_000 });
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveAttribute("data-reason", "consume");
  await expect(panel.getByText(sessionId, { exact: true })).toBeVisible();

  await openAdjust(page);
  await page.getByTestId("stream-credits-kind").selectOption("refund");
  await page.getByTestId("stream-credits-session").fill(sessionId);
  await page.getByTestId("stream-credits-note").fill("e2e: refund the session that failed");
  await page.getByTestId("stream-credits-submit").click();
  await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("stream-credits-error")).toHaveCount(0);
  await expect(balance).toHaveText("1", { timeout: 30_000 });
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toHaveAttribute("data-reason", "refund");

  // The claim: the row the UI wrote carries THAT session id — not null (the goodwill path the main
  // flow test already covers) and not some other session.
  expect(await ledgerSql(rig.orgId)).toEqual([
    { reason: "purchase", delta: 1, balance_after: 1, note: "walkthrough: the pack that funded it", created_by: null, session_id: null },
    { reason: "consume", delta: -1, balance_after: 0, note: "walkthrough: the stream that failed", created_by: null, session_id: sessionId },
    { reason: "refund", delta: 1, balance_after: 1, note: "e2e: refund the session that failed", created_by: rig.userId, session_id: sessionId },
  ]);
  expect(await auditSql(rig.orgId)).toEqual([{ actor_id: rig.userId, action: "stream_credit_refund" }]);
  // The BODY that carried it: the id typed into the field is what reached the route, untouched.
  expect(posts.map((b) => ({ ...b, idempotency_key: undefined }))).toEqual([
    { kind: "refund", delta: 1, session_id: sessionId, note: "e2e: refund the session that failed" },
  ]);
  await shot(page, "stream-credits-linked-refund-1280.png");
});

test("a signed-in NON-staff user gets neither the route (401, no row) nor the page (redirected away) — the positive pair of the staff test", async ({ page }) => {
  test.setTimeout(60_000);
  const rig = await seedRig(null);
  await signInAs(page, rig.userEmail);
  const res = await page.request.post(`/api/admin/orgs/${rig.orgId}/stream-credits`, {
    data: { kind: "grant", delta: 1, note: "must not land", idempotency_key: `e2e-${randomBytes(8).toString("hex")}` },
  });
  expect(res.status()).toBe(401);
  await page.goto(`/admin/orgs/${rig.orgId}`);
  await page.waitForURL((u) => !u.pathname.startsWith("/admin"), { timeout: 30_000 });   // app/admin/layout.tsx:8-9
  await expect(page.getByTestId("stream-credits-panel")).toHaveCount(0);
  await expect(page.getByTestId("stream-credits-adjust")).toHaveCount(0);
  expect(await ledgerSql(rig.orgId)).toEqual([]);
  expect(await auditSql(rig.orgId)).toEqual([]);
});
