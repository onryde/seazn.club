// Registration redesign, guardian consent for minors (owner 2026-11-14, final-fix-brief "Addendum 2b — SIMPLIFY"): ONE box on the
// consent step, shown only when the cart has at least one typed-in player who is not the registrant and whose date of birth makes
// them under 18 today: "I'm the parent or guardian of the players under 18 I'm entering." The submit carries it as one boolean,
// `guardian_for_minors` (the server's half: registration-guardian-for-minors.test.ts).
//
// Expected values come from the rule (under 18 today, doc 06 §4.7; "not the registrant" = not the entry's own self row, the server's
// `rowConsentAtSubmit`) and from each locale's dictionary on disk, never from the code under test. No sport: the step is the same for
// every sport.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import { t as tRuntime } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";

const LOCALES = ["en", "es", "fr", "nl"] as const;
type Loc = (typeof LOCALES)[number];
const DICTS = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "..", "dictionaries", l, "ui.json"), "utf8")) as Dict]),
) as Record<Loc, Dict>;
const current = vi.hoisted(() => ({ locale: "en" as string }));
vi.mock("@/components/i18n/dict-provider", () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) => tRuntime(DICTS[current.locale as Loc], key, vars),
}));

import { StepConsent } from "../step-consent";
import { guardianForMinorsOffered } from "../validation";
import { buildSubmitBody } from "../submit";
import { reviewContent } from "../review-content";
import {
  EMPTY_CART,
  EMPTY_CONSENT,
  EMPTY_CONTACT,
  EMPTY_ROSTER_PLAYER,
  type CartEntry,
  type CartState,
  type ConsentState,
  type ContactState,
  type DivisionLike,
} from "../types";

const NOW = new Date("2026-11-14T12:00:00Z");
// Ages on NOW, by the rule's own arithmetic (whole years, a birthday not yet reached this year does not count).
const CHILD = "2016-05-01"; // 10
const SEVENTEEN = "2008-11-15"; // 17: their 18th birthday is tomorrow, so still under 18
const EIGHTEEN_TODAY = "2008-11-14"; // 18 today: an adult, the case a "<= 18" rule would get wrong
const ADULT = "1990-01-01";

const player = (full_name: string, dob: string | null) => ({ ...EMPTY_ROSTER_PLAYER, full_name, dob });
const entry = (over: Partial<CartEntry>): CartEntry => ({
  id: "e1",
  division_id: "d1",
  entrant_kind: "individual",
  team_name: null,
  partner_name: null,
  free_agent: false,
  players: [],
  answers: {},
  registering_self: false,
  self_player_index: null,
  ...over,
});
const cartOf = (...entries: CartEntry[]): CartState => ({ entries });
// The registrant: an adult who gave no date of birth (the common parent, not playing). Fix round 1 (review I-1): only an adult can
// consent as a guardian, so the contact is part of every question below.
const PARENT: ContactState = { ...EMPTY_CONTACT, name: "Pat Parent" };
const s = (loc: Loc, key: string) => String(DICTS[loc][key]);
const esc = (v: string) => v.replaceAll("&", "&amp;").replaceAll("'", "&#x27;").replaceAll('"', "&quot;");

describe("guardianForMinorsOffered: a typed-in player under 18 who is not the registrant, entered by an adult", () => {
  const cases: Array<[string, CartState, boolean, ContactState?]> = [
    ["the empty cart", EMPTY_CART, false],
    ["a child entered for someone else", cartOf(entry({ players: [player("Kid", CHILD)] })), true],
    ["17, turning 18 tomorrow", cartOf(entry({ players: [player("Teen", SEVENTEEN)] })), true],
    ["18 today", cartOf(entry({ players: [player("Grown", EIGHTEEN_TODAY)] })), false],
    ["an adult", cartOf(entry({ players: [player("Adult", ADULT)] })), false],
    ["no date of birth", cartOf(entry({ players: [player("Undated", null)] })), false],
    // The registrant themselves under 18: their own guardian block (guardianRequired), never this box.
    ["the registrant's own row is the child", cartOf(entry({ registering_self: true, players: [player("Me", CHILD)] })), false],
    [
      "a registrant playing beside their child",
      cartOf(entry({ entrant_kind: "team", registering_self: true, self_player_index: 0, players: [player("Me", ADULT), player("Kid", CHILD)] })),
      true,
    ],
    [
      "a team whose only minor is the registrant's own row",
      cartOf(entry({ entrant_kind: "team", registering_self: true, self_player_index: 1, players: [player("Mate", ADULT), player("Me", CHILD)] })),
      false,
    ],
    ["a solo sign-up (its one row is the registrant's)", cartOf(entry({ entrant_kind: "team", free_agent: true, players: [player("Kid", CHILD)] })), false],
    [
      "the minor is on the second entry",
      cartOf(entry({ players: [player("Adult", ADULT)] }), entry({ id: "e2", division_id: "d2", players: [player("Kid", CHILD)] })),
      true,
    ],
    // Fix round 1 (review I-1): a registrant under 18 is nobody's guardian, whichever date the cart holds says so.
    [
      "A: a self-linked 17-year-old captain beside a 10-year-old teammate",
      cartOf(entry({ entrant_kind: "team", registering_self: true, self_player_index: 0, players: [player("Kai", SEVENTEEN), player("Kid", CHILD)] })),
      false,
      { ...EMPTY_CONTACT, name: "Kai" },
    ],
    [
      "B: a minor typed in as an ordinary row under the contact's own name, beside a sibling",
      cartOf(entry({ entrant_kind: "team", players: [player(" zoe  KID ", SEVENTEEN), player("Sam", CHILD)] })),
      false,
      { ...EMPTY_CONTACT, name: "Zoe Kid" },
    ],
    ["a contact dob under 18, entering a child", cartOf(entry({ players: [player("Kid", CHILD)] })), false, { ...PARENT, dob: SEVENTEEN }],
    ["a contact who turned 18 today, entering a child", cartOf(entry({ players: [player("Kid", CHILD)] })), true, { ...PARENT, dob: EIGHTEEN_TODAY }],
    ["a blank contact name", cartOf(entry({ players: [player("Kid", CHILD)] })), false, { ...PARENT, name: "  " }],
    [
      "an adult row under the contact's own name beside a child",
      cartOf(entry({ entrant_kind: "team", players: [player("Pat Parent", ADULT), player("Kid", CHILD)] })),
      true,
    ],
  ];

  it("answers each case by the rule (empty case first)", () => {
    let checked = 0;
    for (const [name, cart, offered, contact = PARENT] of cases) {
      expect(guardianForMinorsOffered(cart, contact, NOW), name).toBe(offered);
      checked++;
    }
    expect(checked).toBe(cases.length);
    expect(cases.filter(([, , offered]) => offered).length, "both answers are exercised").toBeGreaterThan(0);
    expect(cases.filter(([, , offered]) => !offered).length).toBeGreaterThan(0);
  });
});

// StepConsent reads the real clock, so its carts use dates far from any birthday.
const MINOR_CART = cartOf(entry({ players: [player("Kid", "2016-05-01")] }));
const ADULT_CART = cartOf(entry({ players: [player("Adult", "1990-01-01")] }));
const SELF_MINOR_CART = cartOf(entry({ registering_self: true, players: [player("Me", "2016-05-01")] }));

function consentStep(
  cart: CartState,
  consent: ConsentState = EMPTY_CONSENT,
  onConsentChange: (p: Partial<ConsentState>) => void = () => undefined,
  contact: ContactState = PARENT,
) {
  return (
    <StepConsent
      contact={contact}
      onContactChange={() => undefined}
      consent={consent}
      onConsentChange={onConsentChange}
      cart={cart}
      orgName="Northfield Juniors"
      errors={{}}
    />
  );
}
const render = (cart: CartState, consent?: ConsentState, locale: Loc = "en", contact: ContactState = PARENT) => {
  current.locale = locale;
  return renderToStaticMarkup(consentStep(cart, consent, undefined, contact));
};
const BOX = 'data-testid="reg-consent-guardian-minors-box"';

describe("the consent step's guardian box", () => {
  it("is absent when no typed-in player is a minor someone else is entering (empty cart, adults, a self-registering minor)", () => {
    let checked = 0;
    for (const [name, cart] of [["empty", EMPTY_CART], ["adult", ADULT_CART], ["self minor", SELF_MINOR_CART]] as const) {
      const html = render(cart);
      expect(html, `${name}: premise, the step rendered`).toContain('data-testid="reg-consent-privacy-box"');
      expect(html, name).not.toContain(BOX);
      expect(html, name).not.toContain(esc(s("en", "register.consent.guardianForMinors.label")));
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("is shown, unticked, with the owner's sentence in every locale when a minor is entered", () => {
    let checked = 0;
    for (const loc of LOCALES) {
      const html = render(MINOR_CART, EMPTY_CONSENT, loc);
      expect(html, loc).toContain(BOX);
      expect(html, loc).toContain(esc(s(loc, "register.consent.guardianForMinors.label")));
      expect(html, loc).toContain(esc(s(loc, "register.consent.guardianForMinors.hint")));
      expect(html, `${loc}: unticked`).not.toMatch(/id="reg-consent-guardian-minors"[^>]*checked/);
      if (loc !== "en") {
        expect(s(loc, "register.consent.guardianForMinors.label"), `${loc} is translated`).not.toBe(s("en", "register.consent.guardianForMinors.label"));
      }
      checked++;
    }
    expect(checked).toBe(4);
    expect(s("en", "register.consent.guardianForMinors.label")).toBe("I'm the parent or guardian of the players under 18 I'm entering.");
  });

  it("shows the tick it was given, and a tap hands back { guardian_for_minors } both ways", () => {
    expect(render(MINOR_CART, { ...EMPTY_CONSENT, guardian_for_minors: true })).toMatch(/id="reg-consent-guardian-minors"[^>]*checked/);

    const patches: Partial<ConsentState>[] = [];
    current.locale = "en";
    const tree = StepConsent({
      contact: PARENT,
      onContactChange: () => undefined,
      consent: EMPTY_CONSENT,
      onConsentChange: (p) => patches.push(p),
      cart: MINOR_CART,
      orgName: "Northfield Juniors",
      errors: {},
    });
    const box = findById(tree, "reg-consent-guardian-minors");
    expect(box, "premise: the checkbox is in the tree").not.toBeNull();
    const onChange = (box!.props as { onChange: (e: { target: { checked: boolean } }) => void }).onChange;
    onChange({ target: { checked: true } });
    onChange({ target: { checked: false } });
    expect(patches).toEqual([{ guardian_for_minors: true }, { guardian_for_minors: false }]);
  });

  // The roster notice says who will be asked to confirm. Ticked, the minors will not be: when they are EVERY other player nobody is
  // left to ask and the line steps aside; with an adult or an undated player still to ask, it names only them (fix round 1, review
  // m-1: "each player you've named" beside the ticked box was a contradiction). A box that is not offered changes nothing.
  it("the roster notice: unchanged unticked, gone when the tick covers everyone, narrowed when someone is still to ask", () => {
    const NOTICE = 'data-testid="reg-consent-roster-notice"';
    const ticked = { ...EMPTY_CONSENT, guardian_for_minors: true };
    const team = (...players: ReturnType<typeof player>[]) => cartOf(entry({ entrant_kind: "team", players }));
    const PLAYING = "register.consent.rosterNotice";
    const NOT_PLAYING = "register.consent.rosterNoticeNotPlaying";
    const G_PLAYING = "register.consent.rosterNoticeGuardian";
    const G_NOT_PLAYING = "register.consent.rosterNoticeGuardianNotPlaying";
    const KEYS = [PLAYING, NOT_PLAYING, G_PLAYING, G_NOT_PLAYING];
    const cases: Array<[string, CartState, ConsentState, string | null, ContactState?]> = [
      ["the empty cart names nobody", EMPTY_CART, ticked, null],
      ["unticked, the child is asked", MINOR_CART, EMPTY_CONSENT, NOT_PLAYING],
      ["ticked, the only other player is a child", MINOR_CART, ticked, null],
      ["ticked, two children", team(player("Kid", "2016-05-01"), player("Sib", "2014-03-03")), ticked, null],
      ["ticked, an adult is still asked", team(player("Kid", "2016-05-01"), player("Adult", "1990-01-01")), ticked, G_NOT_PLAYING],
      ["ticked, an undated player is still asked", team(player("Kid", "2016-05-01"), player("Undated", null)), ticked, G_NOT_PLAYING],
      [
        "ticked, the registrant plays beside their child",
        cartOf(entry({ entrant_kind: "team", registering_self: true, self_player_index: 0, players: [player("Pat Parent", "1990-01-01"), player("Kid", "2016-05-01")] })),
        ticked,
        null,
      ],
      [
        "ticked, the registrant plays beside their child and an adult",
        cartOf(entry({ entrant_kind: "team", registering_self: true, self_player_index: 0, players: [player("Pat Parent", "1990-01-01"), player("Kid", "2016-05-01"), player("Coach", "1980-02-02")] })),
        ticked,
        G_PLAYING,
      ],
      ["a stale tick with no minor to cover is ignored", ADULT_CART, ticked, NOT_PLAYING],
      [
        "unticked, the registrant plays beside their child",
        cartOf(entry({ entrant_kind: "team", registering_self: true, self_player_index: 0, players: [player("Pat Parent", "1990-01-01"), player("Kid", "2016-05-01")] })),
        EMPTY_CONSENT,
        PLAYING,
      ],
      [
        "ticked, the child on one entry, an adult on another",
        cartOf(entry({ players: [player("Kid", "2016-05-01")] }), entry({ id: "e2", division_id: "d2", players: [player("Adult", "1990-01-01")] })),
        ticked,
        G_NOT_PLAYING,
      ],
      // A minor registrant is offered no box, so a tick changes nothing and "go back and tick “I'm one of the players”" stays.
      [
        "B: a minor typed in under their own name ticks it",
        team(player("Zoe Kid", "2012-02-02"), player("Sam", "2016-05-01")),
        ticked,
        NOT_PLAYING,
        { ...EMPTY_CONTACT, name: "Zoe Kid" },
      ],
    ];
    let checked = 0;
    for (const [name, cart, consent, key, contact = PARENT] of cases) {
      const html = render(cart, consent, "en", contact);
      expect(html.includes(NOTICE), `${name}: a notice`).toBe(key !== null);
      // Which line: each key's own words (up to its "{box}") are on the page, and no other key's are.
      for (const k of KEYS) expect(html.includes(esc(s("en", k).split("{box}")[0]!)), `${name}: ${k}`).toBe(k === key);
      checked++;
    }
    expect(checked).toBe(cases.length);
    for (const k of [...KEYS, null]) expect(cases.some(([, , , key]) => key === k), `case for ${k}`).toBe(true);
  });

  it("the two narrowed notices are translated in every locale and keep the box name", () => {
    let checked = 0;
    for (const loc of LOCALES) {
      for (const k of ["register.consent.rosterNoticeGuardian", "register.consent.rosterNoticeGuardianNotPlaying"]) {
        expect(DICTS[loc][k], `${loc} ${k}`).toBeTypeOf("string");
        if (loc !== "en") expect(s(loc, k), `${loc} ${k} is translated`).not.toBe(s("en", k));
        checked++;
      }
      // The not-playing line names the box to tick, as its un-narrowed sibling does.
      expect(s(loc, "register.consent.rosterNoticeGuardianNotPlaying"), loc).toContain("{box}");
    }
    expect(checked).toBe(8);
  });
});

/** The element with this `id` in a rendered tree (plain elements only; StepConsent's own markup is not behind a child component). */
function findById(node: ReactNode, id: string): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findById(child as ReactNode, id);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return null;
  const el = node as ReactElement<{ id?: string; children?: ReactNode }>;
  if (el.props.id === id) return el;
  return findById(el.props.children, id);
}

const DIVISIONS: DivisionLike[] = [];

describe("what the submit and the review carry", () => {
  const ticked: ConsentState = { ...EMPTY_CONSENT, guardian_for_minors: true };
  const cases: Array<[string, CartState, ConsentState, boolean]> = [
    ["ticked, a minor entered", MINOR_CART, ticked, true],
    ["unticked, a minor entered", MINOR_CART, EMPTY_CONSENT, false],
    // The box is not on the page, so a tick held from before (a date of birth changed since) is not sent.
    ["ticked, no minor any more", ADULT_CART, ticked, false],
    // A draft saved before the field existed has no key at all.
    ["an older draft without the field", MINOR_CART, { privacy_consent: true, media_consent: false }, false],
  ];
  // Fix round 1 (review I-1): the same ticked cart, sent by a registrant under 18, carries no tick (the server ignores one anyway).
  const MINOR_CONTACT: ContactState = { ...PARENT, dob: "2012-02-02" };

  it("the body sends guardian_for_minors only when the box is shown and ticked", () => {
    let checked = 0;
    for (const [name, cart, consent, sent] of cases) {
      expect(buildSubmitBody(PARENT, consent, cart, "").guardian_for_minors, name).toBe(sent);
      checked++;
    }
    expect(checked).toBe(cases.length);
    expect(buildSubmitBody(MINOR_CONTACT, ticked, MINOR_CART, "").guardian_for_minors, "a registrant under 18").toBe(false);
  });

  it("the review lists the choice exactly when the consent step asked it", () => {
    expect(reviewContent(MINOR_CART, DIVISIONS, PARENT, ticked, new Date()).guardianForMinors).toBe(true);
    expect(reviewContent(MINOR_CART, DIVISIONS, PARENT, EMPTY_CONSENT, new Date()).guardianForMinors).toBe(false);
    expect(reviewContent(ADULT_CART, DIVISIONS, PARENT, ticked, new Date()).guardianForMinors).toBeNull();
    expect(reviewContent(EMPTY_CART, DIVISIONS, PARENT, EMPTY_CONSENT, new Date()).guardianForMinors).toBeNull();
    expect(reviewContent(MINOR_CART, DIVISIONS, MINOR_CONTACT, ticked, new Date()).guardianForMinors, "not asked of a minor").toBeNull();
  });
});
