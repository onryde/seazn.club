import Link from "next/link";
import { ticketTiers } from "@/lib/pricing-cards";
import type { Currency } from "@/lib/currency";
import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";
import type { MatrixData } from "@/lib/pricing-matrix";
import { Reveal } from "./reveal";

/** Floodlit finale pricing (design/v3/12 §4.8): three ticket stubs, Event
 *  Pass glowing. Content comes from the shared pricing-cards source — tier
 *  names, price qualifiers and bullets all as dictionary keys, with the caps
 *  and fee rates interpolated from `plan_entitlements`. The page passes both
 *  in: this is a plain (non-async) component and must not load either itself. */
export function TicketStubs({
  currency,
  dict,
  matrix,
}: {
  currency: Currency;
  dict: Dict;
  matrix: MatrixData;
}) {
  return (
    <div className="flex flex-wrap justify-center gap-5">
      {ticketTiers(currency, dict, matrix).map((tier, i) => (
        <Reveal
          key={tier.tier}
          className={`mk-stub relative w-64 rounded-xl border p-5 text-left ${
            tier.glow
              ? "border-[var(--mk-lime)] shadow-[0_0_34px_rgba(163,230,53,0.22)]"
              : "border-[#3b2a6e]"
          }`}
          style={{
            animationDelay: `${i * 120}ms`,
            background: "linear-gradient(160deg,#241650,#1a0f3e)",
          }}
        >
          <span className="mk-stub-tear" aria-hidden />
          <span className="mk-stub-admit mk-display" aria-hidden>
            ADMIT ONE
          </span>
          <p
            className={`mk-display text-xs font-semibold tracking-[0.18em] ${
              tier.glow ? "text-[var(--mk-lime)]" : "text-[#b7aede]"
            }`}
          >
            {tier.tier}
          </p>
          <p className="mk-display my-1 text-4xl font-bold tabular-nums text-[var(--mk-cream)]">
            {tier.prefix ? (
              <span className="mr-1 align-middle text-xs font-semibold uppercase tracking-[0.12em] text-[#b7aede]">
                {tier.prefix}
              </span>
            ) : null}
            {tier.price}
            {tier.period ? (
              <span className="text-base font-medium text-[#b7aede]">{tier.period}</span>
            ) : null}
          </p>
          <ul className="w-40 space-y-1 text-xs leading-relaxed text-[#cfc6ec]">
            {tier.bullets.map((b) => (
              <li key={b}>
                <span className="text-[var(--mk-lime)]">✓</span> {b}
              </li>
            ))}
          </ul>
        </Reveal>
      ))}
      <p className="w-full">
        <Link
          href="/pricing"
          className="text-xs text-[#8d7fc0] underline hover:text-[var(--mk-lime)]"
        >
          {t(dict, "home.finale.compare")}
        </Link>
      </p>
    </div>
  );
}
