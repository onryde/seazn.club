// T18 / B1-R4: an archived channel's label is a database literal in ENGLISH ("YouTube channel (disconnected)", token-store.ts). Every
// place the Streaming page names a destination reads it through `youtubeTargetLabel`, so a Spanish, French or Dutch organiser never sees
// the English. youtube-connect-panel.test.tsx proves the visible title (static markup); this file proves the two places that exist only
// after a tap - the phone menu's accessible name and the Remove dialog's title - which static markup cannot reach and which the English
// catalog cannot discriminate (there the localized wording IS the literal). So `useMsg` here is the real dictionary of the locale under test.
//
// Sport: not applicable. Expected values are built from the locale dictionaries by key, never from the code under test.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement } from "react";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";

const state = vi.hoisted(() => ({ dict: {} as Record<string, string>, asked: [] as Record<string, unknown>[] }));
vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  return {
    ...actual,
    useMsg: () => (key: string, vars?: Record<string, string | number>) =>
      Object.entries(vars ?? {}).reduce((s, [n, v]) => s.replaceAll(`{${n}}`, String(v)), state.dict[key] ?? key),
  };
});
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => async (opts: Record<string, unknown>) => {
    state.asked.push(opts);
    return false;
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));

import { LOCALES } from "@/lib/i18n-constants";
import { YOUTUBE_DISCONNECTED_LABEL } from "@/lib/youtube";
import type { StreamTarget } from "@/server/api-v1/schemas";
import { DestinationRow } from "../stream-destinations-panel";

const localeDict = (l: string): Record<string, string> =>
  JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "dictionaries", l, "ui.json"), "utf8")) as Record<string, string>;
const fill = (s: string, vars: Record<string, string>) => Object.entries(vars).reduce((r, [n, v]) => r.replaceAll(`{${n}}`, v), s);
const target = (label: string): StreamTarget => ({
  id: "t-1", kind: "youtube", label, watchUrl: null, createdAt: "2026-09-12T10:00:00.000Z", keyHint: "8hd", inUse: null, youtube: null,
});
const attr = (el: ReactElement, name: string): unknown => propsOf(el)[name];
const byTestId = (tree: ReactElement[], id: string) => tree.find((el) => attr(el, "data-testid") === id);
const tap = async (el: ReactElement | undefined): Promise<void> => {
  const onClick = el && (propsOf(el).onClick as ((e?: unknown) => unknown) | undefined);
  if (!onClick) throw new Error("no onClick on that element - the test is asserting nothing");
  await onClick({ preventDefault: () => {}, stopPropagation: () => {} });
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => { state.asked.length = 0; });

describe("T18: an archived channel's label in the phone menu and the Remove dialog (the places only a tap reaches)", () => {
  it("in es, fr and nl the menu's accessible name and the Remove dialog's title carry the locale's wording, never the English literal - and the customer's own label passes through (anti-vacuity: 3 locales x 3 surfaces)", async () => {
    let checked = 0;
    for (const locale of LOCALES.filter((l) => l !== "en")) {
      const dict = localeDict(locale);
      state.dict = dict;
      const localized = dict["streaming.youtube.disconnectedLabel"]!;
      expect(localized, `${locale}: premise - a wording of its own`).not.toBe(YOUTUBE_DISCONNECTED_LABEL);

      for (const [label, shown] of [[YOUTUBE_DISCONNECTED_LABEL, localized], ["Club YouTube", "Club YouTube"]] as const) {
        state.asked.length = 0;
        const row = renderIsland(DestinationRow, { t: target(label), canEdit: true, locale, orgId: "o", run: async () => ({ ok: true, value: null }) } as never);
        const button = byTestId(row.tree(), "stream-dest-menu");
        expect(attr(button!, "aria-label"), `${locale} / ${label}: the menu button's name`).toBe(fill(dict["streamDest.more"]!, { label: shown }));
        await tap(button);
        const menu = row.tree().find((el) => attr(el, "role") === "menu");
        expect(attr(menu!, "aria-label"), `${locale} / ${label}: the open menu's name`).toBe(fill(dict["streamDest.more"]!, { label: shown }));
        await tap(byTestId(row.tree(), "stream-dest-menu-remove"));
        expect(state.asked, `${locale} / ${label}: the Remove dialog opened`).toHaveLength(1);
        expect(state.asked[0]!.title, `${locale} / ${label}: the dialog's title`).toBe(fill(dict["streamDest.confirmRemove.title"]!, { label: shown }));
        if (label === YOUTUBE_DISCONNECTED_LABEL) {
          for (const surface of [attr(button!, "aria-label"), attr(menu!, "aria-label"), state.asked[0]!.title]) expect(String(surface)).not.toContain(YOUTUBE_DISCONNECTED_LABEL);
        }
        checked++;
      }
    }
    expect(checked).toBe((LOCALES.length - 1) * 2);
  });
});
