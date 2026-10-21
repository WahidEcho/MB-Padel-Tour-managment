-- J200 Cairo 2026 go-live (run once in Supabase → SQL editor, project dwyztzywuscljqklhqij):
--   1. public pages on;
--   2. every match-day switch and referee scoring feature on (Admin → Match day / Scoring features),
--      plus the warm-up timer and umpire voice call;
--   3. the app's Discover landing page: a featured "J200 Cairo 2026" group, first; the demo group second.
-- Undo: update tournaments set public_access_enabled = false, event_group_id = null where slug = 'j200-cairo-2026';
--       delete from event_groups where slug = 'j200-cairo-2026'; update event_groups set featured_rank = 1 where slug = 'junior-team-finals-2026-demo';
begin;
insert into event_groups (id, slug, name, subtitle, city, timezone, starts_on, ends_on, featured_rank)
values (md5('j200cai26:group')::uuid, 'j200-cairo-2026', 'J200 Cairo 2026', 'ITF World Tennis Tour Juniors', 'Cairo', 'Africa/Cairo', '2026-10-19', '2026-10-23', 1)
on conflict (slug) do update set featured_rank = 1, updated_at = now();
update event_groups set featured_rank = 2, updated_at = now() where slug = 'junior-team-finals-2026-demo';
update tournaments set public_access_enabled = true, event_group_id = md5('j200cai26:group')::uuid,
  match_day_rules = '{"configured":true,"showcase":{"on":true,"eventDaysOnly":true},"alerts":{"on":true},"matchSoon":{"on":true,"starredFans":false},"courtCall":{"on":true,"autoOnRefereeOpen":true,"minutes":5,"reminderMinutes":2},"noShow":{"on":true,"extensionMinutes":5,"maxExtensions":2,"bothAbsentPromptOnly":true},"lockScreen":{"liveActivities":true,"startByPush":true,"countdown":true,"autoStartMine":true,"autoStartStarred":false},"widgets":{"on":true},"scoring":{"mode":"either"},"features":{"fault":true,"ace":true,"let":true,"timerBetweenPoints":true,"timerChangeover":true,"timerSetBreak":true,"breakStopwatch":true,"bathroom":true,"hydration":true,"autoSwap":true,"manualSwap":true,"matchLog":true,"doublesOrder":true,"callMaster":true,"tvTimers":true,"tvAces":true},"extras":{"imAtCourt":true,"qrCheckInPresent":true,"warmUpTimer":true,"warmUpMinutes":5,"callOnTv":true,"umpireVoiceCall":true,"skipSoonIfBusy":true,"quietOutsideEventDays":true,"autoCallWithoutReferee":false,"notifyBothOnResult":true}}'::jsonb,
  updated_at = now()
where slug = 'j200-cairo-2026';
insert into platform_settings (key, value_json, updated_by)
values ('discover_order', jsonb_build_array(md5('j200cai26:group')::uuid::text, (select id::text from event_groups where slug = 'junior-team-finals-2026-demo')), 'admin')
on conflict (key) do update set value_json = excluded.value_json, updated_at = now(), updated_by = excluded.updated_by;
commit;

-- Check: one row, public true, ace true, featured_rank 1.
select t.slug, t.public_access_enabled, t.match_day_rules->'features'->>'ace' as ace, eg.slug as grp, eg.featured_rank
from tournaments t join event_groups eg on eg.id = t.event_group_id where t.slug = 'j200-cairo-2026';
