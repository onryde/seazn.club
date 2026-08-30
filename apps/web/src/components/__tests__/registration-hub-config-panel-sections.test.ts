// Registration hub config panel — section/field grouping (RS004 W3c/W4).
// See registration-hub-config-panel-sections.ts's header. Pure, so tested
// directly with no harness.
import { describe, expect, it } from "vitest";
import {
  SECTION_IDS,
  SECTION_FIELDS,
  sectionForField,
  firstErrorSection,
} from "@/components/registration-hub-config-panel-sections";

describe("SECTION_FIELDS — every ConfigFieldKey is covered exactly once", () => {
  // RS007/V380 added age_cutoff_month/age_cutoff_day/eligibility_note (15 -> 18).
  it("covers all 18 known fields with no duplicates across sections", () => {
    const all = SECTION_IDS.flatMap((id) => SECTION_FIELDS[id]);
    expect(all).toHaveLength(18);
    expect(new Set(all).size).toBe(18);
  });
});

describe("sectionForField", () => {
  it("maps a field to its section", () => {
    expect(sectionForField("fee_cents")).toBe("money");
    expect(sectionForField("age_max")).toBe("eligibility");
    expect(sectionForField("capacity")).toBe("capacity");
    expect(sectionForField("form_fields")).toBe("form");
    expect(sectionForField("closes_at")).toBe("schedule");
  });

  it("maps the RS007/V380 cutoff + note fields to eligibility, alongside category/age_min/age_max", () => {
    expect(sectionForField("age_cutoff_month")).toBe("eligibility");
    expect(sectionForField("age_cutoff_day")).toBe("eligibility");
    expect(sectionForField("eligibility_note")).toBe("eligibility");
  });
});

describe("firstErrorSection", () => {
  it("returns null when there are no errors", () => {
    expect(firstErrorSection({})).toBeNull();
  });

  it("finds the section for a single error", () => {
    expect(firstErrorSection({ fee_cents: "too low" })).toBe("money");
  });

  it("picks the FIRST section in declaration order when errors span sections — deterministic, not object key order", () => {
    // form_fields (section "form", declared last) and age_max (section
    // "eligibility", declared first) together — must resolve to
    // "eligibility" regardless of which key was inserted into the object
    // first, since object literal key order would otherwise make this test
    // pass by accident.
    expect(firstErrorSection({ form_fields: "dup keys", age_max: "bad band" })).toBe("eligibility");
  });
});
