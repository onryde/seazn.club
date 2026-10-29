// YouTube Connect T16 (plan R7, owner rulings O1 and O3): the public match page shows the match's YouTube replay.
//
// The seam is DATA -> PAGE, and the producer is the database: a `youtube_broadcasts` row in state `complete` is read by the REAL
// `getPublicFixture` (through the `public_fixture_youtube_parts_v` view), handed to the REAL `FixturePage`, and the HTML is read.
// Nothing between the table and the markup is replaced - a fixture in place of the loader would prove the fixture (recurring
// class 1, the inert seam). Only the Next runtime pieces a node test cannot run are stood in for: unstable_cache is a
// passthrough, and `useSearchParams` (the `?tab=` deep link) answers an empty query.
//
// The data rules (O3), each asserted with its twin so a probe that cannot see the thing cannot pass:
//   - zero parts: the existing "Watch live"/"Replay" pill, exactly as before, and no player;
//   - one part: the player alone - no "Part 1" anywhere, no tab rail;
//   - two parts: Part 1 / Part 2 tabs, in the order the broadcasts finished;
//   - a stream_url that IS Part 1 (what the end step writes): shown once, in the player, never again as the pill;
//   - a club's own, different stream_url: still renders, beside the player;
//   - a division still in setup: nothing (neither the parts nor the link leave an unreleased division);
//   - a cancelled fixture: nothing, whatever is stored;
//   - a broadcast that is PRIVATE on YouTube (owner ruling 2026-10-28, option A): neither a player nor a pill (it would be a dead tap
//     and "This video is private"); beside a visible part it is simply not there, and the visible one is "the replay", unlabelled.
// Real Postgres required; skipped without DATABASE_URL.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
  revalidateTag: vi.fn(),
}));
vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return { ...actual, useSearchParams: () => new URLSearchParams() };
});

import { sql } from "@/lib/db";
import { youtubeWatchUrl } from "@/lib/youtube";
import publicEn from "@/dictionaries/en/public.json";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import { rigUser } from "@/server/relay/__tests__/_session-rig";
import { connect } from "@/server/youtube/__tests__/_connect-rig";

const HAS_DB = !!process.env.DATABASE_URL;
const uniq = () => randomUUID().slice(0, 8);
const vid = () => `t16${randomUUID().replace(/-/g, "").slice(0, 8)}`;
const at = (hhmm: string) => new Date(`2030-06-01T${hhmm}:00Z`);
const TWITCH = "https://www.twitch.tv/seaznclub";
const GENERIC_DIVISION_CONFIG = { resultMode: "score", allowDraws: true, points: { w: 3, d: 1, l: 0 }, progressScore: false };

// The file owns its keys. `.env.local` supplies RELAY_KEK on a developer machine and CI's job does not, so a suite that
// reads it from there is green locally and "RELAY_KEK is not set" on every case in CI (the rig mints a stream code under it).
const ENV = ["RELAY_KEK", "YOUTUBE_TOKEN_KEK", "RELAY_IMAGE"] as const;
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
beforeAll(() => {
  process.env.RELAY_KEK = randomBytes(32).toString("hex");
  process.env.YOUTUBE_TOKEN_KEK = randomBytes(32).toString("hex");
  process.env.RELAY_IMAGE = "registry.fly.io/seazn-relay:t16-test";
});
afterAll(() => {
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

interface Seeded { orgId: string; orgSlug: string; compSlug: string; divSlug: string; fixtureId: string; divisionId: string; connectionId: string }

async function seed(o: { divisionStatus?: "active" | "setup"; locale?: string } = {}): Promise<Seeded> {
  const s = uniq();
  await sql`insert into sports (key, name, module_version, position_catalog) values ('generic', 'Generic', '1.0.0', '{}') on conflict (key) do nothing`;
  const orgSlug = `t16p-org-${s}`;
  const [{ id: orgId }] = await sql<{ id: string }[]>`
    insert into organizations (name, slug, default_locale) values (${`T16 Org ${s}`}, ${orgSlug}, ${o.locale ?? "en"}) returning id`;
  const compSlug = `t16p-comp-${s}`;
  const [{ id: compId }] = await sql<{ id: string }[]>`
    insert into competitions (org_id, name, slug, visibility, status) values (${orgId}, ${`T16 Comp ${s}`}, ${compSlug}, 'public', 'live') returning id`;
  const divSlug = `open-${s}`;
  const [{ id: divisionId }] = await sql<{ id: string }[]>`
    insert into divisions (org_id, competition_id, name, slug, sport_key, variant_key, status, config, module_version)
    values (${orgId}, ${compId}, 'Open', ${divSlug}, 'generic', 'score', ${o.divisionStatus ?? "active"}, ${sql.json(GENERIC_DIVISION_CONFIG)}, '1.0.0')
    returning id`;
  const [{ id: stageId }] = await sql<{ id: string }[]>`insert into stages (org_id, division_id, kind, name, seq) values (${orgId}, ${divisionId}, 'league', 'League', 1) returning id`;
  const [{ id: fixtureId }] = await sql<{ id: string }[]>`
    insert into fixtures (org_id, division_id, stage_id, fixture_no, round_no, seq_in_round) values (${orgId}, ${divisionId}, ${stageId}, 1, 1, 1) returning id`;
  const userId = await rigUser();
  const c = await connect({ auth: { orgId, via: "session", userId, role: "owner", keyId: null }, orgId, userId });
  return { orgId, orgSlug, compSlug, divSlug, fixtureId, divisionId, connectionId: c.connectionId };
}

async function completeBroadcast(s: Seeded, completedAt: Date, startedAt?: Date, privacy: "unlisted" | "public" | "private" = "unlisted", madeForKids = false): Promise<string> {
  const ytId = vid();
  await sql`
    insert into youtube_broadcasts (made_for_kids, org_id, connection_id, fixture_id, yt_broadcast_id, title, privacy, state, completed_at, created_at)
    values (${madeForKids}, ${s.orgId}, ${s.connectionId}, ${s.fixtureId}, ${ytId}, 'Match', ${privacy}, 'complete', ${completedAt}, ${startedAt ?? sql`now()`})`;
  return ytId;
}
const setFixture = (s: Seeded, status: string, streamUrl: string | null) =>
  sql`update fixtures set status = ${status}, stream_url = ${streamUrl} where id = ${s.fixtureId}`;

const seeded: string[] = [];
afterAll(async () => {
  for (const orgId of seeded) await sql`delete from organizations where id = ${orgId}`;
});

/** The page the way a visitor's request builds it: the real loader, the real component, the HTML. */
async function pageHtml(s: Seeded): Promise<string> {
  const { default: FixturePage } = await import("../page");
  return renderToStaticMarkup(
    await FixturePage({ params: Promise.resolve({ orgSlug: s.orgSlug, competitionSlug: s.compSlug, divisionSlug: s.divSlug, fixtureId: s.fixtureId }) }),
  );
}
const open = async (o: Parameters<typeof seed>[0] = {}) => {
  const s = await seed(o);
  seeded.push(s.orgId);
  return s;
};
const pill = (html: string) => /<a [^>]*data-testid="public-stream-link"[^>]*>/.exec(html)?.[0] ?? null;
/** The replay player's own markup - the match centre has a tab rail of its own (Summary, Info...), so tab probes are scoped here. */
const player = (html: string) => /<section data-testid="replay-embed"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
const openLinks = (html: string) => [...html.matchAll(/<a [^>]*data-testid="replay-open"[^>]*>/g)].map((m) => m[0]);

describe.skipIf(!HAS_DB)("the public match page shows the match's YouTube replay (T16, through the real loader)", () => {
  it("EMPTY CASE FIRST: no parts and a pasted link - exactly the pill the page always had, and no player", async () => {
    const s = await open();
    await setFixture(s, "decided", TWITCH);
    const html = await pageHtml(s);
    expect(pill(html), "the pasted-key pill is unchanged").toContain(`href="${TWITCH}"`);
    expect(html).toContain(`>${publicEn["overlay.replay"]}</a>`);
    expect(html).not.toContain("replay-embed");
    expect(html).not.toContain("replay-facade");
    // Positive pair: the same fixture, once a broadcast completes, does render a player (so the silence above is a fact).
    await completeBroadcast(s, at("10:00"));
    expect(await pageHtml(s)).toContain('data-testid="replay-embed"');
  });

  it("no parts and no link: neither a pill nor a player", async () => {
    const s = await open();
    await setFixture(s, "decided", null);
    const html = await pageHtml(s);
    expect(html).not.toContain("public-stream-link");
    expect(html).not.toContain("replay-embed");
  });

  it("one part: the player alone, inside the match card, with no part label and no tab rail", async () => {
    const s = await open();
    await setFixture(s, "decided", null);
    const ytId = await completeBroadcast(s, at("10:00"));
    const html = await pageHtml(s);
    expect([...html.matchAll(/data-testid="replay-embed"/g)], "exactly one player").toHaveLength(1);
    expect(html).toContain(`src="https://i.ytimg.com/vi/${ytId}/hqdefault.jpg"`);
    expect(html).toContain('data-testid="replay-facade"');
    expect(html).not.toContain("<iframe");
    expect(player(html), "premise: the player is found").toContain("replay-facade");
    expect(player(html)).not.toContain('role="tablist"');
    expect(player(html)).not.toContain('role="tab"');
    expect(html).not.toMatch(/\bPart [0-9]/);
    expect(openLinks(html)).toHaveLength(1);
    expect(openLinks(html)[0]).toContain(`href="${youtubeWatchUrl(ytId)}"`);
    // Inside the card - or, were the match-centre document absent, in the fallback slab - and never above the headline.
    const at1 = html.indexOf('data-testid="replay-embed"');
    expect(at1).toBeGreaterThan(html.indexOf("<h1"));
    const inCard = html.indexOf('data-testid="mc-court-card"') >= 0 && at1 > html.indexOf('data-testid="mc-court-card"') && at1 < html.indexOf('data-testid="mc-tab-');
    const inFallback = html.indexOf('data-testid="mc-fallback-replay"') >= 0 && at1 > html.indexOf('data-testid="mc-fallback-replay"');
    expect(inCard || inFallback, "the player sits in the match card (or the fallback slab), not loose on the page").toBe(true);
  });

  it("a stream_url that IS Part 1 (what the end step writes) is carried by the player and never shown a second time as the pill", async () => {
    const s = await open();
    const ytId = await completeBroadcast(s, at("10:00"));
    await setFixture(s, "decided", youtubeWatchUrl(ytId));
    const html = await pageHtml(s);
    expect(html).toContain('data-testid="replay-embed"');
    expect(html).not.toContain("public-stream-link");
    expect(html.split(youtubeWatchUrl(ytId)).length - 1, "the video's address appears once - as the open link").toBe(1);
    // Twin: the same video held as a DIFFERENT link on the fixture is the club's own and does render.
    await setFixture(s, "decided", `https://youtu.be/${ytId}x`);
    expect(pill(await pageHtml(s)), "a link that is not one of the parts shows").not.toBeNull();
  });

  it("TWO parts and a stream_url that is Part 1 (the realistic state: the end step wrote Part 1's link and Part 2 never rewrites it): both tabs, and no second 'Replay' pill", async () => {
    const s = await open();
    const part1 = await completeBroadcast(s, at("10:00"));
    const part2 = await completeBroadcast(s, at("11:00"));
    await setFixture(s, "decided", youtubeWatchUrl(part1));
    const html = await pageHtml(s);
    const tabs = [...player(html).matchAll(/<button [^>]*role="tab"[^>]*>(.*?)<\/button>/g)].map((m) => m[1]);
    expect(tabs, "premise: both parts are offered").toEqual(["Part 1", "Part 2"]);
    expect(html, "the stored link is one of the parts, so no pill").not.toContain("public-stream-link");
    expect(openLinks(html), "the open link follows the part showing (Part 1)").toHaveLength(1);
    expect(openLinks(html)[0]).toContain(`href="${youtubeWatchUrl(part1)}"`);
    expect(html.split(youtubeWatchUrl(part1)).length - 1, "Part 1's address appears once, as the open link").toBe(1);
    // The link may equally be Part 2's (a club that re-pasted the later video): the dedupe is over ALL the parts, not the first.
    await setFixture(s, "decided", youtubeWatchUrl(part2));
    const html2 = await pageHtml(s);
    expect([...player(html2).matchAll(/role="tab"/g)], "premise: still both tabs").toHaveLength(2);
    expect(html2).not.toContain("public-stream-link");
    // Negative twin: a link that is neither part DOES show, on the same two-part page.
    await setFixture(s, "decided", TWITCH);
    expect(pill(await pageHtml(s))).toContain(`href="${TWITCH}"`);
  });

  it("a club's own DIFFERENT stream_url still renders, beside the player", async () => {
    const s = await open();
    await setFixture(s, "decided", TWITCH);
    const ytId = await completeBroadcast(s, at("10:00"));
    const html = await pageHtml(s);
    expect(pill(html)).toContain(`href="${TWITCH}"`);
    expect(html).toContain('data-testid="replay-embed"');
    expect(openLinks(html)[0]).toContain(`href="${youtubeWatchUrl(ytId)}"`);
    // The pill is above the match card, the player inside it.
    expect(html.indexOf("public-stream-link")).toBeLessThan(html.indexOf('data-testid="replay-embed"'));
  });

  it("two parts: Part 1 and Part 2 tabs in the order the broadcasts STARTED, Part 1 showing, Part 2's video not loaded yet", async () => {
    const s = await open();
    await setFixture(s, "decided", null);
    // Part 1 started first and finished last; the restart's row is inserted first and finished first: insertion and completion order are wrong.
    const later = await completeBroadcast(s, at("11:30"), at("11:00"));
    const earlier = await completeBroadcast(s, at("12:00"), at("10:00"));
    const html = await pageHtml(s);
    const tabs = [...player(html).matchAll(/<button [^>]*role="tab"[^>]*>(.*?)<\/button>/g)].map((m) => m[1]);
    expect(tabs).toEqual(["Part 1", "Part 2"]);
    expect(html).toContain(`src="https://i.ytimg.com/vi/${earlier}/hqdefault.jpg"`);
    expect(html, "Part 2's video is not touched until its tab is chosen").not.toContain(later);
    expect(html).not.toContain("<iframe");
    expect(openLinks(html)).toHaveLength(1);
    expect(openLinks(html)[0]).toContain(`href="${youtubeWatchUrl(earlier)}"`);
  });

  it("the words follow the organisation's language (es), the tab labels included", async () => {
    const s = await open({ locale: "es" });
    await setFixture(s, "decided", null);
    await completeBroadcast(s, at("10:00"));
    await completeBroadcast(s, at("11:00"));
    const html = await pageHtml(s);
    const es = uiEs as Record<string, string>;
    const en = uiEn as Record<string, string>;
    for (const key of ["streaming.youtube.replay.play", "streaming.youtube.replay.open", "streaming.youtube.replay.region"]) {
      expect(es[key], `premise: ${key} is translated`).not.toBe(en[key]);
      expect(html).toContain(es[key]!);
      expect(html).not.toContain(en[key]!);
    }
    expect(html).toContain(es["streaming.youtube.part"]!.replace("{n}", "2"));
  });

  it("a division still in setup shows nothing - neither the player nor the link - and shows both once it is active", async () => {
    const s = await open({ divisionStatus: "setup" });
    const ytId = await completeBroadcast(s, at("10:00"));
    await setFixture(s, "scheduled", TWITCH);
    const hidden = await pageHtml(s);
    expect(hidden).not.toContain("replay-embed");
    expect(hidden).not.toContain("public-stream-link");
    expect(hidden).not.toContain(ytId);
    await sql`update divisions set status = 'active' where id = ${s.divisionId}`;
    const released = await pageHtml(s);
    expect(released).toContain('data-testid="replay-embed"');
    expect(pill(released)).toContain(`href="${TWITCH}"`);
  });

  it("a cancelled fixture shows nothing, whatever is stored; reinstated, it shows the player", async () => {
    const s = await open();
    await completeBroadcast(s, at("10:00"));
    await setFixture(s, "cancelled", TWITCH);
    const html = await pageHtml(s);
    expect(html).not.toContain("replay-embed");
    expect(html).not.toContain("public-stream-link");
    await setFixture(s, "decided", TWITCH);
    expect(await pageHtml(s)).toContain('data-testid="replay-embed"');
  });

  it("a part still in flight (live, not complete) is not a replay: the page is as it was", async () => {
    const s = await open();
    await setFixture(s, "in_play", null);
    await sql`insert into youtube_broadcasts (made_for_kids, org_id, connection_id, fixture_id, yt_broadcast_id, title, privacy, state)
              values (false, ${s.orgId}, ${s.connectionId}, ${s.fixtureId}, ${vid()}, 'Match', 'unlisted', 'live')`;
    expect(await pageHtml(s)).not.toContain("replay-embed");
  });

  it("a PRIVATE channel's replay is hidden from the public page: no player, no pill, none of its address - the twin with an unlisted broadcast renders the player", async () => {
    const s = await open();
    await setFixture(s, "decided", null);   // the end step writes no link for a private broadcast, so the fixture holds none
    const secret = await completeBroadcast(s, at("10:00"), at("09:00"), "private");
    const html = await pageHtml(s);
    expect(html).not.toContain("replay-embed");
    expect(html).not.toContain("replay-facade");
    expect(html).not.toContain("public-stream-link");
    expect(html, "its video id is nowhere in the page").not.toContain(secret);
    // Positive pair: the same fixture, once an unlisted broadcast completes, shows a player for THAT one (so the silence above is a fact).
    const visible = await completeBroadcast(s, at("12:00"), at("11:00"), "unlisted");
    const after = await pageHtml(s);
    expect(after).toContain('data-testid="replay-embed"');
    expect(after).toContain(`src="https://i.ytimg.com/vi/${visible}/hqdefault.jpg"`);
    expect(after, "the private one is still not on the page").not.toContain(secret);
  });

  it("MIXED: Part 1 unlisted + Part 2 private shows the one visible replay with NO 'Part 1' label and no tab rail; a club's own link beside a private-only match still renders", async () => {
    const s = await open();
    await setFixture(s, "decided", null);
    const visible = await completeBroadcast(s, at("10:00"), at("09:00"), "unlisted");
    const hidden = await completeBroadcast(s, at("12:00"), at("11:00"), "private");
    const html = await pageHtml(s);
    expect([...html.matchAll(/data-testid="replay-embed"/g)], "exactly one player").toHaveLength(1);
    expect(player(html)).not.toContain('role="tablist"');
    expect(html).not.toMatch(/\bPart [0-9]/);
    expect(openLinks(html)).toHaveLength(1);
    expect(openLinks(html)[0]).toContain(`href="${youtubeWatchUrl(visible)}"`);
    expect(html).not.toContain(hidden);

    // A club's own link on a match whose only broadcast is private: the pill is the club's own and renders; nothing of YouTube does.
    const t = await open();
    await setFixture(t, "decided", TWITCH);
    const hiddenOnly = await completeBroadcast(t, at("10:00"), at("09:00"), "private");
    const onlyOwn = await pageHtml(t);
    expect(pill(onlyOwn)).toContain(`href="${TWITCH}"`);
    expect(onlyOwn).not.toContain("replay-embed");
    expect(onlyOwn).not.toContain(hiddenOnly);
  });
  // ─── made for kids (owner 2026-10-29; DP III.E.4.j): the replay is a link out, never a player ──────────────────────────────
  /** The link-out card's own markup. */
  const card = (html: string) => /<div [^>]*data-testid="replay-linkout"[\s\S]*?<\/a><\/div>/.exec(html)?.[0] ?? "";
  const ytLinks = (html: string) => [...html.matchAll(/<a [^>]*href="https:\/\/www\.youtube\.com\/[^"]*"[^>]*>/g)].map((m) => m[0]);

  it("a MADE-FOR-KIDS replay (a broadcast row stamped true) is the link-out card on the real page: no iframe, no facade, no thumbnail request, exactly one youtube.com link - and the same match with a not-for-kids broadcast is the player", async () => {
    const s = await open();
    await setFixture(s, "decided", null);
    const kidsId = await completeBroadcast(s, at("10:00"), at("09:00"), "unlisted", true);
    const html = await pageHtml(s);
    expect(html).toContain('data-testid="replay-embed"');
    expect(card(html), "premise: the card is found").not.toBe("");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("replay-facade");
    expect(html).not.toContain("i.ytimg.com");
    expect(html).not.toContain("youtube-nocookie");
    const links = ytLinks(html);
    expect(links, "exactly one link to youtube.com on the whole page").toHaveLength(1);
    expect(links[0]).toContain(`href="${youtubeWatchUrl(kidsId)}"`);
    expect(links[0]).toContain('target="_blank"');
    expect(links[0]).toContain('rel="noopener noreferrer"');
    expect(html).toContain(uiEn["streaming.youtube.replay.madeForKids"]!);
    expect(html).toContain(uiEn["streaming.youtube.replay.watch"]!);

    // The positive pair, on a new fixture's page: only the stamp differs, and the player is what comes.
    const t = await open();
    await setFixture(t, "decided", null);
    const plainId = await completeBroadcast(t, at("10:00"), at("09:00"), "unlisted", false);
    const plain = await pageHtml(t);
    expect(plain).toContain("replay-facade");
    expect(plain).toContain(`src="https://i.ytimg.com/vi/${plainId}/hqdefault.jpg"`);
    expect(plain).not.toContain("replay-linkout");
  });

  it("the flag is the BROADCAST's: the connection's flag flipped after the broadcast was made moves nothing on the page, in either direction", async () => {
    const s = await open();
    await setFixture(s, "decided", null);
    await completeBroadcast(s, at("10:00"), at("09:00"), "unlisted", true);
    await sql`update org_youtube_connections set made_for_kids = false where id = ${s.connectionId}`;
    const kids = await pageHtml(s);
    expect(card(kids), "a true stamp stays a link out when the connection says false").not.toBe("");
    expect(kids).not.toContain("<iframe");
    expect(kids).not.toContain("replay-facade");

    const t = await open();
    await setFixture(t, "decided", null);
    await completeBroadcast(t, at("10:00"), at("09:00"), "unlisted", false);
    await sql`update org_youtube_connections set made_for_kids = true where id = ${t.connectionId}`;
    const plain = await pageHtml(t);
    expect(plain, "a false stamp stays a player when the connection says true").toContain("replay-facade");
    expect(plain).not.toContain("replay-linkout");
  });

  it("a MIXED match (R4): Part 1 made for kids, Part 2 not - the tabs are Part 1 and Part 2, Part 1 shows the card, and Part 2's video is not on the page; with the stamps the other way round Part 1 is the player", async () => {
    const s = await open();
    await setFixture(s, "decided", null);
    const first = await completeBroadcast(s, at("10:00"), at("09:00"), "unlisted", true);
    const second = await completeBroadcast(s, at("12:00"), at("11:00"), "unlisted", false);
    const html = await pageHtml(s);
    expect([...player(html).matchAll(/<button [^>]*role="tab"[^>]*>(.*?)<\/button>/g)].map((m) => m[1])).toEqual(["Part 1", "Part 2"]);
    expect(card(html)).toContain(`href="${youtubeWatchUrl(first)}"`);
    expect(html).not.toContain(second);
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("replay-facade");

    const t = await open();
    await setFixture(t, "decided", null);
    const a = await completeBroadcast(t, at("10:00"), at("09:00"), "unlisted", false);
    await completeBroadcast(t, at("12:00"), at("11:00"), "unlisted", true);
    const flipped = await pageHtml(t);
    expect(flipped, "Part 1 not for kids: the facade").toContain(`src="https://i.ytimg.com/vi/${a}/hqdefault.jpg"`);
    expect(flipped).not.toContain("replay-linkout");
  });

  it("the stored link that IS the made-for-kids part is carried by the card and not shown a second time as the pill; a club's different link still is", async () => {
    const s = await open();
    const kidsId = await completeBroadcast(s, at("10:00"), at("09:00"), "unlisted", true);
    await setFixture(s, "decided", youtubeWatchUrl(kidsId));
    const html = await pageHtml(s);
    expect(html).not.toContain("public-stream-link");
    expect(ytLinks(html), "one youtube.com link: the card's").toHaveLength(1);
    await setFixture(s, "decided", TWITCH);
    expect(pill(await pageHtml(s)), "the club's own link is still there beside the card").toContain(`href="${TWITCH}"`);
  });

  it("the words follow the organisation's language (es): the card's reason and link are Spanish", async () => {
    const s = await open({ locale: "es" });
    await setFixture(s, "decided", null);
    await completeBroadcast(s, at("10:00"), at("09:00"), "unlisted", true);
    const html = await pageHtml(s);
    const es = uiEs as Record<string, string>;
    const en = uiEn as Record<string, string>;
    for (const key of ["streaming.youtube.replay.madeForKids", "streaming.youtube.replay.watch"]) {
      expect(es[key], `premise: ${key} is translated`).not.toBe(en[key]);
      expect(html.replaceAll("&#x27;", "'")).toContain(es[key]!);
      expect(html).not.toContain(en[key]!);
    }
  });
});
