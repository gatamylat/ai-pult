export const kindNames = {skill: 'Skill', memory: 'Память', document: 'Документ'};
export const textLimit = 200_000;
const terms = text => text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
const bytes = text => new TextEncoder().encode(text).length;

export function validEntry(entry) {
  return typeof entry?.id === 'string' && /^[0-9a-f-]{36}$/.test(entry.id)
    && Object.hasOwn(kindNames, entry.kind)
    && typeof entry.title === 'string' && entry.title.trim().length > 0 && entry.title.length <= 180
    && typeof entry.text === 'string' && entry.text.trim().length > 0 && bytes(entry.text) <= textLimit
    && (entry.conflict === undefined || entry.conflict === true);
}

function skillHeader(text) {
  return text.match(/^\s*---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? text;
}

export function entryTitle(entry) {
  if (entry.kind !== 'skill' || !/^skill\.md(?: \(.*\))?$/i.test(entry.title)) return entry.title;
  const name = skillHeader(entry.text).match(/^name:\s*([\w-]+)\s*$/m)?.[1];
  return name ? entry.title.replace(/^skill\.md/i, name) : entry.title;
}

export function selectSources(task, library) {
  const stop = new Set(['как', 'что', 'для', 'этот', 'этого', 'это', 'предложи', 'изучи', 'сделай', 'нужно',
    'можно', 'чтобы', 'если', 'только', 'пока', 'сейчас', 'скажи', 'или', 'уже', 'какой']);
  const tokens = text => new Set(terms(text.replaceAll('ё', 'е')).filter(word => !stop.has(word)).map(word => word.slice(0, 5)));
  const words = tokens(task);
  const score = text => [...tokens(text)].filter(word => words.has(word)).length;
  const names = ' ' + terms(task).join(' ') + ' ';
  const skills = library.filter(entry => entry.kind === 'skill').map(entry => {
    const header = skillHeader(entry.text);
    const name = header.match(/^name:\s*([\w-]+)\s*$/m)?.[1];
    const description = header.match(/^description:[ \t]*(.*(?:\r?\n[ \t]+[^\r\n]*)*)/m)?.[1];
    const title = entryTitle(entry);
    const explicit = [name, title].some(label => label && !/^skill\.md$/i.test(label) &&
      names.includes(' ' + terms(label).join(' ') + ' '));
    const scope = description?.split(/(?:Не применять|Не использовать|Do not use)/i)[0] ?? entry.text.slice(0, 500);
    const rank = score(title) * 3 + score(scope);
    const text = entry.text.length > 8000 ? entry.text.slice(0, 8000).trimEnd() + '\n\n[…]' : entry.text;
    return {...entry, title, text, explicit, rank};
  }).sort((a, b) => b.rank - a.rank);
  const named = skills.filter(skill => skill.explicit);
  const automatic = skills.find(skill => skill.rank >= 2);
  const chosenSkills = named.length ? named : automatic ? [automatic] : [];

  const materials = library.filter(entry => entry.kind !== 'skill').flatMap(entry => {
    const paragraphs = entry.text.split(/\n\s*\n/);
    const chunks = paragraphs.flatMap(paragraph => paragraph.match(/[\s\S]{1,1800}/g) || []);
    const matches = chunks.map((text, index) => ({text, index, rank: score(text)}))
      .filter(item => item.rank).sort((a, b) => b.rank - a.rank).slice(0, 2);
    const rank = score(entry.title) * 3 + (matches[0]?.rank ?? 0);
    if (!rank) return [];
    const text = matches.length
      ? matches.sort((a, b) => a.index - b.index).map(item => item.text).join('\n\n[…]\n\n')
      : chunks[0];
    return [{...entry, text, rank}];
  }).sort((a, b) => b.rank - a.rank);
  return [...chosenSkills, ...materials].slice(0, 6);
}

export function buildPrompt(task, sources) {
  const sections = [['Правила работы', 'skill'], ['Подтверждённые факты', 'memory'], ['Выдержки из документов', 'document']];
  return [
    '## Задача\n' + task.trim(),
    '## Ожидаемый результат\nВыполни задачу в указанном формате. Если формат не задан, выбери подходящий. Если необходимого материала не хватает, укажи какого.',
    ...sections.flatMap(([label, kind]) => {
      const items = sources.filter(source => source.kind === kind);
      return items.length ? ['## ' + label + '\n' + items.map(item => '### ' + item.title + '\n' + item.text).join('\n\n')] : [];
    }),
  ].join('\n\n');
}

const providers = {
  claude: {label: 'Claude', url: 'https://api.anthropic.com/v1/messages', model: 'claude-sonnet-4-6'},
  deepseek: {label: 'DeepSeek', url: 'https://api.deepseek.com/chat/completions', model: 'deepseek-flash'},
};

export async function askModel(provider, key, messages, request = fetch) {
  const {label, url, model} = providers[provider];
  const headers = {'Content-Type': 'application/json'};
  if (provider === 'claude') {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  } else {
    headers.Authorization = 'Bearer ' + key;
  }
  const body = {model, messages, max_tokens: 4000};
  if (provider === 'deepseek') body.thinking = {type: 'disabled'};
  let response;
  try {
    response = await request(url, {method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000)});
  } catch {
    throw new Error(label + ': нет ответа от API. Проверьте сеть и доступ API из браузера.');
  }
  if (!response.ok) {
    const hints = {400: 'Запрос или модель отклонены.', 401: 'Проверьте ключ и доступ из браузера.', 402: 'Проверьте баланс API.', 403: 'Нет доступа к API.', 429: 'Достигнут лимит запросов.'};
    throw new Error(label + ': HTTP ' + response.status + '. ' + (hints[response.status] || 'Попробуйте ещё раз.'));
  }
  const data = await response.json();
  const value = provider === 'claude'
    ? data.content?.filter(block => block.type === 'text').map(block => block.text).join('\n')
    : data.choices?.[0]?.message?.content;
  if (typeof value !== 'string' || !value.trim()) throw new Error(label + ': пустой ответ.');
  return value.trim();
}

export async function runTask(mode, messages, ask, progress) {
  if (mode !== 'together') {
    progress(providers[mode].label + ' готовит ответ…');
    return {answer: await ask(mode, messages)};
  }
  progress('Claude готовит ответ…');
  const draft = await ask('claude', messages);
  try {
    progress('DeepSeek проверяет…');
    const review = await ask('deepseek', [...messages, {role: 'assistant', content: draft},
      {role: 'user', content: 'Проверь ответ по исходной задаче и материалам. Укажи только существенные ошибки и предложи исправления.'}]);
    progress('Claude уточняет ответ…');
    const answer = await ask('claude', [...messages, {role: 'assistant', content: draft},
      {role: 'user', content: 'Учти замечания проверяющего и верни итоговый ответ.\n\n' + review}]);
    return {answer};
  } catch (error) {
    return {answer: draft, note: 'Совместная работа остановилась. Показан ответ Claude. ' + error.message};
  }
}
