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
// Nothing here reads cookies or the session: every help page stays statically rendered.
export default function HelpLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <MarketingShell>
        <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">{children}</div>
      </MarketingShell>
    </div>
  );
}
