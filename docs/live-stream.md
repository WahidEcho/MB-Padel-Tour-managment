# Live stream: operator guide

Move Beyond owns the broadcast rights for the Junior Finals. Each streamed court gets:

- a clean camera feed from the production crew,
- Move Beyond's team running **OBS**, which adds **our overlay** (score bug + sponsor loop) as a browser source,
- one **YouTube Live** video per court,
- viewers watching **inside the Move Score app and on the website** (match page, live courts on Discover), never sent to YouTube unless the video cannot be embedded.

Which courts are streamed is set per tournament in the admin, never in code. For the Junior Finals the plan is
"Court 13 (boys)" (boys' tournament) and "Court 14 (girls)" (girls' tournament).

```
camera crew ──SDI/HDMI/SRT/NDI──▶ OBS (per court) ──RTMPS──▶ YouTube Live (one video per court)
                                   ▲  browser source:                         │ embed (nocookie)
                                   │  /t/<slug>/overlay/<court>               ▼
                     Move Score live feed (1 s poll)              Move Score app + website
```

## 1. In Move Score (admin)

Admin → tournament → **Live stream** tab (tennis ties and padel tournaments; admins and managers of the organisation).

1. **Overlay title**: the first words of the score bug's header strip, e.g. `Davis Cup Juniors`
   (empty = the tournament's name). The strip then reads `DAVIS CUP JUNIORS · EGY 1–0 USA · S2`.
2. Per court:
   - **YouTube live URL**: paste the live video's own link. Accepted: `youtube.com/live/<id>`, `youtube.com/watch?v=<id>`,
     `youtu.be/<id>`, `youtube.com/embed/<id>`, the nocookie host, or the bare 11-character id. Only the id is stored.
     A channel page (`youtube.com/@channel/live`) is refused: it names no video. Create the live video (scheduled stream)
     in YouTube Studio first and copy *its* link.
   - **Show to viewers**: off by default. While on, the court's match in play shows **● LIVE VIDEO** and the player.
     Switch it on when the stream is actually up (or a little before: YouTube shows its own waiting screen until then).
   - **Video delay (s)**: optional. What you measure in rehearsal (see section 5). Viewers read "The video runs about N s
     behind the live score."
   - **OBS overlay URL**: copy it into OBS (section 3). It uses the court's id, so renaming the court does not break OBS.
     Variants: `?footer=0` (score bug only), `?bug=0` (sponsor loop only), `?scale=1.2` (bigger or smaller, 0.5–2),
     `?idle=0` (no strip when nothing is on or next on the court).
   - The **preview** shows the real overlay over a checkerboard (transparent areas).

Sponsors in the footer loop are the event's sponsors (Settings → Branding: the main partner and the footer sponsors),
the same list as the TV screens. The ACE flash and the changeover/break timers follow **Scoring features → Show aces /
timers on TV & app**.

What viewers get, only while a court's video is on and only for the match **in play** on that court:
`liveVideo: { youtubeId, court, courtId, delaySeconds? }` on the app's live, match, bundle (court) and live-courts payloads
(additive: Move Score 1.0.1 ignores it). Settings for courts that are off never leave the server.

## 2. Feed from the camera crew

Ask for a **clean feed** (no graphics of theirs), 1080p50 (Egypt is a 50 Hz country; 1080p59.94 also works), embedded
audio (ambient/court mics, commentary if any) on channels 1–2.

| The crew gives | Into OBS with |
| --- | --- |
| SDI | SDI capture card (Blackmagic DeckLink Mini Recorder / UltraStudio, AJA) → *Video Capture Device* or *Blackmagic Device* source |
| HDMI | USB/PCIe HDMI capture (Elgato Cam Link 4K / HD60 X, Magewell USB Capture) → *Video Capture Device* |
| SRT (over IP) | *Media Source*, untick "Local file", input `srt://<crew-ip>:<port>?mode=caller&latency=200000` (or listener; agree who calls) |
| RTMP | Run a small RTMP server (or OBS 30+ "Media Source" with the crew's pull URL); SRT is preferred: lower latency, survives packet loss |
| NDI | Install DistroAV (OBS NDI plugin) + NDI Runtime → *NDI Source*; same gigabit LAN as the crew's NDI encoder |

## 3. OBS setup (one OBS per court, or one PC per court)

Settings (Settings → Output, Advanced mode, Streaming tab):

| Setting | Value |
| --- | --- |
| Base and output resolution | 1920×1080 (Video tab) |
| FPS | 50 (match the camera) |
| Encoder | Hardware H.264 (NVENC / Apple VT / QuickSync), x264 "veryfast" only on a strong CPU |
| Rate control | **CBR**, **6000–9000 Kbps** (YouTube 1080p50/60 range) |
| Keyframe interval | **2 s** |
| Profile | high; B-frames 2 |
| Audio | AAC, **48 kHz**, 128–160 Kbps stereo |

Scene, top to bottom in the Sources list:

1. **Browser** source (top): URL = the court's *OBS overlay URL* from the admin; **Width 1920, Height 1080**;
   tick *Shutdown source when not visible* off and *Refresh browser when scene becomes active* off. Leave the
   default custom CSS (it makes the page transparent; our page is transparent anyway). Do not crop or scale it.
2. **Camera** (below): the capture card / Media Source / NDI source from section 2, fit to 1920×1080.
3. Optional: a *Render Delay* filter on the camera source if the bug runs behind the picture (scores reach the overlay
   about 1–2 s after the umpire's tap; a camera on SRT can be ~0.2–1 s behind real time).

Stream (Settings → Stream): Service **YouTube – RTMPS**, use the **stream key of that court's live video**
(YouTube Studio → Go live → Stream → select the scheduled stream → copy key). One key per court; never share a key between
courts. Start streaming in OBS, then check YouTube Studio's stream health ("Excellent").

### Alternative: the crew adds our overlay

If the production company streams directly from vMix, TriCaster, Wirecast or an ATEM + streaming encoder:

- **vMix**: Add Input → *Web Browser*, URL = overlay URL, 1920×1080; put it on an Overlay channel (1–4) over the programme.
- **TriCaster / Wirecast**: add a web/browser input or a *Live Text/Web* layer with the URL at 1920×1080, as a DSK over programme.
- **ATEM** has no browser input: run the overlay in OBS (or a browser) on a PC with an alpha (fill+key) output, or ask for vMix.

They stream to the same YouTube live video (we give them that court's stream key, privately). Ask them to keep the
key secret and to stream at the settings above.

## 4. YouTube settings (per court's live video)

- Create **one scheduled live stream per court** (Studio → Create → Go live → Schedule). Title e.g.
  "Junior Finals · Court 13 · Boys". Visibility **Public** or **Unlisted** (both embed; Unlisted keeps it off the channel page).
- **Allow embedding: ON** (Customisation / More options → "Allow embedding"). Without it the app and the website can only offer
  "Open on YouTube".
- **Stream latency: Low latency** (about 5–10 s; *Ultra-low* is 2–5 s but no 1440p/4K and fewer viewers on weak networks;
  *Normal* can be 15–30 s). DVR on (viewers can rewind).
- Audience: **not made for kids** (made-for-kids videos disable features in embeds); age restriction off (age-restricted videos do not embed).
- Paste each video's link into the admin (section 1). The link is known as soon as the stream is scheduled, so set it up the day before.
- Music: only licensed music in the feed (or none), or YouTube may mute or block the stream.

## 5. Network

- **Wired** Ethernet for every OBS PC, **≥ 20 Mbps upload per court** (two courts: 40 Mbps), measured at the venue on the
  day of the rehearsal; a bonded 4G/5G router (e.g. LiveU Solo, Peplink) as the backup line.
- The overlay polls the server about once a second (small JSON). It keeps its last frame through network blips and
  catches up when the line returns.

## 6. Rehearsal checklist

- [ ] Both live videos scheduled in YouTube Studio, embedding allowed, low latency, links pasted in the admin, switches **off**.
- [ ] OBS on each court: overlay URL from the admin's Copy button, browser source 1920×1080, camera underneath.
- [ ] Score a few points on a test match on each court (referee app): the bug moves within 1–2 s; serve ball, games,
      points; a tie-break shows tie-break points; a finished match shows FINAL then the next match.
- [ ] Ace (with Show aces on) flashes ACE; a changeover timer shows in the tab; Pause shows PLAY SUSPENDED.
- [ ] Sponsor loop: every logo present, no seam, smooth on the recording (look at 50 fps on a recorded test).
- [ ] Stream health "Excellent" for 15 minutes on both courts at once.
- [ ] Measure the delay: show a stopwatch to the camera, compare with the YouTube player on a phone; enter it in the admin.
- [ ] Switch each court **on**: the app's match page and Discover hero show ● LIVE VIDEO and play the video in the app;
      the website's match page plays it. Try a phone on 4G.
- [ ] Switch embedding off on a test video once: the app and website say "This video can only be watched on YouTube" and offer the link.
- [ ] End a test stream: the player says the live stream has ended. Switch the court off after each session.
- [ ] Backup: if OBS fails, the crew can stream the clean feed straight to the same key (no overlay) while OBS restarts.

## 7. Questions to ask the operators

Camera crew / production company:

1. Which output: SDI, HDMI, SRT, NDI? Resolution and frame rate (1080p50?) and is it a clean feed?
2. Audio: which channels carry court sound and commentary? Embedded in the video?
3. For SRT: their IP/port, caller or listener, latency setting, encryption passphrase.
4. How many cameras per court, and is the programme cut by them (one output) or do we switch?
5. Do they stream themselves (vMix/TriCaster) or hand us the feed? If they stream: can they add a 1920×1080 web browser
   input as an overlay?
6. Power and cabling to our OBS position; distance (SDI runs long, HDMI ~10 m).
7. Backup: a second encoder or recorder? ISO recording for highlights?
8. Who to call on the day, and their timing for setup and line check.

Venue / IT:

1. Wired upload per court (≥ 20 Mbps each) and a speed test the day before; fixed IP or not (for SRT listener).
2. Any firewall blocking RTMPS (TCP 443) or SRT (UDP)? Port forwarding for SRT if we listen.
3. A 4G/5G backup line or bonding router available?
4. Wi-Fi for spectators (so phones do not saturate the streaming line): is the streaming network separate?

Move Beyond:

1. The two YouTube live videos (titles, visibility, thumbnails), created by whom, on which channel?
2. Commentary or ambient only? Music rights for walk-on music (YouTube blocks unlicensed music).
3. Who switches each court's video on/off in the admin, and who watches stream health during play?
