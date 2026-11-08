// R4 sponsors on stream — the edges of the journey (spec 2026-10-27), each read against the code and the spec before it
// was written, so a case states what the PRODUCT does. Where the product differs from what was briefed, the case asserts
// the product's behaviour and the walkthrough report names the difference as a finding (never an encoded bug).
//
//   E1  refused relay input: no / forged / another session's token is 401 and writes nothing; a malformed body is 400; in
//       one beat, another org's card (`sponsor_gone`), a clock 15 min out, and a corrupt break assignment naming another
//       org's sponsor (`foreign_sponsor`) are refused while the good item beside them is written — the beat answers 200
//       with the contract's reply, which carries no refusal count; frames too big, not a JPEG, or of no airing are refused
//       and the next beat on the same connection is answered
//   E6  delete after airings (same org as E1): the Overview keeps the deleted sponsor's showings under "Deleted", its
//       clicks unknown (a dash and "not available"), no Share; its report link is a 404
//   E4  one sponsor ticked rotates alone; a second of the same tier joins the rotation
//   E5  no logo: the card shows the name and its initial; a logo: the image
//   E3  the plan's scope: a competition's sponsor only on its own competition's fixtures; no plan when nothing is ticked or
//       the rotation is switched off (each with its positive control) — and the card leaves the stream
//   E2  dead links: an unknown code, a deleted sponsor's code, a report token one character off — all 404, the report's
//       the same page as a token never issued
//   E7  empty: the hub's three tabs with no sponsor, and a report with no showing
//   E8  a 43-character name in Spanish and Dutch at 320: truncated in its row with the full name in its title, no page scroll
//   E9  a viewer's malformed settings PUT is 403 (the role is checked before the body); the owner's is 400
//   E10 repeat visits: every real GET redirects; a bot's GET redirects uncounted. The 30 s one-visitor dedupe needs Redis,
//       which e2e.yml does not run: skipped LOUDLY there, asserted when REDIS_URL is set. Rate limits: not driven (Redis).
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { expectNoHorizontalScroll, withDb } from "./helpers";
import { seedMemberIdentity, sponsorsUrl } from "./settings-support";
import { FAKE_CONNECT_MS, POLL_WAIT_MS, POOL_SLOT_WAIT_MS, cycleMs, holdsStreamSlot, releaseStreamSlot, takeWholePool } from "./helpers/stream-slot-pool";
import {
  EMPTY_JAR,
  LOOPBACK_HOLD_MS,
  beatOk,
  composedSession,
  compositorPage,
  contractValidator,
  disposeStandInPhones,
  endStandInSession,
  jobTokenFor,
  jpegOf,
  planSponsorIds,
  postBeat,
  previewPlan,
  relayPlan,
  releaseStandInOrg,
  seedStandInFixture,
  seedStandInOrg,
  type StandInOrg,
  type StandInSession,
} from "./helpers/sponsor-relay-standin";
import { SCENE_CAROUSEL_MS } from "../src/lib/sponsor-plan";
import { sponsorClickPath } from "../src/lib/sponsor-clicks";
import { CAROUSEL_STYLE, carouselMomentId } from "../src/components/overlay/sponsor-card";

const dictionary = (locale: string): Record<string, string> =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../src/dictionaries/${locale}/ui.json`, import.meta.url)), "utf8"));
const UI = { en: dictionary("en"), es: dictionary("es"), nl: dictionary("nl") };
const say = (dict: Record<string, string>, key: string): string => {
  const v = dict[key];
  if (v === undefined) throw new Error(`no dictionary entry ${key}`);
  return v;
};

const NAV_MS = 20_000;
const ACT_MS = 5_000;
/** Spec §3.6.4 rule 4: "Times > 10 min from server time are refused." Fifteen is past it by a margin no CI clock eats. */
const SKEWED_MS = 15 * 60_000;
/** A 1 MiB still: past the frame bound by four times (frame.test.ts pins the bound's exact edge at the route). */
const OVERSIZED_FRAME = 1 << 20;
const LOGO_URL = "https://logo.sponsor-edge.example/mark.png";
const LOGO_PNG = readFileSync(fileURLToPath(new URL("../public/apple-touch-icon.png", import.meta.url)));
/** The compositor page's time to show two carousel slots: its ready and a loopback round, then two showings. */
const TWO_SHOWINGS_MS = 2 * LOOPBACK_HOLD_MS + 2 * SCENE_CAROUSEL_MS;
/** The longest a test here holds the stream pool: the session's create and facts, a solo window, a joined window (one
 *  overlay poll, then a showing each), the untick's poll and a showing's end, two plan reads and the end. */
const POOL_HOLD = {
  file: "sponsors-edge-cases.spec.ts",
  holdMs: cycleMs(FAKE_CONNECT_MS) + 2 * TWO_SHOWINGS_MS + 2 * POLL_WAIT_MS + 2 * NAV_MS,
} as const;

const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
/** A code in the minted alphabet at the longest length, so it collides with nothing a run left behind. */
const randomCode = () => Array.from({ length: 8 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join("");
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

async function addSponsor(o: StandInOrg, s: { name: string; url?: string | null; tier?: string; logo_path?: string; competition_id?: string }): Promise<string> {
  const res = await o.page.request.post(`/api/v1/orgs/${o.orgId}/sponsors`, { data: { tier: "partner", ...s } });
  expect(res.status(), `setup: add ${s.name}: ${await res.text()}`).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}
async function tick(o: StandInOrg, id: string, on: boolean): Promise<void> {
  const res = await o.page.request.patch(`/api/v1/orgs/${o.orgId}/sponsors/${id}`, { data: { on_stream: on } });
  expect(res.status(), `setup: on_stream=${on}: ${await res.text()}`).toBe(200);
}
async function shareLink(o: StandInOrg, sponsorId: string): Promise<{ id: string; url: string }> {
  const res = await o.page.request.post(`/api/v1/orgs/${o.orgId}/sponsors/${sponsorId}/report-links`, {
    data: { competitionId: null, from: daysAgo(30), to: today() },
  });
  expect(res.status(), `setup: report link: ${await res.text()}`).toBe(201);
  return ((await res.json()) as { data: { id: string; url: string } }).data;
}
const reportPath = (url: string) => new URL(url).pathname;
const startItem = (momentId: string, cardId: string, atMs: number, over: Record<string, unknown> = {}) => ({
  kind: "start", momentId, cardId, style: CAROUSEL_STYLE, source: "scene", breakKind: null, at: new Date(atMs).toISOString(), ...over,
});

test.describe("with a stream session (holds the stream-slot pool)", () => {
  test.describe.configure({ mode: "serial" });
  const orgs: (StandInOrg | undefined)[] = [];
  const sessions: StandInSession[] = [];
  const reserve = async () => {
    if (!holdsStreamSlot()) await takeWholePool(POOL_HOLD, { creditsKeyWaitMs: 1 });
  };

  test.afterEach(async () => {
    try {
      await disposeStandInPhones();
    } finally {
      try {
        for (const s of sessions.splice(0)) await endStandInSession(s);
      } finally {
        await releaseStreamSlot();
      }
    }
  });
  test.afterAll(async () => {
    for (const o of orgs.splice(0)) await releaseStandInOrg(o);
  });

  test("E1 + E6 refused relay input writes nothing and answers as the contract says; a sponsor deleted after airing keeps its showings", async ({ browser }) => {
    test.setTimeout(POOL_SLOT_WAIT_MS + POOL_HOLD.holdMs + 8 * NAV_MS + 12 * ACT_MS);
    const o = await seedStandInOrg(browser, "spe1");
    orgs.push(o);
    const other = await seedStandInOrg(browser, "spe1x");
    orgs.push(other);
    const fx = await seedStandInFixture(o, { label: `Edge Volley ${o.orgSlug}`, sportKey: "volleyball", variantKey: "indoor", home: "Edge Home VC", away: "Edge Away VC" });
    const ownName = "Tidewater Print Works";
    const own = await addSponsor(o, { name: ownName, url: "https://tidewater-print.example/" });
    const foreign = await addSponsor(other, { name: "Elsewhere Ales", url: "https://elsewhere-ales.example/" });
    const s = await composedSession(o, fx, reserve);
    sessions.push(s);
    const rows = () => withDb((sql) => sql<{ sponsor_id: string | null; moment_id: string }[]>`
      select sponsor_id, moment_id from sponsor_airings where session_id = ${s.sid} order by moment_id`);

    // --- credentials: each refused before anything is read or written (heartbeat route: bearer, then the token) ---------
    const now = Date.now();
    const good = startItem(carouselMomentId("starting", now), own, now);
    const body = { state: "playing", programmePhase: "live", airings: [good] };
    for (const [why, token] of [
      ["no token", null],
      ["a token signed with another secret", await jobTokenFor(s.sid, `not-the-secret-${randomUUID()}`)],
      ["another session's token", await jobTokenFor(randomUUID())],
    ] as const) {
      const res = await postBeat(s, body, { token });
      expect(res.status(), `${why}: ${await res.text()}`).toBe(401);
    }
    expect(await rows(), "no refused credential wrote an airing").toEqual([]);

    // --- malformed bodies, with the real token: the contract refuses them, and so does the route (400, not 422) ---------
    const extraKey = { state: "playing", airings: [{ ...good, viewers: 12 }] };
    expect(contractValidator("heartbeat")(extraKey), "premise: the contract refuses an airing with an extra key").toBe(false);
    const auth = { Authorization: `Bearer ${s.jobToken}` };
    const beatUrl = `/api/internal/relay/sessions/${s.sid}/heartbeat`;
    expect((await s.request.post(beatUrl, { headers: auth, data: extraKey })).status(), "an extra key").toBe(400);
    expect(
      (await s.request.post(beatUrl, { headers: { ...auth, "content-type": "application/json" }, data: Buffer.from('{"state":"playing",') })).status(),
      "a body that is not JSON",
    ).toBe(400);
    expect(await rows(), "no malformed body wrote an airing").toEqual([]);

    // --- one beat, four items: the good one is written, three are refused, the beat is answered ------------------------
    // A corrupt break assignment of THIS org naming the OTHER org's sponsor (the database checks no composite reference).
    const corruptMoment = "900:sponsor.set_end";
    await withDb((sql) => sql`
      insert into sponsor_assignments (fixture_id, moment_id, org_id, seq, sponsor_id, sponsor_name, position, source, break_kind, style, hold_ms)
      values (${fx.fixtureId}, ${corruptMoment}, ${o.orgId}, 900, ${foreign}, 'Elsewhere Ales', null, 'operator', 'set_end', 'banner', 15000)`);
    const reply = await beatOk(
      s,
      {
        state: "playing",
        programmePhase: "live",
        airings: [
          startItem(carouselMomentId("starting", now - SCENE_CAROUSEL_MS), foreign, now - SCENE_CAROUSEL_MS),
          startItem(carouselMomentId("starting", now - SKEWED_MS), own, now - SKEWED_MS),
          startItem(corruptMoment, foreign, now, { source: "operator", breakKind: "set_end", style: "banner" }),
          good,
        ],
        airingsDropped: 2,
      },
      "a beat with three bad items and one good",
    );
    // The reply is the contract's (validated in beatOk): it names no refusal. FINDING: refusals are logged, never counted
    // back; `airingsDropped` is the compositor's own count of items IT dropped, which the server only logs.
    expect(Object.keys(reply).sort(), "the reply carries the desired state, nothing about the airings").toEqual(
      Object.keys(reply).filter((k) => k === "desiredState" || k === "phoneLiveEdge").sort(),
    );
    expect(reply.desiredState).toBe("live");
    expect(await rows(), "only the good item was written").toEqual([{ sponsor_id: own, moment_id: good.momentId }]);
    const foreignAired = await withDb((sql) => sql`select 1 from sponsor_airings where sponsor_id = ${foreign}`);
    expect(foreignAired.length, "the other org's sponsor aired nowhere").toBe(0);

    // --- frames: refused for size, type and moment; the next beat on the same client is answered ----------------------
    const framePost = (momentId: string, data: Buffer, token: string | null = s.jobToken) =>
      s.request.post(`/api/internal/relay/sessions/${s.sid}/airings/${encodeURIComponent(momentId)}/frame`, {
        headers: { ...(token === null ? {} : { Authorization: `Bearer ${token}` }), "content-type": "image/jpeg" },
        data,
      });
    const refusedFrame = async (what: string, res: Awaited<ReturnType<typeof framePost>>, status: number, code: string | null) => {
      expect(res.status(), `${what}: ${await res.text()}`).toBe(status);
      if (code !== null) expect(((await res.json()) as { code?: string }).code, what).toBe(code);
    };
    await refusedFrame("a frame with no token", await framePost(good.momentId, jpegOf(2_048), null), 401, null);
    await refusedFrame("a 1 MiB frame", await framePost(good.momentId, jpegOf(OVERSIZED_FRAME)), 413, "FRAME_TOO_LARGE");
    await refusedFrame("a frame that is not a JPEG", await framePost(good.momentId, Buffer.from("GIF89a-not-a-jpeg")), 415, "FRAME_NOT_JPEG");
    await refusedFrame("a frame of a scene that carries no sponsor", await framePost("scene:nowhere:1", jpegOf(2_048)), 400, "FRAME_MOMENT_INVALID");
    await beatOk(s, { state: "playing", programmePhase: "live" }, "the beat after the refused frames, on the same client");
    const frames = await withDb((sql) => sql`select 1 from sponsor_airing_frames where session_id = ${s.sid}`);
    expect(frames.length, "no refused frame was stored").toBe(0);

    // --- E6: a second showing and a click, a report link, then the sponsor deleted through the hub ---------------------
    await beatOk(s, { state: "playing", programmePhase: "live", airings: [startItem(carouselMomentId("starting", now + SCENE_CAROUSEL_MS), own, now + SCENE_CAROUSEL_MS)] }, "a second showing");
    expect((await rows()).length, "two showings of the sponsor").toBe(2);
    const visitor = await browser.newContext({ storageState: EMPTY_JAR, extraHTTPHeaders: { "fly-client-ip": "198.51.100.61" } });
    try {
      const hop = await visitor.request.get(sponsorClickPath(own, { source: "site" }), { maxRedirects: 0 });
      expect(hop.status(), "the sponsor's link redirects").toBe(302);
    } finally {
      await visitor.close();
    }
    await expect
      .poll(async () => (await withDb((sql) => sql`select 1 from sponsor_clicks where sponsor_id = ${own}`)).length, { timeout: POLL_WAIT_MS })
      .toBe(1);
    const link = await shareLink(o, own);

    const { page } = o;
    await page.goto(sponsorsUrl(o.orgSlug, "sponsors"));
    await page.getByRole("button", { name: say(UI.en, "settings.org.sponsors.remove").replace("{name}", ownName), exact: true }).click();
    await expect(page.getByRole("button", { name: say(UI.en, "settings.org.sponsors.remove").replace("{name}", ownName), exact: true }), "the row is gone").toHaveCount(0);
    await expect.poll(async () => (await withDb((sql) => sql`select 1 from sponsors where id = ${own}`)).length).toBe(0);

    await page.goto(sponsorsUrl(o.orgSlug, "overview"));
    const gone = page.getByTestId(`sponsor-overview-row-gone-${ownName}`);
    await expect(gone, "the deleted sponsor keeps its row").toBeVisible();
    await expect(gone).toContainText(say(UI.en, "sponsors.overview.deleted"));
    await expect(gone.getByTestId("sponsor-overview-times"), "its showings are still counted").toHaveText("2");
    const clicks = gone.getByTestId("sponsor-overview-clicks");
    await expect(clicks.locator('[aria-hidden="true"]'), "its clicks went with it: a dash").toHaveText("—");
    await expect(clicks.locator(".sr-only"), "spoken as not available").toHaveText(say(UI.en, "sponsors.overview.notAvailable"));
    await expect(gone.getByTestId("sponsor-overview-share"), "nothing to share for a deleted sponsor").toHaveCount(0);
    const reader = await browser.newContext({ storageState: EMPTY_JAR });
    try {
      const rp = await reader.newPage();
      expect((await rp.goto(reportPath(link.url)))?.status(), "the deleted sponsor's report link").toBe(404);
      await expect(rp.getByTestId("sponsor-report-not-found")).toBeVisible();
    } finally {
      await reader.close();
    }
  });

  test("E4 + E5 + E3 one sponsor rotates alone, a second of its tier joins, the name stands in for a missing logo — and with nothing ticked the card leaves", async ({ browser }) => {
    test.setTimeout(POOL_SLOT_WAIT_MS + POOL_HOLD.holdMs + 4 * NAV_MS);
    const o = await seedStandInOrg(browser, "spe4");
    orgs.push(o);
    const fx = await seedStandInFixture(o, { label: `Edge Hockey ${o.orgSlug}`, sportKey: "hockey", variantKey: "fih-outdoor", home: "Edge Home HC", away: "Edge Away HC" });
    const plain = { name: "Nomad Coffee Roasters", id: "" };
    const logoed = { name: "Lantern Optics", id: "" };
    plain.id = await addSponsor(o, { name: plain.name, url: "https://nomad-coffee.example/" });
    await tick(o, plain.id, true);
    const s = await composedSession(o, fx, reserve);
    sessions.push(s);
    expect(planSponsorIds(await relayPlan(s)), "one ticked: one card").toEqual([plain.id]);

    const cef = await compositorPage(browser, s, "waiting");
    try {
      await cef.context.route(`${new URL(LOGO_URL).origin}/**`, (r) => r.fulfill({ status: 200, contentType: "image/png", body: LOGO_PNG }));
      const starts = (after?: number) => cef.sponsorLines(after).filter((l) => l.kind === "start");
      // E4 — alone, it fills every slot.
      await expect.poll(() => starts().length, { message: "two showings", timeout: TWO_SHOWINGS_MS }).toBeGreaterThanOrEqual(2);
      expect(new Set(starts().map((l) => l.json.cardId)), "every showing is the one ticked sponsor").toEqual(new Set([plain.id]));
      // E5 — no logo: the name, and its initial where the logo would be.
      const card = cef.page.getByTestId("ovl-sponsor-card");
      await expect(card.locator(".ovl-sponsor-name")).toHaveText(plain.name);
      await expect(card.locator(".ovl-sponsor-mono"), "the name's initial stands in").toHaveText(plain.name.charAt(0).toUpperCase());
      await expect(card.locator("img.ovl-sponsor-logo"), "no broken image").toHaveCount(0);

      // E4 — a second sponsor of the SAME tier, with a logo: both rotate.
      logoed.id = await addSponsor(o, { name: logoed.name, url: "https://lantern-optics.example/", logo_path: LOGO_URL });
      await tick(o, logoed.id, true);
      const joined = cef.mark();
      await expect
        .poll(() => new Set(starts(joined).map((l) => String(l.json.cardId))).size, {
          message: "both sponsors air after the overlay's next poll",
          timeout: POLL_WAIT_MS + TWO_SHOWINGS_MS + SCENE_CAROUSEL_MS,
        })
        .toBe(2);
      // E5 — the logo, painted (the image loaded: a natural width), on the logoed sponsor's card.
      const logo = cef.page.getByTestId("ovl-sponsor-card").filter({ hasText: logoed.name }).locator("img.ovl-sponsor-logo");
      await expect(logo, "the logo shows").toBeVisible({ timeout: 2 * SCENE_CAROUSEL_MS });
      await expect(logo).toHaveAttribute("src", LOGO_URL);
      await expect.poll(() => logo.evaluate((img: HTMLImageElement) => img.naturalWidth, undefined, { timeout: 1_000 }).catch(() => 0), { timeout: ACT_MS }).toBeGreaterThan(0);

      // E3 — untick both: no plan, and the card leaves the stream.
      await tick(o, plain.id, false);
      await tick(o, logoed.id, false);
      expect(await relayPlan(s), "nothing ticked: no plan").toBeNull();
      await expect(cef.page.getByTestId("ovl-sponsor-card"), "the card leaves the stream").toHaveCount(0, { timeout: POLL_WAIT_MS + SCENE_CAROUSEL_MS });
    } finally {
      await cef.context.close();
    }
  });
});

test("E3 the plan's scope: a competition's sponsor only on that competition's fixtures; no plan when nothing is ticked or the rotation is off", async ({ browser }) => {
  test.setTimeout(4 * NAV_MS + 14 * ACT_MS);
  const o = await seedStandInOrg(browser, "spe3");
  try {
    const fxA = await seedStandInFixture(o, { label: `Scope A ${o.orgSlug}`, sportKey: "volleyball", variantKey: "indoor", home: "Scope A1", away: "Scope A2" });
    const fxB = await seedStandInFixture(o, { label: `Scope B ${o.orgSlug}`, sportKey: "volleyball", variantKey: "indoor", home: "Scope B1", away: "Scope B2" });
    expect(fxA.competitionId, "premise: two competitions").not.toBe(fxB.competitionId);
    const everywhere = await addSponsor(o, { name: "Everywhere Bakery", url: "https://everywhere-bakery.example/" });
    const scoped = await addSponsor(o, { name: "Only-A Motors", url: "https://only-a-motors.example/", competition_id: fxA.competitionId });
    const plan = async (fixtureId: string) => planSponsorIds(await previewPlan(o.page.request, fixtureId));

    expect(await previewPlan(o.page.request, fxA.fixtureId), "a fresh org (no tick, no rotation): no plan — null, not an empty one").toBeNull();
    await tick(o, everywhere, true);
    await tick(o, scoped, true);
    expect(await plan(fxA.fixtureId), "competition A: both").toEqual([everywhere, scoped].sort());
    expect(await plan(fxB.fixtureId), "competition B: never A's sponsor").toEqual([everywhere]);

    // Switched off (the org-wide rotation row the first tick created): no plan anywhere; on again: back.
    const put = (enabled: boolean) =>
      o.page.request.put(`/api/v1/orgs/${o.orgId}/sponsor-stream-settings`, { data: { competitionId: null, enabled, frequency: "normal" } });
    expect((await put(false)).status()).toBe(200);
    expect(await previewPlan(o.page.request, fxA.fixtureId), "rotation off: no plan").toBeNull();
    expect((await put(true)).status()).toBe(200);
    expect(await plan(fxA.fixtureId), "positive control: on again, the plan is back").toEqual([everywhere, scoped].sort());
    await tick(o, everywhere, false);
    await tick(o, scoped, false);
    expect(await previewPlan(o.page.request, fxB.fixtureId), "every tick removed: no plan").toBeNull();
  } finally {
    await releaseStandInOrg(o);
  }
});

test("E2 dead links: an unknown code, a deleted sponsor's code and a report token one character off are all 404", async ({ browser }) => {
  test.setTimeout(6 * NAV_MS + 10 * ACT_MS);
  const o = await seedStandInOrg(browser, "spe2");
  const visitor = await browser.newContext({ storageState: EMPTY_JAR });
  try {
    const id = await addSponsor(o, { name: "Shortlived Kites", url: "https://shortlived-kites.example/" });
    // A short code as S5 mints them (setup: the minting door is driven by the journey's J3).
    const code = randomCode();
    const unknown = randomCode();
    const taken = await withDb((sql) => sql`select 1 from sponsor_short_codes where code in (${code}, ${unknown})`);
    expect(taken.length, "premise: both codes are free").toBe(0);
    await withDb((sql) => sql`insert into sponsor_short_codes (code, org_id, sponsor_id) values (${code}, ${o.orgId}, ${id})`);
    const go = (path: string) => visitor.request.get(path, { maxRedirects: 0 });
    expect((await go(`/s/${code}`)).status(), "positive control: the live code redirects").toBe(302);
    expect((await go(`/s/${unknown}`)).status(), "a code never issued").toBe(404);
    const del = await o.page.request.delete(`/api/v1/orgs/${o.orgId}/sponsors/${id}`);
    expect(del.ok(), `delete: ${del.status()}`).toBe(true);
    expect((await go(`/s/${code}`)).status(), "the deleted sponsor's code (its row cascaded)").toBe(404);

    const live = await addSponsor(o, { name: "Steady Kites", url: "https://steady-kites.example/" });
    const link = await shareLink(o, live);
    const path = reportPath(link.url);
    const token = path.split("/").pop()!;
    const flip = token[10] === "A" ? "B" : "A";
    const tampered = path.replace(token, `${token.slice(0, 10)}${flip}${token.slice(11)}`);
    const never = path.replace(token, "N".repeat(token.length));
    const vp = await visitor.newPage();
    expect((await vp.goto(path))?.status(), "positive control: the issued token opens").toBe(200);
    await expect(vp.getByTestId("sponsor-report")).toBeVisible();
    expect((await vp.goto(tampered))?.status(), "one character off").toBe(404);
    const tamperedPage = await vp.getByTestId("sponsor-report-not-found").innerHTML();
    expect((await vp.goto(never))?.status(), "a token never issued").toBe(404);
    expect(await vp.getByTestId("sponsor-report-not-found").innerHTML(), "the same page: nothing tells a near miss from a guess").toBe(tamperedPage);
  } finally {
    await visitor.close();
    await releaseStandInOrg(o);
  }
});

test("E7 empty states: the hub with no sponsor, and a report with no showing", async ({ browser }) => {
  test.setTimeout(6 * NAV_MS + 8 * ACT_MS);
  const o = await seedStandInOrg(browser, "spe7");
  const reader = await browser.newContext({ storageState: EMPTY_JAR });
  try {
    const { page } = o;
    await page.goto(sponsorsUrl(o.orgSlug, "overview"));
    const empty = page.getByTestId("sponsor-overview-empty");
    await expect(empty).toContainText(say(UI.en, "sponsors.overview.empty"));
    await expect(page.getByTestId("sponsor-overview-share"), "nothing to share").toHaveCount(0);
    await empty.getByTestId("sponsor-overview-empty-link").click();
    await expect(page.getByTestId("sponsors-tab-sponsors"), "the empty Overview leads to Sponsors").toBeVisible();
    await expect(page.getByTestId("sponsors-tab-sponsors")).toContainText(say(UI.en, "sponsors.empty"));
    await page.goto(sponsorsUrl(o.orgSlug, "on_stream"));
    await expect(page.getByTestId("on-stream-tab")).toContainText(say(UI.en, "sponsors.onStream.checklistEmpty"));

    const id = await addSponsor(o, { name: "Quiet Lane Florist", url: "https://quiet-lane.example/" });
    const link = await shareLink(o, id);
    const rp = await reader.newPage();
    expect((await rp.goto(reportPath(link.url)))?.status()).toBe(200);
    await expect(rp.getByTestId("report-showing"), "no showing").toHaveCount(0);
    await expect(rp.getByText(say(UI.en, "sponsorReport.showings.empty"), { exact: true })).toBeVisible();
    await expect(rp.getByTestId("report-stream-visits")).toHaveText("0");
    await expect(rp.getByTestId("report-viewers").getByTestId("viewers-coming-soon")).toHaveText(say(UI.en, "sponsors.viewers.comingSoon"));
    const onScreen = (await rp.getByTestId("report-on-screen").innerText()).trim();
    expect(onScreen, "a real zero, never NaN or a blank").toMatch(/\d/);
    expect(onScreen).not.toMatch(/NaN|undefined/);
  } finally {
    await reader.close();
    await releaseStandInOrg(o);
  }
});

test("E8 a 43-character sponsor name in Spanish and Dutch at 320: truncated in its row, the full name in its title, no page scroll", async ({ browser }) => {
  test.setTimeout(8 * NAV_MS + 10 * ACT_MS);
  const o = await seedStandInOrg(browser, "spe8");
  const name = "Harbourside Building Supplies and Timber Co";
  expect(name.length, "premise: 43 characters").toBe(43);
  try {
    const id = await addSponsor(o, { name, url: "https://harbourside-timber.example/" });
    const link = await shareLink(o, id);
    const origin = new URL(o.page.url()).origin;
    const { page } = o;
    await page.setViewportSize({ width: 320, height: 800 });
    for (const locale of ["es", "nl"] as const) {
      await o.ctx.addCookies([{ name: "seazn_locale", value: locale, url: origin }]);
      await page.goto(sponsorsUrl(o.orgSlug, "overview"));
      await expect(page.locator("html"), `${locale}: the hub renders in it`).toHaveAttribute("lang", locale);
      const cell = page.getByTestId(`sponsor-overview-row-${id}`).getByTestId("sponsor-overview-name");
      await expect(cell).toBeVisible();
      await expect(cell, "the full name is in its title").toHaveAttribute("title", name);
      const box = await cell.evaluate((el) => {
        const cs = getComputedStyle(el);
        return { overflow: cs.overflowX, ellipsis: cs.textOverflow, clipped: el.scrollWidth > el.clientWidth, right: el.getBoundingClientRect().right };
      });
      expect({ overflow: box.overflow, ellipsis: box.ellipsis, clipped: box.clipped }, `${locale} @320: cut with an ellipsis`).toEqual({ overflow: "hidden", ellipsis: "ellipsis", clipped: true });
      expect(box.right, `${locale} @320: inside the screen`).toBeLessThanOrEqual(320);
      await expect(page.getByTestId(`sponsor-overview-row-${id}`).getByTestId("sponsor-overview-viewers"), `${locale}: its own words`).toHaveText(say(UI[locale], "sponsors.viewers.comingSoon"));
      await expectNoHorizontalScroll(page);
      await page.goto(sponsorsUrl(o.orgSlug, "sponsors"));
      await expect(page.getByTestId("sponsors-tab-sponsors")).toContainText(name.slice(0, 10));
      await expectNoHorizontalScroll(page);
      await page.goto(reportPath(link.url));
      await expect(page.getByTestId("sponsor-report")).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 })).toContainText(name);
      await expectNoHorizontalScroll(page);
    }
  } finally {
    await releaseStandInOrg(o);
  }
});

test("E9 a viewer's malformed settings PUT is 403 — the role before the body; the owner's is 400", async ({ browser }) => {
  test.setTimeout(4 * NAV_MS + 6 * ACT_MS);
  const o = await seedStandInOrg(browser, "spe9");
  const member = await seedMemberIdentity(browser, o.page.request, o.orgId, "viewer");
  try {
    const malformed = { competitionId: "not-a-uuid", enabled: "yes", frequency: "constantly" };
    const url = `/api/v1/orgs/${o.orgId}/sponsor-stream-settings`;
    expect((await member.request.put(url, { data: malformed })).status(), "the viewer: refused for the role").toBe(403);
    expect((await o.page.request.put(url, { data: malformed })).status(), "positive pair: the owner gets the body's 400").toBe(400);
    const rows = await withDb((sql) => sql`select 1 from sponsor_stream_settings where org_id = ${o.orgId}`);
    expect(rows.length, "nothing was written").toBe(0);
  } finally {
    await member.release();
    await releaseStandInOrg(o);
  }
});

test("E10 repeat visits: every real GET redirects, a bot's is not counted; the 30 s dedupe is asserted only where Redis runs", async ({ browser }) => {
  test.setTimeout(4 * NAV_MS + 10 * ACT_MS);
  const o = await seedStandInOrg(browser, "spe10");
  const visitor = await browser.newContext({ storageState: EMPTY_JAR, extraHTTPHeaders: { "fly-client-ip": "198.51.100.71" } });
  try {
    const id = await addSponsor(o, { name: "Second Look Glazing", url: "https://second-look.example/" });
    const path = sponsorClickPath(id, { source: "site" });
    const counted = async () => (await withDb((sql) => sql`select 1 from sponsor_clicks where sponsor_id = ${id}`)).length;
    for (const n of [1, 2]) expect((await visitor.request.get(path, { maxRedirects: 0 })).status(), `visit ${n} redirects`).toBe(302);
    const redis = Boolean(process.env.REDIS_URL);
    // Spec §5.1: "one IP's repeat tap on one link within 30 s counts once." The window lives in Redis (`incrWindow`).
    const want = redis ? 1 : 2;
    await expect.poll(counted, { message: `two taps from one visitor count ${want}`, timeout: POLL_WAIT_MS }).toBe(want);
    if (!redis) {
      const note = "REDIS_URL is unset (e2e.yml runs no Redis): the 30 s one-visitor dedupe cannot hold, so both taps counted — the dedupe is NOT asserted here";
      console.log(`sponsors-edge-cases E10: ${note}`);
      test.info().annotations.push({ type: "skipped loudly", description: note });
    }
    const bot = await visitor.request.get(path, { maxRedirects: 0, headers: { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" } });
    expect(bot.status(), "a crawler is still redirected").toBe(302);
    // Positive pair, sent AFTER the bot: a different visitor's real tap. Once it has landed, a counted bot would show as one
    // more than that (each tap's write is deferred the same way, the bot's first).
    const second = await browser.newContext({ storageState: EMPTY_JAR, extraHTTPHeaders: { "fly-client-ip": "198.51.100.72" } });
    try {
      expect((await second.request.get(path, { maxRedirects: 0 })).status()).toBe(302);
    } finally {
      await second.close();
    }
    await expect.poll(counted, { message: "another visitor's tap counts", timeout: POLL_WAIT_MS }).toBeGreaterThanOrEqual(want + 1);
    expect(await counted(), "a crawler is not a click: only the other visitor's tap was added").toBe(want + 1);
  } finally {
    await visitor.close();
    await releaseStandInOrg(o);
  }
});

