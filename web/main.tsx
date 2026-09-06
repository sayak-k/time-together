import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createUserWithEmailAndPassword, onAuthStateChanged, sendPasswordResetEmail, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import type { User } from 'firebase/auth';
import { collection, doc, getDocsFromServer, limit, onSnapshot, orderBy, query } from 'firebase/firestore';
import type { Timestamp } from 'firebase/firestore';
import { auth, db, configured } from './firebase';
import { createActivity, startTimer, stopTimer } from './cloud';
import './style.css';

type Activity = {id: string; name: string; color: string};
type Session = Activity & {activityId: string; comment: string; startedAt: Timestamp | null; endedAt: Timestamp | null};
const colours = ['#35705a', '#d18453', '#7376ad', '#5189a6', '#b36480', '#8a8051'];
function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
}
function friendly(error: unknown) {
  const e = error as {code?: string; message?: string};
  if (['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found'].includes(e.code ?? '')) return 'The email or password is incorrect.';
  if (e.code === 'auth/email-already-in-use') return 'An account with this email already exists. Sign in instead.';
  if (e.code === 'auth/weak-password') return 'Choose a password with at least 8 characters.';
  if (e.code === 'permission-denied') return 'Access was denied. Check that you are signed in and the database rules are deployed.';
  if (e.code === 'unavailable' || e.code === 'auth/network-request-failed') return 'Could not connect. Check your connection and try again.';
  return e.message ?? 'Something went wrong. Please try again.';
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(configured);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState({activities: false, sessions: false, state: false});
  const [online, setOnline] = useState(navigator.onLine);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [register, setRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [color, setColor] = useState(colours[0]);
  const [note, setNote] = useState('');
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!auth) return;
    return onAuthStateChanged(auth, next => {setUser(next); setLoading(false); setPassword('');});
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => {clearInterval(timer); window.removeEventListener('online', on); window.removeEventListener('offline', off);};
  }, []);
  useEffect(() => {
    setActivities([]); setSessions([]); setActiveId(null);
    setConfirmed({activities: false, sessions: false, state: false});
    if (!user || !db) return;
    const fail = (e: unknown) => {setError(friendly(e)); setConfirmed({activities: false, sessions: false, state: false});};
    const unsub = [
      onSnapshot(query(collection(db, 'users', user.uid, 'activities'), orderBy('createdAt')), {includeMetadataChanges: true}, snap => {
        setActivities(snap.docs.map(d => ({...d.data(), id: d.id} as Activity)));
        setConfirmed(c => ({...c, activities: !snap.metadata.fromCache}));
      }, fail),
      onSnapshot(query(collection(db, 'users', user.uid, 'sessions'), orderBy('startedAt', 'desc'), limit(100)), {includeMetadataChanges: true}, snap => {
        setSessions(snap.docs.map(d => ({...d.data(), id: d.id} as Session)));
        setConfirmed(c => ({...c, sessions: !snap.metadata.fromCache}));
      }, fail),
      onSnapshot(doc(db, 'users', user.uid, 'state', 'timer'), {includeMetadataChanges: true}, snap => {
        setActiveId(snap.data()?.activeSessionId ?? null);
        setConfirmed(c => ({...c, state: !snap.metadata.fromCache}));
      }, fail),
    ];
    return () => unsub.forEach(fn => fn());
  }, [user]);

  async function perform(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {await action();} catch (e) {setError(friendly(e));} finally {setBusy(false);}
  }
  const active = sessions.find(s => s.id === activeId);
  const ready = online && Object.values(confirmed).every(Boolean) && (!activeId || Boolean(active?.startedAt));
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const todaySessions = sessions.filter(s => (s.endedAt?.toMillis() ?? now) > today.getTime());
  const todayTotal = todaySessions.reduce((total, s) => total + Math.max(0, (s.endedAt?.toMillis() ?? now) - Math.max(s.startedAt?.toMillis() ?? now, today.getTime())), 0);

  async function exportHistory() {
    if (!db || !user) return;
    const rows = await getDocsFromServer(query(collection(db, 'users', user.uid, 'sessions'), orderBy('startedAt', 'desc')));
    const data = rows.docs.map(d => {const s = d.data(); return {id: d.id, ...s,
      startedAt: s.startedAt?.toDate().toISOString(), endedAt: s.endedAt?.toDate().toISOString() ?? null};});
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'}));
    link.download = 'time-together-history.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  return <div className="shell">
    <header><a className="brand" href="/" aria-label="Time Together home"><span className="brandmark">t.</span> time together<span className="beta">EARLY ACCESS</span></a>
      {user && <div className="account"><span>{user.email}</span><button className="text-button" disabled={busy} onClick={() => perform(() => signOut(auth!))}>Sign out</button></div>}
    </header>
    {!configured ? <main className="welcome"><p className="eyebrow">A LITTLE MORE INTENTION</p><h1>Your time.<br/><em>All together.</em></h1><p>One place for the things you spend your day on.</p><div className="setup"><h2>Your workspace is being prepared</h2><p>Firebase hasn’t been connected yet. Your timers will appear here once setup is complete.</p><span className="status"><i/> Awaiting connection</span></div></main>
    : loading ? <main className="welcome"><p>Opening your workspace…</p></main>
    : !user ? <main className="welcome login-layout"><div><p className="eyebrow">A LITTLE MORE INTENTION</p><h1>Your time.<br/><em>All together.</em></h1><p>Start on your phone. Stop on your laptop.<br/>Make room for what matters.</p><div className="intro-line">One timer · Every device · Your own pace</div></div>
      <form className="login-card" onSubmit={e => {e.preventDefault(); perform(() => register ? createUserWithEmailAndPassword(auth!, email, password) : signInWithEmailAndPassword(auth!, email, password));}}>
        <h2>{register ? 'Make yourself at home' : 'Welcome back'}</h2><p>{register ? 'Create an account to bring your time together.' : 'Sign in to your personal workspace.'}</p>
        <label>Email<input type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)}/></label>
        <label>Password<input type="password" autoComplete={register ? 'new-password' : 'current-password'} minLength={register ? 8 : undefined} required value={password} onChange={e => setPassword(e.target.value)}/></label>
        {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status">{notice}</p>}
        <button className="primary" disabled={busy}>{busy ? 'Connecting…' : register ? 'Create account' : 'Sign in'} <span>↗</span></button>
        <button className="text-button" type="button" disabled={busy} onClick={() => {setRegister(!register); setError('');}}>{register ? 'Already have an account? Sign in' : 'New here? Create an account'}</button>
        {!register && <button className="text-button" type="button" disabled={busy || !email} onClick={() => perform(async () => {await sendPasswordResetEmail(auth!, email); setNotice('If an account exists, a password reset email will arrive shortly.');})}>Forgot password?</button>}
      </form></main>
    : <main>
      <div className="page-heading"><div><p className="eyebrow">{new Date(now).toLocaleDateString(undefined, {weekday: 'long', day: 'numeric', month: 'long'})}</p><h1>Make time <em>for today.</em></h1></div><span className={`status ${ready ? 'connected' : ''}`}><i/>{ready ? 'Connected across devices' : online ? 'Connecting…' : 'Offline · controls paused'}</span></div>
      {error && <div className="error banner" role="alert">{error}<button className="text-button" onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
      <section className="timer-panel" aria-label="Current timer"><div><p className="eyebrow">{active ? 'IN THE MOMENT' : 'A FRESH MOMENT'}</p><h2>{active?.name ?? 'What are you making time for?'}</h2><p>{active?.comment || (active ? 'A little focus goes a long way.' : 'Choose an activity below to begin.')}</p></div>
        <div className="timer-controls"><div className="clock" aria-label="Elapsed time">{duration(active?.startedAt ? now - active.startedAt.toMillis() : 0)}</div>
          {active && <button className="stop-button" disabled={busy || !ready} onClick={() => perform(() => stopTimer(db!, user.uid, active.id))}><span className="stop-icon"/> Stop timer</button>}
        </div>
      </section>
      <section className="activities-section"><div className="section-title"><div><h2>Your activities</h2><p>One thing at a time. Switch whenever you need.</p></div><button className="outline-button" disabled={!ready || busy} onClick={() => setAdding(!adding)}>{adding ? 'Cancel' : '+ Add activity'}</button></div>
        {adding && <form className="add-form" onSubmit={e => {e.preventDefault(); perform(async () => {await createActivity(db!, user.uid, name, color); setName(''); setAdding(false);});}}><label>Activity name<input value={name} maxLength={80} required placeholder="Reading, work, a walk…" onChange={e => setName(e.target.value)}/></label><fieldset><legend>Colour</legend><div className="swatches">{colours.map(c => <button type="button" key={c} aria-label={`Choose colour ${c}`} aria-pressed={color === c} className={color === c ? 'selected' : ''} style={{background: c}} onClick={() => setColor(c)}/>)}</div></fieldset><button className="primary" disabled={busy || !ready}>Add activity</button></form>}
        {activities.length ? <><label className="note-input">A note for your next session <span>optional</span><input maxLength={2000} placeholder="What are you working on?" value={note} onChange={e => setNote(e.target.value)}/></label><div className="activity-grid">{activities.map(a => <button key={a.id} className={`activity-card ${active?.activityId === a.id ? 'is-active' : ''}`} style={{'--activity': a.color} as React.CSSProperties} disabled={busy || !ready || active?.activityId === a.id} onClick={() => perform(async () => {await startTimer(db!, user.uid, a.id, activeId, note); setNote('');})}><span className="activity-icon">{a.name.slice(0, 1).toUpperCase()}</span><strong>{a.name}</strong><span className="activity-action">{active?.activityId === a.id ? 'In progress' : active ? 'Switch to activity ↗' : 'Start activity ↗'}</span></button>)}</div></>
        : <div className="empty-state"><span>＋</span><h3>A little space for your day</h3><p>Add your first activity, or import activities from the Android app.</p></div>}
      </section>
      <section className="history-section"><div className="section-title"><div><h2>Recently tracked</h2><p>Your latest 100 sessions · Today in this view: {duration(todayTotal)}</p></div><button className="text-button" disabled={busy || !ready} onClick={() => perform(exportHistory)}>Export all history ↓</button></div>
        {sessions.length ? <div className="history-list">{sessions.map(s => <article className="history-row" key={s.id}><span className="history-dot" style={{background: s.color}}/><div className="history-name"><strong>{s.name}</strong>{s.comment && <p>{s.comment}</p>}</div><span className="history-date">{s.startedAt?.toDate().toLocaleString(undefined, {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'}) ?? 'Saving…'}</span><span className="history-duration">{s.endedAt ? duration(s.endedAt.toMillis() - (s.startedAt?.toMillis() ?? 0)) : <span className="live-label">Running</span>}</span></article>)}</div> : <p className="empty-history">Your first session starts a new story.</p>}
      </section>
    </main>}
    <footer><span>Time together</span><span>A little more present, wherever you are.</span></footer>
  </div>;
}
createRoot(document.getElementById('root')!).render(<App/>);
