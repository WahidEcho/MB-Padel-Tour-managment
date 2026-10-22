-- 0043: Move Score Stories (docs: AGENTS.md "Move Score Stories"; pure rules
-- src/lib/stories/rules.ts, server src/lib/stories/server.ts).
--
-- A story is one 1080×1920 picture made in the app's story composer (it always
-- carries a match, tie or pass card), posted by a signed-in account, tied to the
-- public event it came from, and gone 24 hours after posting. Live at once;
-- viewers can report (three distinct reports hide it until staff decide) and
-- block the poster; staff restore, remove, and platform admins ban.
--
-- 1. stories: the picture's media path (stories/<poster key>/<id>.jpg), the poster's
--    name and photo as they were at posting, where it came from, its lifetime and
--    its moderation state.
-- 2. story_views: one row per story and viewer (an HMAC of the account or the
--    phone's install id, never the id itself).
-- 3. story_likes: one like per story and account.
-- 4. story_reports: one report per story and account, with a reason.
-- 5. story_blocks: who blocked whose stories (per account, both ways never shown).
-- 6. story_bans: accounts that may not post.
--
-- Idempotent. RLS on for every new table, no policy, nothing granted to anon /
-- authenticated (the server's secret key bypasses RLS). Apply on the live project
-- before deploying a build that serves stories.

create table if not exists stories (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null,
  poster_name text check (poster_name is null or char_length(poster_name) <= 80),
  poster_avatar_url text check (poster_avatar_url is null or char_length(poster_avatar_url) <= 600),
  organization_id uuid references organizations(id) on delete set null,
  tournament_id uuid not null references tournaments(id) on delete cascade,
  match_id uuid references matches(id) on delete set null,
  tie_id uuid references ties(id) on delete set null,
  kind text not null check (kind in ('match', 'tie', 'pass')),
  image_path text not null check (image_path like 'stories/%' and char_length(image_path) <= 200),
  caption text check (caption is null or char_length(caption) <= 140),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  hidden_at timestamptz,
  hidden_reason text check (hidden_reason is null or hidden_reason in ('reports', 'staff')),
  restored_at timestamptz,
  removed_at timestamptz,
  removed_by text check (removed_by is null or char_length(removed_by) <= 120)
);
create index if not exists stories_live_idx on stories (expires_at) where removed_at is null and hidden_at is null;
create index if not exists stories_user_idx on stories (auth_user_id, created_at desc);
create index if not exists stories_tournament_idx on stories (tournament_id, created_at desc);
create index if not exists stories_org_idx on stories (organization_id, created_at desc);

create table if not exists story_views (
  story_id uuid not null references stories(id) on delete cascade,
  viewer_key text not null check (char_length(viewer_key) between 8 and 80),
  viewed_at timestamptz not null default now(),
  primary key (story_id, viewer_key)
);

create table if not exists story_likes (
  story_id uuid not null references stories(id) on delete cascade,
  auth_user_id uuid not null,
  liked_at timestamptz not null default now(),
  primary key (story_id, auth_user_id)
);

create table if not exists story_reports (
  story_id uuid not null references stories(id) on delete cascade,
  reporter_user_id uuid not null,
  reason text not null check (reason in ('spam', 'nudity', 'harassment', 'hate', 'violence', 'false', 'other')),
  reported_at timestamptz not null default now(),
  primary key (story_id, reporter_user_id)
);
create index if not exists story_reports_at_idx on story_reports (reported_at desc);

create table if not exists story_blocks (
  blocker_user_id uuid not null,
  blocked_user_id uuid not null,
  blocked_at timestamptz not null default now(),
  primary key (blocker_user_id, blocked_user_id),
  check (blocker_user_id <> blocked_user_id)
);

create table if not exists story_bans (
  auth_user_id uuid primary key,
  banned_by text not null check (char_length(banned_by) between 1 and 120),
  reason text check (reason is null or char_length(reason) <= 300),
  banned_at timestamptz not null default now()
);

alter table stories enable row level security;
alter table story_views enable row level security;
alter table story_likes enable row level security;
alter table story_reports enable row level security;
alter table story_blocks enable row level security;
alter table story_bans enable row level security;
revoke all on stories, story_views, story_likes, story_reports, story_blocks, story_bans from anon, authenticated;
