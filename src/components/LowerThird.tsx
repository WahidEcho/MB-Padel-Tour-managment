import SponsorRotator from "./SponsorRotator";
import type { Tournament } from "@/lib/types";

export default function LowerThird({ tournament, big = false }: { tournament: Tournament; big?: boolean }) {
  const b = tournament.branding_config;
  return (
    <div className={`flex items-center justify-between gap-4 border-t border-border bg-card px-4 ${big ? "py-3" : "py-2"}`}>
      <div className="flex items-center gap-3">
        {b.moveBeyondLogoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={b.moveBeyondLogoUrl} alt="Move Beyond" className={big ? "h-10" : "h-6"} />
        )}
        {b.clientLogoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={b.clientLogoUrl} alt="Client" className={big ? "h-10" : "h-6"} />
        )}
        <p className={`font-semibold ${big ? "text-xl" : "text-xs"}`}>{tournament.lower_third_text}</p>
      </div>
      <SponsorRotator logos={b.sponsorLogoUrls ?? []} className={big ? "h-12" : "h-8"} />
    </div>
  );
}
