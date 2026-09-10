// The overlay segment's chrome-less shell. A NESTED layout cannot emit
// <html>/<body> — `app/layout.tsx` owns the only one, and `slideshow/layout.tsx`
// / `embed/layout.tsx` are the two precedents for returning a <div> instead —
// so the transparent ground is set by a <style> element scoped to this segment
// rather than by a prop. OBS composites the page over the camera, so anything
// painted here goes on air: no header, no footer, no attribution link, and the
// root layout's consent banner returns null on this segment (cookie-consent.tsx
// — `usePathname`, not CSS).
//
// RP8 (re-pinned 2026-09-09): the display face is the ROOT layout's
// `barlowCondensed` (`lib/fonts.ts`, variable `--font-barlow`), REUSED — never
// a second `next/font` mount. `app/layout.tsx` already puts `.variable` on the
// `<html>` element, so `--font-barlow` reaches this segment either way; the
// SAME singleton is reapplied here (never a second `Barlow_Condensed({...})`
// call, unlike `slideshow/layout.tsx`'s own separate instance) so the overlay
// stays self-contained if the root layout ever stops carrying it. The existing
// declaration gains weight "800" for W2's slab headline (_THEMES.md §1);
// `.ovl-display` reads `var(--font-barlow)`. Watch-list 7 (double mount) is
// closed by construction — one `barlowCondensed` object, one font file — and
// verified in Step 12 by reading the built CSS.
import { barlowCondensed } from "@/lib/fonts";

export default function OverlayLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={barlowCondensed.variable}>
      <style>{"html,body{background:transparent;margin:0}"}</style>
      {children}
    </div>
  );
}
