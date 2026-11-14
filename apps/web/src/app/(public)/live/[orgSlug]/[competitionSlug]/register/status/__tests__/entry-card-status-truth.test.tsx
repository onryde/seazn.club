// Polish wave P3 (walkthrough W2, W12, W6, W10, W11): the status card tells the truth about WHY an entry is not confirmed, and does not
// say "Checked in" about a roster whose entry is waitlisted, expired or withdrawn.
//
// Expected values here are the brief's rulings (per status / fee / review mode, written out) and the copy in the dictionary files; none
// is read back from the card or the view-model under test. renderToStaticMarkup, the same convention as entry-card.test.tsx (no jsdom
// in this workspace; CancelEntry reads useRouter()/useConfirm() at render time).
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";
import type { Dict, Locale } from "@/lib/i18n-constants";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/components/ui/confirm-provider", () => ({ useConfirm: () => async () => false }));

import { EntryCard, type EntryCardProps } from "../entry-card";
import type { EntryStatus } from "../view-model";

const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";

function props(over: Partial<EntryCardProps["entry"]> = {}, cart: Partial<EntryCardProps["cart"]> = {}, locale: Locale = "en", ui: Dict = uiEn as Dict): EntryCardProps {
  return {
    entry: {
      id: "reg-1",
      division_id: "div-1",
      division_name: "Open Singles",
      display_name: "Mia Cole",
      entrant_kind: "individual",
      status: "pending",
      amount_cents: 1500,
      free_agent: false,
      assigned_team_name: null,
      pool_place_by_at: null,
      join_code: null,
      allows_new_joiner: true,
      promotion_expires_at: null,
      payment_method: "stripe",
      approval: "auto",
      approved: false,
      fee_if_promoted_cents: null,
      waitlist_position: null,
      promotion_skipped_at: null,
      division_youth: false,
      division_player_name_display: null,
      players: [],
      refund_policy: { refundable: false, deadline: null, amount_cents: 0 },
      refunded_cents: 0,
      // B5 T18: a one-entry cart, so the card prints no reference of its own.
      entry_ref: "SZ-ABCD-EFGH",
      ...over,
    },
    cart: { expires_at: FUTURE, charges_enabled: true, instructionsHtml: null, currency: "gbp", timezone: "UTC", cart_size: 1, ...cart },
    orgSlug: "org",
    competitionSlug: "comp",
    token: "tok",
    locale,
    ui,
  };
}
const render = (p: EntryCardProps) => renderToStaticMarkup(<EntryCard {...p} />);
const waitingOn = (markup: string) => markup.match(/data-waiting-on="([a-z_]+)"/)?.[1] ?? null;

describe("a pending entry says what it is waiting on (W2, W12)", () => {
  // [status, fee in cents, review mode, what the card says it waits on]. The brief's ruling: payment (a fee is owed), approval (the
  // division reviews entries by hand), or both; nothing to name for a confirmed, waitlisted or ended entry, or a pending entry with
  // neither a fee nor a review (a state a free auto-approval division never rests in).
  const MATRIX: [EntryStatus, number, "auto" | "manual", string | null][] = [
    ["pending", 1500, "auto", "payment"],
    ["pending", 1500, "manual", "payment_and_approval"],
    ["pending", 0, "manual", "approval"],
    ["pending", 0, "auto", null],
    ["paid", 1500, "manual", "approval"],
    ["paid", 1500, "auto", null],
    ["confirmed", 1500, "manual", null],
    ["confirmed", 1500, "auto", null],
    ["waitlisted", 0, "manual", null],
    ["withdrawn", 1500, "manual", null],
    ["expired", 1500, "auto", null],
    ["rejected", 1500, "manual", null],
  ];

  it("every (status, fee, review) case names the right thing, in the dictionary's own words (counted)", () => {
    let checked = 0;
    const seen = new Set<string>();
    for (const [status, amount_cents, approval, want] of MATRIX) {
      const markup = render(props({ status, amount_cents, approval }));
      expect(waitingOn(markup), `${status}/${amount_cents}/${approval}`).toBe(want);
      if (want) {
        const copy = (uiEn as Record<string, string>)[`register.status.waiting.${want}`]!;
        expect(copy, `premise: copy exists for ${want}`).toBeTruthy();
        expect(markup, `${status}/${amount_cents}/${approval}`).toContain(copy);
        seen.add(copy);
      } else {
        expect(markup, `${status}/${amount_cents}/${approval}: no 'Not confirmed yet'`).not.toContain("Not confirmed yet");
      }
      checked += 1;
    }
    expect(checked).toBe(MATRIX.length);
    expect(seen.size, "the three reasons are three different sentences").toBe(3);
  });

  // Polish wave P5 (W12): the organiser approved the entry while its fee was owed (`approved`, V513). The card then names the
  // payment alone - the same reason an unpaid auto-approval entry gives (the MATRIX's first row), never "payment and approval".
  it("an entry approved ahead of its payment waits on payment alone; unapproved, on both (the pair)", () => {
    const approvedMarkup = render(props({ status: "pending", amount_cents: 1500, approval: "manual", approved: true }));
    const unapprovedMarkup = render(props({ status: "pending", amount_cents: 1500, approval: "manual", approved: false }));
    expect(waitingOn(approvedMarkup)).toBe("payment");
    expect(approvedMarkup).toContain((uiEn as Record<string, string>)["register.status.waiting.payment"]!);
    expect(waitingOn(unapprovedMarkup)).toBe("payment_and_approval");
  });

  it("an offline entry waiting on payment AND approval says both (W12: the page showed only how to pay)", () => {
    const markup = render(props({ payment_method: "offline", approval: "manual" }, { instructionsHtml: "<p>Pay the organiser</p>" }));
    expect(waitingOn(markup)).toBe("payment_and_approval");
    expect(markup).toContain("Pay the organiser");
  });

  it("an entry whose payment window has already closed says nothing here: the window-closed message already explains it", () => {
    const markup = render(props({ payment_method: "stripe" }, { expires_at: PAST }));
    expect(markup).toContain("The payment window for this entry has");
    expect(waitingOn(markup)).toBeNull();
  });

  it("es, fr and nl each carry their own sentence for each reason (read from the raw files: getDictionary fills English)", () => {
    const dicts: [string, Locale, Dict][] = [["es", "es", uiEs as Dict], ["fr", "fr", uiFr as Dict], ["nl", "nl", uiNl as Dict]];
    let checked = 0;
    for (const [name, locale, ui] of dicts) {
      for (const [approval, amount, want] of [["auto", 1500, "payment"], ["manual", 0, "approval"], ["manual", 1500, "payment_and_approval"]] as const) {
        const key = `register.status.waiting.${want}`;
        const own = (ui as Record<string, string>)[key]!;
        expect(own, `${name} ${key} exists`).toBeTruthy();
        expect(own, `${name} ${key} is translated`).not.toBe((uiEn as Record<string, string>)[key]);
        expect(render(props({ approval, amount_cents: amount }, {}, locale, ui)), `${name}/${want}`).toContain(own.replace(/'/g, "&#x27;"));
        checked += 1;
      }
    }
    expect(checked).toBe(9);
  });
});

describe("the roster says 'Checked in' only on a confirmed entry (W6, W10, W11; final fix ruling on V7)", () => {
  const PLAYERS = [
    { id: "p1", full_name: "Mia Cole", consent_status: "granted" as const, consent: null },
    { id: "p2", full_name: "Dev Kapoor", consent_status: "pending" as const, consent: null },
  ];
  const NOT_LIVE: EntryStatus[] = ["waitlisted", "withdrawn", "expired", "rejected"];
  const AWAITING: EntryStatus[] = ["pending", "paid"];

  it("a confirmed entry keeps the check-in words: the chips and the meter", () => {
    const markup = render(props({ status: "confirmed", players: PLAYERS }));
    expect(markup).toContain(">Checked in<");
    expect(markup).toContain(">Not checked in<");
    expect(markup).toContain(">1 of 2 checked in<");
    expect(markup).not.toContain(">Joined<");
    expect(markup).not.toContain(">Registered<");
  });

  // Owner ruling on V7 (2026-11-12): an entry still awaiting payment, approval or both has not been confirmed, so nobody on it has
  // "checked in": its players have JOINED. Tested for both review modes and with and without a fee, so every pending shape is seen.
  it("an entry awaiting payment, approval or both says 'Joined', never 'checked in' (counted)", () => {
    const shapes: [EntryStatus, number, "auto" | "manual"][] = [
      ["pending", 1500, "auto"],
      ["pending", 1500, "manual"],
      ["pending", 0, "manual"],
      ["pending", 0, "auto"],
      ["paid", 1500, "manual"],
      ["paid", 1500, "auto"],
    ];
    let checked = 0;
    for (const [status, amount_cents, approval] of shapes) {
      const markup = render(props({ status, amount_cents, approval, players: PLAYERS }));
      const at = `${status}/${amount_cents}/${approval}`;
      expect(markup, at).toContain(">Joined<");
      expect(markup, at).toContain(">Not joined yet<");
      expect(markup, at).toContain(">1 of 2 joined<");
      expect(markup, at).not.toMatch(/checked in/i);
      expect(markup, at).not.toContain(">Registered<");
      checked += 1;
    }
    expect(checked).toBe(6);
    expect(new Set(shapes.map(([s]) => s)), "both awaiting statuses seen").toEqual(new Set(AWAITING));
  });

  it("a waitlisted, withdrawn, expired or rejected entry never says it checked in (counted)", () => {
    let checked = 0;
    for (const status of NOT_LIVE) {
      const markup = render(props({ status, players: PLAYERS }));
      expect(markup, status).toContain(">Registered<");
      expect(markup, status).toContain(">Not registered yet<");
      expect(markup, status).toContain(">1 of 2 registered<");
      expect(markup, status).not.toContain(">Checked in<");
      expect(markup, status).not.toContain(">Not checked in<");
      expect(markup, status).not.toMatch(/>\d+ of \d+ checked in</);
      checked += 1;
    }
    expect(checked).toBe(NOT_LIVE.length);
  });

  it("the walkthrough's own case: a waitlisted individual whose one player has confirmed reads '1 of 1 registered' (W6)", () => {
    const markup = render(props({ status: "waitlisted", amount_cents: 0, players: [PLAYERS[0]!] }));
    expect(markup).toContain(">1 of 1 registered<");
    expect(markup).toContain(">Registered<");
    expect(markup).not.toContain("checked in");
  });

  it("es, fr and nl: the 'joined' words are each locale's own and differ from the check-in words", () => {
    const dicts: [string, Locale, Dict][] = [["es", "es", uiEs as Dict], ["fr", "fr", uiFr as Dict], ["nl", "nl", uiNl as Dict]];
    const en = uiEn as Record<string, string>;
    let checked = 0;
    for (const [name, locale, ui] of dicts) {
      const d = ui as Record<string, string>;
      for (const key of ["register.status.roster.joined", "register.status.roster.notJoined"]) {
        expect(d[key], `${name} ${key} exists`).toBeTruthy();
        expect(d[key], `${name} ${key} translated`).not.toBe(en[key]);
      }
      const markup = render(props({ status: "pending", players: PLAYERS }, {}, locale, ui));
      expect(markup, name).toContain(`>${d["register.status.roster.joined"]}<`);
      expect(markup, name).toContain(`>${d["register.status.roster.notJoined"]}<`);
      expect(markup, name).toContain(`>${d["register.status.roster.meterJoined"]!.replace("{claimed}", "1").replace("{total}", "2")}<`);
      expect(d["register.status.roster.joined"], `${name}: not the check-in word`).not.toBe(d["register.status.roster.claimed"]);
      checked += 1;
    }
    expect(checked).toBe(3);
  });

  it("es, fr and nl: the neutral words are each locale's own and differ from the check-in words", () => {
    const dicts: [string, Locale, Dict][] = [["es", "es", uiEs as Dict], ["fr", "fr", uiFr as Dict], ["nl", "nl", uiNl as Dict]];
    let checked = 0;
    for (const [name, locale, ui] of dicts) {
      const d = ui as Record<string, string>;
      const markup = render(props({ status: "withdrawn", players: PLAYERS }, {}, locale, ui));
      expect(markup, name).toContain(`>${d["register.status.roster.registered"]}<`);
      expect(markup, name).toContain(`>${d["register.status.roster.notRegistered"]}<`);
      expect(markup, name).toContain(`>${d["register.status.roster.meterRegistered"]!.replace("{claimed}", "1").replace("{total}", "2")}<`);
      expect(d["register.status.roster.notRegistered"], `${name}: not the check-in word`).not.toBe(d["register.status.roster.pending"]);
      checked += 1;
    }
    expect(checked).toBe(3);
  });
});

// Polish wave sign-off V6: a rejected entry whose fee the organiser sent back read only "REJECTED" - the registrant could not see from
// the page that the money was returned (the rejection mail said it, the page did not). The card now names what came back, on any entry
// that has had money sent back (a withdrawal's auto-refund, a rejection's, an organiser's partial refund on a confirmed entry), and says
// nothing about refunds on an entry nothing was sent back for. Expected strings are the dictionary's own words plus the figure written
// out; none is read back from the card.
describe("an entry with money sent back says how much (sign-off V6)", () => {
  const refundedLine = (markup: string) => markup.match(/data-testid="reg-status-refunded"[^>]*>([^<]*)</)?.[1] ?? null;

  it("nothing sent back: no refund line on any status, rejected included (the empty case first; counted)", () => {
    const ALL: EntryStatus[] = ["pending", "paid", "confirmed", "waitlisted", "withdrawn", "expired", "rejected"];
    let checked = 0;
    for (const status of ALL) {
      const markup = render(props({ status, approval: "manual", refunded_cents: 0 }));
      expect(refundedLine(markup), status).toBeNull();
      expect(markup, status).not.toContain("Refunded");
      checked += 1;
    }
    expect(checked).toBe(ALL.length);
  });

  it("the walkthrough's case: a rejected £15 entry refunded in full reads 'Refunded £15.00'", () => {
    const markup = render(props({ status: "rejected", approval: "manual", amount_cents: 1500, refunded_cents: 1500 }));
    expect(refundedLine(markup)).toBe("Refunded £15.00");
  });

  it("every status that has had money sent back names the amount (counted)", () => {
    const ALL: EntryStatus[] = ["pending", "paid", "confirmed", "waitlisted", "withdrawn", "expired", "rejected"];
    let checked = 0;
    for (const status of ALL) {
      expect(refundedLine(render(props({ status, approval: "manual", refunded_cents: 500 }))), status).toBe("Refunded £5.00");
      checked += 1;
    }
    expect(checked).toBe(ALL.length);
  });

  it("a partial refund on a confirmed entry keeps the fee and adds what came back", () => {
    const markup = render(props({ status: "confirmed", amount_cents: 1500, refunded_cents: 500 }));
    expect(markup).toContain(">£15.00<");
    expect(refundedLine(markup)).toBe("Refunded £5.00");
  });

  it("es, fr and nl each say it in their own words (read from the raw files: getDictionary fills English)", () => {
    const dicts: [string, Locale, Dict][] = [["es", "es", uiEs as Dict], ["fr", "fr", uiFr as Dict], ["nl", "nl", uiNl as Dict]];
    const en = (uiEn as Record<string, string>)["register.status.entry.refunded"];
    expect(en).toBe("Refunded {amount}");
    let checked = 0;
    for (const [name, locale, ui] of dicts) {
      const own = (ui as Record<string, string>)["register.status.entry.refunded"]!;
      expect(own, `${name}: the key exists`).toBeTruthy();
      expect(own, `${name}: translated`).not.toBe(en);
      expect(own, `${name}: carries the figure`).toContain("{amount}");
      const line = refundedLine(render(props({ status: "rejected", approval: "manual", refunded_cents: 1500 }, {}, locale, ui)));
      expect(line, name).not.toBeNull();
      for (const part of own.split("{amount}").map((s) => s.trim()).filter(Boolean)) expect(line, `${name}: ${part}`).toContain(part);
      expect(line, `${name}: the figure`).toMatch(/15[.,]00/);
      checked += 1;
    }
    expect(checked).toBe(3);
  });
});
