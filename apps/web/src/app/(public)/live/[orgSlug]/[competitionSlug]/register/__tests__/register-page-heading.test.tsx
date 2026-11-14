// Registration redesign B2 T7 (spec §7.1 + FP10) — the open register page's heading. The H1 is the COMPETITION's name (it used to
// be the word "Register", which told a person nothing about where they were); the breadcrumb stays. A closing line sits under it
// ONLY when every open division closes at the same instant, because closing time lives on the division (`registration_settings`),
// not on the competition — otherwise each card carries its own. Same renderToStaticMarkup pattern as register-page-live.test.tsx
// (no jsdom here); the divisions the mocked usecase returns are a hoisted variable so one file can try every shape.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => "en" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));

const registrations = vi.hoisted(() => ({ divisions: [] as Record<string, unknown>[] }));
vi.mock("@/server/usecases/registrations", () => ({
  publicRegistrationInfo: async () => ({
    competition: { id: "comp-1", name: "Summer Smash Open", slug: "summer-smash", starts_on: "2026-09-15", ends_on: null },
    org: { name: "Riverside CC", slug: "riverside", logo_url: null },
    divisions: registrations.divisions,
  }),
}));

import RegisterPage from "../page";

const division = (id: string, over: Record<string, unknown> = {}) => ({
  division_id: id,
  name: `Division ${id}`,
  slug: id,
  sport_key: "generic",
  entrant_kind: "individual",
  fee_cents: 0,
  currency: "gbp",
  payment_method: "offline",
  opens_at: null,
  closes_at: null,
  capacity: null,
  remaining: null,
  taken: 0,
  open: true,
  closed_reason: null,
  category: null,
  age_min: null,
  age_max: null,
  allow_free_agents: false,
  requires_dob: false,
  requires_gender: false,
  youth: false,
  waitlisted: 0,
  form_fields: [],
  ...over,
});

const render = async (): Promise<string> =>
  renderToStaticMarkup(
    await RegisterPage({
      params: Promise.resolve({ orgSlug: "riverside", competitionSlug: "summer-smash" }),
      searchParams: Promise.resolve({}),
    }),
  );

const NOV = "2026-11-30T23:59:00.000Z";
const DEC = "2026-12-14T23:59:00.000Z";
const CLOSES = /Registration closes [^<]*/;

beforeEach(() => {
  registrations.divisions = [];
});

describe("register page heading — the competition's name", () => {
  it("the H1 is the competition name, and no longer the word 'Register'", async () => {
    registrations.divisions = [division("a"), division("b")];
    const html = await render();
    expect(html).toMatch(/<h1[^>]*>Summer Smash Open<\/h1>/);
    expect(html).not.toMatch(/<h1[^>]*>Register<\/h1>/);
  });

  it("the breadcrumb stays: the competition links back to its hub, then '/ Register'", async () => {
    registrations.divisions = [division("a"), division("b")];
    const html = await render();
    const crumb = html.slice(0, html.indexOf("<h1"));
    expect(crumb).toContain("/live/riverside/summer-smash");
    expect(crumb).toContain("Summer Smash Open");
    expect(crumb).toMatch(/\/ Register/);
  });

  it("there is exactly one H1", async () => {
    registrations.divisions = [division("a")];
    expect((await render()).match(/<h1\b/g)).toHaveLength(1);
  });
});

describe("register page heading — the closing line (spec FP10)", () => {
  it("empty case: open divisions with no closing time say nothing", async () => {
    registrations.divisions = [division("a"), division("b")];
    expect(await render()).not.toMatch(CLOSES);
  });

  it("every open division closes at the same instant: one line, under the H1, naming it (UTC on the server pass)", async () => {
    registrations.divisions = [division("a", { closes_at: NOV }), division("b", { closes_at: NOV })];
    const html = await render();
    expect(html).toContain("Registration closes 30 Nov, UTC");
    expect(html.indexOf("Registration closes")).toBeGreaterThan(html.indexOf("</h1>"));
    expect(html.match(/Registration closes/g)).toHaveLength(1);
  });

  it("a single open division with a closing time: the same line", async () => {
    registrations.divisions = [division("a", { closes_at: DEC })];
    expect(await render()).toContain("Registration closes 14 Dec, UTC");
  });

  it("open divisions that close at different times: no line (each card carries its own)", async () => {
    registrations.divisions = [division("a", { closes_at: NOV }), division("b", { closes_at: DEC })];
    expect(await render()).not.toMatch(CLOSES);
  });

  it("one open division with a closing time and one without: no line (the second never closes)", async () => {
    registrations.divisions = [division("a", { closes_at: NOV }), division("b")];
    expect(await render()).not.toMatch(CLOSES);
  });

  it("a CLOSED division's time does not count — the open ones agree, so the line is shown", async () => {
    registrations.divisions = [
      division("a", { closes_at: NOV }),
      division("b", { closes_at: NOV }),
      division("c", { closes_at: DEC, open: false, closed_reason: "window" }),
    ];
    const html = await render();
    expect(html).toContain("Registration closes 30 Nov, UTC");
    expect(html).not.toContain("14 Dec");
  });
});
