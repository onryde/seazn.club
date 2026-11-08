// "Your recent quick matches" (spec docs/superpowers/specs/2026-11-03-quick-match-design.md §5 step 5): a stub until
// plan 2 Task 9 fills it (D11: name and created date, up to 5, newest first; A9: fail soft).
//
// It takes its rows as props: eslint.config.mjs refuses a value import of @/server/** anywhere in
// src/components/quick-match/** (plan 2 pre-flight, T4), so the visitor's rows are read by the PAGE that mounts the strip
// (`listRecentQuickMatches` in quick-match-home.ts, A10) and handed down. Each row will paint a home token, so Task 9 also
// owes `ph-no-capture` on its links and a verdict in scrub-secret-painters.test.ts (T5's painter-file assertion).
import type { ReactNode } from "react";

/** One row, as A10's `listRecentQuickMatches` returns it. */
export interface RecentQuickMatch {
  token: string;
  name: string;
  createdAt: string;
}

export interface RecentStripProps {
  title: string;
  items: readonly RecentQuickMatch[];
}

export function RecentStrip({ items }: RecentStripProps): ReactNode {
  if (items.length === 0) return null;
  // Rows are Task 9's: a caller that hands some over before it lands would have them silently dropped. Refuse instead.
  throw new Error("RecentStrip renders no rows until plan 2 Task 9: pass items={[]}");
}
