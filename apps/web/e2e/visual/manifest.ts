// The visual gate's manifest: what to photograph, at what size, and what to
// hold each picture to. Deny by default — an unknown check, an unknown seed
// kind, a dangling reference or a duplicate id is refused at parse time, with
// the offending name, so a later wave's appended row cannot silently no-op.
import { z } from "zod";

/** Seed kinds and the placeholders each provides — declared HERE (a pure
 *  module) so the manifest unit test needs nothing from `helpers.ts`;
 *  `seeds.ts` imports these and supplies the recipes. A later wave adds its
 *  kind to BOTH tables in this file and its recipe in `seeds.ts`. */
export const SEED_KINDS = ["none", "public-fixture"] as const;
export type SeedKind = (typeof SEED_KINDS)[number];
export const SEED_PARAMS: Record<SeedKind, readonly string[]> = {
  none: [],
  "public-fixture": ["orgSlug", "compSlug", "divSlug", "divisionId", "fixtureId"],
};

export const VISUAL_CHECKS = [
  "no-horizontal-scroll",
  "no-clip",
  "hit-targets",
  "truncate-chain",
  "rails-a11y",
] as const;
export type VisualCheck = (typeof VISUAL_CHECKS)[number];

const RowSchema = z.object({
  id: z.string().min(1),
  /** A path with `{placeholders}` the group's seed provides. */
  route: z.string().startsWith("/"),
  /** The WINDOW size at 100 %. The harness divides by `zoom` for the CSS viewport. */
  viewport: z.object({
    width: z.number().int().min(320).max(1920),
    height: z.number().int().min(480).max(1080),
  }),
  /** 1 = 100 %. 1.25 = the browser's 125 % (CSS viewport ÷ 1.25, DPR × 1.25). */
  zoom: z.number().min(0.5).max(2).default(1),
  backdrop: z.enum(["light", "dark"]).nullable().default(null),
  /** CSS selector the page must render before the shot — the state proven. */
  awaitSelector: z.string().min(1),
  /** Signed in as the shared Pro org (AUTH_STATE) or anonymous. */
  auth: z.boolean().default(false),
  /** Root for `controlSet`; required for a row named in `controlSetEqual`. */
  controlRoot: z.string().min(1).nullable().default(null),
  checks: z.array(z.enum(VISUAL_CHECKS)).default([]),
});

const GroupSchema = z.object({
  id: z.string().min(1),
  seed: z.enum(SEED_KINDS),
  rows: z.array(RowSchema).min(1),
  /** Pairs of row ids whose PNG hashes must differ (recurring class 10). */
  mustDiffer: z.array(z.tuple([z.string(), z.string()])).default([]),
  /** Pairs of row ids whose visible control SET must be identical
   *  (membership, order, repeats — never box size). */
  controlSetEqual: z.array(z.tuple([z.string(), z.string()])).default([]),
});

const ManifestSchema = z.object({
  version: z.literal(1),
  groups: z
    .array(GroupSchema)
    .min(1, "manifest has no groups — an empty manifest photographs nothing"),
});

export type VisualRow = z.infer<typeof RowSchema>;
export type VisualGroup = z.infer<typeof GroupSchema>;
export type VisualManifest = z.infer<typeof ManifestSchema>;

export function parseManifest(json: unknown): VisualManifest {
  const m = ManifestSchema.parse(json);
  const seenGroup = new Set<string>();
  for (const g of m.groups) {
    if (seenGroup.has(g.id)) throw new Error(`duplicate group id ${g.id}`);
    seenGroup.add(g.id);
    const ids = new Set<string>();
    for (const r of g.rows) {
      if (ids.has(r.id)) throw new Error(`duplicate row id ${g.id}/${r.id}`);
      ids.add(r.id);
    }
    for (const [a, b] of [...g.mustDiffer, ...g.controlSetEqual]) {
      for (const id of [a, b]) if (!ids.has(id)) throw new Error(`${g.id}: reference to unknown row ${id}`);
      if (a === b) throw new Error(`${g.id}: a row cannot be compared with itself (${a})`);
    }
    for (const [a, b] of g.controlSetEqual) {
      for (const id of [a, b]) {
        if (g.rows.find((r) => r.id === id)!.controlRoot === null) {
          throw new Error(`${g.id}/${id}: named in controlSetEqual but has no controlRoot`);
        }
      }
    }
  }
  return m;
}

/** `/shared/{orgSlug}/…` → the seed's values. A placeholder the seed did not
 *  provide throws with its name; the harness must never fetch a literal
 *  `{fixtureId}` and photograph a 404 as if it were the page. */
export function resolveRoute(template: string, params: Record<string, string>): string {
  const out = template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key: string) => {
    const v = params[key];
    if (v === undefined) throw new Error(`route ${template}: unresolved placeholder {${key}}`);
    return encodeURIComponent(v);
  });
  return out;
}
