// W5 app PR A, Task 2 — the round-robin refusal table (`lib/roundrobin-refusals.ts`) pinned against the plan's code list, the
// plan's sentences and the four dictionaries, as knockout-refusals.test.ts does for the knockout table: a code added without
// copy, or copy added in one locale only, is red here and not a raw wire code on an organiser's screen.
import { describe, expect, it } from "vitest";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { HttpError } from "@/lib/errors";
import { ROUND_ROBIN_REFUSALS, isRoundRobinRefusalCode, roundRobinRefusalKey, type RoundRobinRefusalCode } from "@/lib/roundrobin-refusals";
import { roundRobinRefusal } from "@/server/usecases/roundrobin-refusal";

// The plan's table (Task 2, `lib/roundrobin-refusals.ts`), typed here rather than read from the table under test: a code
// dropped from the table, a status changed or a sentence reworded fails the equality. A later task that changes a row changes
// it here in the same commit. The sentence of RR_CUT_EXCEEDS_FIELD is Task 12b's (the plan names only its status).
const PLAN: Record<string, { status: 409 | 422; en: string }> = {
  RR_GENERATE_AFTER_START: { status: 409, en: "Play has started, so Generate won't change the fixtures. Players waiting to join are listed on this stage: use Add to the table." },
  RR_LATE_ENTRY_STAGE_COMPLETE: { status: 422, en: "This table has finished. Late players can't join it." },
  RR_LATE_ENTRY_NOTHING_TO_ADD: { status: 422, en: "This player already has a fixture against everyone in the pool." },
  RR_LATE_ENTRY_NOT_UNDOABLE: { status: 409, en: "Adding a late player can't be undone. Withdraw the player instead." },
  RR_LATE_ENTRY_NOT_WAITING: { status: 409, en: "This player isn't waiting for a place." },
  RR_LATE_ENTRY_ALREADY_PLACED: { status: 409, en: "This player already has their fixtures." },
  RR_LATE_ENTRY_UNKNOWN_POOL: { status: 422, en: "There's no pool with that name in this stage." },
  RR_SUBSTITUTE_PARTNER_REFUSED: { status: 422, en: "A pair can't change partners once play has started. Withdraw the pair and add a new one." },
  RR_ADHOC_ROUND_INVALID: { status: 422, en: "That round doesn't exist yet. Pick an existing round or the next one." },
  RR_RANK_OVERRIDE_POOL: { status: 422, en: "Each rank can be pinned once per pool, and never above the pool's size." },
  RR_RANK_OVERRIDE_NOT_TABLE: { status: 422, en: "Ranks can only be pinned on a league, group, Swiss or americano table." },
  // B4 fix wave (m4): a pin on a pooled stage before its pools are drawn.
  RR_RANK_OVERRIDE_UNDRAWN_POOLS: { status: 422, en: "Draw the pools first: a rank is pinned within its pool." },
  RR_CUT_EXCEEDS_FIELD: { status: 422, en: "{qualified} can't qualify from this field: it can supply at most {max}." },
  // Task 2 fix round 1 (controller ruling): the knockout's KO_REDRAW_WOULD_CLEAR_SETUP, for a league or group.
  RR_REGENERATE_WOULD_CLEAR_SETUP: {
    status: 409,
    en: "The table would have to be drawn again, which clears match setup already on its lines (officials, team sheets, scoring devices, streams, player availability or court calls). Use Rebuild fixtures — it lists what it clears first.",
  },
  // B1 batch C1: the same redraw over a table holding an Add match row.
  RR_REGENERATE_WOULD_DROP_ADD_MATCH: {
    status: 409,
    en: "The table would have to be drawn again, which removes the matches you added with Add match. Rebuild fixtures removes them too: note them down first, then use it.",
  },
  // Final fix wave (m1): deleting a setup-phase entrant whose line holds recorded match data. Typed here, from the brief's sentence.
  ENTRANT_FIXTURES_HAVE_RESULTS: { status: 409, en: "This entrant's fixtures hold recorded match data. Clear it before deleting the entrant." },
};

const LOCALES = { en, es, fr, nl } as Record<string, Record<string, string>>;
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("ROUND_ROBIN_REFUSALS (W5 app PR A, Task 2)", () => {
  it("holds exactly the plan's twelve codes plus the reviews' four, each with the plan's status and sentence", () => {
    expect(Object.keys(ROUND_ROBIN_REFUSALS).sort()).toEqual(Object.keys(PLAN).sort());
    expect(Object.keys(PLAN).length).toBe(16);
    let checked = 0;
    for (const [code, want] of Object.entries(PLAN)) {
      const row = ROUND_ROBIN_REFUSALS[code as RoundRobinRefusalCode];
      expect({ status: row.status, en: row.en }, code).toEqual(want);
      checked++;
    }
    expect(checked).toBe(16);
  });

  it("every code has a key present, translated, in all 4 dictionaries, and en says what the server says", () => {
    let checked = 0;
    for (const [code, row] of Object.entries(ROUND_ROBIN_REFUSALS) as [RoundRobinRefusalCode, (typeof ROUND_ROBIN_REFUSALS)[RoundRobinRefusalCode]][]) {
      expect(row.key, code).toBe(`roundrobin.refusal.${code}`);
      expect(roundRobinRefusalKey(code), code).toBe(row.key);
      expect([409, 422], `${code}: a refusal is a 409 or 422`).toContain(row.status);
      for (const [locale, dict] of Object.entries(LOCALES)) {
        const text = dict[row.key];
        expect(typeof text === "string" && text.trim() !== "", `${code}: ${locale}/ui.json has ${row.key}`).toBe(true);
        expect(placeholders(text!), `${code}: ${locale} placeholders match en`).toEqual(placeholders(row.en));
        if (locale !== "en") expect(text, `${code}: ${locale} is translated, not the English`).not.toBe(row.en);
        checked++;
      }
      expect(en[row.key as keyof typeof en], `${code}: en/ui.json says what the server says`).toBe(row.en);
    }
    // Anti-vacuity: every (code, locale) pair. Zero checked is a failure, not a pass.
    expect(checked, "(code, locale) pairs checked").toBe(16 * 4);
  });

  it("isRoundRobinRefusalCode: true for every code, false for any other wire code or a prototype name", () => {
    let yes = 0;
    for (const code of Object.keys(PLAN)) {
      expect(isRoundRobinRefusalCode(code), code).toBe(true);
      yes++;
    }
    expect(yes).toBe(16);
    const others = ["KO_GENERATE_AFTER_START", "SWISS_BYE_NOT_PLACEABLE", "rr_generate_after_start", "", "toString", "__proto__", "constructor", undefined, null, 409];
    for (const other of others) expect(isRoundRobinRefusalCode(other), String(other)).toBe(false);
    expect(others.length).toBe(10);
  });

  it("roundRobinRefusal builds the HttpError from the row: status, code, English and details; a hole in the sentence is refused by name", () => {
    const err = roundRobinRefusal("RR_GENERATE_AFTER_START", { stageId: "s1" });
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 409, code: "RR_GENERATE_AFTER_START", message: PLAN.RR_GENERATE_AFTER_START!.en });
    expect(err.extra).toMatchObject({ stageId: "s1" });
    const cut = roundRobinRefusal("RR_CUT_EXCEEDS_FIELD", { qualified: 8, max: 6 });
    expect(cut).toMatchObject({ status: 422, code: "RR_CUT_EXCEEDS_FIELD", message: "8 can't qualify from this field: it can supply at most 6." });
    expect(() => roundRobinRefusal("RR_CUT_EXCEEDS_FIELD")).toThrow(/RR_CUT_EXCEEDS_FIELD.*qualified/);
    expect(() => roundRobinRefusal("RR_CUT_EXCEEDS_FIELD", { qualified: 8 })).toThrow(/max/);
  });
});
