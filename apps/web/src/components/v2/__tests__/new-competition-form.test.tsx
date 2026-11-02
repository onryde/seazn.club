// Match Day C8 — the New competition form: one column, "Who will find it", and
// the "Add your first division" screen after Create.
//
// vitest is `environment: "node"` with no jsdom, so the stateful island runs
// through the shared hook harness (the JOIN between form state and what the
// children are handed / what is POSTed), and the stateless pieces are rendered
// to static markup. Expected copy comes from the shipped English catalog and
// the expected audiences from the listing authority — never a table typed here.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { propsOf, renderIsland, textOf, walk } from "@/components/__tests__/_hook-harness";
import { DateTimeField, type DateTimeFieldProps } from "../shared/datetime-field";
import { CompetitionWizard } from "../competition-wizard";
import { CompetitionReach } from "../competition-reach";
import { ShowcaseOptIn } from "../showcase-optin";
import { FirstDivisionPrompt } from "../first-division-prompt";
import { TemplateGallery } from "../template-gallery";
import { VisibilitySegmented } from "@/components/ui/visibility-segmented";
import { VISIBILITY_OPTIONS } from "@/components/ui/visibility-picker";
import { ProseEditor } from "@/components/prose-editor";
import { apiV1 } from "@/lib/client-v1";
import { t } from "@/lib/i18n-runtime";
import { routes } from "@/lib/routes";
import { createBlocker, type CreateBlocker } from "@/lib/new-competition-form";
import {
  competitionReach,
  NEW_COMPETITION_STATUS,
  REACH_AUDIENCES,
} from "@/lib/competition-listing";
import { Visibility } from "@/server/api-v1/schemas";
import uiEn from "@/dictionaries/en/ui.json";
import type { Dict } from "@/lib/i18n-constants";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
}));
vi.mock("@/lib/client-v1", async () => {
  const actual = await vi.importActual<typeof import("@/lib/client-v1")>("@/lib/client-v1");
  return { ...actual, apiV1: vi.fn() };
});
// TemplateGallery reads `useT()`, which throws outside a provider (see
// public-quota-degraded-numbers.test.tsx for the same binding).
vi.mock("@/components/i18n/dict-provider", async () => {
  const actual = await vi.importActual<typeof import("@/components/i18n/dict-provider")>(
    "@/components/i18n/dict-provider",
  );
  const { t: tt } = await import("@/lib/i18n-runtime");
  const ui = (await import("@/dictionaries/en/ui.json")).default;
  return {
    ...actual,
    useT: () => (key: string, vars?: Record<string, string | number>) =>
      tt(ui as unknown as import("@/lib/i18n-constants").Dict, key, vars),
  };
});

const enDict = uiEn as unknown as Dict;
/** `t()` returns the KEY on a miss, so a sentence assertion also proves the key shipped. */
const msg = (key: string, vars?: Record<string, string | number>) => t(enDict, key, vars);

/** Static markup, comments and entities undone, whitespace collapsed. */
const flat = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

// ── harness helpers ──────────────────────────────────────────────────────────

const expandFields = (node: ReactNode): ReactElement[] =>
  walk(node).flatMap((el) =>
    el.type === DateTimeField
      ? [el, ...walk(DateTimeField(propsOf(el) as unknown as DateTimeFieldProps))]
      : [el],
  );

const mount = () =>
  renderIsland(
    CompetitionWizard,
    { orgSlug: "riverside", orgId: "org-1", publicDashboardUpgrade: null, viewerPlan: "community" },
    expandFields,
  );
type Island = ReturnType<typeof mount>;

const find = (island: Island, type: unknown) => island.tree().find((el) => el.type === type)!;
const call = <A,>(el: ReactElement, prop: string, arg: A) => (propsOf(el)[prop] as (a: A) => void)(arg);

const dateFields = (island: Island) => island.tree().filter((el) => el.type === DateTimeField);
const typeStart = (island: Island, v: string) => call(dateFields(island)[0]!, "onChange", v);
const typeEnd = (island: Island, v: string) => call(dateFields(island)[1]!, "onChange", v);
const endValue = (island: Island) => propsOf(dateFields(island)[1]!).value;
const nameInput = (island: Island) =>
  island.tree().find((el) => el.type === "input" && propsOf(el).maxLength === 200)!;
const typeName = (island: Island, v: string) => call(nameInput(island), "onChange", { target: { value: v } });
const pickVisibility = (island: Island, v: string) => call(find(island, VisibilitySegmented), "onChange", v);
const setShowcase = (island: Island, on: boolean) => call(find(island, ShowcaseOptIn), "onChange", on);
const createButton = (island: Island) =>
  island.tree().find((el) => el.type === "button" && propsOf(el).type === "submit")!;
const blockerNote = (island: Island) =>
  island.tree().find((el) => propsOf(el)["data-testid"] === "create-blocker");

async function submit(island: Island): Promise<void> {
  const form = island.tree().find((el) => el.type === "form")!;
  await (propsOf(form).onSubmit as (e: { preventDefault: () => void }) => unknown)({
    preventDefault: () => {},
  });
}
const postedBody = () =>
  (vi.mocked(apiV1).mock.calls.at(-1)?.[1] as { json: Record<string, unknown> }).json;

beforeEach(() => {
  vi.mocked(apiV1).mockReset();
  vi.mocked(apiV1).mockResolvedValue({
    id: "c1",
    slug: "autumn-open",
    visibility: "public",
    discoverable: false,
  } as never);
});

// ── order ────────────────────────────────────────────────────────────────────

describe("the form is one column in the owner's order", () => {
  it("Name, Dates, Visibility, Who will find it, Showcase, Description, Create", () => {
    const island = mount();
    const tree = island.tree();
    const at = (pred: (el: ReactElement) => boolean) => tree.findIndex(pred);
    const order = [
      at((el) => el === nameInput(island)),
      at((el) => el === dateFields(island)[0]),
      at((el) => el === dateFields(island)[1]),
      at((el) => el.type === VisibilitySegmented),
      at((el) => el.type === CompetitionReach),
      at((el) => el.type === ShowcaseOptIn),
      at((el) => el.type === ProseEditor),
      at((el) => el === createButton(island)),
    ];
    // Anti-vacuity: every landmark exists (-1 would mean a missing piece).
    expect(order.every((i) => i >= 0), `landmarks: ${order.join(",")}`).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(8);
  });
});

// ── dates ────────────────────────────────────────────────────────────────────

describe("Ends on follows Starts on", () => {
  it("starts empty, takes the first Start picked, and keeps following it", () => {
    const island = mount();
    expect(endValue(island)).toBe("");
    typeStart(island, "2026-11-14");
    expect(endValue(island)).toBe("2026-11-14");
    typeStart(island, "2026-11-20");
    expect(endValue(island)).toBe("2026-11-20");
    typeStart(island, "2026-11-10");
    expect(endValue(island)).toBe("2026-11-10");
  });

  it("an End the organiser pushed out is theirs, until Start passes it", () => {
    const island = mount();
    typeStart(island, "2026-11-14");
    typeEnd(island, "2026-11-16");
    typeStart(island, "2026-11-12");
    expect(endValue(island)).toBe("2026-11-16");
    typeStart(island, "2026-11-30");
    expect(endValue(island)).toBe("2026-11-30");
  });

  it("the End floor is the Start", () => {
    const island = mount();
    expect(propsOf(dateFields(island)[1]!).min).toBeUndefined();
    typeStart(island, "2026-11-14");
    expect(propsOf(dateFields(island)[1]!).min).toBe("2026-11-14");
  });

  it("explains the empty End, and stops once it is filled", () => {
    const island = mount();
    expect(island.text()).toContain(msg("comp.wizard.endsOn.help"));
    typeStart(island, "2026-11-14");
    expect(island.text()).not.toContain(msg("comp.wizard.endsOn.help"));
  });
});

// ── visibility, who will find it, showcase ───────────────────────────────────

describe("visibility, the checklist and the showcase switch share one state", () => {
  it("opens on Public (V396), showcase off", () => {
    const island = mount();
    expect(propsOf(find(island, VisibilitySegmented)).value).toBe("public");
    expect(propsOf(find(island, ShowcaseOptIn)).checked).toBe(false);
    expect(propsOf(find(island, CompetitionReach))).toMatchObject({ visibility: "public", discoverable: false });
  });

  it("every visibility x showcase the form can reach is what the checklist and the switch are handed", () => {
    let checked = 0;
    for (const visibility of Visibility.options) {
      for (const showcase of [false, true]) {
        const island = mount();
        pickVisibility(island, visibility);
        setShowcase(island, showcase);
        // Showcase is only real on Public: elsewhere the switch is disabled and
        // the choice can never be on.
        const effective = visibility === "public" && showcase;
        expect(propsOf(find(island, ShowcaseOptIn)), `${visibility}/${showcase}`).toMatchObject({
          visibility,
          checked: effective,
        });
        expect(propsOf(find(island, CompetitionReach)), `${visibility}/${showcase}`).toMatchObject({
          visibility,
          discoverable: effective,
        });
        checked += 1;
      }
    }
    expect(checked).toBe(Visibility.options.length * 2);
  });

  it("leaving Public switches showcase off, and coming back does not switch it on again", () => {
    const island = mount();
    setShowcase(island, true);
    expect(propsOf(find(island, ShowcaseOptIn)).checked).toBe(true);
    pickVisibility(island, "unlisted");
    expect(propsOf(find(island, ShowcaseOptIn)).checked).toBe(false);
    pickVisibility(island, "public");
    // Consent is an act, not a memory: it has to be given again.
    expect(propsOf(find(island, ShowcaseOptIn)).checked).toBe(false);
  });

  it("POSTs the visibility and the effective showcase", async () => {
    const island = mount();
    typeName(island, "Autumn Open");
    typeEnd(island, "2026-11-15");
    setShowcase(island, true);
    await submit(island);
    expect(postedBody()).toMatchObject({ visibility: "public", discoverable: true });

    const second = mount();
    typeName(second, "Autumn Open");
    typeEnd(second, "2026-11-15");
    setShowcase(second, true);
    pickVisibility(second, "private");
    await submit(second);
    expect(postedBody()).toMatchObject({ visibility: "private", discoverable: false });
  });
});

describe("<CompetitionReach> — Who will find it", () => {
  const CHOICES = [
    { visibility: "private", discoverable: false },
    { visibility: "unlisted", discoverable: false },
    { visibility: "public", discoverable: false },
    { visibility: "public", discoverable: true },
  ] as const;

  const rowsOf = (html: string) =>
    [...html.matchAll(/<li[^>]*data-audience="([a-z]+)"[^>]*data-state="([a-z_]+)"[^>]*>(.*?)<\/li>/g)].map(
      (m) => ({ audience: m[1]!, state: m[2]!, text: flat(m[3]!.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() }),
    );

  it("one row per audience, in the authority's order, each in the state the authority gives a NEW competition", () => {
    let rows = 0;
    const states = new Set<string>();
    for (const choice of CHOICES) {
      const html = renderToStaticMarkup(<CompetitionReach {...choice} />);
      const got = rowsOf(html);
      const want = competitionReach({ ...choice, status: NEW_COMPETITION_STATUS });
      expect(got.map((r) => r.audience), JSON.stringify(choice)).toEqual([...REACH_AUDIENCES]);
      for (const r of got) {
        expect(r.state, `${JSON.stringify(choice)} ${r.audience}`).toBe(want[r.audience as keyof typeof want]);
        states.add(r.state);
        rows += 1;
      }
    }
    expect(rows).toBe(CHOICES.length * REACH_AUDIENCES.length);
    // Anti-vacuity: all three states are exercised, or the loop proved one answer.
    expect([...states].sort()).toEqual(["after_publish", "no", "yes"]);
  });

  it("says it in words: a yes, a no and a later each read differently, and the title is the owner's", () => {
    const pub = rowsOf(renderToStaticMarkup(<CompetitionReach visibility="public" discoverable />));
    const org = pub.find((r) => r.audience === "org")!;
    expect(org.text).toContain(msg("comp.wizard.reach.afterPublish", { audience: msg("comp.wizard.reach.org") }));
    const team = pub.find((r) => r.audience === "team")!;
    expect(team.text).toContain(`${msg("comp.wizard.reach.yes")}`);
    expect(team.text).toContain(msg("comp.wizard.reach.team"));
    const priv = rowsOf(renderToStaticMarkup(<CompetitionReach visibility="private" discoverable={false} />));
    expect(priv.find((r) => r.audience === "link")!.text).toContain(msg("comp.wizard.reach.no"));
    expect(renderToStaticMarkup(<CompetitionReach visibility="public" discoverable={false} />)).toContain(
      msg("comp.wizard.reach.title"),
    );
  });
});

describe("<VisibilitySegmented>", () => {
  it("three radios from the schema's own enum, one checked, and the selected option's consequence underneath", () => {
    let checked = 0;
    for (const value of Visibility.options) {
      const html = renderToStaticMarkup(<VisibilitySegmented value={value} onChange={() => {}} />);
      const radios = [...html.matchAll(/<input[^>]*type="radio"[^>]*>/g)].map((m) => m[0]);
      expect(radios.map((r) => /value="([a-z]+)"/.exec(r)![1])).toEqual([...Visibility.options]);
      expect(radios.filter((r) => /\schecked(=|\s|>)/.test(r)).length, value).toBe(1);
      expect(radios.find((r) => r.includes(`value="${value}"`))!).toMatch(/\schecked(=|\s|>)/);
      const option = VISIBILITY_OPTIONS.find((o) => o.value === value)!;
      expect(flat(html), value).toContain(msg(option.consequence));
      // The unselected options' consequences are not on screen.
      for (const other of VISIBILITY_OPTIONS.filter((o) => o.value !== value)) {
        expect(flat(html), `${value} must not print ${other.value}'s line`).not.toContain(msg(other.consequence));
      }
      checked += 1;
    }
    expect(checked).toBe(3);
  });

  it("each segment WRAPS its radio (so a click on the label picks it) and is a 44px target", () => {
    const html = renderToStaticMarkup(<VisibilitySegmented value="public" onChange={() => {}} />);
    const labels = [...html.matchAll(/<label[^>]*>(.*?)<\/label>/g)];
    expect(labels).toHaveLength(3);
    for (const l of labels) {
      expect(l[0]).toContain('type="radio"');
      expect(l[0]).toMatch(/min-h-11/);
    }
    // The accessible name of each radio is its label alone — the old e2e helper
    // finds `^private` / `^public` by it.
    expect(labels.map((l) => l[1]!.replace(/<[^>]+>/g, "").trim())).toEqual(
      VISIBILITY_OPTIONS.map((o) => msg(o.label)),
    );
  });

  it("picking an option reports it", () => {
    const seen: string[] = [];
    const island = renderIsland(VisibilitySegmented, { value: "public", onChange: (v: string) => seen.push(v) });
    const radio = island.tree().find((e) => e.type === "input" && propsOf(e).value === "private")!;
    (propsOf(radio).onChange as () => void)();
    expect(seen).toEqual(["private"]);
  });
});

describe("<ShowcaseOptIn>", () => {
  it("is disabled unless Public, and says why in amber-700", () => {
    let checked = 0;
    for (const visibility of Visibility.options) {
      const html = flat(renderToStaticMarkup(<ShowcaseOptIn visibility={visibility} checked={false} onChange={() => {}} />));
      const input = /<input[^>]*role="switch"[^>]*>/.exec(html)![0];
      const isPublic = visibility === "public";
      expect(/\sdisabled(=|\s|>)/.test(input), `${visibility} disabled`).toBe(!isPublic);
      if (isPublic) {
        expect(html).not.toContain(msg("showcase.needsPublic"));
      } else {
        expect(html).toContain(msg("showcase.needsPublic"));
        // The reason is amber-700 (AA), not the old amber-600.
        expect(html).toMatch(/text-amber-700[^>]*>[^<]*(<[^>]+>[^<]*)*Set visibility to public/);
        expect(html).not.toContain("text-amber-600");
      }
      checked += 1;
    }
    expect(checked).toBe(Visibility.options.length);
  });

  it("carries the one line and 'What this allows', whose consent wording is the existing key, unedited", () => {
    const html = flat(renderToStaticMarkup(<ShowcaseOptIn visibility="public" checked onChange={() => {}} />));
    expect(html).toContain(msg("showcase.label"));
    expect(html).toContain(msg("comp.wizard.showcase.line"));
    expect(html).toContain(msg("comp.wizard.showcase.allows"));
    expect(html).toContain(msg("showcase.consent"));
    // Pin the KEY, not a copy: the component reads `showcase.consent` and types
    // no consent sentence of its own, so settings and this form cannot diverge.
    const src = readFileSync(new URL("../showcase-optin.tsx", import.meta.url), "utf8");
    expect(src).toContain('msg("showcase.consent")');
    expect(src).not.toMatch(/may appear on seazn\.club/);
  });

  it("is a switch with a real label, and toggling reports the new value", () => {
    const seen: boolean[] = [];
    const island = renderIsland(ShowcaseOptIn, { visibility: "public", checked: false, onChange: (v: boolean) => seen.push(v) });
    const input = island.tree().find((e) => e.type === "input")!;
    expect(propsOf(input).role).toBe("switch");
    (propsOf(input).onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: true } });
    expect(seen).toEqual([true]);
  });
});

// ── create ───────────────────────────────────────────────────────────────────

describe("Create is disabled until the form can be created, and says what is missing", () => {
  const REASON: Record<CreateBlocker, string> = {
    name: msg("comp.wizard.missing.name"),
    endsOn: msg("comp.wizard.missing.endsOn"),
    both: msg("comp.wizard.missing.both"),
    order: msg("comp.validation.endsBeforeStarts"),
  };

  it("each missing field has its own reason, shown beside the disabled button", () => {
    const cases: [string, (i: Island) => void, CreateBlocker][] = [
      ["nothing typed", () => {}, "both"],
      ["a name only", (i) => typeName(i, "Autumn Open"), "endsOn"],
      ["an end only", (i) => typeEnd(i, "2026-11-15"), "name"],
      ["a start only (Ends follows it) but no name", (i) => typeStart(i, "2026-11-14"), "name"],
      [
        "an End before the Start",
        (i) => {
          typeName(i, "Autumn Open");
          typeStart(i, "2026-11-14");
          typeEnd(i, "2026-11-13");
        },
        "order",
      ],
    ];
    for (const [label, setup, blocker] of cases) {
      const island = mount();
      setup(island);
      expect(propsOf(createButton(island)).disabled, label).toBe(true);
      // The note beside the button says exactly the blocker's reason — not
      // another one's (several are substrings of "Add a name and an end date").
      expect(textOf(blockerNote(island)!), label).toBe(REASON[blocker]);
    }
    expect(new Set(Object.values(REASON)).size).toBe(4);
  });

  it("is enabled, with no reason, once it can be created — and the button names the reason it is waiting on", () => {
    const island = mount();
    typeName(island, "Autumn Open");
    typeEnd(island, "2026-11-15");
    expect(propsOf(createButton(island)).disabled).toBe(false);
    expect(propsOf(createButton(island))["aria-describedby"]).toBe(propsOf(blockerNote(island)!).id);
    expect(textOf(blockerNote(island)!)).toBe("");
  });

  it("the blocker the button obeys is the one createBlocker names", () => {
    const island = mount();
    typeName(island, "x");
    expect(createBlocker({ name: "x", startsOn: "", endsOn: "" })).toBe("endsOn");
    expect(propsOf(createButton(island)).disabled).toBe(true);
  });

  it("a submit that gets past the disabled button (Enter in a field) still posts nothing and says why", async () => {
    const island = mount();
    typeEnd(island, "2026-11-15");
    await submit(island);
    expect(vi.mocked(apiV1)).not.toHaveBeenCalled();
    expect(flat(island.text())).toContain(msg("comp.wizard.missing.name"));
  });
});

describe("the description is the competition-settings editor", () => {
  it("mounts ProseEditor for this org, with the phone tap floor, and posts its Markdown", async () => {
    const island = mount();
    const editor = find(island, ProseEditor);
    expect(propsOf(editor)).toMatchObject({ value: "", orgId: "org-1", touch: true });
    call(editor, "onChange", "Two days of **singles** and doubles.");
    expect(propsOf(find(island, ProseEditor)).value).toBe("Two days of **singles** and doubles.");
    typeName(island, "Autumn Open");
    typeEnd(island, "2026-11-15");
    await submit(island);
    expect(postedBody().description).toBe("Two days of **singles** and doubles.");
  });

  it("posts null, not an empty string, for a description nobody wrote", async () => {
    const island = mount();
    typeName(island, "Autumn Open");
    typeEnd(island, "2026-11-15");
    call(find(island, ProseEditor), "onChange", "   ");
    await submit(island);
    expect(postedBody().description).toBeNull();
  });
});

describe("the whole body", () => {
  it("name, dates, visibility, showcase, description and the empty branding", async () => {
    const island = mount();
    typeName(island, "Autumn Open");
    typeStart(island, "2026-11-14");
    typeEnd(island, "2026-11-15");
    setShowcase(island, true);
    call(find(island, ProseEditor), "onChange", "Hello");
    await submit(island);
    expect(postedBody()).toEqual({
      name: "Autumn Open",
      description: "Hello",
      visibility: "public",
      discoverable: true,
      starts_on: "2026-11-14",
      ends_on: "2026-11-15",
      branding: {},
    });
  });
});

// ── after Create ─────────────────────────────────────────────────────────────

describe("after Create: Add your first division", () => {
  it("replaces the form (so it cannot be created twice) with the prompt, fed by what the server made", async () => {
    vi.mocked(apiV1).mockResolvedValue({
      id: "c1",
      slug: "autumn-open",
      visibility: "unlisted",
      discoverable: false,
    } as never);
    const island = mount();
    typeName(island, "Autumn Open");
    typeStart(island, "2026-11-14");
    typeEnd(island, "2026-11-15");
    await submit(island);
    expect(island.tree().some((el) => el.type === "form")).toBe(false);
    const prompt = find(island, FirstDivisionPrompt);
    expect(propsOf(prompt)).toMatchObject({
      orgSlug: "riverside",
      // The server's answer, not the request's: it is the truthful one.
      created: {
        name: "Autumn Open",
        slug: "autumn-open",
        visibility: "unlisted",
        discoverable: false,
        startsOn: "2026-11-14",
        endsOn: "2026-11-15",
      },
    });
  });

  it("a degraded create keeps its own card (the cap note), not this prompt", async () => {
    vi.mocked(apiV1).mockResolvedValue({
      id: "c1",
      slug: "autumn-open",
      visibility: "private",
      discoverable: false,
      public_quota_degraded: { feature_key: "dashboard.public.max", limit: 2 },
    } as never);
    const island = mount();
    typeName(island, "Autumn Open");
    typeEnd(island, "2026-11-15");
    await submit(island);
    expect(island.tree().some((el) => el.type === FirstDivisionPrompt)).toBe(false);
    expect(island.text()).toContain("was created as private");
  });
});

describe("<FirstDivisionPrompt>", () => {
  const created = (over: Partial<Parameters<typeof FirstDivisionPrompt>[0]["created"]> = {}) => ({
    name: "Riverside Autumn Open 2026",
    slug: "autumn-open",
    visibility: "public",
    discoverable: true,
    startsOn: "2026-11-14",
    endsOn: "2026-11-15",
    ...over,
  });
  const render = (over = {}) =>
    flat(renderToStaticMarkup(<FirstDivisionPrompt orgSlug="riverside" created={created(over)} />));

  it("the primary action opens the division builder, the secondary goes to the competition", () => {
    const html = render();
    const links = [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g)].map((m) => ({
      href: m[1]!,
      text: m[2]!.replace(/<[^>]+>/g, "").trim(),
      tag: m[0],
    }));
    const add = links.find((l) => l.text === msg("comp.wizard.created.add"))!;
    const later = links.find((l) => l.text === msg("comp.wizard.created.later"))!;
    expect(add.href).toBe(routes.divisionNew("riverside", "autumn-open"));
    expect(later.href).toBe(routes.competition("riverside", "autumn-open"));
    expect(add.tag).toMatch(/btn-primary/);
    expect(later.tag).toMatch(/btn-ghost/);
    for (const l of [add, later]) expect(l.tag).toMatch(/min-h-11/);
  });

  it("says it was created, names the competition and what it is set to, and asks for the first division", () => {
    const html = render();
    expect(html).toContain(msg("comp.wizard.created.status"));
    expect(html).toContain("Riverside Autumn Open 2026");
    expect(html).toContain(msg("comp.wizard.created.title"));
    expect(html).toContain(msg("comp.wizard.created.body"));
    expect(html).toContain(msg("comp.wizard.created.showcased"));
    // Both dates, in the viewer's locale.
    expect(html).toMatch(/14 Nov 2026/);
    expect(html).toMatch(/15 Nov 2026/);
  });

  it("each visibility names itself by the existing label; showcase and a second date only when they are real", () => {
    let checked = 0;
    for (const option of VISIBILITY_OPTIONS) {
      const html = render({ visibility: option.value, discoverable: false, endsOn: "2026-11-14" });
      expect(html, option.value).toContain(msg(option.label));
      expect(html, option.value).not.toContain(msg("comp.wizard.created.showcased"));
      expect(html, option.value).not.toMatch(/15 Nov 2026/);
      checked += 1;
    }
    expect(checked).toBe(3);
  });

  it("moves focus to its heading so a screen reader lands on the new screen", () => {
    const src = readFileSync(new URL("../first-division-prompt.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/\.focus\(\)/);
    expect(render()).toMatch(/<h2[^>]*tabindex="-1"/);
  });
});

// ── wiring from the page ─────────────────────────────────────────────────────

describe("TemplateGallery hands the wizard the org id the editor uploads to", () => {
  it("Start blank mounts CompetitionWizard with orgId", () => {
    const island = renderIsland(TemplateGallery, {
      orgSlug: "riverside",
      orgId: "org-1",
      templates: [],
      publicDashboardUpgrade: null,
      viewerPlan: "community" as const,
    });
    const blank = island.tree().find((el) => propsOf(el)["data-testid"] === "template-start-blank")!;
    (propsOf(blank).onClick as () => void)();
    const wizard = island.tree().find((el) => el.type === CompetitionWizard)!;
    expect(propsOf(wizard)).toMatchObject({ orgSlug: "riverside", orgId: "org-1" });
  });
});
