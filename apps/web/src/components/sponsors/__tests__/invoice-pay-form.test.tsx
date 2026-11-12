// The invoice page's "Pay by card" form (sponsor deals, Task 23 carry 2): a double click sends ONE post. Driven through
// renderIsland (no DOM in this workspace): the form's own onSubmit with a plain event, and the `pageshow` listener its effect
// adds, fired from a stubbed window. What a browser does between the two (the post itself, Stripe) is not here: the pay route's
// own suite (r/sponsor/invoice/[token]/__tests__/routes.test.ts) owns what one post does.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { propsOf, renderIsland } from "@/components/__tests__/_hook-harness";
import { InvoicePayForm } from "../invoice-pay-form";

const PROPS = { action: "/r/sponsor/invoice/tok/pay", label: "Pay by card", note: "You pay £250.00 to the club." };

let listeners: Record<string, ((e: { persisted: boolean }) => void)[]> = {};
beforeEach(() => {
  listeners = {};
  vi.stubGlobal("window", {
    addEventListener: (type: string, fn: (e: { persisted: boolean }) => void) => {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener: (type: string, fn: (e: { persisted: boolean }) => void) => {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

function mount() {
  const island = renderIsland(InvoicePayForm, PROPS);
  const form = () => island.tree().find((el) => el.type === "form")!;
  const button = () => island.tree().find((el) => el.type === "button")!;
  /** Submit the form as a browser would; answers whether the submit was cancelled. */
  const submit = (): boolean => {
    let prevented = false;
    (propsOf(form()).onSubmit as (e: { preventDefault(): void }) => void)({ preventDefault: () => (prevented = true) });
    return prevented;
  };
  const pageshow = (persisted: boolean) => {
    for (const fn of [...(listeners.pageshow ?? [])]) fn({ persisted });
  };
  return { island, form, button, submit, pageshow };
}

describe("InvoicePayForm: one card payment per click", () => {
  it("renders the same form the page always had: POST to the pay action, behind ph-no-capture, the label and the note", () => {
    const html = renderToStaticMarkup(<InvoicePayForm {...PROPS} />);
    expect(html).toMatch(/<form[^>]*data-testid="invoice-pay"/);
    expect(html).toContain(`action="${PROPS.action}"`);
    expect(html).toContain('method="post"');
    expect(html).toMatch(/<form[^>]*class="[^"]*\bph-no-capture\b/);
    expect(html).toContain(">Pay by card</button>");
    expect(html).toContain(PROPS.note);
    expect(html, "armed on first paint").not.toMatch(/<button[^>]*disabled/);
  });

  it("the first submit goes through and disables the button; a second submit is cancelled (the double click)", () => {
    const m = mount();
    expect(propsOf(m.button()).disabled, "armed").toBe(false);
    expect(m.submit(), "the first click posts").toBe(false);
    expect(propsOf(m.button()).disabled, "disabled once sent").toBe(true);
    expect(propsOf(m.button())["aria-busy"]).toBe(true);
    let cancelled = 0;
    for (let i = 0; i < 3; i++) if (m.submit()) cancelled++;
    expect(cancelled, "every later submit is cancelled (3 counted)").toBe(3);
  });

  it("back from Stripe out of the back-forward cache (pageshow, persisted): re-armed, so the sponsor can pay; a fresh load (not persisted) changes nothing", () => {
    const m = mount();
    expect((listeners.pageshow ?? []).length, "one pageshow listener while mounted").toBe(1);
    m.submit();
    m.pageshow(false);
    expect(propsOf(m.button()).disabled, "a page that was not restored stays as it was").toBe(true);
    expect(m.submit(), "still one post").toBe(true);
    m.pageshow(true);
    expect(propsOf(m.button()).disabled, "restored: armed again").toBe(false);
    expect(m.submit(), "the sponsor can pay again").toBe(false);
    expect(m.submit(), "and the guard holds again").toBe(true);
    m.island.unmount();
    expect((listeners.pageshow ?? []).length, "the listener goes with the form").toBe(0);
  });
});
