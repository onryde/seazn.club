"use client";

// "Invite your teammates" (polish wave P6, redesigned in wave K) — the captain's block of join links on the status page.
//
// Wave K (owner feedback: "three identical-looking raw URLs confuse"): no URL is printed. The block names every roster slot with
// whether that person has joined; a slot still to join gets Copy link and (where the device can) Share, a joined one only its chip.
// For a team, the general link sits apart, below a divider, under "Someone not listed?". Copying says WHOSE link went to the
// clipboard ("Copied Dana Whitfield's link"), shown and announced through a polite live region, so the captain (and a screen
// reader) knows which link they now hold.
//
// A join link is a capability (whoever holds the code can join the entry), so the whole block is `ph-no-capture`: the recorder drops
// the element, its text and its attributes, which is where the code lives (each Copy button carries its link as `data-href`, the
// hook the walkthrough specs follow as the second person). scrub-secret-painters.test.ts holds the rule and finds this file because
// the links are built here, by `joinLinkPath`.
//
// Layout (registration redesign B4 T16, spec 5.4). The block sits in the entry card's body, 222px wide at a 320 viewport, and that card
// is `overflow-hidden`: anything that outgrows a row is CLIPPED, never scrolled, so the no-horizontal-scroll gate cannot see it. A row is
// a `flex-wrap` of two groups, the person (name, then the joined / not-joined chip) and the buttons, and each group wraps in turn:
//   - the person's group has a 12rem floor (`grow basis-48`, never `flex-1`, whose own 0% basis could outrank basis-*), so on a phone
//     the buttons drop UNDER it rather than leaving the name ~130px wide; from a wide enough row they sit at its end;
//   - inside it the chip drops under the name once the two no longer fit one line, and is itself `max-w-full`, so a long label wraps in
//     its own pill instead of leaving the row;
//   - the name wraps (`break-words`), it does not truncate: it is the one thing that tells the captain whose link a button copies;
//   - every box from the name up to the section carries `min-w-0` (AGENTS.md: truncation and wrapping both need the whole chain).
// The frame is the status page's own card (rounded-xl, a zinc-200 hairline) in the canvas tone, as a well inside the surface-toned entry card.
//
// What this does NOT say: which teammates were "already emailed an invite". Nothing mails a teammate who has not joined yet (the
// only mail a teammate gets is the account-claim after they have), so there is nothing true to state.
import { useId, useState, useSyncExternalStore } from "react";
import { useMsg } from "@/components/i18n/dict-provider";
import { joinLinkPath } from "@/lib/join-link";

// The device's answer, read through a store rather than copied into state by a mount effect: false on the server and on the
// hydration render (so the native button never mismatches the markup the server sent), the device's real answer from the render
// after. Same idiom as ShareBar.
const capabilityNeverChanges = () => () => {};
const readCanShare = () => typeof navigator !== "undefined" && typeof navigator.share === "function";
const cannotShareOnServer = () => false;

const BUTTON =
  "inline-flex min-h-11 items-center rounded-lg border border-zinc-200 bg-surface px-3 text-xs font-medium text-accent-strong shadow-sm transition hover:bg-accent-soft";
const CHIP_JOINED = "max-w-full shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700";
const CHIP_WAITING = "max-w-full shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700";

/** Copy link and (where the device has a share sheet) Share, for one link. `describedBy` names whose link it is to a screen reader;
 *  `onCopied` runs once the link is really on the clipboard. When the clipboard refuses, the link is shown so it can be copied by
 *  hand: the only case a URL is printed. */
export function InviteActions({
  path,
  copyLabel,
  shareTitle,
  shareText,
  describedBy,
  onCopied,
}: {
  path: string;
  copyLabel: string;
  shareTitle: string;
  shareText: string;
  describedBy: string;
  onCopied: () => void;
}) {
  const msg = useMsg();
  const [blocked, setBlocked] = useState(false);
  const canShare = useSyncExternalStore(capabilityNeverChanges, readCanShare, cannotShareOnServer);

  async function copy() {
    try {
      // Read at the moment of the click, not from the render: the render's origin is "" until hydration.
      await navigator.clipboard.writeText(`${window.location.origin}${path}`);
      setBlocked(false);
      onCopied();
    } catch {
      // Clipboard blocked (permissions, an insecure context): show the link so it can be selected by hand.
      setBlocked(true);
    }
  }

  async function share() {
    try {
      await navigator.share({ title: shareTitle, text: shareText, url: `${window.location.origin}${path}` });
    } catch (err) {
      // Dismissing the sheet is an answer, not a failure: copy nothing. Anything else (a browser that refuses without a gesture,
      // a share target that errors) falls back to the copy, so the press still ends with the link on the clipboard.
      if (err instanceof DOMException && err.name === "AbortError") return;
      await copy();
    }
  }

  // `ph-no-capture` on its own root as well as the block's: it carries the link (data-href, and the by-hand fallback), and is a
  // component of its own that could be mounted outside the block.
  return (
    <div className="ph-no-capture flex min-w-0 flex-wrap items-center gap-2">
      <button type="button" data-testid="reg-invite-copy" data-href={path} aria-describedby={describedBy} onClick={copy} className={BUTTON}>
        {copyLabel}
      </button>
      {canShare && (
        <button type="button" data-testid="reg-invite-share" aria-describedby={describedBy} onClick={share} className={BUTTON}>
          {msg("register.status.invite.share")}
        </button>
      )}
      {blocked && (
        <a href={path} className="basis-full font-mono text-xs break-all text-accent-strong underline underline-offset-2">
          {`${window.location.origin}${path}`}
        </a>
      )}
    </div>
  );
}

/**
 * The block: a heading and one line on how the links work, worded for what the entry is (a team's teammates, a pair's partner); one
 * row per roster slot (named by the roster's own masked name, resolved on the server) with its joined / not-joined chip and, while
 * the person is still to join, their own link; then, for a team, the general link. WHICH links exist is `inviteLinks`
 * (view-model.ts); the URLs are written here, from the code, so the code is a prop of the file that paints it.
 */
export function InviteTeammates({
  kind,
  entryName,
  divisionName,
  orgSlug,
  competitionSlug,
  joinCode,
  slots,
  generic,
}: {
  kind: "team" | "pair";
  entryName: string;
  divisionName: string;
  orgSlug: string;
  competitionSlug: string;
  joinCode: string;
  /** Every roster slot, in roster order: the player id a link opens with, the name to show (already masked), and whether the person
   *  has joined (then the slot has no link). */
  slots: { id: string; name: string; joined: boolean }[];
  /** Whether the general link is offered (a team that may still grow). */
  generic: boolean;
}) {
  const msg = useMsg();
  const ids = useId();
  const [announced, setAnnounced] = useState("");
  // Nothing to hand out (every slot joined, and no general link): no block. A heading over chips alone would invite nobody.
  if (!slots.some((slot) => !slot.joined) && !generic) return null;
  const shareTitle = msg("register.status.invite.shareTitle", { entry: entryName });
  const shareText = msg("register.status.invite.shareText", { entry: entryName, division: divisionName });
  const pair = kind === "pair";
  const genericId = `${ids}-generic`;
  return (
    <section data-testid="reg-invite" className="ph-no-capture min-w-0 space-y-3 rounded-xl border border-zinc-200 bg-canvas p-3 sm:p-4">
      {/* Announced through an always-present live region (one hidden with display:none until it has text is never registered, so
          its first message would go unread); the same words are shown at the foot of the block for sighted users once there is
          something to say. First child, and out of flow (sr-only), so it adds no space to the block. */}
      <p role="status" aria-live="polite" className="sr-only">
        {announced}
      </p>
      <div className="space-y-1">
        <h4 className="font-display text-sm font-semibold text-ink">
          {msg(pair ? "register.status.invite.headingPair" : "register.status.invite.heading")}
        </h4>
        <p className="text-xs text-ink-muted">{msg(pair ? "register.status.invite.introPair" : "register.status.invite.intro")}</p>
      </div>
      {slots.length > 0 && (
        <ul className="min-w-0 divide-y divide-zinc-200">
          {slots.map((slot, i) => {
            const nameId = `${ids}-slot-${i}`;
            return (
              <li key={slot.id} data-invite-slot className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0">
                <div className="flex min-w-0 grow basis-48 flex-wrap items-center gap-x-2 gap-y-1">
                  {/* Wraps rather than truncates: the name is how the captain tells whose link this is, so all of it stays visible. */}
                  <span id={nameId} className="max-w-full min-w-0 text-sm font-medium break-words text-ink">
                    {slot.name}
                  </span>
                  {slot.joined ? (
                    <span className={CHIP_JOINED}>
                      <span aria-hidden="true">✓ </span>
                      {msg("register.status.roster.joined")}
                    </span>
                  ) : (
                    <span className={CHIP_WAITING}>{msg("register.status.roster.notJoined")}</span>
                  )}
                </div>
                {!slot.joined && (
                  <InviteActions
                    path={joinLinkPath(orgSlug, competitionSlug, joinCode, slot.id)}
                    copyLabel={msg("register.status.invite.copy")}
                    shareTitle={shareTitle}
                    shareText={shareText}
                    describedBy={nameId}
                    onCopied={() => setAnnounced(msg("register.status.invite.copiedFor", { name: slot.name }))}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {generic && (
        <div
          data-invite-generic
          className={`flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 ${slots.length > 0 ? "border-t border-zinc-300 pt-3" : ""}`}
        >
          <p id={genericId} className="min-w-0 grow basis-48 text-sm font-medium text-ink">
            {msg("register.status.invite.notListed")}
          </p>
          <InviteActions
            path={joinLinkPath(orgSlug, competitionSlug, joinCode)}
            copyLabel={msg("register.status.invite.copyGeneric")}
            shareTitle={shareTitle}
            shareText={shareText}
            describedBy={genericId}
            onCopied={() => setAnnounced(msg("register.status.invite.copiedGeneric"))}
          />
        </div>
      )}
      {announced && (
        <p aria-hidden="true" className="text-xs font-medium break-words text-emerald-700">
          {announced}
        </p>
      )}
    </section>
  );
}
