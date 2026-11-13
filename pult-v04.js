import {askModel, buildPrompt, entryTitle, kindNames, runTask, selectSources, textLimit, validEntry} from './modules/core.js?v=6';
import {change, edit, entries, openStorage, read} from './modules/library.js?v=4';
import {cloudIdentity, connectSync} from './modules/sync.js?v=4';
import {renderMarkdown} from './modules/markdown.js';

const $ = id => document.getElementById(id);
const local = 'local';
const keyName = 'ai-pult:model-';
const cloudCodeName = 'ai-pult:library-code';
const modes = {claude: 'Claude', deepseek: 'DeepSeek', together: 'Вместе'};
const keys = () => Object.fromEntries(['claude', 'deepseek'].map(id => [id, localStorage.getItem(keyName + id) || '']));
let profile = local;
let state;
let connection;
let connectionAttempt = 0;
let busy = false;
let selectedSources = [];
let excludedSources = new Set();
let resultTask = '';
let currentThread;
let historyId;
let answerText = '';
let editingId;
let editingRevision;

function setStatus(id, text) { $(id).textContent = text; }

function renderModes() {
  const execute = $('mode').value === 'execute';
  for (const input of document.querySelectorAll('[name="task-mode"]')) {
    input.checked = input.value === $('mode').value;
  }
  const available = keys();
  const select = $('provider');
  for (const option of select.options) {
    const mode = option.value;
    option.disabled = mode === 'together' ? !available.claude || !available.deepseek : !available[mode];
  }
  if (select.selectedIndex === -1 || select.selectedOptions[0].disabled) {
    select.value = available.claude ? 'claude' : available.deepseek ? 'deepseek' : '';
  }
  $('provider-field').hidden = !execute;
  $('run').textContent = !execute ? 'Собрать промпт' : currentThread ? 'Уточнить' : 'Выполнить задачу';
  $('run').disabled = busy || !state || (execute && !select.value);
  $('history-status').hidden = !busy;
  $('history-continue').disabled = busy;
  if (execute && !select.value) setStatus('status', 'Добавьте ключ Claude или DeepSeek в настройках.');
}

const libraryKind = () => document.querySelector('[name="library-kind"]:checked').value;

function renderLibrary() {
  const list = $('library-list');
  list.replaceChildren();
  const items = entries(state).filter(entry => entry.kind === libraryKind())
    .map(entry => ({entry, title: entryTitle(entry)}))
    .sort((a, b) => a.title.localeCompare(b.title, 'ru'));
  if (!items.length) list.textContent = 'В этом разделе пока нет записей.';
  for (const {entry, title} of items) {
    const li = document.createElement('li');
    const open = button(title, () => {
      const current = state.library[entry.id]?.entry;
      if (current) openEditor(current);
    });
    open.dataset.entryId = entry.id;
    li.append(open);
    list.append(li);
  }
}

function button(label, handler) {
  const node = document.createElement('button');
  node.type = 'button';
  node.textContent = label;
  node.addEventListener('click', handler);
  return node;
}

function renderHistory() {
  const list = $('history-list');
  list.replaceChildren();
  if (!state.history.length) list.textContent = 'Здесь появятся выполненные задачи.';
  for (const {id, title} of state.history) {
    const item = document.createElement('li');
    const open = button(title, () => {
      const thread = state.history.find(entry => entry.id === id);
      if (!thread) return;
      historyId = id;
      $('history-title').textContent = title;
      $('history-mode').textContent = modes[thread.mode] ?? '';
      $('history-note').textContent = thread.note ?? '';
      renderMarkdown($('history-answer'), thread.messages.at(-1).content);
      $('history-list').hidden = true;
      $('history-entry').hidden = false;
      $('history').scrollTop = 0;
      $('history-back').focus({preventScroll: true});
    });
    open.dataset.threadId = id;
    item.append(open);
    list.append(item);
  }
}

function showHistoryList() {
  $('history-list').hidden = false;
  $('history-entry').hidden = true;
  $('history').scrollTop = 0;
  const previous = Array.from($('history-list').querySelectorAll('button')).find(node => node.dataset.threadId === historyId);
  historyId = undefined;
  previous?.focus();
}

$('history-back').addEventListener('click', showHistoryList);
$('history-continue').addEventListener('click', () => {
  if (busy) return;
  const thread = state.history.find(entry => entry.id === historyId);
  if (!thread) return showHistoryList();
  $('history').addEventListener('close', () => $('task').focus(), {once: true});
  $('history').close();
  currentThread = thread;
  $('task').value = '';
  $('task').placeholder = 'Что уточнить в этой задаче?';
  $('mode').value = 'execute';
  $('provider').value = thread.mode;
  selectedSources = thread.sources ?? [];
  excludedSources = new Set();
  showResult('answer', thread.messages.at(-1).content, thread.note);
  renderModes();
});

async function refresh() {
  const current = profile;
  const loaded = await read(current);
  if (profile !== current) return;
  const previous = state?.history;
  state = loaded;
  renderLibrary();
  // Keep the history buttons in place while library sync refreshes the view.
  if (!previous || previous.length !== loaded.history.length || loaded.history.some((thread, index) =>
    thread.id !== previous[index].id || thread.title !== previous[index].title)) renderHistory();
}

async function save(update, target = profile) {
  await change(target, update);
  if (target !== profile) return;
  await refresh();
  connection?.schedule();
}

function openEditor(entry) {
  editingId = entry?.id;
  editingRevision = entry ? state.library[entry.id]?.rev ?? null : null;
  $('library-browser').hidden = true;
  $('entry-form').hidden = false;
  $('delete-entry').hidden = !entry;
  $('entry-heading').textContent = entry ? entryTitle(entry) : 'Новая запись';
  $('entry-kind').value = entry?.kind ?? libraryKind();
  setStatus('library-status', '');
  $('entry-title').value = entry ? entryTitle(entry) : '';
  $('entry-text').value = entry?.text ?? '';
  $('library').scrollTop = 0;
  $('entry-heading').focus({preventScroll: true});
}

function closeEditor() {
  $('entry-form').hidden = true;
  $('library-browser').hidden = false;
  const row = Array.from($('library-list').querySelectorAll('button')).find(node => node.dataset.entryId === editingId);
  if ($('library').open) (row ?? $('new-entry')).focus();
}

function renderSources(editable) {
  const node = $('sources');
  node.replaceChildren();
  $('source-count').textContent = selectedSources.length ? '(' + (selectedSources.length - excludedSources.size) + ')' : '';
  if (!selectedSources.length) node.textContent = 'Подходящих материалов в библиотеке не найдено.';
  for (const source of selectedSources) {
    const label = document.createElement('label');
    if (editable) {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = !excludedSources.has(source.id);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) excludedSources.delete(source.id);
        else excludedSources.add(source.id);
        if ($('prompt-text').value !== promptBuilt) {
          const block = '### ' + source.title + '\n' + source.text;
          if (!checkbox.checked && $('prompt-text').value.includes(block)) {
            $('prompt-text').value = $('prompt-text').value.replace(block, '').replace(/\n{3,}/g, '\n\n').trim();
          } else if (confirm('Пересобрать промпт с этим выбором материалов? Ручные правки будут заменены.')) {
            rebuildPrompt();
          } else {
            checkbox.checked = !checkbox.checked;
            if (checkbox.checked) excludedSources.delete(source.id);
            else excludedSources.add(source.id);
          }
        } else rebuildPrompt();
        $('source-count').textContent = '(' + (selectedSources.length - excludedSources.size) + ')';
      });
      label.append(checkbox, ' ');
    }
    label.append(kindNames[source.kind] + ' · ' + source.title);
    node.append(label);
  }
}

let promptBuilt = '';
function rebuildPrompt() {
  promptBuilt = buildPrompt(resultTask, selectedSources.filter(source => !excludedSources.has(source.id)));
  $('prompt-text').value = promptBuilt;
}

function showResult(type, text, note, proposal = '') {
  $('result').hidden = false;
  $('result-title').textContent = type === 'prompt' ? 'Готовый промпт' : 'Ответ';
  $('prompt-text').hidden = type !== 'prompt';
  $('answer').hidden = type !== 'answer';
  answerText = type === 'answer' ? text : '';
  renderMarkdown($('answer'), answerText);
  const promptField = $('prompt-text');
  promptField.value = type === 'prompt' ? text : '';
  if (type === 'prompt') {
    promptField.setSelectionRange(0, 0);
    promptField.scrollTop = 0;
    $('source-details').open = false;
    if (matchMedia('(max-width: 599px)').matches) {
      if (document.activeElement === $('task')) $('task').blur();
      requestAnimationFrame(() => {
        promptField.scrollTop = 0;
        if (!promptField.hidden && !$('result').hidden) $('result').scrollIntoView({block: 'start'});
      });
    }
  }
  $('memory-proposal').hidden = !proposal;
  $('memory-text').value = proposal;
  setStatus('status', note || '');
  renderSources(type === 'prompt');
}

const memoryInstruction = '\n\nЕсли в сообщении пользователя есть новый явно сообщённый факт или принятое им решение, полезное в будущем, можешь в самом конце предложить одну запись строкой «ПАМЯТЬ: текст». Предложения и догадки модели не предлагай как факты.';
function separateProposal(answer) {
  const match = answer.match(/\n\s*ПАМЯТЬ:\s*([^\n]{1,500})\s*$/u);
  return match ? {answer: answer.slice(0, match.index).trim(), proposal: match[1].trim()} : {answer, proposal: ''};
}

$('task-form').addEventListener('submit', async event => {
  event.preventDefault();
  const task = $('task').value.trim();
  if (!task || busy || !state) return;
  const previous = currentThread;
  const executionProfile = profile;
  const continuing = $('mode').value === 'execute' && previous;
  selectedSources = continuing ? previous.sources : selectSources(task, entries(state));
  excludedSources = new Set();
  resultTask = task;
  const prompt = buildPrompt(task, selectedSources);
  if ($('mode').value === 'prompt') {
    promptBuilt = prompt;
    showResult('prompt', prompt, selectedSources.length ? '' : 'Подходящих материалов не найдено. Можно добавить их в библиотеку.');
    return;
  }
  const mode = $('provider').value;
  if (!mode) return;
  busy = true;
  $('memory-proposal').hidden = true;
  renderModes();
  try {
    const credentials = keys();
    const messages = [...(continuing ? previous.messages : []), {role: 'user', content: (continuing ? task : prompt) + memoryInstruction}];
    const response = await runTask(mode, messages,
      (id, chat) => askModel(id, credentials[id], chat), text => setStatus('status', text));
    if (executionProfile !== profile) return;
    const {answer, proposal} = separateProposal(response.answer);
    if (!answer) throw new Error('Модель не вернула ответ на задачу.');
    const thread = {id: previous?.id ?? crypto.randomUUID(), title: previous?.title ?? task.slice(0, 100),
      mode, messages: [...messages, {role: 'assistant', content: answer}], sources: selectedSources, note: response.note ?? ''};
    currentThread = thread;
    showResult('answer', answer, response.note, proposal);
    $('task').value = '';
    $('task').placeholder = 'Что уточнить в этой задаче?';
    try {
      await change(executionProfile, s => {
        s.history = [thread, ...s.history.filter(t => t.id !== thread.id)].slice(0, 30);
      });
    } catch {
      if (executionProfile === profile) setStatus('status', [response.note, 'Не удалось сохранить ответ в истории. Ответ можно скопировать с экрана.'].filter(Boolean).join(' '));
      return;
    }
    if (executionProfile === profile) {
      await refresh().catch(() => setStatus('status', [response.note, 'Ответ сохранён. Чтобы увидеть его в истории, обновите страницу.'].filter(Boolean).join(' ')));
    }
  } catch (error) { setStatus('status', error.message); }
  finally { busy = false; renderModes(); }
});

document.querySelectorAll('[name="task-mode"]').forEach(input => input.addEventListener('change', () => {
  $('mode').value = input.value;
  setStatus('status', '');
  renderModes();
}));
$('copy').addEventListener('click', async () => {
  const text = $('prompt-text').hidden ? answerText : $('prompt-text').value;
  try { await navigator.clipboard.writeText(text); setStatus('status', 'Скопировано.'); }
  catch {
    setStatus('status', 'Скопируйте выделенный текст вручную.');
    if (!$('prompt-text').hidden) $('prompt-text').select();
    else {
      const range = document.createRange();
      range.selectNodeContents($('answer'));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }
});
$('dismiss-memory').addEventListener('click', () => { $('memory-proposal').hidden = true; });
$('remember').addEventListener('click', async () => {
  const text = $('memory-text').value.trim();
  if (!text) return;
  try {
    await save(s => edit(s, {id: crypto.randomUUID(), kind: 'memory', title: text.slice(0, 80), text}));
    $('memory-proposal').hidden = true;
    setStatus('status', 'Добавлено в память.');
  } catch (error) { setStatus('status', error.message); }
});
const menuToggle = $('menu-toggle');
function setMenu(open) {
  menuToggle.setAttribute('aria-expanded', String(open));
  menuToggle.setAttribute('aria-label', open ? 'Закрыть меню' : 'Открыть меню');
}
menuToggle.addEventListener('click', () => setMenu(menuToggle.getAttribute('aria-expanded') !== 'true'));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && menuToggle.getAttribute('aria-expanded') === 'true') {
    setMenu(false);
    menuToggle.focus();
  }
});
document.querySelectorAll('[data-open]').forEach(node => node.addEventListener('click', () => {
  if (!state) return;
  const dialog = $(node.dataset.open);
  const menuVisible = menuToggle.getClientRects().length > 0;
  setMenu(false);
  if (dialog.id === 'history') showHistoryList();
  dialog.showModal();
  if (menuVisible) dialog.addEventListener('close', () => menuToggle.focus({preventScroll: true}), {once: true});
}));
document.querySelectorAll('[data-close]').forEach(node => node.addEventListener('click', () => node.closest('dialog').close()));
for (const dialog of document.querySelectorAll('dialog')) {
  let pressedOutside = false;
  const isOutside = event => {
    if (event.target !== dialog) return false;
    const {left, right, top, bottom} = dialog.getBoundingClientRect();
    return event.clientX < left || event.clientX >= right || event.clientY < top || event.clientY >= bottom;
  };
  dialog.addEventListener('pointerdown', event => { pressedOutside = isOutside(event); });
  dialog.addEventListener('click', event => {
    if (pressedOutside && isOutside(event)) dialog.close();
    pressedOutside = false;
  });
}

const theme = $('theme');
const themeKey = 'ai-pult:theme';
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
const themeColor = document.querySelector('meta[name="theme-color"]');
try {
  const savedTheme = localStorage.getItem(themeKey);
  if (savedTheme === 'light' || savedTheme === 'dark') theme.value = savedTheme;
} catch { /* Use the system theme if storage is unavailable. */ }
function applyTheme() {
  const dark = theme.value === 'dark' || (theme.value === 'system' && systemTheme.matches);
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  themeColor.content = getComputedStyle(root).getPropertyValue('--bg').trim();
}
theme.addEventListener('change', () => {
  applyTheme();
  try { localStorage.setItem(themeKey, theme.value); } catch { /* Keep the selection for this session. */ }
});
systemTheme.addEventListener('change', applyTheme);
applyTheme();

$('new-entry').addEventListener('click', () => openEditor());
$('cancel-entry').addEventListener('click', () => {
  setStatus('library-status', '');
  closeEditor();
});
document.querySelectorAll('[name="library-kind"]').forEach(input => input.addEventListener('change', () => {
  setStatus('library-status', '');
  renderLibrary();
}));
$('delete-entry').addEventListener('click', async () => {
  const id = editingId;
  const revision = editingRevision;
  if (!id || !confirm('Удалить «' + $('entry-heading').textContent + '»?')) return;
  try {
    await save(s => {
      if (s.library[id]?.rev !== revision) throw new Error('Запись изменилась. Откройте её заново перед удалением.');
      edit(s, null, id);
    });
    if (editingId === id) closeEditor();
    setStatus('library-status', 'Запись удалена.');
  } catch (error) { setStatus('library-status', error.message); }
});
$('entry-form').addEventListener('submit', async event => {
  event.preventDefault();
  const entry = {id: editingId ?? crypto.randomUUID(), kind: $('entry-kind').value,
    title: $('entry-title').value.trim(), text: $('entry-text').value.trim()};
  try {
    let conflict;
    await save(s => { conflict = edit(s, entry, entry.id, editingRevision); });
    document.querySelector('[name="library-kind"][value="' + entry.kind + '"]').checked = true;
    renderLibrary();
    closeEditor();
    setStatus('library-status', conflict ? 'Запись изменилась на другом устройстве. Ваш текст сохранён отдельной копией.' : 'Сохранено.');
  } catch (error) { setStatus('library-status', error.message); }
});
$('files').addEventListener('change', async event => {
  const files = Array.from(event.target.files);
  event.target.value = '';
  const kind = libraryKind();
  const imported = [];
  const skipped = [];
  for (const file of files) {
    try {
      if (file.size > textLimit) throw new Error();
      const text = new TextDecoder('utf-8', {fatal: true}).decode(await file.arrayBuffer()).trim();
      const entry = {id: crypto.randomUUID(), kind, title: file.name.slice(0, 180), text};
      if (!validEntry(entry)) throw new Error();
      imported.push(entry);
    } catch { skipped.push(file.name); }
  }
  try {
    if (imported.length) await save(s => imported.forEach(entry => edit(s, entry)));
    setStatus('library-status', 'Загружено: ' + imported.length + (skipped.length ? '. Пропущены (пустые, больше 200 КБ или не UTF-8): ' + skipped.join(', ') : '.'));
  } catch (error) { setStatus('library-status', error.message); }
});
$('save-keys').addEventListener('click', () => {
  for (const name of ['claude', 'deepseek']) {
    const value = $(name + '-key').value.trim();
    if (value) localStorage.setItem(keyName + name, value);
    else localStorage.removeItem(keyName + name);
  }
  setStatus('settings-status', 'Ключи сохранены на этом устройстве.');
  setStatus('status', '');
  renderModes();
});

async function setProfile(code) {
  const attempt = ++connectionAttempt;
  connection?.close();
  connection = undefined;
  $('connect').disabled = true;
  try {
    const next = code ? (await cloudIdentity(code)).profile : local;
    if (attempt !== connectionAttempt) return;
    profile = next;
    currentThread = undefined;
    $('task').placeholder = 'Что нужно сделать?';
    $('result').hidden = true;
    closeEditor();
    await refresh();
    $('sync-code').value = code;
    $('disconnect').hidden = !code;
    renderModes();
    if (!code) {
      localStorage.removeItem(cloudCodeName);
      setStatus('sync-status', 'Локальная библиотека');
      return;
    }
    localStorage.setItem(cloudCodeName, code);
    setStatus('sync-status', 'Подключаю библиотеку…');
    const sync = await connectSync(code, profile,
      text => { if (attempt === connectionAttempt) setStatus('sync-status', text); },
      refresh, () => attempt === connectionAttempt);
    if (attempt !== connectionAttempt) sync?.close?.();
    else connection = sync;
  } catch {
    if (attempt === connectionAttempt) {
      setStatus('sync-status', 'Синхронизация недоступна · работаем с локальной копией');
    }
  } finally {
    if (attempt === connectionAttempt) $('connect').disabled = false;
  }
}

$('generate-code').addEventListener('click', () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  $('sync-code').value = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  $('sync-code').select();
});
$('connect').addEventListener('click', () => {
  const code = $('sync-code').value.trim();
  if (!/^[A-Za-z0-9_-]{22}$/.test(code)) {
    setStatus('sync-status', 'Создайте код или вставьте код с первого устройства.');
    return;
  }
  setProfile(code);
});
$('disconnect').addEventListener('click', () => setProfile(''));

$('backup').addEventListener('click', async () => {
  try {
    const latest = await read(profile);
    const file = new Blob([JSON.stringify({version: 1, library: entries(latest), history: latest.history}, null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'ai-pult-backup.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  } catch { setStatus('settings-status', 'Не удалось сохранить резервную копию.'); }
});
$('restore').addEventListener('change', async event => {
  const file = event.target.files[0];
  const target = profile;
  event.target.value = '';
  if (!file) return;
  try {
    const backup = JSON.parse(await file.text());
    const validMessage = message => ['user', 'assistant'].includes(message?.role) && typeof message.content === 'string';
    const validThread = thread => typeof thread?.id === 'string' && typeof thread.title === 'string'
      && Object.hasOwn(modes, thread.mode) && Array.isArray(thread.messages) && thread.messages.every(validMessage)
      && thread.messages.at(-1)?.role === 'assistant' && Array.isArray(thread.sources)
      && thread.sources.every(validEntry) && (thread.note === undefined || typeof thread.note === 'string');
    if (backup?.version !== 1 || !Array.isArray(backup.library) || !backup.library.every(validEntry)
      || !Array.isArray(backup.history) || !backup.history.every(validThread)) throw new Error();
    await save(s => {
      for (const entry of backup.library) {
        const existing = s.library[entry.id]?.entry;
        if (!existing) edit(s, entry);
        else if (existing.kind !== entry.kind || existing.title !== entry.title || existing.text !== entry.text) {
          edit(s, {...entry, id: crypto.randomUUID(), title: entry.title.slice(0, 160) + ' (из копии)'});
        }
      }
      const saved = new Set(s.history.map(thread => thread.id));
      s.history = [...s.history, ...backup.history.filter(thread => !saved.has(thread.id))].slice(0, 30);
    }, target);
    setStatus('settings-status', 'Данные из копии добавлены.');
  } catch { setStatus('settings-status', 'Не удалось восстановить копию. Проверьте файл.'); }
});

$('new-task').addEventListener('click', () => {
  if (busy) return;
  currentThread = undefined;
  $('task').value = '';
  $('task').placeholder = 'Что нужно сделать?';
  $('result').hidden = true;
  setStatus('status', '');
  renderModes();
  $('task').focus();
});

try {
  await openStorage();
  if (!localStorage.getItem('ai-pult:migrated-keys')) {
    try {
      const previousKey = JSON.parse(localStorage.getItem('ai-pult.keys.v1'))?.deepseek;
      if (!localStorage.getItem(keyName + 'deepseek') && typeof previousKey === 'string' && previousKey.trim()) {
        localStorage.setItem(keyName + 'deepseek', previousKey.trim());
      }
    } catch { /* Previous settings may be absent or invalid. */ }
    localStorage.setItem('ai-pult:migrated-keys', '1');
  }
  for (const [name, value] of Object.entries(keys())) $(name + '-key').value = value;
  await refresh();
  renderModes();
  const code = localStorage.getItem(cloudCodeName);
  if (code) setProfile(code);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
} catch {
  setStatus('status', 'Не удалось открыть локальное хранилище. Проверьте настройки браузера.');
}
