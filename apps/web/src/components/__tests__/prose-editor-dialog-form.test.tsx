// Task PEF (owner, stg, 2026-11-03): the editor's Link and Sponsor/CTA dialogs submitted the whole page as a GET
// (`/o/{org}/c/new?label=Register+now&url=…`) and threw away the New competition form.
//
// Why: both hosts (the New competition form and competition settings) mount ProseEditor INSIDE their own `<form>`,
// and the dialog rendered its `<form>` in place, so the DOM held a form inside a form. Chromium stops a `submit`
// event at the nearest ancestor `<form>` (Blink's HTMLFormElement::HandleLocalEvents), so the event never bubbled
// to `document`, where React listens: the dialog's onSubmit — and its `preventDefault()` — never ran, and the inner
// form submitted natively as a GET of its own named fields. Reproduced in Chromium on both hosts, both dialogs, both
// triggers (Apply and Enter); see the PEF report.
//
// The fix has two halves and each is held here, separately, because either alone is a defect:
//   1. the dialog renders through a portal into `document.body`, so its form can never sit inside a host form — and
//      a page's `<body>` is never inside a `<form>`;
//   2. its submit handler stops the SYNTHETIC event too: React bubbles a portal's events through the React tree, not
//      the DOM, so without `stopPropagation()` the host form's own onSubmit would run next (creating the competition,
//      or saving the settings) the moment half 1 lets React see the event at all.
// That a real browser now applies the link and keeps the page is proven by the C8 walkthrough
// (e2e/walkthrough/new-competition-form.spec.ts) and the settings drive (settings-competition-drive.spec.ts).
import { readFileSync } from "node:fs";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { propsOf, renderIsland, walk } from "@/components/__tests__/_hook-harness";
import { EditorDialog } from "@/components/prose-editor";

/** Every createPortal call the dialog makes: what it rendered, and where to. */
const portals = vi.hoisted(() => [] as { node: unknown; container: unknown }[]);
vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createPortal: (node: unknown, container: unknown) => {
    portals.push({ node, container });
    return node;
  },
}));

/** A stand-in `<body>` and `document`: node vitest has no DOM. The listener spies are the dialog's Escape wiring. */
const BODY = { nodeName: "BODY" };
const doc = {
  body: BODY,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
};

/** FormData over a stand-in form: node's own FormData refuses any argument. */
class FakeFormData {
  constructor(readonly form: { fields: Record<string, string> }) {}
  get(name: string) {
    return this.form.fields[name] ?? null;
  }
}

const g = globalThis as { document?: unknown };
let hadDocument = false;
let priorDocument: unknown;

beforeEach(() => {
  portals.length = 0;
  doc.addEventListener.mockReset();
  doc.removeEventListener.mockReset();
  hadDocument = "document" in g;
  priorDocument = g.document;
  g.document = doc;
  vi.stubGlobal("FormData", FakeFormData);
});

afterEach(() => {
  if (hadDocument) g.document = priorDocument;
  else delete g.document;
  vi.unstubAllGlobals();
});

function open(onSubmit = vi.fn(), onClose = vi.fn()) {
  const island = renderIsland(EditorDialog, {
    title: "Link",
    onClose,
    onSubmit,
    children: <input name="url" defaultValue="" />,
  });
  return { island, onSubmit, onClose };
}

const formsIn = (node: unknown): ReactElement[] => walk(node as ReactNode).filter((e) => e.type === "form");

describe("EditorDialog: a form that can never sit inside the host's form", () => {
  it("renders through ONE portal into document.body, and its one form is inside that portal", () => {
    open();
    // Anti-vacuity: a dialog that stopped portaling would leave this empty and every check below would have nothing to read.
    expect(portals, "the dialog rendered through exactly one portal").toHaveLength(1);
    expect(portals[0]!.container, "into document.body, which no host <form> can contain").toBe(BODY);
    expect(formsIn(portals[0]!.node), "the dialog's form is part of what was portaled").toHaveLength(1);
  });

  it("a submit stops at the dialog: preventDefault (no native GET) AND stopPropagation (no host onSubmit), then hands over the fields", () => {
    const { island, onSubmit } = open();
    const forms = island.tree().filter((e) => e.type === "form");
    expect(forms, "one form in the dialog").toHaveLength(1);
    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      currentTarget: { fields: { url: "https://example.com" } },
    };
    (propsOf(forms[0]!).onSubmit as (e: typeof event) => void)(event);
    expect(event.preventDefault, "the native submission is cancelled").toHaveBeenCalledTimes(1);
    expect(event.stopPropagation, "the host form's onSubmit never sees the dialog's submit").toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect((onSubmit.mock.calls[0]![0] as FakeFormData).get("url"), "the dialog's own fields reach the caller").toBe(
      "https://example.com",
    );
  });

  it("a second submit is handled the same way (no one-shot guard)", () => {
    const { island, onSubmit } = open();
    for (let i = 0; i < 2; i++) {
      const form = island.tree().find((e) => e.type === "form")!;
      const event = { preventDefault: vi.fn(), stopPropagation: vi.fn(), currentTarget: { fields: {} } };
      (propsOf(form).onSubmit as (e: typeof event) => void)(event);
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    }
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("Escape still closes it (a capture listener on document), and any other key does not", () => {
    const { onClose } = open();
    const keydown = doc.addEventListener.mock.calls.filter((c) => c[0] === "keydown");
    expect(keydown, "one keydown listener").toHaveLength(1);
    expect(keydown[0]![2], "in the capture phase, ahead of the editor's own keys").toBe(true);
    const onKey = keydown[0]![1] as (e: { key: string; stopPropagation: () => void }) => void;
    onKey({ key: "Enter", stopPropagation: vi.fn() });
    expect(onClose, "Enter is the form's, not a close").not.toHaveBeenCalled();
    const esc = { key: "Escape", stopPropagation: vi.fn() };
    onKey(esc);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(esc.stopPropagation).toHaveBeenCalledTimes(1);
  });
});

describe("ProseEditor: every dialog form goes through EditorDialog", () => {
  it("the only <form> in prose-editor.tsx is EditorDialog's own", () => {
    // Comments blanked to spaces (offsets kept), so the prose ABOUT the form is not counted as one.
    const src = readFileSync(new URL("../prose-editor.tsx", import.meta.url), "utf8").replace(
      /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
      (c) => c.replace(/[^\n]/g, " "),
    );
    const at = [...src.matchAll(/<form\b/g)].map((m) => m.index ?? -1);
    // Anti-vacuity: exactly one. Zero would mean the dialog lost its form (no Enter-to-apply); two means a dialog
    // body grew its own form again, which is what nested inside the host's.
    expect(at, "one <form> in the file").toHaveLength(1);
    const start = src.indexOf("export function EditorDialog(");
    const end = src.indexOf("\nexport function ProseEditor(");
    expect(start, "EditorDialog is declared").toBeGreaterThan(-1);
    expect(end, "and ProseEditor after it").toBeGreaterThan(start);
    expect(at[0]!, "that <form> is inside EditorDialog").toBeGreaterThan(start);
    expect(at[0]!).toBeLessThan(end);
    // Both dialogs use it: the Link and the Sponsor/CTA prompt.
    expect(src.match(/<EditorDialog\b/g)?.length, "two dialogs mount EditorDialog").toBe(2);
  });
});
