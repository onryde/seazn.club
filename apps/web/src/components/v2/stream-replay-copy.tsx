"use client";
// "Copy link" on the fixture panel's after-match replay row (YouTube Connect T12, owner's Option B): the organiser pastes the replay
// into the club chat without opening it first. The panel's body is a pure function of props (the node test harness expands it with
// read-only hooks), so the one piece of state this needs — "Link copied" for a moment — lives here.
import { useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { useMsg } from "@/components/i18n/dict-provider";

/** How long "Link copied" stays on the button. */
export const REPLAY_COPIED_MS = 1500;

export function ReplayCopyButton({ url }: { url: string }) {
  const msg = useMsg();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      return; // a browser that refuses the clipboard took nothing; the Watch replay link beside it still opens the video
    }
    setCopied(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), REPLAY_COPIED_MS);
  };
  return (
    <button type="button" data-testid="stream-replay-copy" onClick={() => void copy()} className="btn btn-ghost min-h-11 w-full md:min-h-10 md:w-auto">
      {copied ? <Check aria-hidden className="h-4 w-4 text-green-600" strokeWidth={2} /> : <Copy aria-hidden className="h-4 w-4" strokeWidth={1.8} />}
      <span aria-live="polite">{msg(copied ? "stream.replay.copied" : "stream.replay.copy")}</span>
    </button>
  );
}
