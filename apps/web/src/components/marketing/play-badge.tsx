// The "Get it on Google Play" badge for the Seazn Club Mobile App (spec 2026-11-25 §4). The art is Google's own, one
// file per locale in public/badges, served as shipped: never cropped, redrawn or run through the image optimiser.
import Image from "next/image";
import { PLAY_STORE_URL } from "@/lib/app-store";
import { getDictionary, t } from "@/lib/i18n";
import { toLocale, type Locale } from "@/lib/i18n-constants";

// All four files are a 646x250 canvas, but the badge does not fill it alike: the English one sits inside its own
// transparent margin, the other three run to the canvas's sides. `ART_HEIGHT` is the badge's own height in each file,
// so each file is drawn at the width that makes the badge people SEE one size. play-badge.test.tsx measures the files.
const CANVAS = { width: 646, height: 250 };
const ART_HEIGHT: Record<Locale, number> = { en: 168, es: 192, fr: 192, nl: 192 };
/** Height of the visible badge, in CSS pixels. Google's floor on screen is 40. */
const BADGE_HEIGHT = { sm: 40, md: 48 } as const;

const canvasAt = (lang: Locale, badgeHeight: number) => {
  const scale = badgeHeight / ART_HEIGHT[lang];
  return { width: Math.round(CANVAS.width * scale), height: Math.round(CANVAS.height * scale) };
};

// The link's own box, one for all four locales: the widest badge (es/fr/nl, whose art spans the canvas) with Google's
// clear space, a quarter of the badge's height, on every side. It keeps its room when the image does not load.
const boxAt = (badgeHeight: number) => ({
  width: Math.ceil(badgeHeight * (CANVAS.width / ART_HEIGHT.fr + 0.5)),
  height: badgeHeight * 1.5,
});

/** The badge art for `lang`; English for any locale the site does not have. */
export function playBadgeSrc(lang: string): string {
  return `/badges/google-play-${toLocale(lang)}.png`;
}

export async function PlayBadge({ lang, size = "md" }: { lang: string; size?: keyof typeof BADGE_HEIGHT }) {
  const locale = toLocale(lang);
  const d = await getDictionary(locale, "marketing");
  const art = canvasAt(locale, BADGE_HEIGHT[size]);
  return (
    <a
      href={PLAY_STORE_URL}
      data-testid="play-badge"
      style={boxAt(BADGE_HEIGHT[size])}
      className="inline-flex max-w-full shrink-0 items-center justify-center rounded-lg focus-visible:outline-2 focus-visible:outline-[var(--mk-lime)]"
    >
      <Image
        src={playBadgeSrc(locale)}
        alt={t(d, "app.playBadge.alt")}
        width={art.width}
        height={art.height}
        unoptimized
        // Only seen while the image is missing: the alt text, readable on the night ground.
        className="text-xs text-[var(--mk-cream)]"
      />
    </a>
  );
}
