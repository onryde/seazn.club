// The sponsor's invoice as a PDF, GET /r/sponsor/invoice/[token]/pdf (sponsor deals, Task 22; spec §7): what the invoice page's
// "Download PDF" opens. The page's contract (../page.tsx): `publicRateLimit` BEFORE the lookup, one opaque 404 for every token
// that opens nothing, never cached, no referrer, and the token is never logged. The answers that are not a PDF are short plain
// text in the reader's language.
export const dynamic = "force-dynamic";

import { HttpError } from "@/lib/errors";
import { getDictionary, t } from "@/lib/i18n";
import { resolveLocale } from "@/lib/resolve-locale";
import { INVOICE_PRIVATE_HEADERS as PRIVATE_HEADERS, invoiceFileName } from "@/lib/sponsor-invoice";
import { invoiceDocByToken } from "@/server/sponsors/invoice-doc";
import { invoicePdf } from "@/server/sponsors/invoice-pdf";
import { publicRateLimit } from "@/server/usecases/public";

type Ctx = { params: Promise<{ token: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const { token } = await params;
  try {
    await publicRateLimit(req);
  } catch (err) {
    if (err instanceof HttpError && err.status === 429) return plain(429, "sponsors.invoice.throttled.body");
    throw err;
  }
  const doc = await invoiceDocByToken(token);
  if (doc === null) return plain(404, "sponsors.invoice.notFound.body");
  const bytes = await invoicePdf(doc);
  return new Response(new Uint8Array(bytes), {
    headers: {
      ...PRIVATE_HEADERS,
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${invoiceFileName(doc.number)}"`,
    },
  });
}

async function plain(status: number, key: "sponsors.invoice.throttled.body" | "sponsors.invoice.notFound.body"): Promise<Response> {
  const ui = await getDictionary(await resolveLocale(), "ui");
  return new Response(t(ui, key), { status, headers: { ...PRIVATE_HEADERS, "Content-Type": "text/plain; charset=utf-8" } });
}
