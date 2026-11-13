-- VEIL Premium (no ads) for VEIL</>™ VPN.
-- When a person signs in, the control server asks the Cumulus billing hub whether their Cumulus ID
-- pays for veil_premium, and stores until when (ms since epoch) on every session of that account.
-- 0 means no Premium. Nothing about the payment itself is stored here.
alter table veil_vpn.sessions add column if not exists premium_until bigint not null default 0;
