// The tracked sponsor redirect, followed by a browser, with the sponsor's own site never reached. Shared by the walkthroughs that tap a sponsor's
// link (sponsors-journey.spec.ts, title-sponsor-poster.spec.ts): moved here verbatim from the journey, so one hop is one definition.
import type { BrowserContext } from "@playwright/test";

export const SPONSOR_PAGE_TITLE = "Harbourside";
export type SponsorHop = { url: string; status: number; location: string | undefined };

/** Route ONE `/s/` hop on `ctx`: send it to the REAL server unchanged, record what the server answered, and hand back
 *  the sponsor's page in its place.
 *
 *  Why route the hop and not the sponsor's host: Playwright calls a route handler "only for the first url if the response
 *  is a redirect" (playwright-core types.d.ts, `page.route`). A route on the sponsor's own origin therefore never fires
 *  behind the 302, and the browser goes to DNS, which `.example` never answers. CI run 42449692776 failed exactly this
 *  way: `net::ERR_NAME_NOT_RESOLVED` with a context route on `A.url`'s origin in place. `public-fixture.spec.ts`'s header
 *  records the same finding (CI run 41256296230), probed locally with the page in the same tab and in a popup.
 *
 *  `route.fetch` does not follow redirects here, so the server sees this browser's own request and records the click
 *  from it. Its 302 and Location are asserted exactly, and that redirect target is the seam. The route is context-level,
 *  so it also catches the first request of a new tab. */
export async function realSponsorHop(ctx: BrowserContext, pathname: string): Promise<{ hop: Promise<SponsorHop> }> {
  let settle!: (hop: SponsorHop) => void;
  let fail!: (err: unknown) => void;
  const hop = new Promise<SponsorHop>((res, rej) => {
    settle = res;
    fail = rej;
  });
  await ctx.route(
    (url) => url.pathname === pathname,
    async (route) => {
      try {
        const real = await route.fetch({ maxRedirects: 0 });
        settle({ url: route.request().url(), status: real.status(), location: real.headers()["location"] });
        await route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><title>${SPONSOR_PAGE_TITLE}</title>` });
      } catch (err) {
        fail(err);
      }
    },
  );
  return { hop };
}
