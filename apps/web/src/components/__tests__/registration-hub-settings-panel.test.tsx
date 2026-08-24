// RS004 W3 — the Settings tab panel: an empty-frame (no divisions yet,
// unchanged from W2) or a list of division rows, one `RegistrationHubRow`
// per division, fed by the page's single server-side query.
//
// `textOf`/`walk` rather than `renderToStaticMarkup`: this workspace has no
// jsdom, and React's static-markup renderer HTML-escapes text content (an
// apostrophe becomes `&#x27;`), so a `.toContain()` check against the raw
// dictionary string is a false red against real copy, not a real failure.
import { describe, expect, it } from "vitest";
import { propsOf, textOf, walk } from "@/components/__tests__/_hook-harness";
import { RegistrationHubSettingsPanel } from "@/components/registration-hub-settings-panel";
import {
  RegistrationHubDivisionRow,
  type RegistrationHubRowData,
  type RegistrationHubRowContext,
} from "@/components/registration-hub-division-row";
import { t } from "@/lib/i18n-runtime";
import uiEn from "@/dictionaries/en/ui.json";

const title = t(uiEn, "reg.hub.settings.title");
const body = t(uiEn, "reg.hub.settings.body");

const CONTEXT: RegistrationHubRowContext = {
  dict: uiEn,
  now: new Date("2026-06-15T12:00:00Z"),
  orgTz: "UTC",
  currency: "usd",
  registerHref: "/shared/riverside/summer-league/register",
  registerQrFileName: "register-summer-league.png",
  showRegisterLink: true,
};

const ROW: RegistrationHubRowData = {
  division_id: "div-1",
  name: "Open Singles",
  category: null,
  age_min: null,
  age_max: null,
  enabled: true,
  entrant_kind: "individual",
  opens_at: null,
  closes_at: null,
  capacity: null,
  fee_cents: 0,
  approval: "auto",
  allow_free_agents: false,
  taken: 0,
};

describe("RegistrationHubSettingsPanel — empty (no divisions yet)", () => {
  it("renders the title and body it is given", () => {
    const text = textOf(RegistrationHubSettingsPanel({ title, body, rows: [], context: CONTEXT }));
    expect(text).toContain(title);
    expect(text).toContain(body);
  });

  it("is a designed frame, never a literal TODO placeholder", () => {
    const text = textOf(RegistrationHubSettingsPanel({ title, body, rows: [], context: CONTEXT }));
    expect(text).not.toContain("TODO");
  });

  it("carries its own data hook for e2e/regression targeting", () => {
    const tree = walk(RegistrationHubSettingsPanel({ title, body, rows: [], context: CONTEXT }));
    const root = tree[0]!;
    expect(propsOf(root)).toHaveProperty("data-registration-hub-settings-panel");
  });
});

describe("RegistrationHubSettingsPanel — populated", () => {
  it("renders one RegistrationHubDivisionRow per division, in the given order", () => {
    const rows = [ROW, { ...ROW, division_id: "div-2", name: "Open Doubles" }];
    const tree = walk(RegistrationHubSettingsPanel({ title, body, rows, context: CONTEXT }));
    const rendered = tree.filter((e) => e.type === RegistrationHubDivisionRow);
    expect(rendered).toHaveLength(2);
    expect(propsOf(rendered[0]!).row).toMatchObject({ division_id: "div-1" });
    expect(propsOf(rendered[1]!).row).toMatchObject({ division_id: "div-2" });
  });

  it("threads the shared context to every row unchanged", () => {
    const tree = walk(RegistrationHubSettingsPanel({ title, body, rows: [ROW], context: CONTEXT }));
    const row = tree.find((e) => e.type === RegistrationHubDivisionRow)!;
    expect(propsOf(row).context).toBe(CONTEXT);
  });

  it("does not render the empty-frame copy once there is at least one row", () => {
    const text = textOf(RegistrationHubSettingsPanel({ title, body, rows: [ROW], context: CONTEXT }));
    expect(text).not.toContain(body);
  });

  it("still carries the panel's own data hook when populated", () => {
    const tree = walk(RegistrationHubSettingsPanel({ title, body, rows: [ROW], context: CONTEXT }));
    const root = tree[0]!;
    expect(propsOf(root)).toHaveProperty("data-registration-hub-settings-panel");
  });
});
