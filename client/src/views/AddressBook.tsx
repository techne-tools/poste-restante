import { useCallback, useEffect, useState } from "react";
import { house } from "../api";
import type { Address } from "../api";
import { composeKeyLetter } from "../utils/keyletter";

interface Props {
  onError: (msg: string) => void;
  onCompose: (address: string) => void;
  /** The resident reading the book. Their keys are what a keyletter carries,
   *  and their own row offers nothing (you cannot post keys to yourself).
   *  Optional so the row can be rendered — and tested — without a session. */
  from?: string;
}

/**
 * One line of the address book. Exported because its states matter and are
 * cheap to render: an address WITH keys, one with none yet (which can still
 * receive a letter, but not a sealed one — SPEC §15), and one whose key has
 * CHANGED in a way no one has answered yet (a keyletter's offer, 034).
 *
 * All three are visible here rather than only at a refused send: the book is
 * where a resident looks at who they are corresponding with, so it is where
 * these facts belong.
 */
export function AddressRow({
  address: a,
  onCompose,
  from,
  onSendKeys,
  onAnswerOffer,
}: {
  address: Address;
  onCompose: (address: string) => void;
  from?: string;
  onSendKeys?: (address: string) => void;
  onAnswerOffer?: (address: string, letterId: string, accept: boolean) => void;
}) {
  const keyless = !a.ageRecipient;
  const offer = a.keyOffer ?? null;
  const canSendKeys = Boolean(onSendKeys && from && a.id !== from && !a.isAgent);
  return (
    <div className="address-line">
      <button
        className="address-row"
        onClick={() => onCompose(a.id)}
        title={
          a.isAgent
            ? `${a.id} — an instrument of the house`
            : keyless
              ? `${a.id} has no keys yet — write now; a sealed letter can reach them once they make theirs`
              : `Write to ${a.id}`
        }
        aria-label={
          a.isAgent
            ? `${a.id} — an instrument of the house; open a letter`
            : keyless
              ? `${a.id} — no keys yet; a sealed letter cannot reach them`
              : `Write to ${a.id}`
        }
      >
        <span className="address-who">
          <span className="addr">{a.id}</span>
          {a.isAgent && <span className="instrument-tag">instrument</span>}
          {/* Visible, not a warning: an address with no keys cannot take a
              sealed letter, and the resident should know that from the book
              rather than from a refused send. The row still opens a letter —
              unsealed correspondence is fine. */}
          {keyless && <span className="keyless-tag">no keys yet</span>}
        </span>
        <span className="names">
          {a.names.length > 0 ? a.names.join(", ") : a.pronouns ?? ""}
        </span>
      </button>
      {/* The in-band keyletter (SPEC §15). A correspondent with no keys has
          no way to be told out of band, and the house's own idiom for being
          told is a letter. This sends ours; when they answer in kind, a
          sealed letter can reach them. */}
      {canSendKeys && (
        <button
          className="address-act"
          onClick={() => onSendKeys!(a.id)}
          title={`send your keys to ${a.id} — they can seal a letter to you once they have them`}
        >
          send my keys
        </button>
      )}
      {/* A keyletter that disagrees with the live record does not overwrite
          it: whoever sealed to the old key needs to see the change. The offer
          is a state the resident answers, not a silent update. */}
      {offer && onAnswerOffer && (
        <div className="key-offer" role="status">
          <p className="key-offer-say">
            {a.id} has published different keys — a letter sealed to the old key will not reach
            them. The house has not changed the record; that is yours to say.
          </p>
          <div className="book-propose-actions">
            <button
              className="clause-act"
              onClick={() => onAnswerOffer(a.id, offer.letterId, true)}
            >
              Accept the new key
            </button>
            <button
              className="clause-act"
              onClick={() => onAnswerOffer(a.id, offer.letterId, false)}
            >
              Leave the record as it is
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AddressBook({ onError, onCompose, from }: Props) {
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [loading, setLoading] = useState(true);
  // The invitation desk — the resident's own door opening (SPEC §5.7).
  const [inviting, setInviting] = useState(false);
  const [guestAddress, setGuestAddress] = useState("");
  const [minting, setMinting] = useState(false);
  /** The code, shown once, held in memory for the life of the view. */
  const [minted, setMinted] = useState<{ address: string; code: string } | null>(null);
  /** Who a keyletter was just sent to — said here, because the book will not
   *  change (the keys land on OUR record, not theirs). */
  const [keysSentTo, setKeysSentTo] = useState<string | null>(null);
  const [sendingKeys, setSendingKeys] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await house.addresses();
      setAddresses(res.addresses);
    } catch (err) {
      onError(err instanceof Error ? err.message : "the address book is closed");
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    load();
  }, [load]);

  const mint = async () => {
    if (!guestAddress.trim()) return;
    setMinting(true);
    try {
      const res = await house.createInvite(guestAddress.trim());
      setMinted({ address: res.address, code: res.code });
      setGuestAddress("");
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : "the house could not write this invitation");
    } finally {
      setMinting(false);
    }
  };

  /** Send our keys to a correspondent, in the house's own idiom. The letter
   *  carries the public halves and is signed with the private half of the key
   *  it publishes, so the house can bind them on first sight — and a
   *  correspondent who answers in kind becomes reachable for sealed letters. */
  const sendKeys = async (to: string) => {
    if (!from) return;
    setSendingKeys(true);
    setKeysSentTo(null);
    try {
      const keyletter = await composeKeyLetter({ from, to, addressBook: addresses });
      await house.deliver(keyletter.letter);
      setKeysSentTo(to);
    } catch (err) {
      // The keystore's own refusals are resident-facing copy (absent, sealed)
      // — they say what to do, so they are shown as they are.
      onError(err instanceof Error ? err.message : "the house could not carry your keys");
    } finally {
      setSendingKeys(false);
    }
  };

  /** Answer a keyletter's offered key change. Accepting installs the offered
   *  keys as the live record; declining leaves the record standing. */
  const answerOffer = async (address: string, letterId: string, accept: boolean) => {
    try {
      if (accept) await house.acceptKeyOffer(address, letterId);
      else await house.declineKeyOffer(address, letterId);
      await load();
    } catch (err) {
      onError(err instanceof Error ? err.message : "the house could not take that answer");
    }
  };

  if (loading) return <p className="empty">Opening the address book…</p>;

  return (
    <div>
      {keysSentTo && (
        <p className="compose-hint" role="status">
          Your keys have gone to {keysSentTo} — they can seal a letter to you now. When they send
          theirs back, a sealed letter can reach them too.
        </p>
      )}
      <div className="address-list">
        {addresses.length === 0 && (
          <p className="empty">The address book is empty — the house knows no one yet.</p>
        )}
        {addresses.map((a) => (
          <AddressRow
            key={a.id}
            address={a}
            onCompose={onCompose}
            from={from}
            onSendKeys={sendingKeys ? undefined : sendKeys}
            onAnswerOffer={answerOffer}
          />
        ))}
      </div>

      {/* The invitation desk — inviting is a resident act, quiet, in place.
          The code is shown once: the house never stores it, and this view
          holds it only in memory until the resident leaves the room. */}
      <section className="invite-desk">
        <h3>Invite someone to the house</h3>
        {minted ? (
          <div className="invite-reveal">
            <p className="compose-hint">
              {minted.address} can enter with this one-time code — give it to them out of
              band; the house never pushes.
            </p>
            <pre className="recovery-key">{minted.code}</pre>
            <div className="book-propose-actions">
              <button className="clause-act" onClick={() => setMinted(null)}>
                I have passed it on
              </button>
            </div>
          </div>
        ) : inviting ? (
          <div className="invite-composer">
            <label className="compose-field">
              <span className="compose-label">Their address</span>
              <input
                value={guestAddress}
                onChange={(e) => setGuestAddress(e.target.value)}
                placeholder="sam@house"
                autoComplete="off"
              />
            </label>
            <div className="book-propose-actions">
              <button className="gated" disabled={minting || !guestAddress.trim()} onClick={mint}>
                {minting ? "Writing…" : "Write the invitation"}
              </button>
              <button className="clause-act" onClick={() => setInviting(false)} disabled={minting}>
                Put it down
              </button>
            </div>
          </div>
        ) : (
          <div className="book-propose-actions">
            <button className="clause-act" onClick={() => setInviting(true)}>
              Write an invitation
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
