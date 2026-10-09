// W2b Task 5 (ruling 102 Q1; plan PF-3) — migrates the golden corpora's recorded `core.forfeit` reasons to the W2b
// vocabulary. Before W2b a forfeit's reason was free text ("no-show", "walkover" at any point); W2b closes it
// (`FORFEIT_REASONS`) and the D3 phase guard refuses a walkover after the start. The ruled rule: a forfeit before any
// `core.start` still active at that point is a `walkover`; one after it is `retired`, in every sport (chess included —
// PF-3: no boardgame exception, since D3 R4 admits `retired` after the start everywhere). Only the reason moves: `by`,
// every other event, and every recorded state stay byte-for-byte; the rebaseline that follows is a separate commit.
//
// One-off CLI: `node --experimental-strip-types src/testkit/golden-forfeit-migration.ts [--write]` prints the
// per-sport table, and with `--write` rewrites the corpora in place.
import { pathToFileURL } from "node:url";
import { resolveVoids } from "../core/events.ts";
import { readCorpus, SPORT_DIRS, writeCorpus, type GoldenEvent } from "./golden.ts";
import { makeEnvelope } from "./helpers.ts";

/** A recorded event; `voids` (an `e-<index>` id, as `makeEnvelope` names them) only in synthetic streams — the
 *  committed corpora carry no `core.void`. */
export type MigratableEvent = GoldenEvent & { readonly voids?: string };
type MigratedReason = "walkover" | "retired";

function forfeitSide(payload: unknown): string {
  const by = payload !== null && typeof payload === "object" ? (payload as { by?: unknown }).by : undefined;
  if (typeof by !== "string") throw new Error(`golden forfeit migration: a core.forfeit names no side: ${JSON.stringify(payload)}`);
  return by;
}

/** The ruled reason for the forfeit at `index`: walkover unless an unvoided core.start precedes it. Voids are resolved
 *  over the PREFIX — a void recorded after the forfeit cannot un-start the match the forfeit was recorded in. */
function ruledReason(events: readonly MigratableEvent[], index: number): MigratedReason {
  const prefix = events.slice(0, index).map((event, i) => makeEnvelope(i, event as never, event.voids));
  return resolveVoids(prefix).some((event) => event.type === "core.start") ? "retired" : "walkover";
}

/** Rewrites every `core.forfeit` reason in `streams` to the ruled one. `examined` counts every forfeit seen;
 *  `rewritten` the ones whose recorded reason differed. */
export function migrateGoldenForfeits<S extends { readonly events: readonly MigratableEvent[] }>(
  streams: readonly S[],
): { streams: S[]; examined: number; rewritten: number } {
  let examined = 0;
  let rewritten = 0;
  const out = streams.map((stream) => {
    const events = stream.events.map((event, index) => {
      if (event.type !== "core.forfeit") return event;
      examined++;
      const by = forfeitSide(event.payload);
      const reason = ruledReason(stream.events, index);
      // Assumption, guarded: a double walkover is a W2b shape and a pre-start one; it has no "retired" form.
      if (by === "both" && reason === "retired") {
        throw new Error("golden forfeit migration: a double walkover after core.start has no W2b reason");
      }
      const payload = event.payload as Record<string, unknown>;
      if (payload.reason === reason) return event;
      rewritten++;
      return { ...event, payload: { ...payload, reason } };
    });
    return { ...stream, events };
  });
  return { streams: out, examined, rewritten };
}

function main(args: readonly string[]): number {
  const write = args.includes("--write");
  const rows: string[] = ["| sport | examined | rewritten | walkover | retired |", "|---|---|---|---|---|"];
  let examined = 0;
  let rewritten = 0;
  for (const key of Object.keys(SPORT_DIRS)) {
    const corpus = readCorpus(key);
    const result = migrateGoldenForfeits(corpus.streams);
    const reasons = result.streams
      .flatMap((stream) => stream.events)
      .filter((event) => event.type === "core.forfeit")
      .map((event) => (event.payload as { reason: string }).reason);
    const walkover = reasons.filter((reason) => reason === "walkover").length;
    rows.push(`| ${key} | ${result.examined} | ${result.rewritten} | ${walkover} | ${reasons.length - walkover} |`);
    examined += result.examined;
    rewritten += result.rewritten;
    if (write && result.rewritten > 0) writeCorpus({ ...corpus, streams: result.streams });
  }
  rows.push(`| **total** | ${examined} | ${rewritten} | | |`);
  process.stdout.write(`${rows.join("\n")}\n${write ? "written" : "dry run (pass --write to rewrite the corpora)"}\n`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
