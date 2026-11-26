const PH_OPEN = '\uE000';
const PH_CLOSE = '\uE001';

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const BLOCK_START =
  /^(#{1,6}\s|>\s?|\s*([-*+]|\d+[.)])\s+|```|\s*([-*_])(\s*\3){2,}\s*$|\uE000\d+\uE001$)/;

/**
 * 极简但安全的 Markdown 渲染器（无依赖）：
 * 先转义 HTML，再生成受控标签，链接仅允许 http(s)/mailto/站内路径。
 */
export function renderMarkdown(input) {
  if (!input) return '';
  let text = String(input).replace(/\r\n?/g, '\n').replace(/[\uE000\uE001]/g, '');

  const codeBlocks = [];
  text = text.replace(/```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g, (_match, lang, code) => {
    const index = codeBlocks.length;
    codeBlocks.push({ lang: String(lang || '').trim(), code: String(code).replace(/\n$/, '') });
    return `\n${PH_OPEN}${index}${PH_CLOSE}\n`;
  });

  const inlineCodes = [];
  text = text.replace(/`([^`\n]+)`/g, (_match, code) => {
    inlineCodes.push(code);
    return `${PH_OPEN}i${inlineCodes.length - 1}${PH_CLOSE}`;
  });

  const lines = text.split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (new RegExp(`^${PH_OPEN}\\d+${PH_CLOSE}$`).test(line.trim()) || line.trim().startsWith(PH_OPEN + 'i')) {
      out.push(line.trim());
      i += 1;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('<hr />');
      i += 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${quote.map(inline).join('<br />')}</blockquote>`);
      continue;
    }

    if (isTableStart(lines, i)) {
      const table = renderTable(lines, i);
      out.push(table.html);
      i = table.next;
      continue;
    }

    const listMatch = matchList(line);
    if (listMatch) {
      const list = renderList(lines, i);
      out.push(list.html);
      i = list.next;
      continue;
    }

    const paragraph = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      paragraph.push(inline(lines[i].trim()));
      i += 1;
    }
    if (!paragraph.length) {
      // 安全兜底：避免遇到未知块时死循环
      paragraph.push(inline(line.trim()));
      i += 1;
    }
    out.push(`<p>${paragraph.join('<br />')}</p>`);
  }

  let html = out.join('\n');
  html = html.replace(new RegExp(`${PH_OPEN}(\\d+)${PH_CLOSE}`, 'g'), (_m, index) => renderCodeBlock(codeBlocks[Number(index)]));
  html = html.replace(
    new RegExp(`${PH_OPEN}i(\\d+)${PH_CLOSE}`, 'g'),
    (_m, index) => `<code>${escapeHtml(inlineCodes[Number(index)])}</code>`,
  );
  return html;
}

function inline(raw) {
  let html = escapeHtml(raw);

  html = html.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (match, alt, url) => {
    const safe = sanitizeUrl(url, true);
    if (!safe) return match;
    return `<img src="${safe}" alt="${escapeHtml(alt)}" loading="lazy" />`;
  });

  html = html.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
    const safe = sanitizeUrl(url);
    if (!safe) return label;
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  html = html
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w_])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');

  // 裸链接（不处理已在 href/src 里的）
  html = html.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_m, prefix, url) => {
    return `${prefix}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });

  // 任务列表
  html = html.replace(/^\[ \]\s+/, '<span class="task">☐</span> ');
  html = html.replace(/^\[[xX]\]\s+/, '<span class="task">☑</span> ');

  return html;
}

function sanitizeUrl(raw, allowImage = false) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/^(https?:|mailto:|\/|#)/i.test(value)) {
    // 禁止 javascript: 等协议；其他字符已在转义阶段处理
    return value.replace(/[\u0000-\u001f]/g, '');
  }
  if (allowImage && /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(value)) return value;
  return '';
}

function isBlockStart(line) {
  return (
    /^(#{1,6})\s+/.test(line) ||
    /^\s*>\s?/.test(line) ||
    /^\s*([-*_])(\s*\1){2,}\s*$/.test(line) ||
    matchList(line) !== null ||
    /^\s*```/.test(line) ||
    new RegExp(`^${PH_OPEN}\\d+${PH_CLOSE}$`).test(line.trim())
  );
}

function matchList(line) {
  const match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
  if (!match) return null;
  return {
    indent: match[1].replace(/\t/g, '  ').length,
    ordered: /^\d/.test(match[2]),
    text: match[3],
  };
}

function renderList(lines, start) {
  const first = matchList(lines[start]);
  const baseIndent = first.indent;
  const tag = first.ordered ? 'ol' : 'ul';
  let html = `<${tag}>`;
  let i = start;
  let hasItem = false;

  while (i < lines.length) {
    const item = matchList(lines[i]);
    if (!item) break;
    if (item.indent < baseIndent) break;

    if (item.indent > baseIndent) {
      if (!hasItem) break;
      const nested = renderList(lines, i);
      html = html.replace(/<\/li>$/, `${nested.html}</li>`);
      i = nested.next;
      continue;
    }

    const parts = [inline(item.text)];
    i += 1;
    while (i < lines.length && lines[i].trim() && !matchList(lines[i]) && !isBlockStart(lines[i])) {
      parts.push(inline(lines[i].trim()));
      i += 1;
    }
    html += `<li>${parts.join('<br />')}</li>`;
    hasItem = true;
  }

  html += `</${tag}>`;
  return { html, next: i };
}

function isTableStart(lines, i) {
  if (!lines[i] || !lines[i].includes('|')) return false;
  const separator = lines[i + 1];
  if (!separator || !separator.includes('-') || !separator.includes('|')) return false;
  return splitRow(separator).every((cell) => /^:?-{1,}:?$/.test(cell.trim()));
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function renderTable(lines, start) {
  const headers = splitRow(lines[start]);
  const aligns = splitRow(lines[start + 1]).map((cell) => {
    if (cell.startsWith(':') && cell.endsWith(':')) return 'center';
    if (cell.endsWith(':')) return 'right';
    return 'left';
  });
  let i = start + 2;
  const rows = [];
  while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
    rows.push(splitRow(lines[i]));
    i += 1;
  }

  const head = headers
    .map((cell, index) => `<th style="text-align:${aligns[index] || 'left'}">${inline(cell)}</th>`)
    .join('');
  const body = rows
    .map(
      (row) =>
        `<tr>${headers
          .map((_, index) => `<td style="text-align:${aligns[index] || 'left'}">${inline(row[index] || '')}</td>`)
          .join('')}</tr>`,
    )
    .join('');

  return { html: `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`, next: i };
}

function renderCodeBlock(block) {
  const lang = block?.lang ? escapeHtml(block.lang) : 'text';
  const code = escapeHtml(block?.code || '');
  return (
    '<div class="code-block">' +
    `<div class="code-head"><span>${lang}</span>` +
    '<button type="button" class="copy-code" data-action="copy-code" aria-label="复制代码">' +
    '<svg class="icon" aria-hidden="true"><use href="#i-copy"></use></svg><span>复制</span></button></div>' +
    `<pre><code>${code}</code></pre></div>`
  );
}
