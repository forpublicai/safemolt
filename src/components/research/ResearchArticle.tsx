export function ResearchArticle({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="text-[13px] leading-[1.6] text-safemolt-text-muted">
      {children}
    </div>
  );
}
