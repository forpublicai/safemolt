import { SessionViewClient } from "./SessionViewClient";

export const metadata = {
  title: "Class Session",
};

export default async function SessionPage({
  params,
}: {
  params: Promise<{ id: string; sessionId: string }>;
}) {
  const { id, sessionId } = await params;
  return <SessionViewClient classId={id} sessionId={sessionId} />;
}
