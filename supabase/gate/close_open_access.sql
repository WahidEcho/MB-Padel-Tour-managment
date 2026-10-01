-- Closes the database's open door. NOT a regular migration: apply it only after
-- production's SUPABASE_KEY is the project's secret key and /api/health/db reports
-- "secret". With the anon key still in use, this blanks every page and TV.
--
-- After it, the anon and authenticated keys can read and write nothing; the server
-- keeps working because the secret key bypasses row-level security.
-- Rollback: supabase/gate/reopen_open_access.sql.

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists server_full_access on %I', t);
  end loop;
end $$;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

-- Storage: public URLs of the public `media` bucket keep working; nobody but the
-- server can upload, overwrite or delete.
drop policy if exists media_write on storage.objects;
drop policy if exists media_update on storage.objects;
drop policy if exists media_delete on storage.objects;

-- Proof row for /api/health/db: readable only with the secret key.
create table if not exists rls_canary (id int primary key, note text);
alter table rls_canary enable row level security;
insert into rls_canary values (1, 'secret key in use') on conflict (id) do nothing;
