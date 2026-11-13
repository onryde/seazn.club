"use client";

// "Copy reference" beside the status page's reference hero (registration redesign B4 T15, spec §5.1 item 2). The reference is what a
// registrant quotes on a bank transfer and to the organiser, so one press puts the whole code on the clipboard. The button reads
// "Copied" for a moment after, and the same word goes to a polite live region for a screen reader.
//
// When the clipboard refuses (permissions, an insecure context) nothing changes: the reference beside this button is `select-all`,
// so one tap on it selects the whole code to copy by hand.
import { useState } from "react";
import { useMsg } from "@/components/i18n/dict-provider";
import { BTN_GHOST, LABEL_SIZER, LABEL_SIZER_TEXT } from "@/components/public-site/register/styles";

/** How long the button reads "Copied" before it offers the copy again. */
export const COPIED_MS = 2000;

export function CopyReference({ reference }: { reference: string }) {
  const msg = useMsg();
  const [copied, setCopied] = useState(false);
  const copyLabel = msg("register.status.copyRef");
  const copiedLabel = msg("register.status.copied");

  async function copy() {
    try {
      await navigator.clipboard.writeText(reference);
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      // Refused: the reference itself is selectable (see the header).
    }
  }

  return (
    <>
      {/* LABEL_SIZER keeps the button as wide as the longer of its two words, so "Copied" never shifts the row. 44px tall (`min-h-11`). */}
      <button type="button" data-testid="reg-status-copy-ref" onClick={copy} className={`${BTN_GHOST} min-h-11`}>
        <span className={LABEL_SIZER} data-widest={copyLabel.length >= copiedLabel.length ? copyLabel : copiedLabel}>
          <span className={LABEL_SIZER_TEXT}>{copied ? copiedLabel : copyLabel}</span>
        </span>
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? copiedLabel : ""}
      </span>
    </>
  );
}
