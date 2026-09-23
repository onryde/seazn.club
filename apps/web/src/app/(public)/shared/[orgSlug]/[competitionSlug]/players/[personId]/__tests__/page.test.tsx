// Spectator surface W2, Task 14 — the public player page (owner-approved
// option C): Matches first, the newest line as a court slab, older lines as
// rows, and the squad entry as link cards into the competition hub.
//
// What this file holds down, in order of how badly it would hurt:
//  1. The Matches section exists in EVERY state (R9's empty case first), and
//     the island is handed the page's own lines, the org's locale and a
//     dictionary SLICE — the seam between this server page and its poll.
//  2. The slab is the right line: live beats newest, newest beats older. Each
//     case has at least three lines so the order is witnessed, not assumed.
//  3. Not one heading is hardcoded English. Every locale assertion compares
//     against that locale's OWN dictionary value, never an English literal
//     list — Dutch and French share words with English (`[competitionSlug]/
//     __tests__/page.test.tsx` records the false positives that caused).
//  4. The squad entry is separate elements linking to the hub, not a
//     dash-and-middle-dot sentence linking to a division page.
//
// Markup assertions anchor on `="` (an omitted prop serialises as
// "$undefined", so a bare substring probe passes in both states).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { propsOf, walk } from "@/components/__tests__/_hook-harness";
import { PlayerMatches } from "@/components/public-site/player-matches";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import type { Dict } from "@/lib/i18n-constants";
import { playerMatchesDict } from "@/lib/player-matches-dict";
import type { PlayerMatchLineT } from "@/server/public-site/player-matches-schema";
import type { PlayerUpcomingRow } from "@/server/public-site/public-player-matches";

const stub = vi.hoisted(() => ({ getPublicPlayer: vi.fn(), getPublicPlayerUpcoming: vi.fn() }));
vi.mock("@/server/public-site/data", () => ({
  getPublicPlayer: stub.getPublicPlayer,
  getPublicPlayerUpcoming: stub.getPublicPlayerUpcoming,
}));
// No effect runs under `renderToStaticMarkup`, so nothing polls; this keeps a
// real `fetch` out of the module graph all the same.
vi.mock("@/components/public-site/player-matches-data", () => ({ fetchPlayerMatches: vi.fn() }));
const nav = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("CALLED_NOT_FOUND");
  }),
}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  notFound: nav.notFound,
}));

import Page, { generateMetadata, generateStaticParams, revalidate } from "../page";

// ---------------------------------------------------------------- fixtures

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");

const PERSON = "11111111-2222-3333-4444-555555555555";
const HUB = "/shared/riverside/autumn-cup";

const line = (fixtureId: string, over: Partial<PlayerMatchLineT> = {}): PlayerMatchLineT => ({
  fixtureId,
  href: `${HUB}/premier/fixtures/${fixtureId}`,
  divisionName: "Premier",
  divisionSlug: "premier",
  scheduledAt: "2026-09-05T10:00:00.000Z",
  tz: "Europe/London",
  opponentName: `Opponent ${fixtureId}`,
  line: `${fixtureId} figures`,
  result: "won",
  ...over,
});

/** When `getPublicPlayer`'s cached read ran — 40 s before `RENDER_AT`, the
 *  age an ISR render inside a warm entry really shows. */
const CACHED_AT = "2026-09-05T11:59:20.000Z";
const RENDER_AT = "2026-09-05T12:00:00.000Z";

interface DataOver {
  locale?: string;
  generatedAt?: string;
  matches?: PlayerMatchLineT[];
  memberships?: unknown[];
  stats?: unknown[];
  career?: unknown[];
  upcoming?: PlayerUpcomingRow[];
}

const data = (over: DataOver = {}) => ({
  org: {
    id: "o1",
    name: "Riverside SC",
    slug: "riverside",
    branded: false,
    branding: {},
    logo: null,
    about: null,
    default_locale: over.locale ?? "en",
    card_payments: false,
  },
  competition: {
    id: "c1",
    org_id: "o1",
    name: "Autumn Cup",
    slug: "autumn-cup",
    description: null,
    starts_on: null,
    ends_on: null,
    branding: {},
    status: "active",
    visibility: "public",
  },
  player: { id: PERSON, org_id: "o1", name: "Ada Lovelace", photo: null },
  memberships: over.memberships ?? [
    { division_name: "Premier", division_slug: "premier", entrant_name: "Riverside Blue", squad_number: 7, position: "Wicketkeeper" },
  ],
  stats: over.stats ?? [
    { division_name: "Premier", division_slug: "premier", sport_key: "cricket", metrics: [{ key: "runs", label: "Runs", value: 120 }] },
  ],
  career: over.career ?? [],
  careerLabel: "Career",
  matches: over.matches ?? [],
  generatedAt: over.generatedAt ?? CACHED_AT,
});

const params = Promise.resolve({ orgSlug: "riverside", competitionSlug: "autumn-cup", personId: PERSON });

async function renderPage(over: DataOver = {}) {
  stub.getPublicPlayer.mockResolvedValue(data(over));
  stub.getPublicPlayerUpcoming.mockResolvedValue(over.upcoming ?? []);
  const tree = (await Page({ params })) as ReactElement;
  return { tree, html: renderToStaticMarkup(tree) };
}

/** The slab is the one match link carrying `data-slab`. React writes props in
 *  source order, so the testid sits immediately before it. */
const slabId = (html: string) => html.match(/data-testid="mh-player-match-([^"]+)" data-slab="true"/)?.[1] ?? null;
const rowIds = (html: string) =>
  [...html.matchAll(/data-testid="mh-player-match-([^"]+)"(?! data-slab)/g)].map((m) => m[1]);

/** One section's markup, from its opening tag to the next `</section>`. */
const section = (html: string, testid: string) => {
  const start = html.indexOf(`data-testid="${testid}"`);
  expect(start, `${testid} rendered`).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</section>", start));
};

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------- tests

describe("player page — the Matches section", () => {
  it("EMPTY: the section still renders, with its heading and the empty sentence", async () => {
    const { html } = await renderPage({ matches: [] });
    const matches = section(html, "mh-player-matches");
    expect(matches).toContain(`>${esc(en["player.matches"])}<`);
    expect(matches).toContain('data-testid="mh-player-matches-empty"');
    expect(matches).toContain(`>${esc(en["player.matches.empty"])}<`);
    expect(matches).not.toContain('data-testid="mh-player-match-');
  });

  it("the NEWEST line is the slab and the older lines are rows, in the reader's order", async () => {
    const { html } = await renderPage({ matches: [line("f3"), line("f2", { result: "lost" }), line("f1", { result: "drawn" })] });
    expect(slabId(html)).toBe("f3");
    expect(rowIds(html)).toEqual(["f2", "f1"]);
    // The slab's figures are the newest line's, not a row's. Read as TEXT: the
    // figures are split into break-safe runs (R11), so the words sit in spans.
    const figures = html.match(/data-testid="mh-player-slab-figures"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "";
    expect(figures.replace(/<[^>]+>/g, "")).toBe("f3 figures");
  });

  it("a LIVE line leads even when a newer line exists — and the slab carries the live pill", async () => {
    const { html } = await renderPage({
      matches: [line("f3"), line("f2", { result: "live" }), line("f1", { result: "lost" })],
    });
    expect(slabId(html)).toBe("f2");
    expect(rowIds(html)).toEqual(["f3", "f1"]);
    expect(html).toContain('data-testid="mh-player-slab-live"');
    expect(html).toContain('data-testid="mh-player-updated-at"');
  });

  it("no live line → no live pill and no freshness line on the slab (the positive pair above)", async () => {
    const { html } = await renderPage({ matches: [line("f3"), line("f2"), line("f1")] });
    expect(html).not.toContain('data-testid="mh-player-slab-live"');
    expect(html).not.toContain('data-testid="mh-player-updated-at"');
    expect(html).toContain('data-testid="mh-player-slab-result-won"');
  });

  it("the division chip appears when the lines span TWO divisions", async () => {
    const { html } = await renderPage({
      matches: [line("f3"), line("f2", { divisionSlug: "sunday", divisionName: "Sunday League" }), line("f1")],
    });
    expect(html).toContain('data-testid="mh-player-division-chip"');
    expect(html).toContain(">Sunday League<");
  });

  it("…and not when every line is in ONE division", async () => {
    const { html } = await renderPage({ matches: [line("f3"), line("f2"), line("f1")] });
    expect(html).not.toContain('data-testid="mh-player-division-chip"');
  });

  it("every match link — slab and rows — goes to that fixture's match centre and clears the 44 px floor", async () => {
    const { html } = await renderPage({ matches: [line("f3"), line("f2"), line("f1")] });
    for (const id of ["f3", "f2", "f1"]) {
      const tag = html.match(new RegExp(`<a[^>]*data-testid="mh-player-match-${id}"[^>]*>`))?.[0] ?? "";
      expect(tag).toContain(`href="${HUB}/premier/fixtures/${id}"`);
      expect(tag).toMatch(/class="[^"]*\bmin-h-11\b/);
    }
  });

  it("the breadcrumb and the stats division link clear the 44 px floor too (R11)", async () => {
    const { html } = await renderPage();
    const crumb = html.match(/<nav[^>]*>\s*(<a [^>]*>)/)?.[1] ?? "";
    expect(crumb, "breadcrumb link rendered").toContain(`href="${HUB}"`);
    expect(crumb).toMatch(/class="[^"]*\bmin-h-11\b/);
    const statsLink = section(html, "player-stats").match(/<a [^>]*>/)?.[0] ?? "";
    expect(statsLink, "stats division link rendered").toContain(`href="${HUB}?tab=table"`);
    expect(statsLink).toMatch(/class="[^"]*\bmin-h-11\b/);
  });

  it("the slab is the page's ONE lifted object: the photo avatar carries no shadow (P7)", async () => {
    stub.getPublicPlayer.mockResolvedValue({
      ...data({ matches: [line("f2"), line("f1")] }),
      player: { id: PERSON, org_id: "o1", name: "Ada Lovelace", photo: "https://img.example/ada.jpg" },
    });
    const html = renderToStaticMarkup((await Page({ params })) as ReactElement);
    const avatar = html.match(/<img [^>]*>/)?.[0] ?? "";
    expect(avatar, "photo avatar rendered").toContain('src="https://img.example/ada.jpg"');
    expect(avatar).not.toMatch(/class="[^"]*shadow/);
    // Positive pair: the slab still lifts, and it is the only thing that does.
    expect(html.match(/\bshadow(?:-[a-z0-9]+)?\b/g)).toEqual(["shadow-lg"]);
  });

  it("the freshness line counts from getPublicPlayer's cached read, not from the render (F9)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(RENDER_AT));
    const { html } = await renderPage({ matches: [line("f2", { result: "live" }), line("f1")] });
    const updated = html.match(/data-testid="mh-player-updated-at"[^>]*>([^<]*)</)?.[1];
    expect(updated).toBe(en["matchCentre.updatedAgo"].replace("{seconds}", "40"));
  });

  it("hands the island the page's own lines, the ORG's locale and a dictionary SLICE — never the whole dictionary", async () => {
    const matches = [line("f2", { result: "live" }), line("f1")];
    const { tree } = await renderPage({ locale: "es", matches });
    const island = walk(tree).find((el) => el.type === PlayerMatches);
    expect(island, "PlayerMatches is mounted").toBeDefined();
    const props = propsOf(island!);
    expect((props.initial as { matches: unknown }).matches).toEqual(matches);
    // The CACHED read's instant, not this render's: the lines are as old as
    // the entry they came from.
    expect((props.initial as { generatedAt: string }).generatedAt).toBe(CACHED_AT);
    expect(props.locale).toBe("es");
    expect(props.personId).toBe(PERSON);
    expect(props.dict).toEqual(playerMatchesDict(es as Dict));
    expect(Object.keys(props.dict as Dict).length).toBeLessThan(Object.keys(es).length / 50);
  });
});

describe("player page — composition", () => {
  it("section order is Matches, Career, Stats, then In this competition", async () => {
    const { html } = await renderPage({
      matches: [line("f1")],
      career: [
        { sport_key: "cricket", sport_label: "Cricket", meta: "2 divisions", metrics: [{ key: "runs", label: "Runs", value: 200 }], divisions: 2, variants: 1, matches: 4 },
      ],
    });
    const at = (id: string) => html.indexOf(`data-testid="${id}"`);
    expect(at("mh-player-matches")).toBeGreaterThan(-1);
    expect(at("mh-player-matches")).toBeLessThan(at("player-career"));
    expect(at("player-career")).toBeLessThan(at("player-stats"));
    expect(at("player-stats")).toBeLessThan(at("player-squad"));
  });

  it("two columns from lg: Upcoming and Matches share the 7-span column, the rest stacks in 5 — one DOM", async () => {
    const { html } = await renderPage({ matches: [line("f1")], upcoming: [upcomingRow("u1")] });
    const at = (id: string) => html.indexOf(`data-testid="${id}"`);
    expect(html).toMatch(/class="[^"]*\blg:grid-cols-12\b/);
    expect(html).toMatch(/data-testid="player-main-column" class="[^"]*\blg:col-span-7\b/);
    expect(at("player-main-column")).toBeLessThan(at("mh-player-upcoming"));
    expect(at("mh-player-upcoming")).toBeLessThan(at("mh-player-matches"));
    expect(html).toMatch(/class="[^"]*\blg:col-span-5\b/);
    expect(html.search(/class="[^"]*\blg:col-span-5\b/)).toBeGreaterThan(at("mh-player-matches"));
  });

  it("section titles are Barlow 16 px uppercase ink (P3), not the tracked Geist eyebrow", async () => {
    const { html } = await renderPage({ matches: [line("f1")] });
    const h2s = [...html.matchAll(/<h2 class="([^"]*)"/g)].map((m) => m[1]);
    expect(h2s.length).toBe(3); // Matches, Stats, In this competition (no career here)
    for (const cls of h2s) {
      expect(cls).toBe("mb-3 font-display text-base font-semibold uppercase tracking-wide text-ink");
    }
    expect(html).not.toContain("tracking-[0.18em]");
  });

  it("stat labels are not uppercase, and the stat, career and squad cards carry no shadow (P7)", async () => {
    const { html } = await renderPage({
      career: [
        { sport_key: "cricket", sport_label: "Cricket", meta: "2 divisions", metrics: [{ key: "runs", label: "Runs", value: 200 }], divisions: 2, variants: 1, matches: 4 },
      ],
    });
    const dts = [...html.matchAll(/<dt class="([^"]*)"/g)].map((m) => m[1]);
    expect(dts.length).toBe(2);
    for (const cls of dts) expect(cls).toBe("text-xs text-ink-muted");
    for (const id of ["player-career", "player-stats", "player-squad"]) {
      expect(section(html, id), id).not.toContain("shadow");
    }
  });
});

describe("player page — In this competition", () => {
  it("each membership is its own link card of separate elements — no dash or middle-dot sentence", async () => {
    const { html } = await renderPage();
    const squad = section(html, "player-squad");
    expect(squad).toContain(">Riverside Blue<");
    expect(squad).toContain(">Premier<");
    expect(squad).toContain(">#7<");
    expect(squad).toContain(">Wicketkeeper<");
    // The old composition: "Premier — Riverside Blue · #7 · Wicketkeeper".
    expect(squad).not.toMatch(/ — | · /);
  });

  it("the squad number chip is omitted when there is none, and the position when there is none", async () => {
    const { html } = await renderPage({
      memberships: [{ division_name: "Premier", division_slug: "premier", entrant_name: "Riverside Blue", squad_number: null, position: null }],
    });
    const squad = section(html, "player-squad");
    expect(squad).toContain(">Riverside Blue<");
    expect(squad).not.toContain(">#");
    expect(squad).not.toContain('data-testid="player-squad-number"');
    expect(squad).not.toContain('data-testid="player-squad-position"');
  });

  it("the squad card links to the competition hub's Teams tab and the stats division to its Table tab — never the division page", async () => {
    const { html } = await renderPage();
    const squadLink = section(html, "player-squad").match(/<a [^>]*>/)?.[0] ?? "";
    expect(squadLink).toContain(`href="${HUB}?tab=teams"`);
    expect(squadLink).toMatch(/class="[^"]*\bmin-h-11\b/);
    expect(section(html, "player-stats")).toContain(`href="${HUB}?tab=table"`);
    expect(html).not.toContain(`href="${HUB}/premier"`);
  });

  it("no memberships → the no-squad sentence", async () => {
    const { html } = await renderPage({ memberships: [] });
    expect(section(html, "player-squad")).toContain(`>${esc(en["player.noSquad"])}<`);
  });
});

describe("player page — the org's locale, from the dictionary", () => {
  it("es renders every heading and the empty copy from the es dictionary", async () => {
    const { html } = await renderPage({ locale: "es", matches: [], memberships: [] });
    for (const k of ["player.matches", "player.inThisCompetition", "player.stats", "player.noSquad", "player.matches.empty"] as const) {
      expect(html, k).toContain(`>${esc(es[k])}<`);
      // The negative half only where the two differ and neither contains the
      // other, so it cannot red on a correct page.
      if (!es[k].includes(en[k]) && !en[k].includes(es[k])) {
        expect(html, k).not.toContain(`>${esc(en[k])}<`);
      }
    }
  });

  it("the opponent is phrased by the locale ('v' is English)", async () => {
    const { html } = await renderPage({ locale: "es", matches: [line("f2"), line("f1")] });
    expect(html).toContain(`>${esc(es["player.opponent"].replace("{opponent}", "Opponent f2"))}<`);
    expect(html).toContain(`>${esc(es["player.opponent"].replace("{opponent}", "Opponent f1"))}<`);
  });
});

// The description is the ORG's locale, like every visible word on the page:
// `playerMetaDescription` takes the page's `public` dictionary, and it is a
// required argument, so a caller that forgets it does not compile
// (`lib/__tests__/public-meta.test.ts`). This is the page half: the dictionary
// it passes is the org's, not English. Compared with that locale's own
// dictionary value, never an English literal.
describe("player page — generateMetadata", () => {
  const meta = () => generateMetadata({ params });
  const sentence = (d: Record<string, string>) =>
    d["player.metaDescription"]!.replace("{player}", "Ada Lovelace").replace("{competition}", "Autumn Cup");

  it("premise: the es and en sentences differ, so the es assertion below can witness an English fallback", () => {
    expect(sentence(es)).not.toBe(sentence(en));
    expect(sentence(es)).not.toMatch(/\{\w+\}/);
  });

  it("es: the description is the es dictionary's sentence, not the English one", async () => {
    stub.getPublicPlayer.mockResolvedValue(data({ locale: "es" }));
    const { description } = await meta();
    expect(description).toBe(sentence(es));
    expect(description).not.toBe(sentence(en));
  });

  it("en: the description is the en dictionary's sentence (positive pair)", async () => {
    stub.getPublicPlayer.mockResolvedValue(data({ locale: "en" }));
    expect((await meta()).description).toBe(sentence(en));
  });

  it("titles the page with the player and the competition", async () => {
    stub.getPublicPlayer.mockResolvedValue(data({ locale: "es" }));
    expect((await meta()).title).toBe("Ada Lovelace — Autumn Cup");
  });

  it("a person getPublicPlayer refuses gets no metadata", async () => {
    stub.getPublicPlayer.mockResolvedValue(null);
    expect(await meta()).toEqual({});
  });
});

describe("player page — contract", () => {
  it("a person getPublicPlayer refuses is a 404", async () => {
    stub.getPublicPlayer.mockResolvedValue(null);
    await expect(Page({ params })).rejects.toThrow("CALLED_NOT_FOUND");
  });

  it("keeps its ISR exports", async () => {
    expect(revalidate).toBe(300);
    expect(await generateStaticParams()).toEqual([]);
  });
});

const upcomingRow = (fixtureId: string, over: Partial<PlayerUpcomingRow> = {}): PlayerUpcomingRow => ({
  fixtureId,
  href: `${HUB}/premier/fixtures/${fixtureId}`,
  scheduledAt: "2030-07-01T10:00:00.000Z",
  tz: "Europe/London",
  venue: null,
  courtLabel: null,
  opponentLabel: `Opponent ${fixtureId}`,
  competitionName: "Autumn Cup",
  competitionSlug: "autumn-cup",
  divisionName: "Premier",
  divisionSlug: "premier",
  isOtherCompetition: false,
  ...over,
});

describe("player page — Upcoming", () => {
  it("EMPTY: no rows, no section — and the read was for THIS card's org, competition and player", async () => {
    const { html } = await renderPage({ upcoming: [] });
    expect(html).not.toContain('data-testid="mh-player-upcoming"');
    // No orphan heading either (the positive pair is the next test).
    expect(html).not.toContain(`>${esc(en["player.upcoming"])}<`);
    expect(stub.getPublicPlayerUpcoming).toHaveBeenCalledWith(
      expect.objectContaining({
        org: expect.objectContaining({ id: "o1", slug: "riverside" }),
        competition: expect.objectContaining({ id: "c1" }),
        personId: PERSON,
      }),
    );
  });

  it("with rows: its own section, titled from the dictionary, ABOVE Matches", async () => {
    const { html } = await renderPage({ upcoming: [upcomingRow("u1")], matches: [line("f1")] });
    const upcoming = section(html, "mh-player-upcoming");
    expect(upcoming).toContain(`>${esc(en["player.upcoming"])}<`);
    // A real section heading, styled like its siblings (P3) — not a bare label.
    expect(upcoming).toContain(
      `<h2 class="mb-3 font-display text-base font-semibold uppercase tracking-wide text-ink">${esc(en["player.upcoming"])}</h2>`,
    );
    expect(upcoming).toContain('data-testid="mh-player-upcoming-row-u1"');
    expect(html.indexOf('data-testid="mh-player-upcoming"')).toBeLessThan(html.indexOf('data-testid="mh-player-matches"'));
  });

  it("an es org's heading is the es dictionary's own word", async () => {
    expect(es["player.upcoming"], "premise: es differs from en").not.toBe(en["player.upcoming"]);
    const { html } = await renderPage({ locale: "es", upcoming: [upcomingRow("u1")] });
    expect(section(html, "mh-player-upcoming")).toContain(`>${esc(es["player.upcoming"])}<`);
  });

  it("the list is handed the ORG's dictionary AND locale: an es row is phrased and dated in es", async () => {
    const month = (tag: string) =>
      new Intl.DateTimeFormat(tag, { timeZone: "Europe/London", month: "short" }).format(new Date("2030-07-01T10:00:00.000Z"));
    expect(month("es"), "premise: the es month differs from the en-GB one").not.toBe(month("en-GB"));
    expect(es["player.opponent"], "premise: es phrases the opponent differently").not.toBe(en["player.opponent"]);
    const upcoming = section((await renderPage({ locale: "es", upcoming: [upcomingRow("u1")] })).html, "mh-player-upcoming");
    expect(upcoming).toContain(`>${esc(es["player.opponent"].replace("{opponent}", "Opponent u1"))}<`);
    expect(upcoming).toContain(`>${esc(month("es"))}<`);
    expect(upcoming).not.toContain(`>${esc(month("en-GB"))}<`);
  });

  it("more than five: ONE list of the first five, then a collapsed Show-more BUTTON below it — no <details> (owner request 2026-09-23)", async () => {
    const rows = ["u1", "u2", "u3", "u4", "u5", "u6", "u7"].map((id) => upcomingRow(id));
    const upcoming = section((await renderPage({ upcoming: rows })).html, "mh-player-upcoming");
    expect([...upcoming.matchAll(/data-testid="mh-player-upcoming-row-([^"]+)"/g)].map((m) => m[1])).toEqual([
      "u1",
      "u2",
      "u3",
      "u4",
      "u5",
    ]);
    expect(upcoming.match(/<ul\b/g)).toHaveLength(1);
    expect(upcoming).not.toMatch(/<details\b|<summary\b/);
    const listId = upcoming.match(/<ul id="([^"]+)"/)?.[1];
    expect(listId, "the list carries the id the button controls").toBeTruthy();
    const toggle = upcoming.match(/<button [^>]*data-testid="mh-player-upcoming-more"[^>]*>([^<]*)<\/button>/);
    expect(toggle, "the toggle is a real <button>").not.toBeNull();
    expect(toggle![0]).toContain('type="button"');
    expect(toggle![0]).toContain('aria-expanded="false"');
    expect(toggle![0]).toContain(`aria-controls="${listId}"`);
    expect(toggle![1]).toBe(esc(en["player.upcoming.showMore"].replace("{count}", "2")));
    expect(upcoming.indexOf("<button")).toBeGreaterThan(upcoming.indexOf("</ul>"));
  });

  it("a refused card reads nothing: notFound fires before the upcoming read", async () => {
    stub.getPublicPlayer.mockResolvedValue(null);
    await expect(Page({ params })).rejects.toThrow("CALLED_NOT_FOUND");
    expect(stub.getPublicPlayerUpcoming).not.toHaveBeenCalled();
  });

  it("Matches is unchanged beside it: same slab and rows with or without Upcoming (regression)", async () => {
    const lines = [line("f3"), line("f2", { result: "lost" }), line("f1", { result: "drawn" })];
    const without = (await renderPage({ matches: lines })).html;
    const withRows = (await renderPage({ matches: lines, upcoming: [upcomingRow("u1")] })).html;
    expect(section(withRows, "mh-player-matches")).toBe(section(without, "mh-player-matches"));
  });
});
