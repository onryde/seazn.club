// T6 follow-up fix round (controller, 2026-10-09) — the camera control on the
// division Settings tab:
//  - M-4: a pinned division can go back to "inherit from competition". The
//    select's FIRST option is "Use the competition setting (<its value>)" and
//    saving it sends camera_policy null (the server gates and audits null on
//    the EFFECTIVE change, camera-policy-divisions.test.ts).
//  - the option labels are SHORT (Off / Optional / Required); the explanation
//    lives in the help text only (camera-policy-copy.test.ts pins the copy).
//  - the shared Group header stacks its summary under the title below md, so
//    a long title is not squeezed to one word per line at 320.
//  - help text clears AA contrast: no text-slate-400 anywhere on the tab.
// apps/web vitest is node-env and the camera Group renders collapsed, so its
// body (the select) is not in static markup: the options are proven through
// the exported builders the select maps, and in the browser by the visual
// pass and e2e/division-settings.spec.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import {
  CAMERA_INHERIT,
  DivisionSettings,
  cameraChoiceOf,
  cameraInheritHint,
  cameraPatchValue,
  cameraSelectOptions,
  cameraSummary,
  effectiveCameraChoice,
} from "@/components/v2/division-settings";
import { CAMERA_POLICIES, type CameraPolicy } from "@/lib/camera-policy";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";
import type { EffectiveEntrantModel } from "@seazn/engine/sport";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

const { activeDict } = vi.hoisted(() => ({ activeDict: { current: {} as Record<string, string> } }));
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  return { ...actual, useMsg: () => msgFor(activeDict.current) };
});

function msgFor(dict: Record<string, string>) {
  return (key: string, vars?: Record<string, string | number>) => {
    const raw = dict[key];
    if (typeof raw !== "string") return key;
    if (!vars) return raw;
    return raw.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
  };
}
const EN = enUi as Record<string, string>;
const ES = esUi as Record<string, string>;

const INDIVIDUAL_ONLY: EffectiveEntrantModel = {
  kinds: ["individual"],
  defaultKind: "individual",
  squadNumbers: false,
  captain: false,
  maxTeamMembers: null,
};

function chessProps(
  own: CameraPolicy | null,
  inherited: CameraPolicy,
  config: Record<string, unknown> = { variant: "classical", onlinePlay: "lichess", clock: { base: 600, increment: 5 } },
): ComponentProps<typeof DivisionSettings> {
  return {
    division: {
      id: "d1",
      name: "Open",
      sport_key: "boardgame",
      variant_key: "classical",
      config,
      logo_url: null,
      logo_storage_path: null,
      camera_policy: own,
      inherited_camera_policy: inherited,
    },
    orgId: "org1",
    structureLocked: false,
    lockedFields: [],
    stages: [],
    canEdit: true,
    divisionPathPrefix: "/o/org/c/comp/d/",
    fixturesHref: "/o/org/c/comp/d/div/fixtures",
    embed: <div />,
    danger: <div />,
    entrantModel: INDIVIDUAL_ONLY,
    entrantModelSource: "sport",
    autoPosts: false,
    canAutoPost: false,
    showSeeds: true,
    viewerPlan: "community",
    // T20: the camera control renders only while the club is offered online chess.
    onlineChessOffered: true,
  } as ComponentProps<typeof DivisionSettings>;
}

function renderChess(own: CameraPolicy | null, inherited: CameraPolicy, dict = EN): string {
  activeDict.current = dict;
  return renderToStaticMarkup(<DivisionSettings {...chessProps(own, inherited)} />);
}

/** The collapsed camera Group's header button, by its (typed) title. */
function cameraHeader(html: string, title: string): string {
  const at = html.indexOf(`>${title}<`);
  expect(at, `premise: the camera Group "${title}" rendered`).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<button", at);
  const end = html.indexOf("</button>", at);
  return html.slice(start, end);
}
const text = (markup: string) => markup.replace(/<[^>]+>/g, "\u0000").split("\u0000").filter(Boolean);

describe("camera select options (M-4 + short labels)", () => {
  it("the FIRST option returns to the competition's setting — short, no value inside; then each policy once, short", () => {
    // Typed from the controller's rulings (r2 short labels; r3 "Competition
    // setting", no value in the option).
    expect(cameraSelectOptions(msgFor(EN))).toEqual([
      { value: CAMERA_INHERIT, label: "Competition setting" },
      { value: "off", label: "Off" },
      { value: "optional", label: "Optional" },
      { value: "required", label: "Required" },
    ]);
  });

  it("in Spanish", () => {
    expect(cameraSelectOptions(msgFor(ES)).map((o) => o.label)).toEqual([
      "Ajuste de la competición",
      "Desactivada",
      "Opcional",
      "Obligatoria",
    ]);
  });

  it("every declared policy is offered exactly once, after inherit — swept, with the count", () => {
    const values = cameraSelectOptions(msgFor(EN)).map((o) => o.value);
    let checked = 0;
    for (const p of CAMERA_POLICIES) {
      expect(values.filter((v) => v === p), p).toHaveLength(1);
      checked += 1;
    }
    expect(checked, "anti-vacuity").toBe(CAMERA_POLICIES.length);
    expect(values[0]).toBe(CAMERA_INHERIT);
    expect(values).toHaveLength(CAMERA_POLICIES.length + 1);
  });
});

describe("camera choice <-> stored value", () => {
  it("a division with no value of its own shows inherit; a pinned one shows its value", () => {
    expect(cameraChoiceOf(null)).toBe(CAMERA_INHERIT);
    let checked = 0;
    for (const p of CAMERA_POLICIES) {
      expect(cameraChoiceOf(p)).toBe(p);
      checked += 1;
    }
    expect(checked).toBe(CAMERA_POLICIES.length);
  });

  it("saving inherit sends null (the server's 'clear to inherit'), any policy sends itself", () => {
    expect(cameraPatchValue(CAMERA_INHERIT)).toBeNull();
    for (const p of CAMERA_POLICIES) expect(cameraPatchValue(p)).toBe(p);
  });

  it("what players get under each choice: inherit is the competition's value, a pin is itself", () => {
    expect(effectiveCameraChoice(CAMERA_INHERIT, "required")).toBe("required");
    expect(effectiveCameraChoice(CAMERA_INHERIT, "off")).toBe("off");
    // A pin wins even DOWNWARDS (the division overrides the competition).
    expect(effectiveCameraChoice("off", "required")).toBe("off");
  });
});

describe("where the competition's value is visible while inheriting (never only in the select)", () => {
  it("SAVED inherit: the hint says the division is not set and names the competition's value", () => {
    expect(cameraInheritHint(CAMERA_INHERIT, CAMERA_INHERIT, "required", msgFor(EN))).toBe(
      "Not set for this division — the competition's setting applies: Required. Saving a choice above sets it for this division.",
    );
    // The value FOLLOWS the competition, not a constant.
    expect(cameraInheritHint(CAMERA_INHERIT, CAMERA_INHERIT, "off", msgFor(EN))).toContain("applies: Off.");
  });

  it("UNSAVED inherit on a pinned division: not 'not set' yet — what saving will do (review Minor 3), for every pin", () => {
    let checked = 0;
    for (const stored of CAMERA_POLICIES) {
      expect(cameraInheritHint(CAMERA_INHERIT, stored, "required", msgFor(EN)), `stored ${stored}`).toBe(
        "After saving, this division will use the competition's setting: Required.",
      );
      checked += 1;
    }
    expect(checked).toBe(CAMERA_POLICIES.length);
    expect(cameraInheritHint(CAMERA_INHERIT, "optional", "required", msgFor(ES))).toBe(
      "Al guardar, esta división usará el ajuste de la competición: Obligatoria.",
    );
  });

  it("a pin selected shows no inherit hint, whatever is stored", () => {
    let checked = 0;
    for (const stored of [CAMERA_INHERIT, ...CAMERA_POLICIES] as const) {
      for (const p of CAMERA_POLICIES) {
        expect(cameraInheritHint(p, stored, "required", msgFor(EN)), `choice ${p}, stored ${stored}`).toBeNull();
        checked += 1;
      }
    }
    expect(checked).toBe((CAMERA_POLICIES.length + 1) * CAMERA_POLICIES.length);
  });

  it("the collapsed summary names it too; a pin's summary is its short label", () => {
    expect(cameraSummary(CAMERA_INHERIT, "required", msgFor(EN))).toBe("Competition setting (Required)");
    expect(cameraSummary(CAMERA_INHERIT, "required", msgFor(ES))).toBe("Ajuste de la competición (Obligatoria)");
    expect(cameraSummary("optional", "required", msgFor(EN))).toBe("Optional");
  });
});

describe("the collapsed camera Group header", () => {
  it("an unset division's summary is the competition setting with its value", () => {
    const header = cameraHeader(renderChess(null, "required"), EN["divset.camera.label"]!);
    expect(text(header)).toContain("Competition setting (Required)");
  });

  it("a pinned division's summary is its short label", () => {
    const header = cameraHeader(renderChess("optional", "required"), EN["divset.camera.label"]!);
    expect(text(header)).toContain("Optional");
    expect(text(header).join(" ")).not.toContain("Competition setting");
  });

  it("below md the summary stacks under the title instead of squeezing it (shared Group)", () => {
    const header = cameraHeader(renderChess("required", "off", ES), ES["divset.camera.label"]!);
    // The button wraps on phones and the summary takes a full row there; at
    // md it stays one row. Anchored on `class="` so a class elsewhere cannot
    // satisfy it.
    expect(header).toMatch(/<button[^>]*class="[^"]*\bflex-wrap\b[^"]*\bmd:flex-nowrap\b/);
    const summary = header.match(/<span class="([^"]*)">Obligatoria<\/span>/);
    expect(summary, "premise: the summary span rendered with the short es label").not.toBeNull();
    expect(summary![1]).toMatch(/(^|\s)basis-full(\s|$)/);
    expect(summary![1]).toMatch(/(^|\s)md:basis-auto(\s|$)/);
    expect(summary![1]).toMatch(/(^|\s)truncate(\s|$)/);
  });
});

describe("contrast: no text-slate-400 on the Settings tab (axe: 2.63:1 at 11px fails AA)", () => {
  it("the rendered tab carries none — headers and the open groups", () => {
    const html = renderChess(null, "required");
    const classes = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]!);
    expect(classes.length, "anti-vacuity: the tab rendered elements").toBeGreaterThan(20);
    expect(classes.filter((c) => /(^|\s)text-slate-400(\s|$)/.test(c))).toEqual([]);
  });

  it("…nor does any collapsed body the static render cannot open (source sweep)", () => {
    const src = readFileSync(new URL("../division-settings.tsx", import.meta.url), "utf8");
    expect(src.length, "premise: the component source was read").toBeGreaterThan(1000);
    expect(src.match(/\btext-slate-400\b/g) ?? []).toEqual([]);
  });
});

// Match Day C2 fix round 1, M3 (ruling: online play stays in the strip): Settings says where online play went, in both places
// it is missed - the camera hint that waits on it, and the pointer that replaced the match rules.
describe("online play lives on the Division rules strip, and Settings says where", () => {
  const LOCALES: [string, Record<string, string>][] = [
    ["en", EN],
    ["es", esUi as Record<string, string>],
    ["fr", frUi as Record<string, string>],
    ["nl", nlUi as Record<string, string>],
  ];
  const OFF = { variant: "classical", clock: { base: 600, increment: 5 } };

  it("online play not saved: the camera hint links to the Fixtures tab, by the strip's own name, in every locale (counted)", () => {
    let checked = 0;
    for (const [loc, dict] of LOCALES) {
      activeDict.current = dict;
      // The camera Group's body is folded in a static render, so the island's tree is read (the harness walks a Group's children).
      const tree = renderIsland(DivisionSettings, chessProps(null, "off", OFF)).tree();
      const hint = tree.find((e) => propsOf(e)["data-testid"] === "division-camera-needs-online");
      expect(hint, `${loc}: premise, the hint is on the page`).toBeDefined();
      expect(textOf(hint!), `${loc}: the sentence`).toContain(dict["divset.camera.needsOnlinePlay"]!);
      const link = tree.find((e) => propsOf(e)["data-testid"] === "division-camera-online-link");
      expect(link, `${loc}: the link`).toBeDefined();
      expect(propsOf(link!).href, `${loc}: to the Fixtures tab`).toBe("/o/org/c/comp/d/div/fixtures");
      expect(textOf(link!), `${loc}: named as the strip is`).toBe(dict["divset.rulesMovedLink"]!);
      expect(textOf(hint!), `${loc}: inside the hint`).toContain(dict["divset.rulesMovedLink"]!);
      checked++;
    }
    expect(checked, "locales").toBe(4);
    // The contrast: online play saved, no hint and no link.
    activeDict.current = EN;
    const saved = renderIsland(DivisionSettings, chessProps(null, "off")).tree();
    expect(saved.find((e) => propsOf(e)["data-testid"] === "division-camera-online-link")).toBeUndefined();
  });

  it("the pointer that replaced the match rules names online play, in every locale (counted)", () => {
    let checked = 0;
    for (const [loc, dict] of LOCALES) {
      expect(dict["divset.rulesMoved"]!.toLowerCase(), loc).toContain(dict["divset.onlinePlay.label"]!.toLowerCase());
      checked++;
    }
    expect(checked, "locales").toBe(4);
  });
});
