import type { Metadata } from "next";
import { MarketingShell } from "@/components/marketing/marketing-shell";

export const metadata: Metadata = {
  title: { default: "Help centre — Seazn Club", template: "%s — Seazn Club Help" },
  description:
    "How to run tournaments and leagues on seazn.club — setup, registration, scheduling, scoring, sharing and billing, in plain words.",
};

// The help tree's frame: the site's nav and footer around a centred column. Each page draws its own
// insides — the article and format pages through HelpShell (components/help/help-shell.tsx: search,
// section list, the page), the help home its own search and section cards — because a page knows on
// the server which page it is, and the section list marks it without reading the URL in the browser.
//
// Every help page is prerendered and served from Cloudflare's edge to every visitor (Blog P2, owner ruling
// 2026-11-19: help and blog cached together), so nothing in this tree may read a cookie, a header or the session on
// the server. The nav is drawn signed-out and swaps to "Dashboard" in the browser (`auth="client"`; until this it
// read the session, which made every help page dynamic). `dynamic = "error"` here and on every page fails the build
// on a request-time read, unless a `.catch` swallows the error (the server nav's own session read does exactly that),
// so the build's route table is the real check: no help route may show as ƒ. Both settings are pinned by
// app/help/__tests__/help-route-config.test.ts. The CSP and the no-cookie rule for these responses
// are the proxy's (src/proxy.ts, isStaticContentPath). Each page sets its own `revalidate`; this layout sets none.
export const dynamic = "error";

export default function HelpLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <MarketingShell auth="client">
        <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">{children}</div>
      </MarketingShell>
    </div>
  );
}
