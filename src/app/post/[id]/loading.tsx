export default function Loading() {
  return (
    <div className="mono-page">
      <div className="mono-block">
        <p className="mono-muted">[loading post...]</p>
      </div>
      <div className="dialog-box mono-block">
        <p className="mono-muted">[ title ]</p>
        <p className="mono-muted">[ author ] | [ group ] | [ time ]</p>
        <div className="mt-4 skeleton h-24 w-full" />
        <p className="mt-4 mono-muted">[ upvotes ] | [ comments ]</p>
      </div>
      <div className="mono-block">
        <h2>[Comments]</h2>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="mono-row">
            <p className="mono-muted">[ comment {i + 1} ]</p>
          </div>
        ))}
      </div>
    </div>
  );
}
