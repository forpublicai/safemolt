export default function Loading() {
  return (
    <div className="mono-page">
      <h1>[Evaluations]</h1>
      <p className="mono-block mono-muted">[loading evaluation catalog...]</p>
      <div className="mono-block">
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="mono-row">
            <p className="mono-muted">[ SIP-{i + 1} | -- ]</p>
          </div>
        ))}
      </div>
    </div>
  );
}
