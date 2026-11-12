"use client";

// "Invite your teammates" (polish wave P6) — the captain's block of join links on the status page, replacing the plain anchors that
// said "Send {name} their check-in link" and "Invite someone new to this entry" and gave no way to actually send them: each link is
// shown, with Copy link and (where the device can) Share, so the captain can put it in a message without hunting for the URL.
//
// A join link is a capability (whoever holds the code can join the entry), so each row is `ph-no-capture`: the recorder drops the
// element, its text and its attributes, which is where the code lives (scrub-secret-painters.test.ts holds the rule, and finds this
// file because the links are built here, by `joinLinkPath`). The anchor stays a real anchor to the join page: it is what a captain
// hands their phone over with ("open it for them"), and the walkthrough specs follow it as the second person.
//
// What this does NOT say: which teammates were "already emailed an invite". Nothing mails a teammate who has not joined yet (the
// only mail a teammate gets is the account-claim after they have), so there is nothing true to state.
import { useState, useSyncExternalStore } from "react";
import { useMsg } from "@/components/i18n/dict-provider";
import { joinLinkPath } from "@/lib/join-link";
import { useOrigin } from "@/lib/use-client-snapshot";

// The device's answer, read through a store rather than copied into state by a mount effect: false on the server and on the
// hydration render (so the native button never mismatches the markup the server sent), the device's real answer from the render
// after. Same idiom as ShareBar.
const capabilityNeverChanges = () => () => {};
const readCanShare = () => typeof navigator !== "undefined" && typeof navigator.share === "function";
const cannotShareOnServer = () => false;

const BUTTON =
  "inline-flex min-h-11 items-center rounded-lg border border-zinc-200 bg-surface px-3 text-xs font-medium text-accent-strong shadow-sm transition hover:bg-accent-soft";

/** One link: its label, the link itself, Copy link and (where the device has a share sheet) Share. */
export function InviteRow({
  label,
  path,
  shareTitle,
  shareText,
}: {
  label: string;
  path: string;
  shareTitle: string;
  shareText: string;
}) {
  const msg = useMsg();
  const origin = useOrigin();
  const [copied, setCopied] = useState(false);
  const canShare = useSyncExternalStore(capabilityNeverChanges, readCanShare, cannotShareOnServer);
  // What is shown is what is copied: the absolute URL once the origin is known, the path before that.
  const shown = `${origin}${path}`;

  async function copy() {
    try {
      // Read at the moment of the click, not from the render: the render's origin is "" until hydration.
      await navigator.clipboard.writeText(`${window.location.origin}${path}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked (permissions, an insecure context): the link is on screen and selectable */
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

  return (
    <div data-invite-slot className="ph-no-capture min-w-0 space-y-1">
      <p className="truncate text-sm font-medium text-ink">{label}</p>
      <a href={path} className="block truncate font-mono text-xs text-accent-strong underline underline-offset-2">
        {shown}
      </a>
      <div className="flex flex-wrap gap-2">
        <button type="button" data-testid="reg-invite-copy" onClick={copy} className={BUTTON}>
          {copied ? msg("register.status.invite.copied") : msg("register.status.invite.copy")}
        </button>
        {canShare && (
          <button type="button" data-testid="reg-invite-share" onClick={share} className={BUTTON}>
            {msg("register.status.invite.share")}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The block: a heading and a hint worded for what the entry is (a team's teammates, a pair's partner), then one row per link: one for
 * each unclaimed slot (named by the roster's own masked name, resolved on the server) and, for a team, the general link. WHICH links
 * exist is `inviteLinks` (view-model.ts); the URLs are written here, from the code, so the code is a prop of the file that paints it.
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
  /** Unclaimed roster slots: the player id the link opens with, and the name to show (already masked). */
  slots: { id: string; name: string }[];
  /** Whether the general link is offered (a team that may still grow). */
  generic: boolean;
}) {
  const msg = useMsg();
  if (slots.length === 0 && !generic) return null;
  const shareTitle = msg("register.status.invite.shareTitle", { entry: entryName });
  const shareText = msg("register.status.invite.shareText", { entry: entryName, division: divisionName });
  const pair = kind === "pair";
  return (
    <section data-testid="reg-invite" className="min-w-0 space-y-2 rounded-lg bg-canvas p-3">
      <h4 className="text-xs font-semibold tracking-wide text-ink-muted uppercase">
        {msg(pair ? "register.status.invite.headingPair" : "register.status.invite.heading")}
      </h4>
      <p className="text-xs text-ink-muted">{msg(pair ? "register.status.invite.hintPair" : "register.status.invite.hint")}</p>
      <ul className="space-y-3">
        {slots.map((slot) => (
          <li key={slot.id} className="min-w-0">
            <InviteRow
              label={msg("register.status.invite.slotLabel", { name: slot.name })}
              path={joinLinkPath(orgSlug, competitionSlug, joinCode, slot.id)}
              shareTitle={shareTitle}
              shareText={shareText}
            />
          </li>
        ))}
        {generic && (
          <li key="generic" className="min-w-0">
            <InviteRow
              label={msg("register.status.invite.genericLabel")}
              path={joinLinkPath(orgSlug, competitionSlug, joinCode)}
              shareTitle={shareTitle}
              shareText={shareText}
            />
          </li>
        )}
      </ul>
    </section>
  );
}
