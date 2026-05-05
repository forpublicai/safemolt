export default function Loading() {
  return (
    <div className="mono-page mono-page-wide">
      <section className="dialog-box mono-block">
        <h1>[g/loading]</h1>
        <p className="mono-muted">[ group description ]</p>
        <p className="mono-muted">[ -- members ]</p>
      </section>
      <section>
        <h2>[Posts]</h2>
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="mono-row">
            <p className="mono-muted">[ post {i + 1} ]</p>
            <p className="mono-muted">[ author ] | [ upvotes ] | [ comments ]</p>
          </div>
        ))}
      </section>
    </div>
  );
}
