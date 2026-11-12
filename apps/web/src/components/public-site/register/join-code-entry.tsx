"use client";

// "Have a join code?" (polish wave P6): the way in for a teammate who was handed a CODE, not a link. A join link is the usual hand-over
// (`/register/join?join_code=...`), but a code read out over the phone or typed from a team sheet had nowhere to go on the public
// register page: the only door was the link itself.
//
// It sends the typed code to the join page - nothing more. The code is read the way a person writes one down (`joinLinkFromTyped`:
// any case, with or without the `SZ` and the dashes), and the JOIN PAGE decides everything else: its per-IP throttle runs before
// its lookup, an unknown, dead or full code gets its one "not valid" answer, a throttled visit its own. So this field adds no
// second lookup and no second oracle: it cannot tell a live code from a dead one, because it never asks.
//
// The typed code is a capability (whoever holds it can join the entry), so the input is `ph-no-capture` like every element that
// shows one.
import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useMsg } from "@/components/i18n/dict-provider";
import { joinLinkFromTyped } from "@/lib/join-link";
import { BTN_PRIMARY, FIELD, FIELD_LABEL } from "./styles";

export function JoinCodeEntry({ orgSlug, competitionSlug }: { orgSlug: string; competitionSlug: string }) {
  const m = useMsg();
  const router = useRouter();
  const inputId = useId();
  const [typed, setTyped] = useState("");

  function submit(e: { preventDefault: () => void }) {
    e.preventDefault();
    const href = joinLinkFromTyped(orgSlug, competitionSlug, typed);
    // A blank entry goes nowhere: there is nothing to look up, and an empty join page would only say "not valid".
    if (href) router.push(href);
  }

  return (
    <form
      data-testid="register-join-code"
      onSubmit={submit}
      className="mb-5 max-w-xl rounded-xl border border-zinc-200 bg-white p-4 shadow-sm"
    >
      <h2 className="font-display text-sm font-semibold uppercase tracking-wide text-ink">{m("register.joinCode.heading")}</h2>
      <p className="mt-1 text-xs text-ink-muted">{m("register.joinCode.hint")}</p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <label htmlFor={inputId} className={FIELD_LABEL}>
            {m("register.joinCode.label")}
          </label>
          <input
            id={inputId}
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={m("register.joinCode.placeholder")}
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            className={`ph-no-capture ${FIELD} font-mono`}
          />
        </div>
        <button type="submit" className={BTN_PRIMARY}>
          {m("register.joinCode.submit")}
        </button>
      </div>
    </form>
  );
}
