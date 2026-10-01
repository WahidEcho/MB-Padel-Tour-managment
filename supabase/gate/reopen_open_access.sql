-- Rollback for close_open_access.sql: restores the old open posture exactly.
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' and tablename <> 'rls_canary' loop
    execute format('drop policy if exists server_full_access on %I', t);
    execute format('create policy server_full_access on %I for all to anon, authenticated using (true) with check (true)', t);
  end loop;
end $$;
grant all on all tables in schema public to anon, authenticated;
grant all on all sequences in schema public to anon, authenticated;
create policy media_write on storage.objects for insert to anon, authenticated with check (bucket_id = 'media');
create policy media_update on storage.objects for update to anon, authenticated using (bucket_id = 'media');
create policy media_delete on storage.objects for delete to anon, authenticated using (bucket_id = 'media');
