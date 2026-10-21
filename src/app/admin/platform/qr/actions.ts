"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/supabase";
import { requirePlatformPermission } from "@/lib/guard";
import { audit } from "@/lib/audit";
import { refusal, formResult, type FormState } from "@/lib/refusal";
import { QR_CODE_NAME, QR_LINKS_KEY, normalizeTarget, parseQrLinks } from "@/lib/platform/qrLinks";

const PATH = "/admin/platform/qr";

/**
 * Points a QR code at a new address, or adds a code. Codes are never removed:
 * one that has been printed must keep working.
 */
export async function saveQrLink(_prev: FormState, formData: FormData): Promise<FormState> {
  return formResult(async () => {
    const role = (await requirePlatformPermission()).role;
    const code = String(formData.get("code") ?? "").trim().toLowerCase();
    if (!QR_CODE_NAME.test(code)) refusal("A code is lower-case letters, numbers and dashes, up to 40.");
    const target = normalizeTarget(String(formData.get("target") ?? ""));
    if (!target) refusal("Give a full https:// address, or a path on this site such as /app.");
    const { data } = await db().from("platform_settings").select("value_json").eq("key", QR_LINKS_KEY).maybeSingle();
    const links = parseQrLinks((data as { value_json: unknown } | null)?.value_json);
    const label = String(formData.get("label") ?? "").trim().slice(0, 80) || links[code]?.label || code;
    const before = links[code]?.target ?? null;
    links[code] = { target: target!, label };
    const { error } = await db()
      .from("platform_settings")
      .upsert({ key: QR_LINKS_KEY, value_json: links, updated_at: new Date().toISOString(), updated_by: role }, { onConflict: "key" });
    if (error) refusal(error.message);
    await audit({ actor_role: role, action: "QR_LINK_SET", entity_type: "platform_settings", old_value: { code, target: before }, new_value: { code, target } });
    revalidatePath(PATH);
    return `/q/${code} now opens ${target}.`;
  });
}
