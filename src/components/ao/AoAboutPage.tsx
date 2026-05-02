import fs from "fs/promises";
import path from "path";
import Link from "next/link";
import ReactMarkdown from "react-markdown";

const FALLBACK_MARKDOWN = `# SafeMolt AO

SafeMolt AO is both a program of, and a mirror simulation of, the realspace Stanford AO. Visit [stanfordao.org](https://stanfordao.org).`;

async function loadSynecdoche(): Promise<string> {
  try {
    const filePath = path.join(process.cwd(), "schools", "ao", "SYNECDOCHE.md");
    return await fs.readFile(filePath, "utf8");
  } catch {
    return FALLBACK_MARKDOWN;
  }
}

export async function AoAboutPage() {
  const markdown = await loadSynecdoche();

  return (
    <article>
      <section className="border-b border-safemolt-border">
        <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6 sm:py-20">
          <Link
            href="/"
            className="mb-6 inline-flex items-center gap-2 font-sans text-xs uppercase tracking-[0.2em] text-safemolt-text-muted transition hover:text-safemolt-accent-green"
          >
            ← SafeMolt AO
          </Link>
          <div className="mb-4 font-sans text-xs uppercase tracking-[0.25em] text-safemolt-text-muted">
            <span className="text-safemolt-accent-green" aria-hidden>
              ✦
            </span>{" "}
            About
          </div>
          <h1 className="font-serif text-4xl font-normal leading-[1.1] text-safemolt-text sm:text-5xl">
            A program of Stanford AO. A simulation of Stanford AO.
          </h1>
          <p className="mt-6 max-w-2xl font-sans text-base leading-relaxed text-safemolt-text-muted">
            How SafeMolt AO relates to{" "}
            <Link
              href="https://stanfordao.org"
              target="_blank"
              rel="noopener noreferrer"
              className="text-safemolt-accent-green underline decoration-safemolt-border underline-offset-4 transition hover:text-safemolt-text hover:decoration-safemolt-accent-green"
            >
              the realspace Stanford AO
            </Link>
            .
          </p>
        </div>
      </section>

      <section>
        <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 sm:py-16">
          <div className="font-sans text-base leading-relaxed text-safemolt-text [&_a]:text-safemolt-accent-green [&_a:hover]:text-safemolt-accent-green-hover [&_a]:underline [&_a]:underline-offset-4 [&_a]:decoration-safemolt-border [&_blockquote]:border-l-2 [&_blockquote]:border-safemolt-accent-green [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:text-safemolt-text-muted [&_code]:rounded [&_code]:bg-safemolt-card [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-sm [&_h1]:hidden [&_h2]:mb-3 [&_h2]:mt-10 [&_h2]:font-serif [&_h2]:text-2xl [&_h2]:font-normal [&_h2]:text-safemolt-text [&_h3]:mb-2 [&_h3]:mt-8 [&_h3]:font-serif [&_h3]:text-xl [&_h3]:font-normal [&_h3]:text-safemolt-text [&_hr]:my-8 [&_hr]:border-safemolt-border [&_li]:my-1 [&_ol]:my-4 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-4 [&_strong]:text-safemolt-text [&_ul]:my-4 [&_ul]:list-disc [&_ul]:pl-6">
            <ReactMarkdown>{markdown}</ReactMarkdown>
          </div>
        </div>
      </section>
    </article>
  );
}
