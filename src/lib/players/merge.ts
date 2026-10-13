/**
 * The identity side of merging two player profiles (platform admins only; the
 * results side is mergePlayerProfiles in src/lib/friendly/ops.ts).
 *
 * The survivor takes the absorbed profile's Move Score account (auth_user_id), its
 * mobile and email when it has none, the messaging consents it has no answer for,
 * its ranking categories, its open organiser link offers, and its place in every
 * organisation (the stronger relation wins: anything but 'matched' beats 'matched').
 * Refused when the two profiles are linked to different accounts: two people, or one
 * person with two accounts, which only they can sort out by unlinking one. "Linked"
 * counts the profile's own account and every account holding one of its entries
 * (player_claims): an entry can be held without its profile (a link the proof did
 * not carry to the profile), and a merge must not hand one person's history to another.
 *
 * Server-only.
 */
import { db } from "../supabase";

interface IdRow {
  id: string;
  auth_user_id: string | null;
  mobile_normalized: string | null;
  email: string | null;
  phone_verified_at: string | null;
  owner_scope_org: string | null;
}
const COLS = "id, auth_user_id, mobile_normalized, email, phone_verified_at, owner_scope_org";

/** The accounts a profile is linked to: its own, and those holding its entries. */
async function accountsOf(profile: IdRow): Promise<Set<string>> {
  const out = new Set<string>(profile.auth_user_id ? [profile.auth_user_id] : []);
  const { data: rows } = await db().from("players").select("id").eq("player_profile_id", profile.id).limit(2000);
  const ids = ((rows ?? []) as { id: string }[]).map((r) => r.id);
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await db().from("player_claims").select("user_id").in("player_id", ids.slice(i, i + 200));
    for (const c of (data ?? []) as { user_id: string }[]) out.add(c.user_id);
  }
  return out;
}

export const MERGE_TWO_ACCOUNTS =
  "These two players are linked to different Move Score accounts. One of them must unlink in the app (Account → Not you?) or have their codes reset before they can be merged.";

async function both(survivorId: string, absorbedId: string): Promise<[IdRow, IdRow] | null> {
  const { data } = await db().from("player_profiles").select(COLS).in("id", [survivorId, absorbedId]);
  const rows = (data ?? []) as IdRow[];
  const s = rows.find((r) => r.id === survivorId);
  const a = rows.find((r) => r.id === absorbedId);
  return s && a ? [s, a] : null;
}

export type MergePlan = { ok: true; survivor: IdRow; absorbed: IdRow } | { ok: false; error: string };

/** Read before anything moves: whether the two may be merged, and their identity fields. */
export async function planMerge(survivorId: string, absorbedId: string): Promise<MergePlan> {
  if (survivorId === absorbedId) return { ok: false, error: "Cannot merge a player into themselves" };
  const pair = await both(survivorId, absorbedId);
  if (!pair) return { ok: false, error: "Both players must exist" };
  const [s, a] = pair;
  if (s.auth_user_id && a.auth_user_id && s.auth_user_id !== a.auth_user_id) return { ok: false, error: MERGE_TWO_ACCOUNTS };
  const [accS, accA] = await Promise.all([accountsOf(s), accountsOf(a)]);
  if (accS.size && accA.size && new Set([...accS, ...accA]).size > 1) return { ok: false, error: MERGE_TWO_ACCOUNTS };
  return { ok: true, survivor: s, absorbed: a };
}

/** Run after mergePlayerProfiles (which frees the absorbed mobile and marks it merged), with the plan read before it. */
export async function mergeIdentity(plan: Extract<MergePlan, { ok: true }>): Promise<void> {
  const { survivor: s, absorbed: a } = plan;
  const survivorId = s.id;
  const absorbedId = a.id;
  const now = new Date().toISOString();

  // The account: the absorbed profile lets go first (one profile per account).
  const patch: Record<string, unknown> = { updated_at: now };
  if (!s.auth_user_id && a.auth_user_id) {
    await db().from("player_profiles").update({ auth_user_id: null, owner_scope_org: null, updated_at: now }).eq("id", absorbedId);
    patch.auth_user_id = a.auth_user_id;
    // An account that had only one organisation's word for the absorbed profile keeps only that.
    patch.owner_scope_org = a.owner_scope_org;
  }
  if (!s.email && a.email) patch.email = a.email;
  // The absorbed mobile was freed by mergePlayerProfiles; the plan remembers what it was.
  if (!s.mobile_normalized && a.mobile_normalized) {
    patch.mobile_normalized = a.mobile_normalized;
    if (a.phone_verified_at) patch.phone_verified_at = a.phone_verified_at;
  }
  if (Object.keys(patch).length > 1) {
    const { error } = await db().from("player_profiles").update(patch).eq("id", survivorId);
    if (error) throw new Error(error.message);
  }

  // Consents: the survivor's own answers stand; the absorbed one's fill the gaps.
  const [{ data: sc }, { data: ac }] = await Promise.all([
    db().from("player_consents").select("channel").eq("player_profile_id", survivorId),
    db().from("player_consents").select("*").eq("player_profile_id", absorbedId),
  ]);
  const have = new Set(((sc ?? []) as { channel: string }[]).map((c) => c.channel));
  for (const c of (ac ?? []) as Record<string, unknown>[]) {
    if (have.has(String(c.channel))) continue;
    const { id: _id, ...rest } = c;
    void _id;
    await db().from("player_consents").upsert({ ...rest, player_profile_id: survivorId, updated_at: now }, { onConflict: "player_profile_id,channel" });
  }
  await db().from("player_consents").delete().eq("player_profile_id", absorbedId);

  // Ranking categories (the profile-wide list).
  const { data: cats } = await db().from("player_profile_categories").select("ranking_category_id").eq("player_profile_id", absorbedId);
  for (const c of (cats ?? []) as { ranking_category_id: string }[]) {
    await db().from("player_profile_categories").upsert({ player_profile_id: survivorId, ranking_category_id: c.ranking_category_id }, { onConflict: "player_profile_id,ranking_category_id", ignoreDuplicates: true });
  }
  await db().from("player_profile_categories").delete().eq("player_profile_id", absorbedId);

  // Open organiser offers follow the person.
  await db().from("player_link_offers").update({ player_profile_id: survivorId }).eq("player_profile_id", absorbedId).is("consumed_at", null);

  // Organisations: the survivor joins every organisation of the absorbed profile.
  type OrgRow = { organization_id: string; approval_status: string; notes: string | null; level: string | null; categories: string[] | null; source: string; typed_name: string | null; first_seen: string };
  const cols = "organization_id, approval_status, notes, level, categories, source, typed_name, first_seen";
  const [{ data: so }, { data: ao }] = await Promise.all([
    db().from("organization_players").select(cols).eq("player_profile_id", survivorId),
    db().from("organization_players").select(cols).eq("player_profile_id", absorbedId),
  ]);
  const survivorOrgs = new Map(((so ?? []) as OrgRow[]).map((r) => [r.organization_id, r]));
  for (const r of (ao ?? []) as OrgRow[]) {
    const mine = survivorOrgs.get(r.organization_id);
    if (!mine) {
      await db().from("organization_players").insert({ ...r, player_profile_id: survivorId });
      continue;
    }
    const source = mine.source === "matched" && r.source !== "matched" ? r.source : mine.source;
    const categories = [...new Set([...(mine.categories ?? []), ...(r.categories ?? [])])];
    await db()
      .from("organization_players")
      .update({ source, categories, notes: mine.notes ?? r.notes, level: mine.level ?? r.level, first_seen: mine.first_seen < r.first_seen ? mine.first_seen : r.first_seen, updated_at: now })
      .eq("organization_id", r.organization_id)
      .eq("player_profile_id", survivorId);
  }
}
