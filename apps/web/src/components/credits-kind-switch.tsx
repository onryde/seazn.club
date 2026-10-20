import Link from "next/link";
import { t, type Dict } from "@/lib/i18n";
import { routes } from "@/lib/routes";

export type CreditsKind = "ai" | "stream";

/** `?kind=` → the side of the Credits tab to show. Anything but `stream` is the default side (AI), so every link made
 *  before the tab had two sides — and any URL with an unknown or repeated value — still lands where it always did. */
export function creditsKindOf(raw: string | string[] | undefined): CreditsKind {
  return raw === "stream" ? "stream" : "ai";
}

/**
 * The AI | Streaming switch at the top of Settings → Credits. Two links, not state: each side is its own URL
 * (`/settings/credits`, `/settings/credits?kind=stream`), so the choice survives a reload, a shared link and the back
 * button, and the server renders only the side that was asked for. The current side is `aria-current`. Each target is
 * 44px tall, with the two sharing one row down to 320.
 */
export function CreditsKindSwitch({ orgSlug, active, dict }: { orgSlug: string; active: CreditsKind; dict: Dict }) {
  const items: { kind: CreditsKind; href: string; label: string }[] = [
    { kind: "ai", href: routes.credits(orgSlug), label: t(dict, "settings.credits.kind.ai") },
    { kind: "stream", href: routes.creditsStream(orgSlug), label: t(dict, "settings.credits.kind.stream") },
  ];
  return (
    <nav
      aria-label={t(dict, "settings.credits.kind.label")}
      data-testid="credits-kind-switch"
      className="mb-6 inline-flex rounded-xl border border-purple-100 bg-purple-50/40 p-1"
    >
      {items.map((item) => {
        const current = item.kind === active;
        return (
          <Link
            key={item.kind}
            href={item.href}
            aria-current={current ? "page" : undefined}
            data-testid={`credits-kind-${item.kind}`}
            className={`inline-flex min-h-11 min-w-24 items-center justify-center rounded-lg px-4 text-sm font-medium ${
              current ? "bg-purple-600 text-white" : "text-slate-600 hover:bg-purple-100"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
