// BracketPanel names an unfilled seat by its FEEDER — all four tree variants.
//
// Round 1 of this fix taught the draw list (`desk/run-sheet-row.tsx`) to read
// the bracket feed edges, which moved the disagreement from two SCREENS onto
// one TAB: `d/[divSlug]/page.tsx` renders this tree directly ABOVE that list,
// and the tree still printed `bracket.tbd` where the list read
// "Winner of R1·1". Adjacent panels contradicting each other reads as broken
// rather than merely uninformative, which is a worse customer impression than
// the original defect — so consistency within one view wins over keeping
// `bracket.tbd` as this surface's established vocabulary. (Owner ruling,
// 2026-09-21.)
//
// FOUR variants, four resolution sites, each with a REAL sibling feed:
//   BracketPanel (single-elim)  bracket.ts:203  winnerOf(prev) → the next round
//   DoubleElimPanel             bracket.ts:294  loserOf(wb) → LB, winnerOf → GF
//   StepladderPanel             bracket.ts:427  awayFrom: winnerOf(prev rung)
//   PagePlayoffPanel            bracket.ts:392  loserOf(q1), winnerOf(elim)…
// None of the four is explained away: the engine emits `homeFrom`/`awayFrom`
// for every one of them, and `generateStageFixtures`' second pass turns those
// into `winner_to_*`/`loser_to_*` rows (usecases/stages.ts ~1997).
//
// This file does NOT mock the dict provider. `useMsg()` falls back to the
// English catalog outside a `<DictProvider>` (dict-provider.tsx:131-137), so
// the component runs its real composition — and this suite can therefore pin
// what each seat OPENS AT ("Winner of R1·1"), not merely that some key
// reached the DOM. A reachability assertion is satisfied by ANY value.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Only the two providers `StagesPanel` demands of its host (the draw-list half
// of the agreement test at the bottom). The DICT provider is deliberately NOT
// mocked — see the header note.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

import { BracketPanel } from "../bracket-panel";
import { StagesPanel } from "../stages-panel";
import { matchRef, resolveSlotLabel } from "@/lib/slot-label";
import { messages, type MessageKey } from "@/lib/messages";
import { t as tRuntime } from "@/lib/i18n-runtime";
import type { SlotLabel } from "@/server/usecases/stage-seeding";

/** The same lookup `useMsg()` binds outside a provider — so every expected
 *  string below is DERIVED through the component's own composition point
 *  rather than typed in as a table that a dictionary change would strand. */
const msg = ((key: string, vars?: Record<string, string | number>) =>
  tRuntime(messages, key, vars)) as (
  key: MessageKey,
  vars?: Record<string, string | number>,
) => string;

const winner = (round: number, seq: number): string =>
  resolveSlotLabel({ key: "slot.winner_match", params: { round, seq } }, msg, "bracket.tbd");
const loser = (round: number, seq: number): string =>
  resolveSlotLabel({ key: "slot.loser_match", params: { round, seq } }, msg, "bracket.tbd");

const TBD = resolveSlotLabel(null, msg, "bracket.tbd");
const BYE = resolveSlotLabel({ key: "bracket.slot.bye", params: {} }, msg, "bracket.tbd");

const ENTRANTS = { e1: "Mexico", e2: "Canada", e3: "Japan", e4: "Chile" };

it("sanity: the derived labels are distinct, none collapsed to the TBD fallback", () => {
  const derived = { w01: winner(0, 1), w02: winner(0, 2), l11: loser(1, 1), w21: winner(2, 1), BYE };
  for (const [name, value] of Object.entries(derived)) {
    expect(value, `${name} collapsed to the TBD fallback`).not.toBe(TBD);
    expect(value, `${name} is empty`).not.toBe("");
  }
  expect(new Set(Object.values(derived)).size).toBe(5);
  // The ref really is composed from THESE numbers — a derivation that ignored
  // round/seq would still be distinct from TBD and would pass the loop above.
  expect(winner(0, 2)).toContain(matchRef(0, 2, msg));
  expect(loser(1, 1)).toContain(matchRef(1, 1, msg));
  expect(winner(0, 2)).not.toContain(matchRef(0, 1, msg));
});

type Feed = {
  winner_to_fixture?: string | null;
  winner_to_slot?: number | null;
  loser_to_fixture?: string | null;
  loser_to_slot?: number | null;
};

type Fix = {
  id: string;
  stage_id: string;
  round_no: number;
  seq_in_round: number;
  fixture_no: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  home_slot_label: SlotLabel | null;
  away_slot_label: SlotLabel | null;
  status: string;
  outcome: unknown;
} & Required<Feed>;

let no = 0;
function FIX(
  id: string,
  round: number,
  seq: number,
  home: string | null,
  away: string | null,
  feed: Feed = {},
  labels: { home?: SlotLabel | null; away?: SlotLabel | null } = {},
): Fix {
  no += 1;
  return {
    id,
    stage_id: "s1",
    round_no: round,
    seq_in_round: seq,
    fixture_no: no,
    home_entrant_id: home,
    away_entrant_id: away,
    home_slot_label: labels.home ?? null,
    away_slot_label: labels.away ?? null,
    status: "scheduled",
    outcome: null,
    winner_to_fixture: feed.winner_to_fixture ?? null,
    winner_to_slot: feed.winner_to_slot ?? null,
    loser_to_fixture: feed.loser_to_fixture ?? null,
    loser_to_slot: feed.loser_to_slot ?? null,
  };
}

function tree(fixtures: Fix[], kind?: string): string {
  const html = renderToStaticMarkup(
    <BracketPanel
      {...(kind === undefined ? {} : { kind })}
      fixtures={fixtures}
      entrantNames={ENTRANTS}
      orgSlug="org"
      compSlug="cup"
      divSlug="open"
    />,
  );
  expect(html, "the tree rendered nothing — the shape was rejected").not.toBe("");
  return html;
}

// ---------------------------------------------------------------------------
// VARIANT 1 — single elimination (`BracketPanel`'s own two-sided tree).
// ---------------------------------------------------------------------------
describe("BracketPanel — single-elim tree", () => {
  // Two semis feeding a final whose seats are EMPTY and whose stored labels
  // are NULL: exactly the rows `generateProgressionSetupFixtures` writes for a
  // sibling-fed seat (it leaves them null on purpose, so `stageOwesDraw` can
  // read "no label ⇒ sibling-fed").
  const SE = (): Fix[] => [
    FIX("f1", 0, 1, "e1", "e4", { winner_to_fixture: "f3", winner_to_slot: 1 }),
    FIX("f2", 0, 2, "e2", "e3", { winner_to_fixture: "f3", winner_to_slot: 2 }),
    FIX("f3", 1, 1, null, null),
  ];

  it("names the final's two empty seats by their feeders, not TBD", () => {
    const html = tree(SE());
    // Positive pair: the tree really did render these rows.
    expect(html).toContain("Mexico");
    expect(html).toContain("Japan");
    // Each seat OPENS AT its own feeder — home from R0·1, away from R0·2.
    expect(html).toContain(winner(0, 1));
    expect(html).toContain(winner(0, 2));
    expect(html).not.toContain(TBD);
    // …and each seat opens at ITS OWN feeder. Both strings are in the markup
    // whichever way round the seats are read, so presence alone cannot witness
    // a home/away swap; the order inside the final's node can (nothing else in
    // this tree renders either string — f1/f2 carry real entrant names).
    expect(html.indexOf(winner(0, 1))).toBeLessThan(html.indexOf(winner(0, 2)));
  });

  it("keeps bracket.tbd for a seat with genuinely no feeder", () => {
    // Same tree, feed edges stripped: a league's rows, or any row written
    // before the V214 columns were populated. The fallback must survive.
    const html = tree(SE().map((f) => ({ ...f, winner_to_fixture: null, winner_to_slot: null })));
    expect(html).toContain("Mexico");
    expect(html).toContain(TBD);
    expect(html).not.toContain(winner(0, 1));
  });

  it("a STORED slot label still outranks the feed label", () => {
    // The precedence that matters: `bracket.slot.bye` is the ONLY thing that
    // can mark a phantom seat, and it lives in the stored label. A bye seat
    // that instead advertised "Winner of R0·1" would promise an opponent who
    // is never coming. Inverting these two is a mutant only this case kills.
    const html = tree(
      SE().map((f) =>
        f.id === "f3" ? { ...f, home_slot_label: { key: "bracket.slot.bye", params: {} } } : f,
      ),
    );
    expect(html).toContain(BYE);
    expect(html).not.toContain(winner(0, 1));
    // The OTHER seat of the same fixture has no stored label and still takes
    // its feed label — so this is precedence, not a blanket opt-out.
    expect(html).toContain(winner(0, 2));
  });

  it("a FILLED seat renders the entrant name, ahead of both labels", () => {
    const html = tree(
      SE().map((f) => (f.id === "f3" ? { ...f, home_entrant_id: "e1", away_entrant_id: "e2" } : f)),
    );
    expect(html).toContain("Mexico");
    expect(html).toContain("Canada");
    expect(html).not.toContain(winner(0, 1));
    expect(html).not.toContain(winner(0, 2));
  });
});

// ---------------------------------------------------------------------------
// VARIANT 2 — double elimination (`DoubleElimPanel`). The only variant with
// real LOSER edges, so it is the one that can witness `slot.loser_match`.
// ---------------------------------------------------------------------------
describe("BracketPanel — double-elim tree", () => {
  // 4-entrant DE in this repo's persisted round numbering (k=2): WB 1–2,
  // LB 5–6, GF 9 — the same shape bracket-panel.test.tsx's G8 test uses.
  const DE = (): Fix[] => [
    FIX("w1", 1, 1, "e1", "e2", {
      winner_to_fixture: "wf", winner_to_slot: 1,
      loser_to_fixture: "l1", loser_to_slot: 1,
    }),
    FIX("w2", 1, 2, "e3", "e4", {
      winner_to_fixture: "wf", winner_to_slot: 2,
      loser_to_fixture: "l1", loser_to_slot: 2,
    }),
    FIX("wf", 2, 1, null, null, {
      winner_to_fixture: "gf", winner_to_slot: 1,
      loser_to_fixture: "lf", loser_to_slot: 1,
    }),
    FIX("l1", 5, 1, null, null, { winner_to_fixture: "lf", winner_to_slot: 2 }),
    FIX("lf", 6, 1, null, null, { winner_to_fixture: "gf", winner_to_slot: 2 }),
    FIX("gf", 9, 1, null, null),
  ];

  it("names losers'-bracket seats by the LOSER of their feeder", () => {
    const html = tree(DE());
    expect(html).toContain('data-testid="bracket-panel-de"'); // the DE lane view really rendered
    expect(html).toContain(loser(1, 1));
    expect(html).toContain(loser(1, 2));
    // l1's home seat takes w1's loser, its away seat w2's — a swap keeps both
    // strings present, so bind each to its seat by order.
    expect(html.indexOf(loser(1, 1))).toBeLessThan(html.indexOf(loser(1, 2)));
  });

  it("names the grand final's seats by the winners that reach it", () => {
    const html = tree(DE());
    expect(html).toContain(winner(2, 1)); // WB final's winner
    expect(html).toContain(winner(6, 1)); // LB final's winner
    expect(html).not.toContain(TBD);
  });

  it("keeps bracket.tbd when a double-elim row carries no edges", () => {
    const html = tree(
      DE().map((f) => ({
        ...f,
        winner_to_fixture: null, winner_to_slot: null,
        loser_to_fixture: null, loser_to_slot: null,
      })),
    );
    expect(html).toContain(TBD);
    expect(html).not.toContain(loser(1, 1));
  });
});

// ---------------------------------------------------------------------------
// VARIANT 3 — stepladder (`StepladderPanel`). The engine feeds only the AWAY
// side of each rung above the first (bracket.ts:427), the home side being the
// seeded climber — so this variant exercises a FED seat sitting beside a
// filled one in the same row.
// ---------------------------------------------------------------------------
describe("BracketPanel — stepladder rungs", () => {
  const SL = (): Fix[] => [
    FIX("r1", 1, 1, "e1", "e2", { winner_to_fixture: "r2", winner_to_slot: 2 }),
    FIX("r2", 2, 1, "e3", null, { winner_to_fixture: "r3", winner_to_slot: 2 }),
    FIX("r3", 3, 1, null, null),
  ];

  it("names each rung's climber slot by the rung below it", () => {
    const html = tree(SL(), "stepladder");
    expect(html).toContain('data-testid="bracket-panel-ladder"');
    expect(html).toContain("Japan"); // r2's seeded home seat, unchanged
    expect(html).toContain(winner(1, 1)); // r2's away seat ← r1's winner
    expect(html).toContain(winner(2, 1)); // r3's away seat ← r2's winner
  });

  it("keeps bracket.tbd on the summit seat that nothing feeds", () => {
    // r3's HOME is the seeded summit entrant, still undrawn: no edge points at
    // it, so it must stay TBD even while its away seat is named.
    const html = tree(SL(), "stepladder");
    expect(html).toContain(TBD);
    expect(html).toContain(winner(2, 1));
  });
});

// ---------------------------------------------------------------------------
// VARIANT 4 — page playoff (`PagePlayoffPanel`). Q2 takes the LOSER of Q1 and
// the WINNER of the eliminator, so one card shows both vocabularies.
// ---------------------------------------------------------------------------
describe("BracketPanel — page playoff", () => {
  const PP = (): Fix[] => [
    FIX("q1", 1, 1, "e1", "e2", {
      winner_to_fixture: "fin", winner_to_slot: 1,
      loser_to_fixture: "q2", loser_to_slot: 1,
    }),
    FIX("el", 1, 2, "e3", "e4", { winner_to_fixture: "q2", winner_to_slot: 2 }),
    FIX("q2", 2, 1, null, null, { winner_to_fixture: "fin", winner_to_slot: 2 }),
    FIX("fin", 3, 1, null, null),
  ];

  it("names Q2 by the loser of Q1 and the winner of the eliminator", () => {
    const html = tree(PP(), "page_playoff");
    expect(html).toContain('data-testid="bracket-panel-page"');
    expect(html).toContain(loser(1, 1));
    expect(html).toContain(winner(1, 2));
    // Q2's home is Q1's LOSER, its away the eliminator's WINNER — two
    // different vocabularies on one card, each bound to its own seat.
    expect(html.indexOf(loser(1, 1))).toBeLessThan(html.indexOf(winner(1, 2)));
  });

  it("names the final by the two qualifiers, not TBD", () => {
    const html = tree(PP(), "page_playoff");
    expect(html).toContain(winner(1, 1));
    expect(html).toContain(winner(2, 1));
    expect(html).not.toContain(TBD);
  });

  it("keeps bracket.tbd when a page-playoff row carries no edges", () => {
    const html = tree(
      PP().map((f) => ({
        ...f,
        winner_to_fixture: null, winner_to_slot: null,
        loser_to_fixture: null, loser_to_slot: null,
      })),
      "page_playoff",
    );
    expect(html).toContain(TBD);
    expect(html).not.toContain(loser(1, 1));
  });
});

// ---------------------------------------------------------------------------
// THE PAIR — the test whose absence let this happen. The tree and the draw
// list sit on the SAME `?tab=fixtures`, fed by the SAME `listDivisionFixtures`
// rows. Asserting each surface separately is what allowed them to drift; this
// asserts they agree about the SAME fixture's SAME seat.
// ---------------------------------------------------------------------------
describe("the bracket tree and the draw list agree about the same seat", () => {
  const ROWS = [
    FIX("f1", 1, 1, "e1", "e2", { winner_to_fixture: "f3", winner_to_slot: 1 }),
    FIX("f2", 1, 2, "e3", "e4", { winner_to_fixture: "f3", winner_to_slot: 2 }),
    FIX("f3", 2, 1, null, null),
  ];

  /** The panel row carries the scheduling columns the run sheet needs; the
   *  tree ignores them. One row shape, both surfaces — which is the point. */
  const panelRows = ROWS.map((f) => ({
    ...f,
    pool_id: null,
    scheduled_at: null,
    venue: null,
    court_label: null,
    court_id: null,
    court_name: null,
  }));

  function runSheetHtml(): string {
    const html = renderToStaticMarkup(
      <StagesPanel
        divisionId="d1"
        competitionId="c1"
        orgSlug="org"
        compSlug="comp"
        divSlug="div"
        stages={[
          { id: "s1", seq: 0, kind: "knockout", name: "Cup", config: {}, progression: null, status: "active" },
        ]}
        fixtures={panelRows}
        entrantNames={ENTRANTS}
        canEdit
        tz="UTC"
        orgTz="UTC"
        canExport={false}
        viewerPlan="community"
      />,
    );
    const at = html.indexOf('data-testid="run-sheet"');
    expect(at, "the run sheet did not render at all").toBeGreaterThan(-1);
    return html.slice(at);
  }

  it("both surfaces name f3's home seat 'Winner of R1·1' and its away seat 'Winner of R1·2'", () => {
    const treeHtml = tree(ROWS);
    const listHtml = runSheetHtml();
    for (const [seat, expected] of [
      ["home", winner(1, 1)],
      ["away", winner(1, 2)],
    ] as const) {
      expect(treeHtml, `the tree lost f3's ${seat} feeder`).toContain(expected);
      expect(listHtml, `the draw list lost f3's ${seat} feeder`).toContain(expected);
    }
    // Same seat, same answer, on both surfaces — not merely the same two
    // strings somewhere on the page.
    for (const [surface, html] of [["tree", treeHtml], ["list", listHtml]] as const) {
      expect(
        html.indexOf(winner(1, 1)),
        `${surface} read f3's seats in the wrong order`,
      ).toBeLessThan(html.indexOf(winner(1, 2)));
    }
    // Neither surface may still be printing its own TBD for that fixture.
    expect(treeHtml).not.toContain(TBD);
    expect(listHtml).not.toContain(resolveSlotLabel(null, msg, "schedule.tbd"));
  });
});
