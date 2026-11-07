# RUNBOOK — the house's key (`house@house`)

One keypair. A participant key, never a master key (SPEC §5 #15). This is the
procedure for provisioning it, moving it, backing it up, restoring it, and
living with its loss. Read the next section before anything else.

## What this key opens, and what it does not

| Letter | Does the house key open it? |
|---|---|
| **Collaborative** — sealed with `house@house` among the recipients | **Yes.** This key is required. Without it the body is unreadable. |
| **Unsealed** — no seal at all | Irrelevant. The body is plaintext in Postgres; no key is needed to read it. |
| **Sealed** — sealed to the correspondents only, `house@house` not a recipient | **No, never.** No house key of any kind opens one. The house is not in the recipient set. |

So the key is the difference between "a database dump exposes the unsealed
layer" and "a database dump exposes the collaborative layer too".

## What losing it means

**Collaborative letters sealed before the loss are unreadable forever.** Not
"until someone finds the backup" — forever, if no backup exists. There is no
recovery path, because the house holds no escrow and cannot derive the key from
anything. This is the honest answer and it is stated here so nobody discovers it
on the worst day.

What the loss does *not* do:

- **Sealed letters are unaffected.** They never depended on this key; each
  correspondent opens them with their own identity.
- **Unsealed letters are unaffected.** They are plaintext.
- **New collaborative letters work again** once a new keypair is provisioned —
  but every letter sealed to the old identity stays closed, and its
  correspondents were sealing to a recipient that no longer exists.
- **The archive is not corrupt.** Ids, signatures, threads, frames, payloads and
  the semantic layer are all untouched. What is gone is one ability.

## The two artefacts, and why they must live apart

| Artefact | Holds | Lives in | Backed up as |
|---|---|---|---|
| `house_keys` row | `age_recipient`, `ed25519_public` — **public** halves | the house database | part of the database backup |
| secret store | `HOUSE_AGE_IDENTITY`, `HOUSE_ED25519_PRIVATE` — **private** halves | `containers/poste-restante/.env.enc` (sops + age) | **separately, off-box** |

The point of the split is that a database dump alone opens nothing sealed. That
property survives only if the two artefacts are kept apart: **do not store the
secret inside the database backup, on the same host, or under the same
credentials.** A backup that contains both is no better than the arrangement
this replaced.

## Provision a new house

Run from `server/`, against the database the house uses:

```sh
cd server
npm run house:key:init
```

What happens, in this order:

1. A keypair is generated.
2. The **private** halves are written to `containers/poste-restante/.env.house-key`
   (mode 0600, gitignored). It refuses to overwrite an existing file — that file
   may be the only copy of an identity; use `--out <path>` or `--force` if you
   are certain.
3. The **public** halves are written to `house_keys` and mirrored into
   `address_keys` for `house@house`.

Then move the secret into the store:

```sh
sops containers/poste-restante/.env.enc   # add the two lines, save, quit
shred -u containers/poste-restante/.env.house-key
```

The house will not boot without it: `compose.yml` refuses to interpolate
`HOUSE_AGE_IDENTITY` / `HOUSE_ED25519_PRIVATE`, and the service raises
`HouseKeyMissingError` rather than minting a replacement.

In development (no container), put the same two lines in `server/.env` instead
of `.env.enc` — `npm run serve` loads it.

## Upgrade a house that still carries the private halves in the database

Before migration 032 a house kept its private halves in the `house_keys` row.
They are still there. The columns are deprecated and nullable, but they are
**not** empty, and until they are the dump still opens the collaborative layer.
Do this once, in order:

```sh
cd server

# 1. Export. The row still has the private halves, so init writes them out
#    instead of generating a new identity. Refuses if the file exists.
npm run house:key:init

# 2. Into the secret store, and destroy the plaintext seed.
sops containers/poste-restante/.env.enc    # add the two lines, save
shred -u containers/poste-restante/.env.house-key

# 3. Prove the secret works before deleting what may be its only other copy.
#    Load .env.enc into the environment first (deploy.sh config prints the
#    names; `set -a; source <(sops --decrypt .env.enc); set +a` in a shell).
npm run house:key:check       # expects: house:key-ok

# 4. Only then, empty the columns. It refuses unless check would have passed.
npm run house:key:forget-db-halves

# 5. Confirm the columns are empty.
npm run house:key:export      # expects: house:key-nothing-to-export (exit 1)
```

Step 3 is the gate. `forget-db-halves` deletes what may be the only copy of the
identity, so it verifies first that the environment's secret derives the row's
public halves — the same check `house:key:check` performs. If you cannot reach
step 3 cleanly, stop: the house keeps working, and the leak the split was meant
to close stays open until you finish.

## Back up

The public halves ride along with the database backup. The **private halves are
yours to back up**, and they need their own custody:

- Encrypt them (they are already encrypted in `.env.enc` — back up that file,
  plus the age recipient key that decrypts it, kept elsewhere again) and store
  **two copies, at least one offline and off-box**.
- Re-back-up whenever `house:key:init` runs. The key does not otherwise change.
- Test the backup: restore into a scratch checkout and run
  `npm run house:key:check` against a copy of the database. A backup nobody has
  restored is a hope, not a backup.
- Never: in the repository, in a letter, in a whisper, in a chat message, in a
  ticket, in a screenshot of your terminal.

## Restore

Order matters only in that both are needed before a collaborative letter opens.

1. **The database**, by whatever route the house's Postgres backups use. The
   `house_keys` row comes back with the public halves.
2. **The secret store**: restore `.env.enc` (and its sops age key) into
   `containers/poste-restante/`.
3. **Verify** before declaring the restore done:

```sh
cd server
npm run house:key:show     # the public halves — compare with your records
npm run house:key:check    # house:key-ok, or a named refusal with the remedy
```

`check` proves the secret in the environment derives the public halves in this
database. It does not sample a letter, and it does not need to: if the halves
match the row, every collaborative letter sealed to that row opens.

If `check` reports a **mismatch**, the secret and the database are from
different houses. Stop — do not run `house:key:init` and do not run
`forget-db-halves`. Get the `.env.enc` that belongs to *this* database, or the
database that belongs to this secret.

## If the key is lost

There is no recovery. The options are, in order:

1. **Restore from backup.** This is the only route that keeps the collaborative
   archive. If the backup is gone, it is gone.
2. **Accept the loss and mint a new identity.** Collaborative letters sealed to
   the old one stay unreadable forever. Sealed and unsealed letters are
   unaffected. New collaborative letters work with the new key. Do this
   deliberately:

   ```sh
   cd server
   # The row must go: init refuses to replace an identity it cannot prove.
   psql "$DATABASE_URL" -c 'DELETE FROM house_keys WHERE id = 1;'
   npm run house:key:init      # writes the new secret
   # …then the store step from "Provision a new house".
   ```

   Record the date. Everything collaborative before it is closed, and a
   correspondent who sealed to the old recipient should be told plainly rather
   than left sealing into a void.

## Commands

Run from `server/`.

| Command | Does |
|---|---|
| `npm run house:key:init` | Provision, or export a database that still holds the private halves |
| `npm run house:key:show` | Print the **public** halves (works without the secret) |
| `npm run house:key:check` | Prove the secret matches this database |
| `npm run house:key:export` | Move the private halves out of an un-upgraded database |
| `npm run house:key:forget-db-halves` | Empty the deprecated columns, after proving the secret |

No command prints a private half except to the file named by `--out`.

## Where this is enforced

- `server/src/house/keys.ts` — the service: reads public columns only, reads the
  secret from the environment, refuses on absence or mismatch.
- `server/src/db/migrations/032_house_key_private_halves_outside.sql` — relaxes
  the deprecated columns so a new house never writes them.
- `server/test/unit/house-keys.test.ts` — the restored-database-without-the-
  secret test, and the refusal-not-mint tests.
- `containers/poste-restante/compose.yml` — refuses to start without the secret.
