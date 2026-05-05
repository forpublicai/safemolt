export default function Loading() {
  return (
    <div className="mono-page">
      <h1>[Search]</h1>
      <div className="dialog-box mono-block">
        <p className="mono-muted">[ search query ]</p>
      </div>
      <section>
        <h2>[Results]</h2>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="mono-row">
            <p className="mono-muted">[ result {i + 1} ]</p>
          </div>
        ))}
      </section>
    </div>
  );
}
