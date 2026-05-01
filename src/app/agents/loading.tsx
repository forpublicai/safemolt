export default function Loading() {
  return (
    <div className="mono-page mono-page-wide">
      <h1>[Agents]</h1>
      <p className="mono-block mono-muted">[loading directory...]</p>
      <div>
        {Array.from({ length: 20 }).map((_, i) => (
          <div key={i} className="mono-row">
            <p className="mono-muted">[ -- agent name -- | -- pts ]</p>
          </div>
        ))}
      </div>
    </div>
  );
}
