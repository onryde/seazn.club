// T16 fix round 1, I4 — the division Fixtures list's watch link (canvas WatchStatesDesktop A): "Watch live", the
// final position with its score, "Round not opened yet". Each is a LABEL inside its row's own link (the row opens
// the fixture page, where the watch panel is): never a link inside a link, never a Lichess URL. The words arrive
// finished, in the org's locale (publicWatchCopy over msgFor), as every other word of this client component does.
//
// Node render only (no DOM in apps/web vitest). Single-sport by construction: online play is boardgame only.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { msgFor } from "@/lib/messages-i18n";
import publicEn from "@/dictionaries/en/public.json";
import publicEs from "@/dictionaries/es/public.json";
import publicFr from "@/dictionaries/fr/public.json";
import publicNl from "@/dictionaries/nl/public.json";
import { publicWatchCopy } from "@/server/public-site/schedule-copy";
import type { PublicFixture } from "@/server/public-site/data";
import type { PublicWatchLink } from "@/server/external-play/public-view";
import { Schedule, timeOf, type ScheduleCopy } from "../schedule";
import { formatWatchTime } from "../match-centre/watch-parts";

const LOCALES = ["en", "es", "fr", "nl"] as const;
const F = (id: string, over: Partial<PublicFixture> = {}): PublicFixture => ({
  id,
  division_id: "d1",
  stage_id: "s1",
  pool_id: null,
  round_no: 1,
  seq_in_round: Number(id.slice(1)),
  home_entrant_id: "e1",
  away_entrant_id: "e2",
  home_slot_label: null,
  away_slot_label: null,
  scheduled_at: "2026-10-16T18:00:00.000Z",
  venue: null,
  court_label: null,
  venue_name: null,
  court_name: null,
  status: "scheduled",
  outcome: null,
  summary: null,
  last_seq: null,
  ...over,
});
const COPY: ScheduleCopy = {
  timeTbd: "(time tbd)", allEntrants: "(all)", live: "(live)", ended: "(ended)", tbd: "(tbd)", held: "(held)",
  filterLabel: "(filter)", viewLabel: "(view)", viewDay: "(day)", viewRound: "(round)", calendar: "(calendar)",
  timesIn: "(times in {zone})", empty: "(empty)", roundOpened: "(opened)",
};
const FIXTURES = [F("f1", { status: "in_play" }), F("f2", { status: "decided" }), F("f3"), F("f4")];
const LINKS: Record<string, PublicWatchLink> = {
  f1: { kind: "live" },
  f2: { kind: "final", score: "1–0" },
  f3: { kind: "not_opened" },
};
const esc = (x: string) => x.replaceAll("&", "&amp;").replaceAll("'", "&#x27;").replaceAll('"', "&quot;");
const render = (watch?: Parameters<typeof Schedule>[0]["watch"], fixtures = FIXTURES) =>
  renderToStaticMarkup(
    <Schedule
      fixtures={fixtures}
      entrantNames={{ e1: "Ada Okonkwo", e2: "Tomasz Wieczorek" }}
      divisionPath="/o/c/d"
      tz="Europe/London"
      slotLabels={{}}
      roundLabels={{}}
      stageOrder={{ s1: 1 }}
      stageNames={{ s1: "League" }}
      copy={COPY}
      locale="en"
      {...(watch ? { watch } : {})}
    />,
  );
/** The rail cell's two lines (the clock or status word, then the court/date line), as text. */
const railOf = (row: string): [string, string] => {
  const m = row.match(/<span class="row-span-2 flex min-w-0 flex-col items-start">(<span[^>]*>(?:<span[^>]*><\/span>)?([^<]*)<\/span>)<span[^>]*>([^<]*)<\/span><\/span>/);
  if (!m) throw new Error(`no rail cell in ${row.slice(0, 200)}`);
  return [m[2]!, m[3]!];
};
/** Each fixture row's own link, by its href. */
const rows = (html: string) =>
  Object.fromEntries([...html.matchAll(/<a [^>]*href="\/o\/c\/d\/fixtures\/(f\d)"[^>]*>([^]*?)<\/a>/g)].map((m) => [m[1]!, m[2]!]));

describe("Schedule — the online watch links (I4)", () => {
  it("the empty case first: no watch prop (every other division, the embed), or no links, adds nothing", () => {
    const copy = publicWatchCopy((k) => msgFor("en", k));
    for (const html of [render(), render({ links: {}, copy })]) {
      expect(html).not.toContain('data-testid="schedule-watch"');
      expect(Object.keys(rows(html)), "anti-vacuity: the rows still render").toHaveLength(FIXTURES.length);
    }
  });

  it("each kind, in its own words in all four locales, as a label INSIDE its row's link — the board with none has none", () => {
    let checked = 0;
    for (const loc of LOCALES) {
      const copy = publicWatchCopy((k) => msgFor(loc, k));
      const html = render({ links: LINKS, copy });
      const r = rows(html);
      expect(Object.keys(r), loc).toEqual(["f1", "f2", "f3", "f4"]);
      expect(r.f1, loc).toMatch(new RegExp(`data-testid="schedule-watch" data-kind="live"[^>]*>.*${esc(copy.live)}</span>`));
      expect(r.f2, loc).toMatch(new RegExp(`data-testid="schedule-watch" data-kind="final"[^>]*><span[^>]*>1–0</span>${esc(copy.final)}</span>`));
      expect(r.f3, loc).toMatch(new RegExp(`data-testid="schedule-watch" data-kind="not_opened"[^>]*>${esc(copy.notOpened)}</span>`));
      expect(r.f4, `${loc}: nothing to watch`).not.toContain("schedule-watch");
      // Never a link inside a link, never off to Lichess.
      expect(html.match(/<a /g)?.length, `${loc}: one link per row, plus the calendar`).toBe(FIXTURES.length + 1);
      expect(html).not.toMatch(/lichess\.org/);
      // The words are the org locale's own (the canvas's three), never a key.
      for (const w of [copy.live, copy.final, copy.notOpened]) {
        expect(w.trim().length > 0 && !w.startsWith("externalPlay."), `${loc}: ${w}`).toBe(true);
        if (loc !== "en") expect(w, `${loc}: translated`).not.toBe(publicWatchCopy((k) => msgFor("en", k))[Object.entries(copy).find(([, v]) => v === w)![0] as "live"]);
      }
      checked += 1;
    }
    expect(checked).toBe(4);
  });

  // T17 owner ruling (2026-10-13): Spanish reads "A punto de empezar" (was "Por empezar"); fr and nl stay as authored.
  // The list's label and the fixture page's scorebug chip are ONE word in every locale, so the two surfaces cannot
  // describe one board two ways.
  it("starting: the owner's words — es 'A punto de empezar', fr and nl unchanged — and the list says what the scorebug chip says, in every locale", () => {
    const OWNER: Record<(typeof LOCALES)[number], string> = { en: "Starting", es: "A punto de empezar", fr: "Va commencer", nl: "Begint zo" };
    const PUBLIC = { en: publicEn, es: publicEs, fr: publicFr, nl: publicNl } as Record<string, Record<string, string>>;
    let checked = 0;
    for (const loc of LOCALES) {
      const copy = publicWatchCopy((k) => msgFor(loc, k));
      expect(copy.starting, `${loc}: the list's label`).toBe(OWNER[loc]);
      expect(PUBLIC[loc]!["matchCentre.status.starting"], `${loc}: the scorebug chip`).toBe(OWNER[loc]);
      checked += 1;
    }
    expect(checked, "anti-vacuity: four locales").toBe(4);
  });

  // T17 owner change (2026-10-13): from the round's open until the first move the row says the board is starting —
  // between "Round not opened yet" (quiet text) and "Watch live" (a filled pill, a filled dot): an outlined pill and
  // an EMPTY ring.
  it("starting: its own label in all four locales — an outlined pill with a ring dot, inside its row's link", () => {
    const en = publicWatchCopy((k) => msgFor("en", k));
    let checked = 0;
    for (const loc of LOCALES) {
      const copy = publicWatchCopy((k) => msgFor(loc, k));
      expect(copy.starting.trim().length > 0 && !copy.starting.startsWith("externalPlay."), `${loc}: authored`).toBe(true);
      expect(copy.starting, `${loc}: not the live words`).not.toBe(copy.live);
      expect(copy.starting, `${loc}: not the not-opened words`).not.toBe(copy.notOpened);
      if (loc !== "en") expect(copy.starting, `${loc}: translated`).not.toBe(en.starting);
      const html = render({ links: { ...LINKS, f4: { kind: "starting" } }, copy });
      const r = rows(html);
      const label = r.f4!.match(/<span data-testid="schedule-watch" data-kind="starting" class="([^"]*)">(<span[^>]*><\/span>[^<]*)<\/span>/);
      expect(label, `${loc}: the starting label in row f4`).not.toBeNull();
      const [, cls, inner] = label! as unknown as [string, string, string];
      expect(cls, `${loc}: outlined, not filled`).toMatch(/\bborder-accent-line\b/);
      expect(cls, `${loc}: not the live pill's fill`).not.toMatch(/\bbg-accent\b/);
      expect(inner, `${loc}: a ring dot, then the words`).toMatch(new RegExp(`^<span aria-hidden="true" class="[^"]*\\bborder-current\\b[^"]*"></span>${esc(copy.starting)}$`));
      expect(inner, `${loc}: the dot is not filled`).not.toContain("bg-current");
      // The other rows are as before, and still one link per row.
      expect(r.f1, loc).toContain('data-kind="live"');
      expect(r.f3, loc).toContain('data-kind="not_opened"');
      expect(html.match(/<a /g)?.length, `${loc}: one link per row, plus the calendar`).toBe(FIXTURES.length + 1);
      checked += 1;
    }
    expect(checked).toBe(4);
  });

  // T17 fix round 4, V4 (coordinator ruling, as V1): an online board whose round is open and which has no scheduled
  // time shows WHEN THE ROUND OPENED in the rail, where it said "TBD" — the clock the fixture page's "Round opened
  // HH:MM" line prints (formatWatchTime), with the short word under it on the rail's second line. A board with a
  // real time keeps it; a decided or live row keeps its own word.
  it("V4: no time, its round open — the rail shows the round-open clock (the fixture page's own format) over 'Opened', never TBD; all four locales", () => {
    const OPENED = "2026-10-16T13:05:00.000Z"; // 14:05 in London (BST)
    let checked = 0;
    for (const loc of LOCALES) {
      const copy = publicWatchCopy((k) => msgFor(loc, k));
      const html = render({ links: {}, copy, roundOpenedAt: { f4: OPENED } }, FIXTURES.map((f) => (f.id === "f4" ? { ...f, scheduled_at: null } : f)));
      const rail = railOf(rows(html).f4!);
      const clock = formatWatchTime(OPENED, "Europe/London", loc, false);
      expect(clock, "premise: the fixture page's clock").toBe("14:05");
      expect(rail[0], `${loc}: the round-open clock`).toBe(clock);
      expect(rail[1], `${loc}: the word under it`).toBe(COPY.roundOpened);
      expect(rail[0], `${loc}: not TBD`).not.toBe(COPY.tbd);
      checked += 1;
    }
    expect(checked).toBe(4);
  });

  it("V4: the gate — a real scheduled time is kept; a live or decided row keeps its word; no entry, or no watch, is TBD as before", () => {
    const OPENED = "2026-10-16T13:05:00.000Z";
    const copy = publicWatchCopy((k) => msgFor("en", k));
    const fx = [
      F("f1", { status: "in_play", scheduled_at: null }),
      F("f2", { status: "decided", scheduled_at: null }),
      F("f3"),
      F("f4", { scheduled_at: null }),
      F("f5", { scheduled_at: null }),
    ];
    const opened = { f1: OPENED, f2: OPENED, f3: OPENED, f4: OPENED };
    const r = rows(render({ links: {}, copy, roundOpenedAt: opened }, fx));
    const bare = rows(render({ links: {}, copy }, fx));
    expect(railOf(r.f3!), "a real time is kept").toEqual(railOf(bare.f3!));
    expect(railOf(r.f3!)[0], "premise: 19:00 in London").toBe("19:00");
    expect(r.f1, "live keeps its word").toBe(bare.f1);
    expect(r.f2, "decided keeps its word").toBe(bare.f2);
    expect(railOf(r.f4!)[0], "the one the ruling is for").toBe("14:05");
    expect(railOf(r.f5!), "no entry: TBD, as before").toEqual(railOf(bare.f5!));
    expect(railOf(bare.f4!)[0], "premise: today it says TBD").toBe(COPY.tbd);
    // No watch at all (every other division, the embed): today's markup.
    expect(rows(render(undefined, fx)).f4, "no watch: TBD").toBe(bare.f4);
  });

  it("V4: the rail's clock IS the fixture page's — timeOf and formatWatchTime agree at every 7th minute of a day, across a DST change, in all four locales", () => {
    let checked = 0;
    for (const loc of LOCALES) {
      for (const day of ["2026-10-24", "2026-10-25"]) {
        for (let m = 0; m < 24 * 60; m += 7) {
          const iso = new Date(Date.parse(`${day}T00:00:00.000Z`) + m * 60_000).toISOString();
          expect(timeOf(iso, "Europe/London"), `${loc} ${iso}`).toBe(formatWatchTime(iso, "Europe/London", loc, false));
          checked += 1;
        }
      }
    }
    expect(checked, "anti-vacuity").toBe(4 * 2 * Math.ceil((24 * 60) / 7));
  });

  it("a final position with no recorded score shows the words alone", () => {
    const copy = publicWatchCopy((k) => msgFor("en", k));
    const r = rows(render({ links: { f2: { kind: "final", score: "" } }, copy }));
    expect(r.f2).toMatch(new RegExp(`data-kind="final"[^>]*>${esc(copy.final)}</span>`));
  });
});
