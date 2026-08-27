"use client";

// Share button for a game's result text (Daily Word's emoji grid, 2048's
// score, …). Copies via navigator.clipboard; falls back to a selectable
// <textarea> when the API is missing or the write fails — repo policy:
// "Clipboard API missing → textarea fallback" (design doc, Error handling).
//
// The copy/fallback decision lives in `copyShareText`, a plain async
// function with no DOM dependency, so it's unit-testable without a real
// browser — see share-result.test.tsx's header for why that split exists.
import { useState } from "react";

type ClipboardLike = { writeText(text: string): Promise<void> };

/**
 * Attempts to copy `text` via `clipboard.writeText`. Resolves "copied" on
 * success; resolves "fallback" — never throws — when `clipboard` is
 * missing or the write itself fails (permission denied, insecure context,
 * older browser).
 */
export async function copyShareText(
  text: string,
  clipboard: ClipboardLike | undefined | null,
): Promise<"copied" | "fallback"> {
  if (!clipboard?.writeText) return "fallback";
  try {
    await clipboard.writeText(text);
    return "copied";
  } catch {
    return "fallback";
  }
}

export function ShareResult({
  text,
  label = "Share result",
}: {
  text: string;
  label?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "fallback">("idle");

  async function handleClick() {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    setState(await copyShareText(text, clipboard));
  }

  if (state === "fallback") {
    return (
      <div className="flex flex-col items-center gap-2">
        <textarea
          readOnly
          value={text}
          aria-label={label}
          className="w-full max-w-xs resize-none rounded-lg border border-slate-300 p-2 text-xs text-slate-700"
          onFocus={(e) => e.currentTarget.select()}
        />
        <span className="text-xs text-slate-500">Select the text above to copy it</span>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className="rounded-full bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
    >
      {state === "copied" ? "Copied" : label}
    </button>
  );
}
