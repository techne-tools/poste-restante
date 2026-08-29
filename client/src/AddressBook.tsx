import { useCallback, useEffect, useState } from "react";
import { house } from "./api";
import type { Address } from "./api";

interface Props {
  onError: (msg: string) => void;
}

export default function AddressBook({ onError }: Props) {
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
        <div key={a.id} className="address-row">
          <span className="addr">{a.id}</span>
          <span className="names">
            {a.names.length > 0 ? a.names.join(", ") : a.pronouns ?? ""}
          </span>
        </div>
      ))}
    </div>
  );
}
