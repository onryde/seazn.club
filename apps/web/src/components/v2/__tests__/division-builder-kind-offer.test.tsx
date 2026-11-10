// C9 review 2, N1, with the owner's n3 "yes" (2026-11-03): the Format step reads the kinds the DIVISION will take - the
// one kind shown on Who plays, picked or left at the sport's default - not only the sport's. Americano and Mexicano
// rotate individual players into pairs (usecases/stages/generators.ts americanoGen plays one person per entrant), so a division narrowed to
// Pairs or Teams is not offered them: no card, not ranked or suggested, not the opening, and Next refuses one picked
// anyway (a stale tap). Expected sets come from the engine's entrant models and the server's pair-minting stage kinds
// (PAIR_MINTING_STAGE_KINDS), restated here - never from the builder's own offer functions.
import { describe, expect, it, vi } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import { effectiveEntrantModel, type EntrantKind } from "@seazn/engine/sport";
import { propsOf, renderIsland, walk } from "@/components/__tests__/_hook-harness";
import { DivisionBuilder, type SportOption } from "@/components/v2/division-builder";
import { STAGE_TEMPLATES } from "@/lib/format-templates";
import { PAIR_MINTING_STAGE_KINDS } from "@/lib/chess-individual-only-rule";
import { sportOptionsFrom } from "@/lib/sport-options";
import uiEn from "@/dictionaries/en/ui.json";
import {
  byTestId,
  currentStep,
  goToStep,
  next,
  pickTemplate,
  pickedTemplate,
  setName,
  stepError,
  templateCards,
  templateKeys,
  visibleTemplateKeys,
  type BuilderIsland,
} from "./_division-builder-driver";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/o/org/c/comp/d/new",
}));
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/i18n/dict-provider")>()),
  useLocale: () => "en" as const,
}));

const UI = uiEn as Record<string, string>;
const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_m, k: string) => v[k]!);

const modelOf = (key: string) => {
  const m = builtinModules.find((x) => x.key === key);
  if (!m) throw new Error(`no engine module ${key}`);
  return effectiveEntrantModel(m.entrantModel ?? null, null);
};
/** Every builtin sport as the page hands it to the builder: the engine's variant presets and entrant model. */
const ALL: SportOption[] = sportOptionsFrom(
  builtinModules.map((m) => ({ key: m.key, name: m.key })),
  builtinModules.flatMap((m) => Object.entries(m.variants as Record<string, Record<string, unknown>>).map(([key, config]) => ({ sport_key: m.key, key, name: key, is_system: true, config }))),
  (key) => ({ kinds: modelOf(key).kinds, defaultKind: modelOf(key).defaultKind }),
);
const sportOf = (key: string): SportOption => ALL.find((s) => s.key === key)!;

/** The formats whose stages mint pairs from individual players (the server's list), by template key. */
const MINTS_PAIRS = STAGE_TEMPLATES.filter((t) => t.build({ qualified: 4, swissRounds: 3, poolCount: 2, legs: 1 }).some((s) => PAIR_MINTING_STAGE_KINDS.includes(s.kind))).map((t) => t.key);

function mount(sport: SportOption) {
  return renderIsland(DivisionBuilder, {
    competitionId: "c1",
    orgSlug: "org",
    compSlug: "comp",
    sports: [sport],
    constraintsAllowed: true,
    archivedSlotsExplainRefusal: false,
    viewerPlan: "pro",
  });
}
type H = ReturnType<typeof mount>;

function pickKind(h: H, kind: EntrantKind) {
  const chip = h.tree().find((e) => e.type === "label" && propsOf(e)["data-entrant-kind"] === kind);
  if (!chip) throw new Error(`no ${kind} chip`);
  (propsOf(walk(chip).find((e) => e.type === "input")!).onChange as () => void)();
}
/** Who plays filled (and the kind, unless it is the default), then Next onto Format. */
function toFormat(sportKey: string, kind?: EntrantKind): H {
  const h = mount(sportOf(sportKey));
  if (kind !== undefined && kind !== modelOf(sportKey).defaultKind) pickKind(h, kind);
  setName(h, "Open");
  next(h);
  if (currentStep(h) !== "format") throw new Error(`${sportKey}: Next did not reach Format (${stepError(h) ?? "no reason"})`);
  return h;
}
const suggestedKeys = (h: BuilderIsland) => templateCards(h).filter((e) => propsOf(e)["data-suggested"] !== undefined).map((e) => propsOf(e)["data-template"] as string);
/** A card's radio handler, captured now: a later call is a stale tap on a card the screen may no longer render. */
function radioHandler(h: H, key: string): () => void {
  const card = templateCards(h).find((e) => propsOf(e)["data-template"] === key);
  if (!card) throw new Error(`no ${key} card`);
  return propsOf(walk(card).find((e) => e.type === "input" && propsOf(e).type === "radio")!).onChange as () => void;
}

describe("N1: the Format step offers what the DIVISION's kind can play", () => {
  it("premise: the formats that mint pairs are the owner's two, Americano and Mexicano", () => {
    expect([...MINTS_PAIRS].sort()).toEqual(["americano", "mexicano"]);
  });

  it("every sport x every kind it allows: no partner-rotation card, suggestion or opening unless the division takes individual players (counts)", () => {
    let checked = 0;
    const dropped: string[] = [];
    const kept: string[] = [];
    for (const m of builtinModules) {
      const model = modelOf(m.key);
      // The sport's own offer of a partner-rotation format (fix round 1, I5): its engine model holds individuals AND
      // pairs, and it is not chess (individual-only by ruling).
      const sportOffersThem = model.kinds.includes("individual") && model.kinds.includes("pair") && m.key !== "boardgame";
      for (const kind of model.kinds) {
        const h = toFormat(m.key, kind);
        const want = sportOffersThem && kind === "individual";
        const where = `${m.key} ${kind}`;
        const pairCards = templateKeys(h).filter((k) => MINTS_PAIRS.includes(k));
        expect(pairCards.sort(), where).toEqual(want ? [...MINTS_PAIRS].sort() : []);
        if (!want) {
          expect(suggestedKeys(h).filter((k) => MINTS_PAIRS.includes(k)), `${where}: suggested`).toEqual([]);
          expect(visibleTemplateKeys(h).filter((k) => MINTS_PAIRS.includes(k)), `${where}: shown`).toEqual([]);
          expect(MINTS_PAIRS, `${where}: the opening`).not.toContain(pickedTemplate(h));
        }
        // Every other card is the same as the sport's at its default kind: only the partner-rotation formats move.
        if (sportOffersThem) (want ? kept : dropped).push(where);
        expect(pickedTemplate(h), `${where}: one card is picked`).toBeDefined();
        checked++;
      }
    }
    expect(checked).toBe(builtinModules.reduce((n, m) => n + modelOf(m.key).kinds.length, 0));
    // The review's list: badminton, tennis, table tennis and carrom with Pairs; generic with Teams (and Pairs).
    expect(dropped.sort()).toEqual(["badminton pair", "carrom pair", "generic pair", "generic team", "tabletennis pair", "tennis pair"]);
    // The positive pair (n3 narrows an untouched badminton to individuals, which still plays Americano).
    expect(kept.sort()).toEqual(["badminton individual", "carrom individual", "generic individual", "tabletennis individual", "tennis individual"]);
  });

  it("only the partner-rotation cards move: badminton at Pairs offers exactly badminton at Individuals' cards less Americano and Mexicano", () => {
    const individuals = templateKeys(toFormat("badminton")).sort();
    const pairs = templateKeys(toFormat("badminton", "pair")).sort();
    expect(pairs).toEqual(individuals.filter((k) => !MINTS_PAIRS.includes(k)));
    expect(individuals.length - pairs.length).toBe(MINTS_PAIRS.length);
  });

  it("a picked Americano, then Who plays → Pairs: the pick is dropped to where a Pairs division opens; Individuals again brings the card back, not the pick", () => {
    const pairsOpening = pickedTemplate(toFormat("badminton", "pair"));
    expect(MINTS_PAIRS).not.toContain(pairsOpening);
    const h = toFormat("badminton");
    pickTemplate(h, "americano");
    expect(pickedTemplate(h)).toBe("americano");
    goToStep(h, "who");
    pickKind(h, "pair");
    next(h);
    expect(currentStep(h)).toBe("format");
    expect(pickedTemplate(h), "the dropped pick lands on the Pairs division's opening").toBe(pairsOpening);
    expect(templateKeys(h)).not.toContain("americano");
    // Back to Individuals: the card returns; the pick was dropped, so the opening (not a remembered Americano) decides.
    goToStep(h, "who");
    pickKind(h, "individual");
    next(h);
    expect(templateKeys(h)).toContain("americano");
    expect(pickedTemplate(h)).toBe(pickedTemplate(toFormat("badminton")));
  });

  it("a pick the kind CAN play survives the kind change: League picked, then Pairs, stays League", () => {
    const h = toFormat("badminton");
    pickTemplate(h, "league");
    goToStep(h, "who");
    pickKind(h, "pair");
    next(h);
    expect(pickedTemplate(h)).toBe("league");
  });

  it("Next refuses a partner-rotation format the division cannot play (a stale tap after the kind changed), naming it; a playable pick clears it", () => {
    const h = toFormat("badminton");
    const staleAmericano = radioHandler(h, "americano");
    goToStep(h, "who");
    pickKind(h, "pair");
    next(h);
    expect(templateKeys(h), "premise: the card is gone").not.toContain("americano");
    staleAmericano();
    next(h);
    expect(currentStep(h), "Next stays on Format").toBe("format");
    expect(stepError(h)).toBe(fill(UI["divBuilder.err.formatKind"]!, { format: UI["format.template.americano.label"]! }));
    // The cleared pair: a format the Pairs division plays clears the refusal, and Next leaves Format.
    pickTemplate(h, "league");
    expect(stepError(h)).toBeNull();
    next(h);
    expect(currentStep(h)).toBe("rules");
  });

  it("Review jumps refuse it too: the step nav cannot carry the stale pick past Format", () => {
    const h = toFormat("badminton");
    const staleMexicano = radioHandler(h, "mexicano");
    goToStep(h, "who");
    pickKind(h, "pair");
    next(h);
    staleMexicano();
    goToStep(h, "review");
    expect(currentStep(h)).toBe("format");
    expect(stepError(h)).toBe(fill(UI["divBuilder.err.formatKind"]!, { format: UI["format.template.mexicano.label"]! }));
    expect(byTestId(h, "division-builder-create")).toBeUndefined();
  });
});
