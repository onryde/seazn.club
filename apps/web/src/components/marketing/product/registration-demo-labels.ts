import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";

/** The Registration demo island's copy (`product.registration.demo.*`), built on the server. */
const L = [
  "phone.label", "phone.event", "phone.club", "phone.name", "phone.fee", "phone.spots", "phone.full",
  "phone.pay", "phone.leave", "phone.join", "phone.done",
  "list.label", "status.paid", "status.held", "status.waitlisted", "status.refunded",
  "act.pay", "act.withdraw",
  "money.label", "money.collected", "money.taken", "money.toPay", "money.waiting",
  "event.none", "event.paid", "event.held", "event.waitlisted", "event.refunded", "event.promoted",
  "reset",
] as const;
export type RegistrationDemoLabels = Record<(typeof L)[number], string>;
export const REGISTRATION_DEMO_LABEL_KEYS: readonly string[] = L;

export function registrationDemoLabels(dict: Dict): RegistrationDemoLabels {
  return Object.fromEntries(L.map((k) => [k, t(dict, `product.registration.demo.${k}` as never)])) as RegistrationDemoLabels;
}
