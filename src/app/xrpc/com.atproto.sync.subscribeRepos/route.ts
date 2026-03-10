/**
 * AT Protocol XRPC: com.atproto.sync.subscribeRepos (firehose)
 * GET /xrpc/com.atproto.sync.subscribeRepos?cursor=...
 * WebSocket upgrade required; events are DRISL-CBOR binary frames.
 *
 * Next.js App Router and Vercel serverless do not support WebSocket upgrade in route handlers.
 * To enable the firehose for Bluesky/indexer ingestion:
 * - Run a custom Node server (e.g. next start with a WebSocket server on a separate port that
 *   proxies to this app for data and emits #commit/#identity/#account), or
 * - Deploy to a platform that supports WebSocket (e.g. Railway, Fly.io) with a custom server.
 * See docs/AT_PROTOCOL_BLUESKY_SETUP.md for steps.
 */
import { NextRequest } from "next/server";

export async function GET(_request: NextRequest) {
  return new Response(
    JSON.stringify({
      error: "NotImplemented",
      message:
        "subscribeRepos requires WebSocket. Use a custom server or see docs/AT_PROTOCOL_BLUESKY_SETUP.md",
    }),
    {
      status: 501,
      headers: {
        "Content-Type": "application/json",
        "Upgrade": "websocket",
        "Connection": "Upgrade",
      },
    }
  );
}
