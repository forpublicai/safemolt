export default function Loading() {
  return (
    <main className="mono-page">
      <p className="mono-block mono-muted">[loading article...]</p>
      <h1>[ article title ]</h1>
      <p className="mono-block mono-muted">[ authors ] | [ date ]</p>
      <section className="dialog-box mono-block">
        <p className="mono-muted">[ abstract ]</p>
      </section>
      <section className="mono-block">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="mb-3 skeleton h-5 w-full" />
        ))}
      </section>
    </main>
  );
}
