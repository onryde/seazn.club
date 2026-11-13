"use client";

// The Cloudflare Turnstile widget, as two pieces a guarded form uses:
//
//   const turnstile = useTurnstile("login");                       // one controller per form, one action per form
//   ...
//   await withTurnstile(turnstile, (headers) => api(url, { method: "POST", json, headers }));   // token in, reset after
//   ...
//   <TurnstileWidget controller={turnstile} />                      // somewhere in the form
//
// The widget is `interaction-only`: invisible unless Cloudflare needs the visitor to tick a box, so a person on a normal
// connection sees nothing. It renders NOTHING when `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is unset (dev, e2e): the request then goes
// without a token, which the server accepts exactly where it skips the check (server/turnstile.ts `turnstileMode`).
//
// The logic lives in lib/turnstile-client.ts (unit-tested without a DOM); this file only owns the container element.
import { useEffect, useRef, useState } from "react";
import { useLocaleOrDefault } from "@/components/i18n/dict-provider";
import type { TurnstileAction } from "@/lib/turnstile";
import { createTurnstileController, loadTurnstileApi, type TurnstileController } from "@/lib/turnstile-client";

export function useTurnstile(action: TurnstileAction): TurnstileController {
  // `process.env.NEXT_PUBLIC_*` must be a literal property access: Next replaces it with the build-time value.
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "";
  const [controller] = useState(() => createTurnstileController({ siteKey, action, load: loadTurnstileApi }));
  return controller;
}

export function TurnstileWidget({ controller, className = "" }: { controller: TurnstileController; className?: string }) {
  // The language is cosmetic here (the widget's own words), so a bare render outside a provider falls back to English.
  const locale = useLocaleOrDefault();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    controller.mount(el, { language: locale, width: el.clientWidth });
    return () => controller.unmount();
  }, [controller, locale]);
  // `min-w-0 max-w-full`: never wider than the card it sits in, so it cannot put a horizontal scroll on the page at 320px.
  // `tabIndex={-1}`: focusable by script only (the controller's `reveal`), never a stop in the tab order.
  return <div ref={box} tabIndex={-1} data-testid="turnstile-widget" className={`min-w-0 max-w-full ${className}`.trim()} />;
}
