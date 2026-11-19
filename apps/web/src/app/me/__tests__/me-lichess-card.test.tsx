// T16 (T20 review m1, reworked 2026-11-18) — `/me` mounts the shipped Lichess card with what `myLichessLink` read for
// THIS login (me-lichess-link.test.ts drives that reader against the database). The card shows to EVERY signed-in
// player — linking is the player's own, not a club's — so there is no "no card" state: unlinked, linked, and linked
// with a grant that cannot play each render the REAL card, whose link starts at no club and lands back on `/me`
// (where the flash renders — me-lichess-flash.test.tsx). The reader is doubled at its boundary; the card is not.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  // The REAL Lichess card is rendered (a client island; its unlink refreshes).
  useRouter: () => ({ refresh: () => undefined }),
}));
const card = vi.hoisted(() => ({ myLichessLink: vi.fn() }));
vi.mock("@/server/usecases/me-lichess", () => card);
vi.mock("@/lib/auth", () => ({
  getCurrentUser: loaders.getCurrentUser,
  // /me reads the session (T6 review m3: a staff impersonation sees quick matches without their links).
  getCurrentSession: async () => {
    const user = await loaders.getCurrentUser();
    return user ? { user, impersonated: false } : null;
  },
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
// /me lists the saved quick matches (quick match plan 3 T6); none here.
vi.mock("@/server/usecases/quick-match-home", () => ({ listMyQuickMatches: async () => [] }));
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
import { lichessLinkStartHref } from "@/lib/lichess-link";

const EN = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "dictionaries", "en", "ui.json"), "utf8")) as Record<string, string>;
const escaped = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
/** An attribute value as React serialises it (`&` escaped). */
const attr = (v: string) => v.replace(/&/g, "&amp;");

async function render(): Promise<string> {
  const element = await MePage({ searchParams: Promise.resolve({}) });
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
  card.myLichessLink.mockReset();
  // A Lichess client id is configured (lib/oauth.ts `lichessConfigured`); the unconfigured case is its own test.
  vi.stubEnv("LICHESS_CLIENT_ID", "seazn-test");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/me: the Lichess card (shown to every signed-in player)", () => {
  /** The start the card builds, typed from the start route's contract (a same-origin next, no club) and agreeing with the helper. */
  const OWN_START = "/api/auth/lichess?next=%2Fme";

  it("the empty case first: a player with no club, no entry and no link still gets the card, with a Link that names no club", async () => {
    card.myLichessLink.mockResolvedValue({ linkedUsername: null, needsReconsent: false });
    const html = await render();
    // Anti-vacuity: the page rendered, so the card's presence is the rule's doing.
    expect(html).toContain(escaped(EN["me.title"]!));
    expect(html).toContain('data-testid="lichess-link-card"');
    expect(card.myLichessLink).toHaveBeenCalledWith("u1");
    expect(OWN_START).toBe(lichessLinkStartHref(null, "/me"));
    const link = html.match(/<a[^>]*data-testid="lichess-link"[^>]*>/)?.[0] ?? "";
    expect(link, "the Link anchor").not.toBe("");
    expect(link).toContain(`href="${attr(OWN_START)}"`);
    expect(link, "no club in the start").not.toContain("org=");
    expect(html).toContain(escaped(EN["settings.account.lichess.link"]!));
  });

  it("linked with a grant that cannot play: says so and offers a re-link (no club); unlink stays", async () => {
    card.myLichessLink.mockResolvedValue({ linkedUsername: "magnus", needsReconsent: true });
    const html = await render();
    expect(html).toContain(escaped(EN["settings.account.lichess.reconsentRequired"]!));
    const relink = html.match(/<a[^>]*data-testid="lichess-relink"[^>]*>/)?.[0] ?? "";
    expect(relink, "the re-link anchor").not.toBe("");
    expect(relink).toContain(`href="${attr(OWN_START)}"`);
    expect(html).toContain(escaped(EN["settings.account.lichess.consent.cta"]!));
    expect(html).toContain('data-testid="lichess-unlink"');
  });

  it("no Lichess client configured on this server: the card says so and offers no link", async () => {
    vi.stubEnv("LICHESS_CLIENT_ID", "");
    card.myLichessLink.mockResolvedValue({ linkedUsername: null, needsReconsent: false });
    const html = await render();
    expect(html).toContain('data-testid="lichess-link-card"');
    expect(html).toContain('data-testid="lichess-not-configured"');
    expect(html).not.toContain('data-testid="lichess-link"');
  });

  it("linked, grant fine: the linked name and unlink, no link and no re-link", async () => {
    card.myLichessLink.mockResolvedValue({ linkedUsername: "magnus", needsReconsent: false });
    const html = await render();
    expect(html).toContain('data-testid="lichess-linked-username"');
    expect(html).toContain('data-testid="lichess-unlink"');
    expect(html).not.toContain('data-testid="lichess-link"');
    expect(html).not.toContain('data-testid="lichess-relink"');
    expect(html).not.toContain(escaped(EN["settings.account.lichess.reconsentRequired"]!));
  });

  // M5 (T16 fix round 1, canvas MePhone): every control is a 44px target, and the re-link block discloses what the
  // grant allows — the canvas's three lines, the account tab's own consent copy (the room's re-link card reads it too).
  it("M5: link, re-link and unlink are 44px targets; the re-link block discloses the grant, and only it does", async () => {
    const control = (html: string, id: string) => html.match(new RegExp(`<(?:a|button)[^>]*data-testid="${id}"[^>]*>`))?.[0] ?? "";
    card.myLichessLink.mockResolvedValue({ linkedUsername: "magnus", needsReconsent: true });
    const relinkHtml = await render();
    card.myLichessLink.mockResolvedValue({ linkedUsername: null, needsReconsent: false });
    const linkHtml = await render();
    let checked = 0;
    for (const [html, id] of [[relinkHtml, "lichess-relink"], [relinkHtml, "lichess-unlink"], [linkHtml, "lichess-link"]] as const) {
      const tag = control(html, id);
      expect(tag, `${id}: rendered`).not.toBe("");
      expect(tag, `${id}: 44px`).toMatch(/class="[^"]*\bmin-h-11\b/);
      checked += 1;
    }
    expect(checked).toBe(3);
    const scope = relinkHtml.match(/<div[^>]*data-testid="lichess-scope"[^>]*>([^]*?)<\/div>/)?.[1] ?? "";
    for (const k of ["settings.account.lichess.consent.title", "settings.account.lichess.consent.body", "settings.account.lichess.consent.scopes"]) {
      expect(scope, k).toContain(escaped(EN[k]!));
    }
    expect(linkHtml, "the plain link state (canvas: no disclosure)").not.toContain('data-testid="lichess-scope"');
  });
});
