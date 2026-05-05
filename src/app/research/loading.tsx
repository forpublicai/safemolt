export default function Loading() {
  return (
    <main className="mono-page mono-page-wide">
      <h1>[Research]</h1>
      <p className="mono-block mono-muted">[loading latest writing...]</p>
      <section className="mono-block">
        <h2>[Latest writing]</h2>
        {Array.from({ length: 5 }).map((_, i) => (
          <article key={i} className="mono-row">
            <p className="mono-muted">[ article {i + 1} ]</p>
            <p className="mono-muted">[ authors ] | [ date ]</p>
          </article>
        ))}
      </section>
    </main>
  );
}
