/* eslint-disable @next/next/no-img-element -- print sheets: plain images print reliably */
import { BRAND, textOn, type EventBrand } from "@/lib/brand/brand";

/**
 * The branded band and foot of a printed page or card (court QR sheet, coach cards,
 * match QR): Move Score's lockup and Move Beyond's logo on navy, the event's and the
 * organisation's logos on white chips, a stripe of the event's colour; at the foot the
 * event's sponsors (small) and "Move Score by Move Beyond · tour.mbeg.org".
 * Backgrounds print (print-color-adjust: exact).
 */
export function BrandBand({ brand, compact = false, label }: { brand: EventBrand; compact?: boolean; label?: string }) {
  const h = compact ? "8mm" : "11mm";
  return (
    <div className="brand-band" data-testid="brand-band" style={{ background: BRAND.navy, borderBottom: `${compact ? 1.5 : 2.5}mm solid ${brand.primary}`, padding: compact ? "2mm 4mm" : "3mm 5mm", display: "flex", alignItems: "center", gap: "4mm", WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" }}>
      <img src={BRAND.lockup} alt={BRAND.product} style={{ height: h, width: "auto" }} data-testid="brand-move-score" />
      {label && <span style={{ color: "#fff", fontWeight: 800, fontSize: compact ? "9pt" : "11pt", letterSpacing: "0.12em", textTransform: "uppercase", opacity: 0.85 }}>{label}</span>}
      <span style={{ flex: 1 }} />
      {[brand.eventLogo, brand.orgLogo].filter(Boolean).map((l) => (
        <span key={l!.url} style={{ background: "#fff", borderRadius: "1.5mm", padding: "0.8mm 1.5mm", display: "flex", alignItems: "center" }}>
          <img src={l!.url} alt={l!.name} style={{ height: `calc(${h} - 1.6mm)`, width: "auto", maxWidth: "30mm", objectFit: "contain" }} data-testid="brand-event-logo" />
        </span>
      ))}
      <img src={BRAND.moveBeyondWhite} alt={BRAND.maker} style={{ height: h, width: "auto" }} data-testid="brand-move-beyond" />
    </div>
  );
}

/** The event's name on its colour (under the band). */
export function BrandTitle({ brand, size = "11pt" }: { brand: EventBrand; size?: string }) {
  return (
    <p data-testid="brand-event" style={{ margin: 0, padding: "1.2mm 5mm", background: brand.primary, color: textOn(brand.primary), fontSize: size, fontWeight: 800, letterSpacing: "0.04em", WebkitPrintColorAdjust: "exact", printColorAdjust: "exact" }}>
      {brand.eventName}
      {brand.subtitle ? <span style={{ fontWeight: 600, opacity: 0.85 }}> · {brand.subtitle}</span> : null}
    </p>
  );
}

/** The foot: sponsors (small) and the footer line. */
export function BrandFoot({ brand, sponsors = true, compact = false }: { brand: EventBrand; sponsors?: boolean; compact?: boolean }) {
  const list = sponsors ? brand.sponsors : [];
  return (
    <div data-testid="brand-foot" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "1.5mm", paddingTop: compact ? "1mm" : "2mm", borderTop: "0.3mm solid #d4d4d8" }}>
      {list.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", alignItems: "center", gap: compact ? "3mm" : "5mm" }} data-testid="brand-sponsors">
          {list.map((s) => (
            <img key={s.url} src={s.url} alt={s.name} style={{ height: compact ? "5.5mm" : "8mm", width: "auto", maxWidth: "28mm", objectFit: "contain" }} />
          ))}
        </div>
      )}
      <p style={{ margin: 0, fontSize: compact ? "7pt" : "8.5pt", color: BRAND.muted, letterSpacing: "0.03em" }} data-testid="brand-footer-line">
        {BRAND.footer}
        {brand.orgName && brand.orgName !== BRAND.maker ? ` · Organised by ${brand.orgName}` : ""}
      </p>
    </div>
  );
}
