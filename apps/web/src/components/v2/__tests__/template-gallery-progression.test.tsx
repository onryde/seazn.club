// P7 D1b T4: the template detail sheet's progression map. A stage carrying
// `.seeding` renders a line describing where its entrants come from (ALL of
// its `seeding.take` rules, joined, then the arrow + the stage's own name) —
// euro24's knockout stage is the one that would silently lose information if
// only the first take rule rendered (top-2-per-group AND the 4 best
// third-placed teams), so that pairing is the primary case pinned here. Also
// covers the STAGE_KIND_KEY gap fix: league/page_playoff previously fell
// back to their raw kind string; league-playoff (P7) is the first catalog
// entry to actually reach either branch.
//
// No jsdom in this workspace (component-ui-i18n memory) — pure derivation
// logic (takeRuleText/templateProgressionLines) is tested directly as plain
// functions, and the sheet itself via renderToStaticMarkup, mirroring
// constraints-panel-i18n.test.tsx in this same directory.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  TemplateCard,
  TemplateDetailSheet,
  takeRuleText,
  templateProgressionLines,
  templateStructureChain,
  type Msg,
} from "../template-gallery";
import { DictProvider } from "@/components/i18n/dict-provider";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import { t as tRuntime } from "@/lib/i18n-runtime";
import type { Dict, Locale } from "@/lib/i18n-constants";
import type { CompetitionTemplate } from "@/server/templates/schema";
// Real shipped catalog data (not a hand-built fixture) for the
// multiple-SEEDED-STAGES case below — reviewer gap 1: t20-super8's Super 8
// stage AND its knockout stage both carry `.seeding`, so this tracks the
// actual production data instead of a lookalike that could drift from it.
// `catalog.ts` is server-only, which only matters to a browser BUNDLE; a
// vitest test runs in Node like any other import (catalog.test.ts already
// imports it directly, in this same style, from server/templates/__tests__).
import { getTemplate } from "@/server/templates/catalog";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const ALL_DICTS: [Locale, Dict][] = [
  ["en", enUi as Dict],
  ["es", esUi as Dict],
  ["fr", frUi as Dict],
  ["nl", nlUi as Dict],
];

const enMsg: Msg = (key, vars) => tRuntime(enUi as Dict, key, vars);

type Stage = CompetitionTemplate["divisions"][number]["stages"][number];

const GROUP_NO_SEEDING: Stage = { i18nNameKey: "templates.stage.groupStage", kind: "group", groups: 6 };

// euro24's actual R16 stage (catalog/euro24.json) — the ONE stage in the
// launch catalog with more than one take rule.
const EURO24_KNOCKOUT: Stage = {
  i18nNameKey: "templates.stage.knockout",
  kind: "knockout",
  size: 16,
  seeding: {
    source: "previous",
    take: [
      { kind: "topNPerGroup", n: 2 },
      { kind: "bestNth", nth: 3, count: 4 },
    ],
    placement: "rank_order",
  },
};

function templateWith(stages: Stage[], sportKey = "football"): CompetitionTemplate {
  return {
    key: "fixture-template",
    version: 1,
    i18n: { nameKey: "templates.euro24.name", descriptionKey: "templates.euro24.desc" },
    divisions: [
      {
        i18nNameKey: "templates.euro24.div.main",
        sportKey,
        variantKey: "11-a-side",
        entrantKind: "team",
        entrantCount: 24,
        stages,
      },
    ],
  };
}

describe("takeRuleText — one take rule -> one translated phrase", () => {
  it("topNPerGroup", () => {
    expect(takeRuleText(enMsg, { kind: "topNPerGroup", n: 2 })).toBe("Top 2 per group");
  });
  it("bestNth", () => {
    expect(takeRuleText(enMsg, { kind: "bestNth", nth: 3, count: 4 })).toBe("4 best 3-placed");
  });
  it("rankRange", () => {
    expect(takeRuleText(enMsg, { kind: "rankRange", from: 1, to: 4 })).toBe("Ranked 1–4");
  });
});

describe("templateProgressionLines", () => {
  it("renders NO lines when no stage carries seeding — the pre-P7 catalog shape", () => {
    expect(templateProgressionLines(enMsg, templateWith([GROUP_NO_SEEDING]))).toHaveLength(0);
  });

  it("renders ALL take rules for a stage with more than one, not just the first, prefixed by its source stage", () => {
    const lines = templateProgressionLines(enMsg, templateWith([GROUP_NO_SEEDING, EURO24_KNOCKOUT]));
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toContain("Top 2 per group");
    expect(lines[0].text).toContain("4 best 3-placed");
    expect(lines[0].text).toContain("Knockout");
    // P7/D1b T6: the line must NAME the stage entrants come FROM (the
    // previous stage's own i18nNameKey, "Group Stage" — GROUP_NO_SEEDING
    // here), not just describe the take rule and target.
    expect(lines[0].text).toBe("Group Stage: Top 2 per group and 4 best 3-placed → Knockout");
  });

  // Reviewer gap 1: a DIFFERENT multiplicity than the euro24 case above —
  // TWO OR MORE SEEDED STAGES in one template, not one stage with two take
  // rules. t20-super8 (catalog/t20-super8.json) is exactly that in
  // production: its "Super 8" stage AND its "Knockout" stage both carry
  // `.seeding`. A `templateProgressionLines` that silently truncated to
  // `lines[0]` would pass every OTHER test in this file (none of them has
  // more than one seeded stage) while shipping only half the map here.
  //
  // T6: both lines ALSO share the identical take-rule text ("Top 2 per
  // group") and both targets are `group`-kind stages one level up — before
  // this task NEITHER the take text NOR a kind label could tell the two
  // lines' origins apart (P7/D1b defect). Only the source-stage-name prefix
  // does, so this test pins that prefix explicitly, not just "some text
  // differs somewhere".
  it("renders a distinct line for EACH seeded stage in t20-super8 (Super 8 AND Knockout), each prefixed by its OWN source stage", () => {
    const t20 = getTemplate("t20-super8");
    if (!t20) throw new Error("t20-super8 missing from the catalog — catalog.test.ts should already fail this");

    const lines = templateProgressionLines(enMsg, t20);
    expect(lines).toHaveLength(2);
    expect(lines[0].text).toBe("Group Stage: Top 2 per group → Super 8");
    expect(lines[1].text).toBe("Super 8: Top 2 per group → Knockout");
    expect(lines[0].text).not.toBe(lines[1].text);
    // The load-bearing assertion: a fix that named both lines from the same
    // stage (e.g. always the division's FIRST stage, rather than each
    // stage's actual immediate predecessor) would still pass every check
    // above by accident on this data, since lines[0] genuinely is fed by
    // the first stage — but it would fail HERE, on line[1]'s prefix.
    const sourcePrefix = (text: string) => text.split(":")[0];
    expect(sourcePrefix(lines[0].text)).toBe("Group Stage");
    expect(sourcePrefix(lines[1].text)).toBe("Super 8");
    expect(sourcePrefix(lines[0].text)).not.toBe(sourcePrefix(lines[1].text));
  });
});

describe("templateStructureChain — Structure section's per-division stage chain", () => {
  it("names BOTH ambiguous group-kind stages by their OWN name in t20-super8, fixing the identical-looking-links defect (P7/D1b T6)", () => {
    const t20 = getTemplate("t20-super8");
    if (!t20) throw new Error("t20-super8 missing from the catalog — catalog.test.ts should already fail this");
    expect(templateStructureChain(enMsg, t20.divisions[0])).toBe("Group Stage → Super 8 → Knockout");
  });

  // Regression: none of the 5 pre-P7 catalog templates repeats a kind
  // within one division, so every one of them must keep resolving via the
  // UNCHANGED kind-label path (never a stage's own i18nNameKey). Expected
  // strings use Title Case ("Group Stage", not "Group stage") per the T7
  // casing fix to templates.stageKind.* — before that fix this path and the
  // sheet's own-name path rendered the SAME concept in two different
  // casings side by side across different cards/templates; the kind-label
  // SELECTION logic these 5 exercise is unchanged, only the label text's
  // casing is. Reads the REAL shipped catalog (not lookalike fixtures),
  // same reasoning as the t20-super8 case above.
  it.each([
    ["slam128", "Knockout"],
    ["swiss11", "Swiss"],
    ["wc32", "Group Stage → Knockout"],
    ["americano-night", "Americano"],
    ["box-league", "Group Stage"],
  ])("regression: %s's structure chain still resolves via the kind-label path (%s)", (key, expected) => {
    const template = getTemplate(key);
    if (!template) throw new Error(`${key} missing from the catalog — catalog.test.ts should already fail this`);
    expect(templateStructureChain(enMsg, template.divisions[0])).toBe(expected);
  });
});

describe("templates.detail.progression.line — all four locales interpolate source, take, AND target", () => {
  // The key itself already existed (euro24/t20-super8/league-playoff shipped
  // it pre-T6 with 2 params); T6 adds a THIRD param to its value in all four
  // dictionaries. The generic "every templates.* key resolves in all four
  // locales" scan below only proves the key is present and non-empty, which
  // a dictionary that forgot to add {source} to its template string would
  // still pass. This proves the stronger claim: each locale's STRING
  // actually references all three placeholders, not just source/target.
  it.each(ALL_DICTS)("%s's progression.line template uses {source}, {take}, AND {target}", (locale, dict) => {
    const text = tRuntime(dict, "templates.detail.progression.line", {
      source: "SRC_STAGE_MARKER",
      take: "TAKE_RULE_MARKER",
      target: "TGT_STAGE_MARKER",
    });
    expect(text, `${locale} dropped {source}`).toContain("SRC_STAGE_MARKER");
    expect(text, `${locale} dropped {take}`).toContain("TAKE_RULE_MARKER");
    expect(text, `${locale} dropped {target}`).toContain("TGT_STAGE_MARKER");
  });
});

const renderSheet = (template: CompetitionTemplate, dict: Dict = enUi as Dict, locale: Locale = "en") =>
  renderToStaticMarkup(
    <DictProvider dict={dict} locale={locale}>
      <TemplateDetailSheet orgSlug="acme" template={template} onClose={() => {}} />
    </DictProvider>,
  );

// TemplateCard takes `msg` as a direct prop (unlike TemplateDetailSheet,
// which calls useT() internally) — no DictProvider needed to render it.
const renderCard = (template: CompetitionTemplate, dict: Dict = enUi as Dict) =>
  renderToStaticMarkup(
    <TemplateCard template={template} msg={(key, vars) => tRuntime(dict, key, vars)} onSelect={() => {}} />,
  );

describe("TemplateDetailSheet — progression section", () => {
  it("renders the progression map, with both of euro24's take rules present, prefixed by its source stage", () => {
    const html = renderSheet(templateWith([GROUP_NO_SEEDING, EURO24_KNOCKOUT]));
    expect(html).toContain('data-testid="template-detail-progression"');
    expect(html).toContain("Top 2 per group");
    expect(html).toContain("4 best 3-placed");
    expect(html).toContain("Group Stage: Top 2 per group");
  });

  it("renders BOTH t20-super8 progression lines (two seeded stages), each prefixed by its OWN source stage, not just one", () => {
    const t20 = getTemplate("t20-super8");
    if (!t20) throw new Error("t20-super8 missing from the catalog — catalog.test.ts should already fail this");
    const html = renderSheet(t20);
    expect(html).toContain('data-testid="template-detail-progression"');
    expect(html).toContain("Group Stage: Top 2 per group → Super 8");
    expect(html).toContain("Super 8: Top 2 per group → Knockout");
  });

  it("renders BOTH t20-super8 structure links with their OWN names, not the identical 'Group Stage' kind label twice", () => {
    const t20 = getTemplate("t20-super8");
    if (!t20) throw new Error("t20-super8 missing from the catalog — catalog.test.ts should already fail this");
    const html = renderSheet(t20);
    expect(html).toContain('data-testid="template-detail-structure"');
    expect(html).toContain("Group Stage → Super 8 → Knockout");
    expect(html).not.toContain("Group Stage → Group Stage → Knockout");
  });

  it("regression: a template with no seeded stages omits the section and the structure list is unchanged", () => {
    const html = renderSheet(templateWith([GROUP_NO_SEEDING]));
    expect(html).not.toContain('data-testid="template-detail-progression"');
    // Structure section renders its pre-existing "{division} — {kind chain}
    // · {n} entrants" line exactly as before this task: a single group-kind
    // stage has no kind collision within its division, so it still resolves
    // via stageKindLabel (templates.stageKind.group), NOT the stage's own
    // i18nNameKey (templates.stage.groupStage) — templateStructureChain only
    // switches to a stage's own name when its kind repeats within the
    // division (see the dedicated describe block below for the case that
    // DOES switch). Both keys now resolve to the SAME text ("Group Stage",
    // T7's casing fix) so this no longer proves which path rendered by
    // eyeballing the string alone — the assertion below is really pinning
    // "the pre-existing single-stage shape renders unchanged", not casing.
    expect(html).toContain('data-testid="template-detail-structure"');
    expect(html).toContain("Tournament");
    expect(html).toContain("Group Stage");
    expect(html).toContain("24 entrants");
  });

  it("fixes the league/page_playoff stage-kind label gap: league-playoff's structure line reads real labels, not raw kind strings", () => {
    const leaguePlayoff = templateWith(
      [
        { i18nNameKey: "templates.stage.leagueTable", kind: "league" },
        {
          i18nNameKey: "templates.stage.pagePlayoff",
          kind: "page_playoff",
          size: 4,
          seeding: { source: "previous", take: [{ kind: "rankRange", from: 1, to: 4 }], placement: "rank_order" },
        },
      ],
      "cricket",
    );
    const html = renderSheet(leaguePlayoff);
    expect(html).toContain("League → Page Playoff");
    expect(html).not.toContain("league → page_playoff");
    expect(html).toContain("Ranked 1–4");
  });
});

// Reviewer gap 2 (P7/D1b T7 review round): the block above proves the
// SHEET's Structure line via only ONE synthetic single-group fixture
// (GROUP_NO_SEEDING). templateStructureChain's own kind-vs-own-name
// selection already has a dedicated 5-real-template regression block
// above, and TemplateCard's mirrors it — but neither proves the SHEET's
// OWN JSX (a separate call site) actually wires templateStructureChain's
// output into the Structure <li> correctly; a local wiring slip there
// could ship undetected. Mirrors TemplateCard's regression block below,
// through renderSheet instead of renderCard.
describe("TemplateDetailSheet — structure line regression (5 real pre-P7 templates)", () => {
  it.each([
    ["slam128", "Knockout"],
    ["swiss11", "Swiss"],
    ["wc32", "Group Stage → Knockout"],
    ["americano-night", "Americano"],
    ["box-league", "Group Stage"],
  ])("regression: %s's sheet Structure line still resolves via the kind-label path (%s)", (key, expected) => {
    const template = getTemplate(key);
    if (!template) throw new Error(`${key} missing from the catalog — catalog.test.ts should already fail this`);
    const html = renderSheet(template);
    const structureStart = html.indexOf('data-testid="template-detail-structure"');
    expect(structureStart, `${key}: structure testid not found`).toBeGreaterThan(-1);
    // Isolate to JUST the structure <ul>...</ul> block before matching —
    // a bare html.toContain(expected) is silently vacuous for a
    // single-word label like "Swiss"/"Americano", which ALSO appears in
    // the template's own name/description rendered elsewhere in the
    // sheet (proven by mutation: a broken chain still passed those 2
    // cases under a whole-document toContain check). Then pin the EXACT
    // chain text between the " — " and " · " separators, not a substring
    // of it, mirroring TemplateCard's exact-match regression check.
    const structureHtml = html.slice(structureStart, html.indexOf("</ul>", structureStart));
    const chainMatch = structureHtml.match(/— (.*?) ·/);
    expect(chainMatch, `${key}: could not isolate the structure chain text`).not.toBeNull();
    expect(chainMatch![1]).toBe(expected);
  });
});

// P7/D1b T7 (coordinator-flagged, same defect class as the sheet's
// STRUCTURE line above): the gallery GRID card's own structure summary used
// `templateStageKinds(template).map(stageKindLabel).join(" → ")` — flat kind
// labels across every division, the SAME bug the sheet fix above closed,
// just a second code path expressing the same vocabulary. Now composed from
// `templateStructureChain` (the SAME helper the sheet uses, one per
// division, joined) — no second ambiguity-detection implementation.
describe("TemplateCard — gallery grid structure summary", () => {
  it("names BOTH ambiguous group-kind stages by their OWN name for t20-super8, fixing the identical-looking-links defect on the CARD too", () => {
    const t20 = getTemplate("t20-super8");
    if (!t20) throw new Error("t20-super8 missing from the catalog — catalog.test.ts should already fail this");
    const html = renderCard(t20);
    expect(html).toContain("Group Stage → Super 8 → Knockout");
    expect(html).not.toContain("Group Stage → Group Stage → Knockout");
  });

  // Regression: the five pre-P7 catalog templates' cards must keep resolving
  // via the UNCHANGED kind-label path — same expected strings (Title Case
  // per the T7 casing fix) as templateStructureChain's own regression block
  // above, since every one of these templates has exactly one division (so
  // joining ACROSS divisions is a no-op) and no kind collision within it.
  it.each([
    ["slam128", "Knockout"],
    ["swiss11", "Swiss"],
    ["wc32", "Group Stage → Knockout"],
    ["americano-night", "Americano"],
    ["box-league", "Group Stage"],
  ])("regression: %s's card structure summary still resolves via the kind-label path (%s)", (key, expected) => {
    const template = getTemplate(key);
    if (!template) throw new Error(`${key} missing from the catalog — catalog.test.ts should already fail this`);
    const html = renderCard(template);
    expect(html).toContain(expected);
    // Card's structure `<span>` is 2 elements after the description span —
    // pin its EXACT text, not just a substring, so a mutation that appended
    // stray text alongside `expected` would still be caught.
    const match = html.match(/text-purple-600">([^<]*)</);
    expect(match, `${key}: structure span not found in rendered card`).not.toBeNull();
    expect(match![1]).toBe(`${expected} · ${template.divisions[0].entrantCount} entrants`);
  });
});

// Owner-ruled fix for the 320px scroll-fold: at 320x568 the required
// Ends-on field sat below the modal's internal scroll fold on EVERY
// template even pre-P7 (reproduced on box-league), and PROGRESSION grew
// that overflow further. The form fields now render BEFORE the
// description/STRUCTURE/PROGRESSION prose, so a mobile organiser sees
// what they must fill in without scrolling.
describe("TemplateDetailSheet — form leads, prose follows (320px scroll-fold fix)", () => {
  it("the Ends-on field precedes STRUCTURE and PROGRESSION in the rendered DOM order", () => {
    const html = renderSheet(templateWith([GROUP_NO_SEEDING, EURO24_KNOCKOUT]));
    const endsOnIdx = html.indexOf("Ends on *");
    const structureIdx = html.indexOf('data-testid="template-detail-structure"');
    const progressionIdx = html.indexOf('data-testid="template-detail-progression"');
    expect(endsOnIdx, "Ends-on label not found in rendered output").toBeGreaterThan(-1);
    expect(structureIdx, "structure block not found").toBeGreaterThan(-1);
    expect(progressionIdx, "progression block not found").toBeGreaterThan(-1);
    expect(endsOnIdx).toBeLessThan(structureIdx);
    expect(endsOnIdx).toBeLessThan(progressionIdx);
  });
});

describe("i18n — every templates.* key template-gallery.tsx references resolves in all four locales", () => {
  it("resolves to a non-empty string, all four locales", () => {
    const srcPath = fileURLToPath(new URL("../template-gallery.tsx", import.meta.url));
    const src = readFileSync(srcPath, "utf8");
    const found = new Set<string>();
    const keyPattern = /"(templates\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)"/g;
    let m: RegExpExecArray | null;
    while ((m = keyPattern.exec(src))) found.add(m[1]);

    // A regression net on the scan itself, same reasoning as
    // constraints-panel-i18n.test.tsx: if this collapses toward 0, the loop
    // below passes vacuously instead of proving anything.
    expect(found.size, "source scan found suspiciously few templates.* keys").toBeGreaterThanOrEqual(15);

    for (const [locale, dict] of ALL_DICTS) {
      const record = dict as Record<string, unknown>;
      for (const key of found) {
        const value = record[key];
        expect(typeof value, `${locale} is missing ${key}`).toBe("string");
        expect((value as string).length, `${locale}/${key} is an empty string`).toBeGreaterThan(0);
      }
    }
  });
});
