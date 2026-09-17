// Spectator surface W2, Task 14 — the player page's match lines update IN PLACE
// while the page is open (R10), through ONE poll.
//
// Driven through the shared `_hook-harness` (`renderIsland`) with fake timers,
// the way `use-live-competition.test.tsx` drives the hub: the island itself is
// mounted, so what is asserted is the TEXT a spectator reads after a tick, not
// a hook's return value that the markup might ignore. `fetchPlayerMatches` is
// mocked here; its URL and `no-store` contract are pinned on the real `api()`
// in `player-matches-data.test.ts`, because an assertion on fetch's call shape
// made against this mock would pass with the URL spelled any way at all.
//
// Cadence is witnessed by COUNTING FETCHES across time, not by spying on
// `setInterval`: the island also runs a clock for its "Updated Ns ago" line,
// and a spy that reads interval lengths cannot tell that clock from the poll.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "@seazn/engine/sports";
import { renderToStaticMarkup } from "react-dom/server";
import { t as tDict } from "@/lib/i18n-runtime";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { intlLocaleFor } from "@/lib/public-date-locale";
import type { PlayerMatchLineT, PublicPlayerMatchesT } from "@/server/public-site/player-matches-schema";

vi.mock("../player-matches-data", () => ({ fetchPlayerMatches: vi.fn() }));

import { fetchPlayerMatches } from "../player-matches-data";
import { PlayerMatches, type PlayerMatchesProps } from "../player-matches";
import { HUB_IDLE_POLL_MS, HUB_POLL_MS } from "../use-live-competition";

const PERSON = "11111111-2222-3333-4444-555555555555";
const HELD_AT = "2026-09-05T12:00:00.000Z";

const line = (fixtureId: string, figures: string, over: Partial<PlayerMatchLineT> = {}): PlayerMatchLineT => ({
  fixtureId,
  href: `/shared/riverside/autumn-cup/premier/fixtures/${fixtureId}`,
  divisionName: "Premier",
  divisionSlug: "premier",
  scheduledAt: "2026-09-05T10:00:00.000Z",
  tz: "Europe/London",
  opponentName: "Queens",
  line: figures,
  result: "won",
  ...over,
});

const doc = (matches: PlayerMatchLineT[], generatedAt = HELD_AT): PublicPlayerMatchesT => ({ matches, generatedAt });

const LIVE = () => doc([line("f2", "54 (40)", { result: "live" }), line("f1", "12 (9)", { result: "lost" })]);
const IDLE = () => doc([line("f2", "54 (40)", { result: "won" }), line("f1", "12 (9)", { result: "lost" })]);

function mount(initial: PublicPlayerMatchesT) {
  const props: PlayerMatchesProps = {
    orgSlug: "riverside",
    competitionSlug: "autumn-cup",
    personId: PERSON,
    initial,
    dict: en as Dict,
    locale: "en",
  };
  return renderIsland(PlayerMatches, props);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-05T12:00:05.000Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("PlayerMatches — live means live", () => {
  it("a poll that returns a changed line re-renders that figure in place, with no reload", async () => {
    vi.mocked(fetchPlayerMatches).mockResolvedValue(
      doc([line("f2", "61 (44)", { result: "live" }), line("f1", "12 (9)", { result: "lost" })], "2026-09-05T12:00:15.000Z"),
    );
    const island = mount(LIVE());
    expect(island.text()).toContain("54 (40)");
    expect(island.text()).not.toContain("61 (44)");

    await vi.advanceTimersByTimeAsync(HUB_POLL_MS);

    expect(fetchPlayerMatches).toHaveBeenCalledWith("riverside", "autumn-cup", PERSON);
    expect(island.text()).toContain("61 (44)");
    expect(island.text()).not.toContain("54 (40)");
    // The untouched line is still there: a whole-document replace, not a wipe.
    expect(island.text()).toContain("12 (9)");
  });

  it("a match that finishes between ticks loses its live pill on the next poll", async () => {
    vi.mocked(fetchPlayerMatches).mockResolvedValue(
      doc([line("f2", "54 (40)", { result: "won" }), line("f1", "12 (9)", { result: "lost" })], "2026-09-05T12:00:15.000Z"),
    );
    const island = mount(LIVE());
    expect(island.text()).toContain(en["player.result.live"]);

    await vi.advanceTimersByTimeAsync(HUB_POLL_MS);

    expect(island.text()).not.toContain(en["player.result.live"]);
    expect(island.text()).toContain(en["player.result.won"]);
  });

  it("a failed poll keeps the lines the page already shows", async () => {
    vi.mocked(fetchPlayerMatches).mockRejectedValue(new Error("offline"));
    const island = mount(LIVE());
    await expect(vi.advanceTimersByTimeAsync(HUB_POLL_MS)).resolves.not.toThrow();
    expect(island.text()).toContain("54 (40)");
  });

  it("a response built BEFORE the document held is not applied (R10 C1)", async () => {
    vi.mocked(fetchPlayerMatches).mockResolvedValue(
      doc([line("f2", "10 (8)", { result: "live" })], "2026-09-05T11:59:00.000Z"),
    );
    const island = mount(LIVE());
    await vi.advanceTimersByTimeAsync(HUB_POLL_MS);
    expect(fetchPlayerMatches).toHaveBeenCalledTimes(1);
    expect(island.text()).toContain("54 (40)");
    expect(island.text()).not.toContain("10 (8)");
  });
});

/** The fixture ids of the slab and of the rows, read from the rendered
 *  match links: the slab is the one carrying `data-slab`. */
function layout(island: ReturnType<typeof mount>) {
  const links = island
    .tree()
    .map(propsOf)
    .filter((p) => typeof p["data-testid"] === "string" && (p["data-testid"] as string).startsWith("mh-player-match-"));
  const id = (p: Record<string, unknown>) => (p["data-testid"] as string).slice("mh-player-match-".length);
  return {
    slab: links.filter((p) => p["data-slab"] === "true").map(id),
    rows: links.filter((p) => p["data-slab"] === undefined).map(id),
  };
}

describe("PlayerMatches — the slab follows the live match", () => {
  it("a poll where a DIFFERENT fixture goes live moves the slab to it, and the old slab fixture becomes a row", async () => {
    const before = doc([
      line("f3", "8 (11)", { result: "won" }),
      line("f2", "", { result: null }),
      line("f1", "12 (9)", { result: "lost" }),
    ]);
    vi.mocked(fetchPlayerMatches).mockResolvedValue(
      doc(
        [line("f3", "8 (11)", { result: "won" }), line("f2", "17 (12)", { result: "live" }), line("f1", "12 (9)", { result: "lost" })],
        "2026-09-05T12:01:00.000Z",
      ),
    );
    const island = mount(before);
    expect(layout(island)).toEqual({ slab: ["f3"], rows: ["f2", "f1"] });
    expect(island.text()).not.toContain(en["player.result.live"]);

    // Nothing live yet, so the next fetch is the idle one.
    await vi.advanceTimersByTimeAsync(HUB_IDLE_POLL_MS);

    expect(fetchPlayerMatches).toHaveBeenCalledTimes(1);
    expect(layout(island)).toEqual({ slab: ["f2"], rows: ["f3", "f1"] });
    const slabPill = island.tree().map(propsOf).find((p) => p["data-testid"] === "mh-player-slab-live");
    expect(slabPill, "the moved slab carries the live pill").toBeDefined();
    expect(island.text()).toContain("17 (12)");
  });
});

describe("PlayerMatches — the older-response guard compares SERVER clocks (F9)", () => {
  // The seed's `generatedAt` is the server's cached-read instant and every
  // poll document's is the server's build instant. The viewer's clock is in
  // neither: here it runs five minutes FAST, so a guard that measured a
  // document against `Date.now()` would refuse every fresh one.
  it("a Redis document built BEFORE the seed is dropped; one built AFTER it is kept, whatever the viewer's clock says", async () => {
    vi.setSystemTime(new Date("2026-09-05T12:05:00.000Z"));
    vi.mocked(fetchPlayerMatches)
      .mockResolvedValueOnce(doc([line("f2", "40 (30)", { result: "live" })], "2026-09-05T11:59:50.000Z"))
      .mockResolvedValueOnce(doc([line("f2", "61 (44)", { result: "live" })], "2026-09-05T12:00:10.000Z"));
    const island = mount(LIVE());

    await vi.advanceTimersByTimeAsync(HUB_POLL_MS);
    expect(fetchPlayerMatches).toHaveBeenCalledTimes(1);
    expect(island.text(), "built 10 s before the seed").not.toContain("40 (30)");
    expect(island.text()).toContain("54 (40)");

    await vi.advanceTimersByTimeAsync(HUB_POLL_MS);
    expect(fetchPlayerMatches).toHaveBeenCalledTimes(2);
    expect(island.text(), "built 10 s after the seed").toContain("61 (44)");
    expect(island.text()).not.toContain("54 (40)");
  });
});

describe("PlayerMatches — one poll, at the hub's cadence", () => {
  it("with a live line it polls every HUB_POLL_MS", async () => {
    vi.mocked(fetchPlayerMatches).mockResolvedValue(LIVE());
    mount(LIVE());
    await vi.advanceTimersByTimeAsync(HUB_POLL_MS);
    expect(fetchPlayerMatches).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HUB_POLL_MS);
    expect(fetchPlayerMatches).toHaveBeenCalledTimes(2);
  });

  it("with nothing live it does NOT poll at the live cadence — only every HUB_IDLE_POLL_MS", async () => {
    vi.mocked(fetchPlayerMatches).mockResolvedValue(IDLE());
    mount(IDLE());
    await vi.advanceTimersByTimeAsync(HUB_POLL_MS);
    expect(fetchPlayerMatches).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HUB_IDLE_POLL_MS - HUB_POLL_MS);
    expect(fetchPlayerMatches).toHaveBeenCalledTimes(1);
  });

  // One instance driven across the boundary. Two separately mounted hooks
  // only witness the cadence each was BORN with — the hub's own suite records
  // a dropped `hasLive` dependency surviving exactly that.
  it("re-arms the cadence when the last live line finishes", async () => {
    vi.mocked(fetchPlayerMatches).mockResolvedValue(doc(IDLE().matches, "2026-09-05T12:00:15.000Z"));
    mount(LIVE());
    await vi.advanceTimersByTimeAsync(HUB_POLL_MS);
    expect(fetchPlayerMatches).toHaveBeenCalledTimes(1);
    // Now idle: another live-cadence tick must NOT fetch.
    await vi.advanceTimersByTimeAsync(HUB_POLL_MS);
    expect(fetchPlayerMatches).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HUB_IDLE_POLL_MS - HUB_POLL_MS);
    expect(fetchPlayerMatches).toHaveBeenCalledTimes(2);
  });

  it("unmount stops polling", async () => {
    vi.mocked(fetchPlayerMatches).mockResolvedValue(LIVE());
    const island = mount(LIVE());
    island.unmount();
    await vi.advanceTimersByTimeAsync(HUB_IDLE_POLL_MS * 2);
    expect(fetchPlayerMatches).not.toHaveBeenCalled();
  });
});

describe("PlayerMatches — the freshness line counts from the DOCUMENT's clock", () => {
  it("while live it reads the seconds since `generatedAt`, and it advances", async () => {
    const island = mount(LIVE());
    // System time is HELD_AT + 5 s.
    expect(island.text()).toContain("Updated 5s ago");
    vi.mocked(fetchPlayerMatches).mockRejectedValue(new Error("offline"));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(island.text()).toContain("Updated 8s ago");
  });

  it("with nothing live there is no freshness line (positive pair above)", () => {
    const island = mount(IDLE());
    expect(island.text()).not.toContain("Updated");
  });
});

// The owner's day-month ruling (2026-09-16, `lib/public-date-locale.ts`): an
// English org's dates read "5 Sept", never the US "Sep 5" that bare "en" gives
// `Intl`. Every other locale keeps its own format. The slab is where the ORDER
// shows — a row puts day and month in separate elements — so the order is
// asserted there and the month word on a row.
//
// Expected strings are derived from `Intl` through `intlLocaleFor`, with the
// venue zone pinned in the options (the worker's TZ is not something a test can
// move), plus ONE literal so the day-month order itself is witnessed. Markup is
// read through `renderToStaticMarkup` and anchored on `>…<`, so a string that
// merely contains the expected one cannot pass.
describe("PlayerMatches — dates in the org's locale, day-month for English", () => {
  const TZ = "Europe/London";
  const AT = "2026-09-05T10:00:00.000Z";
  const SLAB: Intl.DateTimeFormatOptions = { timeZone: TZ, weekday: "short", day: "numeric", month: "short" };
  const MONTH: Intl.DateTimeFormatOptions = { timeZone: TZ, month: "short" };
  const fmt = (tag: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(tag, opts).format(Date.parse(AT));

  const markup = (locale: Locale, dict: Dict) =>
    renderToStaticMarkup(
      <PlayerMatches
        orgSlug="riverside"
        competitionSlug="autumn-cup"
        personId={PERSON}
        initial={doc([
          line("f2", "54 (40)", { scheduledAt: AT, tz: TZ }),
          line("f1", "12 (9)", { scheduledAt: AT, tz: TZ, result: "lost" }),
        ])}
        dict={dict}
        locale={locale}
      />,
    );

  it("premise: bare en and intlLocaleFor(en) really differ, in the slab and in the month word", () => {
    expect(intlLocaleFor("en")).not.toBe("en");
    expect(fmt(intlLocaleFor("en"), SLAB)).not.toBe(fmt("en", SLAB));
    expect(fmt(intlLocaleFor("en"), MONTH)).not.toBe(fmt("en", MONTH));
  });

  it("en: the slab reads day-month — 'Sat 5 Sept', not the US 'Sat, Sep 5'", () => {
    const html = markup("en", en as Dict);
    expect(html).toContain(">Sat 5 Sept<");
    expect(html).toContain(`>${fmt(intlLocaleFor("en"), SLAB)}<`);
    expect(html).not.toContain(`>${fmt("en", SLAB)}<`);
  });

  it("en: a row's month word is the day-month locale's ('Sept'), not bare en's ('Sep')", () => {
    const html = markup("en", en as Dict);
    expect(html).toContain(`>${fmt(intlLocaleFor("en"), MONTH)}<`);
    expect(html).not.toContain(`>${fmt("en", MONTH)}<`);
  });

  it("es: keeps its own format, in the slab and on a row (positive pair: not the English one)", () => {
    expect(intlLocaleFor("es")).toBe("es");
    const html = markup("es", es as Dict);
    expect(html).toContain(`>${fmt("es", SLAB)}<`);
    expect(html).toContain(`>${fmt("es", MONTH)}<`);
    expect(fmt("es", SLAB)).not.toBe(fmt(intlLocaleFor("en"), SLAB));
    expect(html).not.toContain(`>${fmt(intlLocaleFor("en"), SLAB)}<`);
  });
});

// R11 screenshot run (2026-09-16), Chromium at 320: the live slab's score broke
// as "1 — 0 · 21–17 (11–" / "9)" — Chromium may wrap after an en dash, so a
// plain text run splits a score inside itself — and on a row the long badminton
// line "2 — 0 · 21–15, 21–18" took the auto column and squeezed the opponent to
// "V PRI…" and the division chip to "ME…".
//
// No layout exists in this vitest, so what is pinned is the break STRUCTURE the
// markup hands the browser: every character of a score sits in a `nowrap` run,
// the only breakable text is a single space between runs, each " · " part is
// its own inline-block (so a line breaks between parts before it breaks inside
// one), and no run boundary falls inside a score. The browser measurements —
// line counts and where each line breaks, at 320/390/768/1024/1280 — are the
// fix round's probe. The lines are not typed here: they are every headline the
// engine's own `summary()` produces over its recorded golden states (each sport,
// in play and decided), plus the cricket figure line built from each locale's
// dictionary templates.
describe("PlayerMatches — a score breaks only between its parts (R11)", () => {
  const sportsDir = new URL("../../../../../../packages/engine/src/sports/", import.meta.url);
  const headlines = (() => {
    const byShape = new Map<string, Set<string>>();
    for (const file of (readdirSync(sportsDir, { recursive: true }) as string[]).filter((f) => f.endsWith(".golden.json"))) {
      const corpus = JSON.parse(readFileSync(new URL(file, sportsDir), "utf8")) as {
        key: string;
        streams: { states: string[] }[];
      };
      const sport = builtinModules.find((m) => m.key === corpus.key);
      if (!sport) throw new Error(`no builtin module for the golden corpus "${corpus.key}"`);
      for (const stream of corpus.streams) {
        // A state is stored as JSON, or as a `#hash` of one; only JSON folds.
        for (const state of stream.states.filter((s) => s.startsWith("{"))) {
          const headline = (sport.summary(JSON.parse(state) as never) as { headline: string }).headline;
          // One per SHAPE (digits collapsed) keeps the corpus to its distinct
          // grammars; the shortest and the longest of each are both kept.
          const shape = headline.replace(/\d+/g, "9");
          const seen = byShape.get(shape) ?? new Set<string>();
          seen.add(headline);
          byShape.set(shape, seen);
        }
      }
    }
    const out: string[] = [];
    for (const seen of byShape.values()) {
      const sorted = [...seen].sort((a, b) => a.length - b.length);
      out.push(sorted[0]!, sorted.at(-1)!);
    }
    return [...new Set(out)];
  })();
  const cricketLines = [en, es].flatMap((d) =>
    [
      [102, 87, 10, 104],
      [0, 1, 0, 0],
    ].map(([runs, balls, wickets, conceded]) =>
      tDict(d as Dict, "player.line.cricket", {
        batting: tDict(d as Dict, "player.line.batting", { runs: runs!, balls: balls! }),
        bowling: tDict(d as Dict, "player.line.bowling", { wickets: wickets!, runs: conceded! }),
      }),
    ),
  );
  const LINES = [...headlines, ...cricketLines];

  const decode = (s: string) =>
    s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'");

  /** One element's inner markup, by testid, balanced over its own tag name. */
  const inner = (html: string, testid: string): string => {
    const at = html.indexOf(`data-testid="${testid}"`);
    expect(at, `${testid} is in the markup`).toBeGreaterThan(-1);
    const open = html.lastIndexOf("<", at);
    const tag = /^<([a-z]+)/.exec(html.slice(open))![1]!;
    let depth = 0;
    const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "g");
    re.lastIndex = open;
    for (let m = re.exec(html); m; m = re.exec(html)) {
      depth += m[1] ? -1 : 1;
      if (depth === 0) return html.slice(html.indexOf(">", open) + 1, m.index);
    }
    throw new Error(`${testid} never closes`);
  };

  /** The figures markup read the way the line breaker reads it. */
  function breakStructure(markup: string) {
    const parts: string[] = []; // each inline-block's text
    const runs: string[] = []; // each nowrap run's text
    const loose: string[] = []; // text outside any nowrap run
    const stack: string[][] = [];
    let text = "";
    for (const m of markup.matchAll(/<(\/?)span([^>]*)>|([^<]+)/g)) {
      if (m[3] !== undefined) {
        const chunk = decode(m[3]);
        text += chunk;
        if (stack.some((cls) => cls.includes("whitespace-nowrap"))) runs[runs.length - 1] += chunk;
        else loose.push(chunk);
        if (stack.length > 0 && parts.length > 0) parts[parts.length - 1] += chunk;
        continue;
      }
      if (m[1]) {
        stack.pop();
        continue;
      }
      const cls = /class="([^"]*)"/.exec(m[2] ?? "")?.[1]?.split(" ") ?? [];
      if (cls.includes("inline-block") && stack.length === 0) parts.push("");
      if (cls.includes("whitespace-nowrap")) runs.push("");
      stack.push(cls);
    }
    return { text, parts, runs, loose };
  }

  /** Why a break between two nowrap runs would split a score, or null. */
  function illegalBoundary(left: string, right: string, before: string): string | null {
    const depth = [...before].reduce((d, c) => d + ("([".includes(c) ? 1 : ")]".includes(c) ? -1 : 0), 0);
    if (depth !== 0) return "inside brackets";
    if (/[—–-]$/.test(left) || /^[—–-]/.test(right)) return "beside a dash";
    // A bracket may leave only a whole tally ("12 — 11" | "(10–9 pens)"), and
    // never as a bare count — that is a cricket innings' overs ("133/6 (9.4)").
    const tallyQualifier = / — \S+$/.test(left) && !/^\([\d.]+\)$/.test(right);
    if (/^[([]/.test(right) && !tallyQualifier) return "a bracketed qualifier leaves its score";
    if (/^&/.test(right)) return "a line starts with the joiner";
    if (/^[A-Za-z]+$/.test(left.split(" ").at(-1)!)) return "a label leaves the score it names";
    return null;
  }

  const render = (figures: string) =>
    renderToStaticMarkup(
      <PlayerMatches
        orgSlug="riverside"
        competitionSlug="autumn-cup"
        personId={PERSON}
        initial={doc([line("f2", figures, { result: "live" }), line("f1", figures, { result: "won" })])}
        dict={en as Dict}
        locale="en"
      />,
    );

  it("premise: the corpus is the engine's real grammar — set lists, tennis strips with tiebreaks and game points, shoot-outs, labels", () => {
    expect(LINES.some((l) => /^\d+ — \d+ · \d+–\d+, \d+–\d+, \d+–\d+/.test(l)), "a three-game list").toBe(true);
    expect(LINES.some((l) => /\d+–\d+\(\d+\)[^·]* · \d+–\d+ \((?:Ad–40|40–Ad|\d+–\d+)\)$/.test(l)), "tennis with a tiebreak and game points").toBe(true);
    expect(LINES.some((l) => /\(TB \d+–\d+\)$/.test(l)), "a tiebreak game").toBe(true);
    expect(LINES.some((l) => /· MTB \d+–\d+$/.test(l)), "a match tiebreak label").toBe(true);
    expect(LINES.some((l) => /\(\d+–\d+ pens\)$/.test(l)), "football pens").toBe(true);
    expect(LINES).toContain("vs");
    expect(LINES).toContain("102 (87) & 10/104");
    expect(LINES.length).toBeGreaterThan(60);
  });

  it.each(["mh-player-slab-figures", "mh-player-row-figures"])("%s: every line reads back verbatim, and only a single space between nowrap runs can break", (testid) => {
    const bad: string[] = [];
    for (const figures of LINES) {
      const s = breakStructure(inner(render(figures), testid));
      if (s.text !== figures) bad.push(`${figures}: reads back as "${s.text}"`);
      const stray = s.loose.filter((chunk) => chunk !== " ");
      if (stray.length > 0) bad.push(`${figures}: breakable text ${JSON.stringify(stray)}`);
    }
    expect(bad).toEqual([]);
  });

  it.each(["mh-player-slab-figures", "mh-player-row-figures"])("%s: each ' · ' part is its own inline-block, and a part breaks inside itself only between whole scores", (testid) => {
    const bad: string[] = [];
    for (const figures of LINES) {
      const s = breakStructure(inner(render(figures), testid));
      const expected = figures.split(" · ").map((part, i, all) => (i < all.length - 1 ? `${part} ·` : part));
      if (JSON.stringify(s.parts) !== JSON.stringify(expected)) bad.push(`${figures}: parts ${JSON.stringify(s.parts)}`);
      let before = "";
      for (const [i, run] of s.runs.entries()) {
        if (i > 0) {
          const why = illegalBoundary(s.runs[i - 1]!, run, before);
          if (why) bad.push(`${figures}: "${s.runs[i - 1]}" | "${run}" — ${why}`);
          before += " ";
        }
        before += run;
      }
    }
    expect(bad).toEqual([]);
  });

  it.each(["mh-player-slab-figures", "mh-player-row-figures"])("%s: a shoot-out after a two-digit tally is two runs, split before its bracket ('12 — 11' | '(10–9 pens)'); a cricket innings keeps its overs", (testid) => {
    // Glued, "12 — 11 (10–9 pens)" was one run 18.5px wider than the 256px
    // slab at 320 and "10 — 10 (12–11 pens)" 36.4px (Chromium, committed
    // Barlow Condensed Bold, review r11fix m1); the slab clipped both.
    const cases: [string, string[]][] = [
      ["12 — 11 (10–9 pens)", ["12 — 11", "(10–9 pens)"]],
      ["10 — 10 (12–11 pens)", ["10 — 10", "(12–11 pens)"]],
      ["3 — 3 (GWS 10–11)", ["3 — 3", "(GWS 10–11)"]],
      ["61/9 (20) — 35 (5)", ["61/9 (20) — 35 (5)"]],
      ["99/2 (14.4) — 133/6 (9.4)", ["99/2 (14.4) — 133/6 (9.4)"]],
    ];
    for (const [figures, runs] of cases) {
      const s = breakStructure(inner(render(figures), testid));
      expect(s.text, figures).toBe(figures);
      expect(s.runs, figures).toEqual(runs);
    }
  });

  it("the positive pair: a game list and a tennis strip keep a break point between each whole score (one nowrap run per score)", () => {
    const list = LINES.find((l) => /^\d+ — \d+ · \d+–\d+, \d+–\d+, \d+–\d+/.test(l))!;
    const runs = breakStructure(inner(render(list), "mh-player-slab-figures")).runs;
    expect(runs.filter((r) => r.endsWith(",")).length, `${list}: ${JSON.stringify(runs)}`).toBeGreaterThanOrEqual(2);
    const strip = "2 — 2 · 7–6(10) 6–7(12) 6–4 4–6 · 6–6 (TB 10–9)";
    expect(breakStructure(inner(render(strip), "mh-player-slab-figures")).runs).toEqual([
      "2 — 2 ·",
      "7–6(10)",
      "6–7(12)",
      "6–4",
      "4–6 ·",
      "6–6 (TB 10–9)",
    ]);
  });

  it("a row keeps schedule grammar (date | opponent | score) from md, and below md gives the score its own line under the opponent", () => {
    const html = render("2 — 0 · 21–15, 21–18");
    const rowTag = html.match(/<a[^>]*data-testid="mh-player-match-f1"[^>]*>/)?.[0] ?? "";
    const cls = (tag: string) => tag.match(/class="([^"]*)"/)?.[1]?.split(" ") ?? [];
    expect(cls(rowTag)).toEqual(
      expect.arrayContaining(["grid-cols-[3.25rem_minmax(0,1fr)]", "md:grid-cols-[3.25rem_minmax(0,1fr)_auto]"]),
    );
    expect(cls(rowTag)).not.toContain("grid-cols-[3.25rem_minmax(0,1fr)_auto]");
    // The date cell is the row's first in-flow child (f1 is not live, so no
    // live bar precedes it). Below md it spans both rows — the opponent's and
    // the score's — so the score line sits under the opponent, not the date.
    // Exact tokens: a substring probe for "row-span-2" also matches its
    // `max-md:` form (AGENTS.md).
    const rowAt = html.indexOf('data-testid="mh-player-match-f1"');
    const dateAt = html.indexOf("<span", rowAt);
    const dateTag = html.slice(dateAt, html.indexOf(">", dateAt) + 1);
    expect(cls(dateTag), dateTag).not.toContain("absolute");
    expect(html.slice(dateAt, html.indexOf("</span>", dateAt)), "the date cell holds the day").toMatch(/>\d{1,2}$/);
    expect(cls(dateTag)).toContain("max-md:row-span-2");
    expect(cls(dateTag)).not.toContain("row-span-2");
    const at = html.indexOf('data-testid="mh-player-row-figures"');
    const scoreTag = html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
    // Under the opponent on a phone, full width; the capped right-aligned
    // column only from md — an unprefixed cap is what squeezed the name.
    expect(cls(scoreTag)).toEqual(expect.arrayContaining(["max-md:col-start-2", "md:max-w-[10rem]", "md:text-right"]));
    expect(cls(scoreTag)).not.toContain("max-w-[10rem]");
    expect(cls(scoreTag)).not.toContain("text-right");
  });
});
