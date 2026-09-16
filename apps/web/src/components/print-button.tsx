"use client";

/** `label` is the caller's resolved copy — this button has no words of its
 *  own, so a public page can print it in the org's language. */
export function PrintButton({ label }: { label: string }) {
  return (
    <button
      onClick={() => window.print()}
      className="btn btn-primary print:hidden"
    >
      🖨 {label}
    </button>
  );
}
