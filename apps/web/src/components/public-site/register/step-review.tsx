"use client";
// RS006 Step 5 — REVIEW→PAY (design §4 step 5). Read-only line items: no
// remove/duplicate/rename/self-link controls here (those are step 2/3's
// job). Computes NOTHING of its own beyond formatting — `summary` (cart.ts's
// summarizeCart) is passed in already built, so the subtotal/waitlist math
// can never drift from step 2's own EntryCart (which shares the SAME
// function — see summarizeCart's own doc comment for why forking it is the
// specific thing the RS006 dispatch calls out not to do).
//
// Registration redesign B2 T10 (spec 7.3): the step now shows everything that will be sent, in four sections — You, Entries (each with
// its players), Answers (only when an organiser asked something) and Consent — and each section has an Edit that goes back to the
// step where it is edited. Going back loses nothing: the stepper's state lives above the steps (and in sessionStorage), not in the
// step that is left. `content` (review-content.ts) is the non-money half, built from the same states the submit reads.
import type { ReactNode } from "react";
import { useT } from "@/components/i18n/dict-provider";
import { formatMoneyExact } from "@/lib/currency";
import { entryDisplayName, UNNAMED_KEY } from "./entry-cart";
import { type CartLineSummary, type CartSummary, lineFeeCents, lineMethod, payableDivision } from "./cart";
import { reviewEditTarget, type ReviewContent, type ReviewSection } from "./review-content";
import { BTN_TEXT } from "./styles";
import type { StepId } from "./types";

/** One explicit key per section, so a key that does not exist cannot be built by accident (same reasoning as step-who.tsx's ERROR_KEY). */
const SECTION_KEY = {
  you: "register.review.section.you",
  entries: "register.review.section.entries",
  answers: "register.review.section.answers",
  consent: "register.review.section.consent",
} as const satisfies Record<ReviewSection, string>;

export function StepReview({
  summary,
  content,
  locale,
  order,
  onEdit,
}: {
  summary: CartSummary;
  content: ReviewContent;
  locale: string;
  /** The stepper's real step order: where an Edit goes depends on it (a one-division competition has no Entries step). */
  order: readonly StepId[];
  /** Jump to the step at this INDEX of `order`. Undefined while a submit is in flight: every Edit is then disabled, as the stepper's
   *  own Back and step rail are, so nothing can change the cart a request is already carrying. */
  onEdit?: (index: number) => void;
}) {
  const t = useT();

  // What an entry is called: its solo badge, its team or partner name, or the kind's "unnamed" fallback. An individual who has a named
  // player needs no fallback ("Entry" over their own name says nothing), so it gets none.
  const entryLabel = ({ entry }: CartLineSummary, playerNames: string[]): string | null =>
    entry.free_agent
      ? t("register.entries.cart.freeAgentBadge")
      : entryDisplayName(entry) || (entry.entrant_kind === "individual" && playerNames.length > 0 ? null : t(UNNAMED_KEY[entry.entrant_kind]));
  const playerNamesOf = ({ entry }: CartLineSummary) => entry.players.map((p) => p.full_name.trim()).filter((n) => n !== "");

  /** A section: its title, its Edit (absent when the step it edits is not in this order), and its body. A plain function, not a
   *  component: it renders inline, and a nested component would be one more opaque node for the interaction tests to expand. */
  const section = (id: ReviewSection, body: ReactNode) => {
    const title = t(SECTION_KEY[id]);
    const target = reviewEditTarget(id, order);
    return (
      <section key={id} data-testid={`reg-review-${id}`} aria-labelledby={`reg-review-${id}-title`} className="py-3 first:pt-0">
        <div className="flex items-center justify-between gap-2">
          <h3 id={`reg-review-${id}-title`} className="font-display text-sm font-semibold uppercase tracking-wide text-ink">
            {title}
          </h3>
          {target !== null && (
            // BTN_TEXT is the tree's quiet text-only action (Remove, Add another). Four buttons called "Edit" are told apart by the
            // section name after the word, hidden from sight: a screen reader hears "Edit Entries", not "Edit" four times.
            <button
              type="button"
              data-testid={`reg-review-edit-${id}`}
              disabled={onEdit === undefined}
              onClick={() => onEdit?.(target)}
              className={`${BTN_TEXT} inline-flex items-center gap-1.5 px-1.5 max-md:min-h-11`}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
              </svg>
              {t("register.review.edit")}
              <span className="sr-only"> {title}</span>
            </button>
          )}
        </div>
        <div className="mt-2">{body}</div>
      </section>
    );
  };

  /** A "label ... value" row. The label may wrap; the value wraps by word and sits on the right once it fits. */
  const row = (key: string, label: string, value: string, muted = false) => (
    <div key={key} className="flex flex-wrap justify-between gap-x-4 gap-y-0.5 text-sm">
      <dt className="min-w-0 text-ink-muted">{label}</dt>
      <dd className={`min-w-0 break-words text-right ${muted ? "text-ink-muted" : "font-medium text-ink"}`}>{value}</dd>
    </div>
  );
  const yesNo = (v: boolean) => t(v ? "register.review.yes" : "register.review.no");

  const cardCart = payableDivision(summary)?.payment_method === "stripe";

  return (
    <div className="rounded-xl border border-zinc-200/80 bg-surface p-4 shadow-sm sm:p-6">
      <h2 tabIndex={-1} className="font-display text-xl font-semibold uppercase tracking-wide text-ink">
        {t("register.review.heading")}
      </h2>
      <p className="mt-1 text-sm text-ink-muted">{t("register.review.subtitle")}</p>

      <div className="mt-4 divide-y divide-zinc-200">
        {section(
          "you",
          <>
            <p className="break-words text-sm font-medium text-ink">{content.contact.name}</p>
            <p className="break-words text-sm text-ink-muted">{content.contact.email}</p>
          </>,
        )}

        {section(
          "entries",
          <ul className="space-y-2.5">
            {summary.lines.map((line) => {
              const { entry, division, waitlisted, staleClosed } = line;
              const playerNames = playerNamesOf(line);
              const label = entryLabel(line, playerNames);
              // P4 (W9): each entry says how IT is paid. This used to be one note under the subtotal, read off the first charged division,
              // which mislabelled any entry that was paid another way. A line that is not charged now has no method to name.
              const method = lineMethod(line);
              // `lineFeeCents`, not `division.fee_cents` — a solo sign-up is
              // charged the division's solo price, and reading the team fee here
              // quoted one number on screen while Stripe asked for another.
              const lineFee = division == null ? null : lineFeeCents(entry, division);
              const feeLabel =
                division == null || lineFee == null
                  ? null
                  : lineFee === 0
                    ? t("register.entries.free")
                    : formatMoneyExact(lineFee, division.currency, locale);
              return (
                <li key={entry.id} className="rounded-lg border border-zinc-200 bg-canvas p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-display text-sm font-semibold uppercase tracking-wide text-ink">
                        {division?.name ?? entry.division_id}
                      </p>
                      {label !== null && <p className="text-xs text-ink-muted">{label}</p>}
                      {playerNames.length > 0 && <p className="break-words text-xs text-ink-muted">{playerNames.join(", ")}</p>}
                    </div>
                    {feeLabel && (
                      <span className="shrink-0 text-right">
                        <span className="block font-display text-sm font-semibold text-ink">
                          {waitlisted || staleClosed ? t("register.entries.free") : feeLabel}
                        </span>
                        {method && (
                          <span data-testid="reg-review-method" className="block font-sans text-xs font-normal text-ink-muted">
                            {t(method === "stripe" ? "register.method.card" : "register.method.offline")}
                          </span>
                        )}
                      </span>
                    )}
                  </div>
                  {waitlisted && (
                    <p data-testid="reg-review-waitlist" className="mt-1.5 text-xs font-medium text-amber-700">
                      {t("register.cart.waitlistLine")}
                    </p>
                  )}
                  {staleClosed && <p className="mt-1.5 text-xs text-red-700">{t("register.entries.cart.closedNote")}</p>}
                </li>
              );
            })}
          </ul>,
        )}

        {/* Only when an organiser asked something: a section with nothing in it is noise, and an Edit that goes to Details to find
            nothing to edit is a dead end. */}
        {content.answers.length > 0 &&
          section(
            "answers",
            <div className="space-y-3">
              {content.answers.map((group) => {
                // Whose answers: the division, then the entry's own name, or its player when it has none (an individual's name IS the
                // entry), so two entries in one division are told apart.
                const line = summary.lines.find((l) => l.entry.id === group.entryId);
                const names = line ? playerNamesOf(line) : [];
                const heading = [group.division, line ? (entryLabel(line, names) ?? names.join(", ")) : ""].filter(Boolean).join(" · ");
                return (
                  <div key={group.entryId}>
                    {/* With one group there is nothing to tell apart; with several, each says whose answers they are. */}
                    {content.answers.length > 1 && <p className="mb-1 text-xs font-semibold text-ink">{heading}</p>}
                    <dl className="space-y-1.5">
                      {group.lines.map((l, i) =>
                        row(
                          `${group.entryId}-${i}`,
                          l.label,
                          typeof l.value === "boolean" ? yesNo(l.value) : (l.value ?? t("register.review.notAnswered")),
                          l.value === null,
                        ),
                      )}
                    </dl>
                  </div>
                );
              })}
            </div>,
          )}

        {section(
          "consent",
          <dl className="space-y-1.5">
            {row("privacy", t("register.consent.privacy.title"), yesNo(content.consents.privacy))}
            {row("media", t("register.review.consent.media"), yesNo(content.consents.media))}
            {/* The guardian pair the submit carries, listed exactly when the Consent step asked for it (review-content.ts). */}
            {content.guardian && row("guardian-name", t("register.guardian.name.label"), content.guardian.name)}
            {content.guardian && row("guardian-consent", t("register.review.consent.guardian"), yesNo(content.guardian.consent))}
          </dl>,
        )}
      </div>

      <div className="mt-1 flex items-baseline justify-between gap-3 border-t border-zinc-200 pt-3">
        <span className="font-display text-xs font-semibold uppercase tracking-wider text-ink-muted">{t("register.review.total")}</span>
        <span data-testid="reg-review-total" className="font-display text-3xl font-bold tabular-nums text-ink">
          {summary.subtotalCents === 0 || !summary.currency
            ? t("register.entries.free")
            : formatMoneyExact(summary.subtotalCents, summary.currency, locale)}
        </span>
      </div>
      {/* How a card cart is paid, once, under the number it is about. An offline or free cart has no Stripe page to warn of. */}
      {cardCart && (
        <p data-testid="reg-review-card-note" className="mt-1 text-xs text-ink-muted">
          {t("register.review.cardNote")}
        </p>
      )}
    </div>
  );
}
