import Link from "next/link";
import { t, type Dict } from "@/lib/i18n";
import { routes } from "@/lib/routes";

export type CreditsKind = "ai" | "stream";

/** `?kind=` → the side of the Credits tab to show. Only `ai`, exactly, is the AI side; anything else is the default side
 *  (Streaming, owner 2026-11-11) — the bare URL, `?kind=stream` (what every link made while AI was the default carries),
 *  and any unknown or repeated value. */
export function creditsKindOf(raw: string | string[] | undefined): CreditsKind {
  return raw === "ai" ? "ai" : "stream";
}

/**
 * The Streaming | AI switch at the top of Settings → Credits. Two links, not state: each side is its own URL
 * (`/settings/credits`, `/settings/credits?kind=ai`), so the choice survives a reload, a shared link and the back button,
 * and the server renders only the side that was asked for. Streaming comes first: it is the default side. The current
 * side is `aria-current`. Each target is 44px tall, with the two sharing one row down to 320.
 */
export function CreditsKindSwitch({ orgSlug, active, dict }: { orgSlug: string; active: CreditsKind; dict: Dict }) {
  const items: { kind: CreditsKind; href: string; label: string }[] = [
    { kind: "stream", href: routes.credits(orgSlug), label: t(dict, "settings.credits.kind.stream") },
    { kind: "ai", href: routes.creditsAi(orgSlug), label: t(dict, "settings.credits.kind.ai") },
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
