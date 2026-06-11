import { createClient, SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

// Server-side only client. The key must never be shipped to the browser:
// all reads/writes go through server components and route handlers.
export function db(): SupabaseClient {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_KEY must be set");
    client = createClient(url, key, { auth: { persistSession: false } });
  }
  return client;
}

export function mediaPublicUrl(path: string): string {
  return `${process.env.SUPABASE_URL}/storage/v1/object/public/media/${path}`;
}
