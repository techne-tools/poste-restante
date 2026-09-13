import { useCallback, useEffect, useRef, useState } from "react";
import { house } from "../api";
import { sealDraft } from "../utils/crypto";
import type { Address } from "../api";
import WhyNote from "../components/WhyNote";

interface Props {
  onError: (msg: string) => void;
  onDelivered: () => void;
  initialTo?: string;
  initialThread?: string;
  from: string;
}

/** A letter being written: text, kind, and any enclosures. An audio letter
 *  may carry no text at all — the recording IS the letter; the whisper
 *  transcribes it into a new letter that follows in the same thread. */
interface PendingFile {
  name: string;
  size: number;
  type: string;
  blob: Blob;
}

export default function Compose({ onError, onDelivered, initialTo, initialThread, from }: Props) {
  const [to, setTo] = useState(initialTo ?? "you@house");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [thread, setThread] = useState(initialThread ?? "");
  const [frame, setFrame] = useState("");
  const [kind, setKind] = useState("letter");
  // The seal — on by default when the resident said so (their record,
  // the desk's default). Still a per-letter choice: the toggle is always
  // on the desk, and the resident can lift it for any single letter.
  const [sealed, setSealed] = useState(false);
  /** Seal *with* the house (SPEC §15, second model): collaborative —
   *  house@house joins the recipients, the house can open it (in
   *  memory only). Shown only when the house has a provisioned key
   *  and the resident is sealing. */
  const [withHouse, setWithHouse] = useState(false);
  const [houseRecipient, setHouseRecipient] = useState<string | null>(null);
  const [houseEd25519Public, setHouseEd25519Public] = useState<string | null>(null);
  const [houseAddress, setHouseAddress] = useState<string | null>(null);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [sealing, setSealing] = useState(false);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [sending, setSending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const canSend =
    (body.trim().length > 0 || files.length > 0) && to.trim().length > 0 && !sending;

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const next = Array.from(list)
      .filter((f) => f.size > 0)
      .map((f) => ({ name: f.name, size: f.size, type: f.type, blob: f }));
    if (next.length > 0) setFiles((prev) => [...prev, ...next]);
  };

  // Ensure the key registry is fresh when the resident reaches for the
  // seal — sealing needs every correspondent's public half resident-side.
  const loadAddressBook = useCallback(async () => {
    if (addresses.length > 0) return addresses;
    try {
      const res = await house.addresses();
      setAddresses(res.addresses);
      return res.addresses;
    } catch (err) {
      onError(err instanceof Error ? err.message : "the house could not show the address book");
      return addresses;
    }
  }, [addresses, onError]);

  // Discover the house's public halves once (SPEC §15, second model) —
  // the composer's "seal with the house" choice needs the recipient.
  const loadHouseMeta = useCallback(async () => {
    try {
      const meta = await house.houseMeta();
      setHouseRecipient(meta.houseAgeRecipient);
      setHouseEd25519Public(meta.houseEd25519Public);
      setHouseAddress(meta.houseAddress);
    } catch {
      // The choice simply won't appear — sealing without the house
      // remains the default. Absence is a door the house left unopened.
    }
  }, []);

  useEffect(() => {
    void loadHouseMeta();
  }, [loadHouseMeta]);

  // The desk's default (17): the resident set the seal on by default in
  // their record; the desk starts with it on. Sealed letters stay a
  // per-letter choice — the toggle never disappears.
  useEffect(() => {
    house
      .address(from)
      .then((rec) => {
        if (rec.sealDefault) setSealed(true);
      })
      .catch(() => {
        // The default simply won't apply — sealing remains per-letter.
      });
  }, [from]);

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    try {
      const frames = frame
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          const [name, value] = s.split(":");
          return { frame: name ?? "season", value: value ?? s };
        });
      const toRecipients = [to.trim() || "you@house"];
      // Seal *with* the house (SPEC §15, second model): house@house
      // joins the participants, so the house is a party to the letter
      // and its recipient joins the sealing circle. The house opens
      // collaborative letters in memory only.
      if (withHouse && houseAddress) toRecipients.push(houseAddress);
      const envelope = {
        from,
        to: toRecipients,
        cc: [],
        thread: thread.trim() || `th_${Date.now().toString(36)}`,
        kind,
        lang: "en-AU",
        subject: sealed ? "" : subject.trim(),
      };
      const { id } = await house.deliver(
        sealed
          ? await (async () => {
              // Seal first, then deliver. The address book is the
              // identity map the letter id resolves through — fetched
              // once and held for the composer's life. When the
              // resident seals *with* the house, the house's public
              // halves join the map (its recipient enters the sealing
              // circle; the house is a participant).
              const book = await loadAddressBook();
              const withHouseEntry =
                withHouse && houseRecipient
                  ? [
                      {
                        id: houseAddress ?? "house@house",
                        ageRecipient: houseRecipient,
                        ed25519Public: houseEd25519Public ?? "",
                        recoveryAgeRecipient: null,
                      },
                    ]
                  : [];
              const sealedBook = [...book, ...withHouseEntry];
              setSealing(true);
              try {
                const result = await sealDraft(
                  {
                    envelope,
                    time: { gregorian: new Date().toISOString(), frames },
                    body: { format: "markdown", content: body },
                  },
                  sealedBook,
                  {
                    registerKeys: (id, keys) => house.registerKeys(id, keys),
                  },
                );
                // The delivered letter is EXACTLY what was canonicalised:
                // the sealed body with an EMPTY envelope subject, signed
                // against that stored form. The house renders "sealed
                // letter"; the client presents the first line of the
                // plaintext as the subject after unsealing (SPEC §15 —
                // subject moves into the body).
                return result.letter;
              } finally {
                setSealing(false);
              }
            })()
          : {
              envelope,
              time: { gregorian: new Date().toISOString(), frames },
              body: { format: "markdown", content: body },
            },
      );

      // The letter is delivered; the enclosures follow. Enclosures on
      // sealed letters are client side only — the house cannot read or
      // serve what it cannot open (SPEC §15: sealed payloads are
      // client-side encrypted before upload; v1 ships text bodies, the
      // payload layer is the recorded follow-on).
      for (const f of files) {
        if (sealed) continue;
        try {
          await house.uploadPayload(id, f.blob, f.name);
        } catch (err) {
          onError(`the letter is delivered; ${f.name} could not be attached — ${err instanceof Error ? err.message : "the house declined"}`);
        }
      }

      setBody("");
      setSubject("");
      setFiles([]);
      onDelivered();
    } catch (err) {
      onError(err instanceof Error ? err.message : "the letter was not delivered");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="letter compose">
      <div className="compose-fields">
        <label className="compose-field">
          <span className="compose-label">To</span>
          <input value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label className="compose-field">
          <span className="compose-label">Subject</span>
          <input
            value={sealed ? "" : subject}
            onChange={(e) => setSubject(e.target.value)}
            disabled={sealed}
            placeholder={sealed ? "taken from the letter's first line" : ""}
          />
        </label>
        {sealed && (
          <p className="compose-hint">
            A sealed letter carries no envelope subject — its first line becomes the title.
          </p>
        )}
        <div className="compose-row">
          <label className="compose-field">
            <span className="compose-label">Thread</span>
            <input
              value={thread}
              onChange={(e) => setThread(e.target.value)}
              placeholder="th_… (blank = new)"
            />
          </label>
          <label className="compose-field">
            <span className="compose-label">Frames</span>
            <input
              value={frame}
              onChange={(e) => setFrame(e.target.value)}
              placeholder="season:autumn, production:tempest"
            />
          </label>
        </div>
        <div className="compose-row">
          <label className="compose-field">
            <span className="compose-label">Kind</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="letter">letter</option>
              <option value="audio">audio</option>
              <option value="note">note</option>
              <option value="task">task</option>
            </select>
          </label>
          <label className="compose-field">
            <span className="compose-label">Enclosures</span>
            <input
              ref={fileInput}
              type="file"
              multiple
              disabled={sealed}
              onChange={(e) => addFiles(e.target.files)}
            />
          </label>
        </div>
        {sealed && (
          <p className="compose-hint">
            A sealed letter carries the text alone — the house cannot serve what it cannot open.
          </p>
        )}
        {/* The seal — a per-letter choice, not a default (SPEC §15).
            Quiet, factual, no red: the tradeoff is stated, the resident
            decides. Sealed = not indexed, not whispered, not
            semantically connected. */}
        <label className="seal-toggle">
          <input
            type="checkbox"
            checked={sealed}
            onChange={(e) => {
              setSealed(e.target.checked);
              if (!e.target.checked) setWithHouse(false);
            }}
          />
          <span>Seal this letter — only {to.trim() || "the recipient"} and I can read it; the house holds it without reading</span>
        </label>
        {/* Seal WITH the house (SPEC §15, second model): house@house
            joins the recipients — a collaborative letter the house
            holds a key to. The house opens it in memory only, exactly
            as the design says. Available only when the house has a
            provisioned key; absent = a door the house left unopened. */}
        {sealed && houseRecipient && houseAddress && (
          <label className="seal-toggle">
            <input
              type="checkbox"
              checked={withHouse}
              onChange={(e) => setWithHouse(e.target.checked)}
            />
            <span>Let the house hold a copy — the house can read this one with you</span>
          </label>
        )}
        <WhyNote summary="what the seal does">
          A sealed letter is the in-common kept nothing-in-common: the
          house holds the letter, carries it, delivers it — and never
          reads it. The seal makes the sharing the circulation, not the
          content (Nancy). It is also the quiet room: sealed letters are
          not indexed, not searched, not whispered — the house holds them
          shut and the archive remembers them without knowing them. The
          trade is stated plainly, and the resident decides.
        </WhyNote>
        {kind === "audio" && body.trim().length === 0 && (
          <p className="compose-hint">An audio letter — the recording is the letter.</p>
        )}
        {files.length > 0 && !sealed && (
          <div className="attach-list">
            {files.map((f) => (
              <span key={f.name} className="attach-chip">
                {f.name}
                <button
                  type="button"
                  className="attach-remove"
                  aria-label={`remove ${f.name}`}
                  onClick={() => setFiles((prev) => prev.filter((p) => p.name !== f.name))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
      <label className="compose-field compose-body">
        <span className="compose-label">Letter</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={kind === "audio" ? "Optional note; the recording travels with the letter…" : "Write a letter…"}
          rows={12}
        />
      </label>
      <div className="compose-actions">
        <button className="primary" onClick={send} disabled={!canSend || sealing}>
          {sealing ? "Sealing…" : sending ? "Posting…" : "Post the letter"}
        </button>
      </div>
    </div>
  );
}
