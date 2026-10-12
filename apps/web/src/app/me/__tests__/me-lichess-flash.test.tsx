// T20 fix round 1, m5 — `/me` is where a Lichess linking flow lands when it started with no `next` (the registration
// stepper's link carries none): the start route's refusal (`?lichess=unavailable`) and every callback outcome. The
// player home says what happened, in the reader's language — the sentence read from each locale's own dictionary.
//
// Drives the REAL page (an async server component, so `prerender`) with its loaders doubled to an empty player: no
// fixtures, no clubs, no officiating. Islands are stubbed to markers; the flash itself is server-rendered copy.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prerender } from "react-dom/static";
import type { ReactNode } from "react";

const loaders = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getUserOrgs: vi.fn(),
  getActiveOrgId: vi.fn(),
  resolveLocale: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirected to ${to}`);
  },
}));
vi.mock("@/lib/auth", () => ({
  getCurrentUser: loaders.getCurrentUser,
  getUserOrgs: loaders.getUserOrgs,
  getActiveOrgId: loaders.getActiveOrgId,
}));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: loaders.resolveLocale }));
vi.mock("@/server/usecases/me", () => ({
  listMyFixtures: async () => ({ upcoming: [], results: [], teams: [] }),
  listMyPersons: async () => [],
  listMyPlayerStats: async () => [],
  listMyCareerStats: async () => [],
  getMySuspensions: async () => [],
}));
vi.mock("@/server/usecases/me-officiating", () => ({
  getMyOfficiating: async () => ({ is_official: false, assignments: [], completed: [], blackouts: [] }),
  listPendingOfficiatingClaims: async () => [],
}));
vi.mock("@/server/usecases/official-marks", () => ({ myMarksAverage: async () => null }));
vi.mock("@/server/usecases/me-lichess", () => ({
  myLichessLink: async () => ({ show: false, linkedUsername: null, needsReconsent: false, orgSlug: null }),
}));
vi.mock("@/components/me/rsvp-control", () => ({ RsvpControl: () => <div /> }));
vi.mock("@/components/me/officiating-lane", () => ({ OfficiatingLane: () => <div /> }));
vi.mock("@/components/me/suspensions-lane", () => ({ SuspensionsLane: () => <div /> }));
vi.mock("@/components/me/consent-card", () => ({ ConsentCard: () => <div /> }));
vi.mock("@/components/logout-button", () => ({ LogoutButton: () => <div /> }));
vi.mock("@/components/run-your-own-cta", () => ({ RunYourOwnCta: () => <div data-testid="run-your-own" /> }));
vi.mock("@/components/client-time", () => ({
  Zoned: () => <span />,
  ViewerTzProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import MePage from "../page";

const LOCALES = ["en", "es", "fr", "nl"] as const;
const DICTS = Object.fromEntries(
  LOCALES.map((l) => [
    l,
    JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "dictionaries", l, "ui.json"), "utf8")) as Record<string, string>,
  ]),
) as Record<(typeof LOCALES)[number], Record<string, string>>;
/** React's text escaping, so a sentence with an apostrophe is compared as the markup carries it. */
const escaped = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

async function render(query: { lichess?: string; claimed?: string }): Promise<string> {
  const element = await MePage({ searchParams: Promise.resolve(query) });
  const { prelude } = await prerender(element);
  const reader = (prelude as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let html = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    html += decoder.decode(value, { stream: true });
  }
  return html;
}

beforeEach(() => {
  loaders.getCurrentUser.mockResolvedValue({ id: "u1", display_name: "Pat Player", email: "pat@example.com", timezone: "UTC" });
  loaders.getUserOrgs.mockResolvedValue([]);
  loaders.getActiveOrgId.mockResolvedValue(null);
  loaders.resolveLocale.mockResolvedValue("en");
});

describe("/me: where a Lichess linking flow with no `next` lands", () => {
  it("?lichess=unavailable — the start refused for the club — renders that locale's sentence, as an error", async () => {
    let checked = 0;
    for (const loc of LOCALES) {
      loaders.resolveLocale.mockResolvedValue(loc);
      const sentence = DICTS[loc]["settings.account.lichess.flash.unavailable"];
      expect(typeof sentence === "string" && sentence.length > 0, `${loc}: the key exists`).toBe(true);
      const html = await render({ lichess: "unavailable" });
      // Anti-vacuity: the page itself rendered (its title), so a missing flash is the page's doing.
      expect(html, loc).toContain(escaped(DICTS[loc]["me.title"] ?? DICTS.en["me.title"]!));
      expect(html, loc).toMatch(/data-testid="me-lichess-flash"[^>]*data-tone="error"|data-tone="error"[^>]*data-testid="me-lichess-flash"/);
      expect(html, loc).toContain(escaped(sentence!));
      checked++;
    }
    expect(checked).toBe(LOCALES.length);
    expect(new Set(LOCALES.map((l) => DICTS[l]["settings.account.lichess.flash.unavailable"])).size).toBe(LOCALES.length);
  });

  it("?lichess=linked — the callback's success — renders the linked sentence as a success", async () => {
    const html = await render({ lichess: "linked" });
    expect(html).toMatch(/data-testid="me-lichess-flash"[^>]*data-tone="ok"|data-tone="ok"[^>]*data-testid="me-lichess-flash"/);
    expect(html).toContain(escaped(DICTS.en["settings.account.lichess.flash.linked"]!));
  });

  it("no ?lichess, or a value that is not one of the flow's outcomes: no flash", async () => {
    let checked = 0;
    for (const query of [{}, { lichess: "pwned<script>" }, { lichess: "" }]) {
      const html = await render(query);
      expect(html, JSON.stringify(query)).toContain(escaped(DICTS.en["me.title"]!));
      expect(html, JSON.stringify(query)).not.toContain('data-testid="me-lichess-flash"');
      checked++;
    }
    expect(checked).toBe(3);
  });
});
