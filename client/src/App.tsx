import { useCallback, useEffect, useState } from "react";
import { house, loadAuth, saveAuth, clearAuth } from "./api";
import { readOidcReturn } from "./oidcReturn";
import type { HouseMeta, Whisper } from "./api";
import Login from "./Login";
import GuestShell from "./GuestShell";
import WhisperSidebar from "./WhisperSidebar";
import Mailbox from "./Mailbox";
import Archive from "./Archive";
import AddressBook from "./AddressBook";
import Compose from "./Compose";
import Pub from "./Pub";
import ThreadView from "./ThreadView";
import Book from "./Book";
import Profile from "./Profile";
import Day from "./Day";

type View = "mailbox" | "archive" | "addresses" | "compose" | "pub" | "thread" | "book" | "profile" | "day";

export default function App() {
  const [auth, setAuth] = useState(() => loadAuth());
  const [guest, setGuest] = useState(false);
  const [view, setView] = useState<View>("mailbox");
  const [whispers, setWhispers] = useState<Whisper[]>([]);
  /** The house's own words — the serif voice's names for the rooms. */
  const [meta, setMeta] = useState<HouseMeta | null>(null);
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
  // A cited clause lands in the book with that clause open — the
  // household's knowing of itself, held in view.
  const [bookClause, setBookClause] = useState<string | null>(null);

  const refreshWhisper = useCallback(async () => {
    try {
      const res = await house.whisper();
      setWhispers(res.whispers);
    } catch (err) {
      setError(err instanceof Error ? err.message : "the house is quiet");
    }
  }, []);

  // The OIDC door returns here with the outcome in the URL fragment. Read it
  // once, clear it (a bearer token does not linger in the address bar), and
  // either sign the resident in or show the door's calm error.
  useEffect(() => {
    const ret = readOidcReturn(window.location.hash);
    if (!ret) return;
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    if (ret.error) {
      setError(ret.error);
      return;
    }
    if (ret.token && ret.address) {
      const header = `Bearer ${ret.token}`;
      saveAuth({ address: ret.address, header });
      setAuth({ address: ret.address, header });
    }
  }, []);

  useEffect(() => {
    if (auth) {
      refreshWhisper();
      house
        .houseMeta()
        .then(setMeta)
        .catch(() => setMeta(null));
    }
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
    setBookClause(null);
    setReturnTo("mailbox");
    setView(v);
  }, []);

  const signOut = useCallback(() => {
    clearAuth();
    setAuth(null);
    setGuest(false);
    setWhispers([]);
    setMeta(null);
    setError(null);
    setView("mailbox");
  }, []);

  /** The resident relabelled — handle changed, identity stayed. The
   *  credential died with the old handle; sign in under the new label. */
  const relabeled = useCallback(() => {
    setMeta(null);
    setAuth(null);
    setGuest(false);
    setWhispers([]);
    setError(null);
    setView("mailbox");
  }, []);

  /** The resident changed their password — the credential changed with
   *  the secret. The saved Basic header is dead; sign in under the new
   *  one. Same path as relabel: the house holds the history, the
   *  resident returns by the door they just turned. */
  const passwordChanged = useCallback(() => {
    clearAuth();
    setAuth(null);
    setGuest(false);
    setWhispers([]);
    setError(null);
    setView("mailbox");
  }, []);

  // A dead credential is keyless: the house answered 401 somewhere, the
  // stored session was cleared, and the resident surface must not stand
  // where the door should be. Return to Login (the same path as leave).
  useEffect(() => {
    const onSignout = () => signOut();
    globalThis.addEventListener("poste-restante:signout", onSignout);
    return () => globalThis.removeEventListener("poste-restante:signout", onSignout);
  }, [signOut]);

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
        title={meta?.whisperName}
        onOpen={open}
        onDismiss={dismiss}
        onUndismiss={undismiss}
        onGaps={async () => {
          await house.detectGaps();
          refreshWhisper();
        }}
        onWriteBack={writeBack}
        onCite={(w) => {
          if (!w.citedClause) return;
          setBookClause(w.citedClause);
          setError(null);
          setView("book");
        }}
      />
      <main className="space">
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button onClick={() => setError(null)} aria-label="dismiss">×</button>
          </div>
        )}
        <header>
          <h1>{meta?.houseName ?? "Poste Restante"}</h1>
          <span className="address">{auth.address}</span>
          <button className="signout" onClick={signOut} aria-label="sign out">
            leave
          </button>
        </header>
        <nav className="nav">
          <button className={view === "mailbox" ? "active" : ""} onClick={() => navigate("mailbox")}>
            {meta?.mailboxName ?? "the mailbox"}
          </button>
          <button className={view === "day" ? "active" : ""} onClick={() => navigate("day")}>
            {meta?.dayName ?? "the day"}
          </button>
          <button className={view === "archive" ? "active" : ""} onClick={() => navigate("archive")}>
            {meta?.archiveName ?? "the archive"}
          </button>
          <button className={view === "pub" ? "active" : ""} onClick={() => navigate("pub")}>
            {meta?.pubName ?? "the pub"}
          </button>
          <button className={view === "book" ? "active" : ""} onClick={() => navigate("book")}>
            {meta?.bookName ?? "the book"}
          </button>
          <button className={view === "addresses" ? "active" : ""} onClick={() => navigate("addresses")}>
            {meta?.addressesName ?? "the address book"}
          </button>
          <button className={view === "profile" ? "active" : ""} onClick={() => navigate("profile")}>
            {meta?.profileName ?? "your record"}
          </button>
          <button className={view === "compose" ? "active" : ""} onClick={() => navigate("compose")}>
            {meta?.writeName ?? "the writing desk"}
          </button>
        </nav>
        {view === "mailbox" && <Mailbox onError={setError} address={auth.address} />}
        {view === "day" && (
          <Day
            name={meta?.dayName}
            onError={setError}
            onOpenThread={(thread) => {
              setThreadId(thread);
              setError(null);
              setView("thread");
            }}
            onOpenWhisper={(id, targetThread) => {
              // Picking up an offer: mark it opened, land on the
              // correspondence it points at (the whisper stays where the
              // house's voice is heard; the board shows where the work is).
              void (async () => {
                try {
                  await house.openWhisper(id);
                  refreshWhisper();
                } catch {
                  // The offer is still visible; opening it is a quiet act.
                }
              })();
              if (targetThread) {
                setThreadId(targetThread);
                setError(null);
                setView("thread");
              }
            }}
          />
        )}
        {view === "archive" && <Archive onError={setError} initialFrame={frameId} onWhisperRefresh={refreshWhisper} />}
        {view === "pub" && (
          <Pub
            name={meta?.pubName}
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
        {view === "book" && <Book name={meta?.bookName} onError={setError} initialClause={bookClause} />}
        {view === "addresses" && <AddressBook onError={setError} onCompose={composeToAddress} />}
        {view === "profile" && (
          <Profile
            name={meta?.profileName}
            onError={setError}
            address={auth.address}
            onRelabeled={relabeled}
            onPasswordChanged={passwordChanged}
          />
        )}
        {view === "thread" && threadId && (
          <ThreadView
            threadId={threadId}
            onError={setError}
            onWhisperRefresh={refreshWhisper}
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
