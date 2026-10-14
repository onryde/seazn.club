// The Americano and player-stats panels LOAD on mount, through a `load`
// callback that is the mount effect's only dep. On a failure with no message
// of its own, `load` wrote a TRANSLATED fallback into state, so it closed over
// `msg` — and `react-hooks/exhaustive-deps` asked for `msg` in its deps.
//
// Listing it would have been wrong: `msg`'s identity follows the provider's
// `dict` prop, so a new catalog object would hand the effect a new `load` and
// re-run the mount fetch. Leaving it out (the old code) was wrong too: the
// stored sentence stayed in the old language. The fix stores WHAT failed
// (the server's sentence, or the fallback's KEY) and translates at render, so
// `load` reads no copy at all. These tests pin both halves:
//   - one GET, before and after a catalog change (the "listing it" mutant
//     reds here with two);
//   - the fallback reads in the catalog the panel has NOW (the old code reds
//     here: it kept the English sentence).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderIsland } from "@/components/__tests__/_hook-harness";
import { msgFor } from "@/lib/messages-i18n";

const h = vi.hoisted(() => ({
  locale: "en" as "en" | "es",
  gets: [] as string[],
  /** What a GET throws — a bare string, i.e. a failure with no message. */
  throws: "socket hang up" as unknown,
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: async (url: string) => {
      h.gets.push(url);
      throw h.throws;
    },
  };
});

vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  const { msgFor: lookup } = await import("@/lib/messages-i18n");
  type Key = Parameters<typeof lookup>[1];
  const bound = {
    en: (k: Key, v?: Record<string, string | number>) => lookup("en", k, v),
    es: (k: Key, v?: Record<string, string | number>) => lookup("es", k, v),
  };
  return { ...actual, useMsg: () => bound[h.locale] };
});

import { AmericanoPanel } from "@/components/v2/americano-panel";
import { StatsPanel } from "@/components/v2/stats-panel";

const flush = () => new Promise((r) => setTimeout(r, 5));

describe.each([
  {
    name: "AmericanoPanel",
    mount: () => renderIsland(AmericanoPanel, { stageId: "s1", canEdit: true, viewerPlan: "community" as const }),
    again: (i: { rerender: (p: never) => void }) =>
      i.rerender({ stageId: "s1", canEdit: true, viewerPlan: "community" } as never),
    key: "americano.failedLoad" as const,
  },
  {
    name: "StatsPanel",
    mount: () => renderIsland(StatsPanel, { divisionId: "d1", viewerPlan: "community" as const }),
    again: (i: { rerender: (p: never) => void }) =>
      i.rerender({ divisionId: "d1", viewerPlan: "community" } as never),
    key: "stats.failed" as const,
  },
])("$name — a load failure is stored as a fact and translated at render", ({ mount, again, key }) => {
  beforeEach(() => {
    h.locale = "en";
    h.gets.length = 0;
    h.throws = "socket hang up";
  });

  it("the fallback follows a catalog change, and the change does not re-fetch", async () => {
    expect(msgFor("es", key)).not.toBe(msgFor("en", key));
    const panel = mount();
    await flush();
    expect(h.gets).toHaveLength(1);
    expect(panel.text().trim()).toBe(msgFor("en", key));

    h.locale = "es";
    again(panel);
    await flush();

    expect(panel.text().trim()).toBe(msgFor("es", key));
    expect(h.gets).toHaveLength(1);
  });

  it("a failure that carries its own sentence shows that sentence, in either catalog", async () => {
    h.throws = new Error("Stage not found.");
    const panel = mount();
    await flush();
    expect(panel.text().trim()).toBe("Stage not found.");

    h.locale = "es";
    again(panel);
    await flush();
    expect(panel.text().trim()).toBe("Stage not found.");
    expect(h.gets).toHaveLength(1);
  });
});
