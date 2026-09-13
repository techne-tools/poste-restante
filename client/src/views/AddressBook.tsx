import { useCallback, useEffect, useState } from "react";
import { house } from "../api";
import type { Address } from "../api";

interface Props {
  onError: (msg: string) => void;
  onCompose: (address: string) => void;
}

export default function AddressBook({ onError, onCompose }: Props) {
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [loading, setLoading] = useState(true);
  // The invitation desk — the resident's own door opening (SPEC §5.7).
  const [inviting, setInviting] = useState(false);
  const [guestAddress, setGuestAddress] = useState("");
  const [minting, setMinting] = useState(false);
  /** The code, shown once, held in memory for the life of the view. */
  const [minted, setMinted] = useState<{ address: string; code: string } | null>(null);

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

  if (loading) return <p className="empty">Opening the address book…</p>;

  return (
    <div>
      <div className="address-list">
        {addresses.length === 0 && (
          <p className="empty">The address book is empty — the house knows no one yet.</p>
        )}
        {addresses.map((a) => (
          <button
            key={a.id}
            className="address-row"
            onClick={() => onCompose(a.id)}
            title={a.isAgent ? `${a.id} — an instrument of the house` : `Write to ${a.id}`}
            aria-label={
              a.isAgent
                ? `${a.id} — an instrument of the house; open a letter`
                : `Write to ${a.id}`
            }
          >
            <span className="address-who">
              <span className="addr">{a.id}</span>
              {a.isAgent && <span className="instrument-tag">instrument</span>}
            </span>
            <span className="names">
              {a.names.length > 0 ? a.names.join(", ") : a.pronouns ?? ""}
            </span>
          </button>
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
