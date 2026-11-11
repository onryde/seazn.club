"use client";

// The pay link a send, a resend or an online Add deal made (sponsor deals PR 2, Task 17; it was the Packages tab's `invoice-link`
// banner). The sponsor gets it by email as well - this is the club's own copy, to paste into a message. It is shown only while its
// deal can still be paid (`payLinkStillOpen`, components/sponsors/deal-copy.ts): OrgSponsors holds the link with the deal it
// belongs to and passes it down only then, so this component is stateless and never decides that itself.
import { Copy } from "lucide-react";
import { useMsg } from "@/components/i18n/dict-provider";

export function PayLinkBanner({ url }: { url: string }) {
  const msg = useMsg();
  return (
    <div
      data-testid="sponsor-pay-link"
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
    >
      <span className="min-w-0">{msg("sponsors.deal.payLink.sent")}</span>
      <div className="flex min-w-0 max-w-full items-center gap-1">
        <code data-testid="sponsor-pay-link-url" className="min-w-0 max-w-full truncate text-xs">
          {url}
        </code>
        <button
          type="button"
          aria-label={msg("sponsors.deal.payLink.copy")}
          onClick={() => void navigator.clipboard?.writeText(url)}
          className="grid h-6 w-6 shrink-0 place-items-center rounded text-emerald-700 hover:bg-emerald-100 max-md:h-11 max-md:w-11"
        >
          <Copy className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
    </div>
  );
}
