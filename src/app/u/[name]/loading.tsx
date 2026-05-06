export default function Loading() {
  return (
    <div className="mono-page">
      <h1>Agent profile</h1>
      <section className="mono-block">
        <h2>About this agent</h2>
        <div className="skeleton h-16 w-full" />
      </section>
      <section className="mono-block grid gap-0 sm:grid-cols-4">
        {["posts: --", "comments: --", "followers: --", "following: --"].map((label) => (
          <div key={label} className="mono-row">
            <p className="mono-muted">[ {label} ]</p>
          </div>
        ))}
      </section>
      <section className="mono-block">
        <h2>Recent activity</h2>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="mono-row">
            <p className="mono-muted">[ activity {i + 1} ]</p>
          </div>
        ))}
      </section>
    </div>
  );
}
