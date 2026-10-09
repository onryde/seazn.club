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
import { renderToStaticMarkup } from "react-dom/server";
import {
  CAMERA_INHERIT,
  DivisionSettings,
  cameraChoiceOf,
  cameraPatchValue,
  cameraSelectOptions,
  effectiveCameraChoice,
} from "@/components/v2/division-settings";
import { CAMERA_POLICIES, type CameraPolicy } from "@/lib/camera-policy";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
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

function renderChess(own: CameraPolicy | null, inherited: CameraPolicy, dict = EN): string {
  activeDict.current = dict;
  return renderToStaticMarkup(
    <DivisionSettings
      division={{
        id: "d1",
        name: "Open",
        sport_key: "boardgame",
        variant_key: "classical",
        config: { variant: "classical", onlinePlay: "lichess", clock: { base: 600, increment: 5 } },
        logo_url: null,
        logo_storage_path: null,
        camera_policy: own,
        inherited_camera_policy: inherited,
      }}
      orgId="org1"
      variants={[{ key: "classical", name: "Classical" }]}
      locked={false}
      stages={[]}
      canEdit
      divisionPathPrefix="/o/org/c/comp/d/"
      fixturesHref="/o/org/c/comp/d/div/fixtures"
      embed={<div />}
      danger={<div />}
      entrantModel={INDIVIDUAL_ONLY}
      entrantModelSource="sport"
      autoPosts={false}
      canAutoPost={false}
      showSeeds
      viewerPlan="community"
    />,
  );
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
  it("the FIRST option returns to the competition's setting and names its value; then each policy once, short", () => {
    // Typed from the controller's ruling: "Use the competition setting
    // (<current competition value>)", then Off / Optional / Required.
    expect(cameraSelectOptions("required", msgFor(EN))).toEqual([
      { value: CAMERA_INHERIT, label: "Use the competition setting (Required)" },
      { value: "off", label: "Off" },
      { value: "optional", label: "Optional" },
      { value: "required", label: "Required" },
    ]);
    // The named value FOLLOWS the competition, not a constant.
    expect(cameraSelectOptions("off", msgFor(EN))[0]).toEqual({
      value: CAMERA_INHERIT,
      label: "Use the competition setting (Off)",
    });
  });

  it("in Spanish, the longest locale here", () => {
    expect(cameraSelectOptions("required", msgFor(ES)).map((o) => o.label)).toEqual([
      "Usar el ajuste de la competición (Obligatoria)",
      "Desactivada",
      "Opcional",
      "Obligatoria",
    ]);
  });

  it("every declared policy is offered exactly once, after inherit — swept, with the count", () => {
    const values = cameraSelectOptions("optional", msgFor(EN)).map((o) => o.value);
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

describe("the collapsed camera Group header", () => {
  it("an unset division's summary is the inherit label with the competition's value", () => {
    const header = cameraHeader(renderChess(null, "required"), EN["divset.camera.label"]!);
    expect(text(header)).toContain("Use the competition setting (Required)");
  });

  it("a pinned division's summary is its short label", () => {
    const header = cameraHeader(renderChess("optional", "required"), EN["divset.camera.label"]!);
    expect(text(header)).toContain("Optional");
    expect(text(header).join(" ")).not.toContain("Use the competition setting");
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
