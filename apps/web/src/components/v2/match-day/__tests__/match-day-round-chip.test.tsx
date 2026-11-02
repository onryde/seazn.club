// Match Day E2 item 7 — the round code on every match (owner 2026-11-01: "we don't know which matches are going on? R1, R2… or SF,
// like in schedule board"). A chip before the names at every place Match Day names a match: the court list (the match on a court,
// or the next one on a free court), the "Playing, no court" rows, the focus panel (the match on court, the called panel, the queue),
// the candidate rows and the call sheet.
//
// The expected code is never typed here: it is `matchDayRounds` over a generated knockout, which itself asks the schedule board's
// `boardRoundCodes` (lib/match-day/__tests__/rounds.test.ts proves that parity). What THIS file proves is the wiring: every surface
// draws the chip, from the match's own `round`, in front of the names, with the full name as its accessible name and its tooltip.
// Anti-vacuity: each sweep reports what it checked; zero fails.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import publicEn from "@/dictionaries/en/public.json";
import type { RoundCodeFixture } from "@/components/v2/board/round-codes";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { msgFor } from "@/lib/messages-i18n";
import type { MessageKey } from "@/lib/messages";
import { matchDayRounds } from "@/lib/match-day/rounds";
import type { MatchDayCandidate, MatchDayCourt, MatchDayFixture, MatchDayRound } from "@/lib/match-day/types";
import { matchMeta } from "@/lib/match-day/view";
import { routes } from "@/lib/routes";
import { CallSheetBody } from "../call-sheet";
import { FreeCourtBody } from "../candidate-list";
import { CourtFocus, NoCourtFocus, type MatchDayCtx } from "../court-focus";
import { CourtList, NoCourtList } from "../court-list";
import { MatchRoundChip } from "../round-chip";

const dict = en as Dict;
const DICTS: Record<Locale, Dict> = { en, es, fr, nl } as Record<Locale, Dict>;
const msgIn = (locale: Locale) => (key: MessageKey, vars?: Record<string, string | number>) => msgFor(locale, key, vars);
const esc = (v: string): string =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

const ctx: MatchDayCtx = {
  competitionId: "comp-1",
  orgSlug: "acme",
  compSlug: "open",
  locale: "en",
  tz: "Europe/London",
  dict,
  scoreDict: publicEn as Dict,
  viewerPlan: "pro",
  readOnly: false,
  frozen: false,
};

/** The generated 8-entrant knockout (QF x4, SF x2, final, bronze) and the rounds the board's own function gives it. */
const KO: RoundCodeFixture[] = [
  ...[1, 2, 3, 4].map((s) => ({ id: `ko-qf${s}`, stage_id: "ko", round_no: 1, seq_in_round: s })),
  ...[1, 2].map((s) => ({ id: `ko-sf${s}`, stage_id: "ko", round_no: 2, seq_in_round: s })),
  { id: "ko-f", stage_id: "ko", round_no: 3, seq_in_round: 1, is_final: true },
  { id: "ko-3p", stage_id: "ko", round_no: 3, seq_in_round: 2, third_place: true },
] as RoundCodeFixture[];
const ROUNDS = (locale: Locale = "en") =>
  matchDayRounds(KO, KO, [{ id: "ko", kind: "knockout" }], msgIn(locale));
const roundOf = (id: string, locale: Locale = "en"): MatchDayRound => ROUNDS(locale).get(id)!;
const PLAIN: MatchDayRound = { code: "R2", label: "Round 2", coded: false };

const fx = (o: Partial<MatchDayFixture> = {}): MatchDayFixture => ({
  id: "f-1",
  division_id: "d-1",
  division_name: "Girls U14",
  division_slug: "girls-u14",
  fixture_no: 7,
  sport_key: "badminton",
  stage_label: "Knockout",
  round: roundOf("ko-sf1"),
  home: "Zara Khan",
  away: "Ella Brooks",
  home_entrant_id: "e-zara",
  away_entrant_id: "e-ella",
  headline: "0 – 0",
  summary: null,
  serving: null,
  started_at: "2026-10-31T11:20:00.000Z",
  called_at: null,
  stream: null,
  scorer_attention: null,
  live_video: null,
  format_line: null,
  ...o,
});
const court = (o: Partial<MatchDayCourt> = {}): MatchDayCourt => ({
  court_id: "c-3",
  court_name: "Court 3",
  venue_id: "venue-1",
  venue_name: "Main Hall",
  sport_noun: "court",
  state: "playing",
  current: fx(),
  in_use_by: null,
  free_since: null,
  queue: [],
  closure: null,
  ...o,
});
const queued = (o: Partial<MatchDayFixture> = {}) => ({
  ...fx({ id: "q-1", home: "Isha Rao", away: "Lily Chen", headline: null, started_at: null, ...o }),
  planned_at: "2026-10-31T12:20:00.000Z",
  estimated_at: "2026-10-31T12:20:00.000Z",
});
const cand = (f: Partial<MatchDayFixture>): MatchDayCandidate => ({
  fixture: fx({ headline: null, started_at: null, ...f }),
  source: "other_court",
  from_court_name: "Court 1",
  waiting_minutes: 15,
  behind_minutes: 0,
  planned_at: null,
  blocked: null,
});

/** Every chip in a markup: [code, coded, title, sr-only name]. */
function chipsOf(html: string): { code: string; coded: string; title: string; sr: string }[] {
  return [
    ...html.matchAll(
      /<span data-testid="md-round-chip" data-round-code="([^"]*)" data-round-coded="([^"]*)" title="([^"]*)"[^>]*><span aria-hidden="true">([^<]*)<\/span><span class="sr-only">([^<]*)<\/span><\/span>/g,
    ),
  ].map((m) => ({ code: m[1]!, coded: m[2]!, title: m[3]!, sr: m[5]! }));
}
/** The chip (as markup) the component draws for a round — the oracle for "this chip, here". */
const chipHtml = (round: MatchDayRound, tone?: "light" | "dark") => renderToStaticMarkup(<MatchRoundChip round={round} tone={tone} />);

const focusHtml = (c: MatchDayCourt) =>
  renderToStaticMarkup(
    <CourtFocus ctx={ctx} court={c} backLabel="All courts" onBack={() => {}} onChanged={() => {}} onRefused={() => {}} notice={null} refreshKey="k" divisions={null} />,
  );

describe("MatchRoundChip — the chip itself", () => {
  it("draws the code hidden from assistive tech, the full name for it, and the full name as a tooltip", () => {
    const sf = roundOf("ko-sf1");
    const html = chipHtml(sf);
    expect(html).toContain('data-testid="md-round-chip"');
    expect(html).toContain(`data-round-code="${sf.code}"`);
    expect(html).toContain(`title="${esc(sf.label)}"`);
    expect(html).toContain(`<span aria-hidden="true">${sf.code}</span>`);
    expect(html).toContain(`<span class="sr-only">${esc(sf.label)}</span>`);
    expect(chipsOf(html)).toEqual([{ code: sf.code, coded: "true", title: sf.label, sr: sf.label }]);
  });

  it("a bracket role and a plain round are two looks, and the page says which in data-round-coded", () => {
    const coded = chipHtml(roundOf("ko-f"));
    const plain = chipHtml(PLAIN);
    expect(coded).toContain('data-round-coded="true"');
    expect(plain).toContain('data-round-coded="false"');
    const classOf = (h: string) => h.match(/class="([^"]*)"/)![1]!;
    expect(classOf(coded)).not.toBe(classOf(plain));
    expect(classOf(coded)).toMatch(/\bpurple-/);
    expect(classOf(plain)).toMatch(/\bslate-/);
  });

  it("the dark tone (the called panel's court-green card) differs from the light one, for both looks", () => {
    for (const round of [roundOf("ko-f"), PLAIN]) expect(chipHtml(round, "dark")).not.toBe(chipHtml(round, "light"));
  });

  it("text sits at the page's 12px floor, never smaller", () => {
    for (const round of [roundOf("ko-f"), PLAIN]) {
      const cls = chipHtml(round).match(/class="([^"]*)"/)![1]!;
      expect(cls).toMatch(/\btext-xs\b/);
      expect(cls).not.toMatch(/text-\[(?:9|10|11)px\]/);
    }
  });

  it("the sweep: every round of the knockout, in every locale, draws its own code and its own words", () => {
    let checked = 0;
    for (const locale of ["en", "es", "fr", "nl"] as Locale[]) {
      for (const f of KO) {
        const round = roundOf(f.id, locale);
        const [chip] = chipsOf(chipHtml(round));
        expect(chip, `${locale} ${f.id}`).toEqual({ code: round.code, coded: "true", title: round.label, sr: round.label });
        checked++;
      }
    }
    expect(checked).toBe(4 * KO.length);
  });
});

describe("the court list", () => {
  const list = (courts: MatchDayCourt[]) =>
    renderToStaticMarkup(<CourtList courts={courts} selectedId={null} dict={dict} locale="en" tz="Europe/London" onSelect={() => {}} />);

  it("a playing court's row carries the chip of the match on it, before the names", () => {
    const html = list([court()]);
    const sf = roundOf("ko-sf1");
    expect(html).toContain(`${chipHtml(sf)} Zara Khan v Ella Brooks`);
    expect(chipsOf(html)).toHaveLength(1);
  });

  it("a free court with a queue names the NEXT match planned there, chip first — the queue's first, not its last", () => {
    const c = court({ state: "free", current: null, queue: [queued({ id: "q-1", round: roundOf("ko-qf1") }), queued({ id: "q-2", round: roundOf("ko-f") })] });
    const html = list([c]);
    expect(html).toContain(`${chipHtml(roundOf("ko-qf1"))} Isha Rao v Lily Chen`);
    expect(chipsOf(html).map((x) => x.code)).toEqual([roundOf("ko-qf1").code]);
  });

  it("a called court shows the called match's chip", () => {
    const html = list([court({ state: "called", current: fx({ round: roundOf("ko-3p"), started_at: null, called_at: "2026-10-31T11:31:00.000Z" }) })]);
    expect(chipsOf(html).map((x) => x.code)).toEqual([roundOf("ko-3p").code]);
  });

  it("another competition's court says who has it and carries no chip; a free empty court carries none either (the empty case)", () => {
    const elsewhere = court({ state: "in_use_elsewhere", current: null, in_use_by: "City Open" });
    const empty = court({ court_id: "c-9", court_name: "Court 9", state: "free", current: null, queue: [] });
    expect(chipsOf(list([elsewhere]))).toEqual([]);
    expect(chipsOf(list([empty]))).toEqual([]);
  });

  it("a plain league round reads R{n}, in the quiet look", () => {
    const html = list([court({ current: fx({ round: PLAIN }) })]);
    expect(chipsOf(html)).toEqual([{ code: "R2", coded: "false", title: "Round 2", sr: "Round 2" }]);
  });

  it("the sweep: one court per round of the knockout — each row's chip is its own match's", () => {
    const courts = KO.map((f, i) => court({ court_id: `c-${i}`, court_name: `Court ${i + 1}`, current: fx({ id: f.id, round: roundOf(f.id) }) }));
    const html = list(courts);
    expect(chipsOf(html).map((x) => x.code)).toEqual(KO.map((f) => roundOf(f.id).code));
    expect(chipsOf(html)).toHaveLength(KO.length);
  });
});

describe("Playing, no court", () => {
  it("each row: the chip before the names, and the meta line ends on the round's FULL name", () => {
    const rows = [fx({ id: "n-1", round: roundOf("ko-f") }), fx({ id: "n-2", round: PLAIN, stage_label: "Swiss" })];
    const html = renderToStaticMarkup(
      <NoCourtList fixtures={rows} noun="court" selectedId={null} dict={dict} hrefOf={(f) => routes.fixture("acme", "open", f.division_slug, f.fixture_no)} openLabel="Open pad" onSelect={() => {}} />,
    );
    expect(chipsOf(html).map((x) => x.code)).toEqual([roundOf("ko-f").code, "R2"]);
    for (const r of rows) {
      expect(html).toContain(`${chipHtml(r.round)} Zara Khan v Ella Brooks`);
      expect(html).toContain(`>${esc(matchMeta(r))}<`);
      expect(matchMeta(r).endsWith(r.round.label)).toBe(true);
    }
  });
});

describe("the focus panel", () => {
  it("the match on court: chip before the names, meta line 'division · stage · round name'", () => {
    const f = fx({ round: roundOf("ko-sf2") });
    const html = focusHtml(court({ current: f }));
    expect(html).toContain(`${chipHtml(f.round)} Zara Khan v Ella Brooks`);
    expect(html).toContain(esc(matchMeta(f)));
    expect(matchMeta(f)).toBe(`Girls U14 · Knockout · ${f.round.label}`);
  });

  it("the called panel carries the DARK chip", () => {
    const f = fx({ round: roundOf("ko-f"), started_at: null, called_at: "2026-10-31T11:31:00.000Z" });
    const html = focusHtml(court({ state: "called", current: f }));
    expect(html).toContain(`${chipHtml(f.round, "dark")} Zara Khan v Ella Brooks`);
    expect(html).toContain(esc(matchMeta(f)));
  });

  it("'Up next here': a chip on every queued match, each its own", () => {
    const q = [queued({ id: "q-1", round: roundOf("ko-qf2") }), queued({ id: "q-2", round: roundOf("ko-sf1") }), queued({ id: "q-3", round: PLAIN })];
    const html = focusHtml(court({ queue: q }));
    const rowsHtml = html.split('data-testid="md-queue-row"').slice(1);
    expect(rowsHtml).toHaveLength(3);
    rowsHtml.forEach((r, i) => expect(r, `row ${i}`).toContain(chipHtml(q[i]!.round)));
  });

  it("the queue's empty case draws no chip", () => {
    const html = focusHtml(court({ queue: [] }));
    expect(html.split('data-testid="md-queue-row"')).toHaveLength(1);
  });

  it("a match in play with no court: chip and meta in its own focus panel", () => {
    const f = fx({ round: roundOf("ko-3p") });
    const html = renderToStaticMarkup(<NoCourtFocus ctx={ctx} fixture={f} backLabel="All courts" onBack={() => {}} onChanged={() => {}} />);
    expect(html).toContain(chipHtml(f.round));
    expect(html).toContain(esc(matchMeta(f)));
  });
});

describe("candidates and the call sheet", () => {
  it("every candidate row carries its own match's chip — the sweep over a mixed list", () => {
    const ids = ["ko-qf1", "ko-sf2", "ko-f", "ko-3p"];
    const candidates = ids.map((id) => cand({ id, round: roundOf(id) }));
    candidates.push(cand({ id: "plain", round: PLAIN }));
    const html = renderToStaticMarkup(
      <FreeCourtBody ctx={ctx} court={court({ state: "free", current: null })} load={{ status: "ready", candidates }} onCall={() => {}} onRetry={() => {}} />,
    );
    const rows = html.split('data-testid="md-candidate"').slice(1);
    expect(rows).toHaveLength(candidates.length);
    rows.forEach((r, i) => expect(r, `row ${i}`).toContain(chipHtml(candidates[i]!.fixture.round)));
  });

  it("the call sheet's heading names the match behind its chip", () => {
    const c = cand({ round: roundOf("ko-sf1") });
    const html = renderToStaticMarkup(
      <CallSheetBody ctx={ctx} court={court({ court_name: "Court 5" })} candidate={c} state={{ kind: "ready", preview: { shifts: [], warnings: [] } }} />,
    );
    expect(html).toContain(`${chipHtml(c.fixture.round)} Zara Khan v Ella Brooks`);
  });

  it("the sweep, in four locales: the panel's chip words are the reader's (the board's own, per language)", () => {
    let checked = 0;
    for (const locale of ["en", "es", "fr", "nl"] as Locale[]) {
      const lctx: MatchDayCtx = { ...ctx, locale, dict: DICTS[locale] };
      const f = fx({ round: roundOf("ko-sf1", locale) });
      const html = renderToStaticMarkup(
        <CourtFocus ctx={lctx} court={court({ current: f })} backLabel="" onBack={() => {}} onChanged={() => {}} onRefused={() => {}} notice={null} refreshKey="k" divisions={null} />,
      );
      expect(chipsOf(html)[0], locale).toMatchObject({ code: f.round.code, title: f.round.label });
      expect(html, locale).toContain(esc(matchMeta(f)));
      checked++;
    }
    expect(checked).toBe(4);
  });
});
