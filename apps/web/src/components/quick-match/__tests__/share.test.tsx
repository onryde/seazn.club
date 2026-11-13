// Quick match plan 2, Task 7 (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5 step 3, O3; pre-flight B7, D14,
// the T6-to-T8 amendment's T7 bullet): the home's Share island, `QuickMatchShare`. No DOM here (vitest `environment: "node"`):
// the island is driven through the no-DOM `renderIsland` harness, its handlers called as a browser calls them. What a browser
// paints (the panel at 320, 768 and 1280, the QR's real scan) is the e2e's and the owed screenshots'.
//
// The contract (controller ruling 2026-11-08, the amendment's T7 bullet: "Add the existing ShareButton beside Copy ... Keep
// the QR behind the toggle"):
//   - First paint: the link's field, Copy and (where the phone has a share sheet) the native share button, so sharing to
//     WhatsApp is ONE tap. Only the QR is behind the "Show QR" toggle, closed on first paint, and never drawn before it.
//     The server's HTML has no native share button (it cannot know the device has one) and no QR.
//   - The link is the HOME's: `routes.quickMatch(token)` on the page's own origin (`window.location.origin`, B7: no
//     x-forwarded-host trust), never the pad's device link. The QR encodes exactly that URL, built on the tap through the
//     Seazn QR (the logo is `renderSeaznQr`'s own contract, src/lib/__tests__/seazn-qr.test.ts), and is painted `sensitive`.
//   - Copy puts that URL on the clipboard and says "Copied" only when the clipboard took it; with no clipboard (an insecure
//     page, an old browser) or a refusal, it selects the link in its read-only field instead.
//   - The native share sheet (`ShareButton`, D14) is offered only where `navigator.share` exists.
//   - Every element that holds the URL carries `ph-no-capture`.
//
// Expected values are typed from the spec and the dictionaries (the home is `/q/<token>` on the page's origin; the words are
// T1's keys), never read back from the island. Sport: not applicable (the island shares a path; it knows no sport).
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { ShareButton } from "@/components/share-button";
import { PHONE_HANDOVER_QR_MAX_PX, SeaznQrImage, SeaznQrPlaceholder } from "@/components/v2/seazn-qr-image";
import en from "@/dictionaries/en/ui.json";
import { t as tRuntime } from "@/lib/i18n-runtime";
import { routes } from "@/lib/routes";
import { QuickMatchShare, type QuickMatchShareProps } from "../share";

const TOKEN = "qm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcde";
const ORIGIN = "https://play.seazn.example";
/** The spec's home link: `/q/<token>` on the page's own origin. Typed here, not built by the island. */
const HOME_URL = `${ORIGIN}/q/${TOKEN}`;
const NAME = "Sunday doubles, court 3";
const SYMBOL = { src: "data:image/svg+xml;charset=utf-8,QM-HOME", modules: 49 };

const seaznQr = vi.hoisted(() => ({
  renderSeaznQr: vi.fn<(text: string) => Promise<{ src: string; modules: number }>>(),
}));
vi.mock("@/lib/seazn-qr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/seazn-qr")>()),
  renderSeaznQr: seaznQr.renderSeaznQr,
}));
// The island loads the helper with a dynamic import on the tap. Under vitest, a second such import in flight at once (a
// double tap) is handed the REAL module, not this double: measured with the draw guard mutated out, the spy counted one
// call while the real `renderSeaznQr` drew the second symbol, and the case stayed green. (Pre-resolving the double, and a
// factory with no `importOriginal`, both still lost the race.) So every case also checks that the real helper never ran:
// it is the only thing here that fetches (the logo, `SEAZN_QR_LOGO_PATH`), and `fetch` is a spy that refuses.
const realDraws = vi.fn(async (): Promise<Response> => {
  throw new Error("a test reached the real Seazn QR helper (its logo fetch)");
});
beforeAll(async () => {
  expect((await import("@/lib/seazn-qr")).renderSeaznQr, "the double, for a lone import").toBe(seaznQr.renderSeaznQr);
});

const LABELS: QuickMatchShareProps["labels"] = {
  share: en["quickMatch.home.share"],
  copy: en["quickMatch.home.copy"],
  copied: en["quickMatch.home.copied"],
  qrAlt: en["quickMatch.home.qrAlt"],
  showQr: en["dlink.showQr"],
  shareNative: tRuntime(en, "quickMatch.home.shareNative", { name: NAME }),
};
const PROPS: QuickMatchShareProps = { path: routes.quickMatch(TOKEN), title: NAME, labels: LABELS };

type Island = ReturnType<typeof renderIsland<QuickMatchShareProps>>;
/** As a hydrating browser mounts it: the server's snapshot first, then the live origin and capabilities. */
const mount = (): Island => renderIsland(QuickMatchShare, PROPS, undefined, { hydrate: true });

/** Settle the dynamic import and the QR helper: each await lands on its own macrotask turn. */
async function flush() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
const byTestId = (tree: ReactElement[], id: string) => tree.filter((el) => propsOf(el)["data-testid"] === id);
const one = (tree: ReactElement[], id: string): ReactElement => {
  const hits = byTestId(tree, id);
  expect(hits, `exactly one [data-testid=${id}]`).toHaveLength(1);
  return hits[0]!;
};
const click = (el: ReactElement) => (propsOf(el).onClick as () => unknown)();
const classOf = (el: ReactElement) => String(propsOf(el).className ?? "").split(/\s+/);
const ofType = (tree: ReactElement[], type: unknown) => tree.filter((el) => el.type === type);
const toggleOf = (i: Island) => one(i.tree(), "qm-share-toggle");
const copyOf = (i: Island) => one(i.tree(), "qm-share-copy");
const fieldOf = (i: Island) => one(i.tree(), "qm-share-url");

/** What a browser hands the island: its page origin, and the navigator capabilities each case sets. */
function browser(nav: Record<string, unknown>) {
  vi.stubGlobal("window", { location: { origin: ORIGIN } });
  vi.stubGlobal("navigator", nav);
}
const clipboardTaking = () => ({ writeText: vi.fn<(text: string) => Promise<void>>(async () => {}) });

/** A stand-in for the field's DOM node, put where the island's ref would point. */
function fakeField(i: Island) {
  const node = { focus: vi.fn(), select: vi.fn(), setSelectionRange: vi.fn(), value: String(propsOf(fieldOf(i)).value) };
  (propsOf(fieldOf(i)).ref as { current: unknown }).current = node;
  return node;
}

beforeEach(() => {
  seaznQr.renderSeaznQr.mockReset();
  seaznQr.renderSeaznQr.mockImplementation(async () => SYMBOL);
  realDraws.mockClear();
  vi.stubGlobal("fetch", realDraws);
});
afterEach(async () => {
  // A case that opened the panel and asserted before the symbol landed: let the draw finish while its browser still stands.
  vi.useRealTimers();
  await flush();
  const reached = realDraws.mock.calls.length;
  vi.unstubAllGlobals();
  expect(reached, "every draw went through the double: the real helper (its logo fetch) never ran").toBe(0);
});

describe("first paint: the link, Copy and the share sheet at once; the QR behind its toggle, closed", () => {
  it("the server's HTML: the field (blocked) and Copy, the closed Show QR toggle; no QR, no native share", () => {
    // The server render: no window, and the store reads its server snapshot (no origin, no navigator.share).
    const html = renderToStaticMarkup(<QuickMatchShare {...PROPS} />);
    const tag = (id: string) => new RegExp(`<[a-z]+[^>]*data-testid="${id}"[^>]*>`).exec(html)?.[0] ?? "";
    expect(tag("qm-share-copy"), "Copy is on first paint").not.toBe("");
    expect(html).toContain(`>${LABELS.copy}</button>`);
    expect(tag("qm-share-toggle")).toContain('aria-expanded="false"');
    expect(html).toContain(LABELS.showQr);
    // The field holds the home PATH until the browser knows its origin: the token's one place in this HTML, and blocked.
    const field = tag("qm-share-url");
    expect(field).toMatch(/class="[^"]*\bph-no-capture\b/);
    expect(field).toContain(`value="/q/${TOKEN}"`);
    expect(html.split(TOKEN).length - 1, "the token is in the field and nowhere else").toBe(1);
    expect(html).not.toContain("<img");
    expect(html).not.toContain('data-testid="qm-share-panel"');
    expect(html).not.toContain(en["share.whatsapp"]);
    expect(seaznQr.renderSeaznQr).not.toHaveBeenCalled();
  });

  it("hydrated on a phone with a share sheet: the link, Copy and Share on WhatsApp with no tap; the QR closed and not drawn", () => {
    browser({ share: vi.fn(), clipboard: clipboardTaking() });
    const i = mount();
    expect(propsOf(fieldOf(i))).toMatchObject({ value: HOME_URL, readOnly: true, "aria-label": LABELS.share });
    expect(textOf(copyOf(i))).toBe(LABELS.copy);
    expect(ofType(i.tree(), ShareButton), "one tap to the share sheet").toHaveLength(1);
    expect(propsOf(toggleOf(i))["aria-expanded"]).toBe(false);
    expect(propsOf(toggleOf(i))["aria-controls"], "no reference to a panel that is not there").toBeUndefined();
    expect(textOf(toggleOf(i))).toBe(LABELS.showQr);
    expect(byTestId(i.tree(), "qm-share-panel")).toHaveLength(0);
    expect(ofType(i.tree(), SeaznQrImage)).toHaveLength(0);
    expect(ofType(i.tree(), SeaznQrPlaceholder)).toHaveLength(0);
    expect(seaznQr.renderSeaznQr).not.toHaveBeenCalled();
  });
});

describe("opening: the home's link, the QR of exactly that link", () => {
  it("builds the QR on the tap from the page's origin plus the home path, and paints it sensitive at the phone-handover cap", async () => {
    browser({ clipboard: clipboardTaking() });
    const i = mount();
    click(toggleOf(i));
    expect(propsOf(toggleOf(i))["aria-expanded"]).toBe(true);
    const panel = one(i.tree(), "qm-share-panel");
    expect(propsOf(toggleOf(i))["aria-controls"]).toBe(propsOf(panel).id);
    // While the symbol is drawn, its frame holds the place.
    expect(ofType(i.tree(), SeaznQrPlaceholder)).toHaveLength(1);
    await flush();
    expect(seaznQr.renderSeaznQr.mock.calls, "the home URL, and nothing else").toEqual([[HOME_URL]]);
    const qr = ofType(i.tree(), SeaznQrImage);
    expect(qr).toHaveLength(1);
    expect(propsOf(qr[0]!)).toMatchObject({ qr: SYMBOL, alt: LABELS.qrAlt, sensitive: true, maxSize: PHONE_HANDOVER_QR_MAX_PX });
    expect(ofType(i.tree(), SeaznQrPlaceholder)).toHaveLength(0);
    // The field shows the same link.
    expect(propsOf(fieldOf(i)).value).toBe(HOME_URL);
    // It is the home's link, never the pad's device link.
    expect(HOME_URL).not.toMatch(/\/score\//);
  });

  it("a second opening reuses the QR; a double tap while it is drawn draws it once; closing takes the QR away, not the link", async () => {
    browser({ clipboard: clipboardTaking() });
    const i = mount();
    click(toggleOf(i)); // open
    click(toggleOf(i)); // close before the symbol lands
    click(toggleOf(i)); // open again
    await flush();
    expect(seaznQr.renderSeaznQr).toHaveBeenCalledTimes(1);
    expect(ofType(i.tree(), SeaznQrImage).map((el) => propsOf(el).qr), "the one symbol the helper drew").toEqual([SYMBOL]);
    click(toggleOf(i));
    expect(propsOf(toggleOf(i))["aria-expanded"]).toBe(false);
    expect(byTestId(i.tree(), "qm-share-panel")).toHaveLength(0);
    expect(ofType(i.tree(), SeaznQrImage)).toHaveLength(0);
    expect(propsOf(fieldOf(i)).value, "the link and Copy stay").toBe(HOME_URL);
    expect(byTestId(i.tree(), "qm-share-copy")).toHaveLength(1);
    click(toggleOf(i));
    expect(ofType(i.tree(), SeaznQrImage), "the second opening paints the symbol at once").toHaveLength(1);
    await flush();
    expect(seaznQr.renderSeaznQr).toHaveBeenCalledTimes(1);
  });

  it("a QR that fails to draw closes its toggle (no empty card, no endless placeholder), leaves the link and Copy, and the next tap tries again", async () => {
    browser({ clipboard: clipboardTaking() });
    seaznQr.renderSeaznQr.mockRejectedValueOnce(new Error("chunk failed to load"));
    const i = mount();
    click(toggleOf(i));
    await flush();
    expect(propsOf(toggleOf(i))["aria-expanded"], "closed again, so its next tap is the retry").toBe(false);
    expect(byTestId(i.tree(), "qm-share-panel")).toHaveLength(0);
    expect(ofType(i.tree(), SeaznQrImage)).toHaveLength(0);
    expect(ofType(i.tree(), SeaznQrPlaceholder)).toHaveLength(0);
    expect(propsOf(fieldOf(i)).value).toBe(HOME_URL);
    expect(byTestId(i.tree(), "qm-share-copy")).toHaveLength(1);
    click(toggleOf(i));
    expect(propsOf(toggleOf(i))["aria-expanded"]).toBe(true);
    await flush();
    expect(seaznQr.renderSeaznQr.mock.calls).toEqual([[HOME_URL], [HOME_URL]]);
    expect(ofType(i.tree(), SeaznQrImage)).toHaveLength(1);
  });
});

describe("Copy", () => {
  it("puts exactly the home URL on the clipboard and says Copied, then Copy link again; a second Copy copies again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const clipboard = clipboardTaking();
    browser({ clipboard });
    const i = mount();
    const field = fakeField(i);
    await click(copyOf(i));
    expect(clipboard.writeText.mock.calls).toEqual([[HOME_URL]]);
    expect(textOf(copyOf(i))).toBe(LABELS.copied);
    expect(textOf(one(i.tree(), "qm-share-status")), "announced, not only shown").toBe(LABELS.copied);
    expect(field.select, "the clipboard took it: nothing to select").not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(textOf(copyOf(i))).toBe(LABELS.copy);
    expect(textOf(one(i.tree(), "qm-share-status"))).toBe("");
    await click(copyOf(i));
    expect(clipboard.writeText.mock.calls).toEqual([[HOME_URL], [HOME_URL]]);
    expect(textOf(copyOf(i))).toBe(LABELS.copied);
  });

  it("a second Copy while 'Copied' still shows is announced again: the live region stays, its words are a NEW node per copy", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    browser({ clipboard: clipboardTaking() });
    const i = mount();
    // The region is there from first paint: a live region inserted with its words already in it is not announced.
    expect(textOf(one(i.tree(), "qm-share-status"))).toBe("");
    const words = () => {
      const nodes = Children.toArray(propsOf(one(i.tree(), "qm-share-status")).children as ReactNode).filter(isValidElement);
      expect(nodes, "the status holds its words in one node").toHaveLength(1);
      return nodes[0]!;
    };
    await click(copyOf(i));
    const first = words();
    expect(textOf(first)).toBe(LABELS.copied);
    await vi.advanceTimersByTimeAsync(500);
    expect(textOf(copyOf(i)), "inside the 2 s: the button still says Copied").toBe(LABELS.copied);
    await click(copyOf(i));
    const second = words();
    expect(textOf(second)).toBe(LABELS.copied);
    // Same words, so only a replaced node is a change a screen reader hears.
    expect(second.key, "the second copy's words are a new node").not.toBe(first.key);
    await click(copyOf(i));
    expect(new Set([first.key, second.key, words().key]).size, "and a third, a third").toBe(3);
  });

  it.each([
    ["no clipboard at all (an insecure page, an old browser)", () => ({})],
    ["a clipboard that refuses (no permission)", () => ({ clipboard: { writeText: vi.fn(async () => Promise.reject(new Error("NotAllowedError"))) } })],
  ])("%s: Copy selects the whole link in its read-only field and never claims Copied", async (_why, nav) => {
    browser(nav());
    const i = mount();
    const field = fakeField(i);
    await click(copyOf(i));
    await flush();
    expect(field.focus).toHaveBeenCalledTimes(1);
    expect(field.select).toHaveBeenCalledTimes(1);
    expect(field.setSelectionRange.mock.calls).toEqual([[0, HOME_URL.length]]);
    expect(propsOf(fieldOf(i)).readOnly).toBe(true);
    expect(textOf(copyOf(i))).toBe(LABELS.copy);
    expect(textOf(one(i.tree(), "qm-share-status"))).toBe("");
    expect(propsOf(toggleOf(i))["aria-expanded"], "Copy never opens the QR").toBe(false);
  });
});

describe("the native share sheet (D14)", () => {
  it("is offered beside Copy where navigator.share exists, with the home URL, the match's name and the message", () => {
    browser({ share: vi.fn(), clipboard: clipboardTaking() });
    const i = mount();
    const shares = ofType(i.tree(), ShareButton);
    expect(shares).toHaveLength(1);
    expect(propsOf(shares[0]!)).toMatchObject({ url: HOME_URL, title: NAME, text: LABELS.shareNative });
    expect(LABELS.shareNative).toContain(NAME);
    // Beside Copy: the same row.
    const row = one(i.tree(), "qm-share-actions");
    const inRow = (el: ReactElement) => {
      const found: unknown[] = [];
      const visit = (n: ReactNode) => {
        if (Array.isArray(n)) return n.forEach(visit);
        if (!isValidElement(n)) return;
        found.push(n);
        visit((n.props as { children?: ReactNode }).children);
      };
      visit(propsOf(row).children as ReactNode);
      return found.includes(el);
    };
    expect(inRow(copyOf(i)) && inRow(shares[0]!)).toBe(true);
  });

  it("is not offered where navigator.share is missing (a desktop browser), open or closed: Copy and the QR only", () => {
    browser({ clipboard: clipboardTaking() });
    const i = mount();
    expect(ofType(i.tree(), ShareButton)).toHaveLength(0);
    expect(byTestId(i.tree(), "qm-share-copy")).toHaveLength(1);
    click(toggleOf(i));
    expect(ofType(i.tree(), ShareButton)).toHaveLength(0);
    expect(byTestId(i.tree(), "qm-share-copy")).toHaveLength(1);
  });
});

describe("session replay never records the link (O3)", () => {
  it("every element that holds the URL, or an ancestor, carries ph-no-capture; the only component handed it paints none", async () => {
    browser({ share: vi.fn(), clipboard: clipboardTaking() });
    const i = mount();
    click(toggleOf(i));
    await flush();
    const tree = i.tree();
    const holds = (el: ReactElement) =>
      Object.entries(propsOf(el)).some(
        ([k, v]) => (k !== "children" && typeof v === "string" && v.includes(TOKEN)) || (k === "children" && typeof v === "string" && v.includes(TOKEN)),
      );
    // Every element's ancestors, found by walking the tree from its root.
    const parents = new Map<ReactElement, ReactElement | null>();
    const visit = (n: ReactNode, parent: ReactElement | null) => {
      if (Array.isArray(n)) return n.forEach((c) => visit(c, parent));
      if (!isValidElement(n)) return;
      parents.set(n as ReactElement, parent);
      visit((n.props as { children?: ReactNode }).children, n as ReactElement);
    };
    visit(tree[0], null);
    const blocked = (el: ReactElement) => {
      for (let p: ReactElement | null = el; p; p = parents.get(p) ?? null) if (classOf(p).includes("ph-no-capture")) return true;
      return false;
    };
    let checked = 0;
    const holders: string[] = [];
    for (const el of tree) {
      if (!holds(el)) continue;
      if (typeof el.type === "string") {
        checked++;
        expect(blocked(el), `<${el.type} data-testid=${String(propsOf(el)["data-testid"])}> holds the link`).toBe(true);
      } else holders.push((el.type as { name: string }).name);
    }
    expect(checked, "anti-vacuity: the field holds the link").toBeGreaterThanOrEqual(1);
    // ShareButton holds it to hand to the share sheet and paints none (the painter scan finds no site in its file).
    expect(holders).toEqual(["ShareButton"]);
    // The QR: painted sensitive (SeaznQrImage blocks the image and its enlarged overlay), on a blocked card.
    const qr = ofType(tree, SeaznQrImage)[0]!;
    expect(propsOf(qr).sensitive).toBe(true);
    expect(blocked(qr)).toBe(true);
    expect(classOf(fieldOf(i))).toContain("ph-no-capture");
  });
});

describe("phone first", () => {
  it("every control is a 44px target, and the link field shrinks inside its box instead of widening the page", () => {
    browser({ share: vi.fn(), clipboard: clipboardTaking() });
    const i = mount();
    click(toggleOf(i));
    let checked = 0;
    for (const el of [toggleOf(i), copyOf(i), fieldOf(i), ofType(i.tree(), ShareButton)[0]!]) {
      expect(classOf(el), String(propsOf(el)["data-testid"] ?? "ShareButton")).toContain("min-h-11");
      checked++;
    }
    expect(checked).toBe(4);
    expect(classOf(fieldOf(i))).toEqual(expect.arrayContaining(["w-full", "min-w-0"]));
    expect(classOf(one(i.tree(), "qm-share"))).toContain("min-w-0");
    expect(classOf(one(i.tree(), "qm-share-actions"))).toEqual(expect.arrayContaining(["min-w-0", "flex-wrap"]));
    expect(classOf(one(i.tree(), "qm-share-panel"))).toContain("min-w-0");
  });
});
