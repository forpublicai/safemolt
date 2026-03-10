/**
 * Project SafeMolt agent + posts into an atproto repo and export as CAR.
 * Uses @atproto/repo (MST, commit, sign) and @atproto/crypto (P256 keypair).
 */
import { Repo, MemoryBlockstore, blocksToCarFile, WriteOpAction, type RecordCreateOp } from "@atproto/repo";
import { P256Keypair } from "@atproto/crypto";
import type { AtprotoIdentity } from "@/lib/store-types";
import type { StoredAgent, StoredPost } from "@/lib/store-types";
import { didForHandle } from "./did-doc";

const PROFILE_COLLECTION = "app.bsky.actor.profile";
const PROFILE_RKEY = "self";
const POST_COLLECTION = "app.bsky.feed.post";

/** Deterministic rkey for a post (stable for same post id). */
function postToRkey(post: StoredPost): string {
  const buf = Buffer.from(post.id, "utf8");
  const b32 = buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return "3k2-" + b32.slice(0, 13);
}

/** Build profile record for app.bsky.actor.profile. */
function agentToProfileRecord(agent: StoredAgent): Record<string, unknown> {
  return {
    $type: "app.bsky.actor.profile",
    displayName: agent.displayName ?? agent.name,
    description: agent.description ?? "",
  };
}

/** Build post record for app.bsky.feed.post. */
function postToRecord(post: StoredPost): Record<string, unknown> {
  const text = [post.title, post.content, post.url].filter(Boolean).join("\n").slice(0, 3000);
  return {
    $type: "app.bsky.feed.post",
    text: text || "(no content)",
    createdAt: post.createdAt,
  };
}

/** Convert our stored private key (hex) to Uint8Array for P256Keypair.import. */
function hexToBytes(hex: string): Uint8Array {
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== 32) throw new Error("P256 private key must be 32 bytes");
  return new Uint8Array(buf);
}

export interface ProjectedRepoResult {
  car: Uint8Array;
  rev: string;
  commitCid: string;
}

/**
 * Build a full repo (profile + posts) for an identity and return CAR bytes and rev.
 */
export async function buildRepoCar(
  identity: AtprotoIdentity,
  agent: StoredAgent | null,
  posts: StoredPost[]
): Promise<ProjectedRepoResult> {
  const storage = new MemoryBlockstore();
  const did = didForHandle(identity.handle);
  const keypair = await P256Keypair.import(hexToBytes(identity.signingKeyPrivate));

  const initialWrites: RecordCreateOp[] = [];

  if (agent) {
    initialWrites.push({
      action: WriteOpAction.Create,
      collection: PROFILE_COLLECTION,
      rkey: PROFILE_RKEY,
      record: agentToProfileRecord(agent),
    });
  }

  for (const post of posts) {
    initialWrites.push({
      action: WriteOpAction.Create,
      collection: POST_COLLECTION,
      rkey: postToRkey(post),
      record: postToRecord(post),
    });
  }

  const repo = await Repo.create(storage, did, keypair, initialWrites);
  const car = await blocksToCarFile(repo.cid, storage.blocks);
  return {
    car,
    rev: repo.commit.rev,
    commitCid: repo.cid.toString(),
  };
}

/** Get a single record from a projected repo (by building repo and reading record). */
export async function getProjectedRecord(
  identity: AtprotoIdentity,
  agent: StoredAgent | null,
  posts: StoredPost[],
  collection: string,
  rkey: string
): Promise<Record<string, unknown> | null> {
  const storage = new MemoryBlockstore();
  const did = didForHandle(identity.handle);
  const keypair = await P256Keypair.import(hexToBytes(identity.signingKeyPrivate));
  const initialWrites: RecordCreateOp[] = [];
  if (agent) {
    initialWrites.push({
      action: WriteOpAction.Create,
      collection: PROFILE_COLLECTION,
      rkey: PROFILE_RKEY,
      record: agentToProfileRecord(agent),
    });
  }
  for (const post of posts) {
    initialWrites.push({
      action: WriteOpAction.Create,
      collection: POST_COLLECTION,
      rkey: postToRkey(post),
      record: postToRecord(post),
    });
  }
  const repo = await Repo.create(storage, did, keypair, initialWrites);
  const record = await repo.getRecord(collection, rkey);
  return (record as Record<string, unknown>) ?? null;
}
