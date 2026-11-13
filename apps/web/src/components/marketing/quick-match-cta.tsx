// The marketing hero's quick match start, the hero's one primary (owner 2026-11-13, "A, apply rec": mockup
// 2026-11-13_marketing-hero-quick-match-first_hqm13a01, Option A; spec docs/superpowers/specs/2026-11-03-quick-match-design.md
// §5 step 1). A Sport select over the setup screen's own offer and the lime Start, so the setup screen opens on that
// sport and the guest's first tap there is naming the sides. The organiser's setup is a quiet link the page puts below.
//
// A plain GET form to `/<lang>/play?sport=<key>`: it works before any script loads, and the setup page checks the key
// against its offer (play/setup-props.ts `prefillSport`). Not next/form: that prefetches its action when visible, and
// /play is a dynamic page with no loading boundary, so every home view would render it (console-link.tsx's reason).
// The action is locale-PREFIXED: only `/<lang>/play` resolves (proxy.ts rewrites an unprefixed marketing path only when
// it is listed), and the create route sends a refusal back to the same path (app/api/quick-match/route.ts).
//
// With no offer (none, or it could not be read) the select is left out and the Start alone leads to the setup page,
// which says plainly that quick matches are unavailable (play/page.tsx).
import { routes } from "@/lib/routes";

/** One sport of the setup screen's offer, named in the page's language (play/setup-props.ts `setupSports`). */
export interface QuickMatchCtaSport {
  sport_key: string;
  name: string;
}

export interface QuickMatchCtaCopy {
  /** The select's label: the setup screen's own word (`quickMatch.setup.sport`). */
  sport: string;
  start: string;
  hint: string;
}

export function QuickMatchCta({
  lang,
  sports,
  copy,
}: {
  lang: string;
  /** In the setup screen's order; its first is the setup screen's default, so it is selected here too. */
  sports: readonly QuickMatchCtaSport[];
  copy: QuickMatchCtaCopy;
}) {
  const [first] = sports;
  return (
    <div data-testid="qm-cta" className="min-w-0">
      {/* `mk-funnel-night`: the hero's night panel, its .label and .input faces (globals.css). */}
      <form
        method="get"
        action={routes.quickMatchSetup(lang)}
        data-testid="qm-cta-form"
        className="mk-funnel-night flex w-full max-w-xl flex-col gap-2 rounded-2xl border p-3 backdrop-blur sm:flex-row sm:items-end"
      >
        {first ? (
          <label className="min-w-0 flex-1">
            <span className="label">{copy.sport}</span>
            <select name="sport" defaultValue={first.sport_key} className="input min-h-11 cursor-pointer">
              {sports.map((s) => (
                <option key={s.sport_key} value={s.sport_key}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button
          type="submit"
          aria-describedby="qm-cta-hint"
          className="mk-display inline-flex min-h-11 shrink-0 cursor-pointer items-center justify-center rounded-xl bg-[var(--mk-lime)] px-6 py-2 text-center text-base font-bold text-[var(--mk-night)] transition hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--mk-lime)]"
        >
          {copy.start}
        </button>
      </form>
      <p id="qm-cta-hint" className="mt-2.5 text-sm text-[#b7aede]">
        {copy.hint}
      </p>
    </div>
  );
}
