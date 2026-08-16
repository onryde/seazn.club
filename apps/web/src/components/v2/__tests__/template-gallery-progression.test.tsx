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
  TemplateDetailSheet,
  takeRuleText,
  templateProgressionLines,
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

  it("renders ALL take rules for a stage with more than one, not just the first", () => {
    const lines = templateProgressionLines(enMsg, templateWith([GROUP_NO_SEEDING, EURO24_KNOCKOUT]));
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toContain("Top 2 per group");
    expect(lines[0].text).toContain("4 best 3-placed");
    expect(lines[0].text).toContain("Knockout");
  });
});

const renderSheet = (template: CompetitionTemplate, dict: Dict = enUi as Dict, locale: Locale = "en") =>
  renderToStaticMarkup(
    <DictProvider dict={dict} locale={locale}>
      <TemplateDetailSheet orgSlug="acme" template={template} onClose={() => {}} />
    </DictProvider>,
  );

describe("TemplateDetailSheet — progression section", () => {
  it("renders the progression map, with both of euro24's take rules present", () => {
    const html = renderSheet(templateWith([GROUP_NO_SEEDING, EURO24_KNOCKOUT]));
    expect(html).toContain('data-testid="template-detail-progression"');
    expect(html).toContain("Top 2 per group");
    expect(html).toContain("4 best 3-placed");
  });

  it("regression: a template with no seeded stages omits the section and the structure list is unchanged", () => {
    const html = renderSheet(templateWith([GROUP_NO_SEEDING]));
    expect(html).not.toContain('data-testid="template-detail-progression"');
    // Structure section renders its pre-existing "{division} — {kind chain}
    // · {n} entrants" line exactly as before this task (stageKindLabel's
    // "Group stage", NOT the stage's own i18nNameKey "Group Stage" — the
    // structure line never rendered individual stage names).
    expect(html).toContain('data-testid="template-detail-structure"');
    expect(html).toContain("Tournament");
    expect(html).toContain("Group stage");
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
    expect(html).toContain("League → Page playoff");
    expect(html).not.toContain("league → page_playoff");
    expect(html).toContain("Ranked 1–4");
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
