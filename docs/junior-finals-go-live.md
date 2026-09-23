# Junior Team Finals, Cairo 2026 — go-live checklist

Davis Cup Junior Finals and Billie Jean King Cup Junior Finals, Smash Sporting Club, 2–8 November 2026.
Two TV courts, one TV each. Everything below is done in the app unless it says otherwise.

## Must be done before the on-site rehearsal (25 September)

1. **Close the database's open door.** The live database lets its `anon` key read and write every table,
   and the app uses that key on the server. Anyone who obtained it could rewrite scores or read player data.
   - In Supabase, copy the project's **secret** (service role) key.
   - In Vercel, set it as `SUPABASE_KEY` for Production and Preview, then redeploy.
   - Then apply a migration that drops the `server_full_access` policies for `anon` and `authenticated`.
     The server key bypasses row-level security, so the app keeps working; the anon key then opens nothing.
   - Check: the Supabase security advisor, and a smoke run (`scripts/smoke.ts`).
2. **Ship the tennis work to production.** Merge branch `main-uhj0tx` into `main` (ask for the pull request),
   check the preview first, then promote.

Not used for this event, by decision: the voice umpire (referees keep it off) and player photos (the TVs
show initials on each nation's flag).

## Setting up the two events

One event per TV court:

| Event | TV court | Outside courts | TV link |
| --- | --- | --- | --- |
| Davis Cup Junior Finals (boys) | Court 1 | its own outside courts | `/t/<boys-slug>/screen/court-1-tv` |
| Billie Jean King Cup Junior Finals (girls) | Court 2 | its own outside courts | `/t/<girls-slug>/screen/court-2-tv` |

A TV belongs to one event. If a boys' tie ever has to go on Court 2, that TV will not show it: move the tie
to Court 1, or open the other event's TV link on that screen.

1. **New tournament** → sport Tennis → tick **Nations team competition**.
2. **Courts**: add the TV court first, then the outside courts.
3. **Screens**: add `Court 1 TV` (boys) or `Court 2 TV` (girls) covering only the TV court. Open its link on
   the TV and leave it; it runs on its own. Add partner logos under Settings → Branding, and the night clay
   background.
4. **Nations**: the 16 nations with ITF code, seed, captain and squad.
5. **Groups**: four groups of four; seeds 1–4 head the groups, the rest snake down. Then **Ties → Generate
   the group ties**.
6. **Order of play**: on each tie card, **Court and time** — the court and the not-before time, in Cairo
   time. The tie's rubbers follow at 90-minute intervals. Do this on the Ties page; the Rubbers page's time
   field reads times as UTC.
7. **Referee phones**: each referee signs in with the referee code and opens their rubber. Keep the page open
   all match.

## Every morning

- Captains nominate before the deadline; enter both line-ups on the tie card, then **Lock line-ups**.
- Check the day's court and time on every tie, and that each TV shows the first tie's line-up.

## During play

- **Late line-up change** (after the lock): change it on the tie card and give the reason. It is recorded.
- **A referee loses signal**: carry on scoring; the phone keeps the points and sends them when the signal is
  back, and the TV catches up. Do not score the same rubber on a second phone. If a phone dies, release its
  lock on the Rubbers page and continue on another.
- **Rain**:
  1. Referees pause their rubbers (the TV shows PLAY SUSPENDED).
  2. The operator starts a **Break** on the screens with an estimate in minutes (the walls show a countdown
     under the event's holding title; set that title to "Rain delay" in Branding if wanted).
  3. **Ties → Delay the order of play** by the expected minutes, for all courts or one. Everything not yet
     started moves; nothing in play or played moves. It is recorded.
  4. When play restarts: referees resume, the operator ends the break.
- **A tie is decided at 2–0 in the placement rounds**: the doubles is dropped by itself. In the groups all three
  rubbers are played.

## After the groups

- **Ties → Make the placement draws** once every group tie is finished: every place from 1st to 16th is played.
- Set court and time for each placement tie as above.

## The rehearsal (the gate)

A dry run on the real courts, TVs and phones on 25 September, trying on purpose:
a late line-up change, a referee phone in airplane mode for a game, a rain delay with a break and a delayed
order of play, and a finals tie through to its result. The same week has been rehearsed in software
(`scripts/e2e/tennis-week.ts`).

## Known limits

- Rules follow standard tennis and the ITF junior team format as researched; the 2026 regulations PDF has not
  been read against them.
- The break screen's title is the event's holding title, not a per-break message.
- No photos: walk-ons and score rows show initials on the flag.

## The finals replay demo (for the rehearsal)

`Junior Team Finals Demo — The finals, replayed` is loaded on the live database: the 2025 Davis Cup Junior final
(USA d. Japan 2–0) on Court 1 and the 2024 BJK Cup Junior final (USA d. Romania 2–1) on Court 2, with the real
line-ups and results. Open the two TV links, then **Replay** in the event's admin and press **Play tie** on each
(pace "Broadcast" is about 8 seconds a point). Only the set scores are real; the points inside them are made up
to fit. To play them again, delete the event and reload it from `scripts/demo/finals-demo.ts`.
