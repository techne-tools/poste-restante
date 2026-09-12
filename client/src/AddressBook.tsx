import { useCallback, useEffect, useState } from "react";
import { house } from "./api";
import type { Address } from "./api";

interface Props {
  onError: (msg: string) => void;
  onCompose: (address: string) => void;
}

export default function AddressBook({ onError, onCompose }: Props) {
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [loading, setLoading] = useState(true);

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

  if (loading) return <p className="empty">Opening the address book…</p>;

  return (
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
  );
}
