// SeaznQrImage — the shared QR image with tap to enlarge (owner ruling D10, 2026-10-04), and the replay block on a
// QR that paints a secret (review R2, D10a). `apps/web` vitest is node — no DOM — so this file proves what a node
// render CAN, in three layers:
//   1. the markup (`renderToStaticMarkup`): the classes, names and sizes each part carries;
//   2. the open/close state machine of `SeaznQrImage` through the hook harness — tap, close, reopen, and a payload
//      that changes while it is enlarged — as named cases AND as a fast-check model over random sequences (TEST-
//      STRATEGY rule 10: ordered user actions);
//   3. `QrEnlarged`'s effects with the browser globals doubled: the portal's target, Esc, the Tab trap, a resize, and
//      the wake lock held while open and released on close (also when the close beats the grant).
// What a node render cannot see — the real portal, real focus, the cascade, the painted size — is the walkthroughs'
// (`e2e/helpers/qr-enlarge.ts`, on all three call sites).
//
// No sport is read anywhere in this component: one call shape is the sweep.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DictProvider } from "@/components/i18n/dict-provider";
import { propsOf, renderIsland, walk } from "@/components/__tests__/_hook-harness";
import { QR_NO_CAPTURE, QrEnlarged, QrEnlargedView, SeaznQrImage, qrCaptureClass } from "@/components/v2/seazn-qr-image";
import { enlargedQrSize } from "@/lib/qr-enlarge";
import type { Dict } from "@/lib/i18n-constants";

const en = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../dictionaries/en/ui.json"), "utf8")) as Dict & Record<string, string>;
const render = (node: ReactNode) => renderToStaticMarkup(<DictProvider dict={en} locale="en">{node}</DictProvider>);

describe("SeaznQrImage / QrEnlargedView — D10, and the replay block (review R2)", () => {
  const view = (sensitive: boolean) =>
    renderToStaticMarkup(
      <QrEnlargedView src="data:image/svg+xml,x" alt="QR" sensitive={sensitive} size={288} label="Enlarge" closeLabel="Close" caption="Turn up" onClose={() => {}} />,
    );
  const closed = (sensitive: boolean) => render(<SeaznQrImage testId="stream-qr" sensitive={sensitive} src="data:image/svg+xml,x" alt="QR" />);

  it("sensitive: the overlay ROOT and the enlarged IMG both carry ph-no-capture", () => {
    const html = view(true);
    expect(html).toMatch(new RegExp(`data-testid="qr-enlarged"[^>]*class="[^"]*\\b${QR_NO_CAPTURE}\\b`));
    expect(html).toMatch(new RegExp(`data-testid="qr-enlarged-img"[^>]*class="[^"]*\\b${QR_NO_CAPTURE}\\b`));
  });

  it("not sensitive: neither does (the positive twin, so the class is not simply always on)", () => {
    expect(view(false)).not.toMatch(new RegExp(QR_NO_CAPTURE));
    expect(qrCaptureClass(false)).toBe("");
    expect(qrCaptureClass(true)).toBe("ph-no-capture"); // the class PostHog's recorder blocks — its name, not ours
  });

  it("the inline image follows `sensitive` too; the trigger names the action and wraps the image; the caption shows", () => {
    expect(closed(true)).toMatch(new RegExp(`data-testid="stream-qr"[^>]*class="[^"]*\\b${QR_NO_CAPTURE}\\b`));
    expect(closed(false)).not.toMatch(new RegExp(QR_NO_CAPTURE));
    const html = closed(true);
    expect(html).toMatch(
      new RegExp(`data-testid="stream-qr-enlarge"[^>]*aria-haspopup="dialog"[^>]*aria-label="${en["qr.enlarge"]}"[^>]*>[\\s\\S]*data-testid="stream-qr"`),
    );
    expect(en["qr.enlarge"], "the trigger names the ACTION, not the image").toBe("Enlarge QR code");
    expect(html).toContain(`>${en["qr.tapToEnlarge"]}<`);
    expect(html).not.toContain('data-testid="qr-enlarged"'); // closed renders no overlay
  });

  it("the caller's classes and declared size reach the inline image untouched", () => {
    const html = render(
      <SeaznQrImage testId="checkin-qr" sensitive src="data:image/svg+xml,x" alt="QR" className="mx-auto rounded-lg border" width={176} height={176} />,
    );
    expect(html).toMatch(/data-testid="checkin-qr"[^>]*class="ph-no-capture mx-auto rounded-lg border"[^>]*width="176"[^>]*height="176"/);
  });

  it("the overlay is a named modal dialog with a 44 px ✕ and the brightness caption", () => {
    const html = view(true);
    expect(html).toMatch(/role="dialog"[^>]*aria-modal="true"[^>]*aria-label="Enlarge"/);
    expect(html).toMatch(/data-testid="qr-enlarged-close"[^>]*aria-label="Close"[^>]*class="[^"]*\bh-11 w-11\b/);
    expect(html).toContain("Turn up");
    expect(html).toMatch(/data-testid="qr-enlarged-img"[^>]*style="width:288px;height:288px"/);
    // Landscape puts the caption beside the QR (review R6) — and portrait stacks it.
    expect(html).toMatch(/data-testid="qr-enlarged"[^>]*class="[^"]*\bflex-col\b[^"]*\blandscape:flex-row\b/);
  });

  it("a tap on the overlay, and on its ✕, each close it ONCE and stop the event at the overlay (a portal still bubbles to its owner)", () => {
    const onClose = vi.fn();
    const el = QrEnlargedView({ src: "x", alt: "QR", sensitive: true, size: 10, label: "L", closeLabel: "C", caption: "c", onClose });
    const tree = walk(el);
    const root = tree.find((n) => propsOf(n)["data-testid"] === "qr-enlarged")!;
    const close = tree.find((n) => propsOf(n)["data-testid"] === "qr-enlarged-close")!;
    let checked = 0;
    for (const target of [root, close]) {
      const stopPropagation = vi.fn();
      onClose.mockClear();
      (propsOf(target).onClick as (e: { stopPropagation: () => void }) => void)({ stopPropagation });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(stopPropagation).toHaveBeenCalledTimes(1);
      checked++;
    }
    expect(checked).toBe(2);
  });
});

// ─── 2. The state machine: closed ⇄ open, and the payload under it ───────────────────────────────────────────────────

type ImgProps = Parameters<typeof SeaznQrImage>[0];
const base: ImgProps = { testId: "stream-qr", sensitive: true, src: "data:image/svg+xml,A", alt: "QR" };
const byTestId = (tree: ReactElement[], id: string) => tree.find((el) => propsOf(el)["data-testid"] === id);
const overlayOf = (tree: ReactElement[]) => tree.find((el) => el.type === QrEnlarged);

function mountImage(props: ImgProps = base) {
  const island = renderIsland(SeaznQrImage, props);
  const focus = vi.fn();
  // The trigger's ref box: the harness hands the SAME object back every render, so the focus double sticks.
  const trigger = byTestId(island.tree(), `${props.testId}-enlarge`)!;
  (propsOf(trigger).ref as { current: unknown }).current = { focus };
  const tap = () => (propsOf(byTestId(island.tree(), `${props.testId}-enlarge`)!).onClick as () => void)();
  const close = () => (propsOf(overlayOf(island.tree())!).onClose as () => void)();
  return { island, focus, tap, close };
}

describe("SeaznQrImage — closed → open → closed, reopen, and a payload that changes while enlarged (rule 1)", () => {
  it("the empty case first: CLOSED renders the trigger around the image and the caption, and no overlay", () => {
    const { island } = mountImage();
    const tree = island.tree();
    expect(byTestId(tree, "stream-qr-enlarge")).toBeDefined();
    expect(propsOf(byTestId(tree, "stream-qr")!).src).toBe(base.src);
    expect(island.text()).toContain(en["qr.tapToEnlarge"]);
    expect(overlayOf(tree)).toBeUndefined();
  });

  it("tap → OPEN with this image's src, alt and sensitivity; close → CLOSED and focus back on the QR; tap again → OPEN again", () => {
    const { island, focus, tap, close } = mountImage();
    tap();
    const open = overlayOf(island.tree());
    expect(open, "one tap opens it").toBeDefined();
    expect(propsOf(open!)).toMatchObject({ src: base.src, alt: base.alt, sensitive: true });
    expect(focus, "focus moves only on close").not.toHaveBeenCalled();
    close();
    expect(overlayOf(island.tree())).toBeUndefined();
    expect(focus, "focus returns to the QR").toHaveBeenCalledTimes(1);
    tap();
    expect(overlayOf(island.tree()), "a second tap reopens it").toBeDefined();
    close();
    expect(focus).toHaveBeenCalledTimes(2);
  });

  it("a payload that changes WHILE enlarged: the overlay shows the new symbol at once — never the old one", () => {
    const { island, tap } = mountImage();
    tap();
    island.rerender({ ...base, src: "data:image/svg+xml,B" });
    expect(propsOf(overlayOf(island.tree())!).src).toBe("data:image/svg+xml,B");
    expect(propsOf(byTestId(island.tree(), "stream-qr")!).src).toBe("data:image/svg+xml,B");
  });

  it("model (fast-check, rule 10): any sequence of tap / close / new payload keeps the overlay iff open, on the CURRENT payload, and returns focus once per close", () => {
    type Action = { kind: "tap" } | { kind: "close" } | { kind: "payload"; src: string };
    const action: fc.Arbitrary<Action> = fc.oneof(
      fc.constant<Action>({ kind: "tap" }),
      fc.constant<Action>({ kind: "close" }),
      fc.constantFrom("A", "B", "C").map<Action>((s) => ({ kind: "payload", src: `data:image/svg+xml,${s}` })),
    );
    let steps = 0;
    let opens = 0;
    let payloadsWhileOpen = 0;
    fc.assert(
      fc.property(fc.array(action, { minLength: 1, maxLength: 12 }), fc.boolean(), (actions, sensitive) => {
        const props = { ...base, sensitive };
        const { island, focus, tap, close } = mountImage(props);
        const model = { open: false, src: props.src, focusReturns: 0 };
        for (const a of actions) {
          if (a.kind === "tap") {
            tap(); // a tap on the trigger; while open the overlay covers it in a browser, and here it is a no-op
            model.open = true;
          } else if (a.kind === "close") {
            if (!model.open) continue; // nothing to close: the ✕ and the overlay only exist while open
            close();
            model.open = false;
            model.focusReturns++;
          } else {
            if (model.open) payloadsWhileOpen++;
            island.rerender({ ...props, src: a.src });
            model.src = a.src;
          }
          const tree = island.tree();
          const overlay = overlayOf(tree);
          expect(!!overlay, `open after ${JSON.stringify(a)}`).toBe(model.open);
          if (overlay) {
            opens++;
            expect(propsOf(overlay).src).toBe(model.src);
            expect(propsOf(overlay).sensitive).toBe(sensitive);
          }
          expect(propsOf(byTestId(tree, "stream-qr")!).src).toBe(model.src);
          expect(focus).toHaveBeenCalledTimes(model.focusReturns);
          steps++;
        }
      }),
      { seed: 20261001, numRuns: 200 },
    );
    // Anti-vacuity: the model checked real steps, saw the overlay open, and changed a payload under an open overlay.
    expect(steps).toBeGreaterThan(200);
    expect(opens).toBeGreaterThan(50);
    expect(payloadsWhileOpen).toBeGreaterThan(10);
  });
});

// ─── 3. QrEnlarged's effects, with the browser doubled ──────────────────────────────────────────────────────────────

type Listener = (e: unknown) => void;
function browser(opts: { vw: number; vh: number; wake?: "grant" | "pending" | "none" }) {
  const winListeners = new Map<string, Listener>();
  const docListeners = new Map<string, Listener>();
  const removed: string[] = [];
  const release = vi.fn(() => Promise.resolve());
  let grant: (s: { release: typeof release }) => void = () => {};
  const request = vi.fn<(type: "screen") => Promise<{ release: typeof release }>>(() =>
    opts.wake === "pending" ? new Promise<{ release: typeof release }>((r) => { grant = r; }) : Promise.resolve({ release }),
  );
  const win = {
    innerWidth: opts.vw,
    innerHeight: opts.vh,
    addEventListener: (t: string, l: Listener) => winListeners.set(t, l),
    removeEventListener: (t: string, l: Listener) => { if (winListeners.get(t) === l) removed.push(`window:${t}`); },
  };
  const body = { nodeType: 1 };
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", {
    body,
    addEventListener: (t: string, l: Listener) => docListeners.set(t, l),
    removeEventListener: (t: string, l: Listener) => { if (docListeners.get(t) === l) removed.push(`document:${t}`); },
  });
  vi.stubGlobal("navigator", opts.wake === "none" ? {} : { wakeLock: { request } });
  return { win, body, winListeners, docListeners, removed, request, release, grant: () => grant({ release }) };
}

/** `QrEnlarged` returns a PORTAL, which the harness's `walk` does not open: unwrap it, and record its target. */
const portalTargets: unknown[] = [];
const throughPortal = (node: ReactNode): ReactElement[] => {
  const p = node as { containerInfo?: unknown; children?: ReactNode } | null;
  if (p && !isValidElement(p) && "containerInfo" in p) {
    portalTargets.push(p.containerInfo);
    return walk(p.children);
  }
  return walk(node);
};
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("QrEnlarged — the portal, Esc, the focus trap, the size kept to the viewport, and the wake lock (D10)", () => {
  beforeEach(() => {
    portalTargets.length = 0;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const props = { src: "data:image/svg+xml,A", alt: "QR", sensitive: true };
  const viewOf = (tree: ReactElement[]) => tree.find((el) => el.type === QrEnlargedView)!;

  it("renders into document.body, sized from the viewport, named and captioned in the page's language", () => {
    const b = browser({ vw: 320, vh: 568 });
    const island = renderIsland(QrEnlarged, { ...props, onClose: vi.fn() }, throughPortal);
    const v = viewOf(island.tree());
    expect(portalTargets.at(-1), "a portal on document.body").toBe(b.body);
    expect(propsOf(v)).toMatchObject({
      size: enlargedQrSize(320, 568),
      label: en["qr.enlarged.name"],
      closeLabel: en["qr.enlarged.close"],
      caption: en["qr.enlarged.brightness"],
      sensitive: true,
      src: props.src,
    });
    island.unmount();
  });

  it("Esc closes it; any other key does not; Tab is held on the ✕ (the dialog's only control)", () => {
    const b = browser({ vw: 320, vh: 568 });
    const onClose = vi.fn();
    const island = renderIsland(QrEnlarged, { ...props, onClose }, throughPortal);
    const key = b.docListeners.get("keydown")!;
    expect(key, "a keydown listener is registered while open").toBeDefined();
    key({ key: "Enter", preventDefault: vi.fn() });
    expect(onClose).not.toHaveBeenCalled();
    key({ key: "Escape", preventDefault: vi.fn() });
    expect(onClose).toHaveBeenCalledTimes(1);
    const focus = vi.fn();
    (propsOf(viewOf(island.tree())).closeRef as { current: unknown }).current = { focus };
    const preventDefault = vi.fn();
    key({ key: "Tab", preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
    island.unmount();
  });

  it("Esc calls the LATEST onClose a re-render handed down, never the one captured when it opened", () => {
    const b = browser({ vw: 320, vh: 568 });
    const first = vi.fn();
    const second = vi.fn();
    const island = renderIsland(QrEnlarged, { ...props, onClose: first }, throughPortal);
    island.rerender({ ...props, onClose: second });
    b.docListeners.get("keydown")!({ key: "Escape", preventDefault: vi.fn() });
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    island.unmount();
  });

  it("a resize (a rotation, a window drag) re-derives the size from the NEW viewport", () => {
    const b = browser({ vw: 390, vh: 844 });
    const island = renderIsland(QrEnlarged, { ...props, onClose: vi.fn() }, throughPortal);
    expect(propsOf(viewOf(island.tree())).size).toBe(enlargedQrSize(390, 844));
    b.win.innerWidth = 1280;
    b.win.innerHeight = 800;
    b.winListeners.get("resize")!({});
    expect(propsOf(viewOf(island.tree())).size).toBe(enlargedQrSize(1280, 800));
    expect(enlargedQrSize(1280, 800), "premise: the two viewports differ in size").not.toBe(enlargedQrSize(390, 844));
    island.unmount();
  });

  it("open holds a screen wake lock; close releases it and removes every listener it added", async () => {
    const b = browser({ vw: 320, vh: 568, wake: "grant" });
    const island = renderIsland(QrEnlarged, { ...props, onClose: vi.fn() }, throughPortal);
    await flush();
    expect(b.request).toHaveBeenCalledTimes(1);
    expect(b.request).toHaveBeenCalledWith("screen");
    expect(b.release).not.toHaveBeenCalled();
    island.unmount();
    await flush();
    expect(b.release).toHaveBeenCalledTimes(1);
    expect(b.removed.sort()).toEqual(["document:keydown", "window:resize"]);
  });

  it("closed while the lock is still PENDING: the lock that arrives later is released at once", async () => {
    const b = browser({ vw: 320, vh: 568, wake: "pending" });
    const island = renderIsland(QrEnlarged, { ...props, onClose: vi.fn() }, throughPortal);
    await flush();
    expect(b.request).toHaveBeenCalledTimes(1);
    island.unmount();
    b.grant();
    await flush();
    expect(b.release).toHaveBeenCalledTimes(1);
  });

  it("no Wake Lock API: it opens, sizes and closes all the same", async () => {
    const b = browser({ vw: 568, vh: 320, wake: "none" });
    const island = renderIsland(QrEnlarged, { ...props, onClose: vi.fn() }, throughPortal);
    expect(propsOf(viewOf(island.tree())).size).toBe(enlargedQrSize(568, 320));
    await flush();
    expect(() => island.unmount()).not.toThrow();
    expect(b.removed.sort()).toEqual(["document:keydown", "window:resize"]);
  });
});
