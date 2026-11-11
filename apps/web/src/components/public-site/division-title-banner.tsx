// W4 B2a (X-CH-1, X-CH-3; R24 pick 3A) — the banner at the top of the division page for what the division's deciding
// stage crowned. Three shapes and no more: ONE champion, JOINT winners ("Joint winners: X and Y" under one trophy), or
// a VACANT title (a muted line, no trophy, no names). Pure and server-safe: the page hands it the title and a name
// lookup; it reads no data of its own.
//
// Gold is fixed podium vocabulary, deliberately outside the org theme. Names WRAP for a joint pair (two names do not
// fit one truncated line at 320px, and an ellipsis over a winner is the wrong answer); a single champion truncates as
// it always has.
import type { DivisionTitle } from "@/server/public-site/champion";
import { t } from "@/lib/i18n";
import type { Dict } from "@/lib/i18n-constants";

export function DivisionTitleBanner({
  title,
  nameOf,
  dict,
}: {
  title: DivisionTitle | null;
  nameOf: (entrantId: string) => string;
  dict: Dict;
}) {
  if (title === null) return null;
  if (title.kind === "vacant") {
    return (
      <div
        data-testid="division-title-vacant"
        className="relative mb-6 overflow-hidden rounded-xl bg-court p-4 text-court-muted shadow-md"
      >
        <div className="min-w-0 pl-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em]">{t(dict, "title.vacant")}</p>
          <p className="text-sm">{t(dict, "title.vacantReason")}</p>
        </div>
      </div>
    );
  }
  return (
    <div
      data-testid={title.kind === "joint" ? "division-title-joint" : "division-title-champion"}
      className="relative mb-6 overflow-hidden rounded-xl bg-court p-4 text-court-ink shadow-md"
    >
      <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-amber-400" />
      <div className="flex items-center gap-4 pl-2">
        <span className="animate-trophy text-4xl" aria-hidden>🏆</span>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-amber-300">
            {t(dict, title.kind === "joint" ? "title.joint" : "table.champion")}
          </p>
          {title.kind === "joint" ? (
            <p className="break-words font-display text-3xl font-bold uppercase leading-tight tracking-tight max-md:text-2xl">
              {t(dict, "title.jointNames", { a: nameOf(title.winners[0]), b: nameOf(title.winners[1]) })}
            </p>
          ) : (
            <p className="truncate font-display text-3xl font-bold uppercase leading-tight tracking-tight">
              {nameOf(title.champion)}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
