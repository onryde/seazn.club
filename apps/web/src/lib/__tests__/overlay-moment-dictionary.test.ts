// Every word the moment slab can put on air exists in all four locales —
// and the LISTS ARE DERIVED FROM THE ENGINE (stream overlay W2 Task 5).
//
// Derived, not typed, because the failure this guards against is not "somebody
// forgot a translation". It is "the engine grew an eleventh mode of dismissal /
// a fourth card colour / a federation added a suspension class, and it shipped
// as an English word on a French broadcast". A list typed into this file would
// go stale in exactly the moment it needed to speak up.
import { describe, expect, it } from "vitest";
import { CricketWicket } from "@seazn/engine/sports/cricket";
import { builtinModules } from "@seazn/engine/sports";
import { SIM_CONFIGS } from "@seazn/engine/testkit";
import { MOMENT_KEYS } from "../overlay-moments";
import { DISCIPLINE_LABEL_KEYS } from "../public-site";
import en from "@/dictionaries/en/public.json";
import es from "@/dictionaries/es/public.json";
import fr from "@/dictionaries/fr/public.json";
import nl from "@/dictionaries/nl/public.json";

const LOCALES: Record<string, Record<string, string>> = {
  en: en as Record<string, string>,
  es: es as Record<string, string>,
  fr: fr as Record<string, string>,
  nl: nl as Record<string, string>,
};

const moduleFor = (key: string) => {
  const m = builtinModules.find((mod) => mod.key === key);
  if (!m) throw new Error(`no builtin module for "${key}"`);
  return m;
};

/**
 * The members of a zod enum, whatever shape this zod version exposes them in.
 *
 * `.options` is an ARRAY in some versions and the `.enum` record is the reliable
 * one in others; read defensively and THROW if neither yields members, because
 * an empty list here would turn every sweep below into a vacuous pass — which
 * is precisely the failure this file exists to prevent.
 */
function enumMembers(schema: unknown, what: string): readonly string[] {
  const node = schema as { options?: unknown; enum?: unknown };
  const fromOptions = Array.isArray(node.options) ? node.options : [];
  const fromEnum =
    typeof node.enum === "object" && node.enum !== null ? Object.values(node.enum) : [];
  const members = [...fromOptions, ...fromEnum].filter((v): v is string => typeof v === "string");
  const unique = [...new Set(members)];
  if (unique.length === 0) throw new Error(`${what}: no enum members read — re-pin the schema shape`);
  return unique;
}

/** Every `CricketWicket.kind` the engine declares. */
const WICKET_KINDS = enumMembers(CricketWicket.shape.kind, "CricketWicket.kind");

/** Every `FootballCard.color`, read off the module's OWN declared schema rather
 *  than an export — `football/index.ts` does not export `CardColor`. */
const CARD_COLOURS = enumMembers(
  (moduleFor("football").eventSchemas?.["football.card"] as { shape?: Record<string, unknown> })
    ?.shape?.color,
  "FootballCard.color",
);

/** Every suspension class the two period sports DECLARE, from their own parsed
 *  configs — so a federation sheet adding one reds here. */
const SUSPENSION_CLASSES: readonly string[] = [
  ...new Set(
    ["hockey", "icehockey"].flatMap((key) => {
      const mod = moduleFor(key);
      const cfg = mod.configSchema.parse(SIM_CONFIGS[key] ?? {}) as {
        suspensions?: { classes?: Record<string, unknown> };
      };
      return Object.keys(cfg.suspensions?.classes ?? {});
    }),
  ),
];

/** The keys the slab reaches for that are NOT in `MOMENT_KEYS`: the ice-hockey
 *  penalty line goes through W1's `disciplineLabel`, deliberately reusing the
 *  chip's own words rather than minting a second set. */
const BORROWED_KEYS: readonly string[] = [
  ...SUSPENSION_CLASSES.map((cls) => DISCIPLINE_LABEL_KEYS[cls]).filter(
    (key): key is string => key !== undefined,
  ),
  "overlay.cricket.strikerMark",
  "overlay.cricket.thisOver",
];

describe("the engine's enums and the slab's key table agree", () => {
  it("every wicket kind the engine declares has a moment key", () => {
    expect(WICKET_KINDS.length, "no kinds read — the probe is vacuous").toBeGreaterThan(5);
    for (const kind of WICKET_KINDS) {
      expect(MOMENT_KEYS, `no key for wicket kind "${kind}"`).toContain(
        `overlay.moment.wicket.${kind}`,
      );
    }
  });

  it("every football card colour the engine declares has a moment key", () => {
    // camelCase on the key, snake_case in the engine: `second_yellow` →
    // `overlay.moment.card.secondYellow`, matching this repo's own dictionary
    // convention (`overlay.card.benchMinor`).
    const camel = (s: string) => s.replace(/_(.)/g, (_, c: string) => c.toUpperCase());
    expect(CARD_COLOURS.length).toBeGreaterThan(2);
    for (const colour of CARD_COLOURS) {
      expect(MOMENT_KEYS, `no key for card colour "${colour}"`).toContain(
        `overlay.moment.card.${camel(colour)}`,
      );
    }
  });

  it("every declared suspension class has a LABEL key — through W1's table, not a second one", () => {
    expect(SUSPENSION_CLASSES.length).toBeGreaterThan(5);
    for (const cls of SUSPENSION_CLASSES) {
      expect(DISCIPLINE_LABEL_KEYS, `no label key for suspension class "${cls}"`).toHaveProperty(
        cls,
      );
    }
  });
});

describe("all four locales carry every key the slab can emit", () => {
  const REQUIRED = [...new Set([...MOMENT_KEYS, ...BORROWED_KEYS])];

  it("the required set is not empty — a vacuous sweep would pass silently", () => {
    expect(REQUIRED.length).toBeGreaterThan(25);
  });

  for (const [locale, dict] of Object.entries(LOCALES)) {
    it(`${locale}`, () => {
      const missing = REQUIRED.filter((key) => dict[key] === undefined);
      expect(missing, `${locale} is missing: ${missing.join(", ")}`).toEqual([]);
    });
  }

  it("placeholders match across locales — a dropped {n} renders the literal brace on air", () => {
    const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of REQUIRED) {
      const expected = placeholders(LOCALES.en![key] ?? "");
      for (const [locale, dict] of Object.entries(LOCALES)) {
        expect(placeholders(dict[key] ?? ""), `${locale} "${key}"`).toEqual(expected);
      }
    }
  });
});
