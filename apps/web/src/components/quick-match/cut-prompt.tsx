"use client";
// The answers to a tie at a League + Knockout's cut (quick match plan 5 Task 7, D5; spec
// docs/superpowers/specs/2026-11-12-quick-match-league-knockout-design.md §5, §11; mockup qmd13a01 §8, layout only): "Pick who
// goes through" opens a panel of the tied sides, and "Toss a coin" posts at once (it reveals the lot the table already
// stored: the same result on every phone). The question itself (its kicker, title and body) is the home's (home.tsx
// `cutCard`); the page builds the actions and the words, and this island only keeps the panel honest:
//
//   - No script: the panel is a native `<details>`, its sides real radios (one place) or checkboxes (more), and Send a real
//     submit. The server counts the picks (PICK_INVALID), so Send is never disabled in the server's markup. Back is a link
//     to the home's own path, which reloads it with the panel shut. Toss is a plain form post.
//   - With the script: Send is disabled until exactly as many sides are chosen as there are places, and says who it sends
//     ("Send Ines through"); Back shuts the panel in place. The first submit of either form goes through and every later
//     one is cancelled until the page comes back from the back-forward cache (`pageshow` persisted), as the Score form does;
//     the busy state is `aria-disabled` and its look, never `disabled` (disabling a submitter can cancel the post it started).
//   - While the panel is open the Toss form steps aside (the wrapper's `group-has` variant: CSS only, so no-script too).
//   - Every element holding the home token (the two actions and Back, O3) carries `ph-no-capture`.
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type MouseEvent } from "react";
import { Coins } from "lucide-react";
import { interpolate } from "@/lib/i18n-runtime";
import { useHydrated } from "@/lib/use-client-snapshot";

export interface QuickMatchCutPromptProps {
  /** `routes.quickMatchCutPick(token)`. */
  pickAction: string;
  /** `routes.quickMatchCutToss(token)`, or null when no lot ordered the tie (`CutView.toss` false): Pick only. */
  tossAction: string | null;
  /** `routes.quickMatch(token)`: Back with no script reloads the home, panel shut. */
  backHref: string;
  /** The tied sides, in the order the guests typed them. */
  members: { id: string; name: string }[];
  /** How many of them go through: one radio group, or checkboxes for more than one. */
  seats: number;
  /** The viewer's language, for the list of names in Send's label. */
  locale: string;
  words: {
    pick: string;
    toss: string;
    back: string;
    /** "Who goes through?" / "Choose 2 to go through" (plural on `seats`, resolved by the page). */
    question: string;
    /** `quickMatch.cut.send` as written: "Send {names} through". */
    send: string;
  };
}

const FOCUS = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cream";
const PRIMARY = `app-display inline-flex min-h-12 w-full max-w-full items-center justify-center gap-2 rounded-xl bg-[color:var(--mk-orange)] px-5 py-2.5 text-center text-base font-bold leading-tight text-night [overflow-wrap:anywhere] disabled:cursor-not-allowed disabled:opacity-45 aria-disabled:opacity-70 ${FOCUS}`;
const SECONDARY = `app-display inline-flex min-h-12 w-full max-w-full items-center justify-center gap-2 rounded-xl border border-[#4a3a80] px-5 py-2.5 text-center text-base font-semibold leading-tight text-cream [overflow-wrap:anywhere] hover:border-[#6b5aa6] aria-disabled:opacity-70 ${FOCUS}`;

export function QuickMatchCutPrompt({ pickAction, tossAction, backHref, members, seats, locale, words }: QuickMatchCutPromptProps) {
  const hydrated = useHydrated();
  const [chosen, setChosen] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const panel = useRef<HTMLDetailsElement | null>(null);
  const many = seats > 1;

  // Back from the next page (bfcache): the page comes back exactly as it was left, locked mid-post. Unlock it.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      locked.current = false;
      setBusy(false);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  const choose = (id: string) => (e: ChangeEvent<HTMLInputElement> | { target: { checked: boolean } }) => {
    const on = e.target.checked;
    setChosen((prev) => (many ? (on ? [...prev.filter((x) => x !== id), id] : prev.filter((x) => x !== id)) : on ? [id] : []));
  };
  const ready = chosen.length === seats;
  // In the panel's order, so the label reads the same whichever was ticked first.
  const names = members.filter((m) => chosen.includes(m.id)).map((m) => m.name);
  const sendLabel =
    names.length === 0
      ? words.pick
      : interpolate(words.send, { names: new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(names) });

  function guard(e: FormEvent<HTMLFormElement> | { preventDefault(): void }) {
    if (locked.current) {
      e.preventDefault();
      return;
    }
    locked.current = true;
    setBusy(true);
  }
  function onPick(e: FormEvent<HTMLFormElement> | { preventDefault(): void }) {
    // An Enter in the panel submits too: the same count Send's disabled state asks for.
    if (hydrated && !ready) {
      e.preventDefault();
      return;
    }
    guard(e);
  }
  function onBack(e: MouseEvent<HTMLAnchorElement> | { preventDefault(): void }) {
    const el = panel.current;
    if (el === null) return; // no panel to shut: follow the link (the reload shuts it)
    e.preventDefault();
    el.open = false;
  }

  return (
    <div data-testid="qm-cut-actions" className="group/cut flex min-w-0 flex-col gap-2.5">
      <details ref={panel} data-testid="qm-cut-pick-panel" className="min-w-0">
        <summary data-testid="qm-cut-pick" className={`${PRIMARY} cursor-pointer list-none [details[open]>&]:hidden [&::-webkit-details-marker]:hidden`}>
          {words.pick}
        </summary>
        <form method="post" action={pickAction} onSubmit={onPick} className="ph-no-capture flex min-w-0 flex-col gap-2.5">
          <fieldset className="min-w-0">
            <legend data-testid="qm-cut-question" className="app-display text-base font-semibold text-cream [overflow-wrap:anywhere]">
              {words.question}
            </legend>
            <div className="mt-2 flex min-w-0 flex-col gap-2">
              {members.map((m) => (
                <label
                  key={m.id}
                  data-testid="qm-cut-option"
                  className="flex min-h-12 min-w-0 cursor-pointer items-center gap-3 rounded-xl border border-[#3b2a6e] bg-[rgba(36,22,80,0.75)] px-3 py-2 has-[:checked]:border-[color:var(--mk-orange)] has-[:checked]:bg-[rgb(251_146_60/0.1)] has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-cream"
                >
                  <input
                    type={many ? "checkbox" : "radio"}
                    name="entrant"
                    value={m.id}
                    onChange={choose(m.id)}
                    className="h-5 w-5 flex-none accent-[color:var(--mk-orange)]"
                  />
                  <span className="min-w-0 text-base font-semibold text-cream [overflow-wrap:anywhere]">{m.name}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <button
            type="submit"
            data-testid="qm-cut-send"
            disabled={hydrated && !ready}
            aria-disabled={busy || undefined}
            className={PRIMARY}
          >
            {sendLabel}
          </button>
          <a data-testid="qm-cut-back" href={backHref} onClick={onBack} className={`ph-no-capture ${SECONDARY}`}>
            {words.back}
          </a>
        </form>
      </details>
      {tossAction !== null ? (
        <form method="post" action={tossAction} onSubmit={guard} className="ph-no-capture min-w-0 group-has-[details[open]]/cut:hidden">
          <button type="submit" data-testid="qm-cut-toss" aria-disabled={busy || undefined} className={SECONDARY}>
            <Coins aria-hidden="true" className="h-5 w-5 flex-none" />
            <span className="min-w-0">{words.toss}</span>
          </button>
        </form>
      ) : null}
    </div>
  );
}
