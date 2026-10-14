/**
 * Calls a server action the way the browser does (the React reply encoding), for
 * the E2E scripts. Action ids come from the build's manifest, so the script must
 * run against the build it was built with (`npm run build`, then `next start`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_URL } from "./session";

interface ManifestEntry {
  filename: string;
  exportedName: string;
  workers: Record<string, unknown>;
}

let manifest: { node: Record<string, ManifestEntry> } | null = null;

function target(file: string, name: string, params: Record<string, string>): { id: string; page: string } {
  manifest ??= JSON.parse(readFileSync(join(process.cwd(), ".next/server/server-reference-manifest.json"), "utf8")) as { node: Record<string, ManifestEntry> };
  // A build with a Turbopack root above the project (a git worktree) names files from that root: "<dir>/src/…".
  const hit = Object.entries(manifest.node).find(([, e]) => (e.filename === file || e.filename.endsWith(`/${file}`)) && e.exportedName === name);
  if (!hit) throw new Error(`no server action ${file}#${name} in the build manifest (rebuild?)`);
  const worker = Object.keys(hit[1].workers).sort((a, b) => a.split("[").length - b.split("[").length)[0]!;
  let page = worker.replace(/^app/, "").replace(/\/page$/, "");
  for (const [k, v] of Object.entries(params)) page = page.replace(`[${k}]`, v);
  return { id: hit[0], page: page || "/" };
}

export function form(o: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.append(k, v);
  return f;
}

export async function callAction(file: string, name: string, args: unknown[], headers: Record<string, string>, params: Record<string, string> = {}) {
  const { id, page } = target(file, name, params);
  let body: string | FormData;
  const h: Record<string, string> = { "Next-Action": id, Accept: "text/x-component", Origin: BASE_URL, ...headers };
  if (args.some((a) => a instanceof FormData)) {
    const fd = new FormData();
    let n = 1;
    const model = args.map((a) => {
      if (!(a instanceof FormData)) return a === undefined ? "$undefined" : a;
      const k = n++;
      a.forEach((v, key) => fd.append(`_${k}_${key}`, v));
      return `$K${k.toString(16)}`;
    });
    fd.set("0", JSON.stringify(model));
    body = fd;
  } else {
    body = JSON.stringify(args);
    h["Content-Type"] = "text/plain;charset=UTF-8";
  }
  const res = await fetch(`${BASE_URL}${page}`, { method: "POST", headers: h, body, redirect: "manual" });
  return { status: res.status, text: await res.text() };
}

/** An action that did its work answers 200 (or a 303 redirect) without an error in its payload. */
export const actionOk = (r: { status: number; text: string }) => (r.status === 200 || r.status === 303) && !/"digest"|Not found|Not allowed/.test(r.text);
