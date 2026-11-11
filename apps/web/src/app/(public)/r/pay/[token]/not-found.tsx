// The ONE answer for a payment-page token that opens nothing - unknown, malformed, withdrawn or rejected (player payment page,
// Task 4). It takes no props and reads no token, so the body cannot differ between those cases. Its own head: on notFound() Next
// reads this module's metadata, not the page's.
import type { Metadata } from "next";
import { getDictionary, t } from "@/lib/i18n";
import { resolveLocale } from "@/lib/resolve-locale";
import { PayPageNotice } from "@/components/registrations/pay-page-view";

export async function generateMetadata(): Promise<Metadata> {
  const ui = await getDictionary(await resolveLocale(), "ui");
  return {
    title: t(ui, "regPay.notFound.title"),
    description: t(ui, "regPay.notFound.body"),
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}

export default async function PayPageNotFound() {
  const ui = await getDictionary(await resolveLocale(), "ui");
  return <PayPageNotice testId="pay-not-found" title={t(ui, "regPay.notFound.title")} body={t(ui, "regPay.notFound.body")} />;
}
