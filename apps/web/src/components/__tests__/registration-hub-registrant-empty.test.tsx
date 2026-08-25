// RS005 W2a — the Registrants tab's shared empty-state shell, used for BOTH
// of task 5's two (deliberately different) empty states: "no registrations
// at all" (RS004's designed placeholder treatment, reused byte-for-byte —
// icon/title/body/cta) and "filters matched nothing" (same shell, different
// icon/copy/cta). One component, two callers, so the visual TREATMENT can
// never drift between the two even though their content does.
import { describe, expect, it } from "vitest";
import { propsOf, textOf, walk } from "@/components/__tests__/_hook-harness";
import { RegistrationHubRegistrantEmpty } from "@/components/registration-hub-registrant-empty";
import Link from "@/components/ui/console-link";
import { ClipboardList, SearchX } from "lucide-react";

const PROPS = {
  icon: ClipboardList,
  title: "No one's registered yet",
  body: "Once a division opens, every entry lands here.",
  ctaLabel: "Go to Settings",
  ctaHref: "/o/acme/c/summer-smash/registration?tab=settings",
  variant: "empty" as const,
};

describe("RegistrationHubRegistrantEmpty", () => {
  it("renders the title, body and cta it is given", () => {
    const text = textOf(RegistrationHubRegistrantEmpty(PROPS));
    expect(text).toContain(PROPS.title);
    expect(text).toContain(PROPS.body);
    expect(text).toContain(PROPS.ctaLabel);
  });

  it("points its cta at the href it is given", () => {
    const link = walk(RegistrationHubRegistrantEmpty(PROPS)).find((e) => e.type === Link);
    expect(link).toBeTruthy();
    expect(propsOf(link!).href).toBe(PROPS.ctaHref);
  });

  it("renders the icon it is given", () => {
    const icon = walk(RegistrationHubRegistrantEmpty(PROPS)).find((e) => e.type === ClipboardList);
    expect(icon).toBeTruthy();
  });

  it("swaps icons cleanly for the 'filtered' variant — the two states are not the same component with only text changed", () => {
    const filteredIcon = walk(
      RegistrationHubRegistrantEmpty({ ...PROPS, icon: SearchX, variant: "filtered" }),
    ).find((e) => e.type === SearchX);
    expect(filteredIcon).toBeTruthy();
  });

  it("carries a variant-tagged data hook so the two empty states are distinguishable in the DOM (e2e/regression)", () => {
    const root = walk(RegistrationHubRegistrantEmpty(PROPS))[0]!;
    expect(propsOf(root)["data-registration-hub-registrant-empty"]).toBe("empty");

    const filteredRoot = walk(RegistrationHubRegistrantEmpty({ ...PROPS, variant: "filtered" }))[0]!;
    expect(propsOf(filteredRoot)["data-registration-hub-registrant-empty"]).toBe("filtered");
  });

  it("is a designed empty state, never a literal TODO placeholder", () => {
    const text = textOf(RegistrationHubRegistrantEmpty(PROPS));
    expect(text).not.toContain("TODO");
  });
});
