"use client";
// How a Lichess linking flow went (`?lichess=<code>`, lib/lichess-link.ts), said on the page the player lands on.
//
// One component for every card that offers the link and is returned to by it - the match room's link / re-link card
// and revoked notice, and the registration stepper's Lichess card - so the two cannot drift. Owner staging test,
// 2026-10-19: the room ignored the parameter, so a link refused because that Lichess account already belongs to a
// DIFFERENT Seazn account landed on the same Re-link card, silently, and the player looped for ever.
//
// It says only what FAILED, as an alert in an error tone (PR #990 review, I1): the room holds the outcome for the page's
// life, and a held "Lichess account linked." would stand over a LATER "Your Lichess link was revoked" card - a success
// is shown by the state itself (the linked row, the seat taken), so `linked` draws nothing here. An outcome that tells
// the player what to do next (already_linked) says it on a second line. Anything that is not one of our failures - a
// hand-typed value, an absent one - draws nothing at all, not an empty box. It never names the other account: the
// server does not know whose it is.
import { useT } from "@/components/i18n/dict-provider";
import { lichessFailureCode, lichessFlashKey, lichessFlashNextKey } from "@/lib/lichess-link";

const LOOK = {
  box: "border-[#efb8b0] bg-[#fdf1ef] text-[#7a271a]",
  icon: "#b42318",
  glyph: (
    <>
      <path d="M12 3l9 16H3z" />
      <path d="M12 10v4" />
      <path d="M12 17h.01" />
    </>
  ),
} as const;

export function LichessFlashNotice({
  code,
  testId = "lichess-flash",
  className = "",
  gameAccount = false,
}: {
  /** The raw `?lichess=` value, or the code already narrowed from it. */
  code: string | null | undefined;
  /** The host's own test id (the registration card keeps `register-lichess-flash`); the text and next step derive theirs. */
  testId?: string;
  className?: string;
  /** The board is on ONE specific Lichess account (the room's revoked notice, `otherAccount`): the next step must keep that
   *  account, never offer a different one (lib/lichess-link.ts `LICHESS_FLASH_NEXT_KEYS_FOR_GAME_ACCOUNT`). */
  gameAccount?: boolean;
}) {
  const t = useT();
  const flash = lichessFailureCode(code);
  const key = lichessFlashKey(flash);
  if (flash === null || key === null) return null;
  const nextKey = lichessFlashNextKey(flash, { gameAccount });
  return (
    <div
      role="alert"
      data-testid={testId}
      data-code={flash}
      data-tone="error"
      className={`flex min-w-0 items-start gap-2.5 rounded-xl border px-3 py-2.5 ${LOOK.box} ${className}`}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke={LOOK.icon}
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="mt-px shrink-0"
      >
        {LOOK.glyph}
      </svg>
      <div className="flex min-w-0 flex-col gap-1">
        <p data-testid={`${testId}-text`} className="m-0 min-w-0 text-sm font-semibold leading-[1.35] [overflow-wrap:anywhere]">
          {t(key)}
        </p>
        {nextKey !== null ? (
          <p data-testid={`${testId}-next`} className="m-0 min-w-0 text-[13px] leading-[1.45] [overflow-wrap:anywhere]">
            {t(nextKey)}
          </p>
        ) : null}
      </div>
    </div>
  );
}
