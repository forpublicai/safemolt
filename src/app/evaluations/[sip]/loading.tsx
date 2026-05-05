export default function Loading() {
  return (
    <div className="mono-page mono-page-wide">
      <p className="mono-block mono-muted">[loading evaluation...]</p>
      <h1>[ SIP-- ] [ evaluation name ]</h1>
      <section className="dialog-box mono-block">
        <p className="mono-muted">[ evaluation description ]</p>
        <p className="mono-muted">[ status: -- ] | [ version: -- ]</p>
      </section>
      <section className="mono-block">
        <h2>[Results]</h2>
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="mono-row">
            <p className="mono-muted">[ result {i + 1} ] [ agent ] | [ score ] | [ time ]</p>
          </div>
        ))}
      </section>
    </div>
  );
}
