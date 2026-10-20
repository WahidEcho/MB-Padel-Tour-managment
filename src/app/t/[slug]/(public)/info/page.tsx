import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { publicEventInfoBySlug } from "@/lib/eventInfo/server";
import { dateSpan, dayLabel, hoursLine, openLabel, openState, todayHours } from "@/lib/eventInfo/hours";
import { mailLink, telLink, whatsAppLink } from "@/lib/eventInfo/links";
import { displayPhone } from "@/lib/players/phone";

/**
 * /t/<slug>/info: the event info for fans on the web, the same content as the
 * app's Event info screen. Plain text only (the sanitiser removed any markup);
 * the "Open now" chip is worked out on the venue's clock when the page renders.
 */
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const info = await publicEventInfoBySlug(slug).catch(() => null);
  return { title: info ? `${info.eventName} · Event info` : "Event info" };
}

/** When this render happens: the chip is worked out for that moment (the page is re-rendered every few seconds). */
function renderedAt(): number {
  return Date.now();
}

function Paragraphs({ text }: { text: string }) {
  return (
    <>
      {text.split("\n\n").map((p, i) => (
        <p key={i} className="whitespace-pre-line text-sm">
          {p}
        </p>
      ))}
    </>
  );
}

function Block({ title, children, open = false, testId }: { title: string; children: React.ReactNode; open?: boolean; testId?: string }) {
  return (
    <details className="card group" open={open} data-testid={testId}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 font-bold">
        {title}
        <span className="text-muted transition group-open:rotate-90">›</span>
      </summary>
      <div className="mt-3 space-y-2">{children}</div>
    </details>
  );
}

export default async function EventInfoPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const info = await publicEventInfoBySlug(slug);
  if (!info) notFound();
  const now = renderedAt();
  const state = openState(info.hours, now, info.timezone);
  const today = todayHours(info.hours, now, info.timezone);
  const e = info.entry;
  const d = info.directions;
  const span = dateSpan(info.startsOn, info.endsOn);
  const mapHref = (place?: string) => (info.map ? `/t/${slug}/map${place ? `?focus=${encodeURIComponent(place)}` : ""}` : null);
  const tiles: { label: string; href: string | null; external?: boolean }[] = [
    { label: "Directions", href: info.links.google, external: true },
    { label: "Parking", href: mapHref(info.map?.places.parking) ?? (info.parking ? "#parking" : null) },
    { label: "Food & drinks", href: mapHref(info.map?.places.food) ?? (info.food ? "#food" : null) },
    { label: "Toilets", href: info.map?.places.toilets ? mapHref(info.map.places.toilets) : null },
    { label: "Medical", href: info.map?.places.medical ? mapHref(info.map.places.medical) : null },
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-4" data-testid="event-info">
      <section className="card space-y-2 bg-gradient-to-br from-accent/15 to-transparent">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted">Event info</p>
        <h2 className="text-2xl font-black">{info.eventName}</h2>
        <p className="text-sm text-muted">{[span, [info.venueName, info.city].filter(Boolean).join(", ")].filter(Boolean).join(" · ")}</p>
        {info.intro && <p className="text-sm">{info.intro}</p>}
        <div className="flex flex-wrap gap-2 pt-1">
          {state && (
            <span className={`badge font-bold ${state.kind === "open" ? (state.closingSoon ? "bg-warning/15 text-warning" : "bg-success/15 text-success") : "bg-card text-muted"}`} data-testid="event-info-open">
              {state.kind === "open" ? "● " : ""}
              {openLabel(state)}
            </span>
          )}
          {e.admission && <span className="badge bg-card">{e.admission === "free" ? "Free entry" : "Tickets needed"}</span>}
        </div>
      </section>

      <nav className="grid grid-cols-2 gap-3 sm:grid-cols-5" aria-label="Quick links">
        {tiles
          .filter((t) => t.href)
          .map((t) => (
            <a key={t.label} href={t.href!} {...(t.external ? { target: "_blank", rel: "noreferrer" } : {})} className="card text-center text-sm font-bold hover:border-accent">
              {t.label}
            </a>
          ))}
      </nav>

      {info.hours.length > 0 && (
        <Block title={today ? `Today · ${hoursLine(today)}` : "Opening hours"} open testId="event-info-hours">
          <ul className="divide-y divide-border text-sm">
            {info.hours.map((h) => (
              <li key={h.date} className={`flex justify-between gap-3 py-1.5 ${today?.date === h.date ? "font-bold" : ""}`}>
                <span>{dayLabel(h.date)}</span>
                <span className="text-right">
                  {hoursLine(h)}
                  {h.note && <span className="block text-xs font-normal text-muted">{h.note}</span>}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted">Times in {info.timezone}.</p>
        </Block>
      )}

      {(e.admission || e.ticketsNote || e.ticketsUrl || e.allowed.length || e.notAllowed.length || e.kids || e.photography || e.other) && (
        <Block title="Getting in" open testId="event-info-entry">
          {e.admission && <p className="text-sm font-semibold">{e.admission === "free" ? "Entry is free." : "You need a ticket."}</p>}
          {e.ticketsNote && <Paragraphs text={e.ticketsNote} />}
          {e.ticketsUrl && (
            <a href={e.ticketsUrl} target="_blank" rel="noreferrer" className="btn-primary inline-block text-sm">
              Get tickets ↗
            </a>
          )}
          {(e.allowed.length > 0 || e.notAllowed.length > 0) && (
            <div className="grid gap-3 sm:grid-cols-2">
              {e.allowed.length > 0 && (
                <div>
                  <p className="label">Allowed</p>
                  <ul className="space-y-1 text-sm">{e.allowed.map((x) => <li key={x}>✓ {x}</li>)}</ul>
                </div>
              )}
              {e.notAllowed.length > 0 && (
                <div>
                  <p className="label">Not allowed</p>
                  <ul className="space-y-1 text-sm">{e.notAllowed.map((x) => <li key={x}>✕ {x}</li>)}</ul>
                </div>
              )}
            </div>
          )}
          {e.kids && (
            <div>
              <p className="label">Kids</p>
              <Paragraphs text={e.kids} />
            </div>
          )}
          {e.photography && (
            <div>
              <p className="label">Photography</p>
              <Paragraphs text={e.photography} />
            </div>
          )}
          {e.other && <Paragraphs text={e.other} />}
        </Block>
      )}

      {(d.address || d.landmark || d.dropOff || d.transit || info.links.google) && (
        <Block title="How to get there" open testId="event-info-directions">
          {d.address && <p className="text-sm font-semibold">{d.address}</p>}
          {d.landmark && <p className="text-sm">Near: {d.landmark}</p>}
          {d.dropOff && (
            <div>
              <p className="label">Taxi / Uber drop-off</p>
              <Paragraphs text={d.dropOff} />
            </div>
          )}
          {d.transit && (
            <div>
              <p className="label">Public transport</p>
              <Paragraphs text={d.transit} />
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {info.links.google && (
              <a href={info.links.google} target="_blank" rel="noreferrer" className="btn-secondary text-xs">
                Google Maps ↗
              </a>
            )}
            {info.links.apple && (
              <a href={info.links.apple} target="_blank" rel="noreferrer" className="btn-secondary text-xs">
                Apple Maps ↗
              </a>
            )}
            {info.map && (
              <Link href={`/t/${slug}/map`} className="btn-secondary text-xs">
                Venue map
              </Link>
            )}
          </div>
        </Block>
      )}

      {info.parking && (
        <section id="parking">
          <Block title="Parking" testId="event-info-parking">
            <Paragraphs text={info.parking} />
          </Block>
        </section>
      )}
      {info.food && (
        <section id="food">
          <Block title="Food & drinks" testId="event-info-food">
            <Paragraphs text={info.food} />
          </Block>
        </section>
      )}

      {info.faqs.length > 0 && (
        <section className="space-y-2" data-testid="event-info-faq">
          <h3 className="px-1 font-bold">FAQ</h3>
          {info.faqs.map((f) => (
            <Block key={f.q} title={f.q}>
              <Paragraphs text={f.a} />
            </Block>
          ))}
        </section>
      )}

      {info.contacts.length > 0 && (
        <section className="card space-y-3" data-testid="event-info-contacts">
          <h3 className="font-bold">Contacts</h3>
          {info.contacts.map((c) => (
            <div key={`${c.label}${c.phone}${c.email}`} className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold">{c.label}</p>
                <p className="text-xs text-muted">{[c.phone ? displayPhone(c.phone) : "", c.email].filter(Boolean).join(" · ")}</p>
              </div>
              <div className="flex gap-2">
                {c.phone && (
                  <a href={telLink(c.phone)} className="btn-secondary text-xs">
                    Call
                  </a>
                )}
                {c.phone && c.whatsapp && (
                  <a href={whatsAppLink(c.phone)} target="_blank" rel="noreferrer" className="btn-secondary text-xs">
                    WhatsApp
                  </a>
                )}
                {c.email && (
                  <a href={mailLink(c.email, info.eventName)} className="btn-secondary text-xs">
                    Email
                  </a>
                )}
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
