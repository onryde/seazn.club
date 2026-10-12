import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RunSheetRow } from "@/components/v2/desk/run-sheet-row";
import { fixtureStatusLabel, VOID_STATUSES } from "@/components/v2/stages-panel";
import { outcomeText, outcomeTextParts, splitResultTail } from "@/lib/outcome-text";
import { forfeitLedgerOfReason, FORFEIT_TAG_KEY } from "@/lib/forfeit-tag";
import type { RunSheetFixture } from "@/lib/run-sheet-groups";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";

// The row's editor hooks throw outside a router context (run-sheet-row.test.tsx carries the same mock).
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(""),
}));

// W2b loop H F1 (controller ruling: the result tag never truncates). At 320 the run sheet's phone line read
// "Round 2 · forfeited · Bears of Br…" — the ellipsis took "won (w/o)", the one thing the line exists to say. The line is
// now two spans, the pattern the device pad's scan-confirm line already uses (`device-score-pad.tsx`): the meta and the
// winner's name in a `min-w-0 truncate` span, and the result's tail in a `shrink-0 whitespace-pre` one that never
// shrinks. Every expected tail below is read from the DICTIONARY's templates, never from the code under test.

type Dict = Record<string, string>;
const LOCALES: Record<string, Dict> = { en: uiEn as Dict, es: uiEs as Dict, fr: uiFr as Dict, nl: uiNl as Dict };
const msgOf = (d: Dict) =>
  ((key: string, vars?: Record<string, string | number>) =>
    (d[key] ?? key).replace(/\{(\w+)\}/g, (_m, k: string) => String(vars?.[k] ?? `{${k}}`))) as Parameters<typeof outcomeText>[0];

/** Realistic 43-character names (the length AGENTS.md's 106px overflow was found with). */
const HOME = "Riverside Athletic Football Club Under-21 A";
const AWAY = "Bears of Brockley Sunday League Veterans XI";
const NAMES = { e1: HOME, e2: AWAY };

/** The template's words after `{name}`, its `{tag}` filled from the same dictionary. */
const afterName = (d: Dict, key: string, tag?: string) => {
  const parts = d[key]!.split("{name}");
  expect(parts, `${key} names the winner once`).toHaveLength(2);
  return parts[1]!.replace("{tag}", tag ?? "");
};

/** Every result shape the row's line can end with: a credited forfeit of each kind, each abandon the ledger tags, a
 *  double walkover, and a plain win. `tail(d)` is the part that must never truncate. */
const CASES: {
  name: string;
  status: string;
  outcome: Record<string, unknown>;
  abandon: string | null;
  winner: string | null;
  tail: (d: Dict) => string;
}[] = [
  ...(["walkover", "withdrew", "retired", "disqualified"] as const).map((reason) => ({
    name: `award ${reason}`,
    status: "forfeited",
    outcome: { kind: "award", winner: "e2", loser: "e1", reason },
    abandon: null,
    winner: AWAY,
    tail: (d: Dict) => afterName(d, "schedule.outcome.wonTagged", d[FORFEIT_TAG_KEY[reason]]),
  })),
  {
    name: "double walkover",
    status: "forfeited",
    outcome: { kind: "double_walkover" },
    abandon: null,
    winner: null,
    tail: (d) => d[FORFEIT_TAG_KEY.double_walkover]!,
  },
  {
    name: "DLS abandon",
    status: "decided",
    outcome: { kind: "win", winner: "e1", loser: "e2", method: "dls" },
    abandon: "rain",
    winner: HOME,
    tail: (d) => afterName(d, "schedule.outcome.wonTagged", d[FORFEIT_TAG_KEY.abandoned_dls]),
  },
  {
    name: "award-policy abandon (the leader)",
    status: "decided",
    outcome: { kind: "win", winner: "e1", loser: "e2", method: "abandoned" },
    abandon: "rain",
    winner: HOME,
    tail: (d) => afterName(d, "schedule.outcome.wonTagged", d[FORFEIT_TAG_KEY.abandoned]),
  },
  {
    name: "level abandon",
    status: "decided",
    outcome: { kind: "draw" },
    abandon: "rain",
    winner: null,
    tail: (d) => `${d["schedule.outcome.draw"]} · ${d[FORFEIT_TAG_KEY.abandoned]}`,
  },
  {
    name: "no-result abandon",
    status: "decided",
    outcome: { kind: "no_result" },
    abandon: "rain",
    winner: null,
    tail: (d) => `${d["schedule.outcome.noResult"]} · ${d[FORFEIT_TAG_KEY.abandoned_no_result]}`,
  },
  {
    name: "a plain win",
    status: "decided",
    outcome: { kind: "win", winner: "e2", loser: "e1" },
    abandon: null,
    winner: AWAY,
    tail: (d) => afterName(d, "schedule.outcome.won"),
  },
];

describe("outcomeTextParts — the result cut where the winner's name ends", () => {
  it("every case in every locale: lead + tail is outcomeText's string, the name ends the lead, the tag is in the tail", () => {
    let checked = 0;
    for (const [locale, d] of Object.entries(LOCALES)) {
      const msg = msgOf(d);
      for (const c of CASES) {
        const ledger = forfeitLedgerOfReason(c.abandon);
        const full = outcomeText(msg, c.outcome, NAMES, ledger);
        const parts = outcomeTextParts(msg, c.outcome, NAMES, ledger);
        const label = `${locale} ${c.name}`;
        expect(full, `${label}: a result line`).not.toBeNull();
        expect(parts, label).not.toBeNull();
        expect(parts!.lead + parts!.tail, `${label}: nothing added, nothing lost`).toBe(full);
        expect(parts!.tail, `${label}: the tail is the template's own words`).toBe(c.tail(d));
        if (c.winner === null) expect(parts!.lead, `${label}: a result naming nobody is all tail`).toBe("");
        else expect(parts!.lead.endsWith(c.winner), `${label}: the name ends the lead`).toBe(true);
        checked++;
      }
    }
    expect(checked, `cases checked: ${checked}`).toBe(Object.keys(LOCALES).length * CASES.length);
  });

  it("no outcome reads no parts; a winner missing from the names reads '?', as outcomeText does", () => {
    const msg = msgOf(LOCALES.en!);
    expect(outcomeTextParts(msg, null, NAMES)).toBeNull();
    const stranger = { kind: "award", winner: "zz", loser: "e1", reason: "walkover" };
    const parts = outcomeTextParts(msg, stranger, NAMES)!;
    expect(parts.lead).toBe("?");
    expect(parts.lead + parts.tail).toBe(outcomeText(msg, stranger, NAMES));
  });

  it("splitResultTail cuts only a line that ENDS with the tail; anything else is all lead", () => {
    expect(splitResultTail("Round 2 · Alpha won (w/o)", " won (w/o)")).toEqual({ lead: "Round 2 · Alpha", tail: " won (w/o)" });
    expect(splitResultTail("Round 2 · Awaiting draw", " won (w/o)")).toEqual({ lead: "Round 2 · Awaiting draw", tail: "" });
    expect(splitResultTail("Round 2", "")).toEqual({ lead: "Round 2", tail: "" });
    expect(splitResultTail("Round 2", null)).toEqual({ lead: "Round 2", tail: "" });
  });

  it("the gap before a tail travels WITH the tail: a truncating span's trailing space collapses ('·2× w/o')", () => {
    // A result that names nobody is all tail, so the separator's space ended the lead — and white-space:nowrap drops a
    // space that ends its box. The tail is whitespace-pre: the space survives there.
    expect(splitResultTail("Round 1 · forfeited · 2× w/o", "2× w/o")).toEqual({ lead: "Round 1 · forfeited ·", tail: " 2× w/o" });
    expect(splitResultTail("Round 1 ·  \t2× w/o", "2× w/o")).toEqual({ lead: "Round 1 ·", tail: "  \t2× w/o" });
    // A tail with its own leading space is unchanged; a line that IS the tail has no lead to give up a gap.
    expect(splitResultTail("Round 2 · Alpha won (w/o)", " won (w/o)")).toEqual({ lead: "Round 2 · Alpha", tail: " won (w/o)" });
    expect(splitResultTail("2× w/o", "2× w/o")).toEqual({ lead: "", tail: "2× w/o" });
  });
});

function fx(o: Partial<RunSheetFixture>): RunSheetFixture {
  return {
    id: "f1",
    stage_id: "s1",
    fixture_no: 1,
    round_no: 2,
    seq_in_round: 1,
    scheduled_at: "2026-09-05T14:00:00.000Z",
    status: "scheduled",
    court_name: null,
    court_id: null,
    venue_name: null,
    officials: [],
    outcome: null,
    home_entrant_id: "e1",
    away_entrant_id: "e2",
    home_slot_label: null,
    away_slot_label: null,
    lane: null,
    is_final: false,
    third_place: false,
    conditional: false,
    ext_key: null,
    ...o,
  };
}

const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const classesOf = (cls: string) => cls.split(/\s+/);

/** The phone line: the `<p>` whose class list holds `md:hidden` as a WHOLE class (never `max-md:hidden`). */
function phoneLine(html: string): { cls: string[]; inner: string } {
  const found = [...html.matchAll(/<p class="([^"]*)">(.*?)<\/p>/g)].filter((m) => classesOf(m[1]!).includes("md:hidden"));
  expect(found, "exactly one phone line").toHaveLength(1);
  return { cls: classesOf(found[0]![1]!), inner: found[0]![2]! };
}
/** The line's spans, each with its TEXT. Since design audit 4.3 the tail holds its tag as a nested named symbol
 *  (`<span role="img" …>w/o</span>`) — the one child a span may carry here; its text is read through it. */
const spans = (inner: string) =>
  [...inner.matchAll(/<span class="([^"]*)">((?:[^<]|<span role="img"[^>]*>[^<]*<\/span>)*)<\/span>/g)].map((m) => ({
    cls: classesOf(m[1]!),
    text: decode(m[2]!.replace(/<[^>]+>/g, "")),
  }));

describe("the run sheet's phone line never truncates the result's tail (loop H F1)", () => {
  const en = LOCALES.en!;
  const msg = msgOf(en);

  it("every case: the tail sits in a shrink-0 whitespace-pre span; only the meta and the name truncate", () => {
    let checked = 0;
    for (const c of CASES) {
      const html = renderToStaticMarkup(
        <RunSheetRow
          fixture={fx({ status: c.status, outcome: c.outcome, abandon_reason: c.abandon })}
          awaitsSettle={false}
          href="/f/1"
          tz="UTC"
          orgTz="UTC"
          nowMs={Date.UTC(2026, 8, 5, 12)}
          canEdit
          entrantNames={NAMES}
        />,
      );
      const line = phoneLine(html);
      expect(line.cls, `${c.name}: the line is a flex row`).toContain("flex");
      expect(line.cls, `${c.name}: the line itself no longer truncates as one string`).not.toContain("truncate");
      const s = spans(line.inner);
      expect(s, `${c.name}: two spans, the truncating lead and the tail`).toHaveLength(2);
      const [lead, tail] = s as [(typeof s)[0], (typeof s)[0]];
      expect(lead.cls, c.name).toEqual(expect.arrayContaining(["min-w-0", "truncate"]));
      expect(tail.cls, c.name).toEqual(expect.arrayContaining(["shrink-0", "whitespace-pre"]));
      expect(tail.cls, `${c.name}: the tail never truncates`).not.toContain("truncate");
      expect(tail.text.endsWith(c.tail(en)), `${c.name}: the tail is the template's words`).toBe(true);
      expect(tail.text.trim(), `${c.name}: and only them, with the gap before them`).toBe(c.tail(en).trim());
      expect(lead.text, `${c.name}: the truncating lead never ENDS in a space (it would collapse, gluing '·2× w/o')`).toBe(lead.text.trimEnd());
      // The visible text is unchanged: round meta, the void status where there is one, then the result.
      const meta = msg("schedule.round", { n: 2 });
      const status = VOID_STATUSES.has(c.status) ? `${fixtureStatusLabel(msg, c.status)} · ` : "";
      expect(lead.text + tail.text, c.name).toBe(`${meta} · ${status}${outcomeText(msg, c.outcome, NAMES, forfeitLedgerOfReason(c.abandon))}`);
      if (c.winner !== null) expect(lead.text.endsWith(c.winner), `${c.name}: the name is what truncates`).toBe(true);
      checked++;
    }
    expect(checked, `rows checked: ${checked}`).toBe(CASES.length);
  });

  it("a row with no result keeps its line whole: one truncating span, no tail", () => {
    const html = renderToStaticMarkup(
      <RunSheetRow fixture={fx({})} awaitsSettle={false} href="/f/1" tz="UTC" orgTz="UTC" nowMs={Date.UTC(2026, 8, 5, 12)} canEdit entrantNames={NAMES} />,
    );
    const s = spans(phoneLine(html).inner);
    expect(s.filter((x) => x.cls.includes("shrink-0") && x.cls.includes("whitespace-pre")), "no tail span").toHaveLength(0);
    expect(s.filter((x) => x.cls.includes("truncate")), "the meta still truncates").toHaveLength(1);
  });
});
