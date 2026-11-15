"use client";
import { useEffect } from "react";
import { revshareCookieString, revshareEnabled } from "@/lib/revshare-shared";

// The Revshare script loads async and fills window.revshare_metadata.ref_code
// when the visitor arrived via an affiliate link. Mirror it into a first-party
// cookie so the server can stamp it on the user's first org (lib/revshare.ts).
// Poll briefly because the script may finish after hydration. Renders nothing
// and does nothing unless NEXT_PUBLIC_REVSHARE_ENABLED=1.
declare global {
  interface Window {
    revshare_metadata?: { ref_code?: string };
  }
}

export function RevshareCapture() {
  useEffect(() => {
    if (!revshareEnabled()) return;
    let tries = 0;
    const id = window.setInterval(() => {
      const cookie = revshareCookieString(window.revshare_metadata?.ref_code, location.protocol);
      if (cookie) {
        document.cookie = cookie;
        window.clearInterval(id);
      } else if (++tries >= 20) {
        window.clearInterval(id);
      }
    }, 500);
    return () => window.clearInterval(id);
  }, []);
  return null;
}
