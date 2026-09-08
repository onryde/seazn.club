// The visual gate's manifest: what to photograph, at what size, and what to
// hold each picture to. Deny by default — an unknown check, an unknown seed
// kind, a dangling reference or a duplicate id is refused at parse time, with
// the offending name, so a later wave's appended row cannot silently no-op.
//
// Pure on purpose: no `@playwright/test`, no DOM. `visual-manifest.test.ts`
// imports it as a plain unit, and the cross-row comparisons below
// (`differingPairViolations`, `controlSetViolations`) live here rather than in
// the spec so they have permanent unit killers instead of a probe that gets
// reverted (fix round 1, Important 7/8).
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

/** What `controlSet` returns when its root is not in the DOM. Declared here so
 *  `controlSetViolations` can recognise it without importing `asserts.ts`
 *  (which would pull in `@playwright/test`), and so exactly one file decides
 *  the wording. A pair of rows BOTH in this state used to compare equal and
 *  pass `controlSetEqual` vacuously (fix round 1, Important 8). */
export const notInDomSentinel = (selector: string) => `<${selector} not in DOM>`;
const NOT_IN_DOM = /^<.+ not in DOM>$/;

/** A box a check EXCUSED, named by a STABLE identity — tag plus `data-testid`,
 *  never a pixel size, so the declared list in the manifest does not churn
 *  when content changes width.
 *
 *  STRICT: a typo'd `exempt.bleed` would otherwise be stripped by zod and the
 *  real `bleeds` would silently fall back to `[]` — which reads as "this row
 *  excuses nothing" while the row's actual exemption goes unasserted. Same
 *  class as the exemptions themselves, one level up (fix round 2). */
const ExemptShape = z.strictObject({
  /** `no-clip`: `overflow-x: visible` boxes whose overhang is accounted for
   *  by a reachable rail inside them. */
  bleeds: z.array(z.string()).default([]),
  /** `hit-targets`: WCAG 2.5.8 "Inline" — a link in running text. */
  inline: z.array(z.string()).default([]),
  /** `hit-targets`: a control off-viewport but reachable (a rail, or below
   *  the fold on a scrollable page). */
  offscreen: z.array(z.string()).default([]),
});

/** The exemption kinds, DERIVED from the schema rather than retyped in the
 *  spec: a fourth kind added above must be held to a declared list too, and a
 *  hardcoded tuple in `capture.spec.ts` would have let it land in report.json
 *  asserted against nothing. */
export const EXEMPT_KINDS = Object.keys(ExemptShape.shape) as readonly (keyof z.infer<
  typeof ExemptShape
>)[];

const ExemptSchema = ExemptShape.default({ bleeds: [], inline: [], offscreen: [] });

/** The checks a row may record as a KNOWN DEFECT. Deliberately NOT all of
 *  `VISUAL_CHECKS`: a check qualifies only when the harness can run it in a
 *  NON-ASSERTING mode and read its offenders back, which today is
 *  `rails-a11y` alone (`expectRailsA11y(page, label, { assert: false })`).
 *  Every other check throws on its first offender and has nothing to hand
 *  back, so the harness cannot verify the recorded defect is still there.
 *
 *  Accepting all five while honouring one is what this list exists to stop:
 *  a `knownDefects` entry for `no-clip` then failed UNCONDITIONALLY with
 *  "the check now finds nothing — the page was FIXED", which is false, and a
 *  later wave appending a manifest row (exactly what this harness promises it
 *  can do without touching harness code) would have been sent to debug a page
 *  that was never fixed (fix round 2, Important). Adding a kind here means
 *  giving that check a non-asserting mode AND wiring it into
 *  `capture.spec.ts`'s offender map, which throws if a listed check has no
 *  entry. */
export const KNOWN_DEFECT_CHECKS = ["rails-a11y"] as const;
export type KnownDefectCheck = (typeof KNOWN_DEFECT_CHECKS)[number];

/** A check this row deliberately does NOT assert because the page has a
 *  recorded defect owed to another wave. The harness still RUNS the check and
 *  compares its offenders against the ones declared here, so the row reds
 *  both when the defect disappears AND when a different one joins it. */
const KnownDefectSchema = z.strictObject({
  check: z.enum(KNOWN_DEFECT_CHECKS, {
    error: (issue) =>
      `${JSON.stringify(issue.input)} cannot be recorded in knownDefects — only ${KNOWN_DEFECT_CHECKS.join(", ")} can be re-run without asserting, so the harness cannot verify any other check's defect is still there. Give the check a non-asserting mode and add it to KNOWN_DEFECT_CHECKS first.`,
  }),
  /** The offender IDENTITIES (tag + `data-testid`) the check is expected to
   *  still report. Compared as a SET, like `exempt` — non-empty alone would
   *  let a SECOND defect on the same page hide behind the recorded one. */
  offenders: z.array(z.string()).min(1),
  /** Long enough to name the file and the owed fix, not just "broken". */
  reason: z.string().min(40),
});

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
  backdrop: z
    .enum(["light", "dark"], {
      error: (issue) => `unknown backdrop ${JSON.stringify(issue.input)} — expected light or dark`,
    })
    .nullable()
    .default(null),
  /** CSS selector the page must render before the shot — the state proven.
   *  Must be something ONLY the intended page renders: `main h1` also matches
   *  the branded 404 (`shared/[orgSlug]/not-found.tsx` renders an `<h1>`
   *  inside the layout's `<main>`), on which every check passes and both
   *  cross-row comparisons still hold (fix round 1, Important 1). */
  awaitSelector: z.string().min(1),
  /** Signed in as the shared Pro org (AUTH_STATE) or anonymous. */
  auth: z.boolean().default(false),
  /** Root for `controlSet`; required for a row named in `controlSetEqual`. */
  controlRoot: z.string().min(1).nullable().default(null),
  checks: z
    .array(
      z.enum(VISUAL_CHECKS, {
        error: (issue) =>
          `unknown check ${JSON.stringify(issue.input)} — expected one of ${VISUAL_CHECKS.join(", ")}`,
      }),
    )
    .default([]),
  exempt: ExemptSchema,
  knownDefects: z.array(KnownDefectSchema).default([]),
});

const GroupSchema = z.object({
  id: z.string().min(1),
  seed: z.enum(SEED_KINDS, {
    error: (issue) =>
      `unknown seed kind ${JSON.stringify(issue.input)} — expected one of ${SEED_KINDS.join(", ")}`,
  }),
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
      for (const d of r.knownDefects) {
        if (r.checks.includes(d.check)) {
          throw new Error(
            `${g.id}/${r.id}: ${d.check} is listed in BOTH checks and knownDefects — a row either asserts a check or records why it cannot`,
          );
        }
      }
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

/** Every `mustDiffer` pair whose two pictures are NOT different, named. Pure
 *  so it has a unit killer: the spec used to compare hashes inline, and the
 *  only way to prove that loop fired was a duplicate-row probe that then had
 *  to be reverted (fix round 1, Important 7). A missing hash counts as a
 *  violation — a pair the harness never photographed is not a pair it proved. */
export function differingPairViolations(
  pairs: readonly (readonly [string, string])[],
  hashById: Readonly<Record<string, string | undefined>>,
): string[] {
  const out: string[] = [];
  for (const [a, b] of pairs) {
    const ha = hashById[a];
    const hb = hashById[b];
    if (ha === undefined || hb === undefined) {
      out.push(`${a}/${b}: no picture for ${ha === undefined ? a : b}`);
    } else if (ha === hb) {
      out.push(`${a} and ${b} are pixel-identical (${ha.slice(0, 12)}) — nothing opened, or the size never applied`);
    }
  }
  return out;
}

/** Every `controlSetEqual` pair that does not hold, named — INCLUDING the two
 *  ways the comparison used to pass on nothing: a root that was not in the DOM
 *  (both sides carry the sentinel and compare equal) and a root that matched no
 *  control at all (both sides empty). Pure, so both vacuous modes have unit
 *  killers rather than depending on `no-clip` happening to run first. */
export function controlSetViolations(
  pairs: readonly (readonly [string, string])[],
  controlsById: Readonly<Record<string, readonly string[] | null | undefined>>,
): string[] {
  const out: string[] = [];
  for (const [a, b] of pairs) {
    for (const id of [a, b]) {
      const list = controlsById[id];
      if (list === undefined || list === null) {
        out.push(`${id}: no control set was captured (the row has no controlRoot?)`);
      } else if (list.length === 0) {
        out.push(`${id}: its controlRoot matched NO controls — an empty set compares equal to anything`);
      } else if (list.some((c) => NOT_IN_DOM.test(c))) {
        out.push(`${id}: its controlRoot was not in the DOM (${list.join(", ")})`);
      }
    }
    const ca = controlsById[a];
    const cb = controlsById[b];
    if (ca && cb && JSON.stringify(ca) !== JSON.stringify(cb)) {
      out.push(
        `${a} vs ${b}: control SET differs (membership, order or repeats)\n  ${a}: ${ca.join(" | ")}\n  ${b}: ${cb.join(" | ")}`,
      );
    }
  }
  return out;
}
