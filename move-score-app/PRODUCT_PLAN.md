# Move Score — Mobile Application, Web Evolution, Development & Production Master Plan

> **Single source of truth for product, design, engineering, QA, release, and event operations**
>
> Repository: `WahidEcho/MB-Padel-Tour-managment`  
> Working branch: `move-score-mobile`  
> Native app folder: `move-score-app/`  
> Product name: **Move Score**  
> Primary launch event: **Junior Tennis Team Finals, Cairo 2026**  
> Hard public-availability target: **1 November 2026**  
> Initial launch scale assumption: **up to 1,000 concurrent spectators and 20 active courts**

---

# 0. Document status

This document replaces fragmented planning notes for the Move Score mobile application and its required web/backend evolution.

It contains:

- product vision;
- locked product decisions;
- role definitions;
- public audience experience;
- match-interest system;
- player-follow system;
- player account/claim system;
- referee experience;
- admin and TV operator scope;
- sponsor/Ads Manager scope;
- design direction;
- Figma structure;
- technical architecture;
- code-sharing strategy;
- database changes;
- API design;
- authentication and permissions;
- offline scoring;
- realtime/public-read strategy;
- notification system;
- analytics and monitoring;
- security hardening;
- testing strategy;
- performance budgets;
- accessibility requirements;
- store-readiness work;
- release plan;
- event rehearsal plan;
- production runbook;
- incident handling;
- acceptance criteria;
- Phase 2/3 roadmap;
- known gaps and pending external inputs.

If a future product decision conflicts with this file, update this file first and then change code/tests/designs to match.

---

# 1. Product vision

Move Score is not only a scoring screen and not only a padel tournament manager.

It is intended to become a **multi-sport tournament operating system and live spectator product** with five connected layers:

1. **Audience layer**
   - tournament discovery;
   - all matches;
   - live scoring;
   - schedules;
   - brackets/draws;
   - standings;
   - results;
   - teams;
   - players;
   - player following;
   - interesting matches;
   - tournament information;
   - major announcements;
   - sponsors.

2. **Player layer**
   - player identity;
   - My Matches;
   - upcoming matches;
   - ranking;
   - statistics;
   - match history;
   - draw position;
   - notifications;
   - optional check-in in future/event-specific configurations.

3. **Referee layer**
   - access-code entry;
   - match selection;
   - offline-first scoring;
   - direct score correction/undo;
   - reliable synchronization;
   - result confirmation according to tournament settings.

4. **Tournament operations layer**
   - teams/nations;
   - players;
   - scheduling;
   - courts;
   - ties/rubbers;
   - match generation;
   - settings;
   - score oversight;
   - announcements;
   - sponsor controls;
   - TV operation.

5. **Commercial/sponsor layer**
   - main sponsor;
   - footer sponsors;
   - image/video creatives;
   - visibility controls;
   - scheduling;
   - sponsor links;
   - live previews;
   - impressions/clicks;
   - tournament-specific campaign reporting.

The long-term architecture must support more sports without requiring a new application for each sport.

---

# 2. Product principles

## 2.1 Backend is the source of truth

The current Move Score web backend remains authoritative.

The native app must **not create a parallel scoring model, tournament database, or sponsor model**.

Mobile reflects and operates the same tournament state as web.

## 2.2 Public experience first

A spectator should be able to open Move Score and immediately understand:

- what is happening live;
- what tournament is featured;
- what matches are on;
- what matches are next;
- who is playing;
- who they follow;
- what they have marked interesting.

No login should be forced before tournament discovery.

## 2.3 Reliability before visual extras

If a choice must be made between:

- a new decorative feature;
- or better offline/recovery/scoring integrity;

reliability wins.

## 2.4 Tournament skin over application redesign

Move Score should have a stable product identity.

Each event may provide:

- event logo;
- event colors;
- event imagery;
- competition artwork;
- sponsor system;
- background;
- light/dark preference.

The navigation and interaction language remain Move Score.

## 2.5 Roles are capabilities, not completely different products

The application is one product.

Roles determine what the user can access.

The public audience experience always remains accessible.

## 2.6 Every critical mutation is auditable

Critical changes must record who, what, when, and before/after state where appropriate.

This includes:

- scores;
- match result correction;
- draw edit;
- court/time edit;
- role changes;
- tournament-setting changes;
- sponsor visibility changes;
- player account linking.

---

# 3. Existing repository audit — what already exists

The existing repository is already a strong foundation.

Current stack:

- Next.js 16;
- React 19;
- TypeScript;
- Tailwind;
- Supabase/PostgreSQL;
- Supabase Storage;
- server-side database access;
- Vitest;
- IndexedDB/Dexie for web referee offline queue.

Current relevant capabilities already in the repository include:

## 3.1 Roles

Current type:

`admin | manager | referee | operator`

Current login flow uses access codes to select the role.

## 3.2 Sports

Current type includes:

- padel;
- chess;
- tennis.

The new app should preserve sport extensibility.

## 3.3 Tournament core

Current tournament model includes:

- name;
- slug;
- sport;
- kind;
- status;
- branding_config;
- scoring_config;
- format_config;
- court_config;
- lower-third text;
- public-access control.

## 3.4 Tennis

The current repository already supports:

- tennis scoring;
- singles/doubles differentiation;
- best-of-three structures;
- advantage/no-ad options;
- match tie-break options;
- nation/team competitions;
- ties;
- rubbers;
- group ties;
- placement ties;
- line-up logic;
- tie standings;
- court/time assignments;
- dead-rubber behavior;
- TV tennis scenes;
- tennis E2E tests.

## 3.5 Scoring

Current architecture already includes:

- event-sourced scoring;
- `score_events`;
- `match_score_snapshots`;
- ordered score events;
- score transitions;
- offline scoring on web;
- score-device locking/control;
- score-control lease;
- conflict handling;
- audit logs;
- result confirmation setting;
- walkover;
- retirement;
- disqualification;
- force end;
- pause/resume;
- undo;
- serve handling;
- tie-break support.

The native app should reuse the pure TypeScript scoring engine/rules but must replace browser storage with native durable storage.

## 3.6 Public web

Current public pages include:

- tournament overview;
- leaderboard;
- live;
- bracket;
- winner;
- match page;
- matches.

These public pages are an important fallback and should evolve alongside the native app.

## 3.7 TV / operator

Current system includes:

- operator role;
- screen settings;
- live court mode;
- leaderboard mode;
- bracket mode;
- ceremony;
- sponsor mode;
- holding state;
- per-screen coverage;
- break countdown;
- pinned court;
- theme;
- sponsor rotation;
- multi-screen control.

## 3.8 Sponsors

Current branding structure includes:

- Move Beyond logo;
- client logo;
- event logo;
- event background;
- main sponsor;
- sponsor accent;
- sponsor intensity;
- footer sponsor list;
- sponsor chips;
- sponsor size logic;
- public sponsor band;
- TV sponsor band.

This remains useful but must be expanded into a real campaign/Ads Manager.

## 3.9 Existing launch risk documented in repository

The existing go-live document identifies a critical security task:

- current broad anonymous Supabase policies must be closed before any client-side credential is allowed to access the database.

This is a **hard launch gate** for native release.

---

# 4. Application information architecture

Recommended bottom navigation for public/user mode:

1. **Discover**
2. **Matches**
3. **Players**
4. **Following**

A profile/avatar/login entry remains in the top-level header or account sheet.

When a user has a role such as referee/admin/operator, role tools are entered from the profile/role switcher rather than replacing the public application entirely.

Example:

```text
Move Score
├── Discover
├── Matches
├── Players
├── Following
└── Account
    ├── Player Profile
    ├── Referee Mode
    ├── Admin Mode
    ├── TV Operator
    └── Settings
```

---

# 5. Audience experience

## 5.1 No-login first launch

The first app screen must not be a login form.

The user opens Move Score and sees:

1. Move Score identity;
2. featured/live tournament;
3. live matches;
4. upcoming tournaments;
5. past tournaments;
6. access to all tournaments.

Login is optional.

## 5.2 Featured tournament behavior

Add a **platform-level featured tournament setting** controlled from the web admin.

Recommended model:

`platform_settings.featured_tournament_id`

Do not implement this as many independent `is_featured` booleans unless a future product decision requires multiple simultaneous hero events.

Behavior:

- one tournament can be featured;
- featured tournament takes hero priority on both app and public web;
- if the featured tournament is live/active, it appears first;
- other tournaments remain discoverable;
- secondary tournaments may be collapsed under “All tournaments”;
- upcoming and past sections still remain;
- clearing the featured value returns normal ordering.

The setting must take effect on:

- native app;
- web public landing page;
- any future public discovery surface.

## 5.3 Tournament sections

Discover page sections:

- Featured now;
- Live now;
- Upcoming;
- Past;
- All tournaments.

Tournament card fields:

- name;
- logo/artwork;
- sport;
- city/venue;
- date range;
- state: Upcoming / Live / Completed;
- number of live matches when active;
- sponsor presence if required;
- call to action.

## 5.4 Tournament hub

Each tournament hub can include:

- Overview;
- Live;
- Matches;
- Schedule;
- Draw/Bracket;
- Standings/Rankings;
- Results;
- Teams/Nations;
- Players;
- News/Announcements;
- Tournament info;
- Venue info;
- rules if organizers want them public;
- streaming links if supplied;
- sponsors.

Visibility should be configurable per tournament.

---

# 6. All Matches experience

Attendees must be able to see **every public match in the tournament**, not only live matches.

## 6.1 Filters

Required filters:

- All;
- Live;
- Upcoming;
- Completed/Results;
- Interesting;
- Day/date;
- Court;
- Round/stage;
- team/nation;
- player;
- singles/doubles where applicable.

Search should support:

- player name;
- team/nation;
- court;
- match identifier.

## 6.2 Match cards

Match card should show:

- scheduled time;
- current status;
- court;
- stage/round;
- team/player A;
- team/player B;
- country/flag when relevant;
- current score or final score;
- “Interesting” control;
- live indicator;
- delay/paused state if applicable.

## 6.3 Interesting matches

Attendees can mark any public match as **Interesting**.

Recommended UX term in English:

- default: `☆ Mark interesting`
- selected: `★ Interesting`

Alternative copy may later become `Save match`, but “Interesting” is currently the product term.

### Guest behavior

No login required.

Store interesting match IDs in local native storage.

Guest saved matches:

- persist across app restarts;
- do not automatically move to another phone;
- may be lost after uninstall.

### Logged-in behavior

When logged in:

- save to backend;
- sync across devices;
- merge existing local guest interests after login.

Recommended merge rule:

`server interests ∪ local interests`

Do not delete either side silently.

## 6.4 Interesting match notifications

Recommended V1:

- an interesting match may opt into:
  - schedule created;
  - court/time changed;
  - match starting;
  - final result.

To avoid notification overload, default behavior can be:

- court/time changes;
- match starting.

Result notification may be configurable.

This is separate from the global “major tournament announcements” channel.

---

# 7. Player directory & following

## 7.1 Public player directory

Everyone can browse all public players.

No account is required to view player data.

Player list should support:

- search;
- A–Z;
- team/nation;
- tournament;
- followed only;
- currently playing;
- upcoming today.

Player row should show:

- name;
- flag/team;
- tournament;
- next match;
- status;
- Follow button.

Private data must never be shown publicly.

Do not expose:

- phone;
- email;
- access code;
- internal notes;
- private admin fields.

## 7.2 Player detail page

Public player detail may show:

- full name;
- public photo/portrait when available;
- nation/team;
- current tournament;
- next match;
- tournament record;
- wins/losses;
- sets/games where appropriate;
- match history;
- current draw/placement;
- ranking/standing;
- live indicator if playing;
- Follow button.

For tennis team competitions, the player page should distinguish:

- singles appearances;
- doubles appearances.

## 7.3 Follow players

The follow system is a core audience feature, particularly for:

- parents;
- siblings;
- extended family;
- friends;
- coaches/supporters;
- fans following a specific athlete.

### Recommended rule

Browsing does not require login.

**Server-backed player following does require a lightweight account** because push subscriptions must reliably persist and follow the user across devices.

A guest may optionally keep local-only followed players, but reliable player notifications should be enabled after login.

Recommended flow:

```text
Tap Follow
    ↓
If logged in → follow saved immediately
    ↓
If guest → offer:
    Keep on this phone
    OR
    Sign in to get alerts everywhere
```

For V1, simplest production rule may be:

- guest can locally follow;
- push alerts prompt user to sign in.

## 7.4 Player-follow notification events

Followers should be eligible for notifications when:

1. player receives a new match assignment;
2. match schedule is changed;
3. court is changed;
4. match is moved/delayed;
5. match is about to start;
6. match status becomes live;
7. match finishes;
8. result is published.

Recommended defaults:

- schedule assigned: ON;
- schedule changed: ON;
- starting: ON;
- result: ON.

Users may later individually disable types.

## 7.5 Duplicate notifications

If a user:

- follows both players in the same match;
- and also marks the match Interesting;

the system must send **one consolidated notification**, not three.

Deduplication key can use:

`user/device + match_id + notification_event_type`

---

# 8. Following feed

The Following tab should aggregate personal tournament tracking.

Recommended sections:

## 8.1 Next for you

Chronologically ordered:

- followed-player upcoming matches;
- interesting matches.

## 8.2 Live now

Live matches containing:

- a followed player;
- an interesting match.

## 8.3 Player updates

Examples:

- Adam Hassan — Court changed to Court 2;
- Jun Sato — won 6–3, 6–4;
- Mateo Lopez — next match tomorrow 10:00.

## 8.4 Following list

Separate views:

- Players;
- Matches;
- Tournaments if tournament-following is added.

---

# 9. Notifications system

Notifications are divided into three categories.

## 9.1 Global tournament announcements

Available without player following.

Examples:

- event started;
- group stage ended;
- quarter-finals ready;
- semi-finals ready;
- final ready;
- country/team wins;
- major manual organizer announcement.

Avoid over-notifying.

## 9.2 Personal match/player notifications

Triggered by:

- followed players;
- interesting matches.

Events:

- scheduled;
- rescheduled;
- court changed;
- delayed;
- starting;
- live;
- final result.

## 9.3 Operational player notifications

Authenticated player account receives:

- own match scheduled;
- own court changed;
- own time changed;
- own match starting;
- important tournament operations.

These should be prioritized higher than general audience notifications.

## 9.4 Sponsor pushes

Not in Phase 1.

Phase 2 only.

If implemented, sponsor pushes must:

- be explicitly enabled;
- respect notification preferences;
- be clearly promotional;
- not be mixed with safety/operational scoring notifications.

---

# 10. Player account experience

## 10.1 Player profile claim

Current players already exist in tournament data.

Create a **Player Code** flow.

Flow:

```text
Create account
↓
Enter one-time player code
↓
Resolve persistent player profile
↓
Confirm
↓
Link user account ↔ player profile
↓
Invalidate code
```

Admin can also manually assign a user account to a player.

## 10.2 Player code rules

Player code should be:

- random;
- one-time or revocable;
- stored hashed server-side;
- never logged in analytics;
- rate limited;
- invalidated after successful claim;
- regenerated by admin if necessary.

Do not use predictable codes based only on:

- player name;
- date of birth;
- tournament ID.

## 10.3 Junior accounts

For current scope:

- juniors may have their own accounts;
- no parent/guardian account linking is required in V1.

Future child/guardian features can be considered separately if required.

## 10.4 My Matches hierarchy

Player home priority:

1. Next/upcoming match;
2. Ranking/standing;
3. Statistics;
4. Further upcoming matches;
5. Recent results;
6. Match history;
7. Draw/tournament context;
8. team details;
9. profile.

The next match should be visually dominant.

## 10.5 Player check-in

Product can support player check-in, but it is tournament-configurable.

For the Junior Tennis Team Finals scoring scope:

- player check-in is OFF;
- Move Score is not responsible for event player check-in.

---

# 11. Referee experience

## 11.1 Authentication

Phase 1:

- referee access code.

A referee can see all tournament matches in current internal-team operation.

Future Phase 2:

- event-scoped codes;
- event-scoped roles;
- user can have different roles per tournament;
- one code must not give permanent access to all events.

## 11.2 Match picker

Referee match list should show:

- tournament;
- date;
- court;
- time;
- teams/players;
- stage;
- match status;
- current scoring-device status;
- pending-sync warning if any.

Filters:

- live;
- ready;
- upcoming;
- court;
- tournament.

## 11.3 Scoring console

Must be optimized for:

- one-hand/two-hand use;
- bright outdoor conditions;
- personal iPhones;
- personal Android devices;
- tablets/iPads;
- unstable mobile internet.

Primary score controls must be extremely large.

No important scoring action should depend on a tiny icon.

## 11.4 Score correction

Referee can undo score events without admin approval because mis-taps are expected during live operation.

Sensitive actions may still require confirmation, including:

- retirement;
- walkover;
- DQ;
- force end.

## 11.5 Result confirmation

Already represented by existing tournament scoring configuration.

Tournament setting:

`requireResultConfirmation`

When on:

- winning point produces provisional final state;
- referee confirms result;
- undo remains possible before confirmation.

When off:

- winning point finalizes directly.

## 11.6 Audit

Every relevant referee event should carry:

- match;
- tournament;
- device;
- actor/role;
- local event ID;
- server event ID;
- timestamp;
- sequence;
- old state;
- new state;
- event type.

---

# 12. Native offline scoring architecture

Offline scoring is mandatory.

Referees are expected to use:

- personal phones;
- iOS or Android;
- primarily SIM/mobile data;
- occasional Wi-Fi.

## 12.1 Existing web model

Current web referee uses IndexedDB/Dexie.

This cannot be reused directly in React Native.

## 12.2 Native storage

Use durable SQLite in native app.

Recommended:

- Expo SQLite or equivalent native SQLite layer.

Do not rely only on:

- in-memory state;
- AsyncStorage for critical ordered score events.

## 12.3 Local event table

Recommended local schema:

```text
score_event_queue
- local_id
- match_id
- tournament_id
- device_id
- client_sequence
- event_type
- payload_json
- previous_state_hash
- created_at_device
- sync_status
- server_event_id
- last_error
- retry_count
```

Possible `sync_status`:

- queued;
- syncing;
- acknowledged;
- conflict;
- error.

## 12.4 Sync flow

1. Claim/control match.
2. Fetch authoritative state and latest server sequence.
3. Persist control/session details.
4. User scores a point.
5. Apply transition locally using shared scoring engine.
6. Persist score event to SQLite **before treating it as durable**.
7. Update UI immediately.
8. Attempt sync.
9. Server validates device/control and sequence.
10. Server appends score event.
11. Server updates authoritative snapshot.
12. Server returns acknowledgment/server event ID.
13. Mark local event acknowledged.
14. Continue.

## 12.5 Reconnect

When network returns:

- send pending events in order;
- never reorder;
- stop on conflict;
- do not silently skip a rejected event.

## 12.6 Visible network states

Referee UI must show:

- Online;
- Offline;
- Syncing;
- Pending Sync;
- Sync Error;
- Conflict.

Referee should always know whether a score is safely on the server.

## 12.7 App termination

If the app is killed:

- queued score events remain in SQLite;
- reopening reconstructs match state from authoritative snapshot + pending local events where safe;
- user is told if pending events still require sync.

## 12.8 Device handover

If referee phone dies:

1. admin/operator releases scoring control;
2. second device claims match;
3. authoritative server snapshot is loaded;
4. second device continues.

Never allow two devices to independently score the same match without explicit control transfer.

---

# 13. Tennis team competitions

## 13.1 Parent tie + child rubbers

Support both views.

Parent:

- nation/team vs nation/team;
- tie score;
- overall status.

Children:

- singles 2;
- singles 1;
- doubles.

Spectators normally enter the tie, then can open each rubber.

Referee scores an individual rubber.

Admin manages both.

## 13.2 Current rules

Repository contains current assumptions and tests for the Cairo junior team format.

However:

- final official event regulations remain authoritative;
- if final regulations differ, update this master plan and rules/tests.

## 13.3 Dead rubbers

Behavior remains tournament-format controlled.

Current implementation already distinguishes group vs placement behavior.

---

# 14. Mobile admin scope

## 14.1 Phase 1 operational admin

Include:

- tournament list;
- tournament dashboard;
- teams/nations;
- team details;
- selected team/player edits;
- tournament settings;
- scoring settings;
- match list;
- generate/manage matches where existing APIs allow;
- courts/times;
- referee oversight;
- score oversight;
- announcements;
- sponsor controls;
- featured-tournament control if appropriate;
- TV/operator entry.

## 14.2 Draw edits

Admin only.

No referee/operator draw editing.

## 14.3 Full tournament creation

Phase 2.

Do not jeopardize first-event reliability by attempting full web parity in the initial native release.

---

# 15. TV Operator

Operator remains distinct from referee.

TV operator responsibilities:

- choose screen;
- choose scene/mode;
- pin court;
- select covered courts;
- break countdown;
- holding;
- leaderboard;
- bracket;
- ceremony;
- sponsors;
- animations/mute;
- sponsor rotation.

Operator does not score matches.

---

# 16. Web platform changes required for mobile

The native app cannot be treated as an isolated code folder.

The web platform must gain shared controls/APIs.

Required web changes:

## 16.1 Platform discovery settings

- featured tournament selection.

## 16.2 Public APIs

Need clean read endpoints/contracts for:

- tournament list;
- featured tournament;
- tournament hub;
- matches;
- live matches;
- players;
- player detail;
- standings;
- brackets;
- sponsors;
- announcements.

## 16.3 Authenticated APIs

Need endpoints/contracts for:

- player profile claim;
- follows;
- interesting matches;
- device push subscriptions;
- notification preferences.

## 16.4 Role mutation APIs

Need protected endpoints for:

- referee scoring/control;
- admin operations;
- operator screen controls.

Native app must not perform arbitrary direct table writes.

## 16.5 Ads Manager

New web admin module for sponsor campaigns and live footer preview.

---

# 17. Sponsor / Ads Manager

## 17.1 Existing sponsor behavior to preserve

- main sponsor;
- main sponsor logo;
- accent/glow;
- intensity;
- sponsor footer;
- sponsor chips;
- sponsor uniform sizing;
- TV sponsor mode;
- public sponsor footer.

## 17.2 New campaign model

Recommended entities:

### sponsor_campaigns

- id;
- tournament_id;
- sponsor_name;
- tier;
- status;
- starts_at;
- ends_at;
- click_enabled;
- destination_url;
- created_by;
- created_at;
- updated_at.

### sponsor_creatives

- id;
- campaign_id;
- type: image | video | embed;
- source_url;
- thumbnail_url;
- aspect;
- duration_ms where relevant;
- alt_text;
- status.

### sponsor_placements

- id;
- campaign_id;
- placement_key;
- active;
- sort_order;
- show_on_web;
- show_on_mobile;
- show_on_tv.

Possible placement keys:

- tournament_footer;
- mobile_home;
- tournament_home;
- live_match_footer;
- schedule;
- results;
- splash;
- full_screen_sponsor;
- TV_footer.

## 17.3 Tournament scope

Phase 1 targeting is by tournament.

Do not add user-personalized ad targeting.

## 17.4 Creative types

Support:

- uploaded image;
- uploaded video;
- embedded video/media where technically safe and allowed.

## 17.5 Sponsor links

Optional.

Setting can enable/disable clicks.

External links must:

- show clear destination behavior;
- use safe URL validation;
- open with native external-browser handling.

## 17.6 Sponsor visibility

Every sponsor/logo/campaign should have:

- Show;
- Hide.

Changes should update:

- web;
- mobile;
- TV surfaces where placement applies.

## 17.7 Live sponsor footer preview

Web Ads Manager must contain an accurate preview.

Preview should show:

- main sponsor;
- current footer order;
- hidden sponsors;
- chips/no chips;
- uniform/non-uniform sizing;
- active campaign timing.

## 17.8 Metrics

Phase 1 helpful metrics:

- impressions;
- clicks;
- CTR;
- placement;
- tournament;
- creative;
- platform/device class.

Do not count background polling as sponsor impressions.

Define an impression only when the sponsor placement is actually rendered/visible according to the implementation rules.

---

# 18. Data model additions

Exact SQL must be reviewed against current production schema before migration.

Recommended additions:

## 18.1 Platform settings

`platform_settings`

- key;
- value_json;
- updated_at;
- updated_by.

Use:

- `featured_tournament_id`.

## 18.2 User/application account

If Supabase Auth is adopted for public/player accounts:

- auth.users remains identity;
- application profile table maps public profile/preferences.

Recommended:

`app_users`

- auth_user_id;
- display_name;
- created_at;
- updated_at.

## 18.3 Player profile claim

Existing player profile forward-compatibility fields should be reused where possible.

Add:

`player_claim_codes`

- id;
- player_profile_id;
- code_hash;
- expires_at;
- used_at;
- revoked_at;
- created_by;
- created_at.

## 18.4 Player follows

`player_follows`

- user_id;
- player_profile_id;
- tournament_id nullable if global following is later allowed;
- created_at.

Unique constraint:

`user_id + player_profile_id + tournament scope`

Product decision for V1 should likely follow a player **within the tournament context**, while the architecture can later allow global follow.

## 18.5 Interesting matches

`match_interests`

- user_id;
- match_id;
- created_at;
- notify_schedule;
- notify_start;
- notify_result.

Guest interests remain local and do not require rows.

## 18.6 Device push subscriptions

`push_devices`

- id;
- user_id nullable;
- installation_id;
- expo_push_token / provider token;
- platform;
- app_version;
- enabled;
- last_seen_at;
- created_at.

## 18.7 Tournament announcement subscriptions

`tournament_subscriptions`

- device_id/user_id;
- tournament_id;
- major_announcements_enabled.

## 18.8 Notification events

`notification_events`

- id;
- event_type;
- tournament_id;
- match_id nullable;
- player_profile_id nullable;
- payload_json;
- dedupe_key;
- created_at.

## 18.9 Notification deliveries

`notification_deliveries`

- notification_event_id;
- device_id;
- status;
- provider_message_id;
- sent_at;
- opened_at;
- error.

## 18.10 Ads Manager tables

As defined in Sponsor section.

## 18.11 Role access Phase 2

Future:

`tournament_role_grants`

- tournament_id;
- role;
- code_hash/user_id;
- starts_at;
- ends_at;
- revoked_at.

This supports event-specific access codes.

---

# 19. API design

Names are recommendations; exact Next.js route placement may change.

## 19.1 Public

- `GET /api/mobile/discover`
- `GET /api/mobile/tournaments/:slug`
- `GET /api/mobile/tournaments/:slug/matches`
- `GET /api/mobile/tournaments/:slug/live`
- `GET /api/mobile/tournaments/:slug/players`
- `GET /api/mobile/tournaments/:slug/players/:id`
- `GET /api/mobile/tournaments/:slug/standings`
- `GET /api/mobile/tournaments/:slug/bracket`
- `GET /api/mobile/tournaments/:slug/announcements`
- `GET /api/mobile/tournaments/:slug/sponsors`

## 19.2 User

- `POST /api/mobile/me/player-claim`
- `GET /api/mobile/me`
- `GET /api/mobile/me/matches`
- `POST /api/mobile/me/follows/:playerId`
- `DELETE /api/mobile/me/follows/:playerId`
- `POST /api/mobile/me/interests/:matchId`
- `DELETE /api/mobile/me/interests/:matchId`
- `POST /api/mobile/push/register`
- `PATCH /api/mobile/push/preferences`

## 19.3 Referee

Reuse/adapt current match scoring endpoints:

- claim;
- state;
- events;
- lease renew;
- release lease;
- control request/response.

Native API contract should be versioned/stable.

## 19.4 Admin

Expose only explicit operations needed by V1.

Avoid a generic “table write” API.

## 19.5 Operator

Reuse/adapt screen control actions.

---

# 20. Authentication & authorization

## 20.1 Public audience

No authentication required.

## 20.2 Player/general user

Use proper application authentication for persistent follows/push preferences.

Recommended options:

- email magic link;
- email/password;
- phone OTP if commercial/provider setup is ready.

The exact V1 account method may be selected based on speed and store/privacy requirements.

Player identity is a separate claim step.

## 20.3 Referee

Access code Phase 1.

Do not mix referee role with spectator/player account unless role linking is explicitly implemented.

## 20.4 Admin/operator

Current access code system can remain for first internal event if security hardening is correct.

Future:

- named accounts;
- event-scoped roles;
- expiring access.

## 20.5 Server authorization

Every write must validate:

- authenticated/session role;
- tournament scope;
- action capability;
- match state if relevant.

Never trust a role sent by the client in a request body.

---

# 21. Supabase security hardening

Hard launch gate.

Before native production:

1. verify Vercel/server has correct secret/service credential;
2. confirm secret never ships to browser/native;
3. remove broad anon/authenticated full-access policies documented by current go-live file;
4. use explicit public read APIs;
5. keep mutation APIs server-side;
6. review RLS;
7. run Supabase security advisor;
8. run smoke/E2E after policy changes;
9. verify public pages still work;
10. verify referee offline sync still works.

Native binary must contain no credential capable of directly rewriting tournament tables.

---

# 22. Shared code strategy

Recommended folder direction:

```text
/
├── src/                        # current Next.js
├── move-score-app/             # React Native/Expo
├── packages/
│   ├── scoring-core/           # pure scoring engine/rules
│   ├── domain/                 # types/contracts
│   └── api-contracts/          # DTO/schema definitions
└── supabase/
```

Do not immediately force a large monorepo refactor before event launch.

Safe incremental approach:

1. identify framework-free modules;
2. copy/extract with tests;
3. preserve imports on web through a stable shared path;
4. validate web tests;
5. consume same package from mobile.

Priority reusable modules:

- scoring engine;
- scoring rules;
- tennis tie rules;
- stage-rule resolution;
- score-state/event types;
- domain types;
- sponsor helper logic that does not depend on DOM/server APIs.

Do not import:

- Next.js server actions;
- Node-only Supabase service code;
- browser Dexie code;

into native.

---

# 23. Native application stack

Recommended:

- React Native;
- Expo;
- TypeScript;
- Expo Router;
- TanStack Query for server state;
- lightweight state store only for local interaction/session state where needed;
- Expo SQLite for critical offline queues;
- SecureStore for secrets/session material;
- Expo Notifications;
- EAS Build;
- EAS Submit.

Pin exact versions at implementation time to compatible stable releases.

Do not upgrade core framework versions during final event hardening unless required for a critical fix.

---

# 24. Native folder structure

Suggested:

```text
move-score-app/
├── app/
│   ├── (public)/
│   │   ├── index.tsx
│   │   ├── matches.tsx
│   │   ├── players.tsx
│   │   ├── following.tsx
│   │   └── tournament/
│   ├── (auth)/
│   ├── player/
│   ├── referee/
│   ├── admin/
│   └── operator/
├── src/
│   ├── components/
│   ├── features/
│   │   ├── discover/
│   │   ├── matches/
│   │   ├── players/
│   │   ├── following/
│   │   ├── scoring/
│   │   ├── admin/
│   │   └── sponsors/
│   ├── api/
│   ├── offline/
│   ├── notifications/
│   ├── analytics/
│   ├── auth/
│   ├── theme/
│   └── utils/
├── assets/
├── app.config.ts
├── eas.json
└── package.json
```

---

# 25. Design system

## 25.1 Figma file

**Move Score Mobile**

Pages:

- 00 Product Brief
- 01 Foundations
- 02 Audience
- 03 Player
- 04 Referee
- 05 Admin & Operator
- 06 Ads Manager

## 25.2 Typography

Primary:

- **Manrope**

Use for:

- navigation;
- titles;
- body;
- buttons;
- editorial content.

Data/sports:

- **IBM Plex Sans Condensed**

Use for:

- scores;
- times;
- courts;
- rounds;
- data-heavy labels.

## 25.3 Visual direction

Desired:

- premium editorial event product;
- calm interface;
- sports broadcast precision;
- large event visuals;
- strong live states;
- low visual noise;
- generous spacing;
- subtle motion;
- high-quality typography.

Reference quality:

- Luma-like event hierarchy/spacing/polish;

but Move Score must remain visually original and sports-specific.

Avoid:

- generic purple/blue AI gradients;
- excessive glassmorphism;
- random glow;
- dashboard card overload;
- excessive rounded containers;
- decorative charts with no purpose;
- identical SaaS-template screen patterns.

## 25.4 Core palette

Current provisional system before final new logo is supplied:

- warm light base;
- near-black live/broadcast surfaces;
- Move Score red accent;
- live orange/red state;
- tournament skin colors as controlled secondary accents.

Final logo may adjust the primary accent without rebuilding the component hierarchy.

## 25.5 Audience Figma flow already started

Core screens:

1. Discover;
2. All Matches;
3. Players;
4. Player Follow;
5. Match Detail.

Further required screens:

- Tournament Hub;
- Schedule;
- Draw/Bracket;
- Standings;
- Results;
- Following feed;
- Search;
- Login/account;
- Notification settings.

## 25.6 Motion

Use motion to communicate state:

- live pulse;
- score changed;
- followed;
- interesting toggled;
- schedule changed;
- screen transitions.

Respect reduced-motion system settings.

Do not animate merely for decoration.

---

# 26. Accessibility

Minimum requirements:

- touch targets roughly 44pt minimum;
- high score contrast;
- do not encode team identity with color only;
- status text alongside color;
- scalable text;
- VoiceOver/TalkBack labels;
- meaningful button labels;
- score updates announced carefully to avoid accessibility spam;
- landscape/tablet support where referee/operator views benefit;
- support device safe areas;
- avoid tiny court/status text.

---

# 27. Performance budgets

Audience app should feel instant on mobile data.

Targets to aim for:

- fast first meaningful tournament content;
- no giant uncompressed tournament images;
- sponsor images cached;
- video lazy-loaded;
- lists virtualized;
- no unnecessary full-tournament payload on app launch.

Scoring screen:

- score tap updates locally immediately;
- network latency must not block UI;
- offline mode should require no remote resource after match is loaded except eventual sync.

---

# 28. Public scale strategy

Expected V1:

- ~1,000 concurrent spectators;
- up to 20 active courts.

Avoid every client continuously hitting heavy raw Supabase queries.

Recommended:

- purpose-built public endpoints;
- short cache windows where acceptable;
- compact live payloads;
- pagination for players/matches;
- efficient polling or realtime depending on endpoint;
- server-side aggregation.

Live score data should prioritize correctness over excessive refresh frequency.

---

# 29. Realtime strategy

Current public web uses polling fallback.

For native:

Possible approach:

- active match detail: frequent compact update/realtime;
- match lists: moderate refresh;
- completed/static content: cache longer.

Do not expose broad Supabase realtime permissions until RLS/security is explicitly designed for it.

Server-mediated live endpoints are acceptable for V1.

---

# 30. Analytics

Recommended product analytics:

**PostHog**

Recommended operational error monitoring:

**Sentry**

## 30.1 Analytics events

Audience:

- app_opened;
- tournament_opened;
- match_opened;
- match_marked_interesting;
- match_unmarked_interesting;
- player_opened;
- player_followed;
- player_unfollowed;
- following_feed_opened;
- notification_opened;
- sponsor_impression;
- sponsor_click.

Player:

- player_claim_started;
- player_claim_succeeded;
- my_matches_opened.

Referee:

- referee_match_opened;
- scoring_offline_entered;
- scoring_offline_recovered;
- score_sync_error;
- score_sync_conflict.

Admin/operator:

- admin_action;
- screen_mode_changed where useful.

## 30.2 Never send

Do not send to analytics:

- access codes;
- player claim codes;
- auth tokens;
- phone numbers;
- email if unnecessary;
- private notes;
- score API secrets.

## 30.3 Sentry context

Critical scoring errors should include safe identifiers:

- app version;
- platform;
- tournament ID;
- match ID;
- device installation ID;
- online/offline state;
- pending queue count;
- API endpoint;
- error class.

Do not attach private credentials.

---

# 31. Notifications implementation

Recommended provider abstraction:

- Expo Notifications for app integration;
- APNs/FCM underneath;
- server-side delivery worker/service.

## 31.1 Event generation

Business events should generate notification candidates.

Examples:

`match_scheduled`  
`match_rescheduled`  
`court_changed`  
`match_starting`  
`match_live`  
`match_completed`  
`stage_completed`  
`tournament_started`  
`tournament_winner`

## 31.2 Recipient resolution

For each event resolve:

- followed players;
- interested matches;
- own player account;
- global tournament subscribers if event is major.

## 31.3 Dedupe

Generate deterministic dedupe key.

Example:

`match_completed:<match_id>:<user_or_device_id>`

## 31.4 Quiet/noise control

Do not notify for every score point.

Score point notifications are explicitly out of scope.

---

# 32. Privacy policy, terms, support

Required launch assets:

- Privacy Policy;
- Terms of Use;
- Support page/contact.

Privacy policy should cover at minimum:

- account data;
- player profile association;
- push tokens;
- follow/interest preferences;
- analytics;
- device/application diagnostics;
- public tournament data;
- sponsor metrics;
- retention/contact for deletion request.

If users can create accounts, provide account deletion path according to applicable store requirements.

---

# 33. Environments

Maintain:

- local;
- staging/preview;
- production.

Never point development builds at production by default.

Mobile config should clearly identify environment.

Example:

- `EXPO_PUBLIC_API_BASE_URL`;
- environment label;
- Sentry DSN per environment;
- PostHog key per environment.

Do not place server secrets in `EXPO_PUBLIC_*`.

---

# 34. Feature flags

Recommended flags:

- player_following;
- match_interests;
- personalized_notifications;
- ads_manager_video;
- mobile_admin;
- mobile_operator;
- player_checkin;
- realtime_live_scores.

Flags allow disabling a risky feature without rebuilding the entire tournament backend.

---

# 35. Testing strategy

## 35.1 Existing tests to preserve

Do not regress:

- scoring engine tests;
- tennis tests;
- tie tests;
- sponsor tests;
- screen tests;
- scoring lease tests;
- tennis-week E2E;
- tennis-TV E2E;
- replay tests.

## 35.2 New unit tests

Add for:

- follow resolution;
- interest merge;
- notification dedupe;
- player-code validation;
- player-code single use;
- featured tournament resolution;
- sponsor campaign scheduling;
- campaign link validation;
- offline queue ordering;
- native score recovery.

## 35.3 Integration tests

Required:

- player follows player → schedule event → one push recipient;
- user follows both players → only one notification;
- user follows player + marks match interesting → one notification;
- court changed → player follower receives update;
- offline score queue syncs in order;
- duplicate score retry remains idempotent;
- device lock prevents second scorer;
- admin releases lock → second device continues;
- sponsor hidden → disappears across intended surfaces;
- featured tournament change → web and app reflect same value.

## 35.4 Device matrix

At minimum test:

- recent iPhone;
- older supported iPhone;
- common Android flagship;
- common mid-range Android;
- iPad/tablet;
- weak/slow mobile data;
- offline/airplane mode.

## 35.5 Network scenarios

Test:

- full offline;
- high latency;
- packet loss;
- network switching Wi-Fi → SIM;
- SIM → Wi-Fi;
- app background/foreground;
- app kill;
- device sleep;
- stale auth;
- server 500;
- timeout;
- duplicate POST;
- retry after acknowledgement loss.

---

# 36. Real tournament QA dataset

Use a clone of a real tournament structure.

Recommended test setup:

- one Davis-style team event;
- 16 nations;
- multiple courts;
- realistic tie schedule;
- singles and doubles;
- actual stage progression.

Do not test only with tiny artificial two-team data.

---

# 37. Load testing

Before event:

Test at least:

- 1,000 public clients reading;
- 20 live matches/courts;
- sponsor assets;
- player directory;
- live match refresh.

Measure:

- API latency;
- database load;
- cache hit rate;
- error rate;
- public update delay.

Scoring writes are low volume relative to audience reads, but scoring integrity is highest priority.

---

# 38. Security testing

Before production:

- verify auth-code brute force rate limits;
- player claim-code rate limit;
- no direct database-write key in native bundle;
- verify public endpoints exclude private data;
- inspect network logs;
- test role escalation;
- test tournament ID tampering;
- test match ID tampering;
- test expired/revoked access;
- validate external sponsor URLs;
- restrict file upload type/size;
- verify video/embed sanitization.

---

# 39. Store strategy

## 39.1 Apple

Existing developer account available.

Prepare:

- bundle identifier;
- app record;
- app icon;
- screenshots;
- privacy data;
- privacy policy URL;
- support URL;
- reviewer instructions;
- reviewer access method;
- TestFlight;
- production submission.

If event deadline demands it, request expedited review with clear event context.

## 39.2 Google Play

No account currently.

Create an **Organization** Play Console account.

Complete:

- organization verification;
- D-U-N-S/business verification if required;
- package ID;
- store listing;
- app access instructions;
- Data Safety;
- privacy policy;
- internal testing;
- production submission.

Avoid creating the project under a new Personal developer account if that would introduce testing eligibility delays incompatible with event timing.

## 39.3 Fallback

Keep mobile public web working.

QRs at venue can point to public web if store install is unavailable.

Native success must not become a single point of failure for spectator access.

---

# 40. Five-day review-ready sprint

## Day 1 — foundation/security/contracts

- security audit;
- API contract map;
- mobile scaffold;
- environment config;
- shared types/scoring extraction plan;
- Figma foundations;
- audience core design;
- featured tournament backend model;
- public discover endpoint.

## Day 2 — spectator core

- Discover;
- tournament hub;
- all matches;
- live match;
- schedule;
- player directory;
- local Interesting matches;
- tournament skins.

## Day 3 — personalization + referee

- account/auth;
- player follow;
- player claim;
- Following feed;
- push registration;
- referee access code;
- match picker;
- native scoring UI;
- SQLite event queue.

## Day 4 — operations/commercial

- admin operational screens;
- TV operator entry/control;
- Ads Manager core;
- sponsor preview;
- announcements;
- PostHog;
- Sentry;
- iPad/tablet refinements.

## Day 5 — release candidate

- unit/integration regression;
- offline drills;
- score device handover;
- native builds;
- TestFlight;
- Play internal track;
- store metadata;
- privacy/terms/support;
- submission package.

---

# 41. October hardening plan

Use remaining time before 1 November for reliability.

## Week 1

- stabilize public APIs;
- stabilize scoring queue;
- fix critical UX;
- verify Figma-to-code consistency.

## Week 2

- real tournament clone;
- player follows;
- notification tests;
- sponsor campaigns;
- admin/operator.

## Week 3

- load testing;
- device matrix;
- store review fixes;
- venue-specific operational review.

## Final week

- feature freeze;
- only P0/P1 fixes;
- production rehearsal;
- backup devices;
- final store versions;
- production monitoring dashboards;
- staff training.

---

# 42. Event-day runbook

## 42.1 Before gates open

Verify:

- production API healthy;
- Supabase healthy;
- Sentry quiet;
- no pending migration;
- sponsor assets load;
- featured tournament correct;
- tournament public access on;
- all courts present;
- match schedule correct;
- TV screens correct;
- referee access code works;
- operator access works;
- push delivery test;
- QR/public links working.

## 42.2 Referee briefing

Every referee must know:

- select correct match;
- verify players/court;
- what Online/Offline/Pending means;
- continue scoring offline;
- never open same live match on second phone unless released;
- how to undo;
- how to pause;
- when to use retirement/walkover/DQ;
- who to contact for device replacement.

## 42.3 Control room

Monitor:

- live score delays;
- pending sync devices;
- TV screen status;
- incorrect court assignments;
- sponsor display;
- public API errors;
- notification delivery.

## 42.4 Incident severity

### P0

Examples:

- score corruption;
- multiple authoritative scoring devices;
- database write security exposure;
- system-wide outage.

Action:

- freeze affected feature;
- switch to safe fallback;
- preserve evidence/logs;
- recover authoritative state.

### P1

Examples:

- one match cannot sync;
- referee app crash loop;
- wrong TV score;
- critical notification/court update failure.

### P2

Examples:

- cosmetic issue;
- sponsor animation issue;
- minor alignment.

Do not deploy P2 fixes during active critical play unless risk is negligible.

---

# 43. Rollback strategy

For web/backend:

- preserve previous deploy;
- use reversible migrations where possible;
- avoid destructive schema changes immediately before event.

For mobile:

- backend feature flags;
- server-side disable risky features;
- public web fallback.

Native binary cannot be instantly rolled back on every user device, so design server contracts defensively.

---

# 44. Observability dashboard

Event operations dashboard should expose:

- API error rate;
- scoring sync failures;
- conflict count;
- pending score queues reported;
- active live matches;
- push errors;
- sponsor media failures;
- application version distribution;
- public traffic.

Create alerts for:

- surge in score event failures;
- 5xx spike;
- database latency;
- push service outage;
- storage/media errors.

---

# 45. Backup/failure scenarios

## Internet failure at venue

Referees continue offline.

Public spectators may see stale scores until connectivity restores.

## One referee phone dies

Release control and move to replacement device.

## TV internet fails

Use last loaded state/holding fallback where possible and restore link.

## Push outage

Core app remains usable; push is convenience, not source of truth.

## Sponsor video fails

Fall back to poster/static logo.

## Store app unavailable

Use public web/PWA QR.

---

# 46. Acceptance criteria — audience

V1 audience is accepted when:

- app opens without mandatory login;
- featured tournament is visible;
- all tournaments remain accessible;
- all public matches are accessible;
- match filters work;
- Interesting can be toggled;
- guest interests persist locally;
- all players are discoverable;
- players can be followed;
- followed player next match is visible;
- live scores show correct state;
- match detail is clear;
- tournament schedule/draw/results work;
- sponsor placements load;
- major announcements can be received.

---

# 47. Acceptance criteria — player

- account can be created;
- valid player code links correct profile;
- invalid/used code fails safely;
- admin can assign profile;
- My Matches shows next match first;
- court/time changes appear;
- ranking/statistics/history available when data exists;
- own-match notifications work;
- no private player data leaks publicly.

---

# 48. Acceptance criteria — referee

- access code works;
- match list works;
- scoring engine behaves same as web rules;
- score tap is immediate;
- offline event persists;
- app can be killed/reopened without losing queued event;
- reconnect sync is ordered;
- duplicate retry is idempotent;
- second scoring device is blocked;
- undo works;
- result-confirmation setting works;
- final result reaches public/TV correctly.

---

# 49. Acceptance criteria — admin/operator

Admin:

- teams visible;
- key edits work;
- matches/courts/times manageable;
- settings editable;
- draw edits admin-only;
- announcements possible;
- sponsors manageable.

Operator:

- screens visible;
- modes controllable;
- court coverage/pin works;
- sponsor/holding/break controls work.

---

# 50. Acceptance criteria — sponsor

- main sponsor works;
- footer sponsors work;
- hide/show works;
- live preview matches real display;
- image creative works;
- video creative works;
- campaign date window works;
- optional link works;
- metrics record without affecting scoring performance.

---

# 51. Phase 2

Planned after stable launch:

- full tournament creation from mobile;
- event-scoped access codes;
- named staff accounts;
- granular role grants;
- richer push preferences;
- sponsor promotional push;
- advanced campaign analytics;
- full player check-in workflows;
- deeper tournament following;
- cross-event player following;
- additional sport rulesets;
- richer admin parity;
- more sophisticated public search.

---

# 52. Phase 3 / longer-term

Potential:

- wallet passes;
- ticket integration where relevant;
- club/academy integrations;
- athlete career profiles;
- season-wide following;
- livestream integration;
- broadcaster overlays;
- federation feeds;
- richer sponsor CRM exports;
- multilingual app;
- venue maps;
- advanced event content/news;
- social sharing cards.

These are not launch scope.

---

# 53. Locked current decisions

- product called Move Score;
- native folder: `move-score-app`;
- English only V1;
- audience opens directly into tournament discovery;
- no mandatory audience login;
- featured tournament controlled in admin and affects web + app;
- all matches publicly discoverable;
- users can mark matches Interesting;
- all players publicly discoverable;
- users can follow players;
- followed-player match notifications are required;
- player code claim + admin assignment;
- juniors have their own accounts for now;
- My Matches prioritizes upcoming match, ranking, statistics;
- player check-in not used for Davis/BJK scoring event;
- court/time changes notify player;
- team tie + individual rubber views supported;
- multi-sport architecture;
- referee access code;
- current referee can see all matches;
- future event-scoped role codes;
- offline scoring mandatory;
- referee can correct mis-click;
- final result confirmation is tournament setting;
- operator is TV operator, not referee;
- full audit required;
- mobile admin V1 is operations-first;
- full tournament creation later;
- draw edits admin only;
- sponsor footer preview;
- sponsor hide/show;
- image/video creative;
- upload/embed support;
- optional links;
- scheduling;
- tournament targeting;
- sponsor metrics;
- sponsor push Phase 2;
- Apple developer account exists;
- Google Play account must be created;
- publisher/store company handling remains owner responsibility;
- privacy policy/terms/support must be created;
- hard public target 1 November;
- ~1,000 concurrent spectators;
- up to 20 courts;
- primarily SIM/mobile network;
- personal iOS and Android phones;
- tablet/iPad layouts supported;
- push infrastructure may be created;
- PostHog + Sentry recommended;
- staging + production exist;
- use realistic tournament clone for QA;
- new Figma file created;
- Luma is inspiration for polish/hierarchy, not a template;
- reliability remains top priority.

---

# 54. Pending inputs

Still required from product/event owner:

1. final Move Score logo;
2. approved Davis Cup / Billie Jean King Cup artwork package for app use;
3. final official competition rules/regulations;
4. Apple bundle ID;
5. Android package ID;
6. Google Play Organization account;
7. privacy/support domain/public URLs;
8. final account-auth method if not chosen during implementation;
9. final tournament data for production;
10. sponsor creative files/campaign rules.

None of these should block core architecture work except final branding, store publication, and official scoring-rule confirmation.

---

# 55. Definition of done for the first public event

The project is considered event-ready only when:

- security launch gate passes;
- scoring offline/online recovery passes;
- production tournament data is verified;
- audience can see all matches;
- audience can browse/follow players;
- interests/follows behave correctly;
- notification dedupe passes;
- referee personal devices pass network tests;
- TV/operator flows pass;
- sponsor surfaces pass;
- public web fallback passes;
- TestFlight/Android production candidate is stable;
- production monitoring is enabled;
- event staff complete rehearsal;
- no unresolved P0/P1 issue remains.

---

# 56. Final architecture summary

```text
                            MOVE SCORE
                                │
            ┌───────────────────┼────────────────────┐
            │                   │                    │
         WEB ADMIN          PUBLIC WEB          NATIVE APP
         Next.js            fallback            Expo / RN
            │                   │                    │
            └───────────────────┼────────────────────┘
                                │
                         SERVER API LAYER
                                │
                    AUTH / PERMISSIONS / AUDIT
                                │
      ┌─────────────────────────┼──────────────────────────┐
      │                         │                          │
  TOURNAMENT                SCORING                    ENGAGEMENT
  teams                     score events               follows
  players                   snapshots                  interests
  ties/rubbers              leases                     notifications
  courts                    offline sync               announcements
  draws                     audit                      sponsors
      │                         │                          │
      └─────────────────────────┼──────────────────────────┘
                                │
                           SUPABASE
                 PostgreSQL + Storage + secure server access
```

The essential rule is simple:

**one tournament truth, multiple carefully permissioned experiences.**
