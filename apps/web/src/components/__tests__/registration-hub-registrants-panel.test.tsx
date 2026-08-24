// RS004 W2 — the Registrants tab's placeholder: designed, not a TODO. RS005
// wires the real table (filters, row expand, approve/reject/promote); this
// panel's copy names that capability in plain language, no ticket reference,
// and points the organiser at the one thing that IS live this wave (Settings).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RegistrationHubRegistrantsPanel } from "@/components/registration-hub-registrants-panel";
import { t } from "@/lib/i18n-runtime";
import uiEn from "@/dictionaries/en/ui.json";

function render(ctaHref = "/o/acme/c/summer-smash/registration?tab=settings"): string {
  return renderToStaticMarkup(
    <RegistrationHubRegistrantsPanel
      title={t(uiEn, "reg.hub.registrants.title")}
      body={t(uiEn, "reg.hub.registrants.body")}
      ctaLabel={t(uiEn, "reg.hub.registrants.cta")}
      ctaHref={ctaHref}
    />,
  );
}

describe("RegistrationHubRegistrantsPanel", () => {
  it("renders the title, body, and CTA it is given", () => {
    const html = render();
    expect(html).toContain(t(uiEn, "reg.hub.registrants.title"));
    expect(html).toContain(t(uiEn, "reg.hub.registrants.body"));
    expect(html).toContain(t(uiEn, "reg.hub.registrants.cta"));
  });

  it("is a designed empty state, never a literal TODO placeholder", () => {
    expect(render()).not.toContain("TODO");
  });

  it("points its CTA at the href it is given (the Settings tab)", () => {
    const html = render("/o/acme/c/summer-smash/registration?tab=settings");
    expect(html).toContain('href="/o/acme/c/summer-smash/registration?tab=settings"');
  });

  it("carries its own data hook for e2e/regression targeting", () => {
    expect(render()).toContain("data-registration-hub-registrants-panel");
  });
});
