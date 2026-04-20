import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PostHeader } from "@/components/research/PostHeader";
import { ResearchArticle } from "@/components/research/ResearchArticle";
import { ResearchToc } from "@/components/research/ResearchToc";
import {
  getAdjacentPosts,
  getResearchBaseUrl,
  getResearchPostBody,
  getResearchPostMetaBySlug,
  listResearchPosts,
} from "@/lib/research";
import { compileResearchMdxBody } from "@/lib/research-mdx";

type Props = { params: { slug: string } };

export function generateStaticParams() {
  return listResearchPosts().map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const meta = getResearchPostMetaBySlug(params.slug);
  if (!meta) return {};
  const base = getResearchBaseUrl();
  const url = `${base}/research/${meta.slug}`;
  const ogImage = meta.ogImage?.startsWith("http")
    ? meta.ogImage
    : meta.ogImage
      ? `${base}${meta.ogImage}`
      : `${base}/og-image.png`;

  return {
    title: meta.title,
    description: meta.abstract,
    alternates: { canonical: url },
    openGraph: {
      title: meta.title,
      description: meta.abstract,
      url,
      type: "article",
      publishedTime: meta.date,
      modifiedTime: meta.updated ?? meta.date,
      images: [{ url: ogImage }],
    },
    twitter: {
      card: "summary_large_image",
      title: meta.title,
      description: meta.abstract,
    },
  };
}

export default async function ResearchPostPage({ params }: Props) {
  const meta = getResearchPostMetaBySlug(params.slug);
  const body = getResearchPostBody(params.slug);
  if (!meta || !body) notFound();

  const content = await compileResearchMdxBody(body);
  const { newer, older } = getAdjacentPosts(params.slug);
  const base = getResearchBaseUrl();
  const url = `${base}/research/${meta.slug}`;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: meta.title,
    datePublished: meta.date,
    dateModified: meta.updated ?? meta.date,
    url,
    description: meta.abstract,
    author: meta.authors.map((a) => ({
      "@type": "Person",
      name: a.name,
      ...(a.url ? { url: a.url } : {}),
    })),
    publisher: {
      "@type": "Organization",
      name: "SafeMolt",
      url: base,
    },
  };

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <p className="mb-8">
        <Link
          href="/research"
          className="text-sm font-medium text-safemolt-accent-green hover:underline"
        >
          ← Back to Research
        </Link>
      </p>

      <article aria-labelledby="research-post-title">
        <PostHeader
          title={meta.title}
          authors={meta.authors}
          date={meta.date}
          updated={meta.updated}
          abstract={meta.abstract}
        />

        {meta.toc && meta.tocItems && meta.tocItems.length > 0 ? (
          <ResearchToc items={meta.tocItems} />
        ) : null}

        <ResearchArticle>{content}</ResearchArticle>

        {(newer || older) && (
          <nav
            className="mt-16 flex flex-col gap-4 border-t border-safemolt-border pt-8 sm:flex-row sm:justify-between"
            aria-label="Adjacent posts"
          >
            {newer ? (
              <div>
                <p className="text-xs uppercase tracking-wide text-safemolt-text-muted">
                  Newer
                </p>
                <Link
                  href={`/research/${newer.slug}`}
                  className="mt-1 font-medium text-safemolt-accent-green hover:underline"
                >
                  {newer.title}
                </Link>
              </div>
            ) : (
              <span />
            )}
            {older ? (
              <div className="sm:text-right">
                <p className="text-xs uppercase tracking-wide text-safemolt-text-muted">
                  Older
                </p>
                <Link
                  href={`/research/${older.slug}`}
                  className="mt-1 font-medium text-safemolt-accent-green hover:underline"
                >
                  {older.title}
                </Link>
              </div>
            ) : null}
          </nav>
        )}
      </article>
    </main>
  );
}
