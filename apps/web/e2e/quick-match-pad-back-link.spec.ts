import { test, expect, type Locator, type Page } from "@playwright/test";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { addEntrantsViaApi, apiJson, createStageAndGenerate, expectNoHorizontalScroll, TAG, withDb } from "./helpers";
import { consentedAnonymousState } from "./scorepad-a11y-kit";
import { QUICK_MATCH_SYSTEM_ORG_ID, QUICK_MATCH_SYSTEM_USER_ID } from "../src/lib/quick-match-constants";

// Quick match plan 1, Task 9 (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §4 step 4, C12): the scoring
// pad's way back to its quick match's home, in a real browser at 320, 768 and 1280. What a server render cannot see:
//  - the link is VISIBLE, holds the 44px tap floor and is what a tap at its centre lands on (hit-test, not paint);
//  - the page never scrolls sideways (mobile first);
//  - one element, ordered by width (AGENTS.md phone composition): ABOVE the pad from md up, UNDER it on a phone, so the
//    board keeps its first-screen headroom on a 568px-tall phone.
//
// The seam itself (the real `createQuickMatch`, the real system-user mint, the real page) is proven in
// src/app/score/[token]/__tests__/page.quick-match.test.tsx. Plan 1 has no route that creates a quick match (plan 2 adds
// `/play` and `/q/[token]`), so this spec builds the fixture with the organiser API's real producers (create, generate,
// start, mint) and then hands that tree to the quick match system org in one SQL transaction, with a `quick_matches` row
// whose home token is sealed the way the server seals it. The click itself is plan 2's: `/q/[token]` does not exist yet.
//
// Sport: badminton (a rally pad, the spec's own example). The link reads the org and the quick_matches row, never the sport.

const KEK_HEX = /^[0-9a-f]{64}$/i;

/** The server's envelope, byte for byte (src/server/relay/crypto.ts `sealWith`; the runner cannot import a `server-only`
 *  module, as e2e/lichess-token-seal.ts says): [0x01][wrap IV 12][wrapped DEK 32][wrap tag 16][data IV 12][data tag 16]
 *  [body], AES-256-GCM, under DEVICE_LINK_KEK, which CI sets to one value for the runner and the server. */
function sealHomeTokenForE2e(plain: string): Buffer {
  const hex = process.env.DEVICE_LINK_KEK ?? "";
  if (!KEK_HEX.test(hex)) {
    throw new Error(
      "sealHomeTokenForE2e: DEVICE_LINK_KEK must be 64 hex characters, and the SAME value the server under test runs with; " +
        "otherwise the server cannot open the home token and the pad (rightly) renders no back link",
    );
  }
  const dek = randomBytes(32);
  const dataIv = randomBytes(12);
  const data = createCipheriv("aes-256-gcm", dek, dataIv);
  const body = Buffer.concat([data.update(plain, "utf8"), data.final()]);
  const dataTag = data.getAuthTag();
  const wrapIv = randomBytes(12);
  const wrap = createCipheriv("aes-256-gcm", Buffer.from(hex, "hex"), wrapIv);
  const wrapped = Buffer.concat([wrap.update(dek), wrap.final()]);
  const wrapTag = wrap.getAuthTag();
  return Buffer.concat([Buffer.from([0x01]), wrapIv, wrapped, wrapTag, dataIv, dataTag, body]);
}

/** Is `el`'s centre the thing a tap lands on (the element itself or one of its children)? Scrolled to the middle of
 *  the viewport first, as run-sheet.spec.ts does: `elementFromPoint` is VIEWPORT-relative and returns null for anything
 *  below the fold, and on a 320x568 phone the link sits under the pad, below the fold. */
async function hitTestable(el: Locator): Promise<boolean> {
  return el.evaluate((node) => {
    node.scrollIntoView({ block: "center" });
    const r = node.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && (hit === node || node.contains(hit));
  });
}

async function boxOf(page: Page, el: Locator, what: string) {
  const box = await el.boundingBox();
  expect(box, `${what} has a box at ${page.viewportSize()!.width}`).not.toBeNull();
  return box!;
}

test("quick match pad (C12): the way back is visible, hit-testable and 44px tall, above the pad from md up and under it on a phone, no horizontal scroll", async ({
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  // The organiser's real producers: a private badminton league of two, generated and started, and its pad link.
  const comp = await apiJson<{ id: string }>(request, "/api/v1/competitions", "POST", {
    ends_on: "2030-12-31",
    name: `QM back link ${TAG}`,
    visibility: "private",
  });
  expect(comp.status, `competition: ${JSON.stringify(comp.error)}`).toBeLessThan(300);
  const competitionId = comp.data!.id;
  const div = await apiJson<{ id: string }>(request, `/api/v1/competitions/${competitionId}/divisions`, "POST", {
    name: "Quick match",
    sport_key: "badminton",
    variant_key: "bwf",
  });
  expect(div.status, `division: ${JSON.stringify(div.error)}`).toBeLessThan(300);
  // Realistic long names: a short one hides a wrap (AGENTS.md phone composition, `truncate` / `min-w-0`).
  const added = await addEntrantsViaApi(request, div.data!.id, [`Alexandria Konstantinopoulou ${TAG}`, `Maximiliano Wolfeschlegel ${TAG}`]);
  expect(added.ids).toHaveLength(2);
  const { fixtureIds } = await createStageAndGenerate(request, div.data!.id, { kind: "league", name: "League" });
  expect(fixtureIds).toHaveLength(1);
  const started = await apiJson(request, `/api/v1/divisions/${div.data!.id}/start`, "POST");
  expect(started.status, `start: ${JSON.stringify(started.error)}`).toBeLessThan(300);
  const fixtureId = fixtureIds[0]!;
  const minted = await apiJson<{ secret: string }>(request, `/api/v1/fixtures/${fixtureId}/device-links`, "POST", {
    label: "quick match back link",
  });
  expect(minted.status, JSON.stringify(minted.error)).toBe(201);
  const secret = minted.data!.secret;

  // Hand the tree to the system org, as `createQuickMatch` would have built it there, issued by the system user; then the
  // quick match's own row, its home token stored the C19 way (sha256 hex + sealed envelope). Private, never discoverable (C7).
  const homeToken = `qm_${randomBytes(32).toString("base64url")}`;
  const divisionId = div.data!.id;
  await withDb(async (sql) => {
    await sql.begin(async (tx) => {
      const org = QUICK_MATCH_SYSTEM_ORG_ID;
      await tx`update competitions set org_id = ${org}, visibility = 'private', discoverable = false where id = ${competitionId}`;
      await tx`update divisions set org_id = ${org} where id = ${divisionId}`;
      await tx`update stages set org_id = ${org} where division_id = ${divisionId}`;
      await tx`update entrants set org_id = ${org} where division_id = ${divisionId}`;
      await tx`update fixtures set org_id = ${org} where division_id = ${divisionId}`;
      await tx`update division_events set org_id = ${org} where division_id = ${divisionId}`;
      await tx`update standings_snapshots set org_id = ${org} where stage_id in (select id from stages where division_id = ${divisionId})`;
      await tx`update match_states set org_id = ${org} where fixture_id = ${fixtureId}`;
      const moved = await tx`update device_links set org_id = ${QUICK_MATCH_SYSTEM_ORG_ID}, issued_by = ${QUICK_MATCH_SYSTEM_USER_ID}
                             where fixture_id = ${fixtureId} returning id`;
      expect(moved.length, "the pad's link moved with its fixture").toBe(1);
      await tx`insert into quick_matches (org_id, competition_id, name, format, token_hash, token_enc, visitor_hash, expires_at)
               values (${QUICK_MATCH_SYSTEM_ORG_ID}, ${competitionId}, ${`QM back link ${TAG}`}, 'league',
                       ${createHash("sha256").update(homeToken, "utf8").digest("hex")}, ${sealHomeTokenForE2e(homeToken)},
                       ${createHash("sha256").update(`e2e-visitor-${TAG}`, "utf8").digest("hex")}, now() + interval '7 days')`;
    });
  });

  // A guest's phone: no session, cookie prompt answered.
  const ctx = await browser.newContext({ storageState: await consentedAnonymousState() });
  let checked = 0;
  try {
    const page = await ctx.newPage();
    for (const viewport of [
      { width: 320, height: 568 },
      { width: 768, height: 1024 },
      { width: 1280, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(`/score/${secret}`, { waitUntil: "load" });
      // The accessible name is the label alone: the arrow is aria-hidden.
      const link = page.getByRole("link", { name: "Back to the quick match", exact: true });
      await expect(link, `the way back at ${viewport.width}`).toBeVisible({ timeout: 20_000 });
      await expect(link).toHaveAttribute("href", `/q/${homeToken}`);
      // The href holds the home token, a capability: PostHog must not autocapture it (pre-flight B9).
      await expect(link).toHaveClass(/(^|\s)ph-no-capture(\s|$)/);
      // The pad itself: the element the page renders right after the link (DeviceScorePad's root).
      const pad = link.locator("xpath=following-sibling::*[1]");
      await expect(pad.getByTestId("scan-scorebug-line"), "precondition: that sibling is the pad").toBeVisible();
      const [l, p] = [await boxOf(page, link, "the link"), await boxOf(page, pad, "the pad")];
      expect(l.height, `the 44px tap floor at ${viewport.width}`).toBeGreaterThanOrEqual(44);
      expect(await hitTestable(link), `a tap at the link's centre lands on it at ${viewport.width}`).toBe(true);
      if (viewport.width < 768) {
        expect(l.y, `under the pad on a ${viewport.width}px phone: the board keeps its headroom`).toBeGreaterThanOrEqual(p.y + p.height);
      } else {
        expect(l.y + l.height, `above the pad at ${viewport.width}`).toBeLessThanOrEqual(p.y);
      }
      await expectNoHorizontalScroll(page);
      checked++;
    }
    // The click itself, in a real browser: the link's handler asks the mounted pads to send what they hold (none here:
    // the Confirm card mounts no pad) and then navigates to the home. `/q/[token]` is plan 2's route, so what loads
    // there is not this spec's question; that the browser GOES there is (a handler that swallowed the click would
    // strand the guest on the pad). The held-point sequence is proven through the real pipeline hook in
    // src/components/v2/__tests__/quick-match-back-link.test.tsx.
    await page.getByRole("link", { name: "Back to the quick match", exact: true }).click();
    await page.waitForURL((url) => url.pathname === `/q/${homeToken}`, { timeout: 15_000 });
  } finally {
    await ctx.close();
    await withDb((sql) => sql`delete from competitions where id = ${competitionId} and org_id = ${QUICK_MATCH_SYSTEM_ORG_ID}`);
  }
  expect(checked, "anti-vacuity: every width was checked").toBe(3);
});
