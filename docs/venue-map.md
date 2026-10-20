# Venue map: 3D map and walking navigation

The venue in 3D (spin, tilt, zoom), courts in their events' colours with their live match, points of
interest by category, the blue dot (with permission) and walking directions along the walkways. One
renderer for the web and the app.

## Architecture

- **Pure logic** `src/lib/venue/` (framework-free, unit tested in `venue.test.ts`): document types and
  strict reader (`types.ts`, `validate.ts`), geo ↔ plan (`geo.ts`), walkway graph and A* (`graph.ts`),
  start point / route planning (`route.ts`), directions text (`directions.ts`), live navigation
  (progress, off-route after 2 fixes, arrival: `navigate.ts`), live court lines (`live.ts`), public
  projection and court linking (`public.ts`), survey + alignment fit (`survey.ts`, `fit.ts`), DXF reader
  (`dxf.ts`), underlay reader (`underlay.ts`), 3D geometry and camera maths (`scene.ts`, `camera.ts`),
  the app bridge (`bridge.ts`, exported through `@core`), sample venue (`sample.ts`).
- **Renderer** `src/components/venue/`: a small WebGL 1 renderer (no library; three tiny shaders),
  DOM labels, touch/mouse gestures, location (`useVenueLocation.ts`), the map UI (`VenueMap.tsx`).
- **Web page** `/t/<slug>/map` (`?court=<courts.id>` focuses a court; `?embed=app&theme=dark|light`
  for the app). "Map" tab on the public pages and "Show on map" on the match page when published.
- **App** `move-score-app/src/app/venue/[slug].tsx`: the page in a WebView. The app owns location and
  compass (`expo-location`, `src/venue/location.ts`), only after the map asks and only while the screen is
  open, and feeds them through the bridge; the map sends `open-match` / `open-tie` / `open-court` out.
  "Show on map" on the match screen and a MAP chip on the live courts hero (when a map is published).
- **API** `GET /api/mobile/v1/t/<slug>/venue` (public, CDN 60 s), `GET …/venue/live` (CDN 2 s),
  `POST …/venue/route` `{ to, from? }` (never cached; the map itself routes on the phone).
- **Data** migration `0039_venue_map.sql`: `venue_maps` (one per event group, or per tournament without
  a group), `doc` (the venue document) and `underlay` (the editor's site plan, never public). RLS on, no
  policy, no grants; private in `supabase/gate/reopen_open_access.sql`.
- **Editor** Admin → tournament → **Venue map**: site plan underneath (image upload, or DXF/SVG import
  with layer picking, scale/turn/move), courts / points / walkways / buildings, anchor, checks,
  JSON import/export, 3D preview. **Survey mode** (`…/venue/survey`, on a phone): pick a feature,
  "Save this spot" averages ~6 s of GPS fixes; *Place it here* moves the feature, *Reference spot* lines
  the whole plan up (anchor + rotation fitted from two or more spots).
- Gate: `npm run e2e:venue-map` (stand-in).

## What the owner needs to provide

1. **Site plan**: the DWG saved as **ASCII DXF** (AutoCAD: Save As → DXF, "ASCII"), ideally with
   `$INSUNITS` set (metres or millimetres) — or an SVG export. Hatching, text and furniture layers can be
   hidden in the editor.
2. **Geo reference**: the latitude/longitude of one recognisable point on the plan (for example the main
   gate, or a court corner) and the plan's rotation from true north if known. Better: walk the venue with
   Survey mode and save 3–4 *reference spots* (gate, two far court corners) — the plan lines itself up.
3. **Court names** exactly as in the events' courts ("Court 1" … "Court 16") and which event uses which
   court; which courts are streamed.
4. **Points of interest** with names: toilets, buffet / café, medical, entrances (and which is the main
   one), parking, referee office, tournament desk, players' lounge, prayer room (indoor / floor if any).
5. **Walkways**: the paths people may walk (and where fences or closed areas block them).
