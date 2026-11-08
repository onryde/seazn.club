// R4 sponsors on stream — the edges of the journey (spec 2026-10-27), each read against the code and the spec before it
// was written, so a case states what the PRODUCT does. Where the product differs from what was briefed, the case asserts
// the product's behaviour and the walkthrough report names the difference as a finding (never an encoded bug).
//
// Every PERSON event is tapped in the hub (walkthrough README "The rule"): the On stream ticks and unticks, the rotation
// switch off and on, the mid-stream tick, and both sponsor deletes. The plan each tap leaves is then read off the overlay
// route: the relay door (`?sid&st`, what the compositor's page polls) wherever a session runs, the console preview's door
// (`?preview=1`) in the scope case, which runs two fixtures and the pool admits ONE composed session. Setup that is not
// under test (the org, a fixture, a sponsor row, a report link) uses SQL and the API.
//
//   E4  one sponsor ticked rotates alone; a second of the same tier, ticked mid-stream, joins the rotation
//   E5  no logo: the card shows the name and its initial; a logo: the image
//   E3  (on the stream) an untick drops its card from the plan; the rotation switched OFF empties it and the card leaves
//       the stream; switched on, it is back; the last untick empties it
//   E1  refused relay input: no token, a forged one, or the token of ANOTHER real session (E4's, ended) is 401 and writes
//       nothing; a malformed body is 400; in one beat, another org's card (`sponsor_gone`), a clock 15 min out, and a
//       corrupt break assignment naming another org's sponsor (`foreign_sponsor`) are refused while the good item beside
//       them is written — the beat answers 200 with the contract's reply, which carries no refusal count; frames too big,
//       not a JPEG, or of no airing are refused and the next beat on the same connection is answered
//   E6  delete after airings (same org as E1): the Overview keeps the deleted sponsor's showings under its name, marked
//       "Deleted", its clicks unknown (a dash and "not available"), no Share. Deleting a sponsor ENDS its share links
//       (PO ruling 2026-11-08; spec §4): its report link is a 404
//   E3  the plan's scope: a competition's sponsor only on its own competition's fixtures; no plan when nothing is ticked or
//       the rotation is switched off (each with its positive control)
//   E2  dead links: an unknown code, a deleted sponsor's code, a report token one character off — all 404, the report's
//       the same page as a token never issued
//   E7  empty: the hub's three tabs with no sponsor, and a report with no showing (a real zero, to the unit)
//   E8  a 43-character name in Spanish and Dutch at 320: truncated in its row with the full name in its title, no page scroll
//   E9  a viewer's malformed settings PUT is 403 (the role is checked before the body); the owner's is 400
//   E10 repeat visits: every real GET redirects and a person's tap is counted; a bot's GET redirects uncounted. The 30 s
//       one-visitor dedupe (spec §3.7: counts once) needs Redis, which e2e.yml does not run, so it is NOT asserted here:
//       src/app/s/__tests__/route.test.ts covers it. Rate limits: not driven (Redis).
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator } from "@playwright/test";
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
  endStandInSessions,
  expectContract,
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
  type StandInSessionRef,
} from "./helpers/sponsor-relay-standin";
import { SCENE_CAROUSEL_MS } from "../src/lib/sponsor-plan";
import { sponsorClickPath } from "../src/lib/sponsor-clicks";
import { SPONSOR_SHORT_CODE_ALPHABET, SPONSOR_SHORT_CODE_MAX_LENGTH } from "../src/lib/sponsor-short-code";
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
/** One tap in the hub: the tap and its write landing, then the plan it leaves, read off the overlay route. */
const TAP_MS = 2 * ACT_MS;
/** The longest a test here holds the stream pool — the session test (E4, E5, E3 on the stream), step by step: the
 *  session's create and facts; the solo window; the mid-stream tick (the tab reloaded for the new row, the tap, the
 *  overlay's next poll, then a showing each and one more); the logo's paint (two showings); the untick; the switch off and
 *  the card leaving (a poll and a showing's end); the switch on and the last untick; the end. E1 + E6 holds it less. */
const POOL_HOLD = {
  file: "sponsors-edge-cases.spec.ts",
  holdMs:
    cycleMs(FAKE_CONNECT_MS) +
    TWO_SHOWINGS_MS +
    (NAV_MS + TAP_MS + POLL_WAIT_MS + TWO_SHOWINGS_MS + SCENE_CAROUSEL_MS) +
    2 * SCENE_CAROUSEL_MS +
    TAP_MS +
    (TAP_MS + POLL_WAIT_MS + SCENE_CAROUSEL_MS) +
    2 * TAP_MS +
    POLL_WAIT_MS,
} as const;

/** A code in the minted alphabet at the longest length, so it collides with nothing a run left behind. */
const randomCode = () =>
  Array.from({ length: SPONSOR_SHORT_CODE_MAX_LENGTH }, () => SPONSOR_SHORT_CODE_ALPHABET[Math.floor(Math.random() * SPONSOR_SHORT_CODE_ALPHABET.length)]).join("");
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

async function addSponsor(o: StandInOrg, s: { name: string; url?: string | null; tier?: string; logo_path?: string; competition_id?: string }): Promise<string> {
  const res = await o.page.request.post(`/api/v1/orgs/${o.orgId}/sponsors`, { data: { tier: "partner", ...s } });
  expect(res.status(), `setup: add ${s.name}: ${await res.text()}`).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}
// --- the hub, as the organiser taps it (on-stream-tab.tsx: a tick is a PATCH, the switch a PUT; both disable the tab's
// controls while the write is in flight, so "enabled again" is the write having landed) ------------------------------------
/** The On stream tab, opened (or reopened, for a sponsor added since) at the organisation-wide scope. */
async function openOnStream(o: StandInOrg): Promise<void> {
  await o.page.goto(sponsorsUrl(o.orgSlug, "on_stream"));
  await expect(o.page.getByTestId("on-stream-tab")).toBeVisible();
}
async function landed(o: StandInOrg, control: Locator): Promise<void> {
  await expect(control, "the write landed").toBeEnabled({ timeout: ACT_MS });
  await expect(o.page.getByTestId("on-stream-error"), "and was not refused").toHaveCount(0);
}
/** Tap a sponsor's On stream box to `on`. */
async function tapTick(o: StandInOrg, id: string, on: boolean): Promise<void> {
  const box = o.page.getByTestId(`on-stream-tick-${id}`);
  await expect(box, `premise: the box is ${on ? "un" : ""}ticked before the tap`).toBeChecked({ checked: !on });
  if (on) await box.check();
  else await box.uncheck();
  await landed(o, box);
  await expect(box).toBeChecked({ checked: on });
}
/** Tap the rotation switch to `on`. */
async function tapSwitch(o: StandInOrg, on: boolean): Promise<void> {
  const sw = o.page.getByTestId("on-stream-switch");
  await expect(sw, `premise: the rotation is ${on ? "off" : "on"} before the tap`).toHaveAttribute("aria-checked", String(!on));
  await sw.click();
  await landed(o, sw);
  await expect(sw).toHaveAttribute("aria-checked", String(on));
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
  /** Every composed session, registered by `composedSession` the moment its create answers. */
  const sessions: StandInSessionRef[] = [];
  /** The first test's session — real, and ended by the time E1 runs: the "another session" whose token E1 presents. */
  let earlier: StandInSessionRef | null = null;
  const reserve = async () => {
    if (!holdsStreamSlot()) await takeWholePool(POOL_HOLD, { creditsKeyWaitMs: 1 });
  };

  test.afterEach(async () => {
    try {
      await disposeStandInPhones();
    } finally {
      try {
        await endStandInSessions(sessions);
      } finally {
        await releaseStreamSlot();
      }
    }
  });
  test.afterAll(async () => {
    for (const o of orgs.splice(0)) await releaseStandInOrg(o);
  });

  test("E4 + E5 + E3 one sponsor rotates alone, a second ticked mid-stream joins, the name stands in for a missing logo — and the rotation switched off takes the card off the stream", async ({ browser }) => {
    test.setTimeout(POOL_SLOT_WAIT_MS + POOL_HOLD.holdMs + 4 * NAV_MS);
    const o = await seedStandInOrg(browser, "spe4");
    orgs.push(o);
    const fx = await seedStandInFixture(o, { label: `Edge Hockey ${o.orgSlug}`, sportKey: "hockey", variantKey: "fih-outdoor", home: "Edge Home HC", away: "Edge Away HC" });
    const plain = { name: "Nomad Coffee Roasters", id: "" };
    const logoed = { name: "Lantern Optics", id: "" };
    plain.id = await addSponsor(o, { name: plain.name, url: "https://nomad-coffee.example/" });
    // E4 — the organiser ticks it: the first tick also switches the rotation on (R12).
    await openOnStream(o);
    await tapTick(o, plain.id, true);
    await expect(o.page.getByTestId("on-stream-switch"), "the first tick turned the rotation on (R12)").toHaveAttribute("aria-checked", "true");
    const s = await composedSession(o, fx, reserve, sessions);
    earlier = s;
    const relayIds = async () => planSponsorIds(await relayPlan(s));
    await expect.poll(relayIds, { message: "one ticked: one card, on the relay door", timeout: ACT_MS }).toEqual([plain.id]);

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

      // E4 — a second sponsor of the SAME tier, with a logo, ticked MID-STREAM: both rotate. Its row is setup (a logo
      // cannot be uploaded here: content-upload writes to Supabase storage, a stub in e2e.yml); its tick is the tap.
      logoed.id = await addSponsor(o, { name: logoed.name, url: "https://lantern-optics.example/", logo_path: LOGO_URL });
      await openOnStream(o);
      await tapTick(o, logoed.id, true);
      await expect.poll(relayIds, { message: "the mid-stream tick joins the plan", timeout: ACT_MS }).toEqual([plain.id, logoed.id].sort());
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

      // E3 — the mid-stream untick: its card leaves the plan, the other stays.
      await tapTick(o, logoed.id, false);
      await expect.poll(relayIds, { message: "the untick drops its card", timeout: ACT_MS }).toEqual([plain.id]);
      // E3 — the rotation switched OFF (on-stream-tab's `saveSettings({ enabled: !on })`): no plan, though a sponsor is
      // still ticked — and the card leaves the stream.
      await tapSwitch(o, false);
      await expect.poll(() => relayPlan(s), { message: "rotation off: no plan", timeout: ACT_MS }).toBeNull();
      await expect(cef.page.getByTestId("ovl-sponsor-card"), "the card leaves the stream").toHaveCount(0, { timeout: POLL_WAIT_MS + SCENE_CAROUSEL_MS });
      // Positive control: on again, the plan is back — the switch alone had emptied it.
      await tapSwitch(o, true);
      await expect.poll(relayIds, { message: "on again: the ticked card is back", timeout: ACT_MS }).toEqual([plain.id]);
      // E3 — the last tick removed: no plan.
      await tapTick(o, plain.id, false);
      await expect.poll(() => relayPlan(s), { message: "nothing ticked: no plan", timeout: ACT_MS }).toBeNull();
    } finally {
      await cef.context.close();
    }
  });

  test("E1 + E6 refused relay input writes nothing and answers as the contract says; a sponsor deleted after airing keeps its showings by name, and its report link ends", async ({ browser }) => {
    test.setTimeout(POOL_SLOT_WAIT_MS + POOL_HOLD.holdMs + 8 * NAV_MS + 12 * ACT_MS);
    const prior = earlier;
    expect(prior, "the session test before this one made a real session (serial: it ran, and its afterEach ended it)").not.toBeNull();
    const o = await seedStandInOrg(browser, "spe1");
    orgs.push(o);
    const other = await seedStandInOrg(browser, "spe1x");
    orgs.push(other);
    const fx = await seedStandInFixture(o, { label: `Edge Volley ${o.orgSlug}`, sportKey: "volleyball", variantKey: "indoor", home: "Edge Home VC", away: "Edge Away VC" });
    const ownName = "Tidewater Print Works";
    const own = await addSponsor(o, { name: ownName, url: "https://tidewater-print.example/" });
    const foreign = await addSponsor(other, { name: "Elsewhere Ales", url: "https://elsewhere-ales.example/" });
    const s = await composedSession(o, fx, reserve, sessions);
    const rows = () => withDb((sql) => sql<{ sponsor_id: string | null; moment_id: string }[]>`
      select sponsor_id, moment_id from sponsor_airings where session_id = ${s.sid} order by moment_id`);

    // --- credentials: each refused before anything is read or written (heartbeat route: bearer, then the token) ---------
    const now = Date.now();
    const good = startItem(carouselMomentId("starting", now), own, now);
    const body = { state: "playing", programmePhase: "live", airings: [good] };
    // Another REAL session's token: the first test's, signed for its sid. Positive pair: on its OWN session's route the
    // token verifies, and is answered as the ended session it is (410 SESSION_ENDED, the contract's) — never a 401.
    const priorToken = await jobTokenFor(prior!.sid);
    const ownRouteBody = { state: "playing" };
    expectContract("heartbeat", ownRouteBody, "the prior session's beat");
    const ownRoute = await s.request.post(`/api/internal/relay/sessions/${prior!.sid}/heartbeat`, {
      headers: { Authorization: `Bearer ${priorToken}` },
      data: ownRouteBody,
    });
    const ownRouteText = await ownRoute.text();
    expect(ownRoute.status(), `the prior session's token on its own route: ${ownRouteText}`).toBe(410);
    expect(ownRouteText).toContain("SESSION_ENDED");
    for (const [why, token] of [
      ["no token", null],
      ["a token signed with another secret", await jobTokenFor(s.sid, `not-the-secret-${randomUUID()}`)],
      ["another session's token", priorToken],
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
    // Its item's card is this org's OWN sponsor, so `foreign_sponsor` alone refuses it: were the assignment not read, the
    // void-race fallback (airings.ts rule 3) would write the card's own sponsor, and the row check below would see it.
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
          startItem(corruptMoment, own, now, { source: "operator", breakKind: "set_end", style: "banner" }),
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
    // No frame-row count here: e2e.yml's storage is a stub, so even an ADMITTED frame stores no row (502
    // FRAME_STORAGE_FAILED, J4) and "no row" reads the same refused or not. The refusals are their statuses and codes.

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

    // PO ruling 2026-11-08 (spec §4): the club's Overview keeps the airings BY NAME; the share links end (below).
    await page.goto(sponsorsUrl(o.orgSlug, "overview"));
    const gone = page.getByTestId(`sponsor-overview-row-gone-${ownName}`);
    await expect(gone, "the deleted sponsor keeps its row").toBeVisible();
    await expect(gone.getByTestId("sponsor-overview-name"), "its airings listed under the sponsor's name").toHaveText(ownName);
    await expect(gone).toContainText(say(UI.en, "sponsors.overview.deleted"));
    await expect(gone.getByTestId("sponsor-overview-times"), "its showings are still counted").toHaveText("2");
    const clicks = gone.getByTestId("sponsor-overview-clicks");
    await expect(clicks.locator('[aria-hidden="true"]'), "its clicks went with it: a dash").toHaveText("—");
    await expect(clicks.locator(".sr-only"), "spoken as not available").toHaveText(say(UI.en, "sponsors.overview.notAvailable"));
    await expect(gone.getByTestId("sponsor-overview-share"), "nothing to share for a deleted sponsor").toHaveCount(0);
    const reader = await browser.newContext({ storageState: EMPTY_JAR });
    try {
      const rp = await reader.newPage();
      expect((await rp.goto(reportPath(link.url)))?.status(), "deleting a sponsor ends its share links").toBe(404);
      await expect(rp.getByTestId("sponsor-report-not-found")).toBeVisible();
    } finally {
      await reader.close();
    }
  });
});

test("E3 the plan's scope: a competition's sponsor only on that competition's fixtures; no plan when nothing is ticked or the rotation is off — every tick and the switch tapped", async ({ browser }) => {
  // The owner's sign-in and two fixtures' seeds, the tab (four navigations); six taps; nine plan reads.
  test.setTimeout(4 * NAV_MS + 6 * TAP_MS + 9 * ACT_MS);
  const o = await seedStandInOrg(browser, "spe3");
  try {
    const fxA = await seedStandInFixture(o, { label: `Scope A ${o.orgSlug}`, sportKey: "volleyball", variantKey: "indoor", home: "Scope A1", away: "Scope A2" });
    const fxB = await seedStandInFixture(o, { label: `Scope B ${o.orgSlug}`, sportKey: "volleyball", variantKey: "indoor", home: "Scope B1", away: "Scope B2" });
    expect(fxA.competitionId, "premise: two competitions").not.toBe(fxB.competitionId);
    const everywhere = await addSponsor(o, { name: "Everywhere Bakery", url: "https://everywhere-bakery.example/" });
    const scoped = await addSponsor(o, { name: "Only-A Motors", url: "https://only-a-motors.example/", competition_id: fxA.competitionId });
    // The console preview's door: two fixtures' plans at once, where the relay door needs a composed session per fixture
    // and the pool admits one (the session test reads the relay door after its taps).
    const plan = async (fixtureId: string) => planSponsorIds(await previewPlan(o.page.request, fixtureId));
    const planIs = (fixtureId: string, want: string[] | null, message: string) =>
      want === null
        ? expect.poll(() => previewPlan(o.page.request, fixtureId), { message, timeout: ACT_MS }).toBeNull()
        : expect.poll(() => plan(fixtureId), { message, timeout: ACT_MS }).toEqual([...want].sort());

    await planIs(fxA.fixtureId, null, "a fresh org (no tick, no rotation): no plan — null, not an empty one");
    // The organisation-wide scope lists both: the competition's own sponsor is ticked there too.
    await openOnStream(o);
    await tapTick(o, everywhere, true);
    await expect(o.page.getByTestId("on-stream-switch"), "the first tick turned the rotation on (R12)").toHaveAttribute("aria-checked", "true");
    await tapTick(o, scoped, true);
    await planIs(fxA.fixtureId, [everywhere, scoped], "competition A: both");
    await planIs(fxB.fixtureId, [everywhere], "competition B: never A's sponsor");

    // Switched off (the org-wide rotation row the first tick created): no plan anywhere, though both are ticked.
    await tapSwitch(o, false);
    await planIs(fxA.fixtureId, null, "rotation off: no plan on A");
    await planIs(fxB.fixtureId, null, "rotation off: no plan on B");
    // Positive control: on again, the plan is back — the switch alone had emptied it.
    await tapSwitch(o, true);
    await planIs(fxA.fixtureId, [everywhere, scoped], "on again: the plan is back");
    await tapTick(o, everywhere, false);
    await planIs(fxB.fixtureId, null, "B's only sponsor unticked: no plan there");
    await planIs(fxA.fixtureId, [scoped], "A keeps its own");
    await tapTick(o, scoped, false);
    await planIs(fxA.fixtureId, null, "every tick removed: no plan");
  } finally {
    await releaseStandInOrg(o);
  }
});

test("E2 dead links: an unknown code, a deleted sponsor's code and a report token one character off are all 404", async ({ browser }) => {
  test.setTimeout(7 * NAV_MS + 12 * ACT_MS);
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
    // The organiser deletes the sponsor in the hub (no confirm step: E6 taps the same button).
    const removeName = say(UI.en, "settings.org.sponsors.remove").replace("{name}", "Shortlived Kites");
    await o.page.goto(sponsorsUrl(o.orgSlug, "sponsors"));
    await o.page.getByRole("button", { name: removeName, exact: true }).click();
    await expect(o.page.getByRole("button", { name: removeName, exact: true }), "the row is gone").toHaveCount(0);
    await expect.poll(async () => (await withDb((sql) => sql`select 1 from sponsors where id = ${id}`)).length, { timeout: ACT_MS }).toBe(0);
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
    // A real zero, to the unit: no time on screen is ZERO SECONDS in the locale's own short unit — the platform's formatter
    // (Intl, this process's ICU: the server's Node on CI), never a blank, NaN or a bare digit — over "across 0 showings".
    const zeroSeconds = new Intl.NumberFormat("en", { style: "unit", unit: "second", unitDisplay: "short" }).format(0);
    expect(zeroSeconds, "premise: the formatter names its unit").toMatch(/^0\s?\D+$/);
    await expect(rp.getByTestId("report-on-screen"), "no time on screen: zero seconds").toHaveText(zeroSeconds);
    const zeroRule = new Intl.PluralRules("en").select(0);
    await expect(
      rp.getByText(say(UI.en, `sponsorReport.stat.onScreen.${zeroRule}`).replace("{count}", "0"), { exact: true }),
      "beside it, across zero showings",
    ).toBeVisible();
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

/** The one test that covers spec §3.7's "one IP's repeat tap on one link within 30 s counts once": the window lives in
 *  Redis (`incrWindow`, clicks.ts `recordClickOnce`), which e2e.yml does not run. */
const DEDUPE_UNIT =
  "src/app/s/__tests__/route.test.ts › GET /s/[key] — the write is filtered, never the redirect (fix round 1, I3) › with Redis: one IP's two GETs inside the window are ONE click; another IP's is its own";

test("E10 repeat visits: every real GET redirects and a person's tap counts, a bot's is not counted; the 30 s dedupe is the unit's (Redis)", async ({ browser }) => {
  test.setTimeout(4 * NAV_MS + 10 * ACT_MS);
  const o = await seedStandInOrg(browser, "spe10");
  const visitorAt = (ip: string) => browser.newContext({ storageState: EMPTY_JAR, extraHTTPHeaders: { "fly-client-ip": ip } });
  try {
    const id = await addSponsor(o, { name: "Second Look Glazing", url: "https://second-look.example/" });
    const path = sponsorClickPath(id, { source: "site" });
    const counted = async () => (await withDb((sql) => sql`select 1 from sponsor_clicks where sponsor_id = ${id}`)).length;
    const getFrom = async (ip: string, headers: Record<string, string> = {}) => {
      const ctx = await visitorAt(ip);
      try {
        return (await ctx.request.get(path, { maxRedirects: 0, headers })).status();
      } finally {
        await ctx.close();
      }
    };

    // A crawler first, then — the positive pair — another visitor's real tap. Each tap's write is deferred the same way,
    // the bot's first, so once the person's has landed a counted bot would show as one more.
    expect(await getFrom("198.51.100.71", { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" }), "a crawler is still redirected").toBe(302);
    expect(await getFrom("198.51.100.72"), "a person's tap redirects").toBe(302);
    await expect.poll(counted, { message: "the person's tap counts", timeout: POLL_WAIT_MS }).toBeGreaterThanOrEqual(1);
    expect(await counted(), "a crawler is not a click: only the person's tap was counted").toBe(1);

    // Repeat taps from one visitor: each redirects, and the taps are counted through the real route. HOW MANY they count is
    // the 30 s dedupe's question, which needs Redis — not asserted here (see the annotation).
    const baseline = await counted();
    const repeat = await visitorAt("198.51.100.73");
    try {
      for (const n of [1, 2]) expect((await repeat.request.get(path, { maxRedirects: 0 })).status(), `repeat visit ${n} redirects`).toBe(302);
    } finally {
      await repeat.close();
    }
    await expect.poll(counted, { message: "the repeat visitor's taps are counted", timeout: POLL_WAIT_MS }).toBeGreaterThan(baseline);
    const note =
      `dedupe needs Redis; spec §3.7 counts once; covered by unit ${DEDUPE_UNIT}. ` +
      `Here (REDIS_URL ${process.env.REDIS_URL ? "set" : "unset"}): baseline ${baseline}, read ${await counted()} after the two repeat taps — not asserted.`;
    console.log(`sponsors-edge-cases E10: ${note}`);
    test.info().annotations.push({ type: "skip", description: note });
  } finally {
    await releaseStandInOrg(o);
  }
});

