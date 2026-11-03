"use client";

// The Showcase opt-in of the New competition form (Match Day C8): a switch, one
// line, and a "What this allows" disclosure. The consent wording is the existing
// `showcase.consent` key — unchanged, shared with competition settings — and the
// switch is disabled unless the competition is Public (doc 15 §1: showcase only
// public), with the reason in amber-700 (AA at 12-13px; amber-600 is ~3.2:1).
import { ChevronRight, Info } from "lucide-react";
import { useMsg } from "@/components/i18n/dict-provider";

export function ShowcaseOptIn({
  visibility,
  checked,
  onChange,
}: {
  visibility: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  const msg = useMsg();
  const isPublic = visibility === "public";
  return (
    <div data-testid="showcase-optin">
      <label className={`flex min-h-11 items-center gap-4 ${isPublic ? "cursor-pointer" : "cursor-not-allowed"}`}>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span id="showcase-title" className={`text-sm font-semibold ${isPublic ? "text-slate-800" : "text-slate-500"}`}>
            {msg("showcase.label")}
          </span>
          <span id="showcase-line" className={`text-[13px] leading-snug ${isPublic ? "text-slate-600" : "text-slate-500"}`}>
            {msg("comp.wizard.showcase.line")}
          </span>
        </span>
        {/* The off track is slate-500, not slate-300: the state has to read at
            3:1 against white. */}
        <input
          type="checkbox"
          role="switch"
          disabled={!isPublic}
          checked={isPublic && checked}
          onChange={(e) => onChange(e.target.checked)}
          aria-labelledby="showcase-title"
          aria-describedby={isPublic ? "showcase-line" : "showcase-line showcase-why"}
          className="relative m-0 h-6 w-10 shrink-0 cursor-pointer appearance-none rounded-full bg-slate-500 transition-colors before:absolute before:left-[3px] before:top-[3px] before:h-[18px] before:w-[18px] before:rounded-full before:bg-white before:shadow before:transition-transform before:content-[''] checked:bg-purple-600 checked:before:translate-x-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-600 disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:transition-none motion-reduce:before:transition-none"
        />
      </label>
      {!isPublic && (
        <p id="showcase-why" className="mt-1.5 flex items-start gap-1.5 text-[13px] leading-snug text-amber-700">
          <Info aria-hidden className="mt-px h-3.5 w-3.5 shrink-0" strokeWidth={2} />
          <span>{msg("showcase.needsPublic")}</span>
        </p>
      )}
      <details className="group mt-1">
        <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1 rounded-md text-[13px] font-medium text-purple-700 [&::-webkit-details-marker]:hidden">
          <ChevronRight
            aria-hidden
            className="h-4 w-4 transition-transform group-open:rotate-90 motion-reduce:transition-none"
            strokeWidth={2}
          />
          {msg("comp.wizard.showcase.allows")}
        </summary>
        <p className="mt-1.5 max-w-prose rounded-lg bg-purple-50 px-3.5 py-3 text-[13px] leading-relaxed text-slate-700">
          {msg("showcase.consent")}
        </p>
      </details>
    </div>
  );
}
