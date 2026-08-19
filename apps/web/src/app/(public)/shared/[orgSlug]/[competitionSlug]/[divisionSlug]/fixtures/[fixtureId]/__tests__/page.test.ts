// P6 fix round 1, finding #2 (CRITICAL, addition beyond the review's literal
// 4-file list): this fixture detail PAGE has the exact same bug pattern as
// bracket.tsx/schedule.tsx/og-model.ts/slideshow-data.ts (a hardcoded-English
// msg() with no way to reach a real locale) and is explicitly named as an
// affected "fixture" surface in the finding's own text, even though the
// dispatch's file list cites og/model.ts (the OG card) for that word. Same
// bug, same fix: resolve via the org's own default_locale.
//
// generateMetadata is a plain async function (no render) — the cheapest,
// highest-confidence way to prove the fix, and it computes home/away with
// the exact same formula the default export's page body duplicates.
import { describe, expect, it, vi } from "vitest";
import { isValidElement } from "react";

const getPublicFixture = vi.fn();
vi.mock("@/server/public-site/data", () => ({
  getPublicFixture: (...a: unknown[]) => getPublicFixture(...a),
}));

const baseData = (locale: string, fixtureOver: Record<string, unknown> = {}) => ({
  org: { id: "o1", name: "Test Org", slug: "test-org", branded: false, branding: {}, logo: null, about: null, default_locale: locale, card_payments: false },
  competition: { id: "c1", org_id: "o1", name: "Test Comp", slug: "test-comp", description: null, starts_on: null, ends_on: null, branding: {}, status: "active", visibility: "public" },
  division: { id: "d1", competition_id: "c1", name: "Open", slug: "open", description: null, sport_key: "generic", variant_key: "score", status: "active", module_version: "1.0.0", tiebreakers: null, sport_name: null, entrant_count: 2 },
  fixture: {
    id: "f1", division_id: "d1", stage_id: "s1", pool_id: null, round_no: 1, seq_in_round: 1,
    home_entrant_id: null, away_entrant_id: null, home_slot_label: null, away_slot_label: null,
    scheduled_at: null, venue: null, court_label: null, venue_name: null, court_name: null,
    status: "scheduled", outcome: null, summary: null, last_seq: null,
    ...fixtureOver,
  },
  entrantNames: {},
  realtime: false,
});

const meta = async (locale: string, fixtureOver: Record<string, unknown> = {}) => {
  getPublicFixture.mockResolvedValue(baseData(locale, fixtureOver));
  const { generateMetadata } = await import("../page");
  return generateMetadata({
    params: Promise.resolve({ orgSlug: "test-org", competitionSlug: "test-comp", divisionSlug: "open", fixtureId: "f1" }),
  });
};

describe("FixturePage generateMetadata — org-locale slot labels (P6 finding #2)", () => {
  it("resolves both slots via the org's default_locale, not hardcoded English", async () => {
    const m = await meta("es", {
      home_slot_label: { key: "slot.winner_group", params: { g: "A" } },
      away_slot_label: { key: "slot.winner_group", params: { g: "B" } },
    });
    expect(m.title).toBe("Ganador del Grupo A vs Ganador del Grupo B — Open");
  });

  it("English org still reads exactly as before (back-compat)", async () => {
    const m = await meta("en", {
      home_slot_label: { key: "slot.winner_group", params: { g: "A" } },
      away_slot_label: { key: "slot.winner_group", params: { g: "B" } },
    });
    expect(m.title).toBe("Winner of Group A vs Winner of Group B — Open");
  });
});

// P9 pass 3c-3: fixture.venue/court_label are frozen since pass 3a — this
// page's default export (subheading text + SportsEvent JSON-LD) must render
// venue_name/court_name (data.ts's derived, join-backed fields) instead.
// No jsdom: walk the returned element tree, same convention as
// officials-fixture-locale.test.tsx / server-component-page-test memory.
function collectText(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join("");
  if (isValidElement(node)) {
    return collectText((node.props as { children?: unknown }).children);
  }
  return "";
}

function findScript(node: unknown): { props: Record<string, unknown> } | null {
  if (!isValidElement(node)) return null;
  if (node.type === "script") return node as unknown as { props: Record<string, unknown> };
  const children = (node.props as { children?: unknown }).children;
  if (Array.isArray(children)) {
    for (const c of children) {
      const hit = findScript(c);
      if (hit) return hit;
    }
    return null;
  }
  return findScript(children);
}

const render = async (fixtureOver: Record<string, unknown> = {}) => {
  getPublicFixture.mockResolvedValue(baseData("en", fixtureOver));
  const { default: FixturePage } = await import("../page");
  return FixturePage({
    params: Promise.resolve({ orgSlug: "test-org", competitionSlug: "test-comp", divisionSlug: "open", fixtureId: "f1" }),
  });
};

describe("FixturePage default export — derived court/venue name (P9 cutover)", () => {
  it("subheading shows venue_name/court_name, never the stale venue/court_label", async () => {
    const tree = await render({
      venue: "Stale Building",
      court_label: "Stale Court",
      venue_name: "Riverside Sports Hall",
      court_name: "Court 3",
    });
    const text = collectText(tree);
    expect(text).toContain("Riverside Sports Hall");
    expect(text).toContain("Court 3");
    expect(text).not.toContain("Stale Building");
    expect(text).not.toContain("Stale Court");
  });

  it("SportsEvent JSON-LD location is the derived venue_name, not the stale venue", async () => {
    const tree = await render({ venue: "Stale Building", venue_name: "Riverside Sports Hall" });
    const script = findScript(tree);
    expect(script).not.toBeNull();
    const html = (script!.props.dangerouslySetInnerHTML as { __html: string }).__html;
    const ld = JSON.parse(html) as { location?: { name?: string } };
    expect(ld.location?.name).toBe("Riverside Sports Hall");
    expect(html).not.toContain("Stale Building");
  });

  it("no venue_name at all omits JSON-LD location, never a blank/undefined placeholder", async () => {
    const tree = await render({});
    const script = findScript(tree);
    const html = (script!.props.dangerouslySetInnerHTML as { __html: string }).__html;
    const ld = JSON.parse(html) as { location?: unknown };
    expect(ld.location).toBeUndefined();
  });
});
