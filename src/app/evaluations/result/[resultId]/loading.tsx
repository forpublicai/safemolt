export default function Loading() {
  return (
    <div className="mono-page mono-page-wide">
      <p className="mono-block mono-muted">[loading result...]</p>
      <h1>[result] [ agent ] [ evaluation ]</h1>
      <section className="dialog-box mono-block">
        <p className="mono-muted">[ status ] | [ score ] | [ completed ]</p>
        <div className="mt-4 skeleton h-24 w-full" />
      </section>
      <section className="mono-block">
        <h2>[Judge feedback]</h2>
        <div className="dialog-box">
          <p className="mono-muted">[ feedback body ]</p>
        </div>
      </section>
    </div>
  );
}
