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
import { BANNED_RE } from "@/components/v2/arbiter/__tests__/_banned-copy";
import { EMPTY_CART } from "../types";

const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("'", "&#x27;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const s = (loc: Loc, key: string) => String(DICTS[loc][key]);
const UNLINKED: RegisterLichessState = { configured: true, linkedUsername: null, needsReconsent: false, flash: null };
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
    const h = render({ state: { configured: true, linkedUsername: "ada_okonkwo", needsReconsent: false, flash: "linked" } });
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

  // Owner staging test 2026-10-19 (the match room looped on this silently). The registration card was not silent - it
  // said the sentence - but for already_linked a sentence is not enough: that Lichess account belongs to ANOTHER Seazn
  // account, so retrying the link can never work. It says what to do, from the same component the room uses.
  it("already_linked says the sentence AND the next step, in every locale, and the start is still offered (link a different account here)", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      const h = render({ state: { ...UNLINKED, flash: "already_linked" } }, locale);
      expect(h, `${locale}: sentence`).toContain(esc(s(locale, "settings.account.lichess.flash.already_linked")));
      expect(h, `${locale}: next step`).toContain(esc(s(locale, "settings.account.lichess.flashNext.already_linked")));
      expect(h, `${locale}: the host's own test id`).toContain('data-testid="register-lichess-flash"');
      expect(h, `${locale}: next step id`).toContain('data-testid="register-lichess-flash-next"');
      expect(h, `${locale}: still starts a link`).toContain('data-testid="register-lichess-start"');
      expect(h, `${locale}: alert`).toContain('role="alert"');
      checked++;
    }
    expect(checked).toBe(4);
    // The pair: every other failure keeps the sentence alone - no next step.
    for (const code of ["oauth_state", "token", "account", "not_configured", "unavailable", "key_unavailable"] as const) {
      const h = render({ state: { ...UNLINKED, flash: code } });
      expect(h, code).toContain(esc(s("en", `settings.account.lichess.flash.${code}`)));
      expect(h, `${code}: no next step`).not.toContain("register-lichess-flash-next");
    }
  });

  it("an already-linked viewer sees the linked row and neither the flash nor the next step", () => {
    const h = render({ state: { ...UNLINKED, linkedUsername: "ada_plays", flash: "already_linked" } });
    expect(h).toContain('data-testid="register-lichess-linked"');
    expect(h).not.toContain("register-lichess-flash");
  });

  it("no Lichess client on this server: says so, and starts nothing", () => {
    const h = render({ state: { ...UNLINKED, configured: false } });
    expect(h).toContain(esc(s("en", "settings.account.lichess.notConfigured")));
    expect(h).not.toContain("/api/auth/lichess");
  });
});

// Owner ruling 2026-10-25: registration refuses a Lichess link the seat gate refuses (the server says
// LICHESS_RECONSENT_REQUIRED), so a viewer whose link cannot play must be told to RECONNECT on this step - not shown
// a "Linked as ..." tick that the submit then contradicts. `needsReconsent` is the page's `!lichessGrantPlays(link)`.
describe("RegisterLichessCard - linked, but the link cannot play (reconnect)", () => {
  const RECONNECT: RegisterLichessState = { configured: true, linkedUsername: "ada_idonly", needsReconsent: true, flash: null };
  const NEW_KEYS = [
    "register.lichess.reconnect.title",
    "register.lichess.reconnect.lead.one",
    "register.lichess.reconnect.lead.other",
    "register.lichess.reconnect.cta",
    "register.lichessReconnectRequired",
  ] as const;

  it("the new copy exists in all four dictionaries, is translated (not the English), and carries no dash or arrow", () => {
    let checked = 0;
    for (const loc of LOCALES) {
      for (const k of NEW_KEYS) {
        const v = DICTS[loc][k];
        expect(typeof v, `${loc}: ${k}`).toBe("string");
        expect(String(v).length, `${loc}: ${k} is not empty`).toBeGreaterThan(10);
        if (loc !== "en") expect(v, `${loc}: ${k} is translated`).not.toBe(DICTS.en[k]);
        expect(String(v), `${loc}: ${k} has no banned character`).not.toMatch(BANNED_RE);
        checked++;
      }
    }
    expect(checked, "anti-vacuity").toBe(LOCALES.length * NEW_KEYS.length);
  });

  it("says RECONNECT in every locale: the reconnect title and lead, who it is linked as without a tick, the grant disclosure, a 44px reconnect start back to this step", () => {
    let checked = 0;
    for (const loc of LOCALES) {
      const h = render({ state: RECONNECT }, loc);
      expect(h, loc).toContain(esc(s(loc, "register.lichess.reconnect.title")));
      expect(h, loc).toContain(esc(s(loc, "register.lichess.reconnect.lead.one").replace("{divisions}", "Open Swiss")));
      expect(h, loc).toContain(esc(s(loc, "register.lichess.required")));
      for (const k of ["settings.account.lichess.consent.title", "settings.account.lichess.consent.body", "settings.account.lichess.consent.scopes", "register.lichess.returnHint"]) {
        expect(h, `${loc}: ${k}`).toContain(esc(s(loc, k)));
      }
      const row = h.match(/<div[^>]*data-testid="register-lichess-needs-reconnect"[^>]*>/);
      expect(row, `${loc}: the linked-but-not-ready row`).not.toBeNull();
      expect(row![0], `${loc}: announced`).toContain('role="status"');
      expect(h, loc).toContain(esc(s(loc, "settings.account.lichess.linkedAs").replace("{username}", "ada_idonly")));
      const a = h.match(/<a[^>]*data-testid="register-lichess-reconnect"[^>]*>([^<]*)</);
      expect(a, `${loc}: the reconnect start`).not.toBeNull();
      expect(a![0], loc).toContain(`href="${lichessLinkStartHref("northfield", NEXT).replaceAll("&", "&amp;")}"`);
      expect(a![0], loc).toMatch(/class="[^"]*\bmin-h-11\b/);
      expect(a![1], loc).toBe(esc(s(loc, "register.lichess.reconnect.cta")));
      // The pair: it is NOT the link card and NOT the done row.
      expect(h, `${loc}: no link title`).not.toContain(esc(s(loc, "register.lichess.title")));
      expect(h, `${loc}: no done tick`).not.toContain('data-testid="register-lichess-linked"');
      expect(h, `${loc}: no link start`).not.toContain('data-testid="register-lichess-start"');
      checked += 1;
    }
    expect(checked).toBe(LOCALES.length);
  });

  it("two divisions read in the plural; the same state with a link that PLAYS is the done row, with no reconnect", () => {
    expect(render({ divisions: ["Open Swiss", "Junior Cup"], state: RECONNECT })).toContain(
      esc(s("en", "register.lichess.reconnect.lead.other").replace("{divisions}", "Open Swiss and Junior Cup")),
    );
    const done = render({ state: { ...RECONNECT, needsReconsent: false } });
    expect(done).toContain('data-testid="register-lichess-linked"');
    expect(done).not.toContain("register-lichess-needs-reconnect");
    expect(done).not.toContain("register-lichess-reconnect");
    expect(done).not.toContain(esc(s("en", "register.lichess.reconnect.title")));
  });

  // A failed reconnect on the way back is NOT done - unlike a linked viewer, this one still has something to do - so the
  // notice must show (a done viewer's flash is deliberately hidden).
  it("a failed reconnect on the way back says why (and what to do), and still offers the reconnect", () => {
    const h = render({ state: { ...RECONNECT, flash: "already_linked" } });
    expect(h).toContain('data-testid="register-lichess-flash"');
    expect(h).toContain(esc(s("en", "settings.account.lichess.flash.already_linked")));
    expect(h).toContain(esc(s("en", "settings.account.lichess.flashNext.already_linked")));
    expect(h).toContain('data-testid="register-lichess-reconnect"');
    // `linked` in the reconnect state is a stale URL (the link still cannot play): nothing to announce.
    expect(render({ state: { ...RECONNECT, flash: "linked" } })).not.toContain('data-testid="register-lichess-flash"');
  });

  it("no Lichess client on this server: says so, and starts nothing", () => {
    const h = render({ state: { ...RECONNECT, configured: false } });
    expect(h).toContain(esc(s("en", "settings.account.lichess.notConfigured")));
    expect(h).not.toContain("/api/auth/lichess");
    expect(h).not.toContain('data-testid="register-lichess-reconnect"');
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
