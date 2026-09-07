// F3 Task 6: division-settings.tsx's format <select> (its <option> labels)
// and its help caption used to render hardcoded English straight off
// STAGE_TEMPLATES. Both now read `format.template.<key>.label` / `.help` via
// useMsg() — format-templates.ts no longer even HAS those fields (see its
// own "F3 Task 6" comment).
//
// Unlike division-builder.tsx's picker (a CSS-hidden tab section, reachable
// by a plain renderToStaticMarkup pass — see
// division-builder-format-picker-i18n.test.tsx), the Format block here lives
// inside a `Group` accordion that defaults CLOSED (`useState(defaultOpen)`,
// defaultOpen not passed at this call site). division-settings-progression.
// test.tsx already documents that Group's `{open && children}` is opaque to
// a plain renderToStaticMarkup pass (closed means "never render") AND to the
// interactive hook-harness's usual click-driven re-render (Group's `open` is
// GROUP's own hook cell — renderIsland only drives the ROOT component's
// hooks, one component per call; see _hook-harness.tsx).
//
// This test reaches the picker without ever opening the Group. `walk()`
// (_hook-harness.tsx) flattens the returned element tree by reading each
// node's `props.children` directly — it never CALLS Group as a function, so
// it never consults Group's `open` state either. `<Group title={...}>
// {formatSectionJsx}</Group>` means `formatSectionJsx` — the <select>, every
// <option>, the help <span>, each already holding its msg()-resolved text —
// was fully built by DIVISIONSETTINGS' OWN render pass (JSX children are
// evaluated eagerly, before Group is ever invoked) and sits on the Group
// element as `props.children`, independent of what Group's internal `open`
// state will eventually do with it. The first test below proves this
// empirically (options are found at all) before the locale assertions lean
// on it.
//
// Locale switching: renderIsland's useContext shim always returns
// DictContext's compiled DEFAULT (there is no real Provider tree — see
// _hook-harness.tsx's own useContext doc), so wrapping in a real
// <DictProvider> would do nothing under this harness. useMsg() itself is
// mocked instead, to a stub that resolves keys against whichever locale
// dict the test just selected — the same {key -> string} contract useMsg's
// real implementation honours, just pointed at a dict this harness can see.
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderIsland, propsOf, textOf, walk } from "@/components/__tests__/_hook-harness";
import { DivisionSettings } from "@/components/v2/division-settings";
import { STAGE_TEMPLATES } from "@/components/v2/format-templates";
import type { EffectiveEntrantModel } from "@seazn/engine/sport";
import enUi from "@/dictionaries/en/ui.json";
import esUi from "@/dictionaries/es/ui.json";
import frUi from "@/dictionaries/fr/ui.json";
import nlUi from "@/dictionaries/nl/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

const { activeDict } = vi.hoisted(() => ({
  activeDict: { current: {} as Record<string, string> },
}));

vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  return {
    ...actual,
    useMsg: () => (key: string, vars?: Record<string, string | number>) => {
      const raw = activeDict.current[key];
      if (typeof raw !== "string") return key;
      if (!vars) return raw;
      return raw.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
    },
  };
});

const en = enUi as Record<string, string>;

const INDIVIDUAL_ONLY: EffectiveEntrantModel = {
  kinds: ["individual"],
  defaultKind: "individual",
  squadNumbers: false,
  captain: false,
  maxTeamMembers: null,
};

function mount() {
  return renderIsland(DivisionSettings, {
    division: {
      id: "d1",
      name: "Open",
      sport_key: "football",
      variant_key: "standard",
      config: {},
      logo_url: null,
      logo_storage_path: null,
    },
    orgId: "org1",
    variants: [{ key: "standard", name: "Standard" }],
    locked: false,
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
    viewerPlan: "community",
  });
}

/** Scoped to the format <select>'s OWN <option> children — division-settings
 *  renders other <select>s elsewhere (e.g. the sport variant picker), so a
 *  bare "every <option> in the tree" filter overcounts. `walk()` on just
 *  this element's `children` prop reaches inside it without needing the
 *  <select> itself to have been "opened" any more than the Group already
 *  needed to be — see the file header. */
function optionsOf(h: ReturnType<typeof mount>) {
  const select = h
    .tree()
    .find((e) => e.type === "select" && propsOf(e)["data-testid"] === "format-template");
  if (!select) throw new Error('format <select data-testid="format-template"> not found');
  return walk((propsOf(select).children as ReactNode) ?? null);
}

/** The format <select>'s help caption — the only <span> with this exact
 *  class combination (division-settings.tsx:~600). */
function helpSpan(h: ReturnType<typeof mount>) {
  return h
    .tree()
    .find((e) => e.type === "span" && propsOf(e).className === "mt-0.5 block text-[11px] text-slate-400");
}

const NON_ENGLISH = [
  ["es", esUi],
  ["fr", frUi],
  ["nl", nlUi],
] as const;

describe("division settings' format picker renders dictionary copy, not the old hardcoded field (F3 Task 6)", () => {
  it("sanity check: the format <select>'s options are reachable even though its enclosing Group defaults closed", () => {
    activeDict.current = en;
    const options = optionsOf(mount());
    expect(options.length).toBe(STAGE_TEMPLATES.length);
    expect(options.length).toBeGreaterThanOrEqual(14);
  });

  for (const [locale, dict] of NON_ENGLISH) {
    it(`renders every STAGE_TEMPLATES option label in ${locale}, not the English literal`, () => {
      activeDict.current = dict as Record<string, string>;
      const options = optionsOf(mount());
      expect(options.length).toBe(STAGE_TEMPLATES.length);

      for (const opt of options) {
        const key = propsOf(opt).value as string;
        const labelKey = `format.template.${key}.label`;
        const translated = (dict as Record<string, string>)[labelKey];
        expect(translated, `${locale} is missing ${labelKey}`).toBeTruthy();
        const text = textOf(opt);
        expect(text, `${locale}/${labelKey} did not render`).toBe(translated);
        if (translated !== en[labelKey]) {
          expect(text, `${locale}/${labelKey} still shows the English literal`).not.toBe(en[labelKey]);
        }
      }
    });

    it(`renders the selected template's help caption in ${locale}, not the English literal (default selection: league)`, () => {
      activeDict.current = dict as Record<string, string>;
      const span = helpSpan(mount());
      expect(span, "help <span> not found").toBeTruthy();

      const helpKey = "format.template.league.help";
      const translated = (dict as Record<string, string>)[helpKey];
      expect(translated, `${locale} is missing ${helpKey}`).toBeTruthy();
      const text = textOf(span!);
      expect(text, `${locale}/${helpKey} did not render`).toBe(translated);
      if (translated !== en[helpKey]) {
        expect(text, `${locale}/${helpKey} still shows the English literal`).not.toBe(en[helpKey]);
      }
    });
  }
});
