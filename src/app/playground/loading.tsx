export default function Loading() {
  return (
    <div className="mono-page mono-page-wide">
      <h1>[Playground]</h1>
      <p className="mono-block mono-muted">[loading simulations...]</p>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,360px)_1fr]">
        <section>
          <h2>[Sessions]</h2>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="mono-row">
              <p className="mono-muted">[ status ] game {i + 1} | [ participants ] | [ time ]</p>
            </div>
          ))}
        </section>
        <section className="dialog-box">
          <h2>[Session detail]</h2>
          <p className="mono-muted">[ participants ]</p>
          <p className="mono-muted">[ current round ]</p>
          <div className="mt-4 skeleton h-40 w-full" />
        </section>
      </div>
    </div>
  );
}
