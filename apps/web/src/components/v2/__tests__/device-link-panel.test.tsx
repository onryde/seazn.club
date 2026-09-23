// Scorer sheets §4.2, Task 3 — the console's hand-over panel after links
// became durable (sealed secret, `expires_at: null`, POST /device-links is
// ENSURE). Three things this file pins, each through the REAL component's own
// handlers under `renderIsland` (apps/web vitest has no DOM — AGENTS 2):
//
//   1. "Show QR" re-shows through ensure and NEVER through /reissue. A
//      hand-over that revoked would kill the sheet already printed for the
//      match, which is the whole defect the printable sheets exist to avoid.
//   2. "Revoke & reissue" asks first; only its confirm posts /reissue.
//   3. What the panel SAYS: a sealed link is live "until it is over", never an
//      epoch date (`new Date(null)` is 1 Jan 1970), and a missing server key is
//      the localised `dlink.kekMissing`, never the server's English sentence.
//
// The `apiV1` double keeps the REAL `ApiV1Error` class (the panel branches on
// `instanceof`; a lookalike makes that silently false). Every POST URL is
// recorded; the GET that `refresh()` issues on mount answers the active link.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { DeviceLinkPanel } from "@/components/v2/device-link-panel";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { messages } from "@/lib/messages";
import { t as tRuntime } from "@/lib/i18n-runtime";

type Link = { id: string; label: string | null; expires_at: string | null; created_at: string };

const api = vi.hoisted(() => ({
  posts: [] as string[],
  deletes: [] as string[],
  active: null as Link | null,
  /** What the refresh GET finds after a DELETE (default: nothing live). */
  afterDelete: null as Link | null,
  /** When set, every POST rejects with this ApiV1Error. */
  refuse: null as { message: string; status: number; code: string } | null,
}));

vi.mock("@/lib/client-v1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/client-v1")>();
  return {
    ...actual, // ApiV1Error stays the REAL class.
    apiV1: vi.fn(async (url: string, options?: { method?: string }) => {
      if (options?.method === "POST") {
        api.posts.push(url);
        if (api.refuse !== null) {
          throw new actual.ApiV1Error(api.refuse.message, api.refuse.status, api.refuse.code);
        }
        return { ...(api.active as Link), secret: "dl_sealed_secret" };
      }
      if (options?.method === "DELETE") {
        api.deletes.push(url);
        api.active = api.afterDelete;
        return {};
      }
      if (options?.method === undefined) return api.active;
      throw new Error(`device-link-panel.test.tsx's apiV1 double has no case for ${options.method} ${url}`);
    }),
  };
});

const SEALED: Link = { id: "l1", label: null, expires_at: null, created_at: "2026-09-23T09:00:00.000Z" };
const ORIGIN = "https://sheets.example";
const PROPS = { fixtureId: "f1", scorerLabel: "Umpire", viewerPlan: "pro" as const };
const t = (key: Parameters<typeof tRuntime>[1], vars?: Record<string, string | number>) =>
  tRuntime(messages, key, vars);

/** Settle the mount GET, the POST, the real QR encoder and the refresh GET.
 *  Macrotask turns, not microtasks: `qrcode`'s node build encodes the PNG
 *  through a stream, which completes on later event-loop turns. */
async function flush() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const byTestId = (tree: ReactElement[], id: string) =>
  tree.find((el) => propsOf(el)["data-testid"] === id);
const click = (el: ReactElement | undefined) => {
  if (el === undefined) throw new Error("the control to click did not render");
  (propsOf(el).onClick as () => void)();
};
const buttons = (tree: ReactElement[]) => tree.filter((el) => el.type === "button");

beforeEach(() => {
  api.posts = [];
  api.deletes = [];
  api.active = SEALED;
  api.afterDelete = null;
  api.refuse = null;
  vi.stubGlobal("window", { location: { origin: ORIGIN } });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("device-link panel — Show QR vs Revoke & reissue (scorer sheets §4.2)", () => {
  it("Show QR re-shows through ensure (POST /device-links), never /reissue — a printed sheet survives a hand-over", async () => {
    const island = renderIsland(DeviceLinkPanel, PROPS);
    await flush();
    click(byTestId(island.tree(), "device-link-show"));
    await flush();
    expect(api.posts).toEqual(["/api/v1/fixtures/f1/device-links"]);
  });

  it("Revoke & reissue asks first, and only the confirm posts to /reissue", async () => {
    const island = renderIsland(DeviceLinkPanel, PROPS);
    await flush();
    click(byTestId(island.tree(), "device-link-reissue"));
    expect(api.posts).toEqual([]);
    // The question is ON SCREEN, not a native dialog (e2e fails on those).
    const alert = island.tree().find((el) => propsOf(el).role === "alert");
    expect(alert, "the reissue warning renders as role=alert").toBeDefined();
    expect(textOf(alert!)).toContain(t("dlink.reissueWarn"));
    click(byTestId(island.tree(), "device-link-reissue-confirm"));
    await flush();
    expect(api.posts).toEqual(["/api/v1/fixtures/f1/device-links/reissue"]);
  });

  it("'Keep this QR' backs out without posting anything and closes the question", async () => {
    const island = renderIsland(DeviceLinkPanel, PROPS);
    await flush();
    click(byTestId(island.tree(), "device-link-reissue"));
    const keep = buttons(island.tree()).find((el) => textOf(el).includes(t("dlink.keep")));
    click(keep);
    await flush();
    expect(api.posts).toEqual([]);
    expect(byTestId(island.tree(), "device-link-reissue-confirm")).toBeUndefined();
    expect(island.text()).not.toContain(t("dlink.reissueWarn"));
  });

  it("revoking while the reissue question is open closes it — a link that is still live does not reappear under a question nobody asked", async () => {
    // A co-organiser's hand-over landed in between: after this revoke the
    // refresh GET still finds a live link, so the live branch renders again.
    api.afterDelete = { ...SEALED, id: "l2" };
    const island = renderIsland(DeviceLinkPanel, PROPS);
    await flush();
    click(byTestId(island.tree(), "device-link-reissue"));
    click(buttons(island.tree()).find((el) => textOf(el).trim() === t("dlink.revoke")));
    await flush();
    expect(api.deletes).toEqual(["/api/v1/fixtures/f1/device-links/l1"]);
    expect(byTestId(island.tree(), "device-link-show"), "the live branch is back, for l2").toBeDefined();
    expect(byTestId(island.tree(), "device-link-reissue-confirm")).toBeUndefined();
    expect(api.posts).toEqual([]);
  });

  it("a live link offers Show QR, Revoke, Revoke & reissue — in that order, and no Create", async () => {
    const island = renderIsland(DeviceLinkPanel, PROPS);
    await flush();
    const labels = buttons(island.tree()).map((el) => textOf(el).trim());
    expect(labels).toEqual([t("dlink.showQr"), t("dlink.revoke"), t("dlink.reissue")]);
    expect(byTestId(island.tree(), "device-link-mint")).toBeUndefined();
  });
});

describe("device-link panel — what it says about a sealed link (null expiry)", () => {
  // The dated line's own head, cut from the catalog so a reword moves it.
  const datedHead = t("dlink.live", { date: "@DATE@" }).split("@DATE@")[0]!;

  it("the live line says the link lasts until the match is over — never the dated line (which renders 1970 for null)", async () => {
    const island = renderIsland(DeviceLinkPanel, PROPS);
    await flush();
    expect(island.text()).toContain(t("dlink.liveUntilOver"));
    expect(island.text()).not.toContain(datedHead);
    expect(island.text()).not.toMatch(/19(69|70)/);
  });

  it("a dated row still gets the dated line (the positive pair of the case above)", async () => {
    api.active = { ...SEALED, expires_at: "2026-09-23T23:59:59.000Z" };
    const island = renderIsland(DeviceLinkPanel, PROPS);
    await flush();
    expect(island.text()).toContain(datedHead);
    expect(island.text()).not.toContain(t("dlink.liveUntilOver"));
  });

  it("the shown QR carries the pad URL and 'Same QR every time' — no expiry date, no 'shown once'", async () => {
    const island = renderIsland(DeviceLinkPanel, PROPS);
    await flush();
    click(byTestId(island.tree(), "device-link-show"));
    await flush();
    const url = byTestId(island.tree(), "device-link-url");
    expect(url, "the pad URL paragraph carries its hook").toBeDefined();
    expect(textOf(url!)).toContain(`${ORIGIN}/score/dl_sealed_secret`);
    const img = island.tree().find((el) => el.type === "img");
    expect(String(propsOf(img!).src)).toMatch(/^data:image\/png;base64,/);
    expect(island.text()).toContain(t("dlink.sameQr"));
    expect(island.text()).not.toMatch(/19(69|70)/);
  });
});

describe("device-link panel — a server with no DEVICE_LINK_KEK (owner ruling Q1, controller ruling)", () => {
  const SERVER_ENGLISH = "Scoring links are not configured on this server (DEVICE_LINK_KEK missing or malformed)";

  beforeEach(() => {
    api.refuse = { message: SERVER_ENGLISH, status: 503, code: "DEVICE_LINK_KEK_MISSING" };
  });

  it("Show QR's 503 renders the localised dlink.kekMissing, never the server's English", async () => {
    const island = renderIsland(DeviceLinkPanel, PROPS);
    await flush();
    click(byTestId(island.tree(), "device-link-show"));
    await flush();
    expect(island.text()).toContain(t("dlink.kekMissing"));
    expect(island.text()).not.toContain(SERVER_ENGLISH);
  });

  it("the reissue confirm's 503 renders the same localised copy", async () => {
    const island = renderIsland(DeviceLinkPanel, PROPS);
    await flush();
    click(byTestId(island.tree(), "device-link-reissue"));
    click(byTestId(island.tree(), "device-link-reissue-confirm"));
    await flush();
    expect(api.posts).toEqual(["/api/v1/fixtures/f1/device-links/reissue"]);
    expect(island.text()).toContain(t("dlink.kekMissing"));
    expect(island.text()).not.toContain(SERVER_ENGLISH);
  });

  it("the first Create on a fixture with no link renders the same localised copy", async () => {
    api.active = null;
    const island = renderIsland(DeviceLinkPanel, PROPS);
    await flush();
    click(byTestId(island.tree(), "device-link-mint"));
    await flush();
    expect(api.posts).toEqual(["/api/v1/fixtures/f1/device-links"]);
    expect(island.text()).toContain(t("dlink.kekMissing"));
    expect(island.text()).not.toContain(SERVER_ENGLISH);
  });

  it("a 402 on either POST opens the upgrade gate, not an error line (Show QR and the reissue confirm)", async () => {
    api.refuse = { message: "upgrade required", status: 402, code: "PAYMENT_REQUIRED" };
    const gate = (tree: ReactElement[]) => tree.some((el) => propsOf(el).feature === "scoring.device_links");
    for (const path of ["show", "reissue"] as const) {
      const island = renderIsland(DeviceLinkPanel, PROPS);
      await flush();
      expect(gate(island.tree()), `${path}: no gate before the tap`).toBe(false);
      if (path === "show") click(byTestId(island.tree(), "device-link-show"));
      else {
        click(byTestId(island.tree(), "device-link-reissue"));
        click(byTestId(island.tree(), "device-link-reissue-confirm"));
      }
      await flush();
      expect(gate(island.tree()), `${path}: the upgrade gate opens`).toBe(true);
      expect(island.text(), `${path}: the server's sentence is not shown`).not.toContain("upgrade required");
    }
  });

  it("any other refusal still shows its own message (the negative pair — the mapping is by code, not blanket)", async () => {
    api.refuse = { message: "fixture is finalized", status: 422, code: "FIXTURE_FINALIZED" };
    const island = renderIsland(DeviceLinkPanel, PROPS);
    await flush();
    click(byTestId(island.tree(), "device-link-show"));
    await flush();
    expect(island.text()).toContain("fixture is finalized");
    expect(island.text()).not.toContain(t("dlink.kekMissing"));
  });
});
