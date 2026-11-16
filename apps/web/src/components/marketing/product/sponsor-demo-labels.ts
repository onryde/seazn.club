import { t } from "@/lib/i18n-runtime";
import type { Dict } from "@/lib/i18n-constants";

/**
 * The Sponsoring demo island's copy (`product.sponsor.demo.*`), built on the server. Tier, payment method, go-live
 * rule, status and step each have one label per key the product itself declares; the page test walks those lists, so
 * a key the product adds later fails there instead of printing itself on the page.
 */
const L = [
  "setup.label", "setup.tier", "setup.method", "setup.rule", "setup.reset",
  "tier.title", "tier.gold", "tier.silver", "tier.partner",
  "method.online", "method.offline", "method.complimentary",
  "rule.on_payment", "rule.immediate", "rule.on_approval",
  "step.send_invoice", "step.pay.online", "step.pay.offline", "step.approve", "step.end",
  "done.send_invoice", "done.pay", "done.approve", "done.end", "done.created",
  "deal.label", "deal.heading",
  "status.draft", "status.awaiting_payment", "status.awaiting_approval", "status.scheduled", "status.live", "status.ended",
  "money.due", "money.paid", "money.free",
  "page.label", "page.comp", "page.presented", "page.board", "page.partners", "page.none",
  "stream.label", "stream.channel", "stream.turns", "stream.none",
] as const;
export type SponsorDemoLabels = Record<(typeof L)[number], string>;

export function sponsorDemoLabels(dict: Dict): SponsorDemoLabels {
  return Object.fromEntries(L.map((k) => [k, t(dict, `product.sponsor.demo.${k}` as never)])) as SponsorDemoLabels;
}
