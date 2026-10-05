// The catalog templates the harness drives through their gallery cards
// (ruling 47; D11). Two API-only cells have an organiser path after all: a
// catalog template builds them (template-gallery.tsx's `template-card-<key>`),
// so the browser layer creates them through the card and never posts a stage
// body. Every fact about a template is read from the PRODUCT's catalog JSON
// (apps/web/src/server/templates/catalog/<key>.json) as text — never imported
// (boundary.test.ts) and never retyped here: its sport, variant, entrant kind,
// entrant count (D11's field size) and stages.
//
// What IS declared here is which API-only row each driven template builds
// (TEMPLATE_ROW). It is checked against the catalogue's own bodies on every
// read (templateRow): a template whose JSON stops building its row's stage
// kinds is refused by name, so a case never runs a different shape under the
// row's name.
//
// A LEAF beside api-only-ui.ts: lib/layers.ts (in run.ts's static closure)
// plans from it, so it must never reach lib/browser (boundary.test.ts).
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { API_ONLY_ROWS, stagesForRow, type ApiOnlyRowKey, type StagePostBody } from "./catalogue.ts";
import type { CaseSpec } from "./scenarios/types.ts";

/** server/templates/catalog/, resolved from this file — never the cwd. */
export const CATALOG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "apps/web/src/server/templates/catalog");

/** The product's own key shape (catalog keys: `box-league`, `t20-super8`, …).
 *  Anything else — a path, a space, a quote — is refused before a file is read. */
const KEY_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** One stage as the catalog spells it (server/templates/schema.ts TemplateStage, the fields read here). */
export interface TemplateStage {
  readonly kind: string;
  readonly i18nNameKey?: string;
  readonly groups?: number;
  readonly points?: unknown;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly progression?: unknown;
}

/** A template's one division, as the harness reads it. */
export interface TemplateField {
  readonly key: string;
  readonly version: number;
  readonly sport: string;
  readonly variant: string;
  readonly entrantKind: string;
  /** D11: the field a case on this template seeds. */
  readonly entrantCount: number;
  readonly stageKinds: readonly string[];
  readonly stages: readonly TemplateStage[];
}

export class UnknownTemplate extends Error {
  readonly key: string;
  constructor(key: string, why: string) {
    super(`templates: no catalog template '${key}' — ${why}`);
    this.name = "UnknownTemplate";
    this.key = key;
  }
}

/** A catalog file the harness cannot read as one division with a count and stages. */
export class TemplateShapeUnsupported extends Error {
  readonly key: string;
  constructor(key: string, why: string) {
    super(`templates: catalog template '${key}' is not a shape the harness drives — ${why}`);
    this.name = "TemplateShapeUnsupported";
    this.key = key;
  }
}

/** A driven template whose JSON no longer builds its row's stage kinds. */
export class TemplateDrifted extends Error {
  readonly key: string;
  readonly row: string;
  constructor(key: string, row: string, built: readonly string[], want: readonly string[]) {
    super(`templates: catalog template '${key}' builds ${built.join(" → ") || "no stage"}, not ${row}'s ${want.join(" → ")} — the case would run a different shape under ${row}'s name`);
    this.name = "TemplateDrifted";
    this.key = key;
    this.row = row;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export function templateField(key: string, dir: string = CATALOG_DIR): TemplateField {
  if (typeof key !== "string" || !KEY_SHAPE.test(key)) throw new UnknownTemplate(String(key), "not a catalog key (lowercase words joined by '-')");
  let text: string;
  try {
    text = readFileSync(join(dir, `${key}.json`), "utf8");
  } catch (e) {
    throw new UnknownTemplate(key, `${join(dir, `${key}.json`)} cannot be read (${e instanceof Error ? e.message.split("\n")[0] : String(e)})`);
  }
  const t: unknown = JSON.parse(text);
  if (!isRecord(t) || !Array.isArray(t.divisions)) throw new TemplateShapeUnsupported(key, "no divisions list");
  if (t.divisions.length !== 1) throw new TemplateShapeUnsupported(key, `${t.divisions.length} division(s); a case drives exactly one`);
  const d: unknown = t.divisions[0];
  if (!isRecord(d)) throw new TemplateShapeUnsupported(key, "its division is not an object");
  const { sportKey, variantKey, entrantKind, entrantCount, stages } = d;
  if (typeof sportKey !== "string" || typeof variantKey !== "string" || typeof entrantKind !== "string") throw new TemplateShapeUnsupported(key, "sportKey, variantKey and entrantKind must be text");
  if (typeof entrantCount !== "number" || !Number.isInteger(entrantCount) || entrantCount < 2) throw new TemplateShapeUnsupported(key, `entrantCount ${JSON.stringify(entrantCount)} is not a whole field of at least 2`);
  if (!Array.isArray(stages) || stages.length === 0 || !stages.every((s) => isRecord(s) && typeof s.kind === "string")) throw new TemplateShapeUnsupported(key, "no stage list of kinds");
  const read = stages as TemplateStage[];
  return Object.freeze({
    key, version: typeof t.version === "number" ? t.version : 0, sport: sportKey, variant: variantKey, entrantKind, entrantCount,
    stageKinds: Object.freeze(read.map((s) => s.kind)), stages: Object.freeze(read),
  });
}

/** The API-only row each driven template builds (the two template-only cells,
 *  ruling 47). The cell's sport is the template's own (templateField). */
export const TEMPLATE_ROW: Readonly<Record<string, ApiOnlyRowKey>> = Object.freeze({ "box-league": "group_only", "t20-super8": "group_group_ko" });

/** The row `key` builds, checked against the catalogue's bodies for that row. */
export function templateRow(key: string, dir: string = CATALOG_DIR): ApiOnlyRowKey {
  if (!Object.prototype.hasOwnProperty.call(TEMPLATE_ROW, key)) throw new UnknownTemplate(key, `the harness drives only ${Object.keys(TEMPLATE_ROW).join(", ")} (TEMPLATE_ROW)`);
  const row = TEMPLATE_ROW[key];
  const built = templateField(key, dir).stageKinds;
  const want = stagesForRow(row).map((b) => b.kind);
  if (JSON.stringify(built) !== JSON.stringify(want)) throw new TemplateDrifted(key, row, built, want);
  return row;
}

/** The template that builds `row` on `sport`, or null: no catalog card reaches the cell. */
export function templateFor(row: string, sport: string): string | null {
  if (!(API_ONLY_ROWS as readonly string[]).includes(row)) return null;
  for (const key of Object.keys(TEMPLATE_ROW)) {
    if (TEMPLATE_ROW[key] === row && templateField(key).sport === sport) return key;
  }
  return null;
}

/** `spec` re-planned onto catalog template `key` (D11): the case drives through the template's card, so its variant
 *  (and the id that names it) is the template's own, never the builder default's, and `template` is set. Every other
 *  field is the spec's. The one builder the grid's L1 cells (layers.ts planL1Grid) and a plain browser plan share. */
export function onTemplate(spec: Omit<CaseSpec, "variant" | "caseId">, key: string): CaseSpec {
  const { variant } = templateField(key);
  return { ...spec, caseId: `${spec.row}|${spec.sport}|${variant}|${spec.scenario}`, variant, template: key };
}

/** W1d item 20: a plain browser plan's spec on a cell a catalog template reaches drives through that template's
 *  card, as the grid's L1 case does; before this it threw DriverMisuse naming the template, on every script of the
 *  cell. Any other spec comes back as the SAME object. Left alone, by name: a spec already on a template, and a
 *  variant case's (it carries `overrides`: the card sets no rule, and a cricket `test` case is not the t20 card). */
export function routeViaTemplate(spec: CaseSpec): CaseSpec {
  if (spec.template !== undefined || spec.overrides !== undefined) return spec;
  const key = templateFor(spec.row, spec.sport);
  return key === null ? spec : onTemplate(spec, key);
}

/** The stage rows the product inserts for `key` (usecases/templates.ts
 *  createFromTemplate, text-pinned by templates.test.ts): seq si + 1, the
 *  kind, effectiveStageConfig's config — `groups` sugar first (a group's
 *  pools.count), then `points`, then `config` spread last — and the
 *  progression verbatim, or null. What a template case "posted", so
 *  life-built-as-posted judges the build against the catalog (D11). */
export function templateBodies(key: string, dir: string = CATALOG_DIR): StagePostBody[] {
  return templateField(key, dir).stages.map((s, i) => {
    const config: Record<string, unknown> = {};
    if (s.kind === "group" && s.groups !== undefined) config.pools = { count: s.groups };
    if (s.points !== undefined) config.points = s.points;
    Object.assign(config, s.config ?? {});
    return { seq: i + 1, kind: s.kind, name: s.i18nNameKey ?? s.kind, config, progression: (s.progression ?? null) as StagePostBody["progression"] };
  });
}
