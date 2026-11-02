// Match Day E2 item 6 — the Hide row and the Hide button speak the viewer's language, in all four locales. Same locale-bound
// `useMsg` double as device-link-panel-i18n.test.tsx. Expected copy is read from each locale's own dictionary file; the check
// that matters is that every shape RENDERS it (a key nothing renders is untranslated copy nobody sees) and that no locale falls
// back to English for the words this change added.
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { DeviceLinkPanel } from "@/components/v2/device-link-panel";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { t } from "@/lib/i18n-runtime";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";

const active = vi.hoisted(() => ({ locale: "en", live: true }));

vi.mock("@/components/i18n/dict-provider", async () => {
  const { t: translate } = await import("@/lib/i18n-runtime");
  const dicts: Record<string, unknown> = {
    en: (await import("@/dictionaries/en/ui.json")).default,
    es: (await import("@/dictionaries/es/ui.json")).default,
    fr: (await import("@/dictionaries/fr/ui.json")).default,
    nl: (await import("@/dictionaries/nl/ui.json")).default,
  };
  return {
    useMsg:
      () =>
      (key: string, vars?: Record<string, string | number>): string =>
        translate(dicts[active.locale] as never, key as never, vars),
  };
});
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: vi.fn(async () => (active.live ? { id: "l1", label: null, expires_at: null, created_at: "2026-10-31T10:00:00.000Z" } : null)),
  };
});

const DICTS = { en, es, fr, nl } as unknown as Record<string, Parameters<typeof t>[0]>;
const LOCALES = Object.keys(DICTS);
const NEW_KEYS = ["dlink.hide", "dlink.hideLabel", "dlink.linkReady", "dlink.noLink", "dlink.copied"] as const;
const PROPS = { fixtureId: "f1", sportKey: "badminton", viewerPlan: "pro" as const, embedded: true, compact: true };
const byTestId = (tree: ReactElement[], id: string) => tree.find((el) => propsOf(el)["data-testid"] === id);
async function flush() {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("the Hide copy in every locale", () => {
  it("every new key exists, is non-empty and is not a raw key in all four locales; es/fr/nl differ from English (count reported)", () => {
    let checked = 0;
    for (const locale of LOCALES) {
      for (const key of NEW_KEYS) {
        const text = t(DICTS[locale]!, key);
        expect(text, `${locale} ${key}`).not.toBe(key);
        expect(text.trim().length, `${locale} ${key}`).toBeGreaterThan(0);
        if (locale !== "en") expect(text, `${locale} ${key} is translated`).not.toBe(t(DICTS.en!, key));
        checked++;
      }
    }
    expect(checked).toBe(4 * NEW_KEYS.length);
  });

  it("the open panel's Hide button reads in the locale (visible word and accessible name)", async () => {
    let checked = 0;
    for (const locale of LOCALES) {
      active.locale = locale;
      active.live = true;
      const island = renderIsland(DeviceLinkPanel, {
        ...PROPS,
        hide: { storageKey: "k", heading: <h3>x</h3>, initiallyOpen: true, followLink: false },
      });
      await flush();
      const hideButton = byTestId(island.tree(), "device-link-hide")!;
      expect(textOf(hideButton), locale).toBe(t(DICTS[locale]!, "dlink.hide"));
      expect(propsOf(hideButton)["aria-label"], locale).toBe(t(DICTS[locale]!, "dlink.hideLabel"));
      checked++;
    }
    expect(checked).toBe(4);
  });

  it("the hidden row reads in the locale: link ready / no link yet, and its buttons", async () => {
    let checked = 0;
    for (const locale of LOCALES) {
      for (const live of [true, false]) {
        active.locale = locale;
        active.live = live;
        const island = renderIsland(DeviceLinkPanel, {
          ...PROPS,
          hide: { storageKey: "k", heading: <h3>x</h3>, initiallyOpen: false, followLink: false },
        });
        await flush();
        const tree = island.tree();
        const d = DICTS[locale]!;
        expect(textOf(byTestId(tree, "device-link-row-state")!), `${locale} live=${live}`).toContain(t(d, live ? "dlink.linkReady" : "dlink.noLink"));
        if (live) {
          expect(textOf(byTestId(tree, "device-link-row-show")!), locale).toBe(t(d, "dlink.showQr"));
          expect(textOf(byTestId(tree, "device-link-row-copy")!), locale).toBe(t(d, "dlink.copy"));
        } else {
          expect(textOf(byTestId(tree, "device-link-row-create")!), locale).toBe(t(d, "dlink.create"));
        }
        checked++;
      }
    }
    expect(checked).toBe(8);
  });
});
