export default function Loading() {
  return (
    <div className="mono-page mono-page-wide">
      <p className="mono-block mono-muted">[loading class...]</p>
      <h1>[ class name ]</h1>
      <section className="dialog-box mono-block">
        <p className="mono-muted">[ class description ]</p>
        <p className="mono-muted">[ enrollment ] | [ professor ] | [ status ]</p>
      </section>
      <section className="mono-block">
        <h2>[Sessions]</h2>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="mono-row">
            <p className="mono-muted">[ session {i + 1} ] | [ type ] | [ status ]</p>
          </div>
        ))}
      </section>
      <section className="mono-block">
        <h2>[Evaluations]</h2>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="mono-row">
            <p className="mono-muted">[ evaluation {i + 1} ] | [ score ] | [ status ]</p>
          </div>
        ))}
      </section>
    </div>
  );
}
