// B06a Task 5 — the provenance number the spec asks every suite to publish.
//
// `report.ts` has declared `provenancePct` since B01 and nothing wrote it, so
// every bench report so far carried it as `undefined`. The number is the
// honesty clause of design §4 made visible: a stream whose per-event sequence
// was never publicly archived is RECONSTRUCTED (a legal sequence folding to the
// exact real score), and a report that cannot say what fraction of its data was
// reconstructed cannot support the claim the bench exists to make. Suite 10
// (carrom) is the deliberate thin-data case and is where this matters most.
import type { Pack } from "./pack-schema.ts";

export interface ProvenanceBreakdown {
  /** Always the stream count — never just the buckets below, so a provenance
   *  value added to PackSchema later shows up as a gap rather than as a
   *  silently smaller denominator that flatters the percentage. */
  readonly total: number;
  readonly real: number;
  readonly reconstructed: number;
  readonly synthetic: number;
  /** Percentage of streams flagged `real`, to one decimal. 0 when there are no
   *  streams at all — never NaN, which a report renderer would print. */
  readonly realPct: number;
}

export function computeProvenance(pack: Pick<Pack, "streams">): ProvenanceBreakdown {
  let real = 0;
  let reconstructed = 0;
  let synthetic = 0;
  for (const stream of pack.streams) {
    if (stream.provenance === "real") real += 1;
    else if (stream.provenance === "reconstructed") reconstructed += 1;
    else if (stream.provenance === "synthetic") synthetic += 1;
  }
  const total = pack.streams.length;
  return {
    total,
    real,
    reconstructed,
    synthetic,
    realPct: total === 0 ? 0 : Math.round((real / total) * 1000) / 10,
  };
}

/** The one-line form the report renders, e.g.
 *  `75% real (6/8 streams; 2 reconstructed)`. */
export function renderProvenance(p: ProvenanceBreakdown): string {
  if (p.total === 0) return "no streams";
  const parts = [`${p.realPct}% real (${p.real}/${p.total} streams`];
  const extras: string[] = [];
  if (p.reconstructed > 0) extras.push(`${p.reconstructed} reconstructed`);
  if (p.synthetic > 0) extras.push(`${p.synthetic} synthetic`);
  const unclassified = p.total - p.real - p.reconstructed - p.synthetic;
  if (unclassified > 0) extras.push(`${unclassified} unclassified`);
  return `${parts.join("")}${extras.length > 0 ? `; ${extras.join(", ")}` : ""})`;
}
