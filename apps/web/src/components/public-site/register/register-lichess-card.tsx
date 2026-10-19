"use client";
// T16 fix round 1, I5 — the Lichess link on the CONSENT step (canvas RegisterLichessPhone): offered before signup when
// a selected division plays online, instead of only after a LICHESS_LINK_REQUIRED submit failure (the review step's
// backstop stays). Not the account card (`components/lichess-link-card.tsx`): a sign-up form has no Unlink, and it
// names the divisions the link is for. The grant disclosure is the account tab's own consent copy, word for word.
//
// The start returns to THIS registration (`registerReturnPath` — a same-origin relative path, which the start route
// re-validates with `safeNextPath`), and the draft survives in sessionStorage (register-state.ts), so the player comes
// straight back to this step with their answers. The page reads the link state for the signed-in viewer (the page is
// force-dynamic), so on the way back the card says who it is linked as.
import { useLocaleOrDefault, usePlural, useT } from "@/components/i18n/dict-provider";
import { LichessFlashNotice } from "@/components/lichess-flash-notice";
import { lichessLinkStartHref, type LichessFlashCode } from "@/lib/lichess-link";

/** What the page knows for this viewer: whether this server can link at all, the linked Lichess name (null when
 *  signed out or not linked), and the `?lichess=` outcome a return from the start carried. */
export type RegisterLichessState = {
  configured: boolean;
  linkedUsername: string | null;
  flash: LichessFlashCode | null;
};

/** This competition's registration, the join code kept — every part encoded, so the path can only ever be ours. */
export function registerReturnPath(orgSlug: string, competitionSlug: string, joinCode: string | null): string {
  const base = `/shared/${encodeURIComponent(orgSlug)}/${encodeURIComponent(competitionSlug)}/register`;
  return joinCode ? `${base}?join=${encodeURIComponent(joinCode)}` : base;
}

/** The cart's selected divisions that play online (the wire's `online_play`, true only while the club is offered
 *  online chess), by name — in the cart's order, each once. Empty ⇒ no card. */
export function onlineDivisionNames(
  cart: { entries: readonly { division_id: string }[] },
  divisions: readonly { division_id: string; name: string; online_play?: boolean }[],
): string[] {
  const byId = new Map(divisions.map((d) => [d.division_id, d]));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const e of cart.entries) {
    const d = byId.get(e.division_id);
    if (d?.online_play !== true || seen.has(d.division_id)) continue;
    seen.add(d.division_id);
    out.push(d.name);
  }
  return out;
}

export function RegisterLichessCard({
  divisions,
  orgSlug,
  next,
  state,
}: {
  /** The selected divisions that play online, by name. */
  divisions: string[];
  orgSlug: string;
  next: string;
  state: RegisterLichessState;
}) {
  const t = useT();
  const plural = usePlural();
  const locale = useLocaleOrDefault();
  const names = new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(divisions);
  // A `linked` outcome is shown as the linked row itself; any other outcome is a failure to say. "linked" with no
  // account on file (a stale or hand-typed URL) is not a success to announce.
  const failure = state.flash !== "linked" ? state.flash : null;
  return (
    <section
      data-testid="register-lichess-card"
      aria-labelledby="register-lichess-title"
      className="mt-4 flex min-w-0 flex-col gap-2.5 rounded-[14px] border-2 border-[#7c3aed] bg-white p-3.5"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 id="register-lichess-title" className="m-0 min-w-0 text-[17px] font-semibold text-[#2e1065]">
          {t("register.lichess.title")}
        </h3>
        <span className="shrink-0 rounded-full bg-[#2e1065] px-2.5 py-0.5 text-xs font-semibold text-white">
          {t("register.lichess.required")}
        </span>
      </div>
      <p className="m-0 text-sm leading-[1.45] text-[#2e1065] [overflow-wrap:anywhere]">
        {plural("register.lichess.lead", divisions.length, { divisions: names })}
      </p>
      {state.linkedUsername !== null ? (
        <div
          role="status"
          data-testid="register-lichess-linked"
          className="flex min-w-0 items-center gap-2.5 rounded-xl border border-[#c9bdf0] bg-[#f3effc] px-3 py-2.5 text-sm text-[#2e1065]"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#5b21b6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
            <path d="M5 12l5 5 9-10" />
          </svg>
          <span className="min-w-0 truncate">{t("settings.account.lichess.linkedAs", { username: state.linkedUsername })}</span>
        </div>
      ) : (
        <>
          <h4 className="m-0 mt-1 text-sm font-semibold text-[#2e1065]">{t("settings.account.lichess.consent.title")}</h4>
          <p className="m-0 text-xs leading-[1.45] text-[#4a3a6b]">{t("settings.account.lichess.consent.body")}</p>
          <p className="m-0 text-xs leading-[1.4] text-[#6b5b8a]">{t("settings.account.lichess.consent.scopes")}</p>
          {/* The same notice the match room's link card says it with: the sentence, and for already_linked the next step. */}
          {failure !== null && <LichessFlashNotice code={failure} testId="register-lichess-flash" />}
          {state.configured ? (
            <>
              <a
                href={lichessLinkStartHref(orgSlug, next)}
                data-testid="register-lichess-start"
                className="flex min-h-11 items-center justify-center rounded-[10px] bg-[#7c3aed] px-4 text-[15px] font-semibold text-white no-underline hover:bg-[#6d28d9] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#7c3aed]"
              >
                {t("settings.account.lichess.link")}
              </a>
              <p className="m-0 text-xs leading-[1.4] text-[#6b5b8a]">{t("register.lichess.returnHint")}</p>
            </>
          ) : (
            <p className="m-0 text-sm text-amber-800">{t("settings.account.lichess.notConfigured")}</p>
          )}
        </>
      )}
    </section>
  );
}
