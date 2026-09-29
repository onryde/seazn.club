// Task 14 fix round 3 (P3, P4): the shared confirm gains two OPTIONAL fields, and neither changes a byte for a caller
// that does not pass it.
//   * `cancelLabel` — the caller's own, page-locale cancel text. Without it the button keeps reading
//     `clientCommon(readLocaleCookie(), "dialog.cancel")`, which follows the `seazn_locale` COOKIE rather than the page's
//     locale — so a Spanish console with no cookie read "Cancel" (capture pass 2, F3).
//   * `size: "touch"` — both buttons get the house 44-px phone floor (`max-md:min-h-11`); unset, both keep exactly
//     `btn btn-ghost` / `btn btn-<tone>`.
// Driven through the REAL provider: `confirm()` is read off the context the provider renders, and the dialog it mounts
// is rendered from the provider's own tree — no copy of the surface is built here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { propsOf, renderIsland, textOf } from "@/components/__tests__/_hook-harness";
import { ConfirmProvider, type ConfirmOptions } from "@/components/ui/confirm-provider";
import { clientCommon } from "@/lib/client-dict";

type Surface = { buttons: ReactElement[]; cancel: ReactElement; confirmBtn: ReactElement };

function open(opts: ConfirmOptions): Surface {
  const provider = renderIsland(ConfirmProvider, { children: null });
  const ctx = provider.tree().find((el) => typeof (propsOf(el) as { value?: unknown }).value === "function");
  if (!ctx) throw new Error("the provider rendered no context value");
  void ((propsOf(ctx) as { value: (o: ConfirmOptions) => Promise<boolean> }).value)(opts);
  const surfaceEl = provider.tree().find((el) => (propsOf(el) as { opts?: unknown }).opts === opts);
  if (!surfaceEl) throw new Error("confirm() mounted no dialog");
  const surface = renderIsland(surfaceEl.type as (p: unknown) => ReactElement, propsOf(surfaceEl));
  const buttons = surface.tree().filter((el) => el.type === "button");
  surface.unmount();
  provider.unmount();
  if (buttons.length !== 2) throw new Error(`expected Cancel + confirm, got ${buttons.length} buttons`);
  return { buttons, cancel: buttons[0]!, confirmBtn: buttons[1]! };
}

const cls = (el: ReactElement): string => String((propsOf(el) as { className?: string }).className);
const BASE: ConfirmOptions = { title: "Stop the stream?", body: "The broadcast ends.", confirmLabel: "Stop stream", tone: "danger" };

describe("confirm dialog — cancelLabel and the touch size are opt-in, and absent they change nothing", () => {
  let cookie = "";
  beforeEach(() => {
    cookie = "";
    vi.stubGlobal("document", {
      get cookie() { return cookie; },
      activeElement: null,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("cancelLabel, when given, IS the cancel text — whatever the cookie says", () => {
    let checked = 0;
    for (const c of ["", "seazn_locale=es", "seazn_locale=fr"]) {
      cookie = c;
      const { cancel } = open({ ...BASE, cancelLabel: "Seguir emitiendo" });
      expect(textOf(cancel), c || "no cookie").toBe("Seguir emitiendo");
      checked++;
    }
    expect(checked).toBe(3);
  });

  it("without it, the cancel text is the cookie's `dialog.cancel`, exactly as before — per locale, and English with no cookie", () => {
    let checked = 0;
    for (const [c, locale] of [["", "en"], ["seazn_locale=es", "es"], ["seazn_locale=nl", "nl"]] as const) {
      cookie = c;
      const { cancel } = open(BASE);
      expect(textOf(cancel), locale).toBe(clientCommon(locale, "dialog.cancel"));
      checked++;
    }
    expect(checked).toBe(3);
    // The differential: the fallback really is locale-dependent, so the loop above could not pass on a constant.
    expect(clientCommon("es", "dialog.cancel")).not.toBe(clientCommon("en", "dialog.cancel"));
  });

  it("size 'touch' puts the 44-px phone floor on BOTH buttons; unset, the classes are byte-identical to before", () => {
    const touch = open({ ...BASE, size: "touch" });
    for (const b of touch.buttons) expect(cls(b).split(/\s+/)).toContain("max-md:min-h-11");
    const plain = open(BASE);
    expect(cls(plain.cancel)).toBe("btn btn-ghost");
    expect(cls(plain.confirmBtn)).toBe("btn btn-danger");
    const plainDefault = open({ ...BASE, tone: "default" });
    expect(cls(plainDefault.confirmBtn)).toBe("btn btn-primary");
    // Only a max-md: variant is added — the 768+ dialog is untouched.
    let checked = 0;
    for (const [i, b] of touch.buttons.entries()) {
      const added = cls(b).split(/\s+/).filter((c) => !cls(plain.buttons[i]!).split(/\s+/).includes(c));
      expect(added, `button ${i}`).toEqual(["max-md:min-h-11"]);
      checked++;
    }
    expect(checked).toBe(2);
  });
});
