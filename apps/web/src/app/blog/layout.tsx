import type { Metadata } from "next";
import { MarketingShell } from "@/components/marketing/marketing-shell";
import { BLOG_INDEX_DESCRIPTION, BLOG_SITE_TITLE, BLOG_TITLE_TEMPLATE } from "@/lib/blog-seo";

// Statically rendered, like /help: no page in this tree reads a cookie, a header or the session on the server. The
// build proves it (`dynamic = "error"` below fails the build on the first dynamic API), and the nav's signed-in
// swap runs in the browser (MarketingShell `auth="client"`). Caching headers, the CSP and the purge are the proxy's
// (src/proxy.ts), not this layout's.
export const dynamic = "error";
export const revalidate = 3600;

export const metadata: Metadata = {
  title: { default: BLOG_SITE_TITLE, template: BLOG_TITLE_TEMPLATE },
  description: BLOG_INDEX_DESCRIPTION,
};

// The blog's frame: the site's nav and footer around a centred column, as help's (app/help/layout.tsx).
export default function BlogLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <MarketingShell auth="client">
        <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">{children}</div>
      </MarketingShell>
    </div>
  );
}
