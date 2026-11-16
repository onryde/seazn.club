import { siteOrigin } from "@/lib/site-origin";

/** `<` escaped so a string value can never close the script element. */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

export function JsonLd({ data }: { data: unknown }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }} />;
}

/** Site-wide identity, rendered once on the home page. */
export function organizationLd() {
  const origin = siteOrigin();
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Seazn Club",
    url: `${origin}/`,
    logo: `${origin}/icons/icon-512.png`,
  };
}

/** Free-plan offer only: paid prices live in the plan catalog, and a copy here would drift from it. */
export function softwareApplicationLd(description: string) {
  const origin = siteOrigin();
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Seazn Club",
    applicationCategory: "SportsApplication",
    operatingSystem: "Web",
    url: `${origin}/`,
    description,
    offers: { "@type": "Offer", name: "Community", price: "0", priceCurrency: "USD" },
  };
}

export function breadcrumbLd(crumbs: { name: string; path: string }[]) {
  const origin = siteOrigin();
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      item: `${origin}${c.path}`,
    })),
  };
}

/** A page's visible questions and answers, word for word: search engines only accept FAQ data the page also shows. */
export function faqLd(items: { q: string; a: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((it) => ({ "@type": "Question", name: it.q, acceptedAnswer: { "@type": "Answer", text: it.a } })),
  };
}
