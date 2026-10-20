import Link from "next/link";
import { notFound } from "next/navigation";
import { requireTournamentPage } from "@/lib/guard";
import { getTournament } from "@/lib/data";
import StateForm from "@/components/StateForm";
import { EVENT_INFO_LIMITS as L, FORM_ROWS } from "@/lib/eventInfo/clean";
import { dateSpan, dayLabel, eventDays } from "@/lib/eventInfo/hours";
import { eventInfoOwnerOf, readEventInfo } from "@/lib/eventInfo/server";
import type { EventInfoDay } from "@/lib/eventInfo/types";
import { saveEventInfoAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * Event info for fans: entry rules, opening hours, getting there, parking, food,
 * contacts and FAQs, shown in the app (tournament → Event info) and at
 * /t/<slug>/info. The info is the event group's (both Junior Finals events share
 * one) or this tournament's own. The grey placeholders are examples only: hours,
 * prices and rules are left for the organiser to fill in.
 */
export default async function EventInfoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { scope } = await requireTournamentPage(id, ["admin", "manager"], `/admin/tournaments/${id}/event-info`);
  const tournament = await getTournament(id);
  if (!tournament) notFound();
  const owner = await eventInfoOwnerOf(id);
  if (!owner || owner.orgId !== scope.orgId) notFound();
  const doc = await readEventInfo(owner);

  // One row per day of the event, then the stored days outside it, then blanks.
  const stored = new Map((doc?.hours ?? []).map((h) => [h.date, h]));
  const days = [...new Set([...eventDays(owner.startsOn, owner.endsOn), ...stored.keys()])].sort();
  const blank = (date: string): EventInfoDay => ({ date, opens: "", closes: "", note: "", closed: false });
  const hourRows: EventInfoDay[] = days.map((d) => stored.get(d) ?? blank(d));
  while (hourRows.length < Math.min(L.hours, Math.max(FORM_ROWS.hoursMin, days.length + 2))) hourRows.push(blank(""));
  const contacts = Array.from({ length: FORM_ROWS.contacts }, (_, i) => doc?.contacts[i] ?? null);
  const faqCount = Math.min(L.faqs, Math.max(FORM_ROWS.faqsMin, (doc?.faqs.length ?? 0) + 3));
  const faqs = Array.from({ length: faqCount }, (_, i) => doc?.faqs[i] ?? null);
  const e = doc?.entry;
  const d = doc?.directions;
  const span = dateSpan(owner.startsOn, owner.endsOn);
  const place = [owner.venueName, owner.city].filter(Boolean).join(", ");

  return (
    <div className="space-y-4" data-testid="event-info-page">
      <section className="card flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="font-bold">Event info — {owner.label}</h2>
          <p className="text-sm text-muted">
            What a fan needs before coming: getting in, opening hours, directions, parking, food, who to call, and answers to common questions. Shown in
            the Move Score app (tournament → <b>Event info</b>) and at <code>/t/{tournament.slug}/info</code>
            {owner.eventGroupId ? ", the same for every event of the group" : ""}. Grey text in the boxes is only an example; nothing is shown to fans
            until you type it and publish.
          </p>
          <p className="text-xs text-muted">
            {[span, place, `times in ${owner.timezone}`].filter(Boolean).join(" · ")}
            {doc?.updatedAt ? ` · last saved ${new Date(doc.updatedAt).toLocaleString("en-GB", { timeZone: owner.timezone })}` : " · not saved yet"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`badge ${doc?.published ? "bg-success/15 text-success" : "bg-card text-muted"}`} data-testid="event-info-status">
            {doc?.published ? "Published" : doc ? "Draft" : "Not started"}
          </span>
          {doc?.published && (
            <Link href={`/t/${tournament.slug}/info`} target="_blank" className="btn-secondary text-xs">
              Public page ↗
            </Link>
          )}
        </div>
      </section>

      <StateForm action={saveEventInfoAction} className="space-y-4" testId="event-info-form">
        <input type="hidden" name="tournament_id" value={id} />
        <input type="hidden" name="based_on" value={doc?.updatedAt ?? ""} />
        <input type="hidden" name="hours_rows" value={hourRows.length} />
        <input type="hidden" name="faq_rows" value={faqCount} />

        <section className="card space-y-2">
          <p className="label">Welcome line</p>
          <input name="intro" defaultValue={doc?.intro ?? ""} maxLength={L.intro} className="input" placeholder="e.g. Welcome to the Junior Finals! Come and watch the world's best juniors." />
        </section>

        <section className="card space-y-3">
          <h3 className="font-bold">Getting in</h3>
          <div className="flex flex-wrap gap-4 text-sm">
            {[
              ["free", "Free entry"],
              ["tickets", "Tickets needed"],
              ["", "Not said yet"],
            ].map(([value, label]) => (
              <label key={value || "unset"} className="flex items-center gap-2 font-semibold">
                <input type="radio" name="admission" value={value} defaultChecked={(e?.admission ?? "") === value} />
                {label}
              </label>
            ))}
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block">
              <span className="label">Tickets: prices, where to buy, what to show</span>
              <textarea name="tickets_note" defaultValue={e?.ticketsNote ?? ""} maxLength={L.ticketsNote} rows={3} className="input" placeholder="e.g. Day pass EGP … at the gate; show the QR on your phone." />
            </label>
            <label className="block">
              <span className="label">Tickets link (https)</span>
              <input name="tickets_url" defaultValue={e?.ticketsUrl ?? ""} className="input font-mono text-xs" placeholder="https://…" />
            </label>
            <label className="block">
              <span className="label">Allowed (one per line)</span>
              <textarea name="allowed" defaultValue={(e?.allowed ?? []).join("\n")} rows={4} className="input" placeholder={"e.g. Water bottles\nHats and sunscreen\nNational flags"} />
            </label>
            <label className="block">
              <span className="label">Not allowed (one per line)</span>
              <textarea name="not_allowed" defaultValue={(e?.notAllowed ?? []).join("\n")} rows={4} className="input" placeholder={"e.g. Glass bottles\nDrones\nFlash photography during points"} />
            </label>
            <label className="block">
              <span className="label">Kids</span>
              <textarea name="kids" defaultValue={e?.kids ?? ""} maxLength={L.paragraph} rows={2} className="input" placeholder="e.g. Children are welcome with an adult." />
            </label>
            <label className="block">
              <span className="label">Photography and filming</span>
              <textarea name="photography" defaultValue={e?.photography ?? ""} maxLength={L.paragraph} rows={2} className="input" placeholder="e.g. Phones welcome between points; no flash." />
            </label>
            <label className="block md:col-span-2">
              <span className="label">Anything else about getting in</span>
              <textarea name="entry_other" defaultValue={e?.other ?? ""} maxLength={L.paragraph} rows={2} className="input" placeholder="e.g. Bring an ID; re-entry allowed with your wristband." />
            </label>
          </div>
        </section>

        <section className="card space-y-3">
          <h3 className="font-bold">Opening hours</h3>
          <p className="text-xs text-muted">
            In the venue&rsquo;s time ({owner.timezone}), 24 h. The app shows &ldquo;Open now · closes 21:00&rdquo; or &ldquo;Opens tomorrow 09:00&rdquo; from these.
            Leave a day empty to say nothing about it.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="event-info-hours">
              <thead>
                <tr className="text-left text-xs text-muted">
                  <th className="py-1 pr-2">Day</th>
                  <th className="py-1 pr-2">Opens</th>
                  <th className="py-1 pr-2">Closes</th>
                  <th className="py-1 pr-2">Closed</th>
                  <th className="py-1">Note</th>
                </tr>
              </thead>
              <tbody>
                {hourRows.map((h, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="py-1 pr-2">
                      <input type="date" name={`hours_date_${i}`} defaultValue={h.date} className="input w-40" aria-label={`Day ${i + 1}`} />
                      {h.date && <span className="ml-2 text-xs text-muted">{dayLabel(h.date).split(" ")[0]}</span>}
                    </td>
                    <td className="py-1 pr-2">
                      <input type="time" name={`hours_opens_${i}`} defaultValue={h.opens} className="input w-28" aria-label={`Opens, day ${i + 1}`} />
                    </td>
                    <td className="py-1 pr-2">
                      <input type="time" name={`hours_closes_${i}`} defaultValue={h.closes} className="input w-28" aria-label={`Closes, day ${i + 1}`} />
                    </td>
                    <td className="py-1 pr-2">
                      <input type="checkbox" name={`hours_closed_${i}`} defaultChecked={h.closed} aria-label={`Closed, day ${i + 1}`} />
                    </td>
                    <td className="py-1">
                      <input name={`hours_note_${i}`} defaultValue={h.note} maxLength={L.dayNote} className="input" placeholder={i === 0 ? "e.g. Gates open 30 min before play" : ""} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card space-y-3">
          <h3 className="font-bold">How to get there</h3>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block md:col-span-2">
              <span className="label">Address</span>
              <input name="address" defaultValue={d?.address ?? ""} maxLength={L.address} className="input" placeholder="e.g. Smash Sporting Club, 104 Airport Rd, Sheraton Al Matar, El Nozha, Cairo" />
            </label>
            <label className="block">
              <span className="label">Nearest landmark</span>
              <input name="landmark" defaultValue={d?.landmark ?? ""} maxLength={L.landmark} className="input" placeholder="e.g. a well-known building or gate taxi drivers know" />
            </label>
            <label className="block">
              <span className="label">Taxi / Uber drop-off point</span>
              <textarea name="drop_off" defaultValue={d?.dropOff ?? ""} maxLength={L.dropOff} rows={2} className="input" placeholder="e.g. Ask for the main gate on Airport Rd; the entrance is …" />
            </label>
            <label className="block md:col-span-2">
              <span className="label">Public transport (optional)</span>
              <textarea name="transit" defaultValue={d?.transit ?? ""} maxLength={L.transit} rows={2} className="input" placeholder="e.g. Nearest metro station, buses" />
            </label>
            <label className="block">
              <span className="label">Gate latitude (optional)</span>
              <input name="lat" defaultValue={d?.lat ?? ""} inputMode="decimal" className="input font-mono text-xs" placeholder="30.1…" />
            </label>
            <label className="block">
              <span className="label">Gate longitude (optional)</span>
              <input name="lng" defaultValue={d?.lng ?? ""} inputMode="decimal" className="input font-mono text-xs" placeholder="31.4…" />
            </label>
            <label className="block">
              <span className="label">Google Maps share link (optional)</span>
              <input name="google_maps_url" defaultValue={d?.googleMapsUrl ?? ""} className="input font-mono text-xs" placeholder="https://maps.app.goo.gl/…" />
            </label>
            <label className="block">
              <span className="label">Apple Maps share link (optional)</span>
              <input name="apple_maps_url" defaultValue={d?.appleMapsUrl ?? ""} className="input font-mono text-xs" placeholder="https://maps.apple.com/?…" />
            </label>
          </div>
          <p className="text-xs text-muted">
            Directions open the share link when given, else the gate&rsquo;s coordinates, else the address{place ? ` (or “${place}”)` : ""}.
          </p>
        </section>

        <section className="card grid gap-3 md:grid-cols-2">
          <label className="block">
            <span className="label">Parking</span>
            <textarea name="parking" defaultValue={doc?.parking ?? ""} maxLength={L.parking} rows={4} className="input" placeholder="e.g. Where to park, whether it is free, when it fills up" />
          </label>
          <label className="block">
            <span className="label">Food &amp; drinks</span>
            <textarea name="food" defaultValue={doc?.food ?? ""} maxLength={L.food} rows={4} className="input" placeholder="e.g. Café by Court 1, open … ; card and cash" />
          </label>
        </section>

        <section className="card space-y-3">
          <h3 className="font-bold">Contacts</h3>
          <p className="text-xs text-muted">Fans get Call (and WhatsApp when ticked) buttons. Use a number someone answers during play.</p>
          {contacts.map((c, i) => (
            <div key={i} className="grid gap-2 md:grid-cols-[1fr_1fr_auto_1fr]">
              <input name={`contact_label_${i}`} defaultValue={c?.label ?? ""} maxLength={L.contactLabel} className="input" placeholder={i === 0 ? "e.g. Tournament desk" : "Name"} aria-label={`Contact ${i + 1} name`} />
              <input name={`contact_phone_${i}`} defaultValue={c?.phone ?? ""} inputMode="tel" className="input" placeholder="+20 1xx xxx xxxx" aria-label={`Contact ${i + 1} phone`} />
              <label className="flex items-center gap-2 text-sm font-semibold">
                <input type="checkbox" name={`contact_whatsapp_${i}`} defaultChecked={c?.whatsapp ?? false} />
                WhatsApp
              </label>
              <input name={`contact_email_${i}`} defaultValue={c?.email ?? ""} inputMode="email" className="input" placeholder="Email (optional)" aria-label={`Contact ${i + 1} email`} />
            </div>
          ))}
        </section>

        <section className="card space-y-3">
          <h3 className="font-bold">FAQ</h3>
          {faqs.map((f, i) => (
            <div key={i} className="grid gap-2 md:grid-cols-[2fr_3fr]">
              <input name={`faq_q_${i}`} defaultValue={f?.q ?? ""} maxLength={L.question} className="input" placeholder={i === 0 ? "e.g. Can I bring my own food?" : `Question ${i + 1}`} aria-label={`Question ${i + 1}`} />
              <textarea name={`faq_a_${i}`} defaultValue={f?.a ?? ""} maxLength={L.answer} rows={2} className="input" placeholder={i === 0 ? "Your answer" : ""} aria-label={`Answer ${i + 1}`} />
            </div>
          ))}
          <p className="text-xs text-muted">Save to get three more empty questions (up to {L.faqs}).</p>
        </section>

        <section className="card flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm font-semibold">
            <input type="checkbox" name="published" defaultChecked={doc?.published ?? false} className="switch" data-testid="event-info-published" />
            Published (fans can see it)
          </label>
          <button className="btn-primary" data-testid="event-info-save">Save event info</button>
        </section>
      </StateForm>
    </div>
  );
}
