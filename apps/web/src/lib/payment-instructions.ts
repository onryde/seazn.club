// Organiser payment instructions are Markdown with one token: {{reference}}
// becomes the registrant's generated ref code wherever the instructions are
// shown — so "quote {{reference}} on your bank transfer" personalises itself.
// Public pages render the Markdown through lib/prose; the email panels are
// plain-text, so they get a readable stripped version instead.

/** Substitute the {{reference}} token. Before a reference exists (the public
 *  registration form) it degrades to a generic phrase. */
export function fillPaymentInstructions(
  instructions: string,
  reference?: string | null,
): string {
  return instructions.replaceAll("{{reference}}", reference ?? "your registration reference");
}

/** Hard-code every single line break as a CommonMark hard break (trailing
 *  double-space) so lib/prose renders it as `<br>` instead of collapsing it
 *  to a space — Markdown treats one `\n` as insignificant whitespace and
 *  only a BLANK line starts a new paragraph, so an organiser's bank details
 *  ("Bank: X\nAccount name: Y") otherwise run together into one paragraph.
 *  A real paragraph break (a blank line) is left alone. HTML-render path
 *  only: paymentInstructionsText's plain-text panels already show `\n` as a
 *  real line break, so they never call this (and must not — the trailing
 *  spaces this adds would leak as literal characters into plain text). */
export function preserveLineBreaks(markdown: string): string {
  return markdown
    .split(/\n{2,}/)
    .map((block) => block.replace(/\n/g, "  \n"))
    .join("\n\n");
}

/** Markdown → readable plain text for the email panels: links become
 *  "label: url", emphasis/heading/quote markers drop, structure survives. */
export function paymentInstructionsText(instructions: string): string {
  return instructions
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1: $2")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(\*|_)(?=\S)([^*_\n]*\S)\1/g, "$2")
    .replace(/^>\s?/gm, "")
    .trim();
}
