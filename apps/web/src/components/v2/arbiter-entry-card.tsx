// The Fixtures tab's one card for the Arbiter Panel (spec 2026-10-24-arbiter-round-column-design.md §8, controller ruling 1,
// option C). The round is opened and watched in the panel now, so this tab keeps a single card: the link into the panel and ONE
// sentence that answers "do I need to go there now?". Which sentence is `entryLine`'s decision (lib/round-column.ts, the same
// pure module the column reads); this component only says it. A server component: the page hands it the dictionary it already
// loaded, like every other line it prints.
//
// House theme, no new element: the card the page drew before, with its fixed body swapped for the status line. A board that
// needs a decision is the only red line (the column queue's own #b42318), so it reads at a glance without the card growing.
import Link from "@/components/ui/console-link";
import type { Dict, Locale } from "@/lib/i18n-constants";
import { plural, t } from "@/lib/i18n-runtime";
import type { EntryLine } from "@/lib/round-column";

function lineText(line: EntryLine, dict: Dict, locale: Locale): string {
  switch (line.kind) {
    case "default":
      return t(dict, "arbiter.entry.body");
    case "attention":
      // The column's own title: the same words and the same plural pair, so the tab and the panel never disagree.
      return plural(dict, "arbiter.column.queue", line.count, locale);
    case "checkin":
      return t(dict, "arbiter.entry.status.checkin", { round: line.roundNo });
    case "ready":
      return t(dict, "arbiter.entry.status.ready", { round: line.roundNo });
  }
}

export function ArbiterEntryCard({ href, line, dict, locale }: { href: string; line: EntryLine; dict: Dict; locale: Locale }) {
  return (
    <div
      data-testid="arbiter-entry"
      className="mb-4 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-[#e7e3f3] bg-white px-4 py-2"
    >
      <Link href={href} className="min-h-11 content-center text-sm font-semibold text-[#5b21b6]">
        {t(dict, "arbiter.entry.link")}
      </Link>
      <span
        data-testid="arbiter-entry-status"
        data-kind={line.kind}
        className={line.kind === "attention" ? "min-w-0 text-sm font-medium text-[#b42318]" : "min-w-0 text-sm text-slate-600"}
      >
        {lineText(line, dict, locale)}
      </span>
    </div>
  );
}
