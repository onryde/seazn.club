import Link from "next/link";
import type { ReactNode } from "react";
import { JsonLd, faqLd } from "@/components/seo/json-ld";
import { PRODUCT_IMAGES, type ProductImageKey } from "@/lib/marketing/product-images";
import "./product.css";

/**
 * The parts every product page is built from (design of record:
 * docs/superpowers/specs/2026-11-16-product-pages-design.md §4). A page is these parts in a fixed order; a shape
 * (feature, sport) leaves parts out but never reorders or restyles them. All server components, complete without
 * script, and all copy arrives already translated — nothing here reads a dictionary.
 */

type LinkTo = { label: string; href: string };

/** A real product screen. Phone captures get the 9:16 phone frame; web captures a plain card. */
export function Shot({ image, alt, eager = false }: { image: ProductImageKey; alt: string; eager?: boolean }) {
  const im = PRODUCT_IMAGES[image];
  return (
    <div className={im.kind === "phone" ? "mkp-shot mkp-ph" : "mkp-shot"}>
      {/* eslint-disable-next-line @next/next/no-img-element -- fixed, pre-sized product captures */}
      <img src={im.src} width={im.width} height={im.height} alt={alt} loading={eager ? "eager" : "lazy"} decoding="async" />
    </div>
  );
}

/** A headline with one lime phrase: the dictionary marks it `like *this*`, so translators choose which words carry it. */
export function Accent({ text }: { text: string }) {
  return (
    <>
      {text.split("*").map((part, i) => (i % 2 ? <em key={i}>{part}</em> : part))}
    </>
  );
}

/** The pages' example sides. Invented, and left untranslated like every example name on the marketing site. */
export const DEMO_TEAMS = { batting: "Thorpe Bay Tigers", bowling: "Southend Blue Blazers" } as const;

/**
 * Where the proof block's button goes. Seazn Demo Club does not exist in production yet (creating it needs the
 * owner's explicit go), so there is no link and the block shows none. Set this once the club is live.
 */
export const DEMO_CLUB_HREF: string | undefined = undefined;

export function ProductPage({ children }: { children: ReactNode }) {
  return <main className="mkp">{children}</main>;
}

export function PageHero({
  crumb,
  title,
  lede,
  primary,
  secondary,
  children,
}: {
  crumb: string;
  title: ReactNode;
  lede: string;
  primary: LinkTo;
  secondary: LinkTo;
  /** The demo band: it sits inside the hero so the night background runs through both. */
  children?: ReactNode;
}) {
  return (
    <section className="mkp-hero" data-section="hero">
      {/* NavScrollFlip (nav-scroll.tsx) keeps the nav in its night colours while this is on screen. */}
      <div id="mk-hero-sentinel" aria-hidden />
      <div className="mkp-wrap">
        <div className="mkp-top">
          <div>
            <p className="mkp-crumb">{crumb}</p>
            <h1 className="mkp-d">{title}</h1>
          </div>
          <div>
            <p className="mkp-lede">{lede}</p>
            <div className="mkp-btns">
              <a className="mkp-btn mkp-btn-l" href={primary.href}>
                {primary.label}
              </a>
              <Link className="mkp-btn mkp-btn-g" href={secondary.href}>
                {secondary.label}
              </Link>
            </div>
          </div>
        </div>
      </div>
      {children}
    </section>
  );
}

export function DemoBand({ id, title, note, children }: { id: string; title: string; note: string; children: ReactNode }) {
  return (
    <div className="mkp-demo" id={id} data-section="demo">
      <div className="mkp-wrap">
        <div className="mkp-demo-h">
          <p>{title}</p>
          <span>{note}</span>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Road({
  title,
  lede,
  steps,
}: {
  title: string;
  lede: string;
  /** A step with no `image` shows no picture: the page has no real screen for it yet. */
  steps: { heading: string; who: string; body: string; image?: ProductImageKey; caption?: string }[];
}) {
  return (
    <section className="mkp-sec" data-section="road">
      <div className="mkp-wrap">
        <h2 className="mkp-d">{title}</h2>
        <p className="mkp-lede">{lede}</p>
        <ol className="mkp-road">
          {steps.map((s, i) => (
            <li className="mkp-stop" key={s.heading}>
              <span className="mkp-n" aria-hidden>{i + 1}</span>
              <div>
                <h3>{s.heading}</h3>
                <span className="mkp-who">{s.who}</span>
                <p>{s.body}</p>
              </div>
              {s.image && s.caption ? (
                <div className="mkp-media">
                  <Shot image={s.image} alt={s.caption} />
                  <p className="mkp-real">{s.caption}</p>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

export function PhoneRow({
  title,
  lede,
  items,
  section = "phones",
}: {
  title: string;
  lede: string;
  items: { image: ProductImageKey; heading: string; body: string }[];
  section?: string;
}) {
  return (
    <section className="mkp-sec mkp-night" data-section={section}>
      <div className="mkp-wrap">
        <h2 className="mkp-d">{title}</h2>
        <p className="mkp-lede">{lede}</p>
        <div className={items.length === 2 ? "mkp-cam" : "mkp-phones"}>
          {items.map((it) => (
            <figure key={it.heading}>
              <Shot image={it.image} alt={it.heading} />
              <figcaption>
                <b>{it.heading}</b>
                {it.body}
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}

export function SplitBand({
  title,
  lede,
  steps,
  figures,
  section = "split",
}: {
  title: string;
  lede: string;
  steps: { heading: string; body: string }[];
  figures: { image: ProductImageKey; caption: string }[];
  section?: string;
}) {
  return (
    <section className="mkp-sec mkp-off" data-section={section}>
      <div className="mkp-wrap">
        <div>
          <h2 className="mkp-d">{title}</h2>
          <p className="mkp-lede">{lede}</p>
          <ol className="mkp-off-steps">
            {steps.map((s) => (
              <li key={s.heading}>
                <b>{s.heading}</b>
                {s.body}
              </li>
            ))}
          </ol>
        </div>
        <div className="mkp-off-p">
          {figures.map((f) => (
            <figure key={f.caption}>
              <Shot image={f.image} alt={f.caption} />
              <figcaption>{f.caption}</figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Ticket({
  title,
  body,
  kicker,
  heading,
  rows,
  stub,
}: {
  title: string;
  body: string;
  kicker: string;
  heading: string;
  rows: { label: string; value: string }[];
  stub: { top: string; big: string; bottom: string; href?: string };
}) {
  const stubBody = (
    <>
      <span>{stub.top}</span>
      <b>{stub.big}</b>
      <span>{stub.bottom}</span>
    </>
  );
  return (
    <section className="mkp-tix" data-section="ticket">
      <div className="mkp-wrap">
        <div>
          <h2 className="mkp-d">{title}</h2>
          <p>{body}</p>
        </div>
        <div className="mkp-ticket">
          <div className="mkp-main">
            <span className="mkp-k">{kicker}</span>
            <h3>{heading}</h3>
            <ul>
              {rows.map((r) => (
                <li key={r.label}>
                  {r.label}
                  <b>{r.value}</b>
                </li>
              ))}
            </ul>
          </div>
          {stub.href ? (
            <Link className="mkp-stub" href={stub.href}>
              {stubBody}
            </Link>
          ) : (
            <div className="mkp-stub">{stubBody}</div>
          )}
        </div>
      </div>
    </section>
  );
}

/** The proof block. Until Seazn Demo Club exists in production there is no `href`, and the block shows no button. */
export function DemoClub({
  title,
  text,
  image,
  imageAlt,
  href,
  linkLabel,
}: {
  title: string;
  text: string;
  image: ProductImageKey;
  imageAlt: string;
  href?: string;
  linkLabel?: string;
}) {
  return (
    <section className="mkp-club" data-section="club">
      <div className="mkp-wrap">
        <div>
          <h2 className="mkp-d">{title}</h2>
          <p>{text}</p>
          {href && linkLabel ? (
            <div className="mkp-btns">
              <Link className="mkp-btn mkp-btn-l" href={href}>
                {linkLabel}
              </Link>
            </div>
          ) : null}
        </div>
        <Shot image={image} alt={imageAlt} />
      </div>
    </section>
  );
}

export function Questions({ title, items }: { title: string; items: { q: string; a: string }[] }) {
  return (
    <section className="mkp-faq" data-section="questions">
      <JsonLd data={faqLd(items)} />
      <div className="mkp-wrap">
        <h2 className="mkp-d">{title}</h2>
        <div>
          {items.map((it, i) => (
            <details key={it.q} open={i === 0}>
              <summary>{it.q}</summary>
              <p>{it.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

export function Closing({
  line,
  sub,
  cta,
  pricing,
}: {
  line: string;
  sub: string;
  cta: LinkTo;
  pricing: LinkTo;
}) {
  return (
    <section className="mkp-fin" data-section="closing">
        <div className="mkp-wrap">
          <h2 className="mkp-d">{line}</h2>
          <p>{sub}</p>
          <div className="mkp-btns">
            <Link className="mkp-btn mkp-btn-l" href={cta.href}>
              {cta.label}
            </Link>
            <Link className="mkp-btn mkp-btn-g" href={pricing.href}>
              {pricing.label}
            </Link>
          </div>
        </div>
    </section>
  );
}
