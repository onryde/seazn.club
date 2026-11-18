// Template resolution (W5 X-BD-3, NEW-W1d-5): a template that names no sport of its own ("any") is resolved against the
// organiser's choice — sport, variant, entrant kind, field size — into an ordinary template before it is instantiated, and
// a stage whose pool count follows the field (`poolSize`) gets its `groups` from the chosen size.
//
// PURE and client-safe: the schema import is type-only (erased), so the detail sheet (a client island) and
// `createFromTemplate` (server) run this one function and what the sheet describes for a count is what the create builds.
// A template that needs no resolution comes back as the very same object, so every create that predates W5 is unchanged.
import type { CompetitionTemplate, TemplateDivision, TemplateStage } from "./schema";

/** The choice the organiser makes for an any-sport template. Every field is optional on the wire; which are required is
 *  decided here, per division. */
export interface TemplateChoice {
  sportKey?: string;
  variantKey?: string;
  entrantKind?: "team" | "pair" | "individual";
  entrantCount?: number;
}

/** The codes a choice can be refused with (400; the usecase maps them onto its HttpError). */
export type ResolveCode = "TEMPLATE_CHOICE_REQUIRED" | "TEMPLATE_CHOICE_NOT_OFFERED" | "TEMPLATE_COUNT_NOT_OFFERED";

export type Resolved =
  | { ok: true; template: CompetitionTemplate }
  | { ok: false; code: ResolveCode; message: string };

const ANY = "any";

/** A division whose sport, variant and kind the organiser chooses (the schema makes the three move together). */
export function isAnyDivision(d: Pick<TemplateDivision, "sportKey">): boolean {
  return d.sportKey === ANY;
}

const needsResolving = (d: TemplateDivision): boolean => isAnyDivision(d) || d.stages.some((s) => s.poolSize !== undefined);

/** `poolSize` -> `groups` for `count` entrants. The schema guarantees every offered count divides; a count that does not is
 *  a refusal upstream, never a rounded pool count here. */
function withGroups(stages: TemplateStage[], count: number): TemplateStage[] {
  return stages.map((s) => {
    if (s.poolSize === undefined) return s;
    const { poolSize, ...rest } = s;
    return { ...rest, groups: count / poolSize };
  });
}

export function resolveTemplate(template: CompetitionTemplate, choice?: TemplateChoice): Resolved {
  const given = choice ?? {};
  const identity = { sportKey: given.sportKey, variantKey: given.variantKey, entrantKind: given.entrantKind };
  let identityUsed = false;
  let countUsed = false;
  let changed = false;
  const divisions: TemplateDivision[] = [];
  for (const d of template.divisions) {
    let next = d;
    const any = isAnyDivision(d);
    if (any) {
      const missing = Object.entries(identity).filter(([, v]) => v === undefined).map(([k]) => k);
      if (missing.length > 0) {
        return { ok: false, code: "TEMPLATE_CHOICE_REQUIRED", message: `template '${template.key}' needs ${missing.join(", ")} (it names no sport of its own)` };
      }
      identityUsed = true;
    }
    if (given.entrantCount !== undefined && d.entrantCountOptions !== undefined) {
      if (!d.entrantCountOptions.includes(given.entrantCount)) {
        return { ok: false, code: "TEMPLATE_COUNT_NOT_OFFERED", message: `template '${template.key}' offers ${d.entrantCountOptions.join(", ")} entrants, not ${given.entrantCount}` };
      }
      countUsed = true;
    }
    if (any || (given.entrantCount !== undefined && d.entrantCountOptions !== undefined) || needsResolving(d)) {
      const count = d.entrantCountOptions !== undefined && given.entrantCount !== undefined ? given.entrantCount : d.entrantCount;
      next = { ...d, entrantCount: count, stages: withGroups(d.stages, count) };
      if (any) {
        // The builder narrows a division to the kind it showed (C9 Q3, n3): the template does the same.
        const kind = identity.entrantKind!;
        next = {
          ...next,
          sportKey: identity.sportKey!,
          variantKey: identity.variantKey!,
          entrantKind: kind,
          cfgOverrides: { entrants: { kinds: [kind], defaultKind: kind } },
        };
      }
      changed = true;
    }
    divisions.push(next);
  }
  const named = Object.entries(identity).filter(([, v]) => v !== undefined).map(([k]) => k);
  if (named.length > 0 && !identityUsed) {
    return { ok: false, code: "TEMPLATE_CHOICE_NOT_OFFERED", message: `template '${template.key}' has its own sport, variant and entrant kind: ${named.join(", ")} cannot be chosen` };
  }
  if (given.entrantCount !== undefined && !countUsed) {
    return { ok: false, code: "TEMPLATE_CHOICE_NOT_OFFERED", message: `template '${template.key}' offers one field size: entrantCount cannot be chosen` };
  }
  return { ok: true, template: changed ? { ...template, divisions } : template };
}

/** What one stage is, for the sheet: `pools` pools of `perPool`, or a knockout of `entrants`. A field the declaration does
 *  not give by plain arithmetic is left out, never guessed (euro24's R16 takes 12 qualifiers and 4 best thirds: a bracket
 *  of 16, not "pools of"). */
export interface StageShape {
  pools?: number;
  perPool?: number;
  entrants?: number;
}

export function stageShapes(division: TemplateDivision): StageShape[] {
  const count = division.entrantCount;
  const shapes: StageShape[] = [];
  division.stages.forEach((st, i) => {
    if (st.kind === "knockout") {
      shapes.push(st.size !== undefined ? { entrants: st.size } : {});
      return;
    }
    if (st.kind !== "group") {
      shapes.push({});
      return;
    }
    const pools = st.groups ?? (st.poolSize !== undefined && count % st.poolSize === 0 ? count / st.poolSize : undefined);
    if (pools === undefined) {
      shapes.push({});
      return;
    }
    // Who is in this stage: the field itself for a first stage; else what the previous stage's pools send on, when every
    // take is "top N per group" (the only take a pool count can multiply).
    let field: number | undefined;
    const sources = st.progression?.sources;
    if (sources === undefined) {
      field = count;
    } else {
      const prev = shapes[i - 1];
      const takes = sources.flatMap((s) => s.take);
      if (prev?.pools !== undefined && takes.length > 0 && takes.every((t) => t.kind === "topNPerGroup")) {
        field = prev.pools * takes.reduce((sum, t) => sum + (t.kind === "topNPerGroup" ? t.n : 0), 0);
      }
    }
    shapes.push(field !== undefined && field % pools === 0 ? { pools, perPool: field / pools } : { pools });
  });
  return shapes;
}
