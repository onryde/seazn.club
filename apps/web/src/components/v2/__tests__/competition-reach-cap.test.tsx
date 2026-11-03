// Match Day PB3 item 6 - a cap-aware "Who will find it" on the New competition form.
//
// At `dashboard.public.max` the server creates a Public (or Link only) competition PRIVATE (`public_quota_degraded`), but the checklist
// above Create used to promise public reach regardless. The page now hands the form the org's remaining public slots; at 0 with a
// metered visibility selected, the checklist says plainly that this one will be created private, shows only the reach a private
// competition really has, and names the way out (make another private, or upgrade).
//
// vitest is `environment: "node"`: the stateful wizard runs through the hook harness (the JOIN between the slots it is handed, the
// visibility picked, and what the checklist receives) and the checklist renders to static markup. That the note FITS at 1280/1024/768/320
// and reads in every language is the walkthrough's (e2e/walkthrough/match-day-pb3-minors.spec.ts). Expected sentences come from the
// shipped catalogs; expected reach comes from the listing authority.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, renderIsland, walk } from "@/components/__tests__/_hook-harness";
import { DictProvider } from "@/components/i18n/dict-provider";
import { CompetitionWizard } from "../competition-wizard";
import { CompetitionReach } from "../competition-reach";
import { VisibilitySegmented } from "@/components/ui/visibility-segmented";
import { ShowcaseOptIn } from "../showcase-optin";
import { DateTimeField, type DateTimeFieldProps } from "../shared/datetime-field";
import { apiV1 } from "@/lib/client-v1";
import { t } from "@/lib/i18n-runtime";
import { routes } from "@/lib/routes";
import { competitionReach, NEW_COMPETITION_STATUS, REACH_AUDIENCES } from "@/lib/competition-listing";
import { Visibility } from "@/server/api-v1/schemas";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";
import type { Dict } from "@/lib/i18n-constants";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
}));
vi.mock("@/lib/client-v1", async () => {
  const actual = await vi.importActual<typeof import("@/lib/client-v1")>("@/lib/client-v1");
  return { ...actual, apiV1: vi.fn() };
});

const en = uiEn as unknown as Dict;
const msg = (key: string, vars?: Record<string, string | number>) => t(en, key as never, vars);
const LIMIT = 2;

const expandFields = (node: React.ReactNode): ReactElement[] =>
  walk(node).flatMap((el) =>
    el.type === DateTimeField ? [el, ...walk(DateTimeField(propsOf(el) as unknown as DateTimeFieldProps))] : [el],
  );

type Quota = { limit: number; left: number } | null;
type Upgrade = { plan: string; limit: number | null | undefined } | null;

const mount = (publicSlots: Quota, publicDashboardUpgrade: Upgrade = { plan: "Pro", limit: 10 }) =>
  renderIsland(
    CompetitionWizard,
    { orgSlug: "riverside", orgId: "org-1", publicDashboardUpgrade, publicSlots, viewerPlan: "community" as const },
    expandFields,
  );
type Island = ReturnType<typeof mount>;
const find = (island: Island, type: unknown) => island.tree().find((el) => el.type === type)!;
const pick = (island: Island, v: string) => (propsOf(find(island, VisibilitySegmented)).onChange as (v: string) => void)(v);
const reachProps = (island: Island) => propsOf(find(island, CompetitionReach));

const flat = (html: string) =>
  html.replace(/<!-- -->/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
const text = (html: string) => flat(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const rows = (html: string) =>
  [...html.matchAll(/<li[^>]*data-audience="([a-z]+)"[^>]*data-state="([a-z_]+)"/g)].map((m) => ({ audience: m[1]!, state: m[2]! }));

beforeEach(() => {
  vi.mocked(apiV1).mockReset();
  vi.mocked(apiV1).mockResolvedValue({ id: "c1", slug: "autumn-open", visibility: "private", discoverable: false } as never);
});

// ── the wiring: slots + the picked visibility decide whether the checklist is told ─────────────

describe("the wizard tells the checklist when this create will come back private", () => {
  it("every visibility x every count of slots: told exactly when the visibility is metered AND no slot is left", () => {
    let checked = 0;
    let told = 0;
    for (const visibility of Visibility.options) {
      for (const left of [null, 0, 1, LIMIT] as const) {
        const island = mount(left === null ? null : { limit: LIMIT, left });
        pick(island, visibility);
        // Rulebook, not this code: the cap meters what a stranger can open (public, link only); private is outside it.
        const want = (visibility === "public" || visibility === "unlisted") && left === 0;
        const cap = reachProps(island).cap;
        expect(Boolean(cap), `${visibility} / left ${left}`).toBe(want);
        if (want) told++;
        checked++;
      }
    }
    expect(checked).toBe(Visibility.options.length * 4);
    expect(told, "anti-vacuity: the telling branch was reached (public and link only, at 0)").toBe(2);
  });

  it("the default (Public) at 0 slots is told on first paint, and carries the plan's own limit", () => {
    const island = mount({ limit: LIMIT, left: 0 });
    expect(reachProps(island).visibility).toBe("public");
    expect(reachProps(island).cap).toMatchObject({ limit: LIMIT });
  });

  // PB3 review m5: the checklist is not the only place the form promises reach. The line under the segments ("Listed ... open to search
  // engines") and the Showcase switch are told the same thing the checklist is, from the same `cap`.
  it("m5 (a): the visibility line is told it is capped exactly when the checklist is - every visibility x every count of slots", () => {
    let checked = 0;
    let capped = 0;
    for (const visibility of Visibility.options) {
      for (const left of [null, 0, 1, LIMIT] as const) {
        const island = mount(left === null ? null : { limit: LIMIT, left });
        pick(island, visibility);
        const want = (visibility === "public" || visibility === "unlisted") && left === 0;
        expect(propsOf(find(island, VisibilitySegmented)).capped, `${visibility} / left ${left}`).toBe(want);
        if (want) capped++;
        checked++;
      }
    }
    expect(checked).toBe(Visibility.options.length * 4);
    expect(capped, "anti-vacuity: the capped branch was reached").toBe(2);
  });

  it("m5 (b): the Showcase switch gets 'private' when no slot is left (it cannot apply), the picked visibility otherwise - every cell", () => {
    let checked = 0;
    let withheld = 0;
    for (const visibility of Visibility.options) {
      for (const left of [null, 0, 1, LIMIT] as const) {
        const island = mount(left === null ? null : { limit: LIMIT, left });
        pick(island, visibility);
        const capped = (visibility === "public" || visibility === "unlisted") && left === 0;
        const props = propsOf(find(island, ShowcaseOptIn));
        expect(props.visibility, `${visibility} / left ${left}`).toBe(capped ? "private" : visibility);
        expect(props.capped, `${visibility} / left ${left}`).toBe(capped);
        if (capped) withheld++;
        checked++;
      }
    }
    expect(checked).toBe(Visibility.options.length * 4);
    expect(withheld, "anti-vacuity: the withheld branch was reached").toBe(2);
  });

  it("an org with room, or a plan with no cap, is told nothing - the checklist is today's", () => {
    expect(reachProps(mount({ limit: LIMIT, left: 1 })).cap ?? null).toBeNull();
    expect(reachProps(mount(null)).cap ?? null).toBeNull();
  });

  it("the way out names an upgrade only when the next plan really raises the limit (a Pro org at Pro's own cap has none to offer)", () => {
    // Pro hosts 10, the org is capped at 2: an upgrade is an offer.
    expect(reachProps(mount({ limit: 2, left: 0 }, { plan: "Pro", limit: 10 })).cap).toMatchObject({ canUpgrade: true });
    // Capped at Pro's own 10: "Pro hosts 10" is no offer.
    expect(reachProps(mount({ limit: 10, left: 0 }, { plan: "Pro", limit: 10 })).cap).toMatchObject({ canUpgrade: false });
    // The figure could not be read: absence suppresses, it never embellishes.
    expect(reachProps(mount({ limit: 2, left: 0 }, { plan: "Pro", limit: undefined })).cap).toMatchObject({ canUpgrade: false });
    expect(reachProps(mount({ limit: 2, left: 0 }, null)).cap).toMatchObject({ canUpgrade: false });
  });

  it("the form still ASKS for what the organiser picked: the request says public; the server is the one that degrades it", async () => {
    const island = mount({ limit: LIMIT, left: 0 });
    const name = island.tree().find((el) => el.type === "input" && propsOf(el).maxLength === 200)!;
    (propsOf(name).onChange as (e: unknown) => void)({ target: { value: "Autumn Open" } });
    const dates = island.tree().filter((el) => el.type === DateTimeField);
    (propsOf(dates[1]!).onChange as (v: string) => void)("2030-11-15");
    const form = island.tree().find((el) => el.type === "form")!;
    await (propsOf(form).onSubmit as (e: { preventDefault: () => void }) => unknown)({ preventDefault: () => {} });
    const body = (vi.mocked(apiV1).mock.calls.at(-1)?.[1] as { json: Record<string, unknown> }).json;
    expect(body.visibility).toBe("public");
  });

  it("the way out is the org's billing page", () => {
    expect(reachProps(mount({ limit: LIMIT, left: 0 })).billingHref).toBe(routes.billing("riverside"));
  });
});

// ── the checklist ────────────────────────────────────────────────────────────

describe("<CompetitionReach cap> - the checklist says it, and shows only the reach a private competition has", () => {
  const CAP = { limit: LIMIT, canUpgrade: true };
  const render = (props: Record<string, unknown>) =>
    renderToStaticMarkup(<CompetitionReach visibility="public" discoverable={false} billingHref="/o/riverside/settings/billing" {...props} />);

  it("names the situation, the limit and the way out", () => {
    const html = render({ cap: CAP });
    expect(html).toContain('data-testid="public-cap-note"');
    const words = text(html);
    expect(words).toContain(msg("comp.wizard.reach.capped.title"));
    expect(words).toContain(msg("comp.wizard.reach.capped.body", { limit: LIMIT }));
    expect(words).toContain(msg("comp.wizard.reach.capped.upgrade"));
    expect(html).toMatch(/href="\/o\/riverside\/settings\/billing"/);
  });

  it("without an upgrade to offer it still names the other way out, and has no upgrade link", () => {
    const html = render({ cap: { ...CAP, canUpgrade: false } });
    const words = text(html);
    expect(words).toContain(msg("comp.wizard.reach.capped.bodyNoUpgrade", { limit: LIMIT }));
    expect(words).not.toContain(msg("comp.wizard.reach.capped.upgrade"));
    expect(html).not.toContain("settings/billing");
  });

  it("the rows are what a PRIVATE competition reaches, whatever Public / Showcase says: the team only", () => {
    let seen = 0;
    for (const discoverable of [false, true]) {
      for (const visibility of ["public", "unlisted"]) {
        const got = rows(render({ cap: CAP, visibility, discoverable }));
        const want = competitionReach({ visibility: "private", status: NEW_COMPETITION_STATUS, discoverable: false });
        expect(got.map((r) => r.audience)).toEqual([...REACH_AUDIENCES]);
        for (const r of got) {
          expect(r.state, `${visibility}/${discoverable} ${r.audience}`).toBe(want[r.audience as keyof typeof want]);
          seen++;
        }
      }
    }
    expect(seen).toBe(4 * REACH_AUDIENCES.length);
    // The positive pair, so "only the team" is not just what an empty list says: the team row is a yes.
    expect(rows(render({ cap: CAP })).find((r) => r.audience === "team")!.state).toBe("yes");
    expect(rows(render({ cap: CAP })).filter((r) => r.state === "yes")).toHaveLength(1);
  });

  it("with no cap there is no note and the rows are the picked visibility's (today's checklist, byte for byte)", () => {
    const withCap = render({ cap: null });
    expect(withCap).not.toContain("public-cap-note");
    expect(withCap).toBe(renderToStaticMarkup(<CompetitionReach visibility="public" discoverable={false} />));
    const publicRows = rows(withCap);
    const want = competitionReach({ visibility: "public", status: NEW_COMPETITION_STATUS, discoverable: false });
    expect(publicRows.find((r) => r.audience === "org")!.state).toBe(want.org);
    expect(want.org, "premise: public really does reach more than the team").not.toBe("no");
  });

  it("the note is announced politely (a status), and its link is a 44px tap target", () => {
    const html = render({ cap: CAP });
    expect(html).toMatch(/data-testid="public-cap-note"[^>]*role="status"|role="status"[^>]*data-testid="public-cap-note"/);
    const link = /<a[^>]*href="\/o\/riverside\/settings\/billing"[^>]*>/.exec(html)![0];
    expect(link).toMatch(/min-h-11/);
  });
});

// ── the two other promises: the visibility line and the Showcase switch ───────────────────────────────────

describe("PB3 m5: the visibility line and the Showcase switch stop promising reach the create will not have", () => {
  const renderIn = (node: React.ReactNode, d: Dict = en, locale: "en" = "en") =>
    renderToStaticMarkup(
      <DictProvider dict={d} locale={locale}>
        {node}
      </DictProvider>,
    );

  // The switch's own tag (its class list says "disabled:..." for every state, so only the attribute counts).
  const switchTag = (html: string) => html.match(/<input[^>]*role="switch"[^>]*>/)?.[0] ?? "";
  const isDisabled = (tag: string) => {
    expect(tag, "the switch rendered").not.toBe("");
    return / disabled=""/.test(tag);
  };

  it("capped: Public and Link only say it is created private, and neither promises the listing, the link or search engines", () => {
    let checked = 0;
    for (const value of ["public", "unlisted"]) {
      const capped = text(renderIn(<VisibilitySegmented value={value} onChange={() => {}} capped />));
      const open = text(renderIn(<VisibilitySegmented value={value} onChange={() => {}} capped={false} />));
      expect(capped, value).toContain(msg("visibility.capped.consequence"));
      expect(capped, `${value}: the old promise is gone`).not.toContain(msg(`visibility.${value}.consequence`));
      // The positive pair: uncapped it still carries the promise, so the line really switched.
      expect(open, value).toContain(msg(`visibility.${value}.consequence`));
      expect(open).not.toContain(msg("visibility.capped.consequence"));
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("capped: the Showcase switch is off, and its reason is the cap - not 'set visibility to public' under a Public that is selected", () => {
    const capped = renderIn(<ShowcaseOptIn visibility="private" checked={false} onChange={() => {}} capped />);
    expect(isDisabled(switchTag(capped)), "the switch itself is disabled").toBe(true);
    const words = text(capped);
    expect(words).toContain(msg("comp.wizard.showcase.capped"));
    expect(words).not.toContain(msg("showcase.needsPublic"));
    // The positive pair: not capped and not public keeps the old reason; public and not capped has no reason at all.
    const needs = text(renderIn(<ShowcaseOptIn visibility="private" checked={false} onChange={() => {}} capped={false} />));
    expect(needs).toContain(msg("showcase.needsPublic"));
    expect(needs).not.toContain(msg("comp.wizard.showcase.capped"));
    const open = renderIn(<ShowcaseOptIn visibility="public" checked={false} onChange={() => {}} capped={false} />);
    expect(isDisabled(switchTag(open)), "a free public slot: the switch is live").toBe(false);
    expect(text(open)).not.toContain(msg("comp.wizard.showcase.capped"));
  });
});

// ── the words, in every language ─────────────────────────────────────────────

describe("the cap note reads in all four languages", () => {
  const dicts = { en: uiEn, es: uiEs, fr: uiFr, nl: uiNl } as unknown as Record<string, Record<string, string>>;
  const KEYS = [...["title", "body", "bodyNoUpgrade", "upgrade"].map((k) => `comp.wizard.reach.capped.${k}`), "visibility.capped.consequence", "comp.wizard.showcase.capped"];

  it("every key exists in every locale, is translated, and the sentences that carry the limit keep {limit}", () => {
    let checked = 0;
    for (const [locale, d] of Object.entries(dicts)) {
      for (const key of KEYS) {
        expect(d[key], `${locale} ${key}`).toBeTruthy();
        if (locale !== "en") expect(d[key], `${locale} ${key} is still English`).not.toBe(dicts.en![key]);
        checked++;
      }
      expect(d["comp.wizard.reach.capped.body"], locale).toContain("{limit}");
      expect(d["comp.wizard.reach.capped.bodyNoUpgrade"], locale).toContain("{limit}");
    }
    expect(checked).toBe(4 * KEYS.length);
  });

  // PB3 review I1. The owner ruled "team" out of the checklist (C8, 2026-11-02: it reads as a playing team in a sports app) and the row
  // under this note says "Members of your organisation on Seazn". The note must name that same audience, in that row's own words, in
  // every locale - and the other two new sentences must not bring "team" back either.
  it("I1: the note names the audience as the row under it does (the members of the organisation), and no capped sentence says 'team'", () => {
    const BAN = /(?<![\p{L}])(team|teams|équipe|équipes|equipo|equipos)(?![\p{L}])/iu;
    let checked = 0;
    for (const [locale, d] of Object.entries(dicts)) {
      const row = d["comp.wizard.reach.team"]!.toLowerCase();
      expect(row, `${locale}: the row exists`).toBeTruthy();
      for (const key of ["comp.wizard.reach.capped.body", "comp.wizard.reach.capped.bodyNoUpgrade"]) {
        expect(d[key]!.toLowerCase(), `${locale} ${key} names the row's audience: "${row}"`).toContain(row);
        checked++;
      }
      for (const key of [...KEYS]) {
        expect(BAN.test(d[key]!), `${locale} ${key} says "team": ${d[key]}`).toBe(false);
        checked++;
      }
    }
    expect(checked).toBe(4 * (2 + KEYS.length));
    // The guard can fail: the banned words really match the words the owner ruled out, in each locale.
    for (const w of ["only your team", "solo tu equipo", "seule votre équipe", "alleen je team"]) expect(BAN.test(w), w).toBe(true);
  });

  it("the note renders in each locale's own words (and the limit is interpolated, never left as {limit})", () => {
    for (const [locale, d] of Object.entries(dicts)) {
      const html = renderToStaticMarkup(
        <DictProvider dict={d as unknown as Dict} locale={locale as "en"}>
          <CompetitionReach visibility="public" discoverable={false} billingHref="/b" cap={{ limit: LIMIT, canUpgrade: true }} />
        </DictProvider>,
      );
      const words = text(html);
      expect(words, locale).toContain(d["comp.wizard.reach.capped.title"]!);
      expect(words, locale).toContain(d["comp.wizard.reach.capped.body"]!.replace("{limit}", String(LIMIT)));
      expect(words, locale).not.toContain("{limit}");
    }
  });
});
