// Match Day C4 (owner, 2026-10-31: the Advanced overrides JSON - "we don't need"): the raw-JSON rules editor is reachable from NO
// surface. C2 deleted the block with the rest of Settings' Match rules; this is the sweep that proves it stays gone, by looking at
// what every mount that draws rules or settings actually RENDERS - not at one file's source.
//
// A mount is swept for: a <textarea> (the JSON box was one), the words "JSON" / "Advanced", an id or test id naming either, and the
// field it edited (`rules_override`). Every mount is rendered for every sport in the registry, as the organiser and as a reader, and
// the sweep counts what it rendered: a render count of zero, or a mount that drew nothing, is a FAILURE (TEST-STRATEGY: anti-vacuity).
// The dictionaries carry no JSON-editor copy in any locale either (the string was the only way to draw one).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { builtinModules } from "@seazn/engine/sports";
import type { AnySportModule, TableStageKind } from "@seazn/engine/sport";
import { DictProvider } from "@/components/i18n/dict-provider";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { DivisionSettings } from "@/components/v2/division-settings";
import { SettingsGroup } from "@/components/v2/settings-group";
import { EntrantKindsSettings } from "@/components/v2/entrant-kinds-settings";
import { DivisionRulesStrip } from "@/components/v2/rules/division-rules-strip";
import { MatchFormatEditor } from "@/components/v2/rules/match-format-editor";
import { PointsEditor, divisionPointsOf, hydrateDivisionPoints } from "@/components/v2/rules/points-editor";
import { TiebreaksEditor } from "@/components/v2/rules/tiebreaks-editor";
import { cfgOf, tableRulesOf } from "@/components/v2/stage-rules/__tests__/_table-rules-fixture";
import { rulesLineDict } from "@/lib/rules-line";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import enPublic from "@/dictionaries/en/public.json";
import type { Dict } from "@/lib/i18n-constants";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, replace: () => undefined, push: () => undefined }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

const ID = "33333333-3333-4333-8333-333333333333";
const SPORTS: readonly AnySportModule[] = builtinModules;
const RULE_DICT = rulesLineDict(enPublic as Dict);

/** What a JSON overrides editor would draw or be reached by. `rules_override` is the column it edited. */
const JSON_EDITOR = /<textarea\b|\bJSON\b|\badvanced\b|data-testid="[^"]*(?:json|advanced)[^"]*"|\bid="[^"]*(?:json|advanced)[^"]*"|rules_override/i;

const html = (el: ReactElement): string =>
  renderToStaticMarkup(
    <DictProvider dict={enUi as Dict} locale="en">
      {el}
    </DictProvider>,
  );

interface Mount {
  name: string;
  /** Every render this mount makes for one sport: the organiser's and the reader's. */
  renders: (m: AnySportModule) => { label: string; markup: string }[];
}

const divisionCfg = (m: AnySportModule): Record<string, unknown> => cfgOf(m) as Record<string, unknown>;

/** The Settings tab's tree, flattened to its markup-like surface: every element's tag and test id, every id, and every string. */
function settingsSurface(sport: string, canEdit: boolean): string {
  const island = renderIsland(DivisionSettings, {
    division: { id: "d1", name: "Open", sport_key: sport, variant_key: "standard", config: {}, logo_url: null, logo_storage_path: null },
    orgId: "org1",
    structureLocked: false,
    lockedFields: [],
    stages: [],
    canEdit,
    divisionPathPrefix: "/o/org/c/comp/d/",
    fixturesHref: "/o/org/c/comp/d/div/fixtures",
    embed: null,
    danger: null,
    autoPosts: false,
    canAutoPost: false,
    showSeeds: true,
    viewerPlan: "community" as const,
    onlineChessOffered: true,
  });
  const parts = island.tree().map((e) => `<${String(e.type)} ${["data-testid", "id", "name", "aria-label", "title", "summary"].map((k) => `${k}="${String(propsOf(e)[k] ?? "")}"`).join(" ")}>`);
  expect(island.tree().filter((e) => e.type === SettingsGroup).length, "premise: the groups were walked").toBeGreaterThan(3);
  return `${parts.join("\n")}\n${island.text()}`;
}

const MOUNTS: Mount[] = [
  {
    name: "Settings tab (every group walked)",
    renders: (m) => [true, false].map((canEdit) => ({ label: `canEdit=${canEdit}`, markup: settingsSurface(m.key, canEdit) })),
  },
  {
    name: "Entrants tab: the entrant kinds block (open)",
    renders: (m) =>
      [true, false].map((canEdit) => ({
        label: `canEdit=${canEdit}`,
        markup: html(<EntrantKindsSettings defaultOpen divisionId={ID} sportKey={m.key} config={{}} canEdit={canEdit} entrantModel={{ kinds: ["individual", "pair", "team"], defaultKind: "individual", squadNumbers: true, captain: true, maxTeamMembers: null }} />),
      })),
  },
  {
    name: "Fixtures tab: the Division rules strip (all panels open)",
    renders: (m) =>
      [true, false].map((canEdit) => ({
        label: `canEdit=${canEdit}`,
        markup: html(
          <DivisionRulesStrip
            divisionId={ID}
            sportKey={m.key}
            variantKey={Object.keys(m.variants)[0] ?? null}
            divisionConfig={divisionCfg(m)}
            divisionTiebreakers={null}
            tableKinds={["league"]}
            canEdit={canEdit}
            ruleDict={RULE_DICT}
            variants={Object.entries(m.variants).map(([key, config]) => ({ key, name: key, system: true, config: config as Record<string, unknown> }))}
            lockedFields={[]}
            onlineChessOffered
            initialOpen={["format", "points", "tiebreaks"]}
          />,
        ),
      })),
  },
  {
    name: "Match format editor: division and stage scope, edit and locked",
    renders: (m) => {
      const cfg = divisionCfg(m);
      const common = { sportKey: m.key, module: m, kind: "league" as const, variant: null, values: {}, onChange: () => undefined, divisionConfig: cfg, resolved: cfg, ruleDict: RULE_DICT };
      return [
        { label: "division edit", markup: html(<MatchFormatEditor scope="division" mode="edit" sportKey={m.key} module={m} values={{}} onChange={() => undefined} inherited={cfg} ruleDict={RULE_DICT} />) },
        { label: "division locked", markup: html(<MatchFormatEditor scope="division" mode="locked" sportKey={m.key} module={m} values={{}} onChange={() => undefined} inherited={cfg} ruleDict={RULE_DICT} />) },
        { label: "stage edit", markup: html(<MatchFormatEditor scope="stage" mode="edit" started={false} {...common} />) },
        { label: "stage locked", markup: html(<MatchFormatEditor scope="stage" mode="locked" started {...common} />) },
      ];
    },
  },
  {
    name: "Points editor: division and stage scope, edit and locked",
    renders: (m) => {
      const cfg = divisionCfg(m);
      const stage = { stageId: ID, module: m, kind: "league", stageConfig: {}, divisionConfig: cfg, stored: null, pointsDict: undefined, onSaved: () => undefined };
      const division = { module: m, divisionConfig: cfg, value: hydrateDivisionPoints(m.key, divisionPointsOf(m, cfg)), onChange: () => undefined, kinds: ["league"] as TableStageKind[] };
      return [
        { label: "division edit", markup: html(<PointsEditor scope="division" mode="edit" {...division} />) },
        { label: "division locked", markup: html(<PointsEditor scope="division" mode="locked" {...division} />) },
        { label: "stage edit", markup: html(<PointsEditor scope="stage" mode="edit" started={false} {...stage} />) },
        { label: "stage locked", markup: html(<PointsEditor scope="stage" mode="locked" started {...stage} />) },
      ];
    },
  },
  {
    name: "Tie-breaks editor: division and stage scope, edit and locked",
    renders: (m) => {
      const cfg = divisionCfg(m);
      const rules = tableRulesOf(m, "league");
      const stageProps = { stage: { id: ID, kind: "league" as TableStageKind, pooled: false, bestNth: false, tableRules: rules }, module: m, divisionConfig: cfg, stageConfig: {}, onSaved: () => undefined };
      const divisionProps = { module: m, value: null, onChange: () => undefined, divisionConfig: cfg, kinds: ["league"] as TableStageKind[] };
      return [
        { label: "division edit", markup: html(<TiebreaksEditor scope="division" mode="edit" {...divisionProps} />) },
        { label: "division locked", markup: html(<TiebreaksEditor scope="division" mode="locked" {...divisionProps} />) },
        { label: "stage edit", markup: html(<TiebreaksEditor scope="stage" mode="edit" started={false} {...stageProps} />) },
        { label: "stage locked", markup: html(<TiebreaksEditor scope="stage" mode="locked" started {...stageProps} />) },
      ];
    },
  },
];

describe("the JSON overrides editor is reachable nowhere", () => {
  it("no mount that draws rules or settings renders one, for any sport, as organiser or reader (renders counted)", () => {
    let renders = 0;
    const perMount = new Map<string, number>();
    for (const mount of MOUNTS) {
      for (const m of SPORTS) {
        for (const r of mount.renders(m)) {
          expect(r.markup.length, `${mount.name} / ${m.key} / ${r.label}: drew something`).toBeGreaterThan(40);
          const hit = r.markup.match(JSON_EDITOR);
          expect(hit?.[0], `${mount.name} / ${m.key} / ${r.label}: a JSON editor, or a name for one`).toBeUndefined();
          renders++;
          perMount.set(mount.name, (perMount.get(mount.name) ?? 0) + 1);
        }
      }
    }
    expect(SPORTS.length, "premise: the registry is not empty").toBeGreaterThan(1);
    expect(perMount.size, "every mount rendered").toBe(MOUNTS.length);
    for (const [name, count] of perMount) expect(count, `${name}: rendered for every sport`).toBeGreaterThanOrEqual(SPORTS.length * 2);
    const expected = SPORTS.length * (2 + 2 + 2 + 4 + 4 + 4);
    expect(renders, "anti-vacuity: renders swept").toBe(expected);
  });

  it("the detector itself sees a JSON editor when one is drawn (the positive pair: it cannot pass on a blind regex)", () => {
    for (const drawn of [
      "<textarea></textarea>",
      "<label>Advanced overrides (JSON)</label>",
      '<div data-testid="division-rules-json"></div>',
      '<div data-testid="rules-advanced-toggle"></div>',
      '<input id="override-json">',
      "<p>rules_override</p>",
    ]) {
      expect(JSON_EDITOR.test(drawn), drawn).toBe(true);
    }
    // ...and it leaves the ordinary rules surface alone.
    expect(JSON_EDITOR.test('<div data-testid="division-rules-panel-points"><input id="win"></div>')).toBe(false);
  });

  it("no source file of a rules or settings surface declares a <textarea> (the JSON box was the only one; sources counted)", () => {
    const root = join(__dirname, "..");
    const walkTsx = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        if (name === "__tests__") return [];
        return statSync(p).isDirectory() ? walkTsx(p) : name.endsWith(".tsx") ? [p] : [];
      });
    const files = [
      ...walkTsx(join(root, "rules")),
      ...walkTsx(join(root, "stage-rules")),
      join(root, "division-settings.tsx"),
      join(root, "division-builder.tsx"),
      join(root, "stages-panel.tsx"),
      join(root, "entrant-kinds-settings.tsx"),
    ];
    let checked = 0;
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      expect(src.length, `${file}: read`).toBeGreaterThan(200);
      expect(src, `${file}: no <textarea>`).not.toMatch(/<textarea\b/);
      expect(src, `${file}: nothing parses a JSON box into a rules override`).not.toMatch(/rules_override|ruleOverrideJson|overridesJson/);
      checked++;
    }
    expect(checked, "anti-vacuity: files swept").toBeGreaterThanOrEqual(10);
  });

  it("no locale carries the JSON editor's copy (counted)", () => {
    let checked = 0;
    for (const [loc, dict] of [["en", enUi], ["es", esUi], ["fr", frUi], ["nl", nlUi]] as const) {
      const values = Object.entries(dict as Record<string, string>);
      expect(values.length, `${loc}: dictionary read`).toBeGreaterThan(1000);
      for (const [key, value] of values) {
        if (/^(divset|rulesStrip|stageRules|stagePoints|stageTiebreaks|rules)\./.test(key)) {
          expect(value, `${loc} ${key}`).not.toMatch(/\bJSON\b/i);
          expect(key, `${loc}: a key naming it`).not.toMatch(/json|advanced/i);
          checked++;
        }
      }
    }
    expect(checked, "anti-vacuity: rules/settings strings swept").toBeGreaterThan(400);
  });
});
