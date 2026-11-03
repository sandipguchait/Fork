/*---------------------------------------------------------------------------------------------
 *  Fork AI. Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

// Code-aware tokens: identifiers are kept whole and also split into their words, so a question
// about "parse date" finds parseDate, parse_date and ParseDates.

const STOPWORDS = new Set([
	// English and question words
	'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'for', 'from', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its',
	'me', 'my', 'of', 'on', 'or', 'our', 'so', 'than', 'that', 'the', 'their', 'then', 'there', 'these', 'this', 'to', 'we', 'what', 'when',
	'where', 'which', 'who', 'why', 'will', 'with', 'you', 'your', 'find', 'show', 'code', 'file', 'located', 'defined', 'logic',
	'implemented', 'implementation', 'thing', 'part', 'place', 'work',
	// Keywords common to most languages
	'const', 'let', 'var', 'function', 'return', 'import', 'export', 'default', 'else', 'new', 'class', 'public', 'private', 'protected',
	'static', 'void', 'null', 'undefined', 'true', 'false', 'this', 'self', 'def', 'fn', 'func', 'pub', 'use', 'mut', 'async', 'await',
	'type', 'interface', 'extends', 'implements', 'readonly', 'string', 'number', 'boolean', 'any', 'unknown', 'object',
]);

/**
 * Light stemming, applied the same way to code and questions, so "parse", "parser", "parsing",
 * "parsed" and "parses" meet at "pars". Only words long enough to keep their meaning are cut.
 */
export function stem(word: string): string {
	let w = word;
	if (w.length > 5 && w.endsWith('ies')) {
		w = w.slice(0, -3) + 'y';
	} else if (w.length > 5 && w.endsWith('ing')) {
		w = w.slice(0, -3);
	} else if (w.length > 4 && w.endsWith('ed') && !w.endsWith('eed')) {
		w = w.slice(0, -2);
	} else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) {
		w = w.slice(0, -1);
	}
	if (w.length > 5 && w.endsWith('er')) {
		w = w.slice(0, -2);
	}
	if (w.length > 4 && w.endsWith('e')) {
		w = w.slice(0, -1);
	}
	return w;
}

/** "parseDateTime_v2" → ["parse", "date", "time", "v2"]. */
export function splitIdentifier(identifier: string): string[] {
	return identifier
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean)
		.map(part => part.toLowerCase());
}

const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*|\d+[A-Za-z]+[A-Za-z0-9]*/g;

/**
 * Terms for indexing. Each identifier yields its stemmed words and, when it has several, the
 * whole identifier joined ("parseDates" → "pars", "date", "parsdate"), so a question that names
 * the same words in order ranks the exact name above loose word matches.
 */
export function tokenize(text: string): string[] {
	const terms: string[] = [];
	for (const match of text.matchAll(IDENTIFIER)) {
		const identifier = match[0];
		if (identifier.length > 64) {
			continue;
		}
		const words = splitIdentifier(identifier);
		const stems = words.map(stem);
		words.forEach((word, i) => {
			if (word.length >= 2 && !STOPWORDS.has(word)) {
				terms.push(stems[i]);
			}
		});
		if (stems.length > 1) {
			terms.push(stems.join(''));
		}
	}
	return terms;
}

/**
 * Terms for a question: the same terms as tokenize, plus neighbouring words joined across the
 * question ("status bar entry" → "statusbar", "barentry"), so prose finds two-word names.
 */
export function queryTerms(query: string): string[] {
	const terms = tokenize(query);
	const words: string[] = [];
	for (const match of query.matchAll(IDENTIFIER)) {
		for (const word of splitIdentifier(match[0])) {
			if (word.length >= 2 && !STOPWORDS.has(word)) {
				words.push(stem(word));
			}
		}
	}
	for (let i = 0; i + 1 < words.length; i++) {
		terms.push(words[i] + words[i + 1]);
	}
	return [...new Set(terms)];
}

/** Path terms: folders and file name split like identifiers ("src/vs/base/common/fuzzyScorer.ts"). */
export function pathTerms(path: string): string[] {
	const withoutExtension = path.replace(/\.[A-Za-z0-9]+$/, '');
	return tokenize(withoutExtension.replace(/[/\\.\-]/g, ' '));
}
