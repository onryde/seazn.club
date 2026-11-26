"use client";
import { useEffect } from "react";
import { revshareEnabled } from "@/lib/revshare-shared";
import { captureRevshareRef, mountRevshare } from "@/lib/revshare-script";

// The one place the Revshare script comes from (lib/revshare-script.ts). On every page load it first purges the
// script's stored visit history - also when NEXT_PUBLIC_REVSHARE_ENABLED is off - and then, only on an affiliate
// landing, adds the tag. The ref_code it answers with (or its first-click cookie, on a later page) is mirrored into
// the first-party `rs_ref` cookie so the server can stamp it on the user's first org (lib/revshare.ts). Poll briefly
// because the script may finish after hydration. Renders nothing.
export function RevshareCapture() {
  useEffect(() => {
    mountRevshare(window, revshareEnabled());
    if (!revshareEnabled() || captureRevshareRef(window)) return;
    let tries = 0;
    const id = window.setInterval(() => {
      if (captureRevshareRef(window) || ++tries >= 20) window.clearInterval(id);
    }, 500);
    return () => window.clearInterval(id);
  }, []);
  return null;
}
