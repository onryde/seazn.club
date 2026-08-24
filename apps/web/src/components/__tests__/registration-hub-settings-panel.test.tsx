// RS004 W2 — the Settings tab's designed frame for this wave. Real division
// rows and the config panel land in RS004 W3; this is deliberately data-free
// (no props beyond the resolved copy), so the test only has to prove it
// renders the copy it is given and carries no "TODO"-shaped placeholder text.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RegistrationHubSettingsPanel } from "@/components/registration-hub-settings-panel";
import { t } from "@/lib/i18n-runtime";
import uiEn from "@/dictionaries/en/ui.json";

function render(): string {
  return renderToStaticMarkup(
    <RegistrationHubSettingsPanel
      title={t(uiEn, "reg.hub.settings.title")}
      body={t(uiEn, "reg.hub.settings.body")}
    />,
  );
}

describe("RegistrationHubSettingsPanel", () => {
  it("renders the title and body it is given", () => {
    const html = render();
    expect(html).toContain(t(uiEn, "reg.hub.settings.title"));
    expect(html).toContain(t(uiEn, "reg.hub.settings.body"));
  });

  it("is a designed frame, never a literal TODO placeholder", () => {
    const html = render();
    expect(html).not.toContain("TODO");
  });

  it("carries its own data hook for e2e/regression targeting", () => {
    expect(render()).toContain("data-registration-hub-settings-panel");
  });
});
