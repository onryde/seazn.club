// "Seazn", the date, and the update date when there is one. Every post is signed with the organisation, never a person
// (owner, 2026-11-19). The mark is a drawn S on the house night, not a photograph.
import { BLOG_AUTHOR } from "@/lib/blog";

export function BlogByline({
  date,
  dateLabel,
  updated,
  updatedLabel,
}: {
  date: string;
  /** "20 November 2026". */
  dateLabel: string;
  updated?: string;
  /** "Updated 3 December 2026", already worded and translated; omitted when the post was never updated. */
  updatedLabel?: string;
}) {
  return (
    <div className="mt-5 flex items-center gap-3" data-testid="blog-byline">
      <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--mk-night,#150b36)] text-base font-extrabold text-white">
        S
      </span>
      <p className="min-w-0 text-sm leading-tight text-slate-500">
        <span className="block font-semibold text-slate-900">{BLOG_AUTHOR}</span>
        <time dateTime={date}>{dateLabel}</time>
        {updated && updatedLabel ? (
          <>
            <span aria-hidden> · </span>
            <time dateTime={updated}>{updatedLabel}</time>
          </>
        ) : null}
      </p>
    </div>
  );
}
