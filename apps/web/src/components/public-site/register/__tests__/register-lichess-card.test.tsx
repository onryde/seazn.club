// T16 fix round 1, I5 — the Lichess link, offered on the CONSENT step (canvas RegisterLichessPhone), before signup,
// instead of only after a LICHESS_LINK_REQUIRED submit failure. Its start returns to this registration (a same-origin
// relative path the start route re-validates), and the draft survives in sessionStorage, so the player comes straight
// back to this step with their answers.
//
// Node render (no DOM in apps/web vitest); copy from each locale's own dictionary through the real translator.
// Single-sport by construction: only a boardgame division plays online.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { plural as pluralRuntime, t as tRuntime } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import { lichessLinkStartHref } from "@/lib/lichess-link";
// The start route's own origin check (lib/auth.ts), the real one: the path this card hands it must survive it.
import { safeNextPath } from "@/lib/auth";

const LOCALES = ["en", "es", "fr", "nl"] as const;
type Loc = (typeof LOCALES)[number];
const DICTS = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "..", "dictionaries", l, "ui.json"), "utf8")) as Dict]),
) as Record<Loc, Dict>;
const current = vi.hoisted(() => ({ locale: "en" as string }));
vi.mock("@/components/i18n/dict-provider", () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) => tRuntime(DICTS[current.locale as Loc], key, vars),
  usePlural: () => (key: string, n: number, vars?: Record<string, string | number>) =>
    pluralRuntime(DICTS[current.locale as Loc], key, n, current.locale as Loc, vars),
  useLocaleOrDefault: () => current.locale,
}));

import { RegisterLichessCard, onlineDivisionNames, registerReturnPath, type RegisterLichessState } from "../register-lichess-card";
import { StepConsent } from "../step-consent";
import { EMPTY_CART } from "../types";

const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("'", "&#x27;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const s = (loc: Loc, key: string) => String(DICTS[loc][key]);
const UNLINKED: RegisterLichessState = { configured: true, linkedUsername: null, flash: null };
const NEXT = "/shared/northfield/autumn-rapid/register";
const render = (o: Partial<Parameters<typeof RegisterLichessCard>[0]> = {}, locale: Loc = "en") => {
  current.locale = locale;
  return renderToStaticMarkup(
    <RegisterLichessCard divisions={["Open Swiss"]} orgSlug="northfield" next={NEXT} state={UNLINKED} {...o} />,
  );
};

describe("registerReturnPath — where the link start comes back to", () => {
  it("this competition's registration, the join code kept; always a same-origin relative path", () => {
    expect(registerReturnPath("northfield", "autumn-rapid", null)).toBe(NEXT);
    expect(registerReturnPath("northfield", "autumn-rapid", "AB12")).toBe(`${NEXT}?join=AB12`);
    // Encoded, so a code (or slug) holding a separator stays one value: the start's own `next` is not split.
    expect(registerReturnPath("north field", "autumn/rapid", "x&next=y")).toBe("/shared/north%20field/autumn%2Frapid/register?join=x%26next%3Dy");
    // Whatever a slug or code holds, the path stays ours: each part is encoded, so nothing escapes the origin.
    let checked = 0;
    for (const [org, comp, join] of [
      ["//evil.example", "x", null],
      ["a", "b/../../evil", "x&next=//evil"],
      ["\\evil.example", "c", "%2F%2Fevil"],
      ["https://evil.example", "d", null],
    ] as const) {
      const p = registerReturnPath(org, comp, join);
      expect(safeNextPath(p), p).toBe(p);
      expect(new URL(p, "https://seazn.club").origin, p).toBe("https://seazn.club");
      checked += 1;
    }
    expect(checked).toBe(4);
  });
});

describe("onlineDivisionNames — which selected divisions the link is for", () => {
  const D = (division_id: string, name: string, online_play?: boolean) => ({ division_id, name, ...(online_play === undefined ? {} : { online_play }) });
  const DIVS = [D("d1", "Open Swiss", true), D("d2", "Blitz Night (over the board)", false), D("d3", "Junior Cup", true), D("d4", "Old wire")];
  const cart = (...ids: string[]) => ({ entries: ids.map((division_id) => ({ division_id })) });
  it("the empty case first: nothing selected, or nothing online selected — none", () => {
    expect(onlineDivisionNames(cart(), DIVS)).toEqual([]);
    expect(onlineDivisionNames(cart("d2", "d4"), DIVS)).toEqual([]);
  });
  it("the online ones, in the cart's order, each once (two entries in one division name it once)", () => {
    expect(onlineDivisionNames(cart("d3", "d2", "d1", "d3"), DIVS)).toEqual(["Junior Cup", "Open Swiss"]);
  });
  it("a cart entry naming no known division is skipped, never shown as an id", () => {
    expect(onlineDivisionNames(cart("gone", "d1"), DIVS)).toEqual(["Open Swiss"]);
  });
});

describe("RegisterLichessCard — the consent step's Lichess link (I5, canvas RegisterLichessPhone)", () => {
  it("unlinked: the title, Required, the division, what the grant allows, a 44px start back to this step, the hint", () => {
    let checked = 0;
    for (const loc of LOCALES) {
      const h = render({}, loc);
      expect(h, loc).toContain('data-testid="register-lichess-card"');
      expect(h, loc).toContain(esc(s(loc, "register.lichess.title")));
      expect(h, loc).toContain(esc(s(loc, "register.lichess.required")));
      expect(h, loc).toContain(esc(s(loc, "register.lichess.lead.one").replace("{divisions}", "Open Swiss")));
      for (const k of ["settings.account.lichess.consent.title", "settings.account.lichess.consent.body", "settings.account.lichess.consent.scopes", "register.lichess.returnHint"]) {
        expect(h, `${loc}: ${k}`).toContain(esc(s(loc, k)));
      }
      const a = h.match(/<a[^>]*data-testid="register-lichess-start"[^>]*>([^<]*)</);
      expect(a, `${loc}: the start`).not.toBeNull();
      expect(a![0]).toContain(`href="${lichessLinkStartHref("northfield", NEXT).replaceAll("&", "&amp;")}"`);
      expect(a![0]).toMatch(/class="[^"]*\bmin-h-11\b/);
      expect(a![1]).toBe(esc(s(loc, "settings.account.lichess.link")));
      expect(h, `${loc}: no linked row`).not.toContain('data-testid="register-lichess-linked"');
      checked += 1;
    }
    expect(checked).toBe(LOCALES.length);
  });

  it("two divisions read as a list, in the plural", () => {
    const h = render({ divisions: ["Open Swiss", "Junior Cup"] });
    expect(h).toContain(esc(s("en", "register.lichess.lead.other").replace("{divisions}", "Open Swiss and Junior Cup")));
  });

  it("linked: the name it is linked as, and no start (nothing to do)", () => {
    const h = render({ state: { configured: true, linkedUsername: "ada_okonkwo", flash: "linked" } });
    expect(h).toMatch(/data-testid="register-lichess-linked"[^>]*role="status"|role="status"[^>]*data-testid="register-lichess-linked"/);
    expect(h).toContain("ada_okonkwo");
    expect(h).not.toContain('data-testid="register-lichess-start"');
    expect(h).not.toContain('data-testid="register-lichess-flash"');
  });

  it("a failed link on the way back says why, and offers the start again; an unknown flash says nothing", () => {
    const h = render({ state: { ...UNLINKED, flash: "token" } });
    expect(h).toMatch(/data-testid="register-lichess-flash"[^>]*>[^<]*/);
    expect(h).toContain(esc(s("en", "settings.account.lichess.flash.token")));
    expect(h).toContain('data-testid="register-lichess-start"');
    // `linked` with no linked account on file (a stale URL) is not a success to announce.
    expect(render({ state: { ...UNLINKED, flash: "linked" } })).not.toContain('data-testid="register-lichess-flash"');
  });

  it("no Lichess client on this server: says so, and starts nothing", () => {
    const h = render({ state: { ...UNLINKED, configured: false } });
    expect(h).toContain(esc(s("en", "settings.account.lichess.notConfigured")));
    expect(h).not.toContain("/api/auth/lichess");
  });
});

describe("StepConsent mounts it only when a selected division plays online", () => {
  const consent = (lichess: Parameters<typeof StepConsent>[0]["lichess"]) => {
    current.locale = "en";
    return renderToStaticMarkup(
      <StepConsent
        contact={{ name: "", email: "", phone: null, dob: null, gender: null, guardian_name: null, guardian_consent: false } as never}
        onContactChange={() => undefined}
        consent={{ privacy_consent: false, media_consent: false } as never}
        onConsentChange={() => undefined}
        cart={EMPTY_CART}
        orgName="Northfield Chess Club"
        errors={{}}
        lichess={lichess}
      />,
    );
  };
  it("the empty case first: none (null) — no card; the consent itself still renders", () => {
    const h = consent(null);
    expect(h).not.toContain('data-testid="register-lichess-card"');
    expect(h).toContain('data-testid="reg-consent-grant"');
  });
  it("one — the card, above the consent", () => {
    const h = consent({ divisions: ["Open Swiss"], orgSlug: "northfield", next: NEXT, state: UNLINKED });
    expect(h.indexOf('data-testid="register-lichess-card"')).toBeGreaterThan(-1);
    expect(h.indexOf('data-testid="register-lichess-card"')).toBeLessThan(h.indexOf('data-testid="reg-consent-grant"'));
  });
});
