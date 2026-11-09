import "server-only";
import { cmp } from "./helpers";

const normName = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Scheduling-only identity guard (#396, design §4.2). Persons whose normalised
 * names match but whose ids differ collapse to ONE synthetic key so person
 * rules see one human. The key never leaves the pack (it lives in
 * `participants`, which `toModelPayload` strips), nothing writes it, and
 * nothing renders it as a merge.
 *
 * The asymmetry that justifies it holds for scheduling and NOT for records: a
 * false merge costs one unnecessary rest gap; a false split books one human on
 * two courts at the same time. It would be wrong in the database — merging two
 * real different people corrupts stats, discipline history, photo and consent.
 * Over-constrain the schedule, never the database.
 *
 * Blank names are skipped: "" and "   " normalise identically, so bucketing
 * them would fuse every unnamed person in the division into one player.
 *
 * Exported so the joint (#350) builder reuses this resolver verbatim rather
 * than growing a second, divergent notion of "same person".
 */
export function personKeyResolver(personNameById: ReadonlyMap<string, string>): {
  keyOf: (personId: string) => string;
  assumptions: string[];
} {
  const byName = new Map<string, string[]>();
  for (const [id, name] of personNameById) {
    const k = normName(name);
    if (k === "") continue;
    (byName.get(k) ?? byName.set(k, []).get(k)!).push(id);
  }
  const synthetic = new Map<string, string>();
  const assumptions: string[] = [];
  // Buckets in normalised-name order; person ids are per-seed UUIDs and the
  // golden-pack test redacts UUIDs to FIRST-SEEN placeholders, so nothing here
  // may order on (or embed a fragment of) an id.
  for (const [norm, ids] of [...byName.entries()].sort(([a], [b]) => cmp(a, b))) {
    if (ids.length < 2) continue;
    for (const id of ids) synthetic.set(id, `name:${norm}`);
    // `personNameById` iterates in DB row order, so the bucket's id order is not
    // stable across reseeds. Display the lexicographically first RAW spelling —
    // a choice that depends only on the names, never on which row came back
    // first — so the assumption string is byte-identical on a reseed.
    const display = ids.map((id) => personNameById.get(id) ?? "").sort(cmp)[0]!;
    assumptions.push(
      `'${display}' matches ${ids.length} person records by name — ` +
        `treated as one player for scheduling only; no records were merged`,
    );
  }
  return { keyOf: (id) => synthetic.get(id) ?? id, assumptions };
}
