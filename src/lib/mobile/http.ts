import { NextResponse } from "next/server";

/**
 * A response every phone may share. The CDN keeps it for `sMaxAge` seconds and
 * serves the old copy while it refreshes, so a thousand phones polling the same
 * URL become about one request to the server per window. Public routes must not
 * read cookies or auth headers, or the response would not be shareable.
 */
export function publicJson(data: unknown, sMaxAge: number, staleWhileRevalidate: number, status = 200) {
  return NextResponse.json(data, {
    status,
    headers: {
      "Cache-Control": `public, max-age=0, s-maxage=${sMaxAge}, stale-while-revalidate=${staleWhileRevalidate}, stale-if-error=120`,
    },
  });
}

/** A response for one person: never stored anywhere on the way. */
export function privateJson(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "private, no-store" } });
}

export function notFoundJson(what = "Not found") {
  return NextResponse.json({ error: what }, { status: 404, headers: { "Cache-Control": "public, max-age=0, s-maxage=30" } });
}

const memoStore = new Map<string, { at: number; value: Promise<unknown> }>();

/**
 * Keeps a result in this server instance for `ttlMs`, and shares one in-flight
 * query between requests that arrive together. Under load the CDN absorbs most
 * traffic; this absorbs the burst of misses at the moment a cached copy expires.
 */
export function memo<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = memoStore.get(key);
  if (hit && now - hit.at < ttlMs) return hit.value as Promise<T>;
  const value = fn().catch((err) => {
    memoStore.delete(key);
    throw err;
  });
  memoStore.set(key, { at: now, value });
  if (memoStore.size > 500) {
    for (const [k, v] of memoStore) if (now - v.at > 60_000) memoStore.delete(k);
  }
  return value;
}

export async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}
