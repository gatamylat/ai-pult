import {validEntry} from './core.js';

const empty = () => ({library: {}, queue: {}, history: []});
let db;
export async function openStorage() {
  db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('ai-pult-library', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('profiles');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transaction(profile, update) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('profiles', update ? 'readwrite' : 'readonly');
    const store = tx.objectStore('profiles');
    const request = store.get(profile);
    let state;
    request.onsuccess = () => {
      state = request.result ?? empty();
      if (!update) return;
      try {
        update(state);
        store.put(state, profile);
      } catch (error) {
        reject(error);
        tx.abort();
      }
    };
    tx.oncomplete = () => resolve(state);
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('Ошибка локального хранилища.'));
  });
}

export const read = profile => transaction(profile);
export const change = (profile, update) => transaction(profile, update);
export const entries = state => Object.values(state.library).filter(record => record.entry).map(record => record.entry);

export function edit(state, entry, id = entry.id, expectedRevision = state.library[id]?.rev ?? null) {
  if (entry && !validEntry(entry)) throw new Error('Укажите название и текст. Размер записи — до 200 КБ.');
  if (entry && (state.library[id]?.rev ?? null) !== expectedRevision) {
    const copy = {...entry, id: crypto.randomUUID(), title: entry.title.slice(0, 160) + ' (копия)', conflict: true};
    edit(state, copy);
    return true;
  }
  const base = state.queue[id] ? state.queue[id].base : expectedRevision;
  const record = {rev: crypto.randomUUID(), entry};
  state.library[id] = record;
  state.queue[id] = {...record, base};
}

export function mergeRemote(state, remote) {
  for (const [id, record] of Object.entries(remote)) {
    if (!state.queue[id]) state.library[id] = record;
  }
}
