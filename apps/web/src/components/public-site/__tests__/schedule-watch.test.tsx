// T16 fix round 1, I4 — the division Fixtures list's watch link (canvas WatchStatesDesktop A): "Watch live", the
// final position with its score, "Round not opened yet". Each is a LABEL inside its row's own link (the row opens
// the fixture page, where the watch panel is): never a link inside a link, never a Lichess URL. The words arrive
// finished, in the org's locale (publicWatchCopy over msgFor), as every other word of this client component does.
//
// Node render only (no DOM in apps/web vitest). Single-sport by construction: online play is boardgame only.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { msgFor } from "@/lib/messages-i18n";
import { publicWatchCopy } from "@/server/public-site/schedule-copy";
import type { PublicFixture } from "@/server/public-site/data";
import type { PublicWatchLink } from "@/server/external-play/public-view";
import { Schedule, type ScheduleCopy } from "../schedule";

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
  timesIn: "(times in {zone})", empty: "(empty)",
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

  it("a final position with no recorded score shows the words alone", () => {
    const copy = publicWatchCopy((k) => msgFor("en", k));
    const r = rows(render({ links: { f2: { kind: "final", score: "" } }, copy }));
    expect(r.f2).toMatch(new RegExp(`data-kind="final"[^>]*>${esc(copy.final)}</span>`));
  });
});
