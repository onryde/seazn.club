import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import en from "@/dictionaries/en/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import {
  SWISS_PAIRING_NOT_SWISS_CODE,
  SWISS_PAIRING_NOT_SWISS_MESSAGE,
  SWISS_PAIRING_ROUND_ONE_ONLY_CODE,
  SWISS_PAIRING_ROUND_ONE_ONLY_MESSAGE,
} from "@/lib/swiss-pairing";
import {
  StagesPanel,
  attachmentWarning,
  classifyActError,
  rebuildBlockedMessage,
} from "@/components/v2/stages-panel";
import { ApiV1Error } from "@/lib/client-v1";
import { msg } from "@/lib/messages";
import { msgFor } from "@/lib/messages-i18n";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

// F3 Task 5 (5a/5b) — the roster-drift banner StagesPanel renders per stage,
// fed getStageRosterDrift's result as a server prop (division page). No DOM
// interaction here (renderToStaticMarkup never fires effects/handlers — see
// stages-panel-delete.test.tsx's identical harness) — these are pure
// prop-in/HTML-out assertions, plus the classifier's own unit tests below.
const STAGE = {
  id: "s1", seq: 0, kind: "league", name: "League",
  config: {}, progression: null, status: "active",
};
const baseProps = {
  divisionId: "d1", competitionId: "c1", orgSlug: "org", compSlug: "comp", divSlug: "div",
  stages: [STAGE],
  fixtures: [],
  entrantNames: { e1: "Alpha", e2: "Bravo" },
  canEdit: true,
  tz: "UTC",
  orgTz: "UTC",
  canExport: false,
  viewerPlan: "community" as const,
};
const GHOST_DRIFT = {
  s1: { ghosts: [{ id: "e1", display_name: "Withdrawn Wendy" }], unplaced: [] },
};
const UNPLACED_DRIFT = {
  s1: { ghosts: [], unplaced: [{ id: "e3", display_name: "New Nadia" }] },
};
const NO_DRIFT = {
  s1: { ghosts: [], unplaced: [] },
};

const banner = /data-testid="roster-drift-banner"/;

describe("StagesPanel — roster-drift banner (F3 Task 5)", () => {
  it("shows the banner and the ghost's name when a withdrawn entrant is still on the board", () => {
    const html = renderToStaticMarkup(<StagesPanel {...baseProps} rosterDrift={GHOST_DRIFT} />);
    expect(html).toMatch(banner);
    expect(html).toContain("Withdrawn Wendy");
    expect(html).toMatch(/data-roster-drift-state="ghosts"/);
  });

  it("shows the banner and the entrant's name for the unplaced-only direction", () => {
    const html = renderToStaticMarkup(<StagesPanel {...baseProps} rosterDrift={UNPLACED_DRIFT} />);
    expect(html).toMatch(banner);
    expect(html).toContain("New Nadia");
    expect(html).toMatch(/data-roster-drift-state="unplaced"/);
  });

  it("hides the banner once both arrays are empty (board matches the roster)", () => {
    const html = renderToStaticMarkup(<StagesPanel {...baseProps} rosterDrift={NO_DRIFT} />);
    expect(html).not.toMatch(banner);
  });

  it("hides the banner when rosterDrift is omitted entirely (optional prop, default {})", () => {
    const html = renderToStaticMarkup(<StagesPanel {...baseProps} />);
    expect(html).not.toMatch(banner);
  });

  // W3 item 6 (review finding M3). Swiss pairs ONE ROUND AT A TIME. A
  // designed sit-out is now a real bye fixture (swissGen persists
  // pairRound's `bye`), so it no longer appears in `unplaced`. What still
  // does: an entrant added before the next round is generated. The soft
  // banner tells the organiser to wait for Pair next, and withholds the
  // btn-danger "Rebuild fixtures" that would delete the round.
  const SWISS_STAGE = { ...STAGE, kind: "swiss", name: "Swiss" };
  const swissProps = { ...baseProps, stages: [SWISS_STAGE] };
  const rebuild = /data-testid="roster-drift-rebuild"/;

  it("swiss + unplaced-only: says it is waiting for the next round, and offers NO destructive rebuild", () => {
    const html = renderToStaticMarkup(<StagesPanel {...swissProps} rosterDrift={UNPLACED_DRIFT} />);
    // Positive pair first: without this, every assertion below is satisfied by
    // a banner that did not render at all.
    expect(html, "no banner rendered -- the absences below prove nothing").toMatch(banner);
    expect(html).toContain("New Nadia");
    expect(html).toMatch(/data-roster-drift-state="swiss-awaiting-pairing"/);
    expect(html, "the destructive rebuild CTA is still offered on a swiss stage between rounds").not.toMatch(
      rebuild,
    );
    expect(html, "the swiss copy did not render").toContain(en["progression.rosterDrift.swissHeading"]);
    // Anchored on the entity-free half of "Fixtures don't match the roster":
    // React escapes the apostrophe to &#x27;, so a `toContain` on the raw
    // dictionary string never matches -- which would make this NEGATIVE
    // assertion pass in every state, including the one it exists to catch.
    expect(html, "the false alarm copy is still shown").not.toContain("match the roster");
  });

  // The fix is SPECIFIC, not "swiss never drifts". A ghost -- a withdrawn
  // entrant still named on a live fixture -- is wrong on swiss exactly as
  // anywhere else, and keeps both the warning and the remedy.
  it("swiss + a ghost: keeps the full warning AND the rebuild button", () => {
    const html = renderToStaticMarkup(<StagesPanel {...swissProps} rosterDrift={GHOST_DRIFT} />);
    expect(html).toMatch(banner);
    expect(html).toMatch(/data-roster-drift-state="ghosts"/);
    expect(html, "a real ghost lost its remedy on a swiss stage").toMatch(rebuild);
    expect(html, "the real warning copy is missing").toContain("match the roster");
  });

  it("a NON-swiss stage with the same unplaced-only drift is untouched -- warning and rebuild both stay", () => {
    const html = renderToStaticMarkup(<StagesPanel {...baseProps} rosterDrift={UNPLACED_DRIFT} />);
    expect(html).toMatch(/data-roster-drift-state="unplaced"/);
    expect(html, "the league stage lost its rebuild CTA").toMatch(rebuild);
    expect(html, "the real warning copy is missing").toContain("match the roster");
  });

  it("hides the banner from viewers (canEdit=false), even with real drift", () => {
    const html = renderToStaticMarkup(
      <StagesPanel {...baseProps} canEdit={false} rosterDrift={GHOST_DRIFT} />,
    );
    expect(html).not.toMatch(banner);
  });

  it("hides the banner once the stage is complete — a rebuild there would always refuse", () => {
    const html = renderToStaticMarkup(
      <StagesPanel {...baseProps} stages={[{ ...STAGE, status: "complete" }]} rosterDrift={GHOST_DRIFT} />,
    );
    expect(html).not.toMatch(banner);
  });
});

describe("rebuildBlockedMessage — StagesPanel rebuild-click classifier", () => {
  it("returns the translated blocked notice for 409 STAGE_HAS_RESULTS", () => {
    const err = new ApiV1Error("this stage has fixtures with a recorded result", 409, "STAGE_HAS_RESULTS", {});
    expect(rebuildBlockedMessage(err, msg)).toBe(msg("progression.rosterDrift.blockedNotice"));
  });

  it("returns null for an unrelated ApiV1Error (falls through to the generic error banner)", () => {
    const err = new ApiV1Error("boom", 500, "INTERNAL", {});
    expect(rebuildBlockedMessage(err, msg)).toBeNull();
  });

  it("returns null for the defence-in-depth 422 STAGE_NOT_ROOT — this panel never offers the button there, so it's the generic banner if it's ever reached directly", () => {
    const err = new ApiV1Error("not eligible", 422, "STAGE_NOT_ROOT", {});
    expect(rebuildBlockedMessage(err, msg)).toBeNull();
  });

  it("returns null for a plain Error (not an ApiV1Error)", () => {
    expect(rebuildBlockedMessage(new Error("network down"), msg)).toBeNull();
  });

  it("returns null for PAYMENT_REQUIRED so the paywall gate still wins", () => {
    const err = new ApiV1Error("upgrade", 402, "PAYMENT_REQUIRED", { feature_key: "formats.advanced" });
    expect(rebuildBlockedMessage(err, msg)).toBeNull();
  });
});

// F3 ultrareview finding 5 — `delete from fixtures` CASCADEs into
// fixture_officials, lineups and device_links, none of which blocks the
// rebuild the way a recorded result does. Before this, the confirm dialog
// said only "every fixture is deleted and regenerated" while silently taking
// a whole day's referee appointments with it.
describe("attachmentWarning — what the rebuild clears besides fixtures", () => {
  const drift = (attachments: { officials: number; lineups: number; deviceLinks: number }) => ({
    ghosts: [],
    unplaced: [],
    attachments,
  });

  it("names every non-zero kind, joined for the locale", () => {
    const out = attachmentWarning(drift({ officials: 6, lineups: 2, deviceLinks: 1 }), msg, "en");
    expect(out).toContain("6 official assignment(s)");
    expect(out).toContain("2 team sheet(s)");
    expect(out).toContain("1 linked scoring device(s)");
    expect(out).toContain("and"); // Intl.ListFormat conjunction, not a hardcoded ", "
  });

  it("lists only the non-zero kinds", () => {
    const out = attachmentWarning(drift({ officials: 4, lineups: 0, deviceLinks: 0 }), msg, "en");
    expect(out).toContain("4 official assignment(s)");
    expect(out).not.toContain("team sheet");
    expect(out).not.toContain("scoring device");
  });

  it("adds nothing to click through when nothing is attached", () => {
    expect(attachmentWarning(drift({ officials: 0, lineups: 0, deviceLinks: 0 }), msg, "en")).toBe("");
  });

  it("is inert for a drift payload that predates the field, and for no drift at all", () => {
    expect(attachmentWarning({ ghosts: [], unplaced: [] }, msg, "en")).toBe("");
    expect(attachmentWarning(undefined, msg, "en")).toBe("");
  });

  // `msg` is the English-only lookup (lib/messages.ts); the localized path
  // is msgFor/useMsg. Bound here so this covers the real four-locale copy,
  // not just the en catalog — a missing fr key would fall back to English
  // and fail these two `toContain`s.
  it("localises — the fr dictionary's own wording", () => {
    const frMsg: typeof msg = (key, vars) => msgFor("fr", key, vars);
    const out = attachmentWarning(drift({ officials: 2, lineups: 1, deviceLinks: 0 }), frMsg, "fr");
    expect(out).toContain("2 désignation(s) d'officiel");
    expect(out).toContain("1 feuille(s) de match");
    expect(out).toContain("Elle supprime aussi");
  });

  // Scorer sheets, owner ruling Q4 (2026-09-23): the rebuild's `delete from
  // fixtures` CASCADEs `device_links`, so every printed QR on the stage dies
  // with it. The count includes revoked links (known and accepted).
  it("warns that printed scorer sheets stop working — only when device links are attached (owner ruling Q4)", () => {
    const withLinks = attachmentWarning(drift({ officials: 0, lineups: 0, deviceLinks: 2 }), msg, "en");
    expect(withLinks).toContain("Printed scorer sheets for this stage will stop working.");
    const without = attachmentWarning(drift({ officials: 3, lineups: 0, deviceLinks: 0 }), msg, "en");
    expect(without).not.toContain("scorer sheets");
    expect(without).not.toBe(""); // the negative pair still warns about the officials
  });
});

// F3 ultrareview findings 4 and 10 — how a failed generate/complete lands on
// the organiser. Both were the same shape: the panel had one branch for
// "everything else" and it showed `err.message` in red.
describe("classifyActError — amber vs red, and whether the board is stale", () => {
  it("a completion that committed but whose seeding failed is amber, carries the reason, and refreshes", () => {
    const err = new ApiV1Error(
      "entrant e1 qualifies through more than one source or take rule",
      409,
      "STAGE_COMPLETED_SEEDING_FAILED",
      {},
    );
    const out = classifyActError(err, msg, "en");
    expect(out.tone).toBe("warning");
    // Red would say "it failed" about an action that half-succeeded.
    expect(out.refresh).toBe(true);
    expect(out.text).toContain("qualifies through more than one");
    expect(out.text).toContain("Stage completed");
  });

  it("localises a SEEDING_* code instead of showing the server's English", () => {
    const err = new ApiV1Error(
      "seeded_map source \"A1\" matches more than one qualifier",
      422,
      "SEEDING_MAP_SOURCE_AMBIGUOUS",
      {},
    );
    const en = classifyActError(err, msg, "en");
    const fr = classifyActError(err, msg, "fr");
    expect(en.tone).toBe("error");
    expect(en.text).not.toContain("seeded_map"); // not the raw wire message
    expect(fr.text).not.toBe(en.text); // …and it actually translates
    expect(fr.text).toContain("qualifié");
  });

  it("falls back to the server message for a code with no wired copy — never a raw code, never a wrong guess", () => {
    const err = new ApiV1Error("stage not found", 404, "NOT_FOUND", {});
    const out = classifyActError(err, msg, "en");
    expect(out).toEqual({ tone: "error", text: "stage not found", refresh: false });
  });

  it("a precondition failure stays amber and does not refresh — nothing changed server-side", () => {
    const err = new ApiV1Error("too few", 422, "STAGE_NOT_READY", {
      reason: "group_too_few_entrants",
      groups: 2,
      required: 4,
      entrants: 3,
    });
    const out = classifyActError(err, msg, "en");
    expect(out.tone).toBe("warning");
    expect(out.refresh).toBe(false);
  });

  it("a non-ApiV1 error still surfaces its own message", () => {
    expect(classifyActError(new Error("network down"), msg, "en")).toEqual({
      tone: "error",
      text: "network down",
      refresh: false,
    });
  });

  // Swiss round-1 pairing, review ruling R4: the server's English
  // `*_MESSAGE` must never reach the desk. Without the mapping these fall
  // through to `seedingErrorMessage`, which echoes the wire sentence.
  it.each([
    [SWISS_PAIRING_ROUND_ONE_ONLY_CODE, SWISS_PAIRING_ROUND_ONE_ONLY_MESSAGE],
    [SWISS_PAIRING_NOT_SWISS_CODE, SWISS_PAIRING_NOT_SWISS_MESSAGE],
  ])("a refused pairing pick (%s) shows the dictionary line, never the server's English, and re-reads the board", (code, wire) => {
    const err = new ApiV1Error(wire, 422, code, {});
    const out = classifyActError(err, msg, "en");
    expect(out.text).toBe(en["schedule.pairing.error.roundOneOnly"]);
    expect(out.text).not.toContain(wire);
    // The desk offered a pick the server says is gone — its board is stale.
    expect(out.refresh).toBe(true);
    expect(out.tone).toBe("warning");
    // …and the line is the organiser's locale, not English.
    const frOut = classifyActError(err, (k, v) => msgFor("fr", k as never, v), "fr");
    expect(frOut.text).toBe(fr["schedule.pairing.error.roundOneOnly"]);
    expect(frOut.text).not.toBe(out.text);
  });
});
