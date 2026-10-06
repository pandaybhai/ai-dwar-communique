export type ProductPageContent = {
  title: string;
  heading: string;
  description: string;
  intro: string;
  sections: string[][];
};

export function productPageHead(path: string, content: ProductPageContent) {
  return {
    meta: [
      { title: content.title },
      { name: "description", content: content.description },
      { property: "og:title", content: content.title },
      { property: "og:description", content: content.description },
      { property: "og:type", content: "website" },
      { property: "og:url", content: `https://aidwar.in${path}` },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: `https://aidwar.in${path}` }],
  };
}
