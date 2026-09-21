"use client";

// Console two-sided bracket (PROMPT-62 §2) — the knockout counterpart of the
// flat StagesPanel list (which stays for scheduling/Documents). Geometry comes
// from the shared engine `twoSidedBracket`, so console, public and PDF can
// never diverge. Renders nothing for non-single-elim shapes (double-elim /
// stepladder keep their existing views).
//
// LEAF IMPORT, NOT THE BARREL (Task 11 fix — this broke `next build` outright:
// `Module not found: Can't resolve 'dns'/'fs'/'http2'/'net'/'tls'`). The
// cutover's `build.ts` now imports `placement-client.ts` (`@grpc/grpc-js`,
// Node-only) into `@seazn/engine/scheduling`'s barrel (`index.ts`), and this
// component is a client component — the barrel's whole module graph, grpc-js
// included, was getting pulled into the browser bundle even though only
// `bracket-layout.ts`'s pure geometry functions are used here. `grid-step.ts`
// and `rest-floor.ts` already carry this same leaf-export pattern for exactly
// this reason ("so the schedule page does not ship the solvers");
// `bracket-layout.ts` has zero imports of its own, so it is safe the same way.
import Link from "@/components/ui/console-link";
import { routes } from "@/lib/routes";
import { useMsg } from "@/components/i18n/dict-provider";
import { resolveSlotLabel } from "@/lib/slot-label";
// `seatLabel` is SHARED with the draw list's `RunSheetRow`: both panels sit on
// ?tab=fixtures and must answer the same way about the same seat, so the
// precedence lives in one place rather than once per surface.
import { feedLabels, seatLabel, type FeedLabelPair, type FeedRow } from "@/lib/schedule-board";
import type { SlotLabel } from "@/server/usecases/stage-seeding";
import { roundRoleLabel } from "@/lib/round-role-label";
import { roundRole, type RoundRole } from "@seazn/engine/competition";
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
} from "@seazn/engine/scheduling/bracket-layout";

interface FixtureLike {
  id: string;
  round_no: number;
  seq_in_round: number;
  fixture_no: number;
  home_entrant_id: string | null;
  away_entrant_id: string | null;
  /** D4b (P6) — {key, params} i18n pattern ref while the matching
   *  *_entrant_id is null (V360's fixtures.home/away_slot_label). Optional:
   *  several test fixtures across this file's suite construct FixtureLike
   *  objects by hand without it — absent reads the same as null. */
  home_slot_label?: SlotLabel | null;
  away_slot_label?: SlotLabel | null;
  /** The bracket FEED edges (V214__fixtures.sql), selected by
   *  `listDivisionFixtures` and handed straight to this panel by the division
   *  page. Optional for the same reason the two labels above are: this file's
   *  suite builds FixtureLike objects by hand. */
  winner_to_fixture?: string | null;
  winner_to_slot?: number | null;
  loser_to_fixture?: string | null;
  loser_to_slot?: number | null;
  status: string;
  outcome: unknown;
}

/** A bracket row as `feedLabels()` wants it — the feed columns are optional on
 *  `FixtureLike` and required on `FeedRow`. */
function toFeedRow(f: FixtureLike): FeedRow {
  return {
    id: f.id,
    round_no: f.round_no,
    seq_in_round: f.seq_in_round,
    winner_to_fixture: f.winner_to_fixture ?? null,
    winner_to_slot: f.winner_to_slot ?? null,
    loser_to_fixture: f.loser_to_fixture ?? null,
    loser_to_slot: f.loser_to_slot ?? null,
  };
}

interface Props {
  /** Stage kind — stepladder gets the rung list; bracket shapes are detected
   *  structurally from the fixtures. */
  kind?: string;
  /** This stage's rows — the tree's GEOMETRY is per stage. */
  fixtures: FixtureLike[];
  /** The WHOLE division's rows, used only to build the feed-label map.
   *
   *  Required, not optional, and deliberately separate from `fixtures`.
   *  `feedLabels()` needs both ends of an edge in one row list
   *  (`!byId.has(target)`), and `wireCrossFeeds` (usecases/stages.ts:2514)
   *  writes edges whose SOURCE and DEST sit in different stages, from a
   *  stage's `cross_feeds` config. Built from a per-stage slice this tree
   *  would silently drop those, label a seat "TBD", and disagree with the
   *  draw list directly below it — which is the exact symptom this whole
   *  change exists to remove. The draw list (`stages-panel.tsx`) and the
   *  schedule board both scope whole-division; this makes three of three.
   *  Required so tsc, not a reviewer, catches a caller that reverts to the
   *  narrow scope. */
  divisionFixtures: FixtureLike[];
  entrantNames: Record<string, string>;
  /** entrant_id → resolved badge URL (PROMPT-60 resolver); null/absent = none. */
  entrantBadges?: Record<string, string | null>;
  /** fixture_id → ScoreSummary.headline (from match_states). */
  headlines?: Record<string, string>;
  orgSlug: string;
  compSlug: string;
  divSlug: string;
}

const COL_W = 190; // px per bracket column
const SLOT_H = 76; // px per round-0 slot
const NODE_H = 60;
const NODE_W = COL_W - 24;

/** Horizontal px of a node's column: L columns grow rightwards, R columns
 *  mirror from the right edge, the centre Final sits in the middle. */
function colX(node: Pick<BracketNode, "side" | "col">, colsPerSide: number): number {
  if (node.side === "L") return node.col * COL_W;
  if (node.side === "R") return (2 * colsPerSide - node.col) * COL_W;
  return colsPerSide * COL_W; // center
}

export function BracketPanel({
  kind,
  fixtures,
  divisionFixtures,
  entrantNames,
  entrantBadges,
  headlines,
  orgSlug,
  compSlug,
  divSlug,
}: Props) {
  const msg = useMsg();
  // Built HERE, once, from the WHOLE DIVISION's rows — the same scope the
  // draw list (`stages-panel.tsx`) and the schedule board use, so the three
  // surfaces cannot diverge by construction rather than by agreement. See
  // `divisionFixtures`' own note for why a per-stage slice is wrong.
  // No second query: the page already holds these rows for the list.
  // `feeds` is a REQUIRED prop on all three sub-panels below, so tsc catches
  // a mount that forgot to pass it.
  const feeds = feedLabels(divisionFixtures.map(toFeedRow));
  if (kind === "page_playoff") {
    const pp = pagePlayoffBracket(fixtures);
    if (!pp.ok) return null;
    return (
      <PagePlayoffPanel
        layout={pp.layout}
        fixtures={fixtures}
        feeds={feeds}
        entrantNames={entrantNames}
        {...(entrantBadges === undefined ? {} : { entrantBadges })}
        {...(headlines === undefined ? {} : { headlines })}
        orgSlug={orgSlug}
        compSlug={compSlug}
        divSlug={divSlug}
      />
    );
  }
  if (kind === "stepladder") {
    return (
      <StepladderPanel
        fixtures={fixtures}
        feeds={feeds}
        entrantNames={entrantNames}
        {...(entrantBadges === undefined ? {} : { entrantBadges })}
        {...(headlines === undefined ? {} : { headlines })}
        orgSlug={orgSlug}
        compSlug={compSlug}
        divSlug={divSlug}
      />
    );
  }
  const result = twoSidedBracket(fixtures);
  // G8: double-elim divisions get the two-lane geometry instead of nothing.
  const de = result.ok ? null : doubleElimBracket(fixtures);
  if (!result.ok) {
    if (de?.ok) {
      return (
        <DoubleElimPanel
          layout={de.layout}
          fixtures={fixtures}
          feeds={feeds}
          entrantNames={entrantNames}
          {...(entrantBadges === undefined ? {} : { entrantBadges })}
          {...(headlines === undefined ? {} : { headlines })}
          orgSlug={orgSlug}
          compSlug={compSlug}
          divSlug={divSlug}
        />
      );
    }
    return null;
  }
  const layout: BracketLayout = result.layout;
  const byId = new Map(fixtures.map((f) => [f.id, f]));

  const totalW = (2 * layout.colsPerSide + 1) * COL_W;
  const rowsPerSide = Math.max(
    1,
    layout.nodes.filter((n) => n.col === 0 && n.side === "L").length,
  );
  const totalH = Math.max(rowsPerSide * SLOT_H, SLOT_H * 2) + (layout.thirdPlaceId ? NODE_H + 16 : 0);

  const nodeTop = (node: BracketNode): number => {
    if (node.side === "center") {
      const centre = (rowsPerSide * SLOT_H) / 2 - NODE_H / 2;
      return node.row === 0 ? centre : centre + NODE_H + 16; // 3rd place hangs under
    }
    return rowCenter(node.col, node.row) * SLOT_H - NODE_H / 2;
  };
  const nodeCenterY = (side: "L" | "R", col: number, row: number): number =>
    rowCenter(col, row) * SLOT_H;

  const side = (
    entrantId: string | null,
    slotLabel: SlotLabel | null | undefined,
    winner: string | null,
    live: boolean,
  ) => {
    const name = entrantId ? (entrantNames[entrantId] ?? entrantId) : null;
    const label = name ?? resolveSlotLabel(slotLabel ?? null, msg, "bracket.tbd");
    const badge = entrantId ? entrantBadges?.[entrantId] : null;
    const isWinner = winner !== null && winner === entrantId;
    const muted = winner !== null && winner !== entrantId;
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        {badge ? (
          // eslint-disable-next-line @next/next/no-img-element -- tenant crest
          <img src={badge} alt="" className="h-3.5 w-3.5 shrink-0 rounded-[3px] object-cover" />
        ) : null}
        <span
          title={label}
          className={`truncate text-xs ${
            name === null
              ? "italic text-[color:var(--app-fg-muted,#94a3b8)]"
              : isWinner
                ? "font-semibold text-[color:var(--app-fg,#e2e8f0)]"
                : muted
                  ? "text-[color:var(--app-fg-muted,#94a3b8)]"
                  : "text-[color:var(--app-fg,#e2e8f0)]"
          }`}
        >
          {label}
        </span>
        {live && <span className="animate-live-pulse h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />}
      </span>
    );
  };

  return (
    <section className="card overflow-hidden" data-testid="bracket-panel">
      <header className="border-b border-slate-100 px-4 py-3">
        <h3 className="text-sm font-semibold text-slate-800">{msg("bracket.title")}</h3>
      </header>
      <div className="overflow-x-auto bg-[color:var(--app-surface,#0f172a)] p-4">
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
              // Feeder centre (col-1 for normal targets; innermost side column
              // feeds the Final).
              const fromCol = c.col - 1;
              const fx =
                c.side === "L"
                  ? fromCol * COL_W + NODE_W
                  : (2 * layout.colsPerSide - fromCol) * COL_W + (COL_W - NODE_W);
              const fy = nodeCenterY(c.side, fromCol, c.fromRow);
              const tx = isFinal
                ? layout.colsPerSide * COL_W + (c.side === "L" ? 0 : NODE_W)
                : c.side === "L"
                  ? c.col * COL_W
                  : (2 * layout.colsPerSide - c.col) * COL_W + NODE_W;
              const ty = isFinal
                ? (rowsPerSide * SLOT_H) / 2
                : nodeCenterY(c.side, c.col, c.toRow);
              const midX = (fx + tx) / 2;
              return (
                <path
                  key={i}
                  d={`M ${fx} ${fy} H ${midX} V ${ty} H ${tx}`}
                  fill="none"
                  stroke="var(--app-hairline, #334155)"
                  strokeWidth="1.5"
                />
              );
            })}
          </svg>
          {layout.nodes.map((node) => {
            const f = byId.get(node.fixtureId);
            if (!f) return null;
            const winner = (f.outcome as { winner?: string } | null)?.winner ?? null;
            const live = f.status === "in_play";
            const headline = headlines?.[f.id];
            return (
              <Link
                key={node.fixtureId}
                href={routes.fixture(orgSlug, compSlug, divSlug, f.fixture_no)}
                data-side={node.side}
                className="absolute block rounded-lg border border-[color:var(--app-hairline,#334155)] bg-[color:var(--app-card,#1e293b)] px-2.5 py-1.5 shadow-sm transition hover:-translate-y-0.5 hover:shadow"
                style={{
                  left: colX(node, layout.colsPerSide) + (node.side === "R" ? COL_W - NODE_W : 0),
                  top: nodeTop(node),
                  width: NODE_W,
                  height: NODE_H,
                }}
              >
                <span className="flex h-full flex-col justify-center gap-0.5">
                  {side(f.home_entrant_id, seatLabel(f.home_slot_label, feeds[f.id], "home"), winner, live)}
                  {side(f.away_entrant_id, seatLabel(f.away_slot_label, feeds[f.id], "away"), winner, live)}
                </span>
                {headline !== undefined && (
                  <span className="absolute right-2 top-1.5 font-display text-[11px] tabular-nums text-[color:var(--app-fg-muted,#94a3b8)]">
                    {headline}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/** G8 — console double-elim: winners lane over losers lane, grand final (+
 *  reset) joining the lane finals. Same night styling and node markup as the
 *  single-elim panel; in-lane connectors from the shared engine layout. */
function DoubleElimPanel({
  layout,
  fixtures,
  feeds,
  entrantNames,
  entrantBadges,
  headlines,
  orgSlug,
  compSlug,
  divSlug,
}: {
  layout: DoubleElimLayout;
  fixtures: FixtureLike[];
  /** fixture_id → the label pair its feed edges imply; see `seatLabel`. */
  feeds: Record<string, FeedLabelPair>;
  entrantNames: Record<string, string>;
  entrantBadges?: Record<string, string | null>;
  headlines?: Record<string, string>;
  orgSlug: string;
  compSlug: string;
  divSlug: string;
}) {
  const msg = useMsg();
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  const LANE_GAP = 44;
  const LABEL_H = 22;
  // Review finding (defect 2): same structural gap as the public site's
  // DoubleElim tree — this panel labels the two LANES as a whole but never
  // named individual ROUNDS. ROUND_LABEL_H reserves a second caption row for
  // a per-COLUMN round name.
  const ROUND_LABEL_H = 16;
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
  const laneLabel =
    "absolute font-display text-[10px] font-semibold uppercase tracking-[0.14em] text-[color:var(--app-fg-muted,#94a3b8)]";

  // Per-column round name (Quarter-finals, Semi-finals, Winners' final, …).
  // FixtureLike carries no `lane` column (unlike the public site's
  // PublicFixture), so roundInLane/lastRoundInLane come straight from the
  // LAYOUT's own column index instead of re-deriving from fixture round_no
  // — doubleElimBracket already builds `col` as the 0-based, ascending-
  // round_no rank within its lane (bracket-layout.ts), the exact number
  // roundRole() needs. isFinal/thirdPlace/conditional are unused by the
  // WB/LB branch roundRole() takes here (only the GF lane and the
  // third-place early-return read them — verified against round-role.ts),
  // so they are fixed `false` rather than threaded through unused.
  const columnRoundLabel = (lane: "WB" | "LB", col: number): string =>
    roundRoleLabel(
      msg,
      roundRole({
        stageKind: "double_elim",
        lane,
        roundInLane: col,
        lastRoundInLane: (lane === "WB" ? layout.k : layout.lbCols) - 1,
        isFinal: false,
        thirdPlace: false,
        conditional: false,
        extKey: null,
      }),
    );

  const node = (f: FixtureLike, left: number, top: number, key: string) => {
    const winner = (f.outcome as { winner?: string } | null)?.winner ?? null;
    const live = f.status === "in_play";
    const headline = headlines?.[f.id];
    const sideRow = (entrantId: string | null, slotLabel: SlotLabel | null | undefined) => {
      const name = entrantId ? (entrantNames[entrantId] ?? entrantId) : null;
      const label = name ?? resolveSlotLabel(slotLabel ?? null, msg, "bracket.tbd");
      const badge = entrantId ? entrantBadges?.[entrantId] : null;
      const isWinner = winner !== null && winner === entrantId;
      const mutedRow = winner !== null && winner !== entrantId;
      return (
        <span className="flex min-w-0 items-center gap-1.5">
          {badge ? (
            // eslint-disable-next-line @next/next/no-img-element -- tenant crest
            <img src={badge} alt="" className="h-3.5 w-3.5 shrink-0 rounded-[3px] object-cover" />
          ) : null}
          <span
            title={label}
            className={`truncate text-xs ${
              name === null
                ? "italic text-[color:var(--app-fg-muted,#94a3b8)]"
                : isWinner
                  ? "font-semibold text-[color:var(--app-fg,#e2e8f0)]"
                  : mutedRow
                    ? "text-[color:var(--app-fg-muted,#94a3b8)]"
                    : "text-[color:var(--app-fg,#e2e8f0)]"
            }`}
          >
            {label}
          </span>
          {live && <span className="animate-live-pulse h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />}
        </span>
      );
    };
    return (
      <Link
        key={key}
        href={routes.fixture(orgSlug, compSlug, divSlug, f.fixture_no)}
        className="absolute block rounded-lg border border-[color:var(--app-hairline,#334155)] bg-[color:var(--app-card,#1e293b)] px-2.5 py-1.5 shadow-sm transition hover:-translate-y-0.5 hover:shadow"
        style={{ left, top, width: NODE_W, height: NODE_H }}
      >
        <span className="flex h-full flex-col justify-center gap-0.5">
          {sideRow(f.home_entrant_id, seatLabel(f.home_slot_label, feeds[f.id], "home"))}
          {sideRow(f.away_entrant_id, seatLabel(f.away_slot_label, feeds[f.id], "away"))}
        </span>
        {headline !== undefined && (
          <span className="absolute right-2 top-1.5 font-display text-[11px] tabular-nums text-[color:var(--app-fg-muted,#94a3b8)]">
            {headline}
          </span>
        )}
      </Link>
    );
  };

  return (
    <section className="card overflow-hidden" data-testid="bracket-panel-de">
      <header className="border-b border-slate-100 px-4 py-3">
        <h3 className="text-sm font-semibold text-slate-800">{msg("bracket.title")}</h3>
      </header>
      <div className="overflow-x-auto bg-[color:var(--app-surface,#0f172a)] p-4">
        <div className="relative" style={{ width: totalW, height: totalH }}>
          <span className={laneLabel} style={{ left: 0, top: 0 }}>
            {msg("bracket.winners")}
          </span>
          {Array.from({ length: layout.k }, (_, col) => (
            <span key={`wb-round-${col}`} className={laneLabel} style={{ left: col * COL_W, top: LABEL_H }}>
              {columnRoundLabel("WB", col)}
            </span>
          ))}
          {lbH > 0 && (
            <span className={laneLabel} style={{ left: 0, top: wbTop + wbH + LANE_GAP }}>
              {msg("bracket.losers")}
            </span>
          )}
          {lbH > 0 &&
            Array.from({ length: layout.lbCols }, (_, col) => (
              <span
                key={`lb-round-${col}`}
                className={laneLabel}
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
                <path key={i} d={`M ${fx} ${fy} H ${midX} V ${ty} H ${tx}`} fill="none" stroke="var(--app-hairline, #334155)" strokeWidth="1.5" />
              );
            })}
            <path
              d={`M ${(layout.k - 1) * COL_W + NODE_W} ${wbY(layout.k - 1, 0)} H ${gfX - 10} V ${gfY} H ${gfX}`}
              fill="none" stroke="var(--app-hairline, #334155)" strokeWidth="1.5"
            />
            {layout.lbCols > 0 && (
              <path
                d={`M ${(layout.lbCols - 1) * COL_W + NODE_W} ${lbY(layout.lbCols - 1, 0)} H ${gfX - 10} V ${gfY} H ${gfX}`}
                fill="none" stroke="var(--app-hairline, #334155)" strokeWidth="1.5"
              />
            )}
          </svg>
          {layout.nodes.map((n) => {
            const f = byId.get(n.fixtureId);
            if (!f) return null;
            const top =
              n.lane === "WB"
                ? wbY(n.col, n.row) - NODE_H / 2
                : n.lane === "LB"
                  ? lbY(n.col, n.row) - NODE_H / 2
                  : gfY - NODE_H / 2;
            const left = n.lane === "GF" ? gfX + n.col * COL_W : n.col * COL_W;
            return (
              <span key={n.fixtureId} data-lane={n.lane} className="contents">
                {n.lane === "GF" && (
                  <span className={laneLabel} style={{ left, top: top - LABEL_H + 4 }}>
                    {/* Paired-node lane annotation (GF directly above Reset),
                        not a list heading -- same treatment as bracket.winners/
                        bracket.losers above and the public site's identical
                        untouched "Grand final"/"Reset" pair (bracket.tsx's
                        DoubleElim tree): terse "Reset" reads correctly right
                        under a "Grand final" sibling, where roundRoleLabel's
                        list-context "Grand final (reset)" would be redundant. */}
                    {n.col === 0 ? msg("bracket.grandFinal") : msg("bracket.reset")}
                  </span>
                )}
                {node(f, left, top, n.fixtureId)}
              </span>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/** Stepladder — rung-by-rung list (the ladder IS the geometry): challenger
 *  climbs bottom-up, each rung's winner feeds the next. Night-styled like
 *  the bracket nodes; rung labels mirror the public view. */
function StepladderPanel({
  fixtures,
  feeds,
  entrantNames,
  entrantBadges,
  headlines,
  orgSlug,
  compSlug,
  divSlug,
}: {
  fixtures: FixtureLike[];
  /** fixture_id → the label pair its feed edges imply; see `seatLabel`. */
  feeds: Record<string, FeedLabelPair>;
  entrantNames: Record<string, string>;
  entrantBadges?: Record<string, string | null>;
  headlines?: Record<string, string>;
  orgSlug: string;
  compSlug: string;
  divSlug: string;
}) {
  const msg = useMsg();
  if (fixtures.length === 0) return null;
  const rungs = [...fixtures].sort((a, b) => a.round_no - b.round_no);
  const row = (f: FixtureLike, entrantId: string | null, slotLabel: SlotLabel | null | undefined) => {
    const winner = (f.outcome as { winner?: string } | null)?.winner ?? null;
    const name = entrantId ? (entrantNames[entrantId] ?? entrantId) : null;
    const label = name ?? resolveSlotLabel(slotLabel ?? null, msg, "bracket.tbd");
    const badge = entrantId ? entrantBadges?.[entrantId] : null;
    const isWinner = winner !== null && winner === entrantId;
    const muted = winner !== null && winner !== entrantId;
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        {badge ? (
          // eslint-disable-next-line @next/next/no-img-element -- tenant crest
          <img src={badge} alt="" className="h-3.5 w-3.5 shrink-0 rounded-[3px] object-cover" />
        ) : null}
        <span
          title={label}
          className={`truncate text-xs ${
            name === null
              ? "italic text-[color:var(--app-fg-muted,#94a3b8)]"
              : isWinner
                ? "font-semibold text-[color:var(--app-fg,#e2e8f0)]"
                : muted
                  ? "text-[color:var(--app-fg-muted,#94a3b8)]"
                  : "text-[color:var(--app-fg,#e2e8f0)]"
          }`}
        >
          {label}
        </span>
        {f.status === "in_play" && (
          <span className="animate-live-pulse h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
        )}
      </span>
    );
  };
  return (
    <section className="card overflow-hidden" data-testid="bracket-panel-ladder">
      <header className="border-b border-slate-100 px-4 py-3">
        <h3 className="text-sm font-semibold text-slate-800">{msg("bracket.title")}</h3>
      </header>
      <div className="space-y-3 bg-[color:var(--app-surface,#0f172a)] p-4">
        {rungs.map((f, i) => (
          <div key={f.id}>
            <p className="mb-1 font-display text-[10px] font-semibold uppercase tracking-[0.14em] text-[color:var(--app-fg-muted,#94a3b8)]">
              {roundRoleLabel(msg, i === rungs.length - 1 ? { kind: "final" } : { kind: "rung", n: i + 1 })}
            </p>
            <Link
              href={routes.fixture(orgSlug, compSlug, divSlug, f.fixture_no)}
              className="relative block max-w-md rounded-lg border border-[color:var(--app-hairline,#334155)] bg-[color:var(--app-card,#1e293b)] px-2.5 py-1.5 shadow-sm transition hover:-translate-y-0.5 hover:shadow"
            >
              <span className="flex flex-col gap-0.5">
                {row(f, f.home_entrant_id, seatLabel(f.home_slot_label, feeds[f.id], "home"))}
                {row(f, f.away_entrant_id, seatLabel(f.away_slot_label, feeds[f.id], "away"))}
              </span>
              {headlines?.[f.id] !== undefined && (
                <span className="absolute right-2 top-1.5 font-display text-[11px] tabular-nums text-[color:var(--app-fg-muted,#94a3b8)]">
                  {headlines[f.id]}
                </span>
              )}
            </Link>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Page playoffs (IPL): Q1 + Eliminator left, Q2 centre (Q1 loser drops in,
 *  dashed), Final right — night-styled like the other bracket panels. */
function PagePlayoffPanel({
  layout,
  fixtures,
  feeds,
  entrantNames,
  entrantBadges,
  headlines,
  orgSlug,
  compSlug,
  divSlug,
}: {
  layout: PagePlayoffLayout;
  fixtures: FixtureLike[];
  /** fixture_id → the label pair its feed edges imply; see `seatLabel`. */
  feeds: Record<string, FeedLabelPair>;
  entrantNames: Record<string, string>;
  entrantBadges?: Record<string, string | null>;
  headlines?: Record<string, string>;
  orgSlug: string;
  compSlug: string;
  divSlug: string;
}) {
  const msg = useMsg();
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  const LABEL_H = 20;
  const pos: Record<string, { x: number; y: number }> = {
    q1: { x: 0, y: LABEL_H },
    eliminator: { x: 0, y: LABEL_H + 168 },
    q2: { x: COL_W, y: LABEL_H + 106 },
    final: { x: 2 * COL_W, y: LABEL_H + 48 },
  };
  const totalW = 2 * COL_W + NODE_W;
  const totalH = LABEL_H + 168 + NODE_H + 8;
  const cy = (slot: string) => pos[slot]!.y + NODE_H / 2;
  const rxx = (slot: string) => pos[slot]!.x + NODE_W;
  const PP_ROLE: Record<PagePlayoffSlot, RoundRole> = {
    q1: { kind: "qualifier1" },
    eliminator: { kind: "eliminator" },
    q2: { kind: "qualifier2" },
    final: { kind: "final" },
  };
  const row = (f: FixtureLike, entrantId: string | null, slotLabel: SlotLabel | null | undefined) => {
    const winner = (f.outcome as { winner?: string } | null)?.winner ?? null;
    const name = entrantId ? (entrantNames[entrantId] ?? entrantId) : null;
    const label = name ?? resolveSlotLabel(slotLabel ?? null, msg, "bracket.tbd");
    const badge = entrantId ? entrantBadges?.[entrantId] : null;
    const isWinner = winner !== null && winner === entrantId;
    const mutedRow = winner !== null && winner !== entrantId;
    return (
      <span className="flex min-w-0 items-center gap-1.5">
        {badge ? (
          // eslint-disable-next-line @next/next/no-img-element -- tenant crest
          <img src={badge} alt="" className="h-3.5 w-3.5 shrink-0 rounded-[3px] object-cover" />
        ) : null}
        <span
          title={label}
          className={`truncate text-xs ${
            name === null
              ? "italic text-[color:var(--app-fg-muted,#94a3b8)]"
              : isWinner
                ? "font-semibold text-[color:var(--app-fg,#e2e8f0)]"
                : mutedRow
                  ? "text-[color:var(--app-fg-muted,#94a3b8)]"
                  : "text-[color:var(--app-fg,#e2e8f0)]"
          }`}
        >
          {label}
        </span>
        {f.status === "in_play" && <span className="animate-live-pulse h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />}
      </span>
    );
  };
  return (
    <section className="card overflow-hidden" data-testid="bracket-panel-page">
      <header className="border-b border-slate-100 px-4 py-3">
        <h3 className="text-sm font-semibold text-slate-800">{msg("bracket.title")}</h3>
      </header>
      <div className="overflow-x-auto bg-[color:var(--app-surface,#0f172a)] p-4">
        <div className="relative" style={{ width: totalW, height: totalH }}>
          <svg aria-hidden className="absolute inset-0" width={totalW} height={totalH} viewBox={`0 0 ${totalW} ${totalH}`}>
            <path d={`M ${rxx("q1")} ${cy("q1")} H ${(rxx("q1") + pos.q2!.x) / 2} V ${cy("q2")} H ${pos.q2!.x}`} fill="none" stroke="var(--app-hairline, #334155)" strokeWidth="1.5" strokeDasharray="4 3" />
            <path d={`M ${rxx("eliminator")} ${cy("eliminator")} H ${(rxx("eliminator") + pos.q2!.x) / 2} V ${cy("q2")} H ${pos.q2!.x}`} fill="none" stroke="var(--app-hairline, #334155)" strokeWidth="1.5" />
            <path d={`M ${rxx("q1")} ${cy("q1")} H ${(rxx("q1") + pos.final!.x) / 2 + 40} V ${cy("final")} H ${pos.final!.x}`} fill="none" stroke="var(--app-hairline, #334155)" strokeWidth="1.5" />
            <path d={`M ${rxx("q2")} ${cy("q2")} H ${(rxx("q2") + pos.final!.x) / 2} V ${cy("final")} H ${pos.final!.x}`} fill="none" stroke="var(--app-hairline, #334155)" strokeWidth="1.5" />
          </svg>
          {layout.nodes.map((n) => {
            const f = byId.get(n.fixtureId);
            if (!f) return null;
            const p = pos[n.slot]!;
            return (
              <span key={n.fixtureId} data-slot={n.slot} className="contents">
                <span className="absolute font-display text-[10px] font-semibold uppercase tracking-[0.14em] text-[color:var(--app-fg-muted,#94a3b8)]" style={{ left: p.x, top: p.y - LABEL_H + 4 }}>
                  {roundRoleLabel(msg, PP_ROLE[n.slot])}
                </span>
                <Link
                  href={routes.fixture(orgSlug, compSlug, divSlug, f.fixture_no)}
                  className="absolute block rounded-lg border border-[color:var(--app-hairline,#334155)] bg-[color:var(--app-card,#1e293b)] px-2.5 py-1.5 shadow-sm transition hover:-translate-y-0.5 hover:shadow"
                  style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
                >
                  <span className={`flex h-full flex-col justify-center gap-0.5 ${headlines?.[f.id] !== undefined ? "pr-12" : ""}`}>
                    {row(f, f.home_entrant_id, seatLabel(f.home_slot_label, feeds[f.id], "home"))}
                    {row(f, f.away_entrant_id, seatLabel(f.away_slot_label, feeds[f.id], "away"))}
                  </span>
                  {headlines?.[f.id] !== undefined && (
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 font-display text-[11px] tabular-nums text-[color:var(--app-fg-muted,#94a3b8)]">
                      {headlines[f.id]}
                    </span>
                  )}
                </Link>
              </span>
            );
          })}
        </div>
      </div>
    </section>
  );
}
