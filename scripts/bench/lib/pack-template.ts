// packToTemplateSkeleton — the strip function that turns a Pack into a
// format-template-shaped skeleton, and the evidence for design note D1
// ("pack schema ⊃ template schema").
//
// It lives BESIDE pack-schema.ts rather than inside it on purpose:
// `PackSchema` is the frozen public contract (it freezes at the end of B06),
// and a derived convenience helper that will keep moving does not belong in
// the same file as a thing that must stop moving.
//
// -------------------------------------------------------------------------
// Why this file does not import the product schema, in any form
// -------------------------------------------------------------------------
// `apps/web/src/server/templates/schema.ts` is `server-only` and it
// VALUE-imports api-v1/schemas.ts, which reaches `@grpc/grpc-js`; and
// tsconfig.scripts.json cannot resolve apps/web's `@/` path aliases, so even
// a `import type` would fail typecheck. The subset relation is therefore
// proven by reading that file as TEXT at test time and extracting its
// declared key list — see pack-schema.test.ts, where the extraction throws
// rather than returning an empty list, because an extraction that silently
// matches nothing passes vacuously.
//
// -------------------------------------------------------------------------
// Where the superset relation is real, and the one place it is NOT
// -------------------------------------------------------------------------
// Every KEY a `CompetitionTemplate` / `TemplateDivision` declares is produced
// here. The VALUES are not always carryable, and exactly one field is a
// genuine translation rather than a projection:
//
//   • i18n keys. A template carries dictionary KEYS and never literal English
//     (templates/schema.ts's own `TemplateI18n` comment, ruling 4). A pack
//     carries the real tournament's real name — "UEFA Euro 2024" — because
//     that is the historical fact it exists to record. So the skeleton MINTS
//     key-shaped strings from the pack's own refs. A real catalog entry needs
//     real dictionary entries in all four locales; that is a curation step,
//     outside the bench. This is the one place "pack ⊃ template" holds at the
//     key level but not the value level, and it is deliberate.
//
//   • `entrantKind` / `entrantCount` are DERIVED from the pack's entrant
//     list, never stored on the division. The template schema documents both
//     as display-only guidance that is "never written to any row"
//     (templates/schema.ts, TemplateDivision) — `CreateDivision` carries no
//     `entrantKind` field at all, and entrant kind is chosen per entrant. A
//     pack that stored them would be storing a second copy of a fact its own
//     `entrants[]` already holds, free to drift from it; deriving cannot. The
//     skeleton still EMITS them, because the template schema requires them.
//
//   • `version` is emitted as 1, not carried from `schemaVersion`. Catalog
//     version means "bumps on ANY content change" (templates/schema.ts) —
//     a curation act on a catalog entry, a different fact from which revision
//     of the PACK contract this file was authored against.
import {
  entrantsOfDivision,
  type Pack,
  type PackDivision,
  type PackEntrantKind,
  type PackJsonValue,
} from "./pack-schema.ts";

export interface TemplateStageSkeleton {
  i18nNameKey: string;
  kind: PackDivision["stages"][number]["kind"];
  config: Record<string, PackJsonValue>;
  progression?: Record<string, PackJsonValue>;
}

export interface TemplateDivisionSkeleton {
  i18nNameKey: string;
  sportKey: string;
  variantKey: string;
  cfgOverrides: Record<string, PackJsonValue>;
  tiebreakers: string[];
  entrantKind: PackEntrantKind;
  entrantCount: number;
  stages: TemplateStageSkeleton[];
}

export interface TemplateSkeleton {
  key: string;
  version: number;
  i18n: { nameKey: string; descriptionKey: string };
  divisions: TemplateDivisionSkeleton[];
}

/** Minted, not carried — see the header note on i18n keys. */
function i18nBase(pack: Pack): string {
  return `bench.pack.${pack.suite}`;
}

export function packToTemplateSkeleton(pack: Pack): TemplateSkeleton {
  const base = i18nBase(pack);
  return {
    key: pack.suite,
    version: 1,
    i18n: { nameKey: `${base}.name`, descriptionKey: `${base}.description` },
    divisions: pack.divisions.map((division) => {
      const entrants = entrantsOfDivision(pack.entrants, division.ref);
      // `checkEntrantDivisions` in pack-schema.ts guarantees at least two, so
      // this index is total for any value that parsed. The fallback exists
      // only so a hand-built object that skipped the parse degrades to a
      // visible default rather than a crash.
      const entrantKind: PackEntrantKind = entrants[0]?.kind ?? "individual";
      return {
        i18nNameKey: `${base}.division.${division.ref}.name`,
        sportKey: division.sportKey,
        variantKey: division.variantKey,
        cfgOverrides: division.cfgOverrides,
        tiebreakers: division.tiebreakers ?? [],
        entrantKind,
        entrantCount: entrants.length,
        stages: division.stages.map((stage) => ({
          i18nNameKey: `${base}.division.${division.ref}.stage.${stage.ref}.name`,
          kind: stage.kind,
          config: stage.config,
          ...(stage.progression === undefined ? {} : { progression: stage.progression }),
        })),
      };
    }),
  };
}
