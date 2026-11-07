-- VEIL</>™ control plane on Supabase Postgres.
-- Same data as control/server.js + control/fraud.js (SQLite), in its own schema.
-- Only the control Edge Function (service role) touches these tables: RLS is on with no
-- policies, so the anon and authenticated keys can read or write nothing here.
-- Privacy: no IP addresses, no raw device IDs, no visited sites. See site/privacy.html.

create schema if not exists veil_vpn;

create table if not exists veil_vpn.sessions (
  id           text primary key,
  key_hash     text not null,
  created      timestamptz not null default now(),
  wallet       text,
  device_hash  text,                      -- keyed hash of the install ID, never the ID itself
  platform     text,
  flags        text not null default ''
);
create index if not exists sessions_device on veil_vpn.sessions (device_hash);
create index if not exists sessions_wallet on veil_vpn.sessions (wallet);

create table if not exists veil_vpn.usage (
  sid        text not null references veil_vpn.sessions (id) on delete cascade,
  day        date not null,
  minutes    integer not null default 0,
  last_beat  bigint  not null default 0,  -- epoch ms of the last credited heartbeat
  primary key (sid, day)
);

create table if not exists veil_vpn.conns (
  sid   text primary key references veil_vpn.sessions (id) on delete cascade,
  node  text not null,
  mode  text not null check (mode in ('proxy', 'wireguard')),
  exp   bigint not null                   -- epoch ms
);

create table if not exists veil_vpn.wg_peers (
  pubkey  text primary key,
  sid     text not null references veil_vpn.sessions (id) on delete cascade,
  node    text not null,
  ip      inet not null,
  unique (node, ip)
);

create table if not exists veil_vpn.ad_stats (
  day     date not null,
  ad      text not null,
  views   integer not null default 0,
  clicks  integer not null default 0,
  primary key (day, ad)
);

create table if not exists veil_vpn.member_ads (
  sid     text not null references veil_vpn.sessions (id) on delete cascade,
  day     date not null,
  views   integer not null default 0,
  clicks  integer not null default 0,
  usd     numeric(14, 6) not null default 0,
  primary key (sid, day)
);

create table if not exists veil_vpn.revenue (
  day            date primary key,
  estimated_usd  numeric(14, 6) not null default 0,
  reported_usd   numeric(14, 6)
);

create table if not exists veil_vpn.epochs (
  day            date primary key,
  members        integer,
  minutes        integer,
  revenue_usd    numeric(14, 6),
  tier           text,
  community_pct  numeric(6, 3),
  pool_usd       numeric(14, 6),
  boost          numeric(10, 6),
  price          numeric(14, 8),
  closed_at      timestamptz
);

create table if not exists veil_vpn.payouts (
  sid        text not null references veil_vpn.sessions (id) on delete cascade,
  day        date not null,
  minutes    integer,
  base_veil  numeric(20, 8),
  pool_usd   numeric(14, 6),
  pool_veil  numeric(20, 8),
  status     text not null default 'accrued' check (status in ('accrued', 'queued', 'paid', 'held', 'void')),
  wallet     text,
  primary key (sid, day)
);

-- Fraud: keyed hash of the /24 or /48 block, daily key, deleted after 3 days.
create table if not exists veil_vpn.net_day (
  day  date not null,
  net  text not null,
  sid  text not null,
  primary key (day, net, sid)
);

-- Lock everything down: service role only.
do $$
declare t text;
begin
  foreach t in array array['sessions','usage','conns','wg_peers','ad_stats','member_ads','revenue','epochs','payouts','net_day'] loop
    execute format('alter table veil_vpn.%I enable row level security', t);
    execute format('revoke all on veil_vpn.%I from anon, authenticated', t);
  end loop;
end $$;
revoke all on schema veil_vpn from anon, authenticated;
grant usage on schema veil_vpn to service_role;
grant all on all tables in schema veil_vpn to service_role;

-- Daily purge of network tags older than 3 days (needs the pg_cron extension).
-- select cron.schedule('veil-net-day-purge', '17 * * * *', $$delete from veil_vpn.net_day where day < current_date - 3$$);
