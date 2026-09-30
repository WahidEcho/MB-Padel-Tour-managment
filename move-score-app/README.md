# Move Score Mobile

Native mobile application workspace for Move Score.

## Product roles
- Public audience: no-login tournament discovery, live scores, schedules, draws, results, event information and sponsors.
- Player: player-code claim, My Matches, rankings, statistics, history and notifications.
- Referee: access-code login, full match list, offline-first scoring and score correction.
- Admin: tournament operations, teams, settings, match generation and score oversight.
- TV operator: event screen control.
- Sponsors: tournament-scoped campaigns and live sponsor footer control.

## Architecture direction
- React Native + Expo + TypeScript.
- Existing Next.js/Supabase platform remains the system of record.
- Reuse pure TypeScript scoring/rules logic from the web project.
- Native offline scoring queue uses durable SQLite storage and the existing ordered score-event/device-lock API protocol.
- Web and mobile share tournament highlighting, sponsor configuration, scoring settings and permissions.

## Launch priorities
1. Reliability and offline scoring.
2. Audience tournament discovery + live scores.
3. Player My Matches.
4. Referee operations.
5. Sponsors / Ads Manager.
6. Mobile admin operations.

Full tournament creation is Phase 2; v1 focuses on event operations and public experience.
