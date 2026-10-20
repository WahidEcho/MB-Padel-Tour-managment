/**
 * The web /login as a browser without JavaScript posts it (the forms' progressive
 * enhancement: a hidden `$ACTION_ID_<id>` field), with a cookie jar. Used to check the
 * referee's code → name + PIN steps and the carry-over cookies across court switches.
 */
import { BASE_URL } from "./session";

export type Jar = Map<string, string>;

export const jarCookie = (j: Jar): Record<string, string> => (j.size ? { Cookie: [...j].map(([k, v]) => `${k}=${v}`).join("; ") } : {});

function eat(j: Jar, res: Response) {
  for (const c of res.headers.getSetCookie()) {
    const kv = c.split(";")[0];
    const i = kv.indexOf("=");
    const k = kv.slice(0, i).trim();
    const v = kv.slice(i + 1);
    if (!v || /max-age=0\b/i.test(c)) j.delete(k);
    else j.set(k, v);
  }
}

/** The action id of the form on the page that has an input named `field`. */
export function actionIn(html: string, field: string): string | null {
  for (const part of html.split("<form").slice(1)) {
    const body = part.slice(0, part.indexOf("</form>") > 0 ? part.indexOf("</form>") : undefined);
    if (!body.includes(`name="${field}"`)) continue;
    const m = /name="\$ACTION_ID_([0-9a-f]+)"/.exec(body);
    if (m) return m[1];
  }
  return null;
}

export async function getPage(j: Jar, path: string): Promise<{ status: number; html: string; location: string | null }> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: jarCookie(j), redirect: "manual" });
  eat(j, res);
  return { status: res.status, html: await res.text(), location: res.headers.get("location") };
}

export async function postForm(j: Jar, path: string, actionId: string, fields: Record<string, string>): Promise<{ status: number; location: string | null; text: string }> {
  const fd = new FormData();
  fd.append(`$ACTION_ID_${actionId}`, "");
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const res = await fetch(`${BASE_URL}${path}`, { method: "POST", body: fd, headers: { ...jarCookie(j), Origin: BASE_URL }, redirect: "manual" });
  eat(j, res);
  return { status: res.status, location: res.headers.get("location"), text: await res.text() };
}

/** Step one: the code. Returns where the server sent the browser (the PIN step for a referee code). */
export async function webCode(j: Jar, code: string, fields: Record<string, string> = {}) {
  const page = await getPage(j, "/login?switch=1");
  const id = actionIn(page.html, "password");
  if (!id) throw new Error(`no code form on /login (status ${page.status})`);
  return postForm(j, "/login?switch=1", id, { password: code, next: "", pending: "", open: "", scoring_device: "", ...fields });
}

/** Step two: the name and the PIN, on the page step one sent the browser to. */
export async function webPin(j: Jar, pinPath: string, refereeId: string, pin: string, fields: Record<string, string> = {}) {
  const page = await getPage(j, pinPath);
  const id = actionIn(page.html, "pin");
  if (!id) throw new Error(`no PIN form on ${pinPath} (status ${page.status})`);
  const done = await postForm(j, pinPath, id, { referee_id: refereeId, pin, next: "", court: "", pending: "", open: "", scoring_device: "", ...fields });
  return { page, done };
}

/** Both steps. */
export async function webSignIn(j: Jar, code: string, refereeId: string, pin: string, fields: Record<string, string> = {}) {
  const first = await webCode(j, code, fields);
  if (!first.location?.includes("pin=1")) return { first, page: null, done: null };
  const { page, done } = await webPin(j, first.location.replace(BASE_URL, ""), refereeId, pin, fields);
  return { first, page, done };
}
