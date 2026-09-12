/**
 * Removes storage objects an end-to-end run uploaded.
 *
 * Database rows cascade when a tournament or session is deleted; storage does
 * not, so every run that uploads a photo leaves objects behind unless they are
 * swept explicitly. Pass one or more prefixes:
 *
 *   npx tsx --env-file=.env.local scripts/e2e/lib/cleanup.ts pending/<session-id>
 *   npx tsx --env-file=.env.local scripts/e2e/lib/cleanup.ts players/<tournament-id> --dry-run
 */
import { db } from "../../../src/lib/supabase";

/**
 * Every object at or under a prefix.
 *
 * `list` is not recursive and does not filter: it returns one entry per
 * immediate child, and a child with no `id` is a folder rather than a file — so
 * deleting what it returns directly would remove folder placeholders and leave
 * the actual objects behind.
 */
async function listUnder(prefix: string): Promise<string[]> {
  const slash = prefix.lastIndexOf("/");
  const folder = slash === -1 ? "" : prefix.slice(0, slash);
  const startsWith = slash === -1 ? prefix : prefix.slice(slash + 1);

  const { data, error } = await db().storage.from("media").list(folder, { limit: 1000 });
  if (error) throw new Error(error.message);

  const found: string[] = [];
  for (const entry of data ?? []) {
    if (!entry.name.startsWith(startsWith)) continue;
    const path = folder ? `${folder}/${entry.name}` : entry.name;
    if (entry.id) found.push(path);
    else found.push(...(await listUnder(`${path}/`)));
  }
  return found;
}

export async function removePrefix(prefix: string, dryRun = false): Promise<string[]> {
  const names = await listUnder(prefix);
  if (names.length > 0 && !dryRun) {
    const { error } = await db().storage.from("media").remove(names);
    if (error) throw new Error(error.message);
  }
  return names;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const prefixes = args.filter((a) => !a.startsWith("--"));
  if (prefixes.length === 0) {
    process.stderr.write("usage: cleanup.ts <prefix> [<prefix>...] [--dry-run]\n");
    process.exit(1);
  }
  for (const prefix of prefixes) {
    const names = await removePrefix(prefix, dryRun);
    process.stdout.write(`${dryRun ? "would remove" : "removed"} ${names.length} under ${prefix}\n`);
    for (const n of names) process.stdout.write(`  ${n}\n`);
  }
}

if (process.argv[1]?.endsWith("cleanup.ts")) {
  void main();
}
