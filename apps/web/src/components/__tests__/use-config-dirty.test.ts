// B7 T23 (spec §9.3) — dirty tracking for the division settings page. `configDirty(saved, draft)` answers "would Save change
// anything, and where?": it compares the two states field by field in the form the save actually sends (the PATCH and PUT bodies
// the hook builds), so a field the save never sends cannot read as changed and a field edited back to its saved value is clean.
// Pure, so it is tested here with no harness; `useConfigDirty` is the same answer with a stable identity, tested at the bottom.
import { afterEach, describe, expect, it, vi } from "vitest";
import { configDirty, useConfigDirty, type ConfigDirty } from "@/components/use-config-dirty";
import {
  toDivisionPatchBody,
  toRegistrationSettingsPutBody,
  type RegistrationConfigState,
} from "@/components/registration-hub-config-state";
import { SECTION_FIELDS, SECTION_IDS, type SectionId } from "@/components/registration-hub-config-panel-sections";
import { editOrgTzDateTimeHalf, orgTzDateTimeHalves } from "@/components/registration-hub-tz-input";
import { renderIsland } from "@/components/__tests__/_hook-harness";

// Every field non-null where the type allows it, so a comparison that only ever saw nulls cannot pass by accident.
const SAVED: RegistrationConfigState = {
  category: "mixed",
  age_min: 10,
  age_max: 18,
  age_cutoff_month: 9,
  age_cutoff_day: 1,
  eligibility_note: "School-registered students only",
  enabled: true,
  entrant_kind: "team",
  // The API's own shape (server/usecases/registrations/settings.ts serialises a Date with toISOString), but WITHOUT the
  // milliseconds: the editor re-derives an instant through `new Date(ms).toISOString()`, which adds ".000". Two spellings of
  // the same instant must compare equal, or editing a date and putting it back would read as an unsaved change.
  opens_at: "2026-01-01T09:00:00Z",
  closes_at: "2026-02-01T23:59:00Z",
  capacity: 32,
  fee_cents: 1500,
  free_agent_fee_cents: 900,
  refund_lock_at: "2026-01-25T12:00:00Z",
  place_by_at: "2026-01-28T18:00:00Z",
  form_fields: [
    { key: "shirt_size", label: "Shirt size", kind: "select", options: ["S", "M", "L"], required: true },
    { key: "diet", label: "Dietary needs", kind: "text", required: false },
  ],
  payment_method: "stripe",
  payment_instructions: "Pay at the desk",
  approval: "manual",
  allow_free_agents: true,
};

const CLEAN: ConfigDirty = { dirty: false, count: 0, sections: [] };

/** A different value of the same shape: what an organiser's edit produces, without knowing which field it is. */
function perturb(value: unknown): unknown {
  if (value === null) return 1;
  if (typeof value === "number") return value + 1;
  if (typeof value === "boolean") return !value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) || !/^\d{4}-/.test(value) ? `${value}!` : new Date(ms + 86_400_000).toISOString();
  }
  if (Array.isArray(value)) return [...value, { key: "extra", label: "Extra", kind: "text", required: false }];
  throw new Error(`perturb: no rule for ${JSON.stringify(value)}`);
}

describe("configDirty — the empty case first", () => {
  it("nothing loaded yet (no saved values, no draft) is clean", () => {
    expect(configDirty(null, null)).toEqual(CLEAN);
  });

  it("a draft with no saved values beside it (the GET has not answered) is clean, never 'everything changed'", () => {
    expect(configDirty(null, SAVED)).toEqual(CLEAN);
    expect(configDirty(SAVED, null)).toEqual(CLEAN);
  });

  it("the saved values against themselves, and against an identical copy, are clean", () => {
    expect(configDirty(SAVED, SAVED)).toEqual(CLEAN);
    expect(configDirty(SAVED, structuredClone(SAVED))).toEqual(CLEAN);
  });
});

describe("configDirty — what counts as a change", () => {
  it("editing capacity then restoring it is clean", () => {
    const edited = { ...SAVED, capacity: 40 };
    expect(configDirty(SAVED, edited)).toEqual({ dirty: true, count: 1, sections: ["capacity"] });
    expect(configDirty(SAVED, { ...edited, capacity: 32 })).toEqual(CLEAN);
  });

  it("editing capacity and fee gives count 2, sections [capacity, money]", () => {
    expect(configDirty(SAVED, { ...SAVED, capacity: 40, fee_cents: 1800 })).toEqual({
      dirty: true,
      count: 2,
      sections: ["capacity", "money"],
    });
  });

  it("counts FIELDS but lists each section once, in the page's section order, whatever order the edits came in", () => {
    // Two money fields and one eligibility field. The fields are walked in the order the save SENDS them (PATCH body, then
    // PUT body), and the PUT body carries `approval` (eligibility) after `fee_cents` and `payment_instructions` (money) — so
    // the walk meets money first, and only the SECTION_IDS order puts eligibility ahead. (A PATCH field such as `category`
    // would be met first anyway and could not tell the two orders apart.)
    const put = Object.keys(toRegistrationSettingsPutBody(SAVED));
    expect(put.indexOf("approval")).toBeGreaterThan(put.indexOf("fee_cents"));
    expect(put.indexOf("approval")).toBeGreaterThan(put.indexOf("payment_instructions"));
    const draft = { ...SAVED, payment_instructions: "Cash only", fee_cents: 2000, approval: "auto" as const };
    expect(configDirty(SAVED, draft)).toEqual({ dirty: true, count: 3, sections: ["eligibility", "money"] });
  });

  it("a cleared optional field (capacity null = no limit) is a change, and so is filling it back", () => {
    expect(configDirty(SAVED, { ...SAVED, capacity: null })).toEqual({ dirty: true, count: 1, sections: ["capacity"] });
    expect(configDirty({ ...SAVED, capacity: null }, SAVED)).toEqual({ dirty: true, count: 1, sections: ["capacity"] });
  });

  it("0 and null are different saved values for the solo price (0 = free, null = charge the team fee)", () => {
    expect(configDirty(SAVED, { ...SAVED, free_agent_fee_cents: 0 }).count).toBe(1);
    expect(configDirty({ ...SAVED, free_agent_fee_cents: 0 }, { ...SAVED, free_agent_fee_cents: null }).count).toBe(1);
  });
});

describe("configDirty — compares what the save SENDS, not object identity", () => {
  it("sign-up questions rebuilt as new objects with the keys in another order are clean (the builder makes a new array on every edit)", () => {
    const rebuilt = SAVED.form_fields.map((f) => {
      const { required, kind, label, key, options } = f;
      return options ? { required, options: [...options], kind, label, key } : { required, kind, label, key };
    });
    expect(rebuilt).not.toBe(SAVED.form_fields);
    expect(configDirty(SAVED, { ...SAVED, form_fields: rebuilt })).toEqual(CLEAN);
  });

  it("a question relabelled and then relabelled back is clean; while it differs it is one change in the form section", () => {
    const relabel = (label: string) => SAVED.form_fields.map((f, i) => (i === 0 ? { ...f, label } : f));
    expect(configDirty(SAVED, { ...SAVED, form_fields: relabel("T-shirt") })).toEqual({
      dirty: true,
      count: 1,
      sections: ["form"],
    });
    expect(configDirty(SAVED, { ...SAVED, form_fields: relabel("Shirt size") })).toEqual(CLEAN);
  });

  it("an `options: undefined` left behind by the builder is the same question as one with no options key (JSON drops it)", () => {
    const withUndefined = SAVED.form_fields.map((f, i) => (i === 1 ? { ...f, options: undefined } : f));
    expect(configDirty(SAVED, { ...SAVED, form_fields: withUndefined })).toEqual(CLEAN);
  });

  it("reordering the questions IS a change (the form shows them in that order)", () => {
    expect(configDirty(SAVED, { ...SAVED, form_fields: [...SAVED.form_fields].reverse() }).count).toBe(1);
  });

  it("each of the four clock fields, moved a day through the real date editor and moved back, is clean", () => {
    const tz = "Europe/London";
    const clocks = ["opens_at", "closes_at", "refund_lock_at", "place_by_at"] as const;
    let checked = 0;
    for (const field of clocks) {
      const halves = orgTzDateTimeHalves(SAVED[field], tz);
      const moved = editOrgTzDateTimeHalf(halves, "date", "2026-03-15", tz);
      expect(moved.incomplete).toBe(false);
      const away = { ...SAVED, [field]: moved.instant };
      expect(configDirty(SAVED, away).count).toBe(1);
      const back = editOrgTzDateTimeHalf(moved.halves, "date", halves.date, tz);
      // The editor's spelling differs from the saved one ("…00.000Z" vs "…00Z"): the guard below is what makes it clean.
      expect(back.instant).not.toBe(SAVED[field]);
      expect(configDirty(SAVED, { ...SAVED, [field]: back.instant })).toEqual(CLEAN);
      checked += 1;
    }
    expect(checked).toBe(clocks.length);
  });

  it("a clock moved by a minute is a change; a cleared clock is a change", () => {
    expect(configDirty(SAVED, { ...SAVED, opens_at: "2026-01-01T09:01:00.000Z" }).count).toBe(1);
    expect(configDirty(SAVED, { ...SAVED, opens_at: null }).count).toBe(1);
  });
});

describe("configDirty — every saved field is tracked, in the section the page shows it in", () => {
  it("a change to any one field reads as exactly one change, in SECTION_FIELDS' section for it", () => {
    const sent = { ...toDivisionPatchBody(SAVED), ...toRegistrationSettingsPutBody(SAVED) };
    const fields = Object.keys(sent) as (keyof RegistrationConfigState)[];
    // The save sends every field the editor holds — none is edited without being saved, so none may go untracked.
    expect(new Set(fields)).toEqual(new Set(Object.keys(SAVED)));
    const sectionOf = (f: string) => SECTION_IDS.find((id) => (SECTION_FIELDS[id] as readonly string[]).includes(f));
    let checked = 0;
    for (const field of fields) {
      const draft = { ...SAVED, [field]: perturb(SAVED[field]) } as RegistrationConfigState;
      const expected = sectionOf(field);
      expect(expected, `${field} has a section`).toBeDefined();
      expect(configDirty(SAVED, draft), field).toEqual({ dirty: true, count: 1, sections: [expected as SectionId] });
      checked += 1;
    }
    expect(checked).toBe(fields.length);
    expect(checked).toBeGreaterThan(0);
  });
});

describe("configDirty — a saved field with no section is refused, not dropped", () => {
  afterEach(() => {
    vi.doUnmock("@/components/registration-hub-config-panel-sections");
    vi.resetModules();
  });

  it("throws naming the field, so a new field added to the save but not to SECTION_FIELDS fails loudly", async () => {
    vi.resetModules();
    vi.doMock("@/components/registration-hub-config-panel-sections", async (importOriginal) => {
      const actual = await importOriginal<typeof import("@/components/registration-hub-config-panel-sections")>();
      return { ...actual, sectionForField: (f: string) => (f === "capacity" ? null : actual.sectionForField(f as never)) };
    });
    const fresh = await import("@/components/use-config-dirty");
    // An unchanged field never asks for its section; only the changed one does.
    expect(fresh.configDirty(SAVED, SAVED)).toEqual(CLEAN);
    expect(() => fresh.configDirty(SAVED, { ...SAVED, capacity: 40 })).toThrow(/capacity/);
  });
});

describe("useConfigDirty — the same answer, with an identity that holds while the answer does", () => {
  it("hands back the SAME object while the summary is unchanged, and a new one when it moves", () => {
    const seen: ConfigDirty[] = [];
    type ProbeProps = { saved: RegistrationConfigState | null; draft: RegistrationConfigState | null };
    function Probe(p: ProbeProps) {
      seen.push(useConfigDirty(p.saved, p.draft));
      return null;
    }
    const initial: ProbeProps = { saved: null, draft: null };
    const island = renderIsland(Probe, initial);
    expect(seen.at(-1)).toEqual(CLEAN);
    island.rerender({ saved: SAVED, draft: { ...SAVED } });
    expect(seen.at(-1)).toBe(seen[0]);
    island.rerender({ saved: SAVED, draft: { ...SAVED, capacity: 40 } });
    const first = seen.at(-1)!;
    expect(first).toEqual({ dirty: true, count: 1, sections: ["capacity"] });
    // A second keystroke in the same field: still one change in Capacity, so a caller keyed on the object does not re-fire.
    island.rerender({ saved: SAVED, draft: { ...SAVED, capacity: 41 } });
    expect(seen.at(-1)).toBe(first);
    island.rerender({ saved: SAVED, draft: { ...SAVED, capacity: 41, fee_cents: 1 } });
    expect(seen.at(-1)).not.toBe(first);
    expect(seen.at(-1)).toEqual({ dirty: true, count: 2, sections: ["capacity", "money"] });
    island.rerender({ saved: SAVED, draft: SAVED });
    expect(seen.at(-1)).toEqual(CLEAN);
  });
});
