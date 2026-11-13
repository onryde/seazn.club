// Code-review fix (2026-08-30, item 6): the claim-link text used to fall
// back to the RAW, unmasked p.full_name whenever displayNameById missed for
// a player, while the roster-name span right above it has always rendered
// blank on the same miss (no fallback at all) — one row leaked what the
// other was already careful about. The map is built from the exact same
// entry.players array both loops read (entry-card.tsx's own doc comment), so
// a genuine miss cannot happen through props alone; rosterPlayerDisplayName
// is mocked here to force one anyway — exactly the "should never happen"
// bug-shaped state the fix guards against. Same renderToStaticMarkup + mock
// pair as status-page.test.tsx (no jsdom in this workspace; CancelEntry
// reads useRouter()/useConfirm() at render time).
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import uiEn from "@/dictionaries/en/ui.json";
import uiEs from "@/dictionaries/es/ui.json";
import uiFr from "@/dictionaries/fr/ui.json";
import uiNl from "@/dictionaries/nl/ui.json";
import type { Dict } from "@/lib/i18n-constants";
import { fmtDateTime, fmtZoneAbbrev } from "@/lib/format";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => async () => false,
}));

vi.mock("../view-model", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../view-model")>();
  return {
    ...actual,
    rosterPlayerDisplayName: () => undefined as unknown as string,
  };
});

import { EntryCard, type EntryCardProps } from "../entry-card";
import type { EntryStatus } from "../view-model";

const RAW_LEAK_SENTINEL = "Raw-Leak-Sentinel-Full-Name";

function baseProps(): EntryCardProps {
  return {
    entry: {
      id: "reg-1",
      division_id: "div-1",
      division_name: "Open",
      display_name: "Team X",
      entrant_kind: "team",
      status: "pending",
      amount_cents: 0,
      free_agent: false,
      assigned_team_name: null,
      pool_place_by_at: null,
      join_code: "JOIN123",
      allows_new_joiner: true,
      promotion_expires_at: null,
      payment_method: "offline",
      approval: "auto",
      approved: false,
      fee_if_promoted_cents: null,
      waitlist_position: null,
      division_youth: false,
      division_player_name_display: null,
      players: [
        {
          id: "player-1",
          full_name: RAW_LEAK_SENTINEL,
          consent_status: "pending",
          consent: null,
        },
      ],
      refund_policy: { refundable: false, deadline: null, amount_cents: 0 },
      refunded_cents: 0,
      entry_ref: "SZ-ABCD-EFGH-2",
    },
    cart: {
      expires_at: null,
      charges_enabled: true,
      instructionsHtml: null,
      currency: "gbp",
      timezone: "UTC",
      cart_size: 2,
    },
    orgSlug: "org",
    competitionSlug: "comp",
    token: "tok",
    locale: "en",
    ui: uiEn as Dict,
  };
}

// Registration redesign B5 T18 (spec §6.3): an entry of a cart sent with two or more entries quotes its own reference, small, under
// its name; the page's hero still says the cart's.
describe("EntryCard — its own reference (B5 T18)", () => {
  const refLine = (html: string) => html.match(/<p data-testid="reg-status-entry-ref" data-entry-ref="([^"]*)"[^>]*>([\s\S]*?)<\/p>/);

  it("a 2+ cart: the line names the reference in the dictionary's words, the reference alone in its own selectable span", () => {
    const html = renderToStaticMarkup(<EntryCard {...baseProps()} />);
    const m = refLine(html);
    expect(m, "the reference line").not.toBeNull();
    expect(m![1]).toBe("SZ-ABCD-EFGH-2");
    const [lead, tail = ""] = (uiEn as Record<string, string>)["register.status.entry.reference"]!.split("{reference}");
    expect(m![2]).toBe(`${lead}<span class="select-all">SZ-ABCD-EFGH-2</span>${tail}`);
  });

  it("sits after the division and the entry's name, so the two lines that name the entry stay together", () => {
    const html = renderToStaticMarkup(<EntryCard {...baseProps()} />);
    const at = (needle: string) => html.indexOf(needle);
    expect(at("Open"), "division").toBeGreaterThan(-1);
    expect(at("Team X")).toBeGreaterThan(at("Open"));
    expect(at('data-testid="reg-status-entry-ref"')).toBeGreaterThan(at("Team X"));
    expect(at('data-testid="reg-status-entry-ref"')).toBeLessThan(at('data-testid="reg-status-outcome"'));
  });

  it("a one-entry cart: no line (the empty case)", () => {
    const p = baseProps();
    const html = renderToStaticMarkup(<EntryCard {...p} cart={{ ...p.cart, cart_size: 1 }} entry={{ ...p.entry, entry_ref: "SZ-ABCD-EFGH" }} />);
    expect(html, "anti-vacuity: the card rendered").toContain("Team X");
    expect(refLine(html)).toBeNull();
  });

  it("no reference to print (the cart has none): no line, whatever the size", () => {
    const p = baseProps();
    const html = renderToStaticMarkup(<EntryCard {...p} entry={{ ...p.entry, entry_ref: null }} />);
    expect(html).toContain("Team X");
    expect(refLine(html)).toBeNull();
  });

  it("a withdrawn entry keeps its number: the line is still there, and says -2", () => {
    const p = baseProps();
    const html = renderToStaticMarkup(<EntryCard {...p} entry={{ ...p.entry, status: "withdrawn" }} />);
    expect(refLine(html)![1]).toBe("SZ-ABCD-EFGH-2");
  });
});

describe("EntryCard — a displayNameById miss never falls back to the raw p.full_name", () => {
  it("the claim-link text stays clear of the raw name even when rosterPlayerDisplayName's own map entry is missing", () => {
    const html = renderToStaticMarkup(<EntryCard {...baseProps()} />);
    expect(html).not.toContain(RAW_LEAK_SENTINEL);
  });

  it("the roster-name span (the pre-existing, already-correct behaviour) renders blank on the same miss", () => {
    // Pins the CURRENT behaviour the claim-link fix now matches, so a future
    // edit cannot quietly diverge the two again in the other direction.
    const html = renderToStaticMarkup(<EntryCard {...baseProps()} />);
    expect(html).toContain(">Not joined yet<"); // the badge still renders (a pending entry's word; owner ruling on V7, 2026-11-12)
    expect(html).not.toContain("undefined");
  });
});

// RS012 stage 3b — the status page tells a waiting solo sign-up not just
// THAT it is waiting but BY WHEN it will be auto-refunded if nobody places
// it. Same org-timezone-aware/zone-labelled rendering the existing pay
// deadline line already uses (deadlineLabel, reused verbatim).
describe("EntryCard — pool_place_by_at deadline (RS012)", () => {
  function poolProps(over: {
    free_agent: boolean;
    assigned_team_name?: string | null;
    pool_place_by_at?: string | null;
  }): EntryCardProps {
    const props = baseProps();
    return {
      ...props,
      entry: {
        ...props.entry,
        free_agent: over.free_agent,
        assigned_team_name: over.assigned_team_name ?? null,
        pool_place_by_at: over.pool_place_by_at ?? null,
      },
      cart: { ...props.cart, timezone: "Asia/Kolkata" },
    };
  }

  const DEADLINE = "2026-03-15T00:00:00.000Z";
  const expectedDate = fmtDateTime("Asia/Kolkata", DEADLINE);
  const expectedZone = fmtZoneAbbrev("Asia/Kolkata", DEADLINE);

  it("shows both the waiting notice and the deadline for an unplaced solo sign-up with a pool deadline", () => {
    const html = renderToStaticMarkup(
      <EntryCard {...poolProps({ free_agent: true, assigned_team_name: null, pool_place_by_at: DEADLINE })} />,
    );
    expect(html).toContain("Waiting for a team");
    expect(html).toContain(expectedDate);
    expect(html).toContain(expectedZone);
  });

  it("shows NEITHER the waiting notice NOR the deadline once assigned, even though pool_place_by_at is still carried", () => {
    const html = renderToStaticMarkup(
      <EntryCard
        {...poolProps({
          free_agent: true,
          assigned_team_name: "Riverside Rovers",
          pool_place_by_at: DEADLINE,
        })}
      />,
    );
    expect(html).not.toContain("Waiting for a team");
    expect(html).not.toContain(expectedDate);
    expect(html).toContain("Assigned to Riverside Rovers");
  });

  it("never shows the deadline for a non-free-agent entry, regardless of a carried pool_place_by_at", () => {
    const html = renderToStaticMarkup(
      <EntryCard {...poolProps({ free_agent: false, pool_place_by_at: DEADLINE })} />,
    );
    expect(html).not.toContain("Waiting for a team");
    expect(html).not.toContain(expectedDate);
  });

  it("shows the waiting notice with NO deadline line when the division has no place-by/closes-at deadline", () => {
    const html = renderToStaticMarkup(
      <EntryCard {...poolProps({ free_agent: true, assigned_team_name: null, pool_place_by_at: null })} />,
    );
    expect(html).toContain("Waiting for a team");
    expect(html).not.toContain(expectedDate);
  });
});

// Bench hook (B03r) — the bench needs to read WHICH outcome a status page
// shows without depending on the (per-locale) visible label, so the badge
// carries both a fixed data-testid AND a data-status value. Critical repo
// rule (AGENTS.md "Verification traps"): anchor on `="` — React serialises
// an omitted prop as `"$undefined"`, so a bare `data-testid`/`data-status`
// substring probe would pass in both the present and absent states.
//
// `EXHAUSTIVE_STATUSES` is typed as `Record<EntryStatus, true>` (view-
// model.ts's own type) rather than a bare string list — if a status is
// ever renamed or removed there, this object stops compiling instead of
// silently asserting a stale set.
describe("EntryCard — reg-status-outcome bench hook", () => {
  const EXHAUSTIVE_STATUSES: Record<EntryStatus, true> = {
    pending: true,
    paid: true,
    confirmed: true,
    waitlisted: true,
    withdrawn: true,
    expired: true,
    rejected: true,
  };
  void EXHAUSTIVE_STATUSES; // compile-time proof the two cases below are real EntryStatus members

  function withStatus(status: EntryStatus) {
    const props = baseProps();
    return renderToStaticMarkup(<EntryCard {...props} entry={{ ...props.entry, status }} />);
  }

  it('carries data-testid="reg-status-outcome" and data-status="waitlisted" for a waitlisted entry', () => {
    const html = withStatus("waitlisted");
    expect(html).toContain('data-testid="reg-status-outcome"');
    expect(html).toContain('data-status="waitlisted"');
  });

  it('carries data-testid="reg-status-outcome" and data-status="rejected" for a rejected entry — a DIFFERENT value than waitlisted, proving the attribute tracks the actual status rather than a constant', () => {
    const html = withStatus("rejected");
    expect(html).toContain('data-testid="reg-status-outcome"');
    expect(html).toContain('data-status="rejected"');
    expect(html).not.toContain('data-status="waitlisted"');
  });

  // `data-registration-id` sits beside `data-status` because the bench cannot
  // read the submit RESPONSE: the stepper navigates here on success, and
  // Playwright's `response.json()` then fails with "No resource with given
  // identifier found" — the browser has discarded the body of a request whose
  // page is gone. The landing URL carries only the GROUP's rid/token, and the
  // public status API is entry-keyed, so this badge is the only place an
  // entry's own id is observable from the page a registrant actually sees.
  it('carries data-registration-id on the same badge, matching the entry it renders', () => {
    const props = baseProps();
    const html = renderToStaticMarkup(
      <EntryCard {...props} entry={{ ...props.entry, id: "reg-abc-123", status: "confirmed" }} />,
    );
    // Anchored on `="` — React serialises an omitted prop as "$undefined", so
    // a bare attribute-name probe passes in both the present and absent states.
    expect(html).toContain('data-registration-id="reg-abc-123"');
  });

  it("data-registration-id tracks the entry rather than being a constant", () => {
    const props = baseProps();
    const other = renderToStaticMarkup(
      <EntryCard {...props} entry={{ ...props.entry, id: "reg-zzz-999", status: "confirmed" }} />,
    );
    // The differential half. A hardcoded id would satisfy the test above
    // forever, and a driver would then address the wrong entry — or the same
    // one twice — with nothing failing.
    expect(other).toContain('data-registration-id="reg-zzz-999"');
    expect(other).not.toContain('data-registration-id="reg-abc-123"');
  });
});

// Owner ruling 2026-09-16: a public page's dates are in the locale its copy is
// in, and English is day-month. The deadline went through `fmtDateTime`, which
// is en-GB in every locale — so a Spanish registrant read "15 Mar 2026, 05:30"
// inside a Spanish sentence. The zone is the org's, named in the expectation.
describe("EntryCard — the deadline is written in the page's locale", () => {
  const DEADLINE = "2026-03-15T00:00:00.000Z";
  const UI = { en: uiEn, es: uiEs, fr: uiFr, nl: uiNl } as const;
  const render = (locale: keyof typeof UI) => {
    const props = baseProps();
    return renderToStaticMarkup(
      <EntryCard
        {...props}
        locale={locale}
        ui={UI[locale] as Dict}
        entry={{ ...props.entry, free_agent: true, assigned_team_name: null, pool_place_by_at: DEADLINE }}
        cart={{ ...props.cart, timezone: "Asia/Kolkata" }}
      />,
    );
  };

  it("en: day-month, the organiser's zone, named", () => {
    expect(render("en")).toContain("15 Mar 2026, 05:30 IST");
  });

  for (const locale of ["es", "fr", "nl"] as const) {
    it(`${locale}: that locale's own Intl form`, () => {
      const own = new Intl.DateTimeFormat(locale, {
        timeZone: "Asia/Kolkata",
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(DEADLINE));
      expect(own, "premise: differs from en-GB").not.toBe("15 Mar 2026, 05:30");
      const html = render(locale);
      expect(html).toContain(own);
      expect(html).not.toContain("15 Mar 2026, 05:30");
    });

    it(`${locale}: the zone label beside it is Intl's in ${locale}, never the English "IST"`, () => {
      const at = new Date(DEADLINE);
      const own = new Intl.DateTimeFormat(locale, { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }).format(at);
      const zone = new Intl.DateTimeFormat(locale, { timeZone: "Asia/Kolkata", timeZoneName: "short" })
        .formatToParts(at)
        .find((p) => p.type === "timeZoneName")?.value;
      expect(zone, "premise: not the English abbreviation").not.toBe("IST");
      const html = render(locale);
      expect(html).toContain(`${own} ${zone}`);
      expect(html).not.toContain("IST");
    });
  }
});

// Registration redesign B3 T13: a waitlisted card says WHERE in the queue the entry is - "You're #{n} on the waiting list" - in place of
// the bare waitlisted note (spec §4.2). The place is the read model's (`waitlist_position`, counted in the order promotion takes the
// queue - registration-waitlist-position.test.ts); the expected words are the dictionaries', filled by the runtime `t`.
describe("EntryCard — a waitlisted entry's place in the queue (B3 T13)", () => {
  const UI = { en: uiEn, es: uiEs, fr: uiFr, nl: uiNl } as const;
  const unescape = (s: string) => s.replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  const render = (over: Partial<EntryCardProps["entry"]>, locale: keyof typeof UI = "en") => {
    const props = baseProps();
    return unescape(
      renderToStaticMarkup(<EntryCard {...props} locale={locale} ui={UI[locale] as Dict} entry={{ ...props.entry, ...over }} />),
    );
  };
  const raw = (locale: keyof typeof UI, key: string): string => {
    const value = (UI[locale] as Record<string, string>)[key];
    expect(typeof value, `premise: ${locale} has ${key}`).toBe("string");
    return value!;
  };

  it("en, typed: You're #2 on the waiting list - and the bare note gives way to it", () => {
    const html = render({ status: "waitlisted", waitlist_position: 2 });
    expect(html).toContain("You're #2 on the waiting list");
    expect(html).toContain('data-testid="reg-status-waitlist-position"');
    expect(html).toContain('data-waitlist-position="2"');
    expect(html).not.toContain(raw("en", "register.status.waitlisted.note"));
  });

  it("each locale states the place in its own words, with the number filled in", () => {
    let judged = 0;
    for (const locale of ["en", "es", "fr", "nl"] as const) {
      const sentence = raw(locale, "register.status.waitlistPosition");
      expect(sentence, `premise: ${locale} names the place`).toContain("{n}");
      const html = render({ status: "waitlisted", waitlist_position: 7 }, locale);
      expect(html, locale).toContain(sentence.replace("{n}", "7"));
      expect(html, `${locale}: no unfilled placeholder`).not.toContain("{n}");
      judged += 1;
    }
    expect(judged, "anti-vacuity: four locales").toBe(4);
  });

  it("the place tracks the entry (a different number renders a different line)", () => {
    expect(render({ status: "waitlisted", waitlist_position: 3 })).toContain("You're #3 on the waiting list");
    expect(render({ status: "waitlisted", waitlist_position: 3 })).not.toContain("You're #2");
  });

  it("a waitlisted entry with no known place keeps the waitlisted note and invents no number", () => {
    const html = render({ status: "waitlisted", waitlist_position: null });
    expect(html).toContain(raw("en", "register.status.waitlisted.note"));
    expect(html).not.toContain('data-testid="reg-status-waitlist-position"');
  });

  it("an entry that is not waitlisted shows no place, even if one were set (the status gates it, not just the field)", () => {
    for (const status of ["pending", "confirmed"] as const) {
      const html = render({ status, waitlist_position: 2 });
      expect(html, status).not.toContain('data-testid="reg-status-waitlist-position"');
      expect(html, status).not.toContain("on the waiting list");
    }
  });
});
