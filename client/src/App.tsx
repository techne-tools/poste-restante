import { useCallback, useEffect, useState } from "react";
import { house, loadAuth, clearAuth } from "./api";
import type { Whisper } from "./api";
import Login from "./Login";
import GuestShell from "./GuestShell";
import WhisperSidebar from "./WhisperSidebar";
import Mailbox from "./Mailbox";
import Archive from "./Archive";
import AddressBook from "./AddressBook";
import Compose from "./Compose";
import Pub from "./Pub";
import ThreadView from "./ThreadView";

type View = "mailbox" | "archive" | "addresses" | "compose" | "pub" | "thread";

export default function App() {
  const [auth, setAuth] = useState(() => loadAuth());
  const [guest, setGuest] = useState(false);
  const [view, setView] = useState<View>("mailbox");
  const [whispers, setWhispers] = useState<Whisper[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [composeTo, setComposeTo] = useState<string | undefined>(undefined);
  const [composeThread, setComposeThread] = useState<string | undefined>(undefined);
  const [threadId, setThreadId] = useState<string | undefined>(undefined);
  /** Where the compose view returns after a letter is delivered — the
   *  mailbox by default, the pub when the resident was writing there. */
  const [returnTo, setReturnTo] = useState<"mailbox" | "pub">("mailbox");
  // A frame-scoped gap (unvisited corner) lands in the archive with that
  // frame open — the empty room, held in view.
  const [frameId, setFrameId] = useState<string | null>(null);

  const refreshWhisper = useCallback(async () => {
    try {
      const res = await house.whisper();
      setWhispers(res.whispers);
    } catch (err) {
      setError(err instanceof Error ? err.message : "the house is quiet");
    }
  }, []);

  useEffect(() => {
    if (auth) refreshWhisper();
  }, [auth, refreshWhisper]);

  const dismiss = useCallback(
    async (id: string) => {
      await house.dismissWhisper(id);
      refreshWhisper();
    },
    [refreshWhisper],
  );

  const undismiss = useCallback(
    async (id: string) => {
      await house.undismissWhisper(id);
      refreshWhisper();
    },
    [refreshWhisper],
  );

  const open = useCallback(
    async (id: string, w?: Whisper) => {
      await house.openWhisper(id);
      refreshWhisper();
      // Picking up a gap offer lands on the correspondence itself — the
      // thread is the unit, not the message. A corner offer lands on the
      // room: the archive, that frame open. The whisper stays in the
      // sidebar: pick up or ignore, the house holds either way.
      if (w?.targetFrame) {
        setFrameId(w.targetFrame);
        setError(null);
        setView("archive");
      } else if (w?.targetThread) {
        setThreadId(w.targetThread);
        setError(null);
        setView("thread");
      }
    },
    [refreshWhisper],
  );

  const writeBack = useCallback(
    (w: Whisper) => {
      // The correction is a letter; the reply is a letter. Address it to the
      // house, on the whisper's thread — the strongest signal.
      setComposeTo("you@house");
      setComposeThread(w.targetThread ?? undefined);
      setError(null);
      setView("compose");
    },
    [],
  );

  const composeToAddress = useCallback((address: string) => {
    setComposeTo(address);
    setComposeThread(undefined);
    setError(null);
    setView("compose");
  }, []);

  // The error banner is view-scoped feedback, not app-global state — a
  // failure in one view must not follow the user into the next. Navigation
  // also clears any corner offer flag: the room stays open only while the
  // resident stands in it.
  const navigate = useCallback((v: View) => {
    setError(null);
    setFrameId(null);
    setReturnTo("mailbox");
    setView(v);
  }, []);

  const signOut = useCallback(() => {
    clearAuth();
    setAuth(null);
    setGuest(false);
    setWhispers([]);
    setError(null);
    setView("mailbox");
  }, []);

  if (!auth) {
    // The keyless door: a guest enters the pub without a credential — the
    // only room that asks nothing. Nothing private is mounted; the pub's
    // own fetch is the only call the shell makes.
    if (guest) {
      return <GuestShell onEnterHouse={() => setGuest(false)} />;
    }
    return (
      <Login
        onAuthed={() => setAuth(loadAuth())}
        onGuest={() => setGuest(true)}
      />
    );
  }

  return (
    <div className="house">
      <WhisperSidebar
        whispers={whispers}
        onOpen={open}
        onDismiss={dismiss}
        onUndismiss={undismiss}
        onGaps={async () => {
          await house.detectGaps();
          refreshWhisper();
        }}
        onWriteBack={writeBack}
      />
      <main className="space">
        {error && (
          <div className="error-banner">
            <span>{error}</span>
            <button onClick={() => setError(null)} aria-label="dismiss">×</button>
          </div>
        )}
        <header>
          <h1>Poste Restante</h1>
          <span className="address">{auth.address}</span>
          <button className="signout" onClick={signOut} aria-label="sign out">
            leave
          </button>
        </header>
        <nav className="nav">
          <button className={view === "mailbox" ? "active" : ""} onClick={() => navigate("mailbox")}>
            Mailbox
          </button>
          <button className={view === "archive" ? "active" : ""} onClick={() => navigate("archive")}>
            Archive
          </button>
          <button className={view === "pub" ? "active" : ""} onClick={() => navigate("pub")}>
            Pub
          </button>
          <button className={view === "addresses" ? "active" : ""} onClick={() => navigate("addresses")}>
            Addresses
          </button>
          <button className={view === "compose" ? "active" : ""} onClick={() => navigate("compose")}>
            Write
          </button>
        </nav>
        {view === "mailbox" && <Mailbox onError={setError} address={auth.address} />}
        {view === "archive" && <Archive onError={setError} initialFrame={frameId} />}
        {view === "pub" && (
          <Pub
            onError={setError}
            onReply={(thread) => {
              setComposeTo("pub@house");
              setComposeThread(thread);
              setReturnTo("pub");
              setError(null);
              setView("compose");
            }}
            onPost={() => {
              setComposeTo("pub@house");
              setComposeThread(undefined);
              setReturnTo("pub");
              setError(null);
              setView("compose");
            }}
          />
        )}
        {view === "addresses" && <AddressBook onError={setError} onCompose={composeToAddress} />}
        {view === "thread" && threadId && (
          <ThreadView
            threadId={threadId}
            onError={setError}
            onBack={() => {
              setThreadId(undefined);
              setView("mailbox");
            }}
          />
        )}
        {view === "compose" && (
          <Compose
            onError={setError}
            onDelivered={() => {
              // A letter on a whispered thread is the strongest signal —
              // the house marks the whisper replied, and the sidebar shows it.
              // Writing from the pub returns to the pub.
              refreshWhisper();
              setView(returnTo);
            }}
            initialTo={composeTo}
            initialThread={composeThread}
            from={auth.address}
          />
        )}
      </main>
    </div>
  );
}
