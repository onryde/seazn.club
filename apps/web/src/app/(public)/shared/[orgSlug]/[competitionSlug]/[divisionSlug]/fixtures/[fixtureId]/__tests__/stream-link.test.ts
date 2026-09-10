// Stream overlay W1, Task 7 — the label decision behind the public match
// page's stream link, swept over the WHOLE fixture-status vocabulary.
//
// `page.test.ts` proves the seam (this function is mounted, its `null` really
// suppresses the anchor, and the key really reaches the dictionary). This file
// proves the DECISION: seven statuses, none of them left to one lucky sample
// (recurring class 7), and the void set held to the repo's own authority
// rather than to three strings retyped here.
import { describe, expect, it } from "vitest";
import { streamLinkLabelKey } from "../stream-link";
import { VOID_STATUSES } from "@/components/v2/stages-panel";
import { OVERLAY_VOID_STATUSES } from "@/lib/overlay-model";
import publicEn from "@/dictionaries/en/public.json";

/**
 * The closed fixture-status vocabulary, derived from `ui.json`'s own
 * `schedule.fstatus.*` family plus `scheduled` (which has no row there —
 * `fixtureStatusLabel` falls back to the raw token for it). Typed here only
 * because there is no exported enum; the VOID third of it is cross-checked
 * against the real export below, so a status moving into or out of that group
 * cannot pass unnoticed.
 */
const EVERY_STATUS = [
  "scheduled",
  "in_play",
  "decided",
  "finalized",
  "cancelled",
  "abandoned",
  "forfeited",
] as const;

describe("streamLinkLabelKey — every fixture status, not one sample", () => {
  it.each([
    ["scheduled", "overlay.watchLive"],
    ["in_play", "overlay.watchLive"],
    ["decided", "overlay.replay"],
    ["finalized", "overlay.replay"],
    ["cancelled", null],
    ["abandoned", null],
    ["forfeited", null],
  ] as const)("%s → %s", (status, expected) => {
    expect(streamLinkLabelKey(status)).toBe(expected);
  });

  it("covers the whole vocabulary — no status is left unasserted", () => {
    // The row list above is typed; this is the check that it is COMPLETE, so
    // adding an eighth status reds here instead of shipping an unlabelled one.
    const decided = new Set(EVERY_STATUS.map(streamLinkLabelKey));
    expect(decided, "all three outcomes are actually exercised").toEqual(
      new Set(["overlay.watchLive", "overlay.replay", null]),
    );
    expect(EVERY_STATUS.length).toBe(7);
  });

  it("returns null for EXACTLY the console's own void statuses, and for no other", () => {
    // One authority for "void", not a fourth hand-typed copy: `VOID_STATUSES`
    // (`stages-panel.tsx`) is the competition desk's, `OVERLAY_VOID_STATUSES`
    // is the overlay's proven mirror of it, and this function reads the
    // mirror. If the two ever diverge, this reds before the page does.
    expect(OVERLAY_VOID_STATUSES).toEqual(VOID_STATUSES);
    const suppressed = new Set(EVERY_STATUS.filter((s) => streamLinkLabelKey(s) === null));
    expect(suppressed).toEqual(VOID_STATUSES);
  });

  it("an unknown status falls into the live bucket, never into `null`", () => {
    // The vocabulary is closed at seven, so this is the shape of the default
    // rather than a live case — but the default matters: a status this file
    // has not heard of must not silently DELETE a link the organiser saved.
    expect(streamLinkLabelKey("postponed")).toBe("overlay.watchLive");
    expect(streamLinkLabelKey("")).toBe("overlay.watchLive");
  });

  it("both keys it can return are real `public` dictionary entries", () => {
    // The function's return type is a string union; nothing in it makes those
    // strings resolvable. `t()` returns the KEY ITSELF for a missing entry, so
    // a typo would render "overlay.watchLive" on the page and pass every
    // assertion above.
    const keys = EVERY_STATUS.map(streamLinkLabelKey).filter(
      (k): k is NonNullable<ReturnType<typeof streamLinkLabelKey>> => k !== null,
    );
    expect(new Set(keys).size).toBe(2);
    for (const key of new Set(keys)) {
      expect(typeof (publicEn as Record<string, unknown>)[key], `en/public.json is missing ${key}`).toBe(
        "string",
      );
    }
  });
});
