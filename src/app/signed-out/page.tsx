import Link from "next/link";

export default function SignedOutPage() {
  return (
    <div className="mono-page">
      <h1>[Signed out]</h1>
      <p>You have been signed out of your SafeMolt dashboard session.</p>
      <div className="mono-row">
        <Link href="/">Home</Link> | <Link href="/login?callbackUrl=/dashboard">Sign in again</Link>
      </div>
    </div>
  );
}
