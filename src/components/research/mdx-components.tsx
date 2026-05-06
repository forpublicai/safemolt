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

/** Typography aligned with the SafeMolt About page (mono, sharp, 12–13px body) */
export const researchMdxComponents: MDXComponents = {
  h2: ({ id, children, ...props }) => (
    <h2
      id={id}
      className="mt-12 scroll-mt-24 border-b border-safemolt-border pb-2 text-[18px] font-bold leading-[1.3] text-safemolt-text first:mt-0 sm:text-[20px]"
      {...props}
    >
      {children}
    </h2>
  ),
  h3: ({ id, children, ...props }) => (
    <h3
      id={id}
      className="mt-8 scroll-mt-24 text-[14px] font-bold leading-[1.35] text-safemolt-text"
      {...props}
    >
      {children}
    </h3>
  ),
  h4: ({ children, ...props }) => (
    <h4
      className="mt-5 text-[13px] font-bold text-safemolt-text"
      {...props}
    >
      {children}
    </h4>
  ),
  p: ({ children, ...props }) => (
    <p
      className="mt-3 text-[13px] leading-[1.6] text-safemolt-text-muted first:mt-0"
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
        "font-medium text-safemolt-accent-green underline decoration-safemolt-accent-green/30 underline-offset-2 hover:decoration-safemolt-accent-green hover:text-safemolt-accent-green-hover"
      }
      {...props}
    >
      {children}
    </AnchorLink>
  ),
  ul: ({ children, ...props }) => (
    <ul
      className="mt-3 list-disc space-y-1.5 pl-5 text-[13px] leading-[1.6] text-safemolt-text-muted marker:text-safemolt-accent-green/80"
      {...props}
    >
      {children}
    </ul>
  ),
  ol: ({ children, ...props }) => (
    <ol
      className="mt-3 list-decimal space-y-1.5 pl-5 text-[13px] leading-[1.6] text-safemolt-text-muted marker:font-bold marker:text-safemolt-text"
      {...props}
    >
      {children}
    </ol>
  ),
  li: ({ children, ...props }) => (
    <li className="leading-[1.6]" {...props}>
      {children}
    </li>
  ),
  blockquote: ({ children, ...props }) => (
    <blockquote
      className="my-5 border-l-2 border-safemolt-accent-green pl-4 text-[13px] italic leading-[1.6] text-safemolt-text"
      {...props}
    >
      {children}
    </blockquote>
  ),
  strong: ({ children, ...props }) => (
    <strong className="font-bold text-safemolt-text" {...props}>
      {children}
    </strong>
  ),
  em: ({ children, ...props }) => (
    <em className="italic" {...props}>
      {children}
    </em>
  ),
  hr: () => (
    <hr className="my-10 border-0 border-t border-safemolt-border" />
  ),
  table: ({ children, ...props }) => (
    <div className="my-6 overflow-x-auto border border-safemolt-border">
      <table
        className="w-full border-collapse text-[12px] text-safemolt-text"
        {...props}
      >
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
      className="px-3 py-2 text-left font-bold text-safemolt-text"
      {...props}
    >
      {children}
    </th>
  ),
  td: ({ children, ...props }) => (
    <td
      className="px-3 py-2 align-top text-[12px] leading-[1.55] text-safemolt-text-muted"
      {...props}
    >
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
        className="bg-safemolt-card px-1.5 py-0.5 text-[12px] text-safemolt-text"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ children, ...props }) => (
    <pre
      className="my-5 overflow-x-auto border border-safemolt-border bg-safemolt-card p-3 text-[12px] leading-[1.55] text-safemolt-text"
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
        className ?? "my-5 h-auto max-w-full border border-safemolt-border"
      }
      {...props}
    />
  ),
};
