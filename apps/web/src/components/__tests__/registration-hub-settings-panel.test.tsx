// RS004 W2 — the Settings tab's designed frame for this wave. Real division
// rows and the config panel land in RS004 W3; this is deliberately data-free
// (no props beyond the resolved copy), so the test only has to prove it
// renders the copy it is given and carries no "TODO"-shaped placeholder text.
//
// `textOf`/`walk` rather than `renderToStaticMarkup`: this workspace has no
// jsdom, and React's static-markup renderer HTML-escapes text content (an
// apostrophe becomes `&#x27;`), so a `.toContain()` check against the raw
// dictionary string is a false red against real copy, not a real failure.
import { describe, expect, it } from "vitest";
import { propsOf, textOf, walk } from "@/components/__tests__/_hook-harness";
import { RegistrationHubSettingsPanel } from "@/components/registration-hub-settings-panel";
import { t } from "@/lib/i18n-runtime";
import uiEn from "@/dictionaries/en/ui.json";

const title = t(uiEn, "reg.hub.settings.title");
const body = t(uiEn, "reg.hub.settings.body");

function tree() {
  return walk(RegistrationHubSettingsPanel({ title, body }));
}

describe("RegistrationHubSettingsPanel", () => {
  it("renders the title and body it is given", () => {
    const text = textOf(RegistrationHubSettingsPanel({ title, body }));
    expect(text).toContain(title);
    expect(text).toContain(body);
  });

  it("is a designed frame, never a literal TODO placeholder", () => {
    const text = textOf(RegistrationHubSettingsPanel({ title, body }));
    expect(text).not.toContain("TODO");
  });

  it("carries its own data hook for e2e/regression targeting", () => {
    const root = tree()[0]!;
    expect(propsOf(root)).toHaveProperty("data-registration-hub-settings-panel");
  });
});
