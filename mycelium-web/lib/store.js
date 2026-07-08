// Shared submission store (Upstash Redis). Submissions are keyed per tree so a
// pull only fetches one event's contacts. Env: UPSTASH_REDIS_REST_URL /
// UPSTASH_REDIS_REST_TOKEN (auto-injected by the Vercel Upstash integration).
import { Redis } from "@upstash/redis";

export const redis = Redis.fromEnv();

const key = (treeId) => `mycelium:tree:${treeId}`;

// Append a submission to a tree's list. `sub` already has id/createdAt.
export async function addSubmission(treeId, sub) {
  await redis.rpush(key(treeId), JSON.stringify(sub));
}

// Read every submission for a tree (newest last).
export async function listSubmissions(treeId) {
  const rows = await redis.lrange(key(treeId), 0, -1);
  return rows.map((r) => (typeof r === "string" ? JSON.parse(r) : r));
}

// Clear a tree's submissions (called after a successful pull-and-consume).
export async function clearSubmissions(treeId) {
  await redis.del(key(treeId));
}
