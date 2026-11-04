"use client";

// Tips framework (v3/03 §4): <Tip id> renders an inline ⓘ whose popover
// explains one concept in 1–3 sentences. All copy comes from config/tips.ts;
// "Learn more →" renders only when the /help article actually resolves
// (PROMPT-35) — never a dead link. (The dismissible banner variant,
// TipCallout, went with its last consumer: UI5 item 1, fix round 1 m6.)
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Info } from "lucide-react";
import { TIPS, type TipId } from "@/config/tips";
import { helpUrl } from "@/lib/help";
import { useMsg } from "@/components/i18n/dict-provider";

export function Tip({
  id,
  className = "",
  small = false,
}: {
  id: TipId;
  className?: string;
  /** Table headers and other dense chrome — smaller ⓘ, same popover. */
  small?: boolean;
}) {
  const msg = useMsg();
  const { helpSlug } = TIPS[id];
  const title = msg(`tips.${id}.title`);
  const body = msg(`tips.${id}.body`);
  const href = helpUrl(helpSlug);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span ref={rootRef} className={`relative inline-flex ${className}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={msg("tips.about", { title })}
        onClick={() => setOpen((v) => !v)}
        className={`grid place-items-center rounded-full text-slate-400 transition hover:text-purple-600 ${
          small ? "h-3.5 w-3.5" : "h-5 w-5"
        }`}
      >
        <Info className={small ? "h-3 w-3" : "h-3.5 w-3.5"} strokeWidth={2} />
      </button>
      {open && (
        // normal-case/tracking-normal: hosts like table headers set uppercase
        // + letter-spacing that the popover must never inherit — the copy
        // renders at the standard tip size everywhere. `small` right-aligns:
        // dense hosts sit in clipping scroll containers where a centered
        // popover runs off the edge.
        <span
          role="note"
          className={`absolute z-30 w-64 rounded-xl border border-purple-100 bg-white p-3 text-left normal-case tracking-normal shadow-lg ${
            small ? "right-0 top-6" : "left-1/2 top-7 -translate-x-1/2"
          }`}
        >
          <span className="block text-xs font-semibold text-slate-800">{title}</span>
          <span className="mt-1 block text-xs font-normal leading-relaxed text-slate-600">
            {body}
          </span>
          {href && (
            <Link
              href={href}
              className="mt-2 block text-xs font-medium text-purple-600 hover:underline"
            >
              {msg("tips.learnMore")} →
            </Link>
          )}
        </span>
      )}
    </span>
  );
}
