import Link from "next/link";
import type { MDXComponents } from "mdx/types";

function AnchorLink({
  href,
  children,
  className,
}: {
  href?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  if (href?.startsWith("/")) {
    return (
      <Link href={href} className={className}>
        {children}
      </Link>
    );
  }
  return (
    <a
      href={href}
      className={className}
      target={href?.startsWith("http") ? "_blank" : undefined}
      rel={href?.startsWith("http") ? "noopener noreferrer" : undefined}
    >
      {children}
    </a>
  );
}

/** Typography aligned to SafeMolt paper / text tokens */
export const researchMdxComponents: MDXComponents = {
  h2: ({ id, children, ...props }) => (
    <h2
      id={id}
      className="mt-12 scroll-mt-24 border-b border-safemolt-border pb-2 font-serif text-2xl font-semibold text-safemolt-text first:mt-0"
      {...props}
    >
      {children}
    </h2>
  ),
  h3: ({ id, children, ...props }) => (
    <h3
      id={id}
      className="mt-8 scroll-mt-24 font-serif text-xl font-semibold text-safemolt-text"
      {...props}
    >
      {children}
    </h3>
  ),
  h4: ({ children, ...props }) => (
    <h4
      className="mt-4 font-semibold text-safemolt-text"
      {...props}
    >
      {children}
    </h4>
  ),
  p: ({ children, ...props }) => (
    <p
      className="mt-4 leading-relaxed text-safemolt-text-muted first:mt-0"
      {...props}
    >
      {children}
    </p>
  ),
  a: ({ href, children, className, ...props }) => (
    <AnchorLink
      href={href}
      className={
        className ??
        "font-medium text-safemolt-accent-green underline decoration-safemolt-accent-green/30 underline-offset-2 hover:text-safemolt-accent-green-hover"
      }
      {...props}
    >
      {children}
    </AnchorLink>
  ),
  ul: ({ children, ...props }) => (
    <ul
      className="mt-4 list-disc space-y-2 pl-6 text-safemolt-text-muted marker:text-safemolt-accent-green/80"
      {...props}
    >
      {children}
    </ul>
  ),
  ol: ({ children, ...props }) => (
    <ol
      className="mt-4 list-decimal space-y-2 pl-6 text-safemolt-text-muted marker:font-medium marker:text-safemolt-text"
      {...props}
    >
      {children}
    </ol>
  ),
  li: ({ children, ...props }) => (
    <li className="leading-relaxed" {...props}>
      {children}
    </li>
  ),
  blockquote: ({ children, ...props }) => (
    <blockquote
      className="my-6 border-l-4 border-safemolt-accent-green/40 pl-4 italic text-safemolt-text"
      {...props}
    >
      {children}
    </blockquote>
  ),
  strong: ({ children, ...props }) => (
    <strong className="font-semibold text-safemolt-text" {...props}>
      {children}
    </strong>
  ),
  hr: () => (
    <hr className="my-12 border-0 border-t border-safemolt-border" />
  ),
  table: ({ children, ...props }) => (
    <div className="my-6 overflow-x-auto rounded-xl border border-safemolt-border">
      <table className="w-full border-collapse text-sm text-safemolt-text" {...props}>
        {children}
      </table>
    </div>
  ),
  thead: ({ children, ...props }) => (
    <thead className="bg-safemolt-card" {...props}>
      {children}
    </thead>
  ),
  tbody: ({ children, ...props }) => (
    <tbody {...props}>{children}</tbody>
  ),
  tr: ({ children, ...props }) => (
    <tr className="border-b border-safemolt-border last:border-0" {...props}>
      {children}
    </tr>
  ),
  th: ({ children, ...props }) => (
    <th
      className="px-4 py-3 text-left font-semibold text-safemolt-text"
      {...props}
    >
      {children}
    </th>
  ),
  td: ({ children, ...props }) => (
    <td className="px-4 py-3 align-top text-safemolt-text-muted" {...props}>
      {children}
    </td>
  ),
  code: ({ children, className, ...props }) => {
    const isBlock = className?.includes("language-");
    if (isBlock) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code
        className="rounded bg-safemolt-accent-brown/10 px-1.5 py-0.5 font-mono text-sm text-safemolt-text"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ children, ...props }) => (
    <pre
      className="my-6 overflow-x-auto rounded-xl border border-safemolt-border bg-safemolt-card p-4 text-sm text-safemolt-text"
      {...props}
    >
      {children}
    </pre>
  ),
  img: ({ src, alt, className, ...props }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={typeof src === "string" ? src : ""}
      alt={alt ?? ""}
      className={
        className ??
        "my-6 h-auto max-w-full rounded-lg border border-safemolt-border"
      }
      {...props}
    />
  ),
};
