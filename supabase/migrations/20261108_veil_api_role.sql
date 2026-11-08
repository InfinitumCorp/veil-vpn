-- Database login for the VEIL</>™ control API Worker (deploy/api).
-- Least privilege: it can read and write the veil_vpn tables and nothing else in the shared
-- project. Its password is set separately (never in this repo) and stored only as the Worker's
-- DATABASE_URL secret. anon and authenticated still have no access to veil_vpn.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'veil_api') then
    create role veil_api login noinherit;
  end if;
end $$;

alter role veil_api set search_path = veil_vpn;
alter role veil_api set statement_timeout = '10s';
alter role veil_api connection limit 60;

grant usage on schema veil_vpn to veil_api;
grant select, insert, update, delete on all tables in schema veil_vpn to veil_api;
alter default privileges in schema veil_vpn grant select, insert, update, delete on tables to veil_api;

-- RLS stays on: these policies admit only the veil_api role (anon/authenticated still see nothing).
do $$
declare t text;
begin
  foreach t in array array['sessions','usage','conns','wg_peers','ad_stats','member_ads','revenue','epochs','payouts','net_day'] loop
    execute format('drop policy if exists veil_api_all on veil_vpn.%I', t);
    execute format('create policy veil_api_all on veil_vpn.%I for all to veil_api using (true) with check (true)', t);
  end loop;
end $$;
