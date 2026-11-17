import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { canSeeDeveloperDocs } from "@/lib/developer-docs";

export const metadata: Metadata = {
  title: { default: "Developers — Seazn Club", template: "%s — Seazn Club Developers" },
  description:
    "Build on the seazn.club platform API: scoped keys, live scoring, standings, registrations. REST, OpenAPI 3.1, versioned.",
  // Switched on per organisation (lib/developer-docs.ts), so there is nothing here for a search engine to list.
  robots: { index: false, follow: false },
};

const NAV = [
  { href: "/developers", label: "Overview" },
  { href: "/developers/reference", label: "API reference" },
  { href: "/developers/guides", label: "Guides" },
  { href: "/developers/changelog", label: "Changelog" },
];

export default async function DevelopersLayout({ children }: { children: React.ReactNode }) {
  // Off for everyone by default (owner, 2026-11-16). Not found rather than "ask for access": to anyone without the
  // switch, the docs do not exist.
  if (!(await canSeeDeveloperDocs())) notFound();
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <MarketingShell>
      <div className="border-b border-purple-100 bg-purple-50/40">
        <nav
          aria-label="Developer docs"
          className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4"
        >
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="whitespace-nowrap border-b-2 border-transparent px-3 py-2.5 text-sm font-medium text-slate-600 transition hover:border-purple-300 hover:text-purple-800"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
      <main className="flex-1">{children}</main>
      </MarketingShell>
    </div>
  );
}
