// Server component: bracket view for knockout/double-elim stages and ladder
// view for stepladder (doc 09 §2). Pure layout from round numbers — no
// per-sport code; scorelines come from ScoreSummary.headline.
// PROMPT-62: single-elim knockouts render as the classic two-sided tree
// (shared engine geometry, same as the console panel and the PDF poster);
// double-elim / stepladder / irregular shapes keep the column fallback.
import Link from "next/link";
import type { PublicFixture } from "@/server/public-site/data";
import { resolveSlotLabel, type SlotLabelLookup } from "@/lib/slot-label";
import type { SlotLabel } from "@/server/usecases/stage-seeding";
import {
  doubleElimBracket,
  lbRowUnit,
  pagePlayoffBracket,
  rowCenter,
  twoSidedBracket,
  type BracketLayout,
  type BracketNode,
  type DoubleElimLayout,
  type PagePlayoffLayout,
  type PagePlayoffSlot,
} from "@seazn/engine/scheduling";
import type { RoundRole } from "@seazn/engine/competition";
import { roundRoleFor, roundRoleLabel } from "@/lib/round-role-label";

interface Props {
  kind: "knockout" | "double_elim" | "stepladder" | "page_playoff";
  fixtures: PublicFixture[];
  entrantNames: Record<string, string>;
  /** Resolved badge/crest URLs (entrant badge → team logo) — same map the
   *  standings table takes; nodes render a crest chip before the name. */
  entrantLogos?: Record<string, string | null>;
  fixtureHref: (fixtureId: string) => string;
  /** P6 fix round 1, finding #2 — a locale-aware lookup for slot labels
   *  (`msgFor(orgLocale, …)`, built server-side by the caller from
   *  `PublicOrg.default_locale`, same pattern as data.ts:502-503). This
   *  component is a Server Component (no "use client"), so passing a real
   *  function down through the tree is safe — nothing here crosses the RSC
   *  boundary into a Client Component.
   *
   *  Mandatory (fix round 2, coordinator item #2): `Schedule`'s equivalent
   *  `slotLabels` prop is compile-required, and this was the odd one out —
   *  optional-with-a-silent-English-default meant a future caller compiles
   *  clean and silently regresses to English. Both real callers already
   *  passed it explicitly (no live defect); this only closes the gap for
   *  the NEXT one. Pass `msg` explicitly from a caller/test that genuinely
   *  wants the English default. */
  lookup: SlotLabelLookup;
}

function sideLabel(
  entrantId: string | null,
  names: Record<string, string>,
  slotLabel: SlotLabel | null,
  lookup: SlotLabelLookup,
): string {
  return entrantId ? (names[entrantId] ?? "?") : resolveSlotLabel(slotLabel, lookup, "bracket.tbd");
}

function FixtureCard({
  fixture,
  entrantNames,
  entrantLogos,
  href,
  lookup,
}: {
  fixture: PublicFixture;
  entrantNames: Record<string, string>;
  entrantLogos?: Record<string, string | null>;
  href: string;
  lookup: SlotLabelLookup;
}) {
  const winner = fixture.outcome?.winner;
  const side = (id: string | null, slotLabel: SlotLabel | null) => {
    const badge = id ? entrantLogos?.[id] : null;
    const label = sideLabel(id, entrantNames, slotLabel, lookup);
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        {badge ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={badge} alt="" className="h-3.5 w-3.5 shrink-0 rounded-[3px] object-cover" />
        ) : null}
        <span
          title={label}
          className={
            id && id === winner
              ? "truncate font-semibold text-ink"
              : winner
                ? "truncate text-ink-muted"
                : "truncate text-ink"
          }
        >
          {label}
        </span>
      </span>
    );
  };
  const live = fixture.status === "in_play";
  return (
    <Link
      href={href}
      className={`relative block overflow-hidden rounded-lg border bg-surface p-2.5 text-sm shadow-sm transition hover:-translate-y-0.5 hover:shadow ${
        live ? "border-emerald-300 hover:border-emerald-400" : "border-zinc-200/80 hover:border-accent-line"
      }`}
    >
      {winner ? <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-accent" /> : null}
      {live ? <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-emerald-400" /> : null}
      <div className="flex flex-col gap-0.5">
        {side(fixture.home_entrant_id, fixture.home_slot_label)}
        {side(fixture.away_entrant_id, fixture.away_slot_label)}
      </div>
      <div className="mt-1.5 text-xs text-ink-muted">
        {live ? (
          <span className="flex items-center gap-1.5 font-bold uppercase tracking-wide text-emerald-600">
            <span className="animate-live-pulse h-1.5 w-1.5 rounded-full bg-emerald-500" />
            Live
          </span>
        ) : fixture.summary?.headline ? (
          <span className="font-display text-sm font-semibold tabular-nums text-accent-strong">
            {fixture.summary.headline}
          </span>
        ) : fixture.scheduled_at ? (
          new Date(fixture.scheduled_at).toLocaleString("en-GB", {
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          })
        ) : (
          "TBD"
        )}
      </div>
    </Link>
  );
}

const COL_W = 208;
const NODE_W = COL_W - 20;
const SLOT_H = 104;
const NODE_H = 92;

function TwoSided({
  layout,
  fixtures,
  entrantNames,
  entrantLogos,
  fixtureHref,
  lookup,
}: {
  layout: BracketLayout;
  fixtures: PublicFixture[];
  entrantNames: Record<string, string>;
  entrantLogos?: Record<string, string | null>;
  fixtureHref: (fixtureId: string) => string;
  lookup: SlotLabelLookup;
}) {
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  const rowsPerSide = Math.max(
    1,
    layout.nodes.filter((n) => n.col === 0 && n.side === "L").length,
  );
  const totalW = (2 * layout.colsPerSide + 1) * COL_W;
  const totalH =
    Math.max(rowsPerSide * SLOT_H, SLOT_H * 2) +
    (layout.thirdPlaceId !== undefined ? NODE_H + 20 : 0);
  const colX = (node: Pick<BracketNode, "side" | "col">): number => {
    if (node.side === "L") return node.col * COL_W;
    if (node.side === "R") return (2 * layout.colsPerSide - node.col) * COL_W + (COL_W - NODE_W);
    return layout.colsPerSide * COL_W + (COL_W - NODE_W) / 2;
  };
  const nodeTop = (node: BracketNode): number => {
    if (node.side === "center") {
      const centre = (rowsPerSide * SLOT_H) / 2 - NODE_H / 2;
      return node.row === 0 ? centre : centre + NODE_H + 20;
    }
    return rowCenter(node.col, node.row) * SLOT_H - NODE_H / 2;
  };

  return (
    <div className="overflow-x-auto" data-bracket="two-sided">
      <div className="relative" style={{ width: totalW, height: totalH }}>
        <svg
          aria-hidden
          className="absolute inset-0"
          width={totalW}
          height={totalH}
          viewBox={`0 0 ${totalW} ${totalH}`}
        >
          {layout.connectors.map((c, i) => {
            const isFinal = c.col === layout.colsPerSide;
            const fromCol = c.col - 1;
            const fx =
              c.side === "L"
                ? fromCol * COL_W + NODE_W
                : (2 * layout.colsPerSide - fromCol) * COL_W + (COL_W - NODE_W);
            const fy = rowCenter(fromCol, c.fromRow) * SLOT_H;
            const tx = isFinal
              ? layout.colsPerSide * COL_W + (c.side === "L" ? (COL_W - NODE_W) / 2 : COL_W - (COL_W - NODE_W) / 2)
              : c.side === "L"
                ? c.col * COL_W
                : (2 * layout.colsPerSide - c.col) * COL_W + COL_W;
            const ty = isFinal ? (rowsPerSide * SLOT_H) / 2 : rowCenter(c.col, c.toRow) * SLOT_H;
            const midX = (fx + tx) / 2;
            return (
              <path
                key={i}
                d={`M ${fx} ${fy} H ${midX} V ${ty} H ${tx}`}
                fill="none"
                className="stroke-zinc-300"
                strokeWidth="1.5"
              />
            );
          })}
        </svg>
        {layout.nodes.map((node) => {
          const f = byId.get(node.fixtureId);
          if (!f) return null;
          return (
            <div
              key={node.fixtureId}
              data-side={node.side}
              className="absolute"
              style={{ left: colX(node), top: nodeTop(node), width: NODE_W }}
            >
              <FixtureCard fixture={f} entrantNames={entrantNames} entrantLogos={entrantLogos} href={fixtureHref(f.id)} lookup={lookup} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// G1 — double-elimination two-lane geometry: winners lane on top, losers lane
// below, grand final (+ optional reset) joining the two lane finals on the
// right. In-lane connectors come from the layout; the two GF joins are drawn
// here from the known lane-final positions.
function DoubleElim({
  layout,
  fixtures,
  entrantNames,
  entrantLogos,
  fixtureHref,
  lookup,
}: {
  layout: DoubleElimLayout;
  fixtures: PublicFixture[];
  entrantNames: Record<string, string>;
  entrantLogos?: Record<string, string | null>;
  fixtureHref: (fixtureId: string) => string;
  lookup: SlotLabelLookup;
}) {
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  const LANE_GAP = 48;
  const LABEL_H = 24;
  // Review finding (defect 2): this tree only ever labelled the two LANES as
  // a whole ("Winners bracket"/"Losers bracket") — it never named individual
  // ROUNDS, so the flagship "name every round by its role" fix (Task 4,
  // roundRoleLabel) never reached the primary view a well-formed
  // double-elim actually renders through (the column-fallback branch below
  // only fires for irregular shapes). ROUND_LABEL_H reserves a second
  // caption row, under the lane title, for a per-COLUMN round name.
  const ROUND_LABEL_H = 18;
  const wbH = Math.max(layout.wbRows, 1) * SLOT_H;
  const lbH = Math.max(layout.lbRows, 0) * SLOT_H;
  const wbTop = LABEL_H + ROUND_LABEL_H;
  const lbTop = wbTop + wbH + LANE_GAP + (lbH > 0 ? LABEL_H + ROUND_LABEL_H : 0);
  const gfX = Math.max(layout.k, layout.lbCols) * COL_W;
  const totalW = gfX + COL_W * (layout.resetId !== undefined ? 2 : 1);
  const totalH = lbTop + lbH;
  const wbY = (col: number, row: number) => wbTop + rowCenter(col, row) * SLOT_H;
  const lbY = (col: number, row: number) => lbTop + rowCenter(lbRowUnit(col), row) * SLOT_H;
  const gfY = (wbTop + (lbH > 0 ? lbTop + lbH : wbTop + wbH)) / 2;
  const wbFinalY = wbY(layout.k - 1, 0);
  const lbFinalY = layout.lbCols > 0 ? lbY(layout.lbCols - 1, 0) : wbFinalY;
  const laneLabel = "font-display text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-muted";

  // Per-column round name (Quarter-finals, Semi-finals, Winners' final, …),
  // ranked within its OWN lane via roundRoleFor — never globally, or a DE's
  // longer losers lane silently reintroduces the count-based naming bug this
  // whole session exists to kill (design §2.3). Same helper the column
  // fallback below already uses, so a round is named identically regardless
  // of which branch renders it.
  const laneFixtures = fixtures.map((f) => ({ round_no: f.round_no, lane: f.lane ?? null }));
  const columnRoundLabel = (lane: "WB" | "LB", col: number): string => {
    const node = layout.nodes.find((n) => n.lane === lane && n.col === col);
    const f = node ? byId.get(node.fixtureId) : undefined;
    if (!f) return "";
    return roundRoleLabel(
      lookup,
      roundRoleFor(
        laneFixtures,
        {
          round_no: f.round_no,
          lane: f.lane ?? null,
          is_final: f.is_final === true,
          third_place: f.third_place === true,
          conditional: f.conditional === true,
        },
        "double_elim",
        null,
      ),
    );
  };

  return (
    <div className="overflow-x-auto" data-bracket="double-elim">
      <div className="relative" style={{ width: totalW, height: totalH }}>
        <span className={`absolute ${laneLabel}`} style={{ left: 0, top: 0 }}>
          {lookup("bracket.winners")}
        </span>
        {Array.from({ length: layout.k }, (_, col) => (
          <span key={`wb-round-${col}`} className={`absolute ${laneLabel}`} style={{ left: col * COL_W, top: LABEL_H }}>
            {columnRoundLabel("WB", col)}
          </span>
        ))}
        {lbH > 0 && (
          <span className={`absolute ${laneLabel}`} style={{ left: 0, top: wbTop + wbH + LANE_GAP }}>
            {lookup("bracket.losers")}
          </span>
        )}
        {lbH > 0 &&
          Array.from({ length: layout.lbCols }, (_, col) => (
            <span
              key={`lb-round-${col}`}
              className={`absolute ${laneLabel}`}
              style={{ left: col * COL_W, top: wbTop + wbH + LANE_GAP + LABEL_H }}
            >
              {columnRoundLabel("LB", col)}
            </span>
          ))}
        <svg aria-hidden className="absolute inset-0" width={totalW} height={totalH} viewBox={`0 0 ${totalW} ${totalH}`}>
          {layout.connectors.map((c, i) => {
            const y = c.lane === "WB" ? wbY : lbY;
            const fx = (c.col - 1) * COL_W + NODE_W;
            const tx = c.col * COL_W;
            const fy = y(c.col - 1, c.fromRow);
            const ty = y(c.col, c.toRow);
            const midX = (fx + tx) / 2;
            return (
              <path key={i} d={`M ${fx} ${fy} H ${midX} V ${ty} H ${tx}`} fill="none" className="stroke-zinc-300" strokeWidth="1.5" />
            );
          })}
          {/* Grand-final joins from both lane finals. */}
          <path
            d={`M ${(layout.k - 1) * COL_W + NODE_W} ${wbFinalY} H ${gfX - 12} V ${gfY} H ${gfX}`}
            fill="none" className="stroke-zinc-300" strokeWidth="1.5"
          />
          {layout.lbCols > 0 && (
            <path
              d={`M ${(layout.lbCols - 1) * COL_W + NODE_W} ${lbFinalY} H ${gfX - 12} V ${gfY} H ${gfX}`}
              fill="none" className="stroke-zinc-300" strokeWidth="1.5"
            />
          )}
        </svg>
        {layout.nodes.map((node) => {
          const f = byId.get(node.fixtureId);
          if (!f) return null;
          const top =
            node.lane === "WB"
              ? wbY(node.col, node.row) - NODE_H / 2
              : node.lane === "LB"
                ? lbY(node.col, node.row) - NODE_H / 2
                : gfY - NODE_H / 2;
          const left = node.lane === "GF" ? gfX + node.col * COL_W : node.col * COL_W;
          return (
            <div key={node.fixtureId} data-lane={node.lane} className="absolute" style={{ left, top, width: NODE_W }}>
              {node.lane === "GF" && (
                <p className={`mb-1 ${laneLabel}`}>{node.col === 0 ? lookup("bracket.grandFinal") : lookup("bracket.reset")}</p>
              )}
              <FixtureCard fixture={f} entrantNames={entrantNames} entrantLogos={entrantLogos} href={fixtureHref(f.id)} lookup={lookup} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function Bracket({ kind, fixtures, entrantNames, entrantLogos, fixtureHref, lookup }: Props) {
  // PROMPT-62: the connected two-sided tree, when the shape allows it.
  if (kind === "knockout") {
    const result = twoSidedBracket(fixtures);
    if (result.ok) {
      return (
        <TwoSided
          layout={result.layout}
          fixtures={fixtures}
          entrantNames={entrantNames}
          entrantLogos={entrantLogos}
          fixtureHref={fixtureHref}
          lookup={lookup}
        />
      );
    }
  }
  // Page playoffs (IPL, spec 2026-07-19): the fixed 4-match card.
  if (kind === "page_playoff") {
    const result = pagePlayoffBracket(fixtures);
    if (result.ok) {
      return (
        <PagePlayoff
          layout={result.layout}
          fixtures={fixtures}
          entrantNames={entrantNames}
          entrantLogos={entrantLogos}
          fixtureHref={fixtureHref}
          lookup={lookup}
        />
      );
    }
  }
  // G1: the two-lane double-elim geometry, when the shape allows it.
  if (kind === "double_elim") {
    const result = doubleElimBracket(fixtures);
    if (result.ok) {
      return (
        <DoubleElim
          layout={result.layout}
          fixtures={fixtures}
          entrantNames={entrantNames}
          entrantLogos={entrantLogos}
          fixtureHref={fixtureHref}
          lookup={lookup}
        />
      );
    }
  }
  const rounds = new Map<number, PublicFixture[]>();
  for (const f of fixtures) {
    const list = rounds.get(f.round_no) ?? [];
    list.push(f);
    rounds.set(f.round_no, list);
  }
  const ordered = [...rounds.entries()].sort(([a], [b]) => a - b);
  // F1 Task 4: name each round by its POSITION (roundRole), never by match
  // count — a double-elim's losers bracket has repeated round sizes, so a
  // count-based namer produces several "Semi-finals" and several "Final"s
  // in one bracket. Ranked per LANE, not across the whole stage: a DE's LB
  // has more rounds than its WB, and a global rank silently reintroduces
  // the bug. page_playoff never reaches this fallback with a real shape
  // (a well-formed 4-fixture set always takes the PagePlayoff tree branch
  // above), so it keeps the plain "Round N" here, same as before.
  const laneFixtures = fixtures.map((f) => ({ round_no: f.round_no, lane: f.lane ?? null }));
  const roundName = (roundNo: number, list: PublicFixture[]): string => {
    if (kind === "knockout" || kind === "double_elim" || kind === "stepladder") {
      const first = list[0]!;
      return roundRoleLabel(
        lookup,
        roundRoleFor(
          laneFixtures,
          {
            round_no: roundNo,
            lane: first.lane ?? null,
            is_final: first.is_final === true,
            third_place: first.third_place === true,
            conditional: first.conditional === true,
          },
          kind,
          null,
        ),
      );
    }
    return roundRoleLabel(lookup, { kind: "plain_round", n: roundNo });
  };

  return (
    <div className="overflow-x-auto">
      <div className={kind === "stepladder" ? "flex flex-col gap-4" : "flex gap-6"}>
        {ordered.map(([roundNo, list]) => (
          <div key={roundNo} className="min-w-48">
            <h3 className="mb-2 font-display text-sm font-semibold uppercase tracking-[0.18em] text-ink-muted">
              {roundName(roundNo, list)}
            </h3>
            <div className="flex flex-col justify-around gap-3">
              {list
                .sort((a, b) => a.seq_in_round - b.seq_in_round)
                .map((f) => (
                  <FixtureCard
                    key={f.id}
                    fixture={f}
                    entrantNames={entrantNames}
                    entrantLogos={entrantLogos}
                    href={fixtureHref(f.id)}
                    lookup={lookup}
                  />
                ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Page playoffs (IPL): Qualifier 1 and the Eliminator on the left, Qualifier 2
// centre (Q1's loser drops in, the Eliminator's winner advances), the Final on
// the right fed by both winners. Positions are the classic playoff card.
// The layout's own `slot` already IS the fixture's identity (pagePlayoffBracket
// assigns it positionally from the SAME emission order bracket.ts's ext_key
// ids encode — F1 Task 4: map it straight to a RoundRole, never re-derive
// from round size).
const PP_ROLE: Record<PagePlayoffSlot, RoundRole> = {
  q1: { kind: "qualifier1" },
  eliminator: { kind: "eliminator" },
  q2: { kind: "qualifier2" },
  final: { kind: "final" },
};

function PagePlayoff({
  layout,
  fixtures,
  entrantNames,
  entrantLogos,
  fixtureHref,
  lookup,
}: {
  layout: PagePlayoffLayout;
  fixtures: PublicFixture[];
  entrantNames: Record<string, string>;
  entrantLogos?: Record<string, string | null>;
  fixtureHref: (fixtureId: string) => string;
  lookup: SlotLabelLookup;
}) {
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  const LABEL_H = 22;
  const pos: Record<string, { x: number; y: number }> = {
    q1: { x: 0, y: LABEL_H },
    eliminator: { x: 0, y: LABEL_H + 190 },
    q2: { x: COL_W, y: LABEL_H + 120 },
    final: { x: 2 * COL_W, y: LABEL_H + 55 },
  };
  const totalW = 2 * COL_W + NODE_W;
  // Each node renders its caption above the card, so the card itself sits
  // LABEL_H below pos.y — size the canvas and centre the connectors on that.
  const totalH = LABEL_H + 190 + LABEL_H + NODE_H + 8;
  const cy = (slot: string) => pos[slot]!.y + LABEL_H + NODE_H / 2;
  const rx = (slot: string) => pos[slot]!.x + NODE_W;
  return (
    <div className="overflow-x-auto" data-bracket="page-playoff">
      <div className="relative" style={{ width: totalW, height: totalH }}>
        <svg aria-hidden className="absolute inset-0" width={totalW} height={totalH} viewBox={`0 0 ${totalW} ${totalH}`}>
          {/* Q1 loser drops into Q2; Eliminator winner advances into Q2. */}
          <path d={`M ${rx("q1")} ${cy("q1")} H ${(rx("q1") + pos.q2!.x) / 2} V ${cy("q2")} H ${pos.q2!.x}`} fill="none" className="stroke-zinc-300" strokeWidth="1.5" strokeDasharray="4 3" />
          <path d={`M ${rx("eliminator")} ${cy("eliminator")} H ${(rx("eliminator") + pos.q2!.x) / 2} V ${cy("q2")} H ${pos.q2!.x}`} fill="none" className="stroke-zinc-300" strokeWidth="1.5" />
          {/* Winners into the Final. */}
          <path d={`M ${rx("q1")} ${cy("q1")} H ${(rx("q1") + pos.final!.x) / 2 + 40} V ${cy("final")} H ${pos.final!.x}`} fill="none" className="stroke-zinc-300" strokeWidth="1.5" />
          <path d={`M ${rx("q2")} ${cy("q2")} H ${(rx("q2") + pos.final!.x) / 2} V ${cy("final")} H ${pos.final!.x}`} fill="none" className="stroke-zinc-300" strokeWidth="1.5" />
        </svg>
        {layout.nodes.map((n) => {
          const f = byId.get(n.fixtureId);
          if (!f) return null;
          const p = pos[n.slot]!;
          return (
            <div key={n.fixtureId} data-slot={n.slot} className="absolute" style={{ left: p.x, top: p.y, width: NODE_W }}>
              <p className="mb-1 font-display text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
                {roundRoleLabel(lookup, PP_ROLE[n.slot])}
              </p>
              <FixtureCard fixture={f} entrantNames={entrantNames} entrantLogos={entrantLogos} href={fixtureHref(f.id)} lookup={lookup} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
