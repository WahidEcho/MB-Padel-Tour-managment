# Every setting, and what it changes

A plain-language guide for organisers. Each entry says where the setting is, what
it does, and **where you see the difference**: on the referee's phone (the game),
on the venue TV screens, or on the public link you share with players.

Three places hold settings:

| Where | What lives there | Who uses it |
| --- | --- | --- |
| **Tournament → Settings** | Name, match rules, courts, branding, sponsors | Organiser, before and between events |
| **Tournament → Screens** and the **Control room** | What each TV is showing, right now | Operator, during the event |
| **Teams, Groups, Matches, Bracket** tabs | The competition itself | Organiser |

A change to Settings reaches the TVs within a few seconds and the public pages on
their next refresh. Nobody has to reload anything.

---

## 1. Settings → General

| Setting | What it does |
| --- | --- |
| **Tournament name** | The title at the top of every TV screen and every public page. |
| **Lower-third banner** | The line of small capitals under the title on the TV screens only — for example "Badya Padel Tournament \| Powered by Move Beyond". Leave it blank and the line disappears. It never appears on the public pages. |

---

## 2. Settings → Scoring & format rules

These decide how a match is played and when it ends. **The referee's phone reads
them when the match opens**, so a change reaches matches that have not started
yet — not one already in progress.

### The tournament default

| Setting | What it does |
| --- | --- |
| **Sets to win match** | 1 for a single set, 2 for best-of-three. |
| **Games to win set** | Usually 6. Set it to 4 for short sets in a one-day event. |
| **Tie-break at games** | The score at which a tie-break starts, usually 6 (so 6–6). |
| **Tie-break target points** | Usually 7, or 10 for a deciding "super tie-break". |
| **Tie-break enabled** | Off means a set is played out to a two-game lead with no tie-break. |
| **Tie-break win by two** | On: 7–6 in the tie-break keeps going to 8–6. Off: first to the target wins. |
| **Walkover score** | The score recorded when a team does not turn up, e.g. `6-0`. It counts towards game difference on the leaderboard. |
| **Qualify per group** | How many teams from each group reach the Cup knockout. Decides who shows as **qualified** on the leaderboard once a group is complete. |
| **Third-place match** | Adds a play-off for third. Without it there is no third place to put on the podium. |
| **Referee confirms each result** | On: the match-winning point shows the final score and waits for the referee to press **Confirm result**. A mis-tap on match point can be undone before it reaches the standings, the bracket or the TV's winner animation. Off: the match finishes on the final point. Walkovers and retirements always finish straight away. |
| **Cup podium places** | How deep the winner screen and the closing ceremony go: champion only, up to top four. Third and fourth exist only if a third-place match was played. |

### Plate bracket

| Setting | What it does |
| --- | --- |
| **Run a Plate bracket** | A second knockout for the teams placed below the Cup places, so nobody goes home after the group stage. Off by default. |
| **Plate places per group** | How many teams per group go into the Plate. They show as **plate** on the leaderboard. |
| **Plate podium places** | As Cup podium places, for the Plate ceremony. |
| **Plate third-place match** | A play-off for third in the Plate. |

### Rules per stage

Seven panels — Group, Quarter/Semi, Final, Round of 16 and earlier, and the same
three for the Plate. Each field left blank **inherits** the tournament default
above. Fill one in and only that stage changes.

Typical use: groups at 4 games, the final at 6. Each panel prints the resulting
rule in plain words ("Plays as: best of 3 sets, 6 games…") so you can check it
before saving.

---

## 3. Settings → Courts

Add or remove the courts this tournament runs on. Courts decide:

- which court a match is scheduled on;
- **what each TV screen can cover** — a screen is set to one or more courts;
- the "One court, full screen" list in the **Watch** menu on the public pages.

Removing a court does not delete its matches; they lose their court and need one
assigning again.

---

## 4. Settings → Branding & sponsors

### Logos

| Setting | Where it shows |
| --- | --- |
| **Move Beyond logo** | Top right of every TV screen. |
| **Client/place logo** | Top right of every TV screen, beside the Move Beyond logo. |
| **Event logo** | Top left of the public pages, beside the tournament name. |
| **Still picture for the holding slate** | The default background of the TV's "Holding" scene (see below). |

Any picture that is too large to upload is **compressed automatically** in your
browser before it is sent, and a line under the picker tells you what happened.
Animated files — a GIF, an animated WebP or PNG — are never re-encoded, because
that would leave one frozen frame.

### Event background

A GIF, an animated SVG, an animated WebP or PNG, a picture, or a short MP4 or
WebM loop (no sound), playing behind everything on the TV screens.

| Setting | What it does |
| --- | --- |
| **The file** | Uploads on its own as soon as you pick it, with a progress bar. Up to 50 MB for GIF and video, 2 MB for SVG. 1920 × 1080 looks sharpest on a TV. |
| **Darken behind the content** | None / Light / Medium / Strong. Raise it if the scores are hard to read over a busy background. |
| **Also behind the public pages** | Off: the background is on the TVs only. On: it appears softly behind the public pages too. |
| **Remove the background** | Clears it. Saved with **Save branding**. |

### Main sponsor

| Setting | What it does |
| --- | --- |
| **Name and logo** | The anchored partner, shown still on the left of the TV's sponsor band. |
| **Glow colour** | The colour that glows behind the TV scenes. The small preview shows it as it will look. |
| **Intensity** | Subtle / Standard / Vivid. The app caps the glow so it can never wash out the scores, whatever you choose. |
| **Also glow behind the public dashboard** | Off: the glow is on the TVs only. |
| **Remove the main sponsor** | Clears it. |

The glow is quiet behind a full grid of live scores and strongest on the holding
slate and the ceremony, where nothing competes with it.

### Footer sponsors

The logos that loop along the bottom of the TV screens and the public pages. Add
several at once, name each one, tick **remove** beside any to drop it, or
**clear all**. The loop repeats without a gap at any screen width.

Two switches decide how the band draws them, with a preview strip above that
shows the answer before you save:

| Setting | What it does |
| --- | --- |
| **White panel behind each logo** | On (the default): each logo sits on a white panel, so a dark logo still reads on a dark wall. Off: the logos sit straight on the background — right for a set supplied light or knocked out. On a white public page the panel is invisible either way; it earns its keep on a dark TV or over an event background. |
| **Give every logo the same size** | On: one identical box down the whole band, every panel the same size. Off (the default): each logo is sized by area, so a wide wordmark and a square crest carry the same visual weight rather than the wordmark shouting. Either way **nothing is stretched** — a distorted logo is a sponsor's trademark drawn wrongly, so each one is fitted inside its box at its own shape. |

Both apply to the TV band and the public footer at once.

### Red and blue teams

One switch, and it changes three things at once:

- **The voice umpire** calls each side by colour: "Advantage, Red team.", "Game,
  Blue team. Four games to two, Blue team." Team and player names are never
  spoken. Off: the voice says "server" and "receiver".
- **The TV court cards** mark each side with a red or blue bar, a tint and the
  word RED or BLUE — live, next on court, the finished result and the player
  entrance. The point flash, the GAME/SET label and the WINNER chip take the
  side's colour too.
- **The referee's scoring page** marks the serve choice, the scoreboard and the
  two "+ Point" buttons RED TEAM and BLUE TEAM.

The first-listed team of each match is Red, the second Blue. Switching it during
an event reaches the walls within seconds and the referee's phone from the next
point.

### Holding slate

What a TV shows when the operator puts it on "Holding".

| Setting | What it does |
| --- | --- |
| **Title** | Big text in the middle. Defaults to the tournament name. |
| **Message** | The line under it. Defaults to "Back shortly". |
| **Picture** | Behind the words. Defaults to the still picture uploaded above. |

---

## 5. Tournament → Screens, and the Control room

A tournament can have up to 12 screens. Each has **its own link**, opened on that
TV's browser, and **its own settings**. The control room drives them all.

### What a screen shows

| Mode | On the wall |
| --- | --- |
| **🎾 Live courts** | A card per court this screen covers: photos, names, sets, games and points, the serve indicator, the 9-second player entrance when a match starts, and the result animation when one finishes. One court fills the screen; two, four or six share it. |
| **📊 Leaderboard** | The group standings, sized to whatever fits — one group gets big type, six get small. |
| **🏆 Bracket** | The knockout tree, or both trees side by side when a Plate is published. |
| **🥇 Ceremony** | The podium, revealed place by place under the operator's control. |
| **🤝 Sponsors** | Full-screen sponsor logos, rotating. |
| **⏸ Holding** | The holding slate above. |

### Per-screen controls

| Setting | What it does |
| --- | --- |
| **Courts on this screen** | Tick the courts this wall covers. Tick none for every court. This is the only setting "push to all screens" never touches — it would undo the split. |
| **Follow live, or pin a court** | Follow live: the screen shows whatever is live on its courts. Pinned: it stays on that court even when the match there ends. |
| **Which bracket is shown** | Plate and Cup, Cup only, or Plate only. Appears once both tiers are published. Screens show both by default. |
| **Break** | 5, 10 or 15 minutes. A countdown appears over whatever is showing; the sponsor band stays on air. **End break** clears it. |
| **Animations** | **Mute** is the emergency brake: every scene shows its finished frame and nothing moves. |
| **Replay entrance** | Plays a live match's 9-second player entrance again — for when the wall was showing something else as the match began. A point scored meanwhile ends it. |
| **Closing ceremony** | Put it on air, then step through the places with **Next ▶** and **◀ Back**, **Replay** one, or **Restart** from the opening slate. With a Plate published it honours the Plate first, then the Cup, unless you choose otherwise. |
| **Screen theme** | Dark (recommended for a TV) or Light. |
| **Sponsor rotation (seconds)** | How long each logo holds in the full-screen Sponsors mode. |
| **Screen name** | The label in the control room. The link never changes — a TV may already be open on it. |

### Push to many

Select several screens and send one change to all of them: a break, a mute, a
ceremony step. Coverage is deliberately excluded. A pin is skipped for any screen
that does not cover that court, and the result says which were skipped.

---

## 6. The public link

`/t/<your-tournament>` — share it with players and spectators. It has no login
and shows no phone numbers or internal notes.

| Page | What it shows |
| --- | --- |
| **Overview** | Groups, what is live, what is next. |
| **Leaderboard** | Full standings. On a phone the difference columns fold into a line under each team. |
| **Live** | Every live scoreboard. |
| **Bracket** | The knockout tree — both tiers when a Plate is published. |
| **Winner** | Champion, runner-up, third. |
| **Watch** (top right, every page) | Opens a venue screen in a new tab: any of your TV screens, or one court full screen. Built for a 16:9 screen, so it looks best full screen or cast to a TV. |

The public link works only while the tournament's public access is on. The
control room says so and offers to turn it on if it is off.

---

## 7. Buttons at the top of a tournament

| Button | What it does |
| --- | --- |
| **⬇ Export Excel** | Downloads the whole tournament — teams, matches, standings — as a spreadsheet. |
| **Clone** | Starts a new tournament from this one's format, rules and branding. Results are not copied. |
| **Public page ↗** | Opens the public link in a new tab. |

---

## 8. Leaderboard → status override

On the admin leaderboard each team has a status dropdown and a **Set** button.

- **pending / qualified / plate / eliminated / disqualified** — set a team's
  status by hand when the calculation cannot know, for example a withdrawal.
- An overridden status is marked with a **\*** on every leaderboard, public
  pages and TV included, and is written to the audit trail.
- **↺** clears the override and hands the place back to the calculation.

Overrides survive every later recalculation until you clear them.
