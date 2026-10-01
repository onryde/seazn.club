// SeaznQrImage — the shared QR image with tap to enlarge (owner ruling D10, 2026-10-04), and the replay block on a
// QR that paints a secret (review R2, D10a). `apps/web` vitest is node — no DOM — so this file proves what a node
// render CAN, in three layers:
//   1. the markup (`renderToStaticMarkup`): the classes, names and sizes each part carries;
//   2. the open/close state machine of `SeaznQrImage` through the hook harness — tap, close, reopen, and a payload
//      that changes while it is enlarged — as named cases AND as a fast-check model over random sequences (TEST-
//      STRATEGY rule 10: ordered user actions);
//   3. `QrEnlarged`'s effects with the browser globals doubled: the portal's target, Esc, the Tab trap, a resize, and
//      the wake lock held while open and released on close (also when the close beats the grant), and taken again
//      when the page comes back from hidden (review m-1);
//   4. the painted size (B6 fix round 1, ruling I-2): the measured box snapped to whole device px per module, inline,
//      on the placeholder and enlarged.
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
import { QR_NO_CAPTURE, QrEnlarged, QrEnlargedView, SeaznQrImage, SeaznQrPlaceholder, qrCaptureClass } from "@/components/v2/seazn-qr-image";
import {
  QR_ENLARGE_CAPTION_H_PX,
  QR_ENLARGE_CAPTION_W_PX,
  QR_ENLARGE_CLOSE_BAND_PX,
  QR_ENLARGE_GAP_PX,
  enlargedQrSize,
} from "@/lib/qr-enlarge";
import type { SeaznQr } from "@/lib/seazn-qr";
import type { Dict } from "@/lib/i18n-constants";

const en = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../../dictionaries/en/ui.json"), "utf8")) as Dict & Record<string, string>;
const render = (node: ReactNode) => renderToStaticMarkup(<DictProvider dict={en} locale="en">{node}</DictProvider>);

describe("SeaznQrImage / QrEnlargedView — D10, and the replay block (review R2)", () => {
  const view = (sensitive: boolean) =>
    renderToStaticMarkup(
      <QrEnlargedView src="data:image/svg+xml,x" alt="QR" sensitive={sensitive} size={288} label="Enlarge" closeLabel="Close" caption="Turn up" onClose={() => {}} />,
    );
  const closed = (sensitive: boolean) =>
    render(<SeaznQrImage testId="stream-qr" sensitive={sensitive} qr={{ src: "data:image/svg+xml,x", modules: 113 }} alt="QR" maxSize={363} />);

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

  it("the caller's classes reach the inline image untouched; before the box is measured it paints its cap, SNAPPED", () => {
    const html = render(
      <SeaznQrImage testId="checkin-qr" sensitive qr={{ src: "data:image/svg+xml,x", modules: 89 }} alt="QR" maxSize={288} className="rounded-lg" />,
    );
    expect(html).toMatch(/data-testid="checkin-qr"[^>]*class="ph-no-capture mx-auto block rounded-lg"/);
    // 288 holds three 89-module scales (267) and not four (356): the size is 3 × 89, never the cap itself.
    expect(html).toMatch(/data-testid="checkin-qr"[^>]*style="width:267px;height:267px"/);
  });

  it("the overlay's reserved room IS its layout (review m-2): the gap, the caption beside and under, the ✕ band", () => {
    const html = view(true);
    const tw = (cls: string) => Number(/-(\d+)$/.exec(cls)![1]) * 4; // Tailwind's spacing scale: N × 4 px
    const rootCls = /data-testid="qr-enlarged"[^>]*class="([^"]*)"/.exec(html)![1]!.split(/\s+/);
    const gap = rootCls.find((c) => /^gap-\d+$/.test(c))!;
    expect(tw(gap), gap).toBe(QR_ENLARGE_GAP_PX);
    const captionCls = /<p class="([^"]*)"/.exec(html)![1]!.split(/\s+/);
    const beside = captionCls.find((c) => /^landscape:w-\d+$/.test(c))!;
    expect(tw(beside), beside).toBe(QR_ENLARGE_CAPTION_W_PX);
    expect(captionCls, "the caption keeps its width beside the QR").toContain("landscape:shrink-0");
    // text-sm is 14 px on a 20 px line; the reserve is two lines.
    expect(captionCls).toContain("text-sm");
    expect(QR_ENLARGE_CAPTION_H_PX).toBe(2 * 20);
    const closeCls = /data-testid="qr-enlarged-close"[^>]*class="([^"]*)"/.exec(html)![1]!.split(/\s+/);
    const top = closeCls.find((c) => /^top-\d+$/.test(c))!;
    const h = closeCls.find((c) => /^h-\d+$/.test(c))!;
    expect(tw(top) + tw(h), `${top} + ${h}`).toBe(QR_ENLARGE_CLOSE_BAND_PX);
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
const qrOf = (s: string, modules = 113): SeaznQr => ({ src: `data:image/svg+xml,${s}`, modules });
const base: ImgProps = { testId: "stream-qr", sensitive: true, qr: qrOf("A"), alt: "QR", maxSize: 363 };
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
    expect(propsOf(byTestId(tree, "stream-qr")!).src).toBe(base.qr.src);
    expect(island.text()).toContain(en["qr.tapToEnlarge"]);
    expect(overlayOf(tree)).toBeUndefined();
  });

  it("tap → OPEN with this image's src, alt and sensitivity; close → CLOSED and focus back on the QR; tap again → OPEN again", () => {
    const { island, focus, tap, close } = mountImage();
    tap();
    const open = overlayOf(island.tree());
    expect(open, "one tap opens it").toBeDefined();
    expect(propsOf(open!)).toMatchObject({ qr: base.qr, alt: base.alt, sensitive: true });
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
    island.rerender({ ...base, qr: qrOf("B") });
    expect(propsOf(overlayOf(island.tree())!).qr).toEqual(qrOf("B"));
    expect(propsOf(byTestId(island.tree(), "stream-qr")!).src).toBe("data:image/svg+xml,B");
  });

  it("model (fast-check, rule 10): any sequence of tap / close / new payload keeps the overlay iff open, on the CURRENT payload, and returns focus once per close", () => {
    type Action = { kind: "tap" } | { kind: "close" } | { kind: "payload"; qr: SeaznQr };
    const action: fc.Arbitrary<Action> = fc.oneof(
      fc.constant<Action>({ kind: "tap" }),
      fc.constant<Action>({ kind: "close" }),
      fc.constantFrom("A", "B", "C").map<Action>((s) => ({ kind: "payload", qr: qrOf(s) })),
    );
    let steps = 0;
    let opens = 0;
    let payloadsWhileOpen = 0;
    fc.assert(
      fc.property(fc.array(action, { minLength: 1, maxLength: 12 }), fc.boolean(), (actions, sensitive) => {
        const props = { ...base, sensitive };
        const { island, focus, tap, close } = mountImage(props);
        const model = { open: false, qr: props.qr, focusReturns: 0 };
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
            island.rerender({ ...props, qr: a.qr });
            model.qr = a.qr;
          }
          const tree = island.tree();
          const overlay = overlayOf(tree);
          expect(!!overlay, `open after ${JSON.stringify(a)}`).toBe(model.open);
          if (overlay) {
            opens++;
            expect(propsOf(overlay).qr).toEqual(model.qr);
            expect(propsOf(overlay).sensitive).toBe(sensitive);
          }
          expect(propsOf(byTestId(tree, "stream-qr")!).src).toBe(model.qr.src);
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
function browser(opts: { vw: number; vh: number; dpr?: number; wake?: "grant" | "pending" | "none" }) {
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
    devicePixelRatio: opts.dpr ?? 1,
    addEventListener: (t: string, l: Listener) => winListeners.set(t, l),
    removeEventListener: (t: string, l: Listener) => { if (winListeners.get(t) === l) removed.push(`window:${t}`); },
  };
  const body = { nodeType: 1 };
  vi.stubGlobal("window", win);
  const doc = {
    body,
    visibilityState: "visible" as "visible" | "hidden",
    addEventListener: (t: string, l: Listener) => docListeners.set(t, l),
    removeEventListener: (t: string, l: Listener) => { if (docListeners.get(t) === l) removed.push(`document:${t}`); },
  };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("navigator", opts.wake === "none" ? {} : { wakeLock: { request } });
  /** The page hidden (a tab switch, the screen locked) and shown again — the browser drops the lock on hide. */
  const visibility = (v: "visible" | "hidden") => {
    doc.visibilityState = v;
    docListeners.get("visibilitychange")?.({});
  };
  return { win, body, winListeners, docListeners, removed, request, release, visibility, grant: () => grant({ release }) };
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
  const props = { qr: qrOf("A"), alt: "QR", sensitive: true };
  const viewOf = (tree: ReactElement[]) => tree.find((el) => el.type === QrEnlargedView)!;

  it("renders into document.body, sized from the viewport, named and captioned in the page's language", () => {
    const b = browser({ vw: 320, vh: 568 });
    const island = renderIsland(QrEnlarged, { ...props, onClose: vi.fn() }, throughPortal);
    const v = viewOf(island.tree());
    expect(portalTargets.at(-1), "a portal on document.body").toBe(b.body);
    expect(propsOf(v)).toMatchObject({
      // D10's room at 320 × 568 is 320 − 32 = 288, which holds two 113-module scales (226) and not three (339).
      size: 226,
      label: en["qr.enlarged.name"],
      closeLabel: en["qr.enlarged.close"],
      caption: en["qr.enlarged.brightness"],
      sensitive: true,
      src: props.qr.src,
    });
    island.unmount();
  });

  it("the painted size is the room SNAPPED to whole device px per module — 1×, 2×, 3× and a 125 % zoom (ruling I-2)", () => {
    // [vw, vh, DPR, modules, expected CSS px, how — D10's room, then the largest whole device-px scale in it]
    const rows: [number, number, number, number, number, string][] = [
      [320, 568, 1, 113, 226, "288 room: 2 × 113"],
      [1280, 800, 1, 113, 678, "768 room: 6 × 113"],
      [390, 844, 3, 113, 1017 / 3, "358 room = 1074 device px: 9 × 113 = 1017"],
      [256, 700, 1.25, 113, 226 / 1.25, "224 room = 280 device px: 2 × 113 = 226 (two per module — the 125 % remedy)"],
      [320, 568, 2, 57, 570 / 2, "288 room = 576 device px: 10 × 57 = 570"],
      [320, 568, 1, 89, 267, "288 room: 3 × 89"],
    ];
    let checked = 0;
    for (const [vw, vh, dpr, modules, want, how] of rows) {
      browser({ vw, vh, dpr });
      const island = renderIsland(QrEnlarged, { ...props, qr: qrOf("A", modules), onClose: vi.fn() }, throughPortal);
      expect(propsOf(viewOf(island.tree())).size as number, how).toBeCloseTo(want, 9);
      island.unmount();
      vi.unstubAllGlobals();
      checked++;
    }
    expect(checked).toBe(rows.length);
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

  it("a resize (a rotation, a window drag, a zoom) re-derives the size from the NEW viewport and DPR", () => {
    const b = browser({ vw: 390, vh: 844 });
    const island = renderIsland(QrEnlarged, { ...props, onClose: vi.fn() }, throughPortal);
    expect(propsOf(viewOf(island.tree())).size, "358 room: 3 × 113").toBe(339);
    b.win.innerWidth = 1280;
    b.win.innerHeight = 800;
    b.winListeners.get("resize")!({});
    expect(propsOf(viewOf(island.tree())).size, "768 room: 6 × 113").toBe(678);
    b.win.devicePixelRatio = 2;
    b.winListeners.get("resize")!({});
    expect(propsOf(viewOf(island.tree())).size, "1536 device px: 13 × 113 = 1469").toBe(1469 / 2);
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
    expect(b.removed.sort()).toEqual(["document:keydown", "document:visibilitychange", "window:resize"]);
  });

  it("hidden → shown while open takes the lock AGAIN (the browser drops it on hide) — twice over: 3 requests, 3 releases (review m-1)", async () => {
    const b = browser({ vw: 320, vh: 568, wake: "grant" });
    const island = renderIsland(QrEnlarged, { ...props, onClose: vi.fn() }, throughPortal);
    await flush();
    expect(b.request).toHaveBeenCalledTimes(1);
    let cycles = 0;
    for (const n of [2, 3]) {
      b.visibility("hidden");
      await flush();
      expect(b.request, "hiding asks for nothing").toHaveBeenCalledTimes(n - 1);
      expect(b.release, "the lock the browser dropped is let go").toHaveBeenCalledTimes(n - 1);
      b.visibility("visible");
      await flush();
      expect(b.request, "shown again: the lock is asked for again").toHaveBeenCalledTimes(n);
      expect(b.release).toHaveBeenCalledTimes(n - 1);
      cycles++;
    }
    expect(cycles).toBe(2);
    island.unmount();
    await flush();
    expect(b.request).toHaveBeenCalledTimes(3);
    expect(b.release, "close releases the lock it holds now").toHaveBeenCalledTimes(3);
    // After close, the page coming back asks for nothing: the listener is gone.
    expect(b.removed).toContain("document:visibilitychange");
  });

  it("a `visible` that was never preceded by a hide does not stack a second lock on the first", async () => {
    const b = browser({ vw: 320, vh: 568, wake: "grant" });
    const island = renderIsland(QrEnlarged, { ...props, onClose: vi.fn() }, throughPortal);
    await flush();
    b.visibility("visible");
    await flush();
    island.unmount();
    await flush();
    expect(b.release.mock.calls.length, "every lock asked for is let go").toBe(b.request.mock.calls.length);
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
    expect(propsOf(viewOf(island.tree())).size, "288 room: 2 × 113").toBe(226);
    b.visibility("hidden");
    b.visibility("visible");
    await flush();
    expect(() => island.unmount()).not.toThrow();
    expect(b.removed.sort()).toEqual(["document:keydown", "document:visibilitychange", "window:resize"]);
  });
});

// ─── 4. The painted size: the measured box, snapped (B6 fix round 1, controller ruling I-2) ──────────────────────────

describe("the painted size — the measured box snapped to whole device px per module (ruling I-2)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  /** A ResizeObserver, a window and an element, doubled: the element's width is set by the test and announced the way
   *  the browser does — through the observer's callback. */
  function measured(dpr = 1) {
    const ros: { cb: () => void; observed: unknown[]; disconnected: boolean }[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        rec: { cb: () => void; observed: unknown[]; disconnected: boolean };
        constructor(cb: () => void) {
          this.rec = { cb, observed: [], disconnected: false };
          ros.push(this.rec);
        }
        observe(el: unknown) {
          this.rec.observed.push(el);
        }
        disconnect() {
          this.rec.disconnected = true;
        }
      },
    );
    const listeners = new Map<string, Listener>();
    const win = {
      devicePixelRatio: dpr,
      addEventListener: (t: string, l: Listener) => listeners.set(t, l),
      removeEventListener: (t: string, l: Listener) => {
        if (listeners.get(t) === l) listeners.delete(t);
      },
    };
    vi.stubGlobal("window", win);
    let width = 0;
    const el = { getBoundingClientRect: () => ({ width }) };
    return {
      ros,
      win,
      listeners,
      el,
      setWidth: (w: number) => {
        width = w;
        for (const r of ros) if (!r.disconnected) r.cb();
      },
    };
  }
  /** The frame the size is measured from: the one element whose ref is a callback (the trigger's is an object). */
  const frameOf = (tree: ReactElement[]) => tree.find((el) => typeof propsOf(el).ref === "function")!;
  const widthOf = (el: ReactElement | undefined) => (propsOf(el!).style as { width: number; height: number }).width;

  it("inline: unmeasured, the cap snapped; measured, the BOX snapped — following the box, the cap and the DPR; closed, nothing left listening", () => {
    const m = measured();
    const island = renderIsland(SeaznQrImage, base);
    const size = () => widthOf(byTestId(island.tree(), "stream-qr"));
    expect(size(), "unmeasured: 363 holds 3 × 113").toBe(339);
    (propsOf(frameOf(island.tree())).ref as (el: unknown) => void)(m.el);
    expect(m.ros.length, "one observer, on the frame").toBe(1);
    expect(m.ros[0]!.observed).toEqual([m.el]);
    // [box width, expected CSS px, how]
    const steps: [number, number, string][] = [
      [236, 226, "236 at 320 (fixture page): 2 × 113"],
      [500, 339, "a box wider than the cap: the cap's 3 × 113"],
      [100, 100, "fewer px than modules: the box, unsnapped (no whole scale exists)"],
      [339, 339, "exactly three scales"],
      [338.5, 226, "half a px short of three: two"],
    ];
    let checked = 0;
    for (const [w, want, how] of steps) {
      m.setWidth(w);
      expect(size(), how).toBe(want);
      expect((propsOf(byTestId(island.tree(), "stream-qr")!).style as { height: number }).height, "square").toBe(want);
      checked++;
    }
    expect(checked).toBe(steps.length);
    // A zoom or a move to a 3× screen changes the DPR, not the box: the window's resize is what announces it.
    m.win.devicePixelRatio = 3;
    m.listeners.get("resize")!({});
    m.setWidth(291);
    expect(size(), "873 device px: 7 × 113 = 791").toBeCloseTo(791 / 3, 9);
    island.unmount();
    expect(m.ros[0]!.disconnected, "the observer is let go").toBe(true);
    expect(m.listeners.has("resize"), "the resize listener is removed").toBe(false);
  });

  it("the enlarged overlay paints the SAME symbol the inline image does (src and module count, not a re-encode)", () => {
    measured();
    const island = renderIsland(SeaznQrImage, { ...base, qr: qrOf("Z", 57) });
    (propsOf(byTestId(island.tree(), "stream-qr-enlarge")!).onClick as () => void)();
    expect(propsOf(overlayOf(island.tree())!).qr).toEqual(qrOf("Z", 57));
  });

  it("the placeholder (review m-7): the same snapped square, and the caption's line held by an INVISIBLE copy of the caption", () => {
    const html = render(<SeaznQrPlaceholder maxSize={363} modules={113} />);
    expect(html, "the cap snapped, as the image will be").toMatch(/style="width:339px;height:339px"/);
    const real = /<p class="([^"]*)">([^<]*)<\/p>/.exec(render(<SeaznQrImage {...base} />));
    expect(real, "the image's caption").not.toBeNull();
    expect(real![2]).toBe(en["qr.tapToEnlarge"]);
    // The same class and the same words, so the same height in every locale and at every width — only hidden.
    expect(html).toContain(`<p class="${real![1]} invisible">${real![2]}</p>`);
    expect(html).toMatch(/^<div[^>]*aria-hidden="true"/);
    const unknown = render(<SeaznQrPlaceholder maxSize={363} modules={null} />);
    expect(unknown, "no payload yet: the box's own width, unsnapped").toMatch(/style="width:363px;height:363px"/);
  });

  it("the placeholder is measured like the image: the box it lands in, snapped", () => {
    const m = measured(2);
    const island = renderIsland(SeaznQrPlaceholder, { maxSize: 363, modules: 113 });
    const square = () => island.tree().find((el) => (propsOf(el).style as { width?: number } | undefined)?.width !== undefined);
    (propsOf(frameOf(island.tree())).ref as (el: unknown) => void)(m.el);
    m.setWidth(236);
    expect(widthOf(square()), "472 device px: 4 × 113 = 452").toBe(452 / 2);
    island.unmount();
    expect(m.ros[0]!.disconnected).toBe(true);
  });
});
