import { collection, doc, runTransaction, serverTimestamp, updateDoc } from 'firebase/firestore';
import type { Firestore } from 'firebase/firestore';

// Rules that validate both halves of a transition can reject a racing commit
// before Firestore reports ABORTED. Re-read once with the SAME request identity.
async function retryRuleRace<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); } catch (error) {
    if ((error as {code?: string}).code !== 'permission-denied') throw error;
    return action();
  }
}

export async function createActivity(db: Firestore, uid: string, name: string, color: string, id = crypto.randomUUID()) {
  const cleanName = name.trim();
  if (!cleanName || cleanName.length > 80 || !/^#[a-f\d]{6}$/i.test(color)) throw new Error('Enter a name (up to 80 characters) and a colour.');
  const ref = doc(db, 'users', uid, 'activities', id);
  const stateRef = doc(db, 'users', uid, 'state', 'timer');
  // Transactions fail offline; no invisible queued writes in this first version.
  await runTransaction(db, async tx => {
    const existing = await tx.get(ref);
    const state = await tx.get(stateRef);
    if (!existing.exists()) tx.set(ref, {name: cleanName, color, createdAt: serverTimestamp()});
    if (!state.exists()) tx.set(stateRef, {activeSessionId: null, revision: 0, updatedAt: serverTimestamp()});
  });
  return id;
}

export async function renameActivity(db: Firestore, uid: string, activityId: string, name: string) {
  const cleanName = name.trim();
  if (!cleanName || cleanName.length > 80) throw new Error('Enter a name up to 80 characters.');
  await updateDoc(doc(db, 'users', uid, 'activities', activityId), {name: cleanName});
}

export async function deleteActivity(db: Firestore, uid: string, activityId: string) {
  const activityRef = doc(db, 'users', uid, 'activities', activityId);
  const stateRef = doc(db, 'users', uid, 'state', 'timer');
  await runTransaction(db, async tx => {
    const activity = await tx.get(activityRef);
    const state = await tx.get(stateRef);
    if (!activity.exists()) return;
    const activeSessionId: string | null = state.data()?.activeSessionId ?? null;
    if (activeSessionId) {
      const activeSession = await tx.get(doc(db, 'users', uid, 'sessions', activeSessionId));
      if (activeSession.data()?.activityId === activityId) {
        throw new Error('Stop this timer before deleting its activity.');
      }
    }
    tx.delete(activityRef);
  });
}

export async function startTimer(db: Firestore, uid: string, activityId: string, expectedActive: string | null, comment = '', requestId = crypto.randomUUID()) {
  if (comment.length > 2000) throw new Error('Keep the note under 2,000 characters.');
  const stateRef = doc(db, 'users', uid, 'state', 'timer');
  const sessionRef = doc(collection(db, 'users', uid, 'sessions'), requestId);
  return retryRuleRace(() => runTransaction(db, async tx => {
    const state = await tx.get(stateRef);
    const priorRequest = await tx.get(sessionRef);
    // A retry after an uncertain response never starts the same request twice.
    if (priorRequest.exists()) return requestId;
    const currentId: string | null = state.data()?.activeSessionId ?? null;
    const currentRef = currentId ? doc(db, 'users', uid, 'sessions', currentId) : null;
    const current = currentRef ? await tx.get(currentRef) : null;
    if (current?.data()?.activityId === activityId) return currentId!;
    if (currentId !== expectedActive) throw new Error('The timer changed on another device. Review it and try again.');
    const activity = await tx.get(doc(db, 'users', uid, 'activities', activityId));
    if (!activity.exists()) throw new Error('This activity is no longer available.');
    if (currentRef) tx.update(currentRef, {endedAt: serverTimestamp()});
    tx.set(sessionRef, {activityId, name: activity.data().name, color: activity.data().color, comment,
      startedAt: serverTimestamp(), endedAt: null});
    tx.set(stateRef, {activeSessionId: requestId, revision: (state.data()?.revision ?? 0) + 1, updatedAt: serverTimestamp()});
    return requestId;
  }));
}

export async function stopTimer(db: Firestore, uid: string, sessionId: string) {
  const stateRef = doc(db, 'users', uid, 'state', 'timer');
  const sessionRef = doc(db, 'users', uid, 'sessions', sessionId);
  return retryRuleRace(() => runTransaction(db, async tx => {
    const state = await tx.get(stateRef);
    const session = await tx.get(sessionRef);
    // A delayed stop for an old session must never stop a newer timer.
    if (!session.exists() || session.data().endedAt != null) return;
    if (state.data()?.activeSessionId !== sessionId) throw new Error('The active timer changed. Please refresh.');
    tx.update(sessionRef, {endedAt: serverTimestamp()});
    tx.set(stateRef, {activeSessionId: null, revision: state.data()!.revision + 1, updatedAt: serverTimestamp()});
  }));
}
