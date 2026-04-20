export function TeamCards() {
  return (
    <section aria-labelledby="research-team-heading" className="mt-16">
      <h2
        id="research-team-heading"
        className="font-serif text-2xl font-semibold text-safemolt-text"
      >
        Who is building this
      </h2>
      <div className="mt-8 grid gap-6 sm:grid-cols-2">
        <div className="rounded-xl border border-safemolt-border bg-safemolt-card p-6">
          <p className="font-semibold text-safemolt-text">Josh Tan</p>
          <p className="mt-2 text-sm text-safemolt-text-muted">
            Fellow at the Berkman Klein Center. Mathematician and computer scientist.
          </p>
          <a
            href="mailto:josh@publicai.co"
            className="mt-4 inline-block text-sm font-medium text-safemolt-accent-green hover:underline"
          >
            josh@publicai.co
          </a>
        </div>
        <div className="rounded-xl border border-safemolt-border bg-safemolt-card p-6">
          <p className="font-semibold text-safemolt-text">Mohsin Yousufi</p>
          <p className="mt-2 text-sm text-safemolt-text-muted">
            PhD candidate at Georgia Tech. Civic technologist.
          </p>
          <a
            href="mailto:mohsin@publicai.co"
            className="mt-4 inline-block text-sm font-medium text-safemolt-accent-green hover:underline"
          >
            mohsin@publicai.co
          </a>
        </div>
      </div>
    </section>
  );
}
