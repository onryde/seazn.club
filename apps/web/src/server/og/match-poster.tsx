import "server-only";
// The match poster (Spectator Surface Boards §poster, "Option A — owner pick"):
// crest tiles in TEAM COLOURS on the competition's court colour, real badges
// dropping into the tiles when uploaded. One satori layout feeds both the
// fixture's OG card (1200×630, what unfurls in a chat) and the downloadable
// 1080×1350 poster — the board draws `Poster` and `Share` as two buttons in
// the same row, so the two images are one design in two shapes.
//
// The board draws an UPCOMING and a RESULT variant. Reading them side by side,
// they are one skeleton with two of its slots swapped, so this builds the
// skeleton once and fills it three ways — the third being LIVE, which the
// board does not draw and which is the state a spectator shares most:
//
//   slot     upcoming                 live                      result
//   chip     division · round         ● LIVE · 12.3 OV          RESULT · division · round
//   hero     the stage               "Queens need 34 from 21"  "Blue Blazers won by 12 runs"
//   tiles    short + name             + score, batting lit      + score, loser dimmed
//   foot     when · where             CRR 8.44 · RRR 9.71       top batter + top bowler
//
// The PURE model decides variant, paint and which slots fill, so all of that
// unit-tests without rendering a pixel (mirrors ./model.ts and ./post-card.tsx).
// ImageResponse supports flexbox only — every div declares display:flex.
import { ogTheme, type OgTheme } from "./model";
import { OG_SIZE } from "./card";
// Bytes only, never a URL — the one rule shared by every satori frame here.
import { drawableImage } from "./drawable";
import { readBrandFontFile } from "@/server/doc-theme";
import { monogramInk, autoColour } from "@/components/ui/entity-logo";
import type { MatchCentreDocT, SideT } from "@/server/public-site/match-centre-schema";

/**
 * `--mk-lime` (globals.css:498), and the rule that comes with it, verbatim from
 * the "floodlit console" block above it: *"Lime discipline: hairline, LIVE
 * signals, eyebrow ticks, focus-on-night — never lime text on light."*
 *
 * A share image is a night surface, so both permitted uses apply here and no
 * third one is invented: the floodlight HAIRLINE that closes the app's own
 * gantry runs along the top of the card, and LIVE is signalled in lime.
 *
 * Lime is a STATUS colour, never an identity one, which is why it does not
 * come from `theme` — a Pro org's own accent paints the slab and its crests,
 * and "this match is on right now" has to mean the same thing on every club's
 * poster. A club that picked lime still gets lime crests; its live chip is the
 * same lime as everyone's, and that is correct.
 */
const LIME = "#a3e635";

export const POSTER_SIZE = { width: 1080, height: 1350 };
export { OG_SIZE };

// ─── fonts ──────────────────────────────────────────────────────────────────
//
// Every existing `ImageResponse` call site on this branch passed NO `fonts:`
// option, which meant satori fell back to its single built-in face — so a
// declared `fontWeight: 800` never actually rendered bold. The static TTFs
// pinned at `apps/web/assets/fonts` (same directory `doc-theme.ts` reads for
// `poster.pdf`, `DOC_FONT_DIR`-overridable there) are this card's real
// display and body faces: Barlow Condensed for headings/figures, Geist for
// the small print. Satori takes no woff2 and no variable font, only static
// TTF/OTF bytes handed through the `fonts:` array on `ImageResponse` — this
// module only loads and exposes them; the two route call sites (`poster.png`
// and the fixture `opengraph-image.tsx`) pass the result through.
export const POSTER_FONT_HEADING = "Barlow Condensed";
export const POSTER_FONT_BODY = "Geist";

export interface PosterFont {
  name: string;
  data: Buffer;
  weight: 400 | 600 | 700;
  style: "normal";
}

const FONT_FILES: ReadonlyArray<{ name: string; file: string; weight: 400 | 600 | 700 }> = [
  { name: POSTER_FONT_HEADING, file: "BarlowCondensed-Bold.ttf", weight: 700 },
  { name: POSTER_FONT_HEADING, file: "BarlowCondensed-SemiBold.ttf", weight: 600 },
  { name: POSTER_FONT_BODY, file: "Geist-Bold.ttf", weight: 700 },
  { name: POSTER_FONT_BODY, file: "Geist-Regular.ttf", weight: 400 },
];

// Same reader as the PDFs (`readBrandFontFile` / `DOC_FONT_DIR` / cwd rule),
// so the two cannot drift apart again (both once defaulted to
// `<cwd>/apps/web/assets/fonts`, which production's cwd — /app/apps/web —
// never has). Sync read is fine: fonts are small and cached once per process.
let cached: Promise<PosterFont[]> | null = null;

/** The `fonts:` array for an `ImageResponse`'s options (its `fonts` key). Read once per
 *  server lifetime — module-level `Promise` cache, not a value cache, so
 *  concurrent first callers share one disk read instead of racing several.
 *
 *  A font that fails to read is DROPPED, not thrown — same principle as
 *  `doc-theme.ts`'s `registerFonts` aliasing a missing TTF to a built-in
 *  face: a wrong `DOC_FONT_DIR`/cwd should degrade the card's typography,
 *  never turn a public image route into a 500. */
export function posterFonts(): Promise<PosterFont[]> {
  if (cached === null) {
    cached = Promise.resolve(
      FONT_FILES.map((f) => {
        const data = readBrandFontFile(f.file);
        return data
          ? ({ name: f.name, data, weight: f.weight, style: "normal" } satisfies PosterFont)
          : null;
      }).filter((f): f is PosterFont => f !== null),
    );
  }
  return cached;
}

/** Build the second argument for an `ImageResponse` call: `ImageResponse(tree, await posterImageInit(size))`. The `fonts:` key is
 *  left OFF entirely when nothing loaded, rather than sent as `fonts: []`:
 *  `next/og` treats an explicit empty array as "no font is available" and
 *  throws ("At least one font is required to calculate the layout."),
 *  which is a worse failure than the satori default this app rendered with
 *  before this module existed. Dropping the key restores exactly that
 *  fallback instead of turning a font-loading failure into a 500. */
export async function posterImageInit<T extends { width: number; height: number }>(
  size: T,
): Promise<T & { fonts?: PosterFont[] }> {
  const fonts = await posterFonts();
  return fonts.length > 0 ? { ...size, fonts } : { ...size };
}

export type MatchPosterVariant = "upcoming" | "live" | "result";

export interface MatchPosterSide {
  short: string;
  name: string;
  /** Tile paint — the side's own colour, else one derived from its name. */
  bg: string;
  ink: string;
  /** The badge as a `data:` URI — bytes this app fetched itself — or null for
   *  the monogram tile. Never a URL: see `drawableImage` in ./drawable. */
  badgeUrl: string | null;
  score: string | null;
  sub: string | null;
  /** The side that is not batting / did not win, held back a little. */
  dim: boolean;
}

export interface MatchPosterPerformer {
  role: string;
  name: string;
  line: string;
  detail: string | null;
}

export interface MatchPosterModel {
  theme: OgTheme;
  variant: MatchPosterVariant;
  orgName: string;
  /** The org logo as a `data:` URI, or null for the initials tile. */
  logo: string | null;
  competitionName: string;
  chip: string;
  chipLive: boolean;
  hero: string | null;
  sides: [MatchPosterSide, MatchPosterSide];
  footNote: string | null;
  performers: MatchPosterPerformer[];
  poweredBy: string;
  vs: string;
}

export interface MatchPosterInput {
  branding: unknown[];
  orgName: string;
  /**
   * The org logo ALREADY RESOLVED to bytes by `posterImageDataUrl`, or null.
   * Not `org.logo`: that is a URL, and satori would fetch it (see
   * `drawableImage`). A URL handed here is dropped, not drawn.
   */
  logo: string | null;
  /**
   * Each side's badge, in header order, resolved the same way. Separate from
   * `header.sides[i].badgeUrl` on purpose — the header's value is the
   * organiser-typed URL, this is what came back from fetching it, and keeping
   * them apart is what makes "the model never holds a URL" checkable.
   */
  badges: [string | null, string | null];
  competitionName: string;
  divisionName: string;
  /** The stage's own name ("League", "Quarter-final") — the board's hero line
   *  on an upcoming poster. Null when the fixture belongs to no named stage. */
  stageName: string | null;
  header: MatchCentreDocT["header"];
  /**
   * Which side is DOING something right now — batting, or serving. Resolved by
   * the caller, because the answer comes from a different place per sport and
   * only one of them is on the header: cricket's is `battingIndex`, a racket
   * sport's is `serving` in the kernel summary, and a period sport has no such
   * idea at all (nothing tracks possession), which is `null`.
   *
   * Was `header.battingIndex` read directly, which meant a live TENNIS poster
   * held back neither player — the one field it asked was cricket's.
   */
  activeIndex: 0 | 1 | null;
  /**
   * "6–4 3–6 · 2–1" — the set-by-set score, already composed by the caller from
   * the Sets tab's own view, or null.
   *
   * SETS ONLY, never periods. A set score is self-describing notation that
   * needs no header; "1–0 · 1–1" for a football match is not — unlabelled, it
   * could be halves, could be anything, and the poster has no room to label it.
   */
  setLine: string | null;
  /** Cricket's own top performers, already selected by the match-centre
   *  builder. Null for every sport that has none — the foot then stays the
   *  live rate line or the kick-off line, never an empty pair of boxes. */
  topPerformers: NonNullable<MatchCentreDocT["cricket"]>["topPerformers"] | null;
  /** Copy, resolved by the route in the org's locale. `statusLine` is the
   *  header's own Msg already through `t()`; the rest are dictionary reads. */
  copy: {
    statusLine: string | null;
    pillNote: string | null;
    live: string;
    result: string;
    vs: string;
    topBatter: string;
    topBowler: string;
    poweredBy: string;
  };
}

/** The board's tile: the side's declared colour, else the name-derived one.
 *  Same chain as the court card and the Sets/Periods table — a club that chose
 *  navy gets navy, and an INDIVIDUAL, who can never have a club, still gets a
 *  tile rather than a grey slab that identifies nothing. */
function paintOf(side: SideT): { bg: string; ink: string } {
  const chosen = monogramInk(side.colour);
  if (chosen) return chosen;
  // `autoColour` always yields a hex `monogramInk` accepts, so this cannot be
  // null — asserted rather than defaulted, so a change to either function
  // surfaces here instead of silently painting every tile one colour.
  const derived = monogramInk(autoColour(side.name));
  return derived ?? { bg: "#ffffff", ink: "#1d1928" };
}

/**
 * The two tiles resolved TOGETHER, because a collision can only be seen — and
 * broken — by looking at both at once. Same reason `disambiguatedShorts`
 * resolves the two short codes as a pair in `match-centre-load.ts`.
 *
 * Found by rendering, not by reading: a real fixture came back with Northfield
 * CC and Riverside FC on IDENTICAL tiles, because `autoColour`'s palette has
 * sixteen entries and two derived names collide about one pair in sixteen. On
 * a card that is otherwise fine that is a blemish; on a poster whose entire
 * idea is "two crests in two colours" it is the picture failing.
 *
 * Only DERIVED paint is stepped, and only the away side. A colour an organiser
 * chose is an identity and is never moved — if a club really did pick the same
 * navy as its opponent, that is the fixture, not a bug to correct. The step
 * re-derives from a salted name rather than reaching into `AUTO_PALETTE`, so
 * this owns no copy of that shared literal and cannot drift from it; bounded,
 * because the salt could in principle collide too.
 */
function paintPair(home: SideT, away: SideT): [{ bg: string; ink: string }, { bg: string; ink: string }] {
  const h = paintOf(home);
  let a = paintOf(away);
  const bothDerived = monogramInk(home.colour) === null && monogramInk(away.colour) === null;
  for (let n = 2; bothDerived && n <= 6 && a.bg === h.bg; n++) {
    a = monogramInk(autoColour(`${away.name}#${n}`)) ?? a;
  }
  return [h, a];
}

export function matchPosterModel(input: MatchPosterInput): MatchPosterModel {
  const { header, copy } = input;
  const variant: MatchPosterVariant =
    header.status === "in_play" ? "live" : header.status === "decided" ? "result" : "upcoming";

  // Which side to hold back. Live: whoever is not batting. Result: whoever the
  // score says did not win — and ONLY when the two scores actually differ, so a
  // tie dims neither. Upcoming: neither, nobody has done anything yet.
  const dimIndex = ((): 0 | 1 | null => {
    if (variant === "live") return input.activeIndex === 0 ? 1 : input.activeIndex === 1 ? 0 : null;
    if (variant !== "result") return null;
    const [h, a] = header.scoreLines;
    if (h === null || a === null || h === a) return null;
    const nh = Number.parseFloat(h);
    const na = Number.parseFloat(a);
    if (!Number.isFinite(nh) || !Number.isFinite(na) || nh === na) return null;
    return nh > na ? 1 : 0;
  })();

  const paints = paintPair(header.sides[0], header.sides[1]);
  const sideAt = (i: 0 | 1): MatchPosterSide => {
    const side = header.sides[i];
    const paint = paints[i];
    return {
      short: side.short,
      name: side.name,
      bg: paint.bg,
      ink: paint.ink,
      badgeUrl: drawableImage(input.badges[i]),
      // An upcoming match has no score to print even if a stale summary left
      // one behind; the board's upcoming tile is the crest and nothing else.
      score: variant === "upcoming" ? null : header.scoreLines[i],
      sub: variant === "upcoming" ? null : header.subLines[i],
      dim: dimIndex === i,
    };
  };

  // "RESULT · Men's T8 · Round 1" / "LIVE · 12.3 OV" / "Men's T8 · Round 1".
  // Joined through filter(Boolean) so a fixture with no division round, or a
  // live sport with no pill note, never renders a stray separator.
  const chip = (
    variant === "result"
      ? [copy.result, input.divisionName, input.stageName]
      : variant === "live"
        ? [copy.live, copy.pillNote]
        : // The stage is the upcoming HERO, so the chip must not say it again:
          // this printed "TOURNAMENT · GROUP STAGE" above a 92px "GROUP STAGE".
          [input.divisionName]
  )
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(" · ");

  // The hero. Live and result both have a sentence the builder already wrote
  // ("Canvey Crusaders need 22 to win", "Blue Blazers won by 12 runs"), and an
  // upcoming match has the board's own answer — the stage.
  //
  // NULL rather than a stand-in when there is no sentence. A first cut fell
  // back to the division name, which printed "MAIN DRAW" in 92px across a live
  // tennis poster as though it were the news; a headline slot with nothing to
  // say is better empty, and the chip and the tiles already carry the match.
  const hero = variant === "upcoming" ? input.stageName : copy.statusLine;

  // The foot. Result: the two performers, which is what the board draws.
  // Live: the rate line, the one fact that only exists while a match is on.
  // Upcoming: the status line ("Starts Sat 14:00"), which is the whole point
  // of sharing a fixture that has not happened yet.
  const performers =
    variant === "result" && input.topPerformers !== null
      ? input.topPerformers
          // A masked minor is DROPPED here, never printed masked (design
          // ramp rule 8 — "a poster is permanent"). The match-centre TAB
          // renders `person.masked`'s placeholder label because that page is
          // the org's own working record; a downloadable, shareable poster
          // has no such licence, and until this filter existed the model
          // took `p.person.name` unconditionally, which meant a masked
          // performer's placeholder ("?" or similar) reached the picture
          // instead of being left off it.
          .filter((p) => !p.person.masked)
          .slice(0, 2)
          .map((p) => ({
            role: p.role === "batter" ? copy.topBatter : copy.topBowler,
            name: p.person.name,
            line: p.line,
            detail: p.detail,
          }))
      : [];
  // Computed independently of `performers` now, because the two SHAPES want
  // different things: the portrait poster has room for the board's two
  // performer boxes, and the 630px landscape card does not (measured: the box
  // is ~100px tall against a budget with ~40 to spare). So the landscape falls
  // back to this line and the portrait prefers the boxes — one model, and the
  // renderer picks per shape rather than the model guessing which it is for.
  //
  // Ordered most-specific-first within each state. `setLine` is why a live
  // tennis poster is no longer blank along the foot: it has no run rate, and
  // the set-by-set score is the fact a spectator actually wants there.
  const footNote =
    variant === "live"
      ? (header.rateLine ?? input.setLine ?? header.metaLine)
      : variant === "upcoming"
        ? (copy.statusLine ?? header.metaLine)
        : (input.setLine ?? header.metaLine);

  return {
    theme: ogTheme(...input.branding),
    variant,
    orgName: input.orgName,
    logo: drawableImage(input.logo),
    competitionName: input.competitionName,
    chip,
    chipLive: variant === "live",
    hero,
    sides: [sideAt(0), sideAt(1)],
    footNote,
    performers,
    poweredBy: copy.poweredBy,
    vs: copy.vs,
  };
}

// ─── the renderer ──────────────────────────────────────────────────────────

/** Every measurement the two shapes disagree on, in one place: the portrait is
 *  the board at 1080×1350, the landscape is the same vocabulary compressed to
 *  1200×630. Deriving the landscape by scaling the portrait was tried and is
 *  wrong — 400px tiles plus a hero plus two performer boxes do not survive a
 *  630px canvas, so the tile shrinks and the performers become one line. */
interface Scale {
  pad: number; logo: number; logoRadius: number; logoFs: number; eyebrowFs: number;
  eyebrowGap: number; chipFs: number; chipPad: string; heroFs: number; heroMax: number;
  tile: number; tileRadius: number; shortFs: number; scoreFs: number; subFs: number;
  pillFs: number; pillPad: string; vsFs: number; colGap: number; rowGap: number;
  footFs: number; perfW: number; perfLabelFs: number; perfNameFs: number;
  perfLineFs: number; perfDetailFs: number; brandFs: number; brandWordFs: number;
  badge: number;
}

const SCALE: Record<"poster" | "og", Scale> = {
  poster: {
    pad: 64, logo: 96, logoRadius: 24, logoFs: 34, eyebrowFs: 32, eyebrowGap: 18,
    chipFs: 26, chipPad: "10px 26px", heroFs: 92, heroMax: 960, tile: 400, tileRadius: 40,
    shortFs: 104, scoreFs: 72, subFs: 30, pillFs: 36, pillPad: "14px 30px", vsFs: 84,
    colGap: 30, rowGap: 40, footFs: 34, perfW: 900, perfLabelFs: 22, perfNameFs: 34,
    perfLineFs: 48, perfDetailFs: 26, brandFs: 26, brandWordFs: 40, badge: 260,
  },
  // The landscape's numbers are a BUDGET, not a taste. 630px has to hold the
  // masthead, the chip, a hero that may wrap to two lines, a 180px tile, a name
  // pill that may wrap to two lines, the foot and the wordmark — and the first
  // cut did not: the live cricket card rendered "CRR 8.53 · RRR 1.31" ON TOP OF
  // "Powered by seazn", clipped by the root's bottom padding. Summed at the
  // two-line worst case these come to ~594 of 630.
  og: {
    pad: 40, logo: 48, logoRadius: 12, logoFs: 20, eyebrowFs: 20, eyebrowGap: 12,
    chipFs: 18, chipPad: "6px 16px", heroFs: 44, heroMax: 1020, tile: 180, tileRadius: 24,
    shortFs: 50, scoreFs: 36, subFs: 16, pillFs: 20, pillPad: "6px 18px", vsFs: 38,
    colGap: 20, rowGap: 14, footFs: 20, perfW: 1020, perfLabelFs: 14, perfNameFs: 22,
    perfLineFs: 30, perfDetailFs: 16, brandFs: 18, brandWordFs: 24, badge: 120,
  },
};

/** Each line inside a tile owns the tile's full width and centres in it, so a
 *  wide figure is centred rather than spilling out of one side. */
const TILE_LINE = {
  display: "flex",
  width: "100%",
  justifyContent: "center",
  lineHeight: 1,
} as const;

function Tile({ side, s }: { side: MatchPosterSide; s: Scale }) {
  const badge = side.badgeUrl;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: s.eyebrowGap, width: s.tile }}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          width: s.tile,
          height: s.tile,
          borderRadius: s.tileRadius,
          background: side.bg,
          color: side.ink,
          opacity: side.dim ? 0.72 : 1,
          // Measured, not assumed: at the first sizes a cricket tile's "48/3"
          // and "(5.1)" rendered OUTSIDE the rounded rect, because satori
          // neither shrinks type to fit nor clips by default — a child wider
          // than its box overflows both edges and keeps painting. The figures
          // are now sized to fit the narrowest real case, and the box clips
          // anyway so an unusually long score can never escape it again.
          overflow: "hidden",
        }}
      >
        {badge !== null ? (
          // eslint-disable-next-line @next/next/no-img-element -- satori
          <img src={badge} alt="" width={s.badge} height={s.badge} style={{ objectFit: "contain" }} />
        ) : (
          <div style={{ ...TILE_LINE, fontSize: s.shortFs, fontWeight: 800 }}>{side.short}</div>
        )}
        {side.score !== null ? (
          <div style={{ ...TILE_LINE, marginTop: 8, fontSize: s.scoreFs, fontWeight: 800 }}>
            {side.score}
          </div>
        ) : null}
        {side.sub !== null ? (
          <div style={{ ...TILE_LINE, marginTop: 4, fontSize: s.subFs, fontWeight: 500, opacity: 0.8 }}>
            {side.sub}
          </div>
        ) : null}
      </div>
      <div
        style={{
          display: "flex",
          maxWidth: s.tile,
          background: "#ffffff",
          color: "#1d1928",
          borderRadius: 999,
          padding: s.pillPad,
          fontSize: s.pillFs,
          fontWeight: 600,
          textAlign: "center",
          lineHeight: 1.05,
        }}
      >
        {side.name}
      </div>
    </div>
  );
}

export function MatchPoster({ model, size }: { model: MatchPosterModel; size: "og" | "poster" }) {
  const s = SCALE[size === "poster" ? "poster" : "og"];
  const { theme } = model;
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
        background: theme.court,
        color: theme.ink,
        fontFamily: POSTER_FONT_HEADING,
        padding: `${s.pad}px ${s.pad}px ${s.pad + s.brandWordFs}px`,
      }}
    >
      {/* The floodlight hairline. The app's gantry is "closed by the sticky lime
          floodlight hairline" (globals.css); the share card is the same night
          surface leaving the building, so it carries the same edge — which is
          also what makes a seazn poster recognisable at thumbnail size, where
          the wordmark at the foot is four pixels tall and reads as nothing. */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: size === "poster" ? 8 : 6,
          display: "flex",
          background: LIME,
        }}
      />

      {/* The board's one piece of atmosphere: a single diagonal accent slab.
          Its dot texture is deliberately not reproduced — satori has no
          `mask-image`, and an unmasked field of dots is a different picture
          from the one that was approved. */}
      <div
        style={{
          position: "absolute",
          left: -200,
          top: size === "poster" ? 180 : 60,
          width: 1500,
          height: size === "poster" ? 420 : 260,
          background: theme.accent,
          opacity: 0.14,
          transform: "rotate(-14deg)",
        }}
      />

      {/* masthead: org badge + competition */}
      <div style={{ display: "flex", alignItems: "center", gap: s.eyebrowGap }}>
        {model.logo !== null ? (
          // eslint-disable-next-line @next/next/no-img-element -- satori
          <img
            src={model.logo}
            alt=""
            width={s.logo}
            height={s.logo}
            style={{ borderRadius: s.logoRadius, background: "#ffffff", objectFit: "contain" }}
          />
        ) : (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: s.logo,
              height: s.logo,
              borderRadius: s.logoRadius,
              background: theme.accent,
              color: "#ffffff",
              fontSize: s.logoFs,
              fontWeight: 700,
            }}
          >
            {model.orgName.slice(0, 3).toUpperCase()}
          </div>
        )}
        <div
          style={{
            display: "flex",
            fontSize: s.eyebrowFs,
            fontWeight: 600,
            letterSpacing: 4,
            textTransform: "uppercase",
            color: theme.muted,
          }}
        >
          {model.competitionName}
        </div>
      </div>

      {/* chip + hero */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 10,
          marginTop: s.rowGap,
        }}
      >
        {model.chip !== "" ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              borderRadius: 999,
              padding: s.chipPad,
              fontSize: s.chipFs,
              fontWeight: 700,
              letterSpacing: 3,
              textTransform: "uppercase",
              background: model.chipLive ? "rgba(163,230,53,0.16)" : "rgba(247,245,251,0.12)",
              border: model.chipLive ? `2px solid ${LIME}` : "2px solid transparent",
              color: model.chipLive ? LIME : theme.ink,
            }}
          >
            {model.chipLive ? (
              <div style={{ display: "flex", width: 12, height: 12, borderRadius: 999, background: LIME }} />
            ) : null}
            {model.chip}
          </div>
        ) : null}
        {model.hero !== null ? (
          <div
            style={{
              display: "flex",
              maxWidth: s.heroMax,
              fontSize: s.heroFs,
              fontWeight: 800,
              lineHeight: 1.02,
              textAlign: "center",
              textTransform: "uppercase",
              color: theme.ink,
            }}
          >
            {model.hero}
          </div>
        ) : null}
      </div>

      {/* tiles */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: s.colGap,
          marginTop: s.rowGap,
        }}
      >
        <Tile side={model.sides[0]} s={s} />
        <div
          style={{
            display: "flex",
            marginTop: s.tile / 2 - s.vsFs / 2,
            fontSize: s.vsFs,
            fontWeight: 800,
            color: theme.muted,
            textTransform: "uppercase",
            lineHeight: 1,
          }}
        >
          {model.vs}
        </div>
        <Tile side={model.sides[1]} s={s} />
      </div>

      {/* The foot. The portrait carries the board's two performer boxes; the
          landscape has no room for them and carries the match's own line
          instead — see `footNote`'s note in the model. */}
      {size === "poster" && model.performers.length > 0 ? (
        <div
          style={{
            display: "flex",
            gap: s.colGap,
            width: s.perfW,
            marginTop: s.rowGap,
          }}
        >
          {model.performers.map((p) => (
            <div
              key={p.role + p.name}
              style={{
                // STACKED, not the board's name-left/figure-right row. With
                // real data that row does not fit: "Arjun Mehta" beside
                // "20 (14)" beside "SR 142.9" rendered straight through the
                // box's own border and over its neighbour's name. The board's
                // figures ("34 (21)") are shorter than the ones the builder
                // actually produces, and the picture has to hold the real
                // ones. `overflow: hidden` is the backstop, not the plan.
                display: "flex",
                flexDirection: "column",
                flexGrow: 1,
                flexBasis: 0,
                overflow: "hidden",
                gap: 2,
                border: "2px solid rgba(247,245,251,0.2)",
                borderRadius: 24,
                padding: "16px 26px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  fontSize: s.perfLabelFs,
                  letterSpacing: 2,
                  textTransform: "uppercase",
                  color: theme.muted,
                }}
              >
                {p.role}
              </div>
              <div style={{ display: "flex", fontSize: s.perfNameFs, fontWeight: 600, lineHeight: 1.15 }}>
                {p.name}
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <div style={{ display: "flex", fontSize: s.perfLineFs, fontWeight: 800, lineHeight: 1.1 }}>
                  {p.line}
                </div>
                {p.detail !== null ? (
                  <div style={{ display: "flex", fontSize: s.perfDetailFs, fontWeight: 500, color: theme.muted }}>
                    {p.detail}
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : model.footNote !== null ? (
        <div
          style={{
            display: "flex",
            marginTop: s.rowGap,
            border: "2px solid rgba(247,245,251,0.35)",
            borderRadius: 999,
            padding: s.pillPad,
            fontSize: s.footFs,
            fontWeight: 500,
            fontFamily: POSTER_FONT_BODY,
            color: theme.ink,
          }}
        >
          {model.footNote}
        </div>
      ) : null}

      {/* the free-tier wordmark the board puts at the foot of both variants */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: Math.round(s.pad * 0.7),
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: s.brandFs,
          fontFamily: POSTER_FONT_BODY,
          color: theme.muted,
        }}
      >
        {model.poweredBy}
      </div>
    </div>
  );
}
