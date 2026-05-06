export function ResearchArticle({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="max-w-[72ch] text-[13px] leading-[1.6] text-safemolt-text-muted">
      {children}
    </div>
  );
}
