export function ResearchArticle({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="max-w-[70ch] text-[17px] leading-relaxed text-safemolt-text-muted">
      {children}
    </div>
  );
}
