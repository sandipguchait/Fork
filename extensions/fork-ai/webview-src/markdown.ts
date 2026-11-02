/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

// A small Markdown renderer for model replies. Model output is untrusted, so everything is
// HTML-escaped first and only a fixed set of tags is produced; links must be http(s).
// It renders partial input well, since replies are re-rendered on every streamed chunk.

export type MarkdownBlock =
	| { readonly type: 'html'; readonly html: string }
	| { readonly type: 'code'; readonly language: string; readonly code: string; readonly complete: boolean };

export function escapeHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatEmphasis(escaped: string): string {
	return escaped
		.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
		.replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>')
		.replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?!\*)/g, '$1<em>$2</em>')
		.replace(/(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1<em>$2</em>')
		.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
}

function formatLinks(escaped: string): string {
	return escaped.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label: string, url: string) =>
		`<a href="${url}" title="${url}">${label}</a>`);
}

/** Inline code first, so nothing inside backticks gets formatted. */
export function renderInline(text: string): string {
	const pieces = text.split(/(`+[^`\n]*?`+)/g);
	return pieces.map(piece => {
		const code = /^(`+)([^`\n]*?)\1$/.exec(piece);
		if (code) {
			return `<code>${escapeHtml(code[2])}</code>`;
		}
		return formatLinks(formatEmphasis(escapeHtml(piece)));
	}).join('');
}

const FENCE = /^(\s*)(```|~~~)\s*([\w#+.-]*)/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*(\d+)[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function tableCells(line: string): string[] {
	return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
}

export function parseMarkdown(source: string): MarkdownBlock[] {
	const lines = source.replace(/\r\n?/g, '\n').split('\n');
	const blocks: MarkdownBlock[] = [];
	let html = '';
	const flush = () => {
		if (html) {
			blocks.push({ type: 'html', html });
			html = '';
		}
	};

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];

		const fence = FENCE.exec(line);
		if (fence) {
			flush();
			const marker = fence[2];
			const code: string[] = [];
			i++;
			let complete = false;
			while (i < lines.length) {
				if (lines[i].trim().startsWith(marker)) {
					complete = true;
					i++;
					break;
				}
				code.push(lines[i]);
				i++;
			}
			blocks.push({ type: 'code', language: fence[3], code: code.join('\n'), complete });
			continue;
		}

		if (!line.trim()) {
			i++;
			continue;
		}

		const heading = HEADING.exec(line);
		if (heading) {
			const level = Math.min(heading[1].length + 2, 6);
			html += `<h${level}>${renderInline(heading[2])}</h${level}>`;
			i++;
			continue;
		}

		if (RULE.test(line)) {
			html += '<hr>';
			i++;
			continue;
		}

		if (line.includes('|') && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) {
			const header = tableCells(line);
			i += 2;
			const rows: string[][] = [];
			while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
				rows.push(tableCells(lines[i]));
				i++;
			}
			html += '<table><thead><tr>' + header.map(cell => `<th>${renderInline(cell)}</th>`).join('') + '</tr></thead><tbody>'
				+ rows.map(row => '<tr>' + header.map((_, column) => `<td>${renderInline(row[column] ?? '')}</td>`).join('') + '</tr>').join('')
				+ '</tbody></table>';
			continue;
		}

		if (BULLET.test(line) || ORDERED.test(line)) {
			const ordered = !BULLET.test(line);
			const start = ordered ? Number(ORDERED.exec(line)![1]) : 1;
			const items: string[] = [];
			while (i < lines.length) {
				const item = ordered ? ORDERED.exec(lines[i]) : BULLET.exec(lines[i]);
				if (item) {
					items.push(ordered ? item[2] : item[1]);
				} else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
					items[items.length - 1] += ' ' + lines[i].trim();
				} else {
					break;
				}
				i++;
			}
			const tag = ordered ? 'ol' : 'ul';
			const startAttr = ordered && start !== 1 ? ` start="${start}"` : '';
			html += `<${tag}${startAttr}>` + items.map(item => `<li>${renderInline(item)}</li>`).join('') + `</${tag}>`;
			continue;
		}

		if (QUOTE.test(line)) {
			const quoted: string[] = [];
			while (i < lines.length && QUOTE.test(lines[i])) {
				quoted.push(QUOTE.exec(lines[i])![1]);
				i++;
			}
			html += `<blockquote>${quoted.map(renderInline).join('<br>')}</blockquote>`;
			continue;
		}

		const paragraph: string[] = [];
		while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !HEADING.test(lines[i]) && !BULLET.test(lines[i]) && !ORDERED.test(lines[i]) && !QUOTE.test(lines[i])) {
			paragraph.push(lines[i]);
			i++;
		}
		html += `<p>${paragraph.map(renderInline).join('<br>')}</p>`;
	}
	flush();
	return blocks;
}
