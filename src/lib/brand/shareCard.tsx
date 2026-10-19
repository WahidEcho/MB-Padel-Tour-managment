/* eslint-disable @next/next/no-img-element -- Satori draws plain <img> */
/**
 * Share images (owner's decision, 20 Oct 2026): a branded PNG, 1080×1350 (a phone
 * portrait post), of a team's coach card or a court's QR card, for the organiser to
 * download and send (e.g. on WhatsApp). Drawn server-side with next/og (Satori + Resvg):
 * the navy band with Move Score's lockup and Move Beyond's logo (plus the event's and the
 * organisation's logos), the event's name on its colour, the QR and the code, short
 * instructions, sponsors and the footer line. Every image is inlined as a data: URI, so
 * nothing is fetched while drawing.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import QRCode from "qrcode";
import { BRAND, textOn, type EventBrand } from "./brand";
import { dataUri, imageBytes } from "./server";

export const SHARE_SIZE = { width: 1080, height: 1350 } as const;

let fontsP: Promise<{ name: string; data: Buffer; weight: 400 | 700 | 900; style: "normal" }[]> | null = null;
function fonts() {
  fontsP ??= Promise.all([
    readFile(join(process.cwd(), "public", "brand", "fonts", "Geist-Regular.ttf")),
    readFile(join(process.cwd(), "public", "brand", "fonts", "Archivo-ExpandedBold.ttf")),
    readFile(join(process.cwd(), "public", "brand", "fonts", "Archivo-ExpandedBlack.ttf")),
  ]).then(([regular, bold, black]) => [
    { name: "Geist", data: regular, weight: 400 as const, style: "normal" as const },
    { name: "Archivo", data: bold, weight: 700 as const, style: "normal" as const },
    { name: "Archivo", data: black, weight: 900 as const, style: "normal" as const },
  ]);
  return fontsP;
}

async function flagUri(iso2: string | null): Promise<string | null> {
  if (!iso2 || !/^[a-z]{2}(-[a-z]+)?$/i.test(iso2)) return null;
  try {
    const svg = await readFile(join(process.cwd(), "public", "flags", `${iso2.toLowerCase()}.svg`));
    return `data:image/svg+xml;base64,${svg.toString("base64")}`;
  } catch {
    return null;
  }
}

export interface ShareCardInput {
  brand: EventBrand;
  /** "Team coach" / "Referee scoring" (on the band). */
  kind: string;
  /** The big name: the team or the court. */
  heading: string;
  iso2?: string | null;
  /** Under the heading: "Team coach access · EGY". */
  subheading: string;
  /** The QR's content (the /c# or /r# link). */
  link: string;
  /** The code as typed ("ABCD-EFGH-JKLM"). */
  code: string;
  steps: string[];
  validity: string;
  fileName: string;
}

/** The PNG response (private, never cached, downloaded under `fileName`). */
export async function shareCardResponse(i: ShareCardInput): Promise<Response> {
  const b = i.brand;
  const [f, lockup, mb, ev, org, flag, qr, ...sponsors] = await Promise.all([
    fonts(),
    imageBytes(BRAND.lockup),
    imageBytes(BRAND.moveBeyondWhite),
    imageBytes(b.eventLogo?.url, 200),
    imageBytes(b.orgLogo?.url, 200),
    flagUri(i.iso2 ?? null),
    QRCode.toDataURL(i.link, { margin: 1, width: 640, errorCorrectionLevel: "M", color: { dark: "#05060aff", light: "#ffffffff" } }),
    ...b.sponsors.slice(0, 6).map((s) => imageBytes(s.url, 120)),
  ]);
  const chip = (img: ReturnType<typeof dataUri>, w: number, h: number) =>
    img ? (
      <div style={{ display: "flex", background: "#fff", borderRadius: 14, padding: "8px 12px", alignItems: "center" }}>
        <img src={img} width={w} height={h} style={{ objectFit: "contain" }} alt="" />
      </div>
    ) : null;
  const logoW = (x: { width: number; height: number } | null, h: number) => (x ? Math.min(200, Math.round((h * x.width) / Math.max(1, x.height))) : 0);
  const sp = sponsors.filter(Boolean) as NonNullable<(typeof sponsors)[number]>[];
  const onPrimary = textOn(b.primary);

  const el = (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "#ffffff", fontFamily: "Geist", color: BRAND.ink }}>
      {/* The band */}
      <div style={{ display: "flex", alignItems: "center", background: BRAND.navy, padding: "34px 48px", borderBottom: `14px solid ${b.primary}`, gap: 22 }}>
        {lockup && <img src={dataUri(lockup)!} width={Math.round(64 * BRAND.lockupAspect)} height={64} alt="" />}
        <div style={{ display: "flex", flex: 1 }} />
        {chip(dataUri(ev), logoW(ev, 56), 56)}
        {chip(dataUri(org), logoW(org, 56), 56)}
        {mb && <img src={dataUri(mb)!} width={Math.round(70 * BRAND.moveBeyondAspect)} height={70} alt="" />}
      </div>
      {/* The event */}
      <div style={{ display: "flex", flexDirection: "column", background: b.primary, color: onPrimary, padding: "18px 48px" }}>
        <div style={{ display: "flex", fontFamily: "Archivo", fontWeight: 900, fontSize: 34, lineHeight: 1.15 }}>{b.eventName}</div>
        {b.subtitle && <div style={{ display: "flex", fontFamily: "Archivo", fontWeight: 700, fontSize: 24, opacity: 0.85 }}>{b.subtitle}</div>}
      </div>
      {/* The card */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1, padding: "30px 56px 0" }}>
        <div style={{ display: "flex", fontFamily: "Archivo", fontWeight: 700, fontSize: 22, letterSpacing: 6, color: BRAND.muted }}>{i.kind.toUpperCase()}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 22, marginTop: 10 }}>
          {flag && <img src={flag} width={96} height={72} style={{ borderRadius: 8, border: "2px solid #e4e4e7", objectFit: "cover" }} alt="" />}
          <div style={{ display: "flex", fontFamily: "Archivo", fontWeight: 900, fontSize: i.heading.length > 16 ? 56 : 72, lineHeight: 1.05 }}>{i.heading}</div>
        </div>
        <div style={{ display: "flex", fontSize: 28, marginTop: 8, color: BRAND.muted }}>{i.subheading}</div>
        <div style={{ display: "flex", marginTop: 22, padding: 14, borderRadius: 28, border: `6px solid ${BRAND.navy}` }}>
          <img src={qr} width={430} height={430} alt="" />
        </div>
        <div style={{ display: "flex", fontFamily: "Archivo", fontWeight: 900, fontSize: 52, letterSpacing: 6, marginTop: 18 }}>{i.code}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 14, width: "100%" }}>
          {i.steps.map((s, n) => (
            <div key={n} style={{ display: "flex", gap: 14, fontSize: 25, lineHeight: 1.3 }}>
              <div style={{ display: "flex", width: 38, height: 38, borderRadius: 19, background: BRAND.navy, color: BRAND.ball, alignItems: "center", justifyContent: "center", fontFamily: "Archivo", fontWeight: 900, fontSize: 20, flexShrink: 0 }}>{n + 1}</div>
              <div style={{ display: "flex", flex: 1 }}>{s}</div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", fontSize: 20, color: BRAND.muted, marginTop: 12 }}>{i.validity}</div>
      </div>
      {/* The foot */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: "16px 48px 26px", borderTop: "2px solid #e4e4e7" }}>
        {sp.length > 0 && (
          <div style={{ display: "flex", gap: 30, alignItems: "center", justifyContent: "center" }}>
            {sp.map((s, n) => (
              <img key={n} src={dataUri(s)!} width={Math.min(170, Math.round((52 * s.width) / Math.max(1, s.height)))} height={52} style={{ objectFit: "contain" }} alt="" />
            ))}
          </div>
        )}
        <div style={{ display: "flex", fontSize: 22, color: BRAND.muted }}>
          {BRAND.footer}
          {b.orgName && b.orgName !== BRAND.maker ? ` · Organised by ${b.orgName}` : ""}
        </div>
      </div>
    </div>
  );
  const res = new ImageResponse(el, {
    ...SHARE_SIZE,
    fonts: await f,
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="${i.fileName.replace(/[^\w.-]+/g, "-")}"`,
    },
  });
  // Rendered now, so a drawing error answers 500 here instead of a broken stream.
  const png = await res.arrayBuffer();
  return new Response(png, { headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store", "Content-Disposition": `attachment; filename="${i.fileName.replace(/[^\w.-]+/g, "-")}"` } });
}
