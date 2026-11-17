// Every public way into the developer docs is closed unless the switch is on (owner, 2026-11-16; lib/developer-docs.ts):
// the pages themselves, the marketing footer, and the console "?" menu. The one link left is in Settings → API, shown
// only to an organisation that has the docs.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const canSee = vi.fn<() => Promise<boolean>>();
vi.mock("@/lib/developer-docs", () => ({ canSeeDeveloperDocs: () => canSee() }));
vi.mock("@/components/marketing/marketing-shell", () => ({
  MarketingShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { renderToStaticMarkup } from "react-dom/server";
import DevelopersLayout, { metadata } from "@/app/developers/layout";
import { footerCols } from "@/components/marketing-footer";
import { helpMenuItems, type HelpMenuLabels } from "@/components/help-menu";

describe("developer docs: the pages", () => {
  it("are not found without the switch, and render with it", async () => {
    canSee.mockResolvedValueOnce(false);
    await expect(DevelopersLayout({ children: <p>docs body</p> })).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
    canSee.mockResolvedValueOnce(true);
    const html = renderToStaticMarkup(await DevelopersLayout({ children: <p>docs body</p> }));
    expect(html).toContain("docs body");
    expect(html).toContain('href="/developers/reference"');
  });

  it("ask search engines not to list them", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});

describe("developer docs: the links", () => {
  it("the marketing footer links to no developer page, with revshare on or off, and still links to Help", () => {
    let checked = 0;
    for (const revshare of [true, false]) {
      const links = footerCols(revshare).flatMap((c) => c.links);
      expect(links.length).toBeGreaterThan(10);
      expect(links.filter((l) => l.href.startsWith("/developers"))).toEqual([]);
      expect(links.map((l) => l.href)).toContain("/help");
      expect(footerCols(revshare).map((c) => c.headKey)).not.toContain("footer.col.developers");
      checked++;
    }
    expect(checked).toBe(2);
  });

  it("the console help menu links to Help and to no developer page", () => {
    const labels: HelpMenuLabels = { menu: "Help", centre: "Help centre", developerDocs: "Developer docs", contactSupport: "Contact" };
    expect(helpMenuItems(labels).map((i) => i.href)).toEqual(["/help"]);
  });
});
