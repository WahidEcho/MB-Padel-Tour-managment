-- 0032_function_search_path
--
-- Pins gen_player_access_code()'s search_path (Supabase advisor "function search
-- path mutable"): it uses gen_random_uuid(), which lives in public or extensions.
-- Already applied on the live project on 14 Oct 2026.
--
-- Idempotent, and skipped where the function is not in public (the local stand-in
-- creates it there from 0018; nothing else is touched).

do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'gen_player_access_code' and p.pronargs = 0
  ) then
    alter function public.gen_player_access_code() set search_path = public, extensions;
  end if;
end $$;
