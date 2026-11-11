-- Cumulus ID sign-in for VEIL</>™ VPN.
-- A session (one per device) now belongs to the person who signed in with Cumulus ID.
-- `account` is a keyed hash (HMAC with the control server's TOKEN_SECRET) of the CID, never the CID,
-- name or email. All sessions with the same account share one earning account: one daily limit,
-- one wallet, one balance.
alter table veil_vpn.sessions add column if not exists account text;
create index if not exists sessions_account on veil_vpn.sessions (account);
