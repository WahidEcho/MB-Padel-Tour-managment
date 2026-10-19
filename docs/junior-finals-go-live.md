# Junior Team Finals, Cairo 2026 — go-live checklist

Davis Cup Junior Finals and Billie Jean King Cup Junior Finals, Smash Sporting Club, 2–8 November 2026.
Two TV courts, one TV each. Everything below is done in the app unless it says otherwise.

## Before the rehearsal (25 September)

1. **Ship the tennis work to production.** Done: branch `main-uhj0tx` merged into `main`.

## After the rehearsal, before 2 November

1. **Close the database's open door.** The live database lets its `anon` key read and write every table,
   and the app uses that key on the server. Anyone who obtained it could rewrite scores or read player data.
   - In Supabase, copy the project's **secret** (service role) key.
   - In Vercel, set it as `SUPABASE_KEY` for Production and Preview, then redeploy and check the site.
   - Only then apply a migration that drops the `server_full_access` policies for `anon` and `authenticated`.
     The secret key bypasses row-level security, so the app keeps working; the anon key then opens nothing.
     (Dropping them first would blank every page and TV.)
   - Check: the Supabase security advisor, and a smoke run (`scripts/smoke.ts`).

Not used for this event, by decision: the voice umpire (referees keep it off) and player photos (the TVs
show initials on each nation's flag).

## Setting up the two events

Both events are ready to load, with the 16 nations, 48 players and 16 captains of each exactly as the ITF published
them: `npx tsx scripts/events/cairo-2026.ts > cairo-2026.sql`, then run the SQL on the live project. They arrive as
drafts with the public pages off, each with its TV court (boys Court 1, girls Court 2), seven outside courts
(boys 3–9, girls 10–16; rename them on the Settings page to the club's real names) and the main and TV screens.
Still to enter in Cairo: the seeds and groups (the draw) and each nation's **order of merit** — players are
loaded in the ITF's published order, which the ITF does not say is the order of merit, and the No. 1 singles
player must rank above the No. 2 (Nations page: Player 1 is No. 1).

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
4. **Nations**: the 16 nations with ITF code, seed, captain and squad, players in the nation's order of merit.
5. **Groups**: four groups of four, as drawn in Cairo (Reg 36: seed 1 heads group 1, seed 2 group 4, seeds 3
   and 4 groups 2 and 3 by lot). Then **Ties → Generate the group ties**.
6. **Order of play**: on each tie card, **Court and time** — the court and the not-before time, in Cairo
   time. The tie's rubbers follow at 90-minute intervals. Do this on the Ties page; the Rubbers page's time
   field reads times as UTC.
7. **Referee phones**: each referee signs in with the referee code and opens their rubber. Keep the page open
   all match.

## Every morning

- Captains name their two singles players (and the doubles pair, if they wish) 30 minutes before play
  (Reg 43). Enter them on the tie card, the doubles left as **To be named** if it is not known yet, then
  **Lock line-ups**. The No. 1 singles must rank above the No. 2 in the nation's order of merit.
- **After the second singles**, the captains name or change the doubles pair (up to 20 minutes before the
  doubles): pick the pair on the tie card and **Save**. No reason is needed; it is recorded as the doubles
  named. Until then the TV and the referee phone show the doubles as to be named.
- Check the day's court and time on every tie, and that each TV shows the first tie's line-up.

## During play

- **Late singles change** (after the lock, e.g. illness, Reg 46): change it on the tie card and give the reason.
  It is recorded.
- **A player retires injured** (Reg 50): they may not play on in the tie without the Referee's approval. The tie
  card warns if they are still named in a later rubber.
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
- **A tie is won 2–0 after the singles**: the doubles is still played, in every tie, groups and placement alike.
  The winner already goes through to the next round; the tie shows Final once the doubles is played.

## After the groups

- Draw the lots for the runners-up at the venue (Reg 36: group 1 and 2 winners at positions 1 and 4, groups 3
  and 4 winners at 5 and 8; runners-up of groups 3 and 4 drawn into 2 and 3, of groups 1 and 2 into 6 and 7;
  the same for 3rd and 4th places in the 9th–16th draw). Enter how they fell above the button, then
  **Ties → Make the placement draws** once every group tie is finished: every place from 1st to 16th is played.
- Singles in the main draw (quarter-finals, semi-finals, final, third place) and the 15th/16th play-off are best
  of three sets; every other play-off singles is two sets and a 10-point match tie-break (Reg 51). The app
  applies this by itself and marks those rubbers "2 sets + MTB" on the tie card.
- Set court and time for each placement tie as above.

## The rehearsal (the gate)

A dry run on the real courts, TVs and phones on 25 September, trying on purpose:
a late line-up change, a referee phone in airplane mode for a game, a rain delay with a break and a delayed
order of play, and a finals tie through to its result. The same week has been rehearsed in software
(`scripts/e2e/tennis-week.ts`).

## Known limits

- Rules follow the 2026 ITF Junior Team Competitions regulations (Regs 36, 38, 40, 43, 50, 51), read against the
  app in October 2026. Group ranking: points, then for two level the tie between them; for three or more,
  matches won, sets %, games % (head-to-head never), a match tie-break counting as one set and one game, a
  retirement at its full score and a walkover as 6-0 6-0.
- Not enforced by the app (the Referee's call): the 30-minute nomination deadline, the 21:00 latest start, rest
  between ties, substitutions, and the short-set format a Referee may allow for a 2–0 doubles in the knockouts.
- The break screen's title is the event's holding title, not a per-break message.
- No photos: walk-ons and score rows show initials on the flag.

## The finals replay demo (for the rehearsal)

`Junior Team Finals Demo — The finals, replayed` is loaded on the live database: the 2025 Davis Cup Junior final
(USA d. Japan 2–0) on Court 1 and the 2024 BJK Cup Junior final (USA d. Romania 2–1) on Court 2, with the real
line-ups and results. Open the two TV links, then **Replay** in the event's admin and press **Play tie** on each
(pace "Broadcast" is about 8 seconds a point). Only the set scores are real; the points inside them are made up
to fit. To play them again, delete the event and reload it from `scripts/demo/finals-demo.ts`.
