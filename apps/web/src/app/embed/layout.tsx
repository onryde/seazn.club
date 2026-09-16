import type { Metadata } from "next";
import { Barlow_Condensed } from "next/font/google";
import { AttributionLink } from "@/components/attribution-link";

// The widgets are the /shared public tree's own components, and those ask for
// the display face through `font-display` — which globals.css declares
// `@theme inline` as `var(--ps-font-display, var(--font-geist-sans))`, so the
// variable is resolved on the element, not at :root. Only the /shared org
// layout set it, so an embedded widget silently fell back to the body sans:
// the schedule widget's fixed rail then painted "Finalizado" / "Afgelopen" /
// "déterminer" over the entrant name (N1f f1, review-n1e I1). Same face and
// same weights as `(public)/shared/[orgSlug]/layout.tsx` — the two surfaces
// have to render the rail identically, and 600 is the weight it uses.
const displayFont = Barlow_Condensed({
  weight: ["500", "600", "700"],
  subsets: ["latin"],
  variable: "--ps-font-display",
});

export const metadata: Metadata = {
  robots: { index: false, follow: false }, // widgets live inside other sites
};

// Minimal chrome for /embed/* (v3/10 #4): no nav, no footer, white canvas.
// The inline script posts the document height to the parent on every resize
// so the snippet's listener can grow the iframe (auto-height postMessage).
const AUTO_HEIGHT = `
(function () {
  function post() {
    parent.postMessage(
      { type: "seazn:embed:height", height: document.documentElement.scrollHeight },
      "*"
    );
  }
  new ResizeObserver(post).observe(document.documentElement);
  window.addEventListener("load", post);
})();
`;

export default function EmbedLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`${displayFont.variable} min-h-4 bg-white p-3`}>
      {children}
      <p className="mt-3 text-right text-[10px] text-zinc-400">
        <AttributionLink surface="embed" />
      </p>
      <script dangerouslySetInnerHTML={{ __html: AUTO_HEIGHT }} />
    </div>
  );
}
