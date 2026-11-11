"use client";

// Visibility's shared vocabulary (v3/03 §7): plain language over engineer
// vocabulary — every option has a one-line consequence, because the decision
// IS the consequence. Maps 1:1 onto the existing private/unlisted/public keys
// (no schema change; noindex behaviour unchanged).
//
// The radio-card picker that lived here was retired with the settings C8
// layout (owner 2026-11-11): competition settings now uses the same segmented
// control as the New competition form (`visibility-segmented.tsx`), which reads
// its labels and consequences from `VISIBILITY_OPTIONS` below. What the cards
// did beyond choosing stayed: the share URL and its copy button
// (`VisibilityShareLink`), and the youth guard, which competition settings
// raises itself before it applies a pick.
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { useMsg } from "@/components/i18n/dict-provider";
import type { MessageKey } from "@/lib/messages";
import { useOrigin } from "@/lib/use-client-snapshot";

export type VisibilityKey = "private" | "unlisted" | "public";

/** The three options, their names and the one-line consequence of each — read by
 *  the segmented control on the New competition form and in competition
 *  settings, so the wording has one home. */
export const VISIBILITY_OPTIONS: { value: VisibilityKey; label: MessageKey; consequence: MessageKey }[] = [
  { value: "private", label: "visibility.private.label", consequence: "visibility.private.consequence" },
  { value: "unlisted", label: "visibility.unlisted.label", consequence: "visibility.unlisted.consequence" },
  { value: "public", label: "visibility.public.label", consequence: "visibility.public.consequence" },
];

/**
 * The competition's public URL with a copy button, once the choice is one a
 * stranger can open (anything but Private). Renders nothing for Private or
 * without a path.
 */
export function VisibilityShareLink({
  value,
  sharePath,
}: {
  value: VisibilityKey | string;
  /** Site-relative public path (e.g. /live/org/comp), shown as a full URL. */
  sharePath?: string | null;
}) {
  const msg = useMsg();
  const [copied, setCopied] = useState(false);
  const origin = useOrigin();
  const shareUrl = sharePath ? `${origin}${sharePath}` : null;

  async function copy() {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (value === "private" || !shareUrl) return null;
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg bg-purple-50/70 px-3 py-1.5" data-testid="visibility-share-link">
      <span className="label !mb-0 shrink-0">{msg("visibility.share.label")}</span>
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-slate-700">{shareUrl}</code>
      <button type="button" onClick={() => void copy()} className="btn btn-ghost min-h-11 shrink-0 px-2 py-1 text-xs">
        {copied ? (
          <>
            <Check aria-hidden className="h-3.5 w-3.5 text-green-600" />
            {msg("visibility.share.copied")}
          </>
        ) : (
          <>
            <Copy aria-hidden className="h-3.5 w-3.5" />
            {msg("visibility.share.copy")}
          </>
        )}
      </button>
    </div>
  );
}
