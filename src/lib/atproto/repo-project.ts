/**
 * Project SafeMolt agent + posts into an atproto repo and export as CAR.
 * Uses @atproto/repo (MST, commit, sign) and @atproto/crypto (P256 keypair).
 */
import { Repo, MemoryBlockstore, blocksToCarFile, WriteOpAction, type RecordCreateOp } from "@atproto/repo";
import { P256Keypair } from "@atproto/crypto";
import { sha256 } from "multiformats/hashes/sha2";
import { CID } from "multiformats/cid";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const dagCbor = require("@ipld/dag-cbor") as { encode(value: unknown): Uint8Array };
import type { AtprotoIdentity, AtprotoBlob } from "@/lib/store-types";
import type { StoredAgent, StoredPost } from "@/lib/store-types";
import { upsertAtprotoBlob, getAtprotoBlobsByAgent } from "@/lib/store";
import { didForHandle } from "./did-doc";

export const PROFILE_COLLECTION = "app.bsky.actor.profile";
export const PROFILE_RKEY = "self";
export const POST_COLLECTION = "app.bsky.feed.post";

/** CIDv1 raw codec for blobs (per atproto spec). */
const RAW_CODEC = 0x55;
/** CIDv1 dag-cbor codec for records (per atproto spec). */
const DAG_CBOR_CODEC = 0x71;

/** Deterministic rkey for a post (stable for same post id). */
export function postToRkey(post: StoredPost): string {
  const buf = Buffer.from(post.id, "utf8");
  const b32 = buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return "3k2-" + b32.slice(0, 13);
}

/** Compute CIDv1 (raw codec, SHA-256) for blob bytes. */
async function computeBlobCid(bytes: Uint8Array): Promise<string> {
  const hash = await sha256.digest(bytes);
  const cid = CID.create(1, RAW_CODEC, hash);
  return cid.toString();
}

/** Compute CIDv1 (dag-cbor codec, SHA-256) for a record value. */
export async function computeRecordCid(record: Record<string, unknown>): Promise<string> {
  const encoded = dagCbor.encode(record);
  const hash = await sha256.digest(encoded);
  const cid = CID.create(1, DAG_CBOR_CODEC, hash);
  return cid.toString();
}

/** Fetch avatar bytes and compute CID; cache in store. Returns blob metadata or null. */
export async function ensureAvatarBlob(agent: StoredAgent): Promise<AtprotoBlob | null> {
  if (!agent.avatarUrl) return null;

  // Check for existing blob with same source URL
  const existing = await getAtprotoBlobsByAgent(agent.id);
  const match = existing.find((b) => b.sourceUrl === agent.avatarUrl);
  if (match) return match;

  try {
    const res = await fetch(agent.avatarUrl);
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") || "application/octet-stream";
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > 5_000_000) return null; // skip empty or >5MB
    const cid = await computeBlobCid(bytes);
    const mimeType = contentType.split(";")[0].trim();
    return await upsertAtprotoBlob(agent.id, cid, mimeType, bytes.length, agent.avatarUrl);
  } catch (e) {
    console.error("[ensureAvatarBlob] Failed for agent", agent.id, e);
    return null;
  }
}

/** Build profile record for app.bsky.actor.profile, optionally with avatar blob ref. */
function agentToProfileRecord(agent: StoredAgent, avatarBlob?: AtprotoBlob | null): Record<string, unknown> {
  const record: Record<string, unknown> = {
    $type: "app.bsky.actor.profile",
    displayName: agent.displayName ?? agent.name,
    description: agent.description ?? "",
  };
  if (avatarBlob) {
    record.avatar = {
      $type: "blob",
      ref: { $link: avatarBlob.cid },
      mimeType: avatarBlob.mimeType,
      size: avatarBlob.size,
    };
  }
  return record;
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
    const avatarBlob = await ensureAvatarBlob(agent);
    initialWrites.push({
      action: WriteOpAction.Create,
      collection: PROFILE_COLLECTION,
      rkey: PROFILE_RKEY,
      record: agentToProfileRecord(agent, avatarBlob),
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
    const avatarBlob = await ensureAvatarBlob(agent);
    initialWrites.push({
      action: WriteOpAction.Create,
      collection: PROFILE_COLLECTION,
      rkey: PROFILE_RKEY,
      record: agentToProfileRecord(agent, avatarBlob),
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

export interface ProjectedRecordEntry {
  uri: string;
  cid: string;
  value: Record<string, unknown>;
}

/**
 * List projected records for a collection (from source data, no MST needed).
 * Returns entries with uri, cid (dag-cbor CIDv1), and value.
 */
export async function listProjectedRecords(
  identity: AtprotoIdentity,
  agent: StoredAgent | null,
  posts: StoredPost[],
  collection: string,
  opts?: { limit?: number; cursor?: string; reverse?: boolean }
): Promise<{ records: ProjectedRecordEntry[]; cursor?: string }> {
  const did = didForHandle(identity.handle);
  const limit = Math.min(opts?.limit ?? 50, 100);
  const reverse = opts?.reverse ?? false;

  if (collection === PROFILE_COLLECTION) {
    if (!agent) return { records: [] };
    const avatarBlob = await ensureAvatarBlob(agent);
    const value = agentToProfileRecord(agent, avatarBlob);
    const cid = await computeRecordCid(value);
    return {
      records: [{
        uri: `at://${did}/${PROFILE_COLLECTION}/${PROFILE_RKEY}`,
        cid,
        value,
      }],
    };
  }

  if (collection === POST_COLLECTION) {
    let sorted = [...posts];
    if (reverse) sorted.reverse();

    // Cursor-based pagination: cursor is the rkey of the last item from previous page
    if (opts?.cursor) {
      const cursorIdx = sorted.findIndex((p) => postToRkey(p) === opts.cursor);
      if (cursorIdx >= 0) sorted = sorted.slice(cursorIdx + 1);
    }

    const page = sorted.slice(0, limit);
    const records = await Promise.all(page.map(async (post) => {
      const value = postToRecord(post);
      const cid = await computeRecordCid(value);
      return {
        uri: `at://${did}/${POST_COLLECTION}/${postToRkey(post)}`,
        cid,
        value,
      };
    }));

    const nextCursor = page.length === limit && sorted.length > limit
      ? postToRkey(page[page.length - 1])
      : undefined;

    return { records, cursor: nextCursor };
  }

  return { records: [] };
}

/** Get the collections present in a projected repo. */
export function getProjectedCollections(agent: StoredAgent | null, posts: StoredPost[]): string[] {
  const cols: string[] = [];
  if (agent) cols.push(PROFILE_COLLECTION);
  if (posts.length > 0) cols.push(POST_COLLECTION);
  return cols;
}
