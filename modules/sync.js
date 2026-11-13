import {change, read, mergeRemote} from './library.js';
import {validEntry} from './core.js';

const config = {
    apiKey: "AIzaSyAgIA0PLvUOJsRN8tHRzC03evTTkt3KHHc",
    authDomain: "skills-tracker-3f21b.firebaseapp.com",
    projectId: "skills-tracker-3f21b",
    storageBucket: "skills-tracker-3f21b.firebasestorage.app",
    messagingSenderId: "108202530564",
    appId: "1:108202530564:web:31ecf70071f49a89abe251"
};
const sdk = 'https://www.gstatic.com/firebasejs/10.7.1/firebase-';
const encoder = new TextEncoder();
let firebaseReady;

async function firebase() {
  firebaseReady ??= (async () => {
    for (const name of ['app', 'auth', 'firestore']) {
      if (typeof window.firebase?.[name === 'app' ? 'initializeApp' : name] === 'function') continue;
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = sdk + name + '-compat.js';
        const timer = setTimeout(() => { script.remove(); reject(new Error('Firebase не загрузился.')); }, 12_000);
        script.onload = () => { clearTimeout(timer); resolve(); };
        script.onerror = () => { clearTimeout(timer); reject(new Error('Firebase не загрузился.')); };
        document.head.append(script);
      });
    }
    const fb = window.firebase.apps.find(app => app.name === 'ai-pult')
      ?? window.firebase.initializeApp(config, 'ai-pult');
    if (!fb.auth().currentUser) await fb.auth().signInAnonymously();
    return fb.firestore();
  })();
  try { return await firebaseReady; }
  catch (error) {
    firebaseReady = undefined;
    throw error;
  }
}

const encode = bytes => btoa(Array.from(bytes, value => String.fromCharCode(value)).join(''));
const decode = text => Uint8Array.from(atob(text), char => char.charCodeAt(0));

export async function cloudIdentity(code) {
  const input = await crypto.subtle.importKey('raw', encoder.encode(code.trim()), 'PBKDF2', false, ['deriveBits', 'deriveKey']);
  const params = salt => ({name: 'PBKDF2', salt: encoder.encode(salt), iterations: 200_000, hash: 'SHA-256'});
  const hash = await crypto.subtle.deriveBits(params('ai-pult/v1/profile'), input, 256);
  const profile = Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
  const key = await crypto.subtle.deriveKey(params('ai-pult/v1/library'), input, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
  return {profile, key};
}

export async function connectSync(code, localProfile, status, refresh, active = () => true) {
  const {profile, key} = await cloudIdentity(code);
  const db = await firebase();
  if (!active()) return;
  const collection = db.collection('apps').doc('ai-pult').collection('users');
  const query = collection.where('profile', '==', profile);
  const ref = id => collection.doc(profile + '_' + id);
  const additionalData = (id, rev) => encoder.encode(profile + '/' + id + '/' + rev);

  async function pack(id, record) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData: additionalData(id, record.rev)}, key,
      encoder.encode(JSON.stringify(record.entry)));
    return {profile, id, rev: record.rev, iv: encode(iv), data: encode(new Uint8Array(data))};
  }

  async function unpack(data) {
    const {id, rev, iv} = data;
    const decoded = await crypto.subtle.decrypt({name: 'AES-GCM', iv: decode(iv), additionalData: additionalData(id, rev)}, key, decode(data.data));
    const entry = JSON.parse(new TextDecoder().decode(decoded));
    if (entry !== null && (!validEntry(entry) || entry.id !== id)) throw new Error('Неверный формат записи.');
    return {rev, entry};
  }

  async function send(id, pending) {
    const normal = await pack(id, pending);
    const conflictId = pending.rev;
    const conflict = pending.entry
      ? {...pending, entry: {...pending.entry, id: conflictId, title: (pending.entry.title.slice(0, 160) + ' (копия)'), conflict: true}}
      : null;
    const copy = conflict ? await pack(conflictId, conflict) : null;
    const result = await db.runTransaction(async tx => {
      const current = await tx.get(ref(id));
      const remote = current.exists ? current.data() : null;
      if (!active()) throw new Error('Синхронизация остановлена.');
      if (remote?.rev === pending.rev) return 'saved';
      if ((remote?.rev ?? null) === pending.base) {
        tx.set(ref(id), normal);
        return 'saved';
      }
      if (copy) {
        const existingCopy = await tx.get(ref(conflictId));
        if (!existingCopy.exists) tx.set(ref(conflictId), copy);
      }
      return 'conflict';
    });

    await change(localProfile, state => {
      const queued = state.queue[id];
      if (queued?.rev === pending.rev) delete state.queue[id];
      else if (queued && result === 'saved' && queued.base === pending.base) queued.base = pending.rev;
    });
    return result;
  }

  let stopped = false;
  let running = false;
  let queued = false;
  let timer;
  let retry;
  let conflicts = false;
  async function synchronize() {
    if (stopped || !active()) return;
    if (running) { queued = true; return; }
    if (!navigator.onLine) { status('Локальная копия · нет сети'); return; }
    running = true;
    status('Синхронизация…');
    try {
      const snapshot = await read(localProfile);
      for (const [id, pending] of Object.entries(snapshot.queue)) {
        if (stopped || !active()) return;
        if (await send(id, pending) === 'conflict') conflicts = true;
      }
      const cloud = await query.get({source: 'server'});
      const remote = Object.fromEntries(await Promise.all(cloud.docs.map(async doc => {
        const data = doc.data();
        if (doc.id !== profile + '_' + data.id) throw new Error('Неверный идентификатор записи.');
        return [data.id, await unpack(data)];
      })));
      if (stopped || !active()) return;
      await change(localProfile, state => mergeRemote(state, remote));
      await refresh();
      status(conflicts ? 'Синхронизировано · проверьте конфликтующие записи' : 'Библиотека синхронизирована');
    } catch {
      if (!stopped && active()) {
        status('Синхронизация недоступна · работаем с локальной копией');
        clearTimeout(retry);
        retry = setTimeout(synchronize, 15_000);
      }
    } finally {
      running = false;
      if (queued) { queued = false; schedule(); }
    }
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(synchronize, 250);
  }

  const unsubscribe = query.onSnapshot({includeMetadataChanges: true}, snapshot => {
    if (!snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites) schedule();
  }, () => status('Синхронизация недоступна · локальная копия'));
  addEventListener('online', schedule);
  addEventListener('offline', schedule);
  schedule();
  return {schedule, close() {
    stopped = true;
    clearTimeout(timer);
    clearTimeout(retry);
    unsubscribe();
    removeEventListener('online', schedule);
    removeEventListener('offline', schedule);
  }};
}
