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
    },
    cart: {
      expires_at: null,
      charges_enabled: true,
      instructionsHtml: null,
      currency: "gbp",
      timezone: "UTC",
    },
    orgSlug: "org",
    competitionSlug: "comp",
    token: "tok",
    locale: "en",
    ui: uiEn as Dict,
  };
}

describe("EntryCard — a displayNameById miss never falls back to the raw p.full_name", () => {
  it("the claim-link text stays clear of the raw name even when rosterPlayerDisplayName's own map entry is missing", () => {
    const html = renderToStaticMarkup(<EntryCard {...baseProps()} />);
    expect(html).not.toContain(RAW_LEAK_SENTINEL);
  });

  it("the roster-name span (the pre-existing, already-correct behaviour) renders blank on the same miss", () => {
    // Pins the CURRENT behaviour the claim-link fix now matches, so a future
    // edit cannot quietly diverge the two again in the other direction.
    const html = renderToStaticMarkup(<EntryCard {...baseProps()} />);
    expect(html).toContain(">Not checked in<"); // the badge still renders
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
