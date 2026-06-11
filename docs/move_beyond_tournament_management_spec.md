# Move Beyond Tournament Management Platform

**Document type:** Product Requirements Document + Technical Specification + 2-Day Production Plan  
**Platform name:** Move Beyond Tournament Management  
**Version:** V1 Production MVP Specification  
**Prepared for:** Move Beyond  
**Primary sport for V1:** Padel  
**Future expansion:** Other sports can be added later through a sport/rules engine  
**Target delivery window:** 2 production days  
**Target devices:** Laptop, tablet, mobile browser, and TV display  

---

## 1. Executive Summary

Move Beyond Tournament Management is a responsive web-based tournament operations platform designed to manage padel tournaments live during events. The system will allow Move Beyond to create tournaments, add teams and players, upload player photos, build group stages, randomize teams into groups, manually drag/drop teams, generate matches, manage live scoring, run multiple live matches, update leaderboards automatically, generate knockout brackets, support manual check-in, support offline scoring, and showcase live tournament screens on TVs and mobile browsers.

The V1 platform is focused on padel only, but the product must be structured so that future versions can support additional sports such as beach tennis, volleyball, football 5-a-side, racket games, e-sports, and corporate leagues.

The V1 must be event-ready and operational, not only a visual prototype. The highest priority is reliability during a live tournament.

---

## 2. Locked Product Direction

### 2.1 Product Positioning

The product will be positioned as:

> **Move Beyond Tournament Management** — a live tournament management web platform for scoring, leaderboards, brackets, and event display screens.

### 2.2 Current Scope

V1 is for padel tournaments only.

V1 must support:

- Group stage + knockout format.
- Any number of teams.
- Manual team/player entry.
- CSV upload using a downloadable template.
- Team/player photos.
- Manual tournament-level check-in.
- Group randomization with multiple draw options.
- Drag/drop group editing.
- Match generation.
- Manual match editing.
- Live referee scoring.
- Multiple simultaneous matches.
- Offline referee scoring.
- Live leaderboard.
- Public TV display screens.
- Knockout bracket generation and editing.
- Clone tournament feature.
- Excel export.
- Demo/test mode.

### 2.3 Out of Scope for V1

The following are planned for future versions and should not block the 2-day build:

- Native mobile app.
- App Store / Google Play deployment.
- QR code check-in.
- Mobile QR scanner application.
- Advanced referee assignment.
- Department/company separation algorithm.
- Seeded ranking automation.
- Push notifications.
- Sponsor analytics dashboard.
- Player registration portal.
- Payment collection.
- Arabic RTL interface.
- Multi-sport scoring engines.
- Certificates and print-ready result sheets.
- Advanced AI schedule optimization.

---

## 3. Branding and Identity Requirements

### 3.1 Platform Name

The platform name is:

> **Move Beyond Tournament Management**

### 3.2 Branding Structure

Every tournament should support the following branding structure:

| Branding Element | V1 Requirement |
|---|---|
| Move Beyond logo | Required |
| Client/place logo | Optional but supported |
| Sponsor logos | Optional but supported |
| TV display branding | Required |
| Lower-third text/banner | Required and editable |
| Light mode | Required |
| Dark mode | Required |

### 3.3 Branding Uploads

The tournament setup should allow uploading:

- Move Beyond logo.
- Client/place logo.
- Sponsor logos.
- Optional event logo.
- Optional background image or pattern.

### 3.4 Display Modes

The system must support both:

- **Light mode** for normal admin use.
- **Dark mode** for TV/event display.

The admin or screen operator should be able to select the preferred theme per public display screen.

### 3.5 Brand Identity Pending Input

Move Beyond brand identity will be uploaded later. The UI should be built using a theme configuration object so brand colors can be replaced quickly.

Recommended theme config:

```ts
const theme = {
  primaryColor: "#000000",
  secondaryColor: "#FFFFFF",
  accentColor: "#00AEEF",
  backgroundLight: "#FFFFFF",
  backgroundDark: "#0B0B0B",
  textLight: "#111111",
  textDark: "#FFFFFF",
  borderRadius: "20px",
};
```

---

## 4. Users, Roles, and Permissions

### 4.1 User Roles

The platform must support these roles from V1:

| Role | Description |
|---|---|
| Super Admin | Full Move Beyond control over all tournaments. |
| Admin | Full control over a specific tournament. |
| Tournament Manager | Can manage tournament operations, teams, groups, matches, check-in, scoring corrections, and bracket approval. |
| Referee | Shared referee login; can view all matches, start matches, score matches, undo scores, override/end matches, and update match status. |
| Screen Operator | Controls what appears on TV/public display screens. |
| Viewer/Public | Read-only access to public tournament screens. |

### 4.2 Login Requirements

V1 should use:

- One shared referee login.
- Admin login.
- Tournament manager login.
- Screen operator login.
- Public read-only links without login.

### 4.3 Referee Access

The shared referee login can:

- See all matches.
- Start any match.
- Score any match.
- Undo scores.
- Override/end matches.
- Handle disqualification/walkover.
- Use offline scoring.

### 4.4 Critical Action Permissions

| Action | Super Admin | Admin | Tournament Manager | Referee | Screen Operator |
|---|---:|---:|---:|---:|---:|
| Create tournament | Yes | Yes | Optional | No | No |
| Clone tournament | Yes | Yes | Yes | No | No |
| Add/edit teams | Yes | Yes | Yes | No | No |
| Upload player photos | Yes | Yes | Yes | No | No |
| Manual check-in | Yes | Yes | Yes | Yes | No |
| Create groups | Yes | Yes | Yes | No | No |
| Randomize groups | Yes | Yes | Yes | No | No |
| Drag/drop group teams | Yes | Yes | Yes | No | No |
| Generate matches | Yes | Yes | Yes | No | No |
| Start match | Yes | Yes | Yes | Yes | No |
| Score match | Yes | Yes | Yes | Yes | No |
| Undo score | Yes | Yes | Yes | Yes | No |
| Force end match | Yes | Yes | Yes | Yes | No |
| Edit final result | Yes | Yes | Yes | Yes | No |
| Approve bracket | Yes | Yes | Yes | Yes | No |
| Edit bracket positions | Yes | Yes | Yes | Yes | No |
| Control TV screen | Yes | Yes | Yes | No | Yes |
| Export Excel | Yes | Yes | Yes | No | No |

### 4.5 Audit Requirement

Every sensitive action must be logged:

- Score added.
- Game won.
- Set ended.
- Undo used.
- Manual override.
- Walkover.
- Disqualification.
- Bracket edited.
- Match reopened.
- Final result edited.
- Tournament cloned.

---

## 5. Tournament Setup Requirements

### 5.1 Supported Tournament Type in V1

V1 supports:

> **Group Stage + Knockout**

The system should be designed so knockout-only and league-only formats can be added later, but they are not required for V1.

### 5.2 Number of Teams

The platform must support any number of teams.

The tournament setup should not be restricted to fixed presets such as 8, 12, or 16 teams.

### 5.3 Odd Number of Teams

If there is an odd number of teams in knockout pairing, the system must support a **Lucky Team / Bye**.

Definition:

- If a knockout round has an odd number of teams, one team automatically advances to the next round.
- This team is marked as **Lucky Team** or **BYE Advance**.
- The admin/tournament manager/referee can select the lucky team manually, or the system can choose based on ranking/randomization.

Recommended V1 behavior:

1. If knockout teams are odd, show a warning.
2. System suggests one lucky team.
3. Admin/tournament manager/referee can approve or change it.
4. Lucky team advances without score.
5. Audit log records the decision.

### 5.4 Auto-Generated but Editable Structure

The system should automatically generate:

- Groups.
- Group team distribution.
- Group stage matches.
- Knockout bracket.

But the admin/tournament manager/referee must be able to edit:

- Group names.
- Team positions.
- Match order.
- Match court.
- Match time.
- Bracket positions.
- Who faces who in knockout.

---

## 6. Tournament Clone Feature

### 6.1 Required Feature

The system must include an option to:

> **Clone Tournament and Start Again**

This allows Move Beyond to reuse the same tournament setup, teams, players, photos, groups, courts, branding, and rules without rebuilding everything from zero.

### 6.2 Clone Button Location

The clone feature should appear in:

- Tournament list page.
- Tournament settings page.
- Completed tournament summary page.

Button label:

> **Clone Tournament**

### 6.3 Clone Behavior

When cloning a tournament, the system should copy:

| Data | Clone? | Notes |
|---|---:|---|
| Tournament name | Yes, with suffix | Example: `Move Beyond Cup - Copy` |
| Branding | Yes | Move Beyond, client, sponsor logos |
| Tournament format | Yes | Group stage + knockout |
| Scoring rules | Yes | Set to 6, advantage scoring, tie-break settings |
| Courts setup | Yes | Court count and names |
| Teams | Yes | Same teams |
| Players | Yes | Same players |
| Player photos | Yes | Same photo URLs/assets |
| Groups | Yes | Same group structure |
| Group team placement | Yes | Same draw by default |
| Match schedule | Optional | Can clone or regenerate |
| Match results | No | Must reset |
| Score history | No | Must reset |
| Leaderboard | No | Must reset |
| Check-in status | No | Reset to Not arrived |
| Bracket results | No | Reset |
| Champion/winner | No | Reset |

### 6.4 Clone Options Modal

When clicking clone, show modal:

```text
Clone Tournament

Tournament Name: [Move Beyond Cup - New Run]

What do you want to copy?
[x] Teams and players
[x] Player photos
[x] Groups and team placement
[x] Match schedule
[x] Branding
[x] Scoring rules
[x] Courts

Reset:
[x] Scores
[x] Leaderboard
[x] Check-in status
[x] Bracket results

Buttons:
Cancel | Clone and Start New Tournament
```

### 6.5 Default Clone Mode

Default V1 clone mode:

- Copy everything operational.
- Reset all live data.
- Reset check-in to `Not arrived`.
- Reset all matches to `Scheduled`.
- Reset all scores to zero.
- Reset leaderboard.
- Keep the same teams and same groups.

### 6.6 Technical Clone Logic

Pseudo logic:

```ts
async function cloneTournament(sourceTournamentId, cloneOptions) {
  const source = await getTournamentWithAllRelations(sourceTournamentId);

  const newTournament = await createTournament({
    name: cloneOptions.newName,
    cloned_from_tournament_id: sourceTournamentId,
    status: "draft",
    branding_config: source.branding_config,
    scoring_config: source.scoring_config,
    format_config: source.format_config,
    court_config: source.court_config,
  });

  const teamIdMap = await cloneTeamsAndPlayers(source.teams, newTournament.id);

  if (cloneOptions.copyGroups) {
    const groupIdMap = await cloneGroups(source.groups, newTournament.id);
    await cloneGroupTeams(source.groupTeams, groupIdMap, teamIdMap);
  }

  if (cloneOptions.copySchedule) {
    await cloneMatchesAsScheduled(source.matches, newTournament.id, teamIdMap, groupIdMap);
  } else {
    await generateMatches(newTournament.id);
  }

  await resetTournamentRuntimeState(newTournament.id);

  return newTournament;
}
```

---

## 7. Team and Player Data

### 7.1 Required Team Data

Each team requires:

| Field | Required? | Notes |
|---|---:|---|
| Team name | Yes | Main display name |
| Player 1 name | Yes | Displayed in match cards |
| Player 2 name | Yes | Displayed in match cards |
| Player 1 photo | Optional | Displayed if uploaded |
| Player 2 photo | Optional | Displayed if uploaded |
| Phone number | Optional | For fast contact only |
| Notes | Optional | Internal notes |
| Check-in status | Yes | Default: Not arrived |

### 7.2 Photo Rules

- Player photos are optional.
- If no photo is uploaded, show initials/avatar placeholder.
- Photos should appear in:
  - Team profile card.
  - Leaderboard, where space allows.
  - Live match card.
  - Winner screen.
  - Bracket preview, where space allows.

### 7.3 Manual Team Entry

The admin/tournament manager must be able to add teams manually using a form:

```text
Team Name
Player 1 Name
Player 1 Photo
Player 2 Name
Player 2 Photo
Phone Number
Notes
Save Team
```

### 7.4 CSV Upload

The system should provide:

- Download CSV template button.
- Upload filled CSV button.
- Preview imported rows.
- Validate missing required fields.
- Confirm import.

### 7.5 CSV Template Columns

The V1 CSV template should include:

```csv
team_name,player_1_name,player_2_name,player_1_photo_url,player_2_photo_url,phone,notes
Team Alpha,Ahmed Ali,Omar Khaled,,,01000000000,
Team Bravo,Mohamed Samir,Youssef Hany,,,01000000001,
```

### 7.6 CSV Validation Rules

Required:

- `team_name`
- `player_1_name`
- `player_2_name`

Optional:

- `player_1_photo_url`
- `player_2_photo_url`
- `phone`
- `notes`

Validation behavior:

- If required field missing, row is blocked.
- If photo URL is invalid, import team but ignore photo URL.
- If duplicate team name exists, show warning and allow admin to continue or rename.

---

## 8. Manual Check-In

### 8.1 Check-In Statuses

V1 statuses:

```text
Not arrived
Checked in
No-show
Disqualified
```

### 8.2 Who Can Check In

The following roles can update check-in:

- Admin.
- Tournament Manager.
- Referee.

### 8.3 Check-In Level

Check-in is tournament-level only in V1.

Meaning:

- A team is marked as arrived for the tournament.
- Match-level readiness is not required in V1.

### 8.4 Starting Match Without Check-In

If a match is started while one or both teams are not checked in:

- Show warning.
- Allow override.
- Admin, tournament manager, and referee can override.

Warning example:

```text
Warning: Team Alpha is not checked in.
Do you still want to start this match?

Cancel | Start Anyway
```

---

## 9. Group Stage Management

### 9.1 Group Generation

The admin should define:

- Number of teams.
- Preferred group count or preferred teams per group.
- Qualification rule.

System should generate groups automatically.

### 9.2 Balanced Group Algorithm

If the number of teams is not divisible by the number of groups, distribute teams as evenly as possible.

Example:

```text
10 teams into 3 groups:
Group A: 4 teams
Group B: 3 teams
Group C: 3 teams
```

Algorithm:

```ts
function distributeTeamsIntoGroups(teams, groupCount) {
  const baseSize = Math.floor(teams.length / groupCount);
  const extra = teams.length % groupCount;

  return Array.from({ length: groupCount }, (_, i) => ({
    groupName: `Group ${String.fromCharCode(65 + i)}`,
    size: baseSize + (i < extra ? 1 : 0),
  }));
}
```

### 9.3 Round-Robin Match Count

For a group with `n` teams:

```text
Matches per group = n × (n - 1) / 2
Matches per team = n - 1
```

Examples:

| Teams in Group | Matches per Group | Matches per Team |
|---:|---:|---:|
| 3 | 3 | 2 |
| 4 | 6 | 3 |
| 5 | 10 | 4 |
| 6 | 15 | 5 |

### 9.4 Odd Group Size

If a group has an odd number of teams, round-robin scheduling uses a BYE placeholder.

Example for 3 teams:

```text
Round 1: Team A vs Team B, Team C rests
Round 2: Team A vs Team C, Team B rests
Round 3: Team B vs Team C, Team A rests
```

The BYE inside group stage means rest round only. It does not mean automatic qualification.

### 9.5 Drag-and-Drop Group Editing

Admin/tournament manager must be able to:

- Drag teams between groups.
- Reorder teams inside a group.
- Lock teams in position.
- Save group draw.
- Publish group draw.

Once published, editing groups should show warning because matches may need regeneration.

Warning example:

```text
Changing groups after publishing will regenerate group matches and may affect the schedule.
Continue?
```

---

## 10. Randomizer and Multiple Draw Options

### 10.1 Required Randomizer Features

The group randomizer must support:

- Multiple draw options.
- Locked teams.
- Manual selection of final draw.
- Save selected draw.
- Regenerate draw.

### 10.2 V1 Randomizer Flow

1. Admin adds teams.
2. Admin selects number of groups or group size.
3. Admin optionally locks some teams in specific groups.
4. Admin clicks `Generate Draw Options`.
5. System generates multiple draw options.
6. Admin previews options.
7. Admin selects one option.
8. Admin can manually drag/drop after selection.
9. Admin publishes final groups.

### 10.3 Recommended Number of Draw Options

Default:

```text
Generate 5 options
```

Allow setting:

```text
3, 5, or 10 options
```

### 10.4 Locked Teams

Locked team behavior:

- Locked team stays in assigned group.
- Randomizer only moves unlocked teams.
- If a group is full due to locked teams, system prevents more teams from being added.

### 10.5 Future Randomizer Improvements

Future versions can support:

- Seed separation.
- Department/company separation.
- Ranking-based balanced groups.
- Avoid repeat opponents from previous tournaments.

---

## 11. Match Scheduling

### 11.1 Match Scheduling Requirements

V1 should support:

- Auto-generated match schedule.
- Manual match creation.
- Manual match editing.
- Court number.
- Match time.
- Match order.
- Up to 20 courts configured in venue settings.
- Up to 5 live matches at the same time in V1.

### 11.2 Venue Court Setup

Admin/tournament manager enters:

```text
Number of courts: 1 to 20
Court names: Court 1, Court 2, Court 3, etc.
```

For the upcoming event:

```text
Courts: 2
TV/operator screens: 1
```

### 11.3 Match Fields

Each match should include:

| Field | Required? | Notes |
|---|---:|---|
| Tournament ID | Yes | Internal |
| Stage | Yes | Group / Quarter-final / Semi-final / Final / Third-place |
| Group ID | If group match | Group A, B, etc. |
| Round name | Yes | Group Round 1, QF1, SF1, Final |
| Team A | Yes | Team |
| Team B | Yes | Team |
| Court | Optional but recommended | Court 1, Court 2 |
| Match order | Yes | Used if no exact time |
| Match time | Optional | Manually set in V1 |
| Status | Yes | Scheduled, Live, Completed, etc. |

### 11.4 Match Statuses

```text
Scheduled
Ready
Live
Paused
Completed
Walkover
Disqualified
Retired
Cancelled
Pending Sync
```

### 11.5 Starting Matches

Both admin/tournament manager and referee can start matches.

Start flow:

1. Select match.
2. Click `Start Match`.
3. System checks check-in statuses.
4. If not checked in, show warning.
5. Select first server.
6. Confirm start.
7. Match status becomes `Live`.
8. Timer starts.
9. Public displays update.

---

## 12. Padel Scoring Rules for V1

### 12.1 Default Match Format

V1 default:

```text
1 set to 6 games
Tie-break at 6-6
Standard advantage scoring
```

### 12.2 Match Override Requirement

During a match, admin/tournament manager/referee must be able to end the match at any time with the current score and selected winner.

This is required for real event flexibility.

Override flow:

1. Click `Force End Match` or `End Match Now`.
2. Select winner team.
3. System shows current score.
4. Confirmation modal appears.
5. User confirms.
6. Match is saved with current score.
7. Winner is registered.
8. Leaderboard/bracket updates.
9. Audit log records the override.

Confirmation example:

```text
You are about to end this match manually.

Current score:
Team A: 4 games
Team B: 2 games

Selected winner: Team A

This action will register Team A as the winner using the current score.

Cancel | Confirm End Match
```

### 12.3 Point Progression

Normal game score progression:

```text
0 → 15 → 30 → 40 → Game
```

### 12.4 Advantage Scoring

V1 uses standard advantage scoring:

```text
40-40 → Advantage Team A
Advantage Team A + Team A wins next point → Game Team A
Advantage Team A + Team B wins next point → Back to 40-40
```

Same logic for Team B.

### 12.5 Golden Point Handling in V1

A separate Golden Point scoring mode is not required in V1.

For fast friendly/event use, the referee can still end the game quickly using the standard advantage flow:

- At deuce, first tap gives advantage.
- Second tap for the same team confirms game.

Future version can add a true Golden Point toggle.

### 12.6 Game-Winning Confirmation

When a score click will cause a team to win the game, the system must show confirmation.

Example:

```text
Team A is about to win this game.
Current point score: 40 - 15
Game score will become: Team A 1 - 0 Team B

Cancel | Confirm Game
```

This prevents accidental game wins from wrong taps.

### 12.7 Set Rules

Default set rule:

```text
First team to 6 games wins the set.
Team must win by 2 games.
At 6-6, tie-break starts.
```

Examples:

```text
6-0 → set won
6-1 → set won
6-2 → set won
6-3 → set won
6-4 → set won
6-5 → not finished; continue
7-5 → set won
6-6 → tie-break
7-6 → set won by tie-break winner
```

### 12.8 Tie-Break Rules

V1 tie-break:

```text
Tie-break starts at 6-6.
Tie-break points are counted numerically: 0, 1, 2, 3, etc.
Recommended rule: first to 7 points, win by 2.
Winner of tie-break wins set 7-6.
```

Per user input, the product should keep this simple and event-friendly.

If required by event settings, the system can include a config flag:

```ts
tiebreakTargetPoints: 7,
tiebreakWinByTwo: true
```

### 12.9 Super Tie-Break

Super tie-break to 10 is not required for V1.

Future version can add:

```text
Super tie-break to 10, win by 2
```

### 12.10 Manual End Set

Referee/admin/tournament manager can manually end a set even if normal score condition is not reached.

User requirement:

- This should not require manager permission.
- It should be available during live match operations.

Recommended safety behavior:

- Do not require extra approval permission.
- Still record the manual set end in the audit log.

### 12.11 Serving Team

Before match starts:

- User selects first serving team.
- Tennis/padel ball icon appears beside serving team.

During normal games:

- System can auto-switch serving team after each game.
- User can manually change server if needed.

During tie-break:

- V1 should not show serving team until tie-break ends.
- This keeps V1 simple and avoids tie-break service complexity.

---

## 13. Referee Screen Requirements

### 13.1 Target Devices

The referee page must work well on:

- Tablet browser.
- Mobile browser.

### 13.2 Referee Screen Design

The referee screen must be simple, large, and touch-friendly.

Main elements:

```text
Tournament name
Court number
Match stage
Team A card
Team B card
Current sets
Current games
Current point score
Serve indicator
Match timer
Large Team A score button
Large Team B score button
Undo button
Pause/resume button
Change server button
End match button
Walkover/disqualification button
Offline sync status
```

### 13.3 Button Requirements

Required buttons:

| Button | Requirement |
|---|---|
| Team A score | Huge button |
| Team B score | Huge button |
| Undo | Requires confirmation and cancel button |
| Change server | Manual correction |
| Pause match | Pauses timer/status |
| Resume match | Resumes timer/status |
| End match | Requires confirmation |
| Force winner | Requires selected winner + confirmation |
| Disqualify Team A/B | Requires confirmation |
| Walkover Team A/B | Requires confirmation |

### 13.4 Undo Rules

Undo must:

- Require confirmation.
- Include cancel button.
- Be allowed during live match.
- Support unlimited undo during live match.
- Not delete original event history.
- Create an undo/correction event in the audit trail.

Undo confirmation example:

```text
Undo last scoring action?

This will revert the last point/game action and save an undo record.

Cancel | Confirm Undo
```

### 13.5 Score Event History

Every scoring click must create a history log.

Each event should store:

- Match ID.
- Event number.
- Event type.
- Scoring team.
- Previous score state.
- New score state.
- User who clicked.
- Timestamp.
- Whether event is synced or pending sync.

### 13.6 Referee Notes

Referee notes are future scope.

Future notes examples:

- Injury.
- Delay.
- Player dispute.
- Weather issue.
- Technical issue.

---

## 14. Walkover, No-Show, Disqualification, and Retirement

### 14.1 No-Show

If a team does not show up:

- Opponent wins by walkover.
- Default score for best-of-3 style result: `6-0 / 6-0`.
- For V1 one-set matches, system can store result as `6-0` while retaining the configured walkover result option.

### 14.2 Walkover Flow

1. Open match.
2. Click `Walkover`.
3. Select team that did not show.
4. System selects opponent as winner.
5. Confirmation appears.
6. Confirm.
7. Match status becomes `Walkover`.
8. Leaderboard/bracket updates.

### 14.3 Disqualification

If team is disqualified:

- Team remains visible in leaderboard.
- Team status becomes `Disqualified`.
- Future matches of that team become automatic walkovers.
- Admin/tournament manager/referee can restore the team if needed.

### 14.4 Restore Disqualified Team

Restore flow:

1. Open team profile.
2. Click `Restore Team`.
3. Confirm restore.
4. Team status changes from `Disqualified` to previous valid status or `Not arrived`.
5. Future match statuses can be regenerated or manually edited.

### 14.5 Retirement / Injury

If team retires due to injury:

- Opponent wins.
- Score can be manually entered or current score can be kept.
- Match status becomes `Retired`.
- Audit log records retirement.

---

## 15. Leaderboard Rules

### 15.1 Point System

V1 point system:

```text
Win = 1 point
Loss = 0 points
Walkover win = 1 point
Disqualified loss = 0 points
```

### 15.2 Leaderboard Fields

Leaderboard should show:

| Field | Meaning |
|---|---|
| Rank | Position inside group |
| Team | Team name + player names/photos where space allows |
| Played | Matches played |
| Won | Matches won |
| Lost | Matches lost |
| Points | Ranking points |
| Sets Won | Total sets won |
| Sets Lost | Total sets lost |
| Set Difference | Sets won - sets lost |
| Games Won | Total games won |
| Games Lost | Total games lost |
| Game Difference | Games won - games lost |
| Status | Pending / Qualified / Eliminated / Disqualified |

### 15.3 Ranking Priority

User selected ranking priority starting with points.

Recommended V1 ranking order:

```text
1. Points
2. Wins
3. Head-to-head
4. Set difference
5. Game difference
6. Games won
7. Manual decision
```

If the user wants the absolute simplest V1, ranking can initially use:

```text
1. Points
2. Game difference
3. Games won
4. Manual decision
```

But the recommended implementation should include head-to-head because it is important in group tournaments.

### 15.4 Live Match vs Official Leaderboard

During live match:

- Show live score in live match screens.
- Do not update official leaderboard until match is completed or synced.

After match ends:

- Recalculate leaderboard.
- Update public display.
- Highlight qualified teams.

If match is completed offline:

- Match status becomes `Pending Sync`.
- Leaderboard updates only after successful sync.

### 15.5 Qualification Statuses

Supported statuses:

```text
Qualified
Pending
Eliminated
Disqualified
```

### 15.6 Manual Qualification Override

Admin/tournament manager/referee can manually override qualification.

Use cases:

- Event timing issue.
- Team withdrawal.
- Dispute resolution.
- Custom organizer decision.

Manual override must be logged.

---

## 16. Knockout Bracket Requirements

### 16.1 Bracket Generation

After group stage ends:

- System identifies qualified teams.
- System generates knockout bracket.
- Admin/tournament manager/referee must approve bracket before publishing.
- Admin/tournament manager/referee can edit teams and who faces who before publishing.

### 16.2 Standard 12-Team Example

For 12 teams:

```text
4 groups × 3 teams
Top 2 qualify from each group
8 teams qualify
Quarter-final starts
```

Default bracket:

```text
QF1: Group A Rank 1 vs Group B Rank 2
QF2: Group B Rank 1 vs Group A Rank 2
QF3: Group C Rank 1 vs Group D Rank 2
QF4: Group D Rank 1 vs Group C Rank 2

SF1: Winner QF1 vs Winner QF3
SF2: Winner QF2 vs Winner QF4

Final: Winner SF1 vs Winner SF2
Third-place match: Loser SF1 vs Loser SF2
```

### 16.3 Bracket Display

Bracket should show team names, not only group codes.

Example:

```text
QF1: Team Alpha vs Team Delta
QF2: Team Bravo vs Team Eagle
```

### 16.4 Avoid Same-Group Rematch

System should try to avoid same-group rematches where possible.

However:

- Admin/tournament manager/referee can override.
- Manual bracket editing is required.

### 16.5 Manual Bracket Editing

Before publishing bracket, user can:

- Drag teams between slots.
- Swap teams.
- Assign lucky team/bye if odd.
- Approve bracket.
- Publish bracket.

### 16.6 Third-Place Match

V1 should include:

- Third-place match.
- Bronze/third place display.

### 16.7 Final Result Display

The final winner screen should show:

- Champion / Winner for first place.
- Runner-up for second place.
- Third place / bronze result from third-place match.
- Team names.
- Player names.
- Player photos.
- Logos and sponsor branding.

---

## 17. Live TV and Public Screens

### 17.1 Required Screens

V1 must include:

```text
Public leaderboard screen
Live match screen
Multi-match screen
Bracket screen
Winner screen
Mobile-friendly public leaderboard
Screen operator control page
```

### 17.2 Public Access

TV/public screens should be:

- Public read-only links.
- Uneditable.
- Auto-reconnecting.
- Responsive for large screens and mobile browser.

### 17.3 Public URL Structure

Recommended route structure:

```text
/t/[tournament-slug]
/t/[tournament-slug]/leaderboard
/t/[tournament-slug]/live
/t/[tournament-slug]/matches
/t/[tournament-slug]/bracket
/t/[tournament-slug]/winner
/t/[tournament-slug]/screen
```

Example:

```text
/t/badya-padel-tour
/t/move-beyond-cup
```

### 17.4 Screen Operator Control Page

Screen operator can choose what the TV display shows:

```text
Show leaderboard
Show Court 1 live match
Show Court 2 live match
Show all live matches
Show bracket
Show winner screen
Show sponsor screen
```

### 17.5 TV Display Requirements

TV screens must have:

- Large readable fonts.
- High contrast.
- Minimal clutter.
- Sponsor/client/Move Beyond logos.
- Editable lower-third banner.
- Auto-refresh/reconnect.
- Score change animation.
- Qualified badge animation.
- Winner highlight animation.

### 17.6 Lower-Third Banner

Default text:

```text
Move Beyond Tournament Management | Powered by Move Beyond
```

Must be editable from tournament settings.

Examples:

```text
Badya Padel Tournament | Powered by Move Beyond
Live Leaderboard | Powered by Move Beyond
Quarter Finals Starting Soon
Final Match Live Now
```

### 17.7 Sponsor Logo Rotation

V1 should support sponsor logo rotation.

Basic behavior:

- Upload multiple sponsor logos.
- Rotate every configurable number of seconds.
- Show on TV screens.

Default rotation:

```text
Every 10 seconds
```

### 17.8 Mobile-Friendly Public View

Mobile public view should not use the exact TV layout.

It should show:

- Groups.
- Team ranks.
- Live matches.
- Bracket.
- Upcoming matches.

---

## 18. Offline Mode Requirements

### 18.1 Offline Mode Scope

Offline mode must work for:

```text
Referee scoring page
Undo
Local match history
Reconnect sync
Admin scoring
Tournament manager scoring
```

### 18.2 Offline Mode Assumption

Realistic 2-day V1 behavior:

- The match page must be opened while online first.
- Once loaded, if internet disconnects, scoring continues locally.
- When internet returns, local events sync automatically.

### 18.3 Offline Warning

Offline badge is mandatory.

Suggested statuses:

```text
Online
Offline - scoring locally
Syncing
Pending Sync
Synced
Sync Error
```

### 18.4 One Active Scoring Device per Match

There can be many devices scoring different matches.

But for one specific match:

- Only one active scoring device controls it.
- Other devices viewing that match are read-only.

This prevents conflicts.

### 18.5 Multiple Live Matches

V1 supports up to 5 simultaneous live matches.

Example:

```text
Court 1 controlled by Device A
Court 2 controlled by Device B
Court 3 controlled by Device C
```

Each match has its own active scoring lock.

### 18.6 Ending Match Offline

If referee/admin/tournament manager ends match while offline:

- Allow the local end action.
- Mark match as `Pending Sync`.
- Public leaderboard does not officially update until sync succeeds.
- Tournament manager sees pending sync warning.

### 18.7 Offline Event Queue

Every scoring action while offline should be added to local queue.

Example local event:

```json
{
  "client_event_id": "uuid",
  "match_id": "match_123",
  "event_number": 18,
  "event_type": "POINT_AWARDED",
  "team_id": "team_a",
  "previous_state": {},
  "new_state": {},
  "created_at_client": "2026-06-11T18:15:00Z",
  "sync_status": "pending"
}
```

### 18.8 Sync Logic

When connection returns:

1. Detect online state.
2. Lock match sync.
3. Send unsynced events in order.
4. Server validates event sequence.
5. Server applies events.
6. Server updates match snapshot.
7. Server recalculates leaderboard/bracket.
8. Local queue marks events as synced.
9. Public displays update.

### 18.9 Conflict Handling

If server detects a conflict:

- Stop automatic sync.
- Mark sync error.
- Show warning to admin/tournament manager.
- Allow manual resolution.

Possible conflict reasons:

- Another device scored same match.
- Match was ended by another user.
- Event sequence mismatch.

### 18.10 Offline Storage

Use browser storage:

- IndexedDB preferred.
- localStorage only for simple backup flags.

Recommended library:

- Dexie.js for IndexedDB.

---

## 19. Technical Architecture

### 19.1 Recommended V1 Stack

Recommended stack for 2-day production MVP:

```text
Frontend: Next.js / React
Hosting: Vercel or equivalent
Database: Supabase Postgres
Auth: Supabase Auth
Storage: Supabase Storage
Realtime: Supabase Realtime for V1
Offline queue: IndexedDB in browser
Backend logic: Next.js API routes / server actions + Supabase RPC where needed
```

### 19.2 Supabase vs Railway Decision

For the upcoming event:

```text
Expected courts: 2
Expected simultaneous live matches: 2, max 5 supported
Expected users: limited event operation + public screens
```

Supabase Free can be acceptable for V1 if:

- Public viewers are limited.
- Realtime channels are optimized.
- We avoid creating one channel per small component.
- We broadcast snapshots instead of excessive events.
- We keep a polling fallback.
- We monitor quota.

However, for professional paid events or bigger public traffic, recommended upgrade path:

```text
Supabase Pro or Railway backend with Socket.IO
```

### 19.3 Practical Recommendation

For the 2-day build:

> Use Supabase as database/auth/storage/realtime first. Do not add Railway unless realtime testing shows instability or expected viewers exceed the safe free-tier limit.

Reason:

- One full-stack developer.
- 2-day timeline.
- Less deployment complexity.
- Upcoming event has 2 courts.
- V1 can rely on Supabase + local offline queue.

### 19.4 Railway Future Upgrade

Add Railway later if:

- Many public viewers.
- Many simultaneous matches.
- Need a stronger authoritative scoring server.
- Need custom Socket.IO rooms.
- Need Redis-based scaling.
- Need advanced conflict handling.

Future architecture:

```text
Next.js frontend
Railway Node.js backend
Socket.IO realtime
Redis adapter
Supabase Postgres
Supabase Storage
Supabase Auth
```

### 19.5 Important Realtime Rules

To keep V1 stable:

- Use one channel per tournament screen type, not many unnecessary channels.
- Broadcast match snapshots, not every UI detail.
- Persist all official state to database.
- Public screens should rehydrate from database on reconnect.
- Do not rely only on websocket memory.
- Use fallback polling every 5-10 seconds for TV screens.

---

## 20. Database Model

### 20.1 Core Tables

```text
tournaments
users
roles
tournament_users
teams
players
courts
groups
group_teams
matches
match_sets
score_events
match_score_snapshots
standings_snapshots
brackets
bracket_slots
media_assets
check_in_logs
audit_logs
screen_settings
clone_logs
```

### 20.2 tournaments

```sql
tournaments (
  id uuid primary key,
  name text not null,
  slug text unique not null,
  sport text default 'padel',
  status text default 'draft',
  cloned_from_tournament_id uuid null,
  branding_config jsonb,
  scoring_config jsonb,
  format_config jsonb,
  court_config jsonb,
  public_access_enabled boolean default true,
  created_by uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
)
```

### 20.3 teams

```sql
teams (
  id uuid primary key,
  tournament_id uuid references tournaments(id),
  team_name text not null,
  phone text,
  notes text,
  seed_number int null,
  check_in_status text default 'not_arrived',
  team_status text default 'active',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
)
```

### 20.4 players

```sql
players (
  id uuid primary key,
  tournament_id uuid references tournaments(id),
  team_id uuid references teams(id),
  player_order int not null,
  full_name text not null,
  photo_url text null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
)
```

### 20.5 groups

```sql
groups (
  id uuid primary key,
  tournament_id uuid references tournaments(id),
  group_name text not null,
  group_order int not null,
  status text default 'draft',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
)
```

### 20.6 group_teams

```sql
group_teams (
  id uuid primary key,
  tournament_id uuid references tournaments(id),
  group_id uuid references groups(id),
  team_id uuid references teams(id),
  position int,
  is_locked boolean default false,
  created_at timestamptz default now()
)
```

### 20.7 courts

```sql
courts (
  id uuid primary key,
  tournament_id uuid references tournaments(id),
  court_name text not null,
  court_order int not null,
  is_active boolean default true,
  created_at timestamptz default now()
)
```

### 20.8 matches

```sql
matches (
  id uuid primary key,
  tournament_id uuid references tournaments(id),
  stage text not null,
  group_id uuid null references groups(id),
  round_name text,
  match_order int,
  court_id uuid null references courts(id),
  scheduled_time timestamptz null,
  team_a_id uuid references teams(id),
  team_b_id uuid references teams(id),
  status text default 'scheduled',
  serving_team_id uuid null references teams(id),
  winner_team_id uuid null references teams(id),
  active_scoring_device_id text null,
  is_pending_sync boolean default false,
  started_at timestamptz null,
  ended_at timestamptz null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
)
```

### 20.9 match_score_snapshots

```sql
match_score_snapshots (
  id uuid primary key,
  match_id uuid references matches(id),
  tournament_id uuid references tournaments(id),
  current_set_number int default 1,
  team_a_point_label text default '0',
  team_b_point_label text default '0',
  team_a_point_value int default 0,
  team_b_point_value int default 0,
  team_a_games int default 0,
  team_b_games int default 0,
  team_a_sets int default 0,
  team_b_sets int default 0,
  is_tiebreak boolean default false,
  tiebreak_team_a_points int default 0,
  tiebreak_team_b_points int default 0,
  serving_team_id uuid null,
  last_event_number int default 0,
  snapshot_json jsonb,
  updated_at timestamptz default now()
)
```

### 20.10 score_events

```sql
score_events (
  id uuid primary key,
  client_event_id text unique,
  tournament_id uuid references tournaments(id),
  match_id uuid references matches(id),
  event_number int not null,
  event_type text not null,
  team_id uuid null references teams(id),
  previous_state_json jsonb,
  new_state_json jsonb,
  created_by uuid null,
  created_by_role text,
  created_at_server timestamptz default now(),
  created_at_client timestamptz null,
  sync_status text default 'synced',
  undo_of_event_id uuid null references score_events(id),
  note text null
)
```

### 20.11 standings_snapshots

```sql
standings_snapshots (
  id uuid primary key,
  tournament_id uuid references tournaments(id),
  group_id uuid references groups(id),
  team_id uuid references teams(id),
  rank int,
  played int default 0,
  won int default 0,
  lost int default 0,
  points int default 0,
  sets_won int default 0,
  sets_lost int default 0,
  set_diff int default 0,
  games_won int default 0,
  games_lost int default 0,
  game_diff int default 0,
  status text default 'pending',
  calculated_at timestamptz default now()
)
```

### 20.12 brackets

```sql
brackets (
  id uuid primary key,
  tournament_id uuid references tournaments(id),
  bracket_name text default 'Main Bracket',
  status text default 'draft',
  approved_by uuid null,
  approved_at timestamptz null,
  published_at timestamptz null,
  created_at timestamptz default now()
)
```

### 20.13 bracket_slots

```sql
bracket_slots (
  id uuid primary key,
  bracket_id uuid references brackets(id),
  tournament_id uuid references tournaments(id),
  round_name text,
  slot_order int,
  match_id uuid null references matches(id),
  team_id uuid null references teams(id),
  source_type text null,
  source_ref text null,
  is_bye boolean default false,
  created_at timestamptz default now()
)
```

### 20.14 audit_logs

```sql
audit_logs (
  id uuid primary key,
  tournament_id uuid references tournaments(id),
  actor_user_id uuid null,
  actor_role text,
  action text not null,
  entity_type text,
  entity_id uuid null,
  old_value jsonb null,
  new_value jsonb null,
  created_at timestamptz default now()
)
```

---

## 21. Scoring Engine Algorithm

### 21.1 Score State Object

```ts
type ScoreState = {
  currentSet: number;
  teamA: {
    points: '0' | '15' | '30' | '40' | 'AD';
    pointValue: number;
    games: number;
    sets: number;
    tiebreakPoints: number;
  };
  teamB: {
    points: '0' | '15' | '30' | '40' | 'AD';
    pointValue: number;
    games: number;
    sets: number;
    tiebreakPoints: number;
  };
  isTiebreak: boolean;
  servingTeamId?: string;
  winnerTeamId?: string;
  matchStatus: 'scheduled' | 'live' | 'paused' | 'completed' | 'pending_sync';
};
```

### 21.2 Award Point Function

```ts
function awardPoint(state: ScoreState, scoringTeam: 'A' | 'B', config: ScoringConfig) {
  if (state.isTiebreak) {
    return awardTiebreakPoint(state, scoringTeam, config);
  }

  return awardNormalPoint(state, scoringTeam, config);
}
```

### 21.3 Normal Point Logic

```ts
function awardNormalPoint(state, scoringTeam, config) {
  const opponent = scoringTeam === 'A' ? 'B' : 'A';

  const scorer = state[scoringTeam];
  const other = state[opponent];

  // Advantage wins game
  if (scorer.points === 'AD') {
    return confirmGameWin(state, scoringTeam);
  }

  // Opponent had advantage, scoring team brings back to deuce
  if (other.points === 'AD') {
    other.points = '40';
    scorer.points = '40';
    return state;
  }

  // 40-40 goes to advantage
  if (scorer.points === '40' && other.points === '40') {
    scorer.points = 'AD';
    return state;
  }

  // 40 with opponent below 40 wins game
  if (scorer.points === '40') {
    return confirmGameWin(state, scoringTeam);
  }

  // Normal progression
  scorer.points = nextPointLabel(scorer.points);
  return state;
}
```

### 21.4 Game Win Confirmation

The UI should detect when the next action will trigger `confirmGameWin` and show confirmation before applying.

```ts
function willPointWinGame(state, scoringTeam) {
  // Returns true if the scoring action will cause a game win.
}
```

### 21.5 Game Win Logic

```ts
function winGame(state, winningTeam, config) {
  state[winningTeam].games += 1;

  resetCurrentGamePoints(state);
  switchServingTeamAfterGame(state);

  if (shouldStartTiebreak(state, config)) {
    state.isTiebreak = true;
    state.servingTeamId = null; // V1: hide serve in tie-break
    return state;
  }

  if (hasWonSet(state, winningTeam, config)) {
    return winSet(state, winningTeam, config);
  }

  return state;
}
```

### 21.6 Set Win Logic

```ts
function hasWonSet(state, team, config) {
  const gamesWon = state[team].games;
  const gamesLost = state[opponent(team)].games;

  if (gamesWon >= config.gamesToWinSet && gamesWon - gamesLost >= 2) {
    return true;
  }

  return false;
}
```

### 21.7 Tie-Break Start Logic

```ts
function shouldStartTiebreak(state, config) {
  return (
    config.tiebreakEnabled &&
    state.teamA.games === config.tiebreakAtGames &&
    state.teamB.games === config.tiebreakAtGames
  );
}
```

Default:

```ts
{
  gamesToWinSet: 6,
  tiebreakEnabled: true,
  tiebreakAtGames: 6,
  tiebreakTargetPoints: 7,
  tiebreakWinByTwo: true
}
```

### 21.8 Tie-Break Point Logic

```ts
function awardTiebreakPoint(state, scoringTeam, config) {
  state[scoringTeam].tiebreakPoints += 1;

  const a = state.teamA.tiebreakPoints;
  const b = state.teamB.tiebreakPoints;

  const target = config.tiebreakTargetPoints || 7;
  const winByTwo = config.tiebreakWinByTwo !== false;

  const scorerPoints = state[scoringTeam].tiebreakPoints;
  const opponentPoints = state[opponent(scoringTeam)].tiebreakPoints;

  if (scorerPoints >= target) {
    if (!winByTwo || scorerPoints - opponentPoints >= 2) {
      return winTiebreakSet(state, scoringTeam);
    }
  }

  return state;
}
```

### 21.9 Match Win Logic

V1 default is one set only.

Therefore:

```ts
function winSet(state, winningTeam, config) {
  state[winningTeam].sets += 1;

  if (state[winningTeam].sets >= config.setsToWinMatch) {
    state.winnerTeamId = getTeamId(winningTeam);
    state.matchStatus = 'completed';
    return state;
  }

  startNextSet(state);
  return state;
}
```

Default:

```ts
setsToWinMatch: 1
```

---

## 22. Pages and Routes

### 22.1 Admin Routes

```text
/admin/login
/admin/tournaments
/admin/tournaments/new
/admin/tournaments/[id]/dashboard
/admin/tournaments/[id]/settings
/admin/tournaments/[id]/branding
/admin/tournaments/[id]/teams
/admin/tournaments/[id]/teams/import
/admin/tournaments/[id]/groups
/admin/tournaments/[id]/matches
/admin/tournaments/[id]/schedule
/admin/tournaments/[id]/leaderboard
/admin/tournaments/[id]/bracket
/admin/tournaments/[id]/screens
/admin/tournaments/[id]/exports
```

### 22.2 Referee Routes

```text
/referee/login
/referee/tournaments
/referee/tournaments/[id]/matches
/referee/matches/[matchId]/score
```

### 22.3 Screen Operator Routes

```text
/operator/login
/operator/tournaments/[id]/control
```

### 22.4 Public Routes

```text
/t/[slug]
/t/[slug]/leaderboard
/t/[slug]/live
/t/[slug]/match/[matchId]
/t/[slug]/bracket
/t/[slug]/winner
/t/[slug]/screen
```

---

## 23. Excel Export

### 23.1 Required Export

V1 must support Excel export.

### 23.2 Export Content

Export should include:

- Tournament info.
- Teams.
- Players.
- Groups.
- Matches.
- Results.
- Leaderboard.
- Bracket.
- Champion.
- Runner-up.
- Third place.
- Score history summary.

### 23.3 Export File Structure

Recommended Excel sheets:

```text
Tournament Summary
Teams
Players
Groups
Group Matches
Leaderboard
Knockout Bracket
Final Results
Audit Summary
```

---

## 24. Demo Mode and Reset

### 24.1 Demo Mode

V1 must include demo/training mode.

Purpose:

- Train referees.
- Test TV screens.
- Simulate tournament before live event.

### 24.2 Reset Demo Data

A hidden/admin-only button should allow:

```text
Reset demo scores
Reset demo matches
Reset demo leaderboard
Reset demo bracket
```

This should not be visible to referees or public viewers.

---

## 25. Emergency Fallback Plan

Even with offline mode, an event should have a manual backup.

### 25.1 Required Backup

Prepare:

- Printed group list.
- Printed match schedule.
- Manual score sheets.
- Emergency Excel template.
- Backup internet hotspot/router.

### 25.2 Full System Failure Process

If platform becomes unavailable:

1. Referees continue on paper.
2. Tournament manager records results in emergency Excel.
3. Once platform returns, admin enters results manually.
4. Leaderboard recalculates.
5. TV screen resumes.

---

## 26. 2-Day Production Plan

This is one production sprint, not separate phases.

### 26.1 Production Objective

By the end of 2 days, the system must allow Move Beyond to run a real padel tournament from setup to final winner.

### 26.2 Team Available

User confirmed:

```text
Development team: 1 full-stack developer
Accounts: Supabase, Railway, Vercel/domain available
```

Because only one full-stack developer is available, scope must be controlled strictly.

### 26.3 Day 1 Plan

#### 09:00–10:00 — Scope Lock and Project Setup

Deliverables:

- Confirm V1 rules.
- Create project repo.
- Create Supabase project.
- Create environment variables.
- Create routing structure.
- Create authentication skeleton.

#### 10:00–12:00 — Database and Core Models

Deliverables:

- Create tables.
- Create storage buckets.
- Create RLS basics.
- Create tournament CRUD.
- Create team/player CRUD.
- Create photo upload.

#### 12:00–14:00 — Team Import and Tournament Setup

Deliverables:

- Manual team entry.
- CSV template download.
- CSV upload/import.
- Tournament settings.
- Court setup.
- Branding upload.

#### 14:00–16:30 — Groups and Randomizer

Deliverables:

- Auto-create groups.
- Drag/drop teams.
- Lock teams.
- Generate multiple draw options.
- Select final draw.
- Publish groups.

#### 16:30–18:30 — Match Generation and Scheduling

Deliverables:

- Generate round-robin matches.
- Assign match order.
- Assign court.
- Manually edit match time/order/court.
- Support 1–20 courts.
- Limit active live matches by available courts.

#### 18:30–22:30 — Scoring Engine and Referee Screen

Deliverables:

- Start match.
- Select server.
- Huge scoring buttons.
- 0/15/30/40/AD scoring.
- Game win confirmation.
- Set to 6.
- Tie-break at 6-6.
- Undo with confirmation.
- Pause/resume.
- Force end match.
- Walkover.
- Disqualification.
- Match timer.

#### 22:30–01:00 — Leaderboard and Realtime Basics

Deliverables:

- Calculate standings.
- Update standings after match completion.
- Show live match snapshot.
- Public leaderboard page.
- Public live match page.

### 26.4 Day 2 Plan

#### 09:00–11:00 — Offline Scoring

Deliverables:

- IndexedDB local event queue.
- Offline badge.
- Continue scoring offline.
- Store undo locally.
- Mark match pending sync.
- Sync when internet returns.
- One active scoring device per match.

#### 11:00–13:00 — Knockout Bracket

Deliverables:

- Generate qualifiers.
- Create bracket.
- Approve bracket.
- Edit bracket positions.
- Lucky team/bye support.
- Advance winners.
- Third-place match.
- Champion, runner-up, third-place output.

#### 13:00–15:00 — TV and Screen Operator

Deliverables:

- Leaderboard TV screen.
- Multi-match TV screen.
- Bracket TV screen.
- Winner screen.
- Screen operator control page.
- Sponsor/logo display.
- Editable lower-third.
- Light/dark toggle.

#### 15:00–16:30 — Clone Tournament and Export

Deliverables:

- Clone tournament modal.
- Clone teams/players/photos/groups/rules/branding.
- Reset scores/check-in/leaderboard.
- Excel export.

#### 16:30–20:30 — Full Tournament Simulation

Test scenario:

```text
Create tournament
Add 12 teams
Upload/import teams
Create 4 groups
Generate 5 draw options
Select one draw
Drag/drop one team manually
Publish groups
Generate matches
Run 2 live matches at same time
Score all group matches
Test undo
Test game confirmation
Test walkover
Test disqualification
Test offline scoring
Sync offline events
Update leaderboard
Generate bracket
Edit bracket
Approve bracket
Run QF/SF/Final/Third-place
Show winner screen
Export Excel
Clone tournament
Start clone from zero
```

#### 20:30–01:00 — Bug Fix and Hardening

Only fix critical issues:

- Wrong scoring.
- Wrong leaderboard.
- Offline sync failure.
- Bracket advancement issue.
- TV screen not updating.
- CSV import broken.
- Photo upload broken.
- Clone broken.
- Permissions bug.

No new features after this point.

---

## 27. Acceptance Criteria

The V1 is accepted only if the following are working:

### 27.1 Tournament Setup

- Admin can create tournament.
- Admin can configure branding.
- Admin can configure courts.
- Admin can add/import teams.
- Admin can upload player photos.
- Admin can manually check in teams.

### 27.2 Group Stage

- Groups auto-generate.
- Multiple draw options generate.
- Teams can be locked.
- Teams can be drag/dropped.
- Group matches generate correctly.

### 27.3 Scoring

- Referee can start match.
- First server can be selected.
- Score progresses correctly.
- Game-winning point requires confirmation.
- Undo works with confirmation.
- Set to 6 works.
- Tie-break at 6-6 works.
- Manual force-end match works.
- Walkover works.
- Disqualification works.

### 27.4 Offline

- Match can continue scoring offline after page loaded online.
- Offline badge appears.
- Local history is saved.
- Match can end offline as pending sync.
- Events sync when internet returns.
- Leaderboard updates after sync.

### 27.5 Leaderboard

- Win = 1 point.
- Loss = 0 points.
- Rankings update after completed match.
- Qualified teams are highlighted.
- Manual qualification override works.

### 27.6 Bracket

- Qualifiers generate bracket.
- Bracket can be edited before publishing.
- Admin/tournament manager/referee can approve.
- Winners advance automatically.
- Third-place match exists.
- Winner/runner-up/third-place display works.

### 27.7 Public Screens

- TV leaderboard works.
- Live match screen works.
- Multi-match screen works.
- Bracket screen works.
- Winner screen works.
- Public screens are read-only.
- Screen operator can switch displays.

### 27.8 Clone and Export

- Tournament can be cloned.
- Teams/players/photos/groups/branding/rules copied.
- Scores/check-in/leaderboard reset.
- Excel export works.

---

## 28. Future Roadmap

### 28.1 Version 1.1

- True Golden Point toggle.
- Short set to 4.
- Best of 3 formats.
- Different rules per stage.
- Referee notes.
- Referee assignment.
- Arabic interface.
- Better sponsor screen.

### 28.2 Version 1.2

- QR check-in.
- Mobile scanner web app.
- Player registration form.
- Automated SMS/WhatsApp notifications.
- Advanced exports.
- Certificates.

### 28.3 Version 2.0

- Multi-sport support.
- Beach tennis scoring.
- Volleyball scoring.
- Football group/knockout support.
- E-sports brackets.
- AI scheduling optimization.
- Sponsor analytics.
- SaaS tenant billing.

---

## 29. Key Development Notes

### 29.1 Build for Event Stability First

The first version must prioritize:

```text
Stable scoring
Correct leaderboard
Offline protection
Simple UI
Fast TV display
Manual overrides
```

Do not overbuild future SaaS features before the event engine is stable.

### 29.2 Important UX Rule

For live events:

- Buttons must be large.
- Screens must be readable from distance.
- Confirmation is required for destructive actions.
- Offline status must be obvious.
- Manual override must always exist.

### 29.3 Important Data Rule

Never only store final score.

Always store:

```text
Score events
Current snapshot
Final result
Audit log
```

This protects Move Beyond during disputes.

---

## 30. Source/Reference Notes

This specification uses standard padel scoring concepts:

- Normal tennis-style point progression: 0, 15, 30, 40, game.
- Advantage scoring.
- Set to 6 games.
- Tie-break at 6-6.
- Tie-break to 7 points.

The technical recommendation is based on the expected V1 event size of two courts and the need for a fast two-day web build.

Current official platform documentation to verify before deployment:

- Supabase Realtime documentation and pricing/limits.
- Supabase Storage/Auth documentation.
- Railway Socket.IO deployment documentation if Railway backend is added.
- FIP padel rules for official event rule alignment.

---

## 31. Final V1 Summary

The V1 should be built as:

```text
Move Beyond Tournament Management
Padel-only responsive web platform
Group stage + knockout
Any number of teams
Manual + CSV team entry
Photos optional
Manual check-in
Multiple random draw options
Drag/drop groups
Match scheduling
Live scoring
Offline scoring
Leaderboard
Bracket
TV screens
Clone tournament
Excel export
```

The most important product decision is:

> Build the platform as a reusable Move Beyond tournament engine, not as a one-time Badya tournament page.

