import { readFile } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { initializeTestEnvironment, assertFails } from '@firebase/rules-unit-testing';
import { collection, doc, getDoc, getDocs, setDoc, updateDoc, writeBatch, serverTimestamp } from 'firebase/firestore';
import { createActivity, startTimer, stopTimer } from '../web/cloud.ts';

let env;
before(async () => {
  env = await initializeTestEnvironment({projectId: 'demo-timer-sync', firestore: {
    host: '127.0.0.1', port: 8085, rules: await readFile('firestore.rules', 'utf8'),
  }});
});
beforeEach(async () => env.clearFirestore());
after(async () => env?.cleanup());
const client = (uid = 'alice') => env.authenticatedContext(uid).firestore();
const state = db => doc(db, 'users/alice/state/timer');
const session = (db, id) => doc(db, 'users/alice/sessions', id);
async function seed(db) {
  await createActivity(db, 'alice', 'Work', '#35705a', 'work');
  await createActivity(db, 'alice', 'Read', '#7376ad', 'read');
}

test('start on one device, stop on another, with shared server timestamps', async () => {
  const phone = client(), web = client(); await seed(phone);
  const id = await startTimer(phone, 'alice', 'work', null, 'A focused session');
  const seen = await getDoc(session(web, id));
  assert.equal(seen.data().name, 'Work'); assert.ok(seen.data().startedAt.toMillis() > 0);
  await stopTimer(web, 'alice', id);
  const stopped = (await getDoc(session(phone, id))).data();
  assert.ok(stopped.endedAt.toMillis() >= stopped.startedAt.toMillis());
  assert.equal((await getDoc(state(phone))).data().activeSessionId, null);
});
test('switch closes the previous timer and starts the next at the same instant', async () => {
  const db = client(); await seed(db);
  const first = await startTimer(db, 'alice', 'work', null);
  const next = await startTimer(db, 'alice', 'read', first);
  assert.equal((await getDoc(session(db, first))).data().endedAt.toMillis(), (await getDoc(session(db, next))).data().startedAt.toMillis());
});
test('duplicate starts produce a single session', async () => {
  const a = client(), b = client(); await seed(a);
  const ids = await Promise.all([startTimer(a, 'alice', 'work', null), startTimer(b, 'alice', 'work', null)]);
  assert.equal(ids[0], ids[1]); assert.equal((await getDocs(collection(a, 'users/alice/sessions'))).size, 1);
});
test('competing different starts cannot silently replace each other', async () => {
  const a = client(), b = client(); await seed(a);
  const result = await Promise.allSettled([startTimer(a, 'alice', 'work', null), startTimer(b, 'alice', 'read', null)]);
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await getDocs(collection(a, 'users/alice/sessions'))).size, 1);
});
test('late or repeated stop never stops the next session', async () => {
  const db = client(); await seed(db);
  const first = await startTimer(db, 'alice', 'work', null);
  const next = await startTimer(db, 'alice', 'read', first);
  await stopTimer(db, 'alice', first); await stopTimer(db, 'alice', first);
  assert.equal((await getDoc(state(db))).data().activeSessionId, next);
  assert.equal((await getDoc(session(db, next))).data().endedAt, null);
});
test('retrying an already completed request does not resurrect it', async () => {
  const db = client(); await seed(db);
  const first = await startTimer(db, 'alice', 'work', null, '', 'request-1');
  await stopTimer(db, 'alice', first);
  await startTimer(db, 'alice', 'work', null, '', 'request-1');
  assert.equal((await getDoc(state(db))).data().activeSessionId, null);
  assert.equal((await getDocs(collection(db, 'users/alice/sessions'))).size, 1);
});
test('another account and signed-out clients cannot read or write private data', async () => {
  const a = client(); await seed(a); const id = await startTimer(a, 'alice', 'work', null);
  for (const db of [client('bob'), env.unauthenticatedContext().firestore()]) {
    await assertFails(getDoc(session(db, id)));
    await assertFails(getDocs(collection(db, 'users/alice/activities')));
    await assertFails(updateDoc(session(db, id), {endedAt: serverTimestamp()}));
  }
});
test('rules deny stopping a session without clearing the shared active state', async () => {
  const db = client(); await seed(db); const id = await startTimer(db, 'alice', 'work', null);
  await assertFails(updateDoc(session(db, id), {endedAt: serverTimestamp()}));
});
test('rules deny clearing active state without stopping its session', async () => {
  const db = client(); await seed(db); await startTimer(db, 'alice', 'work', null);
  await assertFails(setDoc(state(db), {activeSessionId: null, revision: 2, updatedAt: serverTimestamp()}));
});
test('rules deny fabricated history and changes to completed sessions', async () => {
  const db = client(); await seed(db); const id = await startTimer(db, 'alice', 'work', null); await stopTimer(db, 'alice', id);
  await assertFails(updateDoc(session(db, id), {name: 'Forged'}));
  await assertFails(updateDoc(session(db, id), {endedAt: serverTimestamp()}));
  await assertFails(setDoc(session(db, 'fake'), {activityId:'work', name:'Work', color:'#35705a', comment:'', startedAt:serverTimestamp(), endedAt:null}));
});
test('rules deny invalid activity input and extra fields', async () => {
  const db = client();
  await assertFails(setDoc(doc(db, 'users/alice/activities/bad'), {name:'', color:'#35705a', createdAt:serverTimestamp()}));
  await assertFails(setDoc(doc(db, 'users/alice/activities/bad'), {name:'Work', color:'red', createdAt:serverTimestamp()}));
  await assertFails(setDoc(doc(db, 'users/alice/activities/bad'), {name:'Work', color:'#35705a', createdAt:serverTimestamp(), owner:'bob'}));
});
test('rules deny a second running session without closing the first', async () => {
  const db = client(); await seed(db); await startTimer(db, 'alice', 'work', null);
  const batch = writeBatch(db);
  batch.set(session(db, 'second'), {activityId:'read', name:'Read', color:'#7376ad', comment:'', startedAt:serverTimestamp(), endedAt:null});
  batch.set(state(db), {activeSessionId:'second', revision:2, updatedAt:serverTimestamp()});
  await assertFails(batch.commit());
});
