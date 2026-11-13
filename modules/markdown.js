const heading = /^\s{0,3}(#{1,6})\s+(.+)$/;
const listItem = /^\s{0,3}([-+*]|\d{1,9}[.)])\s+(.+)$/;
const fence = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
const rule = /^\s{0,3}(?:-\s*){3,}$|^\s{0,3}(?:\*\s*){3,}$|^\s{0,3}(?:_\s*){3,}$/;

function append(parent, tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  parent.append(node);
  return node;
}

function inline(parent, text) {
  const tokens = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_/g;
  let start = 0;
  for (const match of text.matchAll(tokens)) {
    parent.append(text.slice(start, match.index));
    if (match[1]) append(parent, 'code', match[1]);
    else if (match[2] || match[3]) append(parent, 'strong', match[2] ?? match[3]);
    else append(parent, 'em', match[4] ?? match[5]);
    start = match.index + match[0].length;
  }
  parent.append(text.slice(start));
}

function cells(line) {
  if (!line?.includes('|')) return [];
  return line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/).map(cell => cell.trim().replaceAll('\\|', '|'));
}

function tableHeader(line, next) {
  const titles = cells(line);
  const separators = cells(next);
  return titles.length && titles.length === separators.length && separators.every(cell => /^:?-{3,}:?$/.test(cell))
    ? titles : null;
}

function tableRow(parent, tag, values) {
  const row = append(parent, 'tr');
  for (const value of values) inline(append(row, tag), value);
}

export function renderMarkdown(target, text) {
  const content = document.createDocumentFragment();
  const lines = text.split(/\r?\n/);
  let paragraph;
  let list;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const code = line.match(fence);
    const title = line.match(heading);
    const item = line.match(listItem);
    const titles = tableHeader(line, lines[index + 1]);
    if (!item || rule.test(line)) list = undefined;
    if (!line.trim() || code || title || item || titles || rule.test(line)) paragraph = undefined;

    if (!line.trim()) continue;
    if (code) {
      const rows = [];
      const marker = code[1];
      const end = new RegExp('^\\s{0,3}' + marker[0] + '{' + marker.length + ',}\\s*$');
      while (index + 1 < lines.length && !end.test(lines[index + 1])) rows.push(lines[++index]);
      if (index + 1 < lines.length) index++;
      append(append(content, 'pre'), 'code', rows.join('\n'));
    } else if (title) {
      inline(append(content, 'h' + Math.min(title[1].length + 2, 6)), title[2]);
    } else if (rule.test(line)) {
      append(content, 'hr');
    } else if (titles) {
      const wrapper = append(content, 'div');
      wrapper.className = 'markdown-table';
      wrapper.tabIndex = 0;
      wrapper.setAttribute('role', 'region');
      wrapper.setAttribute('aria-label', 'Таблица');
      const table = append(wrapper, 'table');
      tableRow(append(table, 'thead'), 'th', titles);
      const body = append(table, 'tbody');
      index++;
      while (cells(lines[index + 1]).length) {
        const values = cells(lines[++index]);
        tableRow(body, 'td', titles.map((_, column) => values[column] ?? ''));
      }
    } else if (item) {
      const tag = /^\d/.test(item[1]) ? 'OL' : 'UL';
      if (list?.tagName !== tag) {
        list = append(content, tag.toLowerCase());
        if (tag === 'OL') list.start = parseInt(item[1], 10);
      }
      inline(append(list, 'li'), item[2]);
    } else {
      if (!paragraph) paragraph = append(content, 'p');
      else append(paragraph, 'br');
      inline(paragraph, line);
    }
  }
  target.replaceChildren(content);
}
