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
