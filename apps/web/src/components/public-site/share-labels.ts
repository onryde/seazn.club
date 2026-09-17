// The five words `ShareBar` says, resolved from a public page's own `public`
// dictionary. ONE mapping, so the competition page and the news post cannot
// disagree about which key feeds which slot.
//
// Pure, no `"use client"`: a server page calls it and hands the result across
// the client boundary as a plain object.
import type { ShareBarLabels } from "@/components/share-bar";
import type { Dict } from "@/lib/i18n-constants";
import { t } from "@/lib/i18n-runtime";

/**
 * The WhatsApp link's accessible name. The default names no subject ("Share on
 * WhatsApp") and fits any page; a page that IS a competition passes
 * `"share.whatsappAria"` ("Share this competition on WhatsApp"). A news post
 * saying "this competition" to a screen reader would be wrong.
 */
export type WhatsappAriaKey = "share.whatsapp" | "share.whatsappAria";

export function shareLabels(
  dict: Dict,
  whatsappAria: WhatsappAriaKey = "share.whatsapp",
): ShareBarLabels {
  return {
    share: t(dict, "share.share"),
    // The SHORT label is the visible text and the full sentence is the
    // accessible name: three full-sentence buttons wrap onto two rows in a
    // 320px hero (competition page, Task 12). The verb is not lost — it is in
    // `whatsappAria`, which is what a screen reader announces.
    //
    // `share.whatsapp` itself stays the long sentence: it must read the same
    // as ui.json's copy (`hub-dictionary.test.ts`), where it is the console
    // share button's accessible name.
    whatsapp: t(dict, "share.whatsappShort"),
    whatsappAria: t(dict, whatsappAria),
    copy: t(dict, "share.copy"),
    copied: t(dict, "share.copied"),
  };
}
