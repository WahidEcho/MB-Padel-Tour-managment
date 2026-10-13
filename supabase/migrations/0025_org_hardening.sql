-- 0025_org_hardening
--
-- Security review of Phase 0.5B (organisations: onboarding, invites, members,
-- profile). Additive and idempotent; no new table. See docs/organizations.md.
--
-- 1. The last owner, under concurrency. Two requests demoting (or removing) the
--    organisation's last two owners at the same time each saw the other still
--    active at READ COMMITTED and both passed. The trigger now locks the
--    organisation's row first (select … for update), so such changes to one
--    organisation's owners run one after the other, and the check that follows
--    sees the other's committed change.
-- 2. organizations.pending_name: a rename of an approved organisation waits here
--    until a platform admin approves it (Admin → Organisations); the public name
--    is unchanged meanwhile.

-- 1.
create or replace function organization_members_keep_owner() returns trigger
language plpgsql
set search_path = public
as $$
declare
  org uuid := coalesce(old.organization_id, new.organization_id);
begin
  -- The organisation itself is being deleted (its members go with it, by cascade).
  if tg_op = 'DELETE' and not exists (select 1 from organizations o where o.id = org) then
    return old;
  end if;
  if old.role = 'owner' and old.status = 'active'
     and (tg_op = 'DELETE' or new.role <> 'owner' or new.status <> 'active' or new.organization_id <> old.organization_id)
  then
    -- One owner change per organisation at a time: wait for any other, then look
    -- again (a new statement, so a fresh snapshot that sees what it committed).
    perform 1 from organizations o where o.id = org for update;
    if not exists (
      select 1 from organization_members m
      where m.organization_id = org and m.id <> old.id and m.role = 'owner' and m.status = 'active'
    ) then
      raise exception 'an organisation must keep at least one owner'
        using errcode = '23514';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists organization_members_keep_owner on organization_members;
create trigger organization_members_keep_owner
  before update or delete on organization_members
  for each row execute function organization_members_keep_owner();

-- 2.
alter table organizations add column if not exists pending_name text;
alter table organizations drop constraint if exists organizations_pending_name_check;
alter table organizations add constraint organizations_pending_name_check
  check (pending_name is null or char_length(pending_name) between 2 and 120);
alter table organizations add column if not exists pending_name_at timestamptz;
