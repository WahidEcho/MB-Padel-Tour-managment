import QRCode from "qrcode";
import StateForm from "@/components/StateForm";
import { db } from "@/lib/supabase";
import { requirePlatformPage } from "@/lib/guard";
import { siteUrl } from "@/lib/messaging/links";
import { QR_LINKS_KEY, parseQrLinks } from "@/lib/platform/qrLinks";
import { saveQrLink } from "./actions";

export const dynamic = "force-dynamic";

/** Print-ready: high error correction (a scratch or a logo over 30% still scans), black on white, a wide quiet zone. */
const PRINT = { errorCorrectionLevel: "H", margin: 4, color: { dark: "#000000", light: "#ffffff" } } as const;

/**
 * Permanent QR codes. Each code's address (tour.mbeg.org/q/…) is fixed for good;
 * where it forwards to is changed here, and takes effect on the next scan.
 */
export default async function QrLinksPage() {
  await requirePlatformPage("/admin/platform/qr");
  const { data } = await db().from("platform_settings").select("value_json").eq("key", QR_LINKS_KEY).maybeSingle();
  const links = parseQrLinks((data as { value_json: unknown } | null)?.value_json);
  const rows = await Promise.all(
    Object.entries(links).map(async ([code, link]) => {
      const url = `${siteUrl()}/q/${code}`;
      const [svg, png] = await Promise.all([
        QRCode.toString(url, { ...PRINT, type: "svg" }),
        QRCode.toDataURL(url, { ...PRINT, width: 2000 }),
      ]);
      return { code, link, url, svg, png };
    }),
  );
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">QR codes</h1>
        <p className="text-sm text-muted">
          A printed code never changes and never expires: it opens its fixed address on this site, which forwards to the
          address set here. Change the address and the next scan goes there — no reprinting.
        </p>
      </div>
      {rows.map(({ code, link, url, svg, png }) => (
        <section key={code} className="card grid gap-4 sm:grid-cols-[14rem_1fr]" data-testid="qr-link">
          <div className="space-y-2">
            <div className="rounded-lg bg-white p-1" dangerouslySetInnerHTML={{ __html: svg }} />
            <div className="flex gap-3 text-xs font-semibold">
              <a className="text-accent underline" href={png} download={`qr-${code}.png`}>PNG (print)</a>
              <a className="text-accent underline" href={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`} download={`qr-${code}.svg`}>SVG (any size)</a>
            </div>
          </div>
          <div className="space-y-3">
            <div>
              <p className="font-bold">{link.label}</p>
              <p className="font-mono text-sm">{url}</p>
              <p className="text-sm text-muted">
                Opens now: <a className="text-accent underline" href={link.target} target="_blank" rel="noreferrer">{link.target}</a>
              </p>
            </div>
            <StateForm action={saveQrLink} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="code" value={code} />
              <input type="hidden" name="label" value={link.label} />
              <label className="text-xs">
                <span className="label">Send this code to</span>
                <input name="target" defaultValue={link.target} className="input w-80 max-w-full" required />
              </label>
              <button type="submit" className="btn-primary">Save</button>
            </StateForm>
          </div>
        </section>
      ))}
      <section className="card space-y-2">
        <p className="font-bold">New QR code</p>
        <StateForm action={saveQrLink} className="flex flex-wrap items-end gap-2">
          <label className="text-xs">
            <span className="label">Code (in the address)</span>
            <input name="code" className="input w-40" placeholder="venue-map" required />
          </label>
          <label className="text-xs">
            <span className="label">What it is for</span>
            <input name="label" className="input w-56" placeholder="Venue map signs" />
          </label>
          <label className="text-xs">
            <span className="label">Send it to</span>
            <input name="target" className="input w-80 max-w-full" placeholder="https://… or /t/…" required />
          </label>
          <button type="submit" className="btn-secondary">Add</button>
        </StateForm>
      </section>
    </div>
  );
}
