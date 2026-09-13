import { useCallback, useEffect, useState } from "react";
import { Route, Switch, useLocation } from "wouter";
import { house, loadAuth, saveAuth, clearAuth } from "./api";
import { readOidcReturn, planOidcReturn } from "./utils/oidcReturn";
import type { HouseMeta, Whisper } from "./api";
import Login from "./views/Login";
import GuestShell from "./views/GuestShell";
import WhisperSidebar from "./components/WhisperSidebar";
import Mailbox from "./views/Mailbox";
import Archive from "./views/Archive";
import AddressBook from "./views/AddressBook";
import Compose from "./views/Compose";
import Pub from "./views/Pub";
import ThreadView from "./views/ThreadView";
import Book from "./views/Book";
import Profile from "./views/Profile";
import Day from "./views/Day";

export default function App() {
  const [auth, setAuth] = useState(() => loadAuth());
  const [guest, setGuest] = useState(false);
  const [whispers, setWhispers] = useState<Whisper[]>([]);
  const [meta, setMeta] = useState<HouseMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  const [location, setLocation] = useLocation();


  const refreshWhisper = useCallback(async () => {
    try {
      const res = await house.whisper();
      setWhispers(res.whispers);
    } catch (err) {
      setError(err instanceof Error ? err.message : "the house is quiet");
    }
  }, []);

  useEffect(() => {
    const plan = planOidcReturn(readOidcReturn(window.location.hash));
    if (plan.action === "none") return;
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    if (plan.action === "error") {
      setError(plan.message);
      return;
    }
    saveAuth({ address: plan.address, header: plan.header });
    setAuth({ address: plan.address, header: plan.header });
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

  // Clear error on navigation
  useEffect(() => {
    setError(null);
  }, [location]);

  const dismiss = useCallback(
    async (id: string) => {
      await house.dismissWhisper(id);
      refreshWhisper();
    },
    [refreshWhisper],
  );

  const open = useCallback(
    async (id: string, w?: Whisper) => {
      await house.openWhisper(id);
      refreshWhisper();
      if (w?.targetFrame) {
        setLocation(`/archive?frame=${encodeURIComponent(w.targetFrame)}`);
      } else if (w?.targetThread) {
        setLocation(`/thread/${encodeURIComponent(w.targetThread)}?from=sidebar`);
      }
    },
    [refreshWhisper, setLocation],
  );

  const writeBack = useCallback(
    (w: Whisper) => {
      setLocation(`/compose?to=you@house&thread=${encodeURIComponent(w.targetThread ?? "")}`);
    },
    [setLocation],
  );

  const composeToAddress = useCallback((address: string) => {
    setLocation(`/compose?to=${encodeURIComponent(address)}`);
  }, [setLocation]);

  const signOut = useCallback(() => {
    clearAuth();
    setAuth(null);
    setGuest(false);
    setWhispers([]);
    setMeta(null);
    setError(null);
    setLocation("/");
  }, [setLocation]);

  const relabeled = useCallback(() => {
    setMeta(null);
    setAuth(null);
    setGuest(false);
    setWhispers([]);
    setError(null);
    setLocation("/");
  }, [setLocation]);

  const passwordChanged = useCallback(() => {
    clearAuth();
    setAuth(null);
    setGuest(false);
    setWhispers([]);
    setError(null);
    setLocation("/");
  }, [setLocation]);

  useEffect(() => {
    const onSignout = () => signOut();
    globalThis.addEventListener("poste-restante:signout", onSignout);
    return () => globalThis.removeEventListener("poste-restante:signout", onSignout);
  }, [signOut]);

  if (!auth) {
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

  // Helper for active link styles
  const activeClass = (path: string) => location === path || location.startsWith(path + '/') ? "active" : "";
  // Special case for root (mailbox)
  const rootActiveClass = location === "/" ? "active" : "";

  return (
    <div className="house">
      <WhisperSidebar
        whispers={whispers}
        title={meta?.whisperName}
        onOpen={open}
        onDismiss={dismiss}
        onGaps={async () => {
          await house.detectGaps();
          refreshWhisper();
        }}
        onWriteBack={writeBack}
        onCite={(w) => {
          if (!w.citedClause) return;
          setLocation(`/book?clause=${encodeURIComponent(w.citedClause)}`);
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
          <button className={rootActiveClass} onClick={() => setLocation("/")}>
            {meta?.mailboxName ?? "the mailbox"}
          </button>
          <button className={activeClass("/day")} onClick={() => setLocation("/day")}>
            {meta?.dayName ?? "the day"}
          </button>
          <button className={activeClass("/archive")} onClick={() => setLocation("/archive")}>
            {meta?.archiveName ?? "the archive"}
          </button>
          <button className={activeClass("/pub")} onClick={() => setLocation("/pub")}>
            {meta?.pubName ?? "the pub"}
          </button>
          <button className={activeClass("/book")} onClick={() => setLocation("/book")}>
            {meta?.bookName ?? "the book"}
          </button>
          <button className={activeClass("/addresses")} onClick={() => setLocation("/addresses")}>
            {meta?.addressesName ?? "the address book"}
          </button>
          <button className={activeClass("/compose")} onClick={() => setLocation("/compose")}>
            {meta?.writeName ?? "the writing desk"}
          </button>
          <button className={activeClass("/profile")} onClick={() => setLocation("/profile")}>
            {meta?.profileName ?? "your record"}
          </button>
        </nav>
        
        <Switch>
          <Route path="/">
            <Mailbox onError={setError} address={auth.address} />
          </Route>
          <Route path="/day">
            <Day
              name={meta?.dayName}
              onError={setError}
              address={auth.address}
              onOpenThread={(thread) => setLocation(`/thread/${encodeURIComponent(thread)}?from=day`)}
              onOpenWhisper={(id, targetThread) => {
                void house.openWhisper(id).then(refreshWhisper).catch(() => {});
                if (targetThread) {
                  setLocation(`/thread/${encodeURIComponent(targetThread)}?from=day`);
                }
              }}
            />
          </Route>
          <Route path="/archive">
            {/* The query string parsed dynamically inside Archive via URLSearchParams */}
            {() => {
               const frameId = new URLSearchParams(window.location.search).get("frame");
               return <Archive onError={setError} initialFrame={frameId} onWhisperRefresh={refreshWhisper} />;
            }}
          </Route>
          <Route path="/pub">
            <Pub
              name={meta?.pubName}
              onError={setError}
              onReply={(thread) => setLocation(`/compose?to=pub@house&thread=${encodeURIComponent(thread)}&returnTo=pub`)}
              onPost={() => setLocation(`/compose?to=pub@house&returnTo=pub`)}
            />
          </Route>
          <Route path="/book">
            {() => {
              const clause = new URLSearchParams(window.location.search).get("clause");
              return <Book name={meta?.bookName} onError={setError} initialClause={clause} address={auth.address} />;
            }}
          </Route>
          <Route path="/addresses">
            <AddressBook onError={setError} onCompose={composeToAddress} />
          </Route>
          <Route path="/profile">
            <Profile
              name={meta?.profileName}
              onError={setError}
              address={auth.address}
              onRelabeled={relabeled}
              onPasswordChanged={passwordChanged}
            />
          </Route>
          <Route path="/compose">
            {() => {
              const search = new URLSearchParams(window.location.search);
              return (
                <Compose
                  onError={setError}
                  onDelivered={() => {
                    refreshWhisper();
                    const returnTo = search.get("returnTo");
                    setLocation(returnTo === "pub" ? "/pub" : "/");
                  }}
                  initialTo={search.get("to") || undefined}
                  initialThread={search.get("thread") || undefined}
                  from={auth.address}
                />
              );
            }}
          </Route>
          <Route path="/thread/:id">
            {params => {
              const from = new URLSearchParams(window.location.search).get("from");
              const backPath = from === "day" ? "/day" : from === "pub" ? "/pub" : "/";
              return (
                <ThreadView
                  threadId={decodeURIComponent(params.id)}
                  onError={setError}
                  onWhisperRefresh={refreshWhisper}
                  onBack={() => setLocation(backPath)}
                />
              );
            }}
          </Route>
        </Switch>
      </main>
    </div>
  );
}
