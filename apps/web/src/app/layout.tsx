import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { barlowCondensed } from "@/lib/fonts";
import { siteOrigin } from "@/lib/site-origin";
import { AnalyticsBootstrap } from "@/components/analytics-bootstrap";
import { CookieConsent } from "@/components/cookie-consent";
import { ConfirmProvider } from "@/components/ui/confirm-provider";
import { HtmlLang } from "@/components/i18n/html-lang";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Seazn Club — Tournament Management",
    template: "%s — Seazn Club",
  },
  description:
    "Run fair, fun, multi-sport tournaments for your club. Chess, carrom, cricket and more.",
  metadataBase: new URL(siteOrigin()),
  icons: {
    icon: [
      { url: "/icons/icon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/icons/icon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon-48.png", sizes: "48x48", type: "image/png" },
      { url: "/favicon.ico", sizes: "any" },
    ],
    apple: [
      { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
    other: [
      { rel: "mask-icon", url: "/icons/icon-512.png" },
    ],
  },
  manifest: "/site.webmanifest",
  openGraph: {
    type: "website",
    siteName: "Seazn Club",
    // og:image comes from the root opengraph-image.tsx file convention —
    // per-segment cards (the /shared tree) override it automatically.
  },
  twitter: {
    card: "summary_large_image",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // Server-rendered as "en" because this layout is deliberately static —
    // reading the locale here needs cookies()/headers() and would opt the whole
    // app into dynamic rendering (resolve-locale.ts:17-18). <HtmlLang> below
    // corrects it after hydration; trees that already know their locale
    // server-side pass it down explicitly.
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${barlowCondensed.variable} h-full antialiased`}
    >
      <body className="min-h-full font-sans">
        {/* A screen reader was pronouncing French, Spanish and Dutch copy with
            English rules on every tree outside [lang]/(marketing), which was
            the only place mounting this. Cookie-driven here; authoritative
            where a layout passes `lang`. */}
        <HtmlLang />
        {/* Confirmation dialogs everywhere (v3/03 §3) — console and public
            trees both have destructive actions. */}
        <ConfirmProvider>{children}</ConfirmProvider>
        {/* Identifies the logged-in user for PostHog; a no-op for anon traffic.
            Client-mounted (task-8): fetches identity from /api/users/me
            instead of reading cookies() here, so this layout's RSC tree stays
            static/ISR-eligible (see analytics-bootstrap.tsx). */}
        <AnalyticsBootstrap />
        {/* Global consent banner — analytics stays opted out until Accept. */}
        <CookieConsent />
      </body>
    </html>
  );
}
