// The app band (spec 2026-11-25 §4; the owner picked Option B, the slim "ticket stub" strip, 2026-11-25): what the
// Seazn Club Mobile App does for the page it sits on, beside Google's badge. A night strip with a dashed lime box: one
// centred column on phones, words left and badge right from `sm`. It sits between two sections of a page, never inside
// one, and takes all its copy already translated.
//
// The title, the app's name and the line are three blocks at every width. Their spacing is the column's `gap`: on the
// product pages, product.css's unlayered reset takes every margin and padding off `h2` and `p`, over any utility.
import { PlayBadge } from "@/components/marketing/play-badge";

export async function AppBand({ lang, title, label, line }: { lang: string; title: string; label: string; line: string }) {
  return (
    <section data-testid="app-band" data-section="app" className="bg-[var(--mk-night)] px-4 py-3">
      <div className="mx-auto flex max-w-6xl flex-col items-center gap-3 rounded-[14px] border-[1.5px] border-dashed border-[var(--mk-lime)] px-5 py-4 text-center sm:flex-row sm:justify-between sm:gap-5 sm:py-3.5 sm:text-left">
        <div className="flex min-w-0 flex-col gap-2 sm:gap-1">
          <h2 className="text-balance text-base font-bold leading-snug text-[var(--mk-cream)]">{title}</h2>
          <p className="text-[13px] leading-5 text-[var(--mk-lime)]">{label}</p>
          <p className="text-pretty text-[13px] leading-5 text-[#c9bfee]">{line}</p>
        </div>
        {/* Called, not mounted: the pages' tests render to static markup, which cannot resolve a nested async component. */}
        {await PlayBadge({ lang, size: "sm" })}
      </div>
    </section>
  );
}
