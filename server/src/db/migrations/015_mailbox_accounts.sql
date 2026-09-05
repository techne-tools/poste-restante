-- 015_mailbox_accounts.sql — the mailbox sync's per-resident accounts (SPEC §5 #12).
--
-- Movement B built the pure engine (B1), the sync state machine (B2a), and
-- the live IMAP adapter (B2b). This migration gives the sync drive its
-- subject: which residents have a mailbox, and where it lives.
--
-- Privacy as schema (invariant 4): an account row is the ONLY thing that
-- makes a resident's mailbox sync — no row, no sync, no connection. The
-- drive enumerates accounts and syncs only those; it never scans addresses.
--
-- The URL carries the sidecar credential — a per-resident, sidecar-specific
-- secret (minted once, printed once, exactly like an invite code; the B1
-- design note: "sidecar-specific secrets, not the house password"). The
-- house stores that secret in the URL because the house is the one who
-- speaks IMAP with it — but it is a sidecar secret, never the resident's
-- house credential, and never the postgres password.
--
-- Sidecar addresses are RFC 2606 test domains: house.test on the dev
-- sidecar, house.internal on the homelab container — never the house's own
-- @house domain (that is a header-space name, not a resolvable mailbox).
--
-- Columns:
--   address       the resident (house address, e.g. you@house). PK.
--   url           the sidecar IMAP URL (imap:// or imaps://) with the
--                 sidecar-specific credential in the userinfo.
--   created_at    when the account was provisioned.
CREATE TABLE IF NOT EXISTS mailbox_accounts (
  address    TEXT PRIMARY KEY,
  url        TEXT NOT NULL CHECK (
               url LIKE 'imap://%' OR url LIKE 'imaps://%'
             ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mailbox_accounts_created_at_idx
  ON mailbox_accounts (created_at);
