// Finding E, settings walkthrough W2 (owner ruled 2026-09-05: fixed now, not
// deferred). The org switcher sits in the identity row on
// /o/{org}/settings?tab=organization — a customer-facing control — and shipped
// its copy as English literals, so every non-English organiser read English
// there. This pins the copy to the `ui` catalog IN ALL FOUR LOCALES.
//
// Why the hook harness rather than renderToStaticMarkup: three of the five
// strings live inside `{open && …}` and one more inside `busy === o.id`, so a
// static render never reaches them at all — a suite built on it would witness
// the trigger and silently skip the popover. `_hook-harness` supplies React's
// dispatcher, so the popover can be opened and an org clicked the way a person
// would. `useMsg` is stubbed to read the REAL locale JSON (never a fixture
// table typed into this file), so a key deleted from any one locale renders
// `‹missing:…›` and reds here instead of falling back to English in silence.
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { OrgMembership } from "@/lib/types";
import { propsOf, renderIsland, textOf } from "./_hook-harness";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {} }),
  usePathname: () => "/o/alpha/settings",
}));

// Never resolves: `switchTo` sets `busy` synchronously and clears it in its
// `finally`, so a promise that never settles is what holds the "Switching…"
// branch on screen long enough to assert on it.
vi.mock("@/lib/client", () => ({ api: () => new Promise(() => {}) }));

let lookup: (key: string) => string = (key) => key;
vi.mock("@/components/i18n/dict-provider", () => ({
  useMsg: () => (key: string) => lookup(key),
}));

// Imported after the mocks are declared; vitest hoists `vi.mock` above it.
import { OrgSwitcher } from "../org-switcher";

const DICTS: Record<string, Record<string, string>> = { en, es, fr, nl };
const LOCALES = ["en", "es", "fr", "nl"] as const;

/** Every key this control reads. `role.*` is the shared catalog org-team.tsx
 *  and settings/page.tsx already use for the same badge. */
const KEYS = [
  "settings.org.switch",
  "settings.org.switch.aria",
  "settings.org.switch.busy",
  "settings.org.switch.active",
  "settings.org.switch.new",
  "role.owner",
  "role.admin",
] as const;

const org = (id: string, name: string, slug: string, role: string): OrgMembership =>
  ({
    id,
    name,
    slug,
    role,
    created_by: null,
    created_at: "2026-01-01T00:00:00Z",
    logo_url: null,
    logo_storage_path: null,
    branding: null,
    timezone: null,
  }) as OrgMembership;

const ORGS = [org("o1", "Alpha Club", "alpha", "owner"), org("o2", "Beta Club", "beta", "admin")];

beforeAll(() => {
  // The outside-click effect only registers once the popover is open, and this
  // suite is `environment: "node"` with no jsdom. Two no-op listeners are all
  // the effect touches.
  if (!("document" in globalThis)) {
    (globalThis as { document?: unknown }).document = {
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  }
});

/** Drive the control the way a person does: read the trigger, open the
 *  popover, then start a switch to the OTHER org so the busy row renders. */
function driveInLocale(locale: string) {
  const dict = DICTS[locale]!;
  lookup = (key) => dict[key] ?? `‹missing:${key}›`;

  const island = renderIsland(OrgSwitcher, { orgs: ORGS, activeId: "o1" });
  const trigger = island.tree().find((el) => propsOf(el)["aria-haspopup"] === "menu");
  if (!trigger) throw new Error("no popover trigger rendered — the island did not mount");
  const ariaLabel = String(propsOf(trigger)["aria-label"] ?? "");

  (propsOf(trigger).onClick as () => void)();

  const other = island
    .tree()
    .find((el) => el.type === "button" && textOf(el).includes("Beta Club"));
  if (!other) throw new Error("the popover did not list the other org");
  (propsOf(other).onClick as () => void)();

  return { ariaLabel, text: island.text() };
}

describe("org switcher i18n (finding E)", () => {
  it("every locale carries all five switcher keys plus the role badges", () => {
    // The parity assertion, stated before any render: a key missing from one
    // locale would otherwise fall back to English and read as a pass.
    for (const locale of LOCALES) {
      for (const key of KEYS) {
        expect(typeof DICTS[locale]![key], `${locale}/${key}`).toBe("string");
      }
    }
  });

  it.each(LOCALES)("renders %s copy from that locale's own dictionary", (locale) => {
    const dict = DICTS[locale];
    const { ariaLabel, text } = driveInLocale(locale);

    // Expectations derived from the dictionary, never a table typed in here —
    // a copy change moves the test with it instead of leaving it asserting
    // yesterday's wording.
    expect(ariaLabel).toBe(dict["settings.org.switch.aria"]);
    expect(text).toContain(dict["settings.org.switch"]);
    expect(text).toContain(dict["settings.org.switch.busy"]);
    expect(text).toContain(dict["settings.org.switch.active"]);
    expect(text).toContain(dict["settings.org.switch.new"]);
    expect(text).toContain(dict["role.owner"]);
    expect(text).toContain(dict["role.admin"]);
    expect(`${ariaLabel} ${text}`).not.toContain("‹missing:");
  });

  it("shows a French organiser no English at all", () => {
    // The differential case: without it the suite above is satisfied by a
    // build that still hardcodes English, because English IS one of the four.
    const { ariaLabel, text } = driveInLocale("fr");
    expect(ariaLabel).not.toContain("Switch");
    expect(text).not.toContain("Switch");
    expect(text).not.toContain("+ New organization");
    expect(text).not.toContain("owner");
    expect(text).not.toContain("admin");
  });

  it("keeps the English strings the two org-switch e2e specs select on", () => {
    // e2e/org-switch.spec.ts and e2e/org-management.spec.ts both click by
    // accessible name; the English value is their selector.
    expect(en["settings.org.switch.aria"]).toBe("Switch organisation");
    expect(en["settings.org.switch"]).toBe("Switch");
  });

  it("translates the new keys rather than pasting English into all four", () => {
    // "Active" is a correct French word for this badge and coincides with the
    // English — the only legitimate identity, and it is named so the rest of
    // the matrix cannot quietly acquire company.
    const IDENTICAL_IS_CORRECT = new Set(["fr:settings.org.switch.active"]);
    const NEW_KEYS = KEYS.filter((k) => k.startsWith("settings.org.switch"));
    for (const locale of ["es", "fr", "nl"]) {
      for (const key of NEW_KEYS) {
        if (IDENTICAL_IS_CORRECT.has(`${locale}:${key}`)) continue;
        expect(DICTS[locale]![key], `${locale}/${key}`).not.toBe(
          (en as Record<string, string>)[key],
        );
      }
    }
  });
});
