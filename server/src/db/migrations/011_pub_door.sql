-- 011_pub_door.sql
-- The pub's door becomes schema, not code.
--
-- Before this migration, "the pub is the public exception" was hard-coded:
-- `server.ts` skipped auth for pub@house's mailbox, and the MCP face did the
-- same. A closed pub therefore had nowhere to live — the door was welded
-- open. House invariant 4 (privacy as schema): the door state is data now.
--
--   addresses.is_public : the address's room is open to unauthenticated
--                         readers. Only meaningful for pub@house today, but
--                         it is a property of the ROOM, not of pub@house —
--                         the schema makes no special case for the name.
--
-- Seed: pub@house is created public so an existing house keeps its open pub
-- after migration, and a fresh house's pub is open by default — the house's
-- stance is "public until you deliberately close the door". Closing is an
-- UPDATE, not a deploy:
--
--   UPDATE addresses SET is_public = false WHERE id = 'pub@house';
--
-- The DO UPDATE matters: on a house where pub@house already exists (created
-- by an earlier delivery), a plain DO NOTHING would leave the new column at
-- its default false — a door closed by accident. Before this migration the
-- pub was WELDED open in code; there was no way to close it. Every existing
-- pub row therefore normalises to open.
--
-- Note: storeLetter materialises addresses on first delivery, so a pub row
-- wiped by a test reset comes back — as PUBLIC when absent (ON CONFLICT DO
-- NOTHING keeps a deliberately-closed door closed).
ALTER TABLE addresses
    ADD COLUMN IF NOT EXISTS is_public boolean NOT NULL DEFAULT false;

INSERT INTO addresses (id, is_public) VALUES ('pub@house', true)
ON CONFLICT (id) DO UPDATE SET is_public = true;
