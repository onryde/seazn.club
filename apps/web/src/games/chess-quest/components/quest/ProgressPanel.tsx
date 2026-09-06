"use client";

// Progress panel — streak, stars, track bars, a 14-day activity strip and a
// per-game stars table. Port of js/app.js renderProgressPanel (357–441).
import {
  HUNTS,
  MATE1,
  MATE2,
  MATE3,
  TACTICS,
  TACTICS2,
  TACTICS3,
  TACTICS4,
  TACTICS5,
} from "../../content/puzzles";
import { GameId, LESSONS } from "../../content/lessons";
import { useCopy } from "../../lib/copy";
import { last14Days } from "../../lib/last14";
import { useProgress } from "../../lib/progress";
import { STAR_RULES } from "../../lib/stars";
import { Modal } from "./Modal";

// Mate in 1 / Mate in 2 / Piece Detective are each fed by TWO stores that
// index the SAME pool: the arcade writes the legacy arrays (solved / solved2 /
// hunts), while a quest lesson is scoped to a slice of that pool and writes
// the generic tactic store under `mate1_${a}_${b}` / `mate2_${a}_${b}` /
// `hunt_${a}_${b}` (MateInOne.tsx:38, MateInTwo.tsx:53, HangingHunt.tsx:47).
// The slices are a contiguous partition of the pool — pinned by
// content/__tests__/lessons.test.ts — so slice index `i` of `[a,b)` IS pool
// index `a + i`, and this panel counts the UNION of pool indices: reading only
// the legacy array showed a quest-only player "0 / 32 cases", and summing the
// two would count a puzzle solved in both places twice.
//
// Ranges come from LESSONS itself, never a table typed in here, so adding or
// resizing a lesson moves the accounting with it.
function sliceRanges(game: GameId): [number, number][] {
  const seen = new Set<string>();
  const out: [number, number][] = [];
  for (const lesson of LESSONS) {
    const range = lesson.game === game ? lesson.gameOpts?.range : undefined;
    if (!range) continue;
    const key = `${range[0]}_${range[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(range);
  }
  return out;
}

function todayISO() {
  const d = new Date();
  return (
    d.getFullYear() +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0")
  );
}

function Stars({ n }: { n: number }) {
  return (
    <span aria-label={`${n} of 3 stars`} className="text-amber-500">
      {"★".repeat(n)}
      <span className="text-slate-300">{"☆".repeat(3 - n)}</span>
    </span>
  );
}

function TrackBar({ label, done, total }: { label: string; done: number; total: number }) {
  return (
    <div>
      <div className="flex justify-between text-xs text-slate-500">
        <span>{label}</span>
        <span>
          {done} / {total}
        </span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-(color:--cq-accent-soft)">
        <div className="h-full rounded-full bg-(color:--cq-ring)" style={{ width: `${(done / total) * 100}%` }} />
      </div>
    </div>
  );
}

export function ProgressPanel({ onClose, onPrint }: { onClose(): void; onPrint(): void }) {
  const progress = useProgress();
  const { t, isStory } = useCopy();
  const name = progress.getName() || "This player";
  // Trick Shots progress per tier: solved across the tier's packs, and the
  // tier's size read from the packs themselves so the table never hardcodes
  // a count the content has outgrown.
  const tier = (packs: Record<string, { fen: string }[]>) => {
    const keys = Object.keys(packs);
    return {
      done: keys.reduce((s, p) => s + progress.tacticCount(p), 0),
      size: keys.reduce((s, p) => s + packs[p].length, 0),
    };
  };
  const t1 = tier(TACTICS);
  const t2 = tier(TACTICS2);
  const t3 = tier(TACTICS3);
  const t4 = tier(TACTICS4);
  const t5 = tier(TACTICS5);
  const mate3 = progress.tacticCount("mateInThree");

  // Pool indices solved through EITHER store (see sliceRanges above).
  const pooled = (
    game: GameId,
    prefix: string,
    poolLength: number,
    legacySolved: (i: number) => boolean,
  ) => {
    const union = new Set<number>();
    for (let i = 0; i < poolLength; i++) if (legacySolved(i)) union.add(i);
    for (const [start, end] of sliceRanges(game)) {
      const key = `${prefix}_${start}_${end}`;
      for (let i = 0; i < end - start; i++)
        if (progress.isTacticSolved(key, i)) union.add(start + i);
    }
    return union.size;
  };
  const mate1Done = pooled("mateInOne", "mate1", MATE1.length, (i) => progress.isSolved(i));
  const mate2Done = pooled("mateInTwo", "mate2", MATE2.length, (i) => progress.isSolved2(i));
  const huntDone = pooled("hangingHunt", "hunt", HUNTS.length, (i) => progress.isHuntSolved(i));

  const puzzlesTotal =
    mate1Done +
    mate2Done +
    mate3 +
    huntDone +
    t1.done +
    t2.done +
    t3.done +
    t4.done +
    t5.done;
  const streak = progress.streak();
  const days = last14Days(progress.activityDates(), todayISO());

  // A fourth element overrides the row's star cell. The three pooled rows need
  // it: a lesson banks its stars under the per-lesson gameId (`mate1_5_10`, …)
  // that this table never lists, so progress.gameStars("mateInOne") only ever
  // holds what the ARCADE earned. Deriving the cell from the union through the
  // same STAR_RULES the games themselves call keeps the star cell and the
  // count beside it telling one story.
  const rows: [string, string, string, number?][] = [
    [
      "Square Race",
      "squareRace",
      progress.getBest("squareRace") ? `best: ${progress.getBest("squareRace")} squares` : "",
    ],
    ["Coin Hop", "coinHop", ""],
    ["Rook Maze", "rookMaze", ""],
    ["Pawn Wars", "pawnWars", ""],
    [
      "Mate in 1",
      "mateInOne",
      `${mate1Done} / ${MATE1.length} puzzles`,
      STAR_RULES.packStars(mate1Done, MATE1.length),
    ],
    [
      "Mate in 2",
      "mateInTwo",
      `${mate2Done} / ${MATE2.length} puzzles`,
      STAR_RULES.packStars(mate2Done, MATE2.length),
    ],
    ["Mate in 3", "mateInThree", `${mate3} / ${MATE3.length} puzzles`],
    [
      "Piece Detective",
      "hangingHunt",
      `${huntDone} / ${HUNTS.length} cases`,
      STAR_RULES.packStars(huntDone, HUNTS.length),
    ],
    ["Trick Shots", "tacticTrainer", `${t1.done} / ${t1.size} tricks`],
    ["Trick Shots — Master", "tacticTrainer2", `${t2.done} / ${t2.size} tricks`],
    ["Trick Shots — Set-ups", "tacticTrainer3", `${t3.done} / ${t3.size} tricks`],
    ["Trick Shots — Finishers", "tacticTrainer4", `${t4.done} / ${t4.size} tricks`],
    ["Trick Shots — Win a Piece", "tacticTrainer5", `${t5.done} / ${t5.size} tricks`],
  ];

  const tile = (num: React.ReactNode, label: string) => (
    <div className="flex flex-col items-center rounded-xl border border-slate-200 bg-slate-50 p-3">
      <span className="text-xl font-bold text-(color:--cq-ink)">{num}</span>
      <span className="text-xs text-slate-500">{label}</span>
    </div>
  );

  return (
    <Modal title="Progress" onClose={onClose}>
      <p className="text-xs text-slate-500">
        {name} · {isStory() ? "Story" : "Classic"} mode
      </p>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {tile(streak, t("day streak 🔥", "day streak"))}
        {tile(`⭐ ${progress.totalStars()}`, "total stars")}
        {tile(puzzlesTotal, "puzzles solved")}
        {tile(progress.activityDates().length, "days played")}
      </div>

      <h3 className="mk-display mt-5 font-bold text-(color:--cq-ink)">Quest tracks</h3>
      <div className="mt-2 flex flex-col gap-2">
        <TrackBar label="Track 1 · First Steps" done={progress.trackDone(1)} total={24} />
        <TrackBar label="Track 2 · Rising Player" done={progress.trackDone(2)} total={24} />
        <TrackBar label="Track 3 · Opening Range" done={progress.trackDone(3)} total={5} />
      </div>

      <h3 className="mk-display mt-5 font-bold text-(color:--cq-ink)">Last 14 days</h3>
      <div
        role="img"
        aria-label={`Played on ${days.filter((d) => d.on).length} of the last 14 days`}
        className="mt-2 flex justify-between gap-1"
      >
        {days.map((d) => (
          <span key={d.iso} title={`${d.iso}${d.on ? " — played" : ""}`} className="flex flex-col items-center gap-1">
            <span
              className={`h-4 w-4 rounded-full ${d.on ? "bg-emerald-500" : "bg-slate-200"}`}
            />
            <span className="text-[10px] text-slate-400">{d.wd}</span>
          </span>
        ))}
      </div>

      <h3 className="mk-display mt-5 font-bold text-(color:--cq-ink)">Games</h3>
      <table className="mt-2 w-full text-sm">
        <tbody>
          {rows.map(([label, id, detail, stars]) => (
            <tr key={id} className="border-t border-slate-100">
              <td className="py-1.5 text-slate-700">{label}</td>
              <td className="py-1.5">
                <Stars n={stars ?? progress.gameStars(id)} />
              </td>
              <td className="py-1.5 text-right text-xs text-slate-400">{detail}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-5">
        <button type="button" className="btn btn-primary" onClick={onPrint}>
          🖨 Print certificate
        </button>
      </div>
    </Modal>
  );
}
