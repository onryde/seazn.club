// /day/{token} (capture S4 design §9 item 2; MD-1 Task 2): the Match Day code's QR payload, opened by a phone's own camera
// instead of the Seazn Club app. The page says to scan it with the app and nothing else: it never resolves the token
// (an unknown code and a live one look the same) and never writes it into the HTML. No DB.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const locale = vi.hoisted(() => ({ value: "en" as "en" | "es" | "fr" | "nl" }));
vi.mock("@/lib/resolve-locale", () => ({ resolveLocale: async () => locale.value }));
// Proof that the page never looks the code up: any import of the use-case is a failure.
vi.mock("@/server/usecases/match-day-codes", () => {
  throw new Error("the landing page must not resolve the token");
});

import en from "@/dictionaries/en/ui.json";
import nl from "@/dictionaries/nl/ui.json";
import { scrubScoreUrl } from "@/lib/scrub-score-url";
import DayPage, { metadata } from "../page";

const TOKEN = "md_x";

/** Called as Next calls it, with the token in `params`. */
const asNext = DayPage as unknown as (props: { params: Promise<{ token: string }> }) => ReturnType<typeof DayPage>;

/** The page's markup, with React's entity escapes undone so it can be compared with the dictionary's plain text. */
async function html(token: string): Promise<string> {
  return renderToStaticMarkup(await asNext({ params: Promise.resolve({ token }) }))
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
}

describe("/day/{token}", () => {
  it("/day/md_x renders the app prompt and never the token", async () => {
    locale.value = "en";
    const out = await html(TOKEN);
    expect(out).toContain(en["matchDay.code.landing.title"]);
    expect(out).toContain(en["matchDay.code.landing.body"]);
    expect(out).not.toContain(TOKEN);
  });

  it("a real-shaped token is not in the HTML either", async () => {
    locale.value = "en";
    const token = "md_" + "Zq9-_".repeat(8) + "abc";
    expect(await html(token)).not.toContain(token);
  });

  it("speaks the reader's language", async () => {
    locale.value = "nl";
    const out = await html(TOKEN);
    expect(out).toContain(nl["matchDay.code.landing.title"]);
    expect(nl["matchDay.code.landing.title"]).not.toBe(en["matchDay.code.landing.title"]);
  });

  it("is not indexed and sends no referrer (the URL is a credential)", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.referrer).toBe("no-referrer");
  });

  it("telemetry never sees the token: the scrubber swaps it out of a /day/ URL, plain or encoded", () => {
    const token = "md_" + "Zq9-_".repeat(8) + "abc";
    for (const url of [`https://seazn.club/day/${token}`, `/day/${token}?from=camera`, `/login?next=${encodeURIComponent(`/day/${token}`)}`]) {
      const out = scrubScoreUrl(url);
      expect(out, url).not.toContain(token);
      expect(out, url).toContain("[token]");
    }
  });
});
