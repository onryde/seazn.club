// RS004 W2 — the Registrants tab's placeholder: designed, not a TODO. RS005
// wires the real table (filters, row expand, approve/reject/promote); this
// panel's copy names that capability in plain language, no ticket reference,
// and points the organiser at the one thing that IS live this wave
// (Settings).
//
// `textOf`/`walk` rather than `renderToStaticMarkup`: this workspace has no
// jsdom, and React's static-markup renderer HTML-escapes text content (an
// apostrophe becomes `&#x27;`), so a `.toContain()` check against the raw
// dictionary string is a false red against real copy, not a real failure.
import { describe, expect, it } from "vitest";
import { propsOf, textOf, walk } from "@/components/__tests__/_hook-harness";
import { RegistrationHubRegistrantsPanel } from "@/components/registration-hub-registrants-panel";
import Link from "@/components/ui/console-link";
import { t } from "@/lib/i18n-runtime";
import uiEn from "@/dictionaries/en/ui.json";

const title = t(uiEn, "reg.hub.registrants.title");
const body = t(uiEn, "reg.hub.registrants.body");
const ctaLabel = t(uiEn, "reg.hub.registrants.cta");
const ctaHref = "/o/acme/c/summer-smash/registration?tab=settings";

function tree() {
  return walk(RegistrationHubRegistrantsPanel({ title, body, ctaLabel, ctaHref }));
}

describe("RegistrationHubRegistrantsPanel", () => {
  it("renders the title, body, and CTA it is given", () => {
    const text = textOf(RegistrationHubRegistrantsPanel({ title, body, ctaLabel, ctaHref }));
    expect(text).toContain(title);
    expect(text).toContain(body);
    expect(text).toContain(ctaLabel);
  });

  it("is a designed empty state, never a literal TODO placeholder", () => {
    const text = textOf(RegistrationHubRegistrantsPanel({ title, body, ctaLabel, ctaHref }));
    expect(text).not.toContain("TODO");
  });

  it("points its CTA at the href it is given (the Settings tab)", () => {
    const link = tree().find((e) => e.type === Link);
    expect(link).toBeTruthy();
    expect(propsOf(link!).href).toBe(ctaHref);
  });

  it("carries its own data hook for e2e/regression targeting", () => {
    const root = tree()[0]!;
    expect(propsOf(root)).toHaveProperty("data-registration-hub-registrants-panel");
  });
});
