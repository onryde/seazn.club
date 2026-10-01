// Scorer sheets §4.2, Task 3 — the console's hand-over panel after links
// became durable (sealed secret, `expires_at: null`, POST /device-links is
// ENSURE). Three things this file pins, each through the REAL component's own
// handlers under `renderIsland` (apps/web vitest has no DOM — AGENTS 2):
//
//   1. "Show QR" re-shows through ensure and NEVER through /reissue. A
//      hand-over that revoked would kill the sheet already printed for the
//      match, which is the whole defect the printable sheets exist to avoid.
//   2. "Revoke & reissue" asks first; only its confirm posts /reissue. Plain
//      "Revoke" and "Revoke now" ask first too; only their confirm DELETEs.
//   3. What the panel SAYS: a sealed link is live "until it is over", never an
//      epoch date (`new Date(null)` is 1 Jan 1970), and a missing server key is
//      the localised `dlink.kekMissing`, never the server's English sentence.
//
// The `apiV1` double keeps the REAL `ApiV1Error` class (the panel branches on
// `instanceof`; a lookalike makes that silently false). Every POST URL is
// recorded; the GET that `refresh()` issues on mount answers the active link.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { DeviceLinkPanel } from "@/components/v2/device-link-panel";
import { SeaznQrImage } from "@/components/v2/seazn-qr-image";
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
  /** When set, every DELETE rejects with this ApiV1Error. */
  refuseDelete: null as { message: string; status: number; code: string } | null,
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
        if (api.refuseDelete !== null) {
          const { message, status, code } = api.refuseDelete;
          throw new actual.ApiV1Error(message, status, code);
        }
        api.active = api.afterDelete;
        return {};
      }
      if (options?.method === undefined) return api.active;
      throw new Error(`device-link-panel.test.tsx's apiV1 double has no case for ${options.method} ${url}`);
    }),
  };
});

// The Seazn QR helper (T10, D7) is doubled so its INPUT — the pad URL — is what the test reads; the symbol itself (EC H,
// the logo, a decode at every painted size) is `src/lib/__tests__/seazn-qr.test.ts`'s, and the painted size the shared
// component's (B6 fix round 1).
const DLINK_SYMBOL = { src: "data:image/svg+xml;charset=utf-8,DLINK", modules: 57 };
const seaznQr = vi.hoisted(() => ({
  renderSeaznQr: vi.fn<(text: string) => Promise<{ src: string; modules: number }>>(async () => ({
    src: "data:image/svg+xml;charset=utf-8,DLINK",
    modules: 57,
  })),
}));
vi.mock("@/lib/seazn-qr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seazn-qr")>()),
  renderSeaznQr: seaznQr.renderSeaznQr,
}));

const SEALED: Link = { id: "l1", label: null, expires_at: null, created_at: "2026-09-23T09:00:00.000Z" };
const ORIGIN = "https://sheets.example";
const PROPS = { fixtureId: "f1", sportKey: "badminton", viewerPlan: "pro" as const };
const t = (key: Parameters<typeof tRuntime>[1], vars?: Record<string, string | number>) =>
  tRuntime(messages, key, vars);

/** Settle the mount GET, the POST, the QR encoder and the refresh GET.
 *  Macrotask turns, not microtasks: each await in the chain lands on its own
 *  turn, and a microtask-only flush would read the tree mid-chain. */
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
/** The Remote scoring QR as the panel hands it to the shared component — an element the harness does not expand, so it
 *  is found by TYPE and its `testId` PROP (D10). */
const dlinkQr = (tree: ReactElement[]) => tree.find((el) => el.type === SeaznQrImage && propsOf(el).testId === "dlink-qr");

beforeEach(() => {
  seaznQr.renderSeaznQr.mockClear();
  api.posts = [];
  api.deletes = [];
  api.active = SEALED;
  api.afterDelete = null;
  api.refuse = null;
  api.refuseDelete = null;
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
    // "Survives" means NOTHING revoked the live link on the way: no DELETE,
    // and the link the panel shows afterwards is still the one it started with.
    expect(api.deletes, "Show QR never revokes the live link first").toEqual([]);
    expect(api.active?.id).toBe(SEALED.id);
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

  it("revoking while the reissue question is open swaps the question, and a confirmed revoke closes it — a link that is still live does not reappear under a question nobody asked", async () => {
    // A co-organiser's hand-over landed in between: after this revoke the
    // refresh GET still finds a live link, so the live branch renders again.
    api.afterDelete = { ...SEALED, id: "l2" };
    const island = renderIsland(DeviceLinkPanel, PROPS);
    await flush();
    click(byTestId(island.tree(), "device-link-reissue"));
    click(byTestId(island.tree(), "device-link-revoke"));
    expect(byTestId(island.tree(), "device-link-reissue-confirm"), "one question at a time").toBeUndefined();
    click(byTestId(island.tree(), "device-link-revoke-confirm"));
    await flush();
    expect(api.deletes).toEqual(["/api/v1/fixtures/f1/device-links/l1"]);
    expect(byTestId(island.tree(), "device-link-show"), "the live branch is back, for l2").toBeDefined();
    expect(byTestId(island.tree(), "device-link-reissue-confirm")).toBeUndefined();
    expect(byTestId(island.tree(), "device-link-revoke-confirm")).toBeUndefined();
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

// Owner ruling (T3 fix round 2): plain Revoke kills a printed sheet exactly as
// Revoke & reissue does, and sits 8px from Show QR — so it asks first too, on
// screen, with the same shape. Both DELETE doors are covered: the live line's
// "Revoke" and the shown QR's "Revoke now".
describe("device-link panel — Revoke asks first, like Revoke & reissue (owner ruling)", () => {
  const alertText = (tree: ReactElement[]) =>
    tree.filter((el) => propsOf(el).role === "alert").map((el) => textOf(el)).join(" ");

  it("the live line's Revoke sends NO DELETE on its own — it puts the question on screen", async () => {
    const island = renderIsland(DeviceLinkPanel, PROPS);
    await flush();
    click(byTestId(island.tree(), "device-link-revoke"));
    await flush();
    expect(api.deletes, "the tap alone revokes nothing").toEqual([]);
    expect(alertText(island.tree())).toContain(t("dlink.revokeWarn"));
    expect(byTestId(island.tree(), "device-link-revoke-confirm")).toBeDefined();
  });

  it("Keep backs out of the revoke question: no DELETE, question closed, link still live", async () => {
    const island = renderIsland(DeviceLinkPanel, PROPS);
    await flush();
    click(byTestId(island.tree(), "device-link-revoke"));
    click(byTestId(island.tree(), "device-link-keep"));
    await flush();
    expect(api.deletes).toEqual([]);
    expect(byTestId(island.tree(), "device-link-revoke-confirm")).toBeUndefined();
    expect(island.text()).not.toContain(t("dlink.revokeWarn"));
    expect(byTestId(island.tree(), "device-link-show"), "the live branch stays").toBeDefined();
  });

  it("the revoke confirm sends exactly one DELETE, for the live link", async () => {
    const island = renderIsland(DeviceLinkPanel, PROPS);
    await flush();
    click(byTestId(island.tree(), "device-link-revoke"));
    click(byTestId(island.tree(), "device-link-revoke-confirm"));
    await flush();
    expect(api.deletes).toEqual(["/api/v1/fixtures/f1/device-links/l1"]);
    expect(api.posts).toEqual([]);
  });

  it("the shown QR's 'Revoke now' asks first too; Keep backs out, the confirm revokes", async () => {
    const island = renderIsland(DeviceLinkPanel, PROPS);
    await flush();
    click(byTestId(island.tree(), "device-link-show"));
    await flush();
    click(byTestId(island.tree(), "device-link-revoke-now"));
    await flush();
    expect(api.deletes, "the tap alone revokes nothing").toEqual([]);
    expect(alertText(island.tree())).toContain(t("dlink.revokeWarn"));
    click(byTestId(island.tree(), "device-link-keep"));
    expect(byTestId(island.tree(), "device-link-revoke-confirm")).toBeUndefined();
    expect(byTestId(island.tree(), "device-link-url"), "the QR stays on screen").toBeDefined();
    click(byTestId(island.tree(), "device-link-revoke-now"));
    click(byTestId(island.tree(), "device-link-revoke-confirm"));
    await flush();
    expect(api.deletes).toEqual(["/api/v1/fixtures/f1/device-links/l1"]);
  });

  it("Show QR closes an open question — the reissue confirm never sits under a freshly shown QR", async () => {
    const island = renderIsland(DeviceLinkPanel, PROPS);
    await flush();
    click(byTestId(island.tree(), "device-link-reissue"));
    click(byTestId(island.tree(), "device-link-show"));
    await flush();
    expect(byTestId(island.tree(), "device-link-url")).toBeDefined();
    expect(byTestId(island.tree(), "device-link-reissue-confirm")).toBeUndefined();
    expect(alertText(island.tree())).toBe("");
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

  it("the panel's description says the link lives until the match is finalized or cancelled — never 'today only'", async () => {
    const island = renderIsland(DeviceLinkPanel, PROPS);
    await flush();
    expect(island.text()).toContain(t("dlink.desc", { scorer: t("sport.official.badminton").toLowerCase() }));
    expect(island.text()).toContain("as the umpire");
    expect(island.text()).toContain("until it's finalized or cancelled");
    expect(island.text()).not.toMatch(/\btoday\b/i);
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
    // T10: the QR is the Seazn QR (D7) of exactly the pad URL the text shows, painted through the shared component.
    expect(seaznQr.renderSeaznQr.mock.calls[0], "the pad URL, and nothing else: the helper takes no size").toEqual([`${ORIGIN}/score/dl_sealed_secret`]);
    const qr = dlinkQr(island.tree());
    expect(qr, "the QR renders through SeaznQrImage").toBeDefined();
    expect(propsOf(qr!).qr, "the symbol the helper drew, with its module count").toEqual(DLINK_SYMBOL);
    expect(propsOf(qr!).alt).toBe(t("dlink.alt"));
    // The cap is the panel's declared one (review m-10: read, never a literal here) and holds whole px per module for
    // a real pad URL (v8: 57 modules with the quiet zone) — four of them.
    const cap = Number(/const DLINK_QR_MAX_PX = (\d+);/.exec(readFileSync(resolve(import.meta.dirname, "../device-link-panel.tsx"), "utf8"))![1]);
    expect(propsOf(qr!).maxSize).toBe(cap);
    expect(Math.floor(cap / 57), "at least three px per module").toBeGreaterThanOrEqual(3);
    expect(island.tree().find((el) => el.type === "img"), "no bare img bypasses the component").toBeUndefined();
    expect(island.text()).toContain(t("dlink.sameQr"));
    expect(island.text()).not.toMatch(/19(69|70)/);
  });
});

describe("device-link panel — the live link never reaches a session replay (fix batch 2, item 1)", () => {
  // PostHog replay gzips its full-snapshot and mutation frames before
  // `before_send` runs, so the URL scrub cannot see a secret painted into the
  // DOM. Its recorder BLOCKS any element carrying the `ph-no-capture` class
  // (rrweb `blockClass`, posthog-js default): no children, no `src`, just a
  // same-size placeholder. The pad URL text and the QR that encodes it are the
  // two places the live secret is painted. Standalone and embedded (the
  // fixture console's hand-over card) are the same component, so both run.
  // Anchored on the class TOKEN: `ph-no-capture-x` or `no-ph-no-capture`
  // would not block anything.
  const classTokens = (el: ReactElement | undefined) =>
    String(propsOf(el!).className ?? "").split(/\s+/).filter(Boolean);

  it.each([
    ["standalone", false],
    ["embedded in the console", true],
  ] as const)("%s: the pad URL text and the QR image are both ph-no-capture", async (_, embedded) => {
    const island = renderIsland(DeviceLinkPanel, { ...PROPS, embedded });
    await flush();
    click(byTestId(island.tree(), "device-link-show"));
    await flush();
    const url = byTestId(island.tree(), "device-link-url");
    expect(textOf(url!), "the element holds the live secret").toContain("dl_sealed_secret");
    expect(classTokens(url), "pad URL text").toContain("ph-no-capture");
    // The QR: the shared component owns the class (on the inline image AND the enlarged overlay — seazn-qr-image.test),
    // so what THIS panel owes is to mark it sensitive. A bare <img> here would bypass both.
    const qr = dlinkQr(island.tree());
    expect(qr, "the QR image is rendered").toBeDefined();
    expect(propsOf(qr!).sensitive, "QR image is sensitive").toBe(true);
    expect(island.tree().find((el) => el.type === "img"), "no bare img bypasses the component").toBeUndefined();
    // The positive pair: the controls around them stay recordable, so a
    // replay still shows what the organiser tapped.
    for (const button of buttons(island.tree())) {
      expect(classTokens(button), textOf(button)).not.toContain("ph-no-capture");
    }
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

  // One `it` per path, so each starts from `beforeEach`'s fresh double: a
  // shared loop let the first path's side effects (a DELETE nulling the live
  // link) leak into the second and red it for the wrong reason.
  it.each(["show", "reissue"] as const)(
    "a 402 on the %s POST opens the upgrade gate, not an error line",
    async (path) => {
      api.refuse = { message: "upgrade required", status: 402, code: "PAYMENT_REQUIRED" };
      const gate = (tree: ReactElement[]) => tree.some((el) => propsOf(el).feature === "scoring.device_links");
      const island = renderIsland(DeviceLinkPanel, PROPS);
      await flush();
      expect(gate(island.tree()), "no gate before the tap").toBe(false);
      if (path === "show") click(byTestId(island.tree(), "device-link-show"));
      else {
        click(byTestId(island.tree(), "device-link-reissue"));
        click(byTestId(island.tree(), "device-link-reissue-confirm"));
      }
      await flush();
      expect(gate(island.tree()), "the upgrade gate opens").toBe(true);
      expect(island.text(), "the server's sentence is not shown").not.toContain("upgrade required");
    },
  );

});

// Review finding 3 (T3 fix round 1): NO refusal renders the server's English.
// Each case is the real wire shape the device-link routes send (see
// `failureKey`'s table test in device-link-copy.test.ts); the organiser reads
// the localised sentence for it, and the mapping is per case, not blanket —
// every case expects a DIFFERENT key, so collapsing them to one line reds.
const REFUSALS = [
  { label: "a finalized/cancelled fixture (422)", err: { status: 422, code: "ERROR", message: "fixture is finalized — nothing left to score" }, key: "dlink.error.matchOver" },
  { label: "the mint budget (429)", err: { status: 429, code: "RATE_LIMITED", message: "Too many requests — slow down and try again." }, key: "dlink.error.rateLimited" },
  { label: "a fixture that is gone (404)", err: { status: 404, code: "NOT_FOUND", message: "fixture not found" }, key: "dlink.error.notFound" },
  { label: "no permission (403)", err: { status: 403, code: "FORBIDDEN", message: "Device links can only be managed with a session login" }, key: "dlink.error.forbidden" },
  { label: "anything unmapped (500) — the generic fallback", err: { status: 500, code: "INTERNAL", message: "relation \"device_links\" does not exist" }, key: "dlink.failed" },
] as const;

describe("device-link panel — every refusal is localised, never the server's English (review finding 3)", () => {
  it.each(REFUSALS)("Show QR: $label", async ({ err, key }) => {
    api.refuse = { ...err };
    const island = renderIsland(DeviceLinkPanel, PROPS);
    await flush();
    click(byTestId(island.tree(), "device-link-show"));
    await flush();
    expect(island.text()).toContain(t(key));
    expect(island.text()).not.toContain(err.message);
  });

  it.each(REFUSALS)("the reissue confirm: $label", async ({ err, key }) => {
    api.refuse = { ...err };
    const island = renderIsland(DeviceLinkPanel, PROPS);
    await flush();
    click(byTestId(island.tree(), "device-link-reissue"));
    click(byTestId(island.tree(), "device-link-reissue-confirm"));
    await flush();
    expect(api.posts).toEqual(["/api/v1/fixtures/f1/device-links/reissue"]);
    expect(island.text()).toContain(t(key));
    expect(island.text()).not.toContain(err.message);
  });

  it("Revoke's refusal is localised too (a link already gone: 404)", async () => {
    api.refuseDelete = { status: 404, code: "NOT_FOUND", message: "device link not found" };
    const island = renderIsland(DeviceLinkPanel, PROPS);
    await flush();
    click(byTestId(island.tree(), "device-link-revoke"));
    click(byTestId(island.tree(), "device-link-revoke-confirm"));
    await flush();
    expect(api.deletes).toEqual(["/api/v1/fixtures/f1/device-links/l1"]);
    expect(island.text()).toContain(t("dlink.error.notFound"));
    expect(island.text()).not.toContain("device link not found");
  });

  // Task 3 review carry: a failed revoke used to leave the question open,
  // still offering "Yes, revoke" for a link that (on a 404) is already gone.
  it("a failed revoke closes the question and re-reads the live line", async () => {
    const { apiV1 } = await import("@/lib/client-v1");
    const reads = () => vi.mocked(apiV1).mock.calls.filter(([, o]) => o?.method === undefined).length;
    api.refuseDelete = { status: 404, code: "NOT_FOUND", message: "device link not found" };
    const island = renderIsland(DeviceLinkPanel, PROPS);
    await flush();
    click(byTestId(island.tree(), "device-link-revoke"));
    expect(byTestId(island.tree(), "device-link-revoke-confirm"), "precondition: the question is open").toBeDefined();
    // Revoked from another session meanwhile: the server has no live link.
    api.active = null;
    const readsBefore = reads();
    click(byTestId(island.tree(), "device-link-revoke-confirm"));
    await flush();

    expect(api.deletes).toEqual(["/api/v1/fixtures/f1/device-links/l1"]);
    expect(byTestId(island.tree(), "device-link-revoke-confirm"), "no 'Yes, revoke' for a dead link").toBeUndefined();
    expect(island.text()).not.toContain(t("dlink.revokeWarn"));
    expect(reads(), "the panel re-reads the live line").toBeGreaterThan(readsBefore);
    expect(byTestId(island.tree(), "device-link-show"), "the gone link's live line is gone").toBeUndefined();
    expect(byTestId(island.tree(), "device-link-mint"), "…and Create is back").toBeDefined();
    expect(island.text(), "the refusal is still said").toContain(t("dlink.error.notFound"));
  });

  // The case above cannot see the close on its own: with no live link left the
  // question has nothing to render against. Here the link SURVIVES the refusal
  // (a transient 500), so only closing the question takes "Yes, revoke" away.
  it("a refused revoke on a link that is still live closes the question too, and keeps the live line", async () => {
    api.refuseDelete = { status: 500, code: "INTERNAL", message: "connection reset" };
    const island = renderIsland(DeviceLinkPanel, PROPS);
    await flush();
    click(byTestId(island.tree(), "device-link-revoke"));
    expect(byTestId(island.tree(), "device-link-revoke-confirm"), "precondition: the question is open").toBeDefined();
    click(byTestId(island.tree(), "device-link-revoke-confirm"));
    await flush();

    expect(api.deletes).toEqual(["/api/v1/fixtures/f1/device-links/l1"]);
    expect(byTestId(island.tree(), "device-link-show"), "precondition: the link is still live").toBeDefined();
    expect(byTestId(island.tree(), "device-link-revoke-confirm"), "the question closes on any refusal").toBeUndefined();
    expect(island.text()).not.toContain(t("dlink.revokeWarn"));
    expect(island.text(), "the refusal is said").toContain(t("dlink.failed"));
    expect(island.text()).not.toContain("connection reset");
  });

  // Task 6 review minor (b): Revoke & reissue is the other destructive door on
  // the same question, and a refusal there left "Yes, reissue" on screen.
  it("a refused reissue closes its question too, keeps the live line, and re-reads it", async () => {
    const { apiV1 } = await import("@/lib/client-v1");
    const reads = () => vi.mocked(apiV1).mock.calls.filter(([, o]) => o?.method === undefined).length;
    api.refuse = { status: 500, code: "INTERNAL", message: "connection reset" };
    const island = renderIsland(DeviceLinkPanel, PROPS);
    await flush();
    click(byTestId(island.tree(), "device-link-reissue"));
    expect(byTestId(island.tree(), "device-link-reissue-confirm"), "precondition: the question is open").toBeDefined();
    const readsBefore = reads();
    click(byTestId(island.tree(), "device-link-reissue-confirm"));
    await flush();

    expect(api.posts).toEqual(["/api/v1/fixtures/f1/device-links/reissue"]);
    expect(byTestId(island.tree(), "device-link-show"), "precondition: the link is still live").toBeDefined();
    expect(byTestId(island.tree(), "device-link-reissue-confirm"), "the question closes on any refusal").toBeUndefined();
    expect(island.text()).not.toContain(t("dlink.reissueWarn"));
    expect(reads(), "the panel re-reads the live line").toBeGreaterThan(readsBefore);
    expect(island.text(), "the refusal is said").toContain(t("dlink.failed"));
    expect(island.text()).not.toContain("connection reset");
  });

  it("a dropped connection (fetch TypeError) gets the generic line, not the browser's English", async () => {
    const { apiV1 } = await import("@/lib/client-v1");
    const island = renderIsland(DeviceLinkPanel, PROPS);
    await flush();
    vi.mocked(apiV1).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    click(byTestId(island.tree(), "device-link-show"));
    await flush();
    expect(island.text()).toContain(t("dlink.failed"));
    expect(island.text()).not.toContain("Failed to fetch");
  });
});

// Owner ruling (2026-09-23): once the fixture is finalized or cancelled there
// is nothing to hand over. The panel learns it from the hand-over routes' own
// refusal (their only 422 — a match that is over, see `failureKey`), because
// the console unmounts the panel on its OWN status and a finalize from another
// session is not seen until then. From that moment it offers no control at all
// — no Create, no Show QR, no Revoke — and says only the match-over line.
describe("device-link panel — a finished match offers nothing to hand over (owner ruling 2026-09-23)", () => {
  const HAND_OVER_CONTROLS = [
    "device-link-mint",
    "device-link-show",
    "device-link-revoke",
    "device-link-reissue",
    "device-link-revoke-now",
  ];
  const MATCH_OVER = { status: 422, code: "ERROR", message: "fixture is finalized — nothing left to score" };

  it("a live match: Create scoring link is offered, and no match-over line shows", async () => {
    api.active = null;
    const island = renderIsland(DeviceLinkPanel, PROPS);
    await flush();
    expect(byTestId(island.tree(), "device-link-mint")).toBeDefined();
    expect(byTestId(island.tree(), "device-link-match-over")).toBeUndefined();
  });

  it.each([
    ["Create (no link yet)", null, "device-link-mint"],
    ["Show QR (a live link)", SEALED, "device-link-show"],
  ] as const)("%s answered 422: every hand-over control is gone, only the localised match-over line remains", async (_, active, control) => {
    api.active = active;
    api.refuse = { ...MATCH_OVER };
    const island = renderIsland(DeviceLinkPanel, PROPS);
    await flush();
    click(byTestId(island.tree(), control));
    await flush();
    for (const id of HAND_OVER_CONTROLS) expect(byTestId(island.tree(), id), id).toBeUndefined();
    expect(buttons(island.tree()), "no button of any kind").toEqual([]);
    const line = byTestId(island.tree(), "device-link-match-over");
    expect(line, "the match-over line renders").toBeDefined();
    expect(textOf(line!)).toBe(t("dlink.error.matchOver"));
    // "Only" the line: the card's own heading, then the line — no description,
    // no error box repeating it, no server English.
    expect(island.text()).toBe(`${t("dlink.title")} ${t("dlink.error.matchOver")}`);
  });

  it("embedded in the console card: the line alone, with no heading", async () => {
    api.active = null;
    api.refuse = { ...MATCH_OVER };
    const island = renderIsland(DeviceLinkPanel, { ...PROPS, embedded: true });
    await flush();
    click(byTestId(island.tree(), "device-link-mint"));
    await flush();
    expect(island.text()).toBe(t("dlink.error.matchOver"));
  });

  it("a refusal that is NOT the match being over (429) keeps every control — the terminal state is only for a finished match", async () => {
    api.active = null;
    api.refuse = { status: 429, code: "RATE_LIMITED", message: "Too many requests — slow down and try again." };
    const island = renderIsland(DeviceLinkPanel, PROPS);
    await flush();
    click(byTestId(island.tree(), "device-link-mint"));
    await flush();
    expect(byTestId(island.tree(), "device-link-mint"), "Create is still offered").toBeDefined();
    expect(byTestId(island.tree(), "device-link-match-over")).toBeUndefined();
    expect(island.text()).toContain(t("dlink.error.rateLimited"));
  });
});
