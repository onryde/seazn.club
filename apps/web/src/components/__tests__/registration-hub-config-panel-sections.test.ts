// TEMP(RS004 variants) — shared section/field grouping for config-panel
// variants B (accordion) and C (tabs). See registration-hub-config-panel-
// sections.ts's header. Pure, so tested directly with no harness.
import { describe, expect, it } from "vitest";
import {
  SECTION_IDS,
  SECTION_FIELDS,
  sectionForField,
  firstErrorSection,
} from "@/components/registration-hub-config-panel-sections";

describe("SECTION_FIELDS — every ConfigFieldKey is covered exactly once", () => {
  it("covers all 15 known fields with no duplicates across sections", () => {
    const all = SECTION_IDS.flatMap((id) => SECTION_FIELDS[id]);
    expect(all).toHaveLength(15);
    expect(new Set(all).size).toBe(15);
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
