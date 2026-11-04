// The division logo upload, driven through the REAL DivisionSettings: pick a file on the (General-group) file input and read
// the banner `run()` renders. FU5 made every Error that is not a fetch rejection keep its message, and the upload's three
// own failures - a file that is not a usable image, a failed conversion, a refused storage PUT - used to be bare English
// Errors ("bad image", "image conversion failed", "upload failed (403)"). `lib/__tests__/division-logo-upload.test.ts` proves the
// two helpers; this proves the component hands them ITS `msg` (the reader's locale) and shows what they throw - the seam
// a helper test cannot see.
//
// Interactive hook harness, not renderToStaticMarkup: a change on the input has to re-run the component's state. `useMsg` is
// swapped for a reader over the locale under test (the harness has no provider tree), so the sweep covers all four locales.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import en from "@/dictionaries/en/ui.json";
import es from "@/dictionaries/es/ui.json";
import fr from "@/dictionaries/fr/ui.json";
import nl from "@/dictionaries/nl/ui.json";

type Dict = Record<string, string>;
const LOCALES = [["en", en], ["es", es], ["fr", fr], ["nl", nl]] as const;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/components/ui/confirm-provider", () => ({
  useConfirm: () => vi.fn(async () => false),
}));

const state = vi.hoisted(() => ({
  dict: {} as Record<string, string>,
  calls: [] as { url: string; method?: string; json?: unknown }[],
  impl: (async () => ({})) as (url: string, options?: { method?: string; json?: unknown }) => Promise<unknown>,
}));

vi.mock("@/components/i18n/dict-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/i18n/dict-provider")>();
  return {
    ...actual,
    useMsg: () => (key: string, vars?: Record<string, string | number>) =>
      (state.dict[key] ?? key).replace(/\{(\w+)\}/g, (hole, name: string) => (vars !== undefined && name in vars ? String(vars[name]) : hole)),
  };
});
vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual,
    apiV1: (url: string, options?: { method?: string; json?: unknown }) => {
      state.calls.push({ url, method: options?.method, json: options?.json });
      return state.impl(url, options);
    },
  };
});

import { DivisionSettings } from "@/components/v2/division-settings";
import { engineEntrantKinds } from "@/lib/__tests__/_engine-entrant-kinds";

const baseProps = {
  division: { id: "d1", name: "Open", sport_key: "football", variant_key: "standard", config: {}, logo_url: null, logo_storage_path: null },
  orgId: "org1",
  entrantKinds: engineEntrantKinds("football"),
  variants: [{ key: "standard", name: "Standard" }],
  structureLocked: false,
  lockedFields: [],
  stages: [],
  canEdit: true,
  divisionPathPrefix: "/o/org/c/comp/d/",
  fixturesHref: "/o/org/c/comp/d/div/fixtures",
  embed: null,
  danger: null,
  autoPosts: false,
  canAutoPost: true,
} as unknown as Parameters<typeof DivisionSettings>[0];

/** The four browser APIs the upload touches; one knob each. */
const browser = { imageFails: false, blobFails: false, putStatus: 200 as number | "offline" };

beforeEach(() => {
  Object.assign(browser, { imageFails: false, blobFails: false, putStatus: 200 });
  state.calls.length = 0;
  state.impl = async (url) => (url.endsWith("/logo-upload-url") ? { upload_url: "https://storage.invalid/put", storage_path: "d1/logo.webp" } : {});
  vi.stubGlobal(
    "FileReader",
    class {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() {
        queueMicrotask(() => {
          this.result = "data:image/png;base64,AA==";
          this.onload?.();
        });
      }
    },
  );
  vi.stubGlobal(
    "Image",
    class {
      width = 800;
      height = 600;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_: string) {
        queueMicrotask(() => (browser.imageFails ? this.onerror?.() : this.onload?.()));
      }
    },
  );
  vi.stubGlobal("document", {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: () => undefined }),
      toBlob: (done: (b: Blob | null) => void, type?: string) => done(browser.blobFails ? null : new Blob(["webp"], { type })),
    }),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (browser.putStatus === "offline") throw new TypeError("Failed to fetch");
      return new Response(null, { status: browser.putStatus });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function pickLogo(tree: ReactElement[]): void {
  const input = tree.find((n) => n.type === "input" && propsOf(n).type === "file");
  if (!input) throw new Error("no file input in the General group");
  (propsOf(input).onChange as (e: unknown) => void)({ target: { files: [{ name: "logo.png" }] } });
}

function banner(tree: ReactElement[]): string | undefined {
  const p = tree.find((n) => n.type === "p" && typeof propsOf(n).className === "string" && (propsOf(n).className as string).includes("bg-red-50"));
  return p === undefined ? undefined : (propsOf(p).children as string);
}

async function upload(dict: Dict): Promise<{ shown: string | undefined }> {
  state.dict = dict;
  const island = renderIsland(DivisionSettings, baseProps);
  pickLogo(island.tree());
  await flush();
  return { shown: banner(island.tree()) };
}

describe("DivisionSettings logo upload: its own failures read in the reader's locale", () => {
  it("a file that will not decode, a failed conversion and a refused storage PUT each show their own sentence in every locale (counted)", async () => {
    let checked = 0;
    for (const [loc, dict] of LOCALES) {
      const unreachable = (dict as Dict)["save.err.unreachable"]!;
      for (const [what, arm, key] of [
        ["bad image", () => { browser.imageFails = true; }, "divset.logo.badImage"],
        ["conversion", () => { browser.blobFails = true; }, "divset.logo.convertFailed"],
        ["refused PUT", () => { browser.putStatus = 403; }, "divset.logo.uploadFailed"],
      ] as const) {
        Object.assign(browser, { imageFails: false, blobFails: false, putStatus: 200 });
        state.calls.length = 0;
        arm();
        const { shown } = await upload(dict as Dict);
        expect(shown, `${loc} ${what}`).toBe((dict as Dict)[key]);
        expect(shown, `${loc} ${what}: not the unreachable copy`).not.toBe(unreachable);
        if (loc !== "en") expect(shown, `${loc} ${what}: translated`).not.toBe((en as Dict)[key]);
        // A failed step stops the sequence: the division is only PATCHed once the PUT went through.
        expect(state.calls.some((c) => c.method === "PATCH"), `${loc} ${what}: no PATCH after a failure`).toBe(false);
        checked++;
      }
    }
    expect(checked).toBe(LOCALES.length * 3);
  });

  it("the positive pair: a good file uploads and PATCHes the storage path, with no banner; a PUT that never reaches storage still says 'couldn't reach Seazn'", async () => {
    for (const [loc, dict] of LOCALES) {
      Object.assign(browser, { imageFails: false, blobFails: false, putStatus: 200 });
      state.calls.length = 0;
      const ok = await upload(dict as Dict);
      expect(ok.shown, `${loc} good file`).toBeUndefined();
      // (The island also reads tag suggestions on mount; only this division's own calls are the upload's.)
      const mine = state.calls.filter((c) => c.url.startsWith("/api/v1/divisions/d1"));
      expect(mine.map((c) => `${c.method ?? "GET"} ${c.url}`), loc).toEqual([
        "POST /api/v1/divisions/d1/logo-upload-url",
        "PATCH /api/v1/divisions/d1",
      ]);
      expect(mine[1]!.json).toEqual({ logo_storage_path: "d1/logo.webp" });

      browser.putStatus = "offline";
      state.calls.length = 0;
      const offline = await upload(dict as Dict);
      expect(offline.shown, `${loc} offline PUT`).toBe((dict as Dict)["save.err.unreachable"]);
    }
  });

  it("sequence: a refusal, then a retry that works, then a refusal again - the banner follows each attempt", async () => {
    state.dict = nl as Dict;
    const island = renderIsland(DivisionSettings, baseProps);
    browser.putStatus = 403;
    pickLogo(island.tree());
    await flush();
    expect(banner(island.tree())).toBe((nl as Dict)["divset.logo.uploadFailed"]);
    browser.putStatus = 200;
    pickLogo(island.tree());
    await flush();
    expect(banner(island.tree())).toBeUndefined();
    browser.imageFails = true;
    pickLogo(island.tree());
    await flush();
    expect(banner(island.tree())).toBe((nl as Dict)["divset.logo.badImage"]);
  });
});
