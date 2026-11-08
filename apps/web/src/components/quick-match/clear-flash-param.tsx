"use client";
// A quick match page's refusal lands as `?e=<code>` (pre-flight D3): the home's flash (plan 2 Task 6) and the setup
// page's error (Task 4). The server has already read it into the page by the time this runs, so the parameter is spent:
// left in the URL, a reload, a shared link or a bookmark would print the same refusal again over a page where nothing
// was refused (T6 review m2). After mount, this takes `e` out of the URL, and only `e`: the path, every other parameter
// and the fragment stay as they are.
//
// `replaceState` through the public surface's own writer (`writeSearchParam`, which Next's router follows), never a
// navigation: the page on screen, with its flash, does not change. A URL with no `e` is left alone.
import { useEffect } from "react";
import { writeSearchParam } from "@/components/public-site/use-tab-param";

/** The query parameter a quick match page reads its refusal from. */
export const FLASH_PARAM = "e";

export function ClearFlashParam() {
  useEffect(() => {
    if (!new URL(window.location.href).searchParams.has(FLASH_PARAM)) return;
    writeSearchParam(FLASH_PARAM, null);
  }, []);
  return null;
}
