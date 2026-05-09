export type ProjectHistoryRole = "user" | "assistant";
export type ProjectHistoryRoleFilter = ProjectHistoryRole | "all";

export interface ProjectHistorySession {
	path: string;
	id: string;
	cwd?: string;
	name?: string;
	created?: Date | string | number;
	modified?: Date | string | number;
	firstMessage?: string;
}

export interface SearchDocument {
	sessionPath: string;
	sessionId: string;
	sessionName?: string;
	sessionCwd?: string;
	sessionCreated?: Date;
	sessionModified?: Date;
	sessionFirstMessage?: string;
	entryId: string;
	timestamp?: Date;
	role: ProjectHistoryRole;
	text: string;
	lineNumber?: number;
}

export interface ProjectHistorySearchOptions {
	query: string;
	role?: ProjectHistoryRoleFilter;
	limit?: number;
	maxSnippetLength?: number;
}

export interface ProjectHistorySearchResult extends SearchDocument {
	score: number;
	snippet: string;
	matchedTokens: string[];
}

export interface HistoryCommandOptions {
	query: string;
	role: ProjectHistoryRoleFilter;
	limit: number;
}

export interface HistoryCommandParseError {
	error: string;
}

export interface HistoryResultsSummary {
	query: string;
	role?: ProjectHistoryRoleFilter;
	searchedSessions?: number;
	searchedDocuments?: number;
	limit?: number;
	maxOutputChars?: number;
}

export interface ProjectHistoryPrompt extends SearchDocument {
	role: "user";
}

export interface PromptHistoryOptions {
	limit?: number;
	excludeSessionPath?: string | readonly string[];
}

export interface PromptHistorySink {
	addToHistory(text: string): void;
}

interface InternalDocument {
	entryId: string;
	timestamp?: Date;
	role: ProjectHistoryRole;
	text: string;
	lineNumber?: number;
}

const DEFAULT_HISTORY_LIMIT = 8;
const MAX_HISTORY_LIMIT = 50;
const DEFAULT_SNIPPET_LENGTH = 320;
const DEFAULT_MAX_OUTPUT_CHARS = 12_000;
const DEFAULT_PROMPT_HISTORY_LIMIT = 100;
const USAGE = "Usage: /history [--role user|assistant|all] [--limit 1-50] <query>";
const EXPANDED_SKILL_BLOCK_PATTERN =
	/(?:[ \t]*(?:\r?\n)){0,2}[ \t]*<skill\b[^>]*\bname=(["'])([^"']+)\1[^>]*>[\s\S]*?<\/skill>[ \t]*(?:(?:\r?\n)[ \t]*){0,2}/gi;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanOptionalString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function dateFromUnknown(value: unknown): Date | undefined {
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? undefined : new Date(value.getTime());
	}

	if (typeof value === "number") {
		if (!Number.isFinite(value)) return undefined;
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? undefined : date;
	}

	if (typeof value === "string") {
		const date = new Date(value);
		return Number.isNaN(date.getTime()) ? undefined : date;
	}

	return undefined;
}

function timeValue(date: Date | undefined): number {
	return date?.getTime() ?? 0;
}

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function splitHistoryQuery(query: string): string[] {
	return query
		.split(/\s+/)
		.map((part) => part.trim())
		.filter(Boolean);
}

function escapeRegExp(text: string): string {
	return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

interface CompiledHistoryQueryToken {
	token: string;
	regex: RegExp;
	globalRegex: RegExp;
}

function compileHistoryQueryToken(token: string): CompiledHistoryQueryToken {
	try {
		return {
			token,
			regex: new RegExp(token, "isu"),
			globalRegex: new RegExp(token, "gisu"),
		};
	} catch {
		const escaped = escapeRegExp(token);
		return {
			token,
			regex: new RegExp(escaped, "isu"),
			globalRegex: new RegExp(escaped, "gisu"),
		};
	}
}

function compileHistoryQueryTokens(tokens: readonly string[]): CompiledHistoryQueryToken[] {
	return tokens.map((token) => compileHistoryQueryToken(token));
}

function regexMatches(regex: RegExp, text: string): boolean {
	regex.lastIndex = 0;
	return regex.test(text);
}

function regexOccurrenceCount(regex: RegExp, text: string): number {
	let count = 0;
	regex.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(text)) !== null) {
		if (match[0].length === 0) {
			regex.lastIndex += 1;
			continue;
		}
		count += 1;
	}
	return count;
}

function scoreDocument(
	document: SearchDocument,
	queryTokens: readonly CompiledHistoryQueryToken[],
): { score: number; matchedTokens: string[] } | undefined {
	const text = document.text;
	if (!text.trim()) return undefined;
	if (queryTokens.length === 0) return { score: document.role === "user" ? 10 : 0, matchedTokens: [] };

	const matchedTokens = queryTokens.filter((token) => regexMatches(token.regex, text));
	if (matchedTokens.length === 0) return undefined;

	let score = matchedTokens.length * 100;
	for (const token of matchedTokens) {
		score += regexOccurrenceCount(token.globalRegex, text);
	}
	if (document.role === "user") score += 10;

	return { score, matchedTokens: matchedTokens.map((token) => token.token) };
}

function findFirstRegexMatchIndex(text: string, queryTokens: readonly CompiledHistoryQueryToken[]): number {
	let matchIndex = -1;
	for (const token of queryTokens) {
		token.globalRegex.lastIndex = 0;
		const match = token.globalRegex.exec(text);
		if (!match || match[0].length === 0) continue;
		if (matchIndex === -1 || match.index < matchIndex) matchIndex = match.index;
	}
	return matchIndex;
}

function createSnippet(text: string, queryTokens: readonly CompiledHistoryQueryToken[], maxLength: number): string {
	const compact = collapseWhitespace(text);
	const max = Math.max(20, Math.floor(maxLength));
	if (compact.length <= max) return compact;

	const matchIndex = Math.max(0, findFirstRegexMatchIndex(compact, queryTokens));
	const initialWindow = Math.max(1, max - 2);
	let start = Math.max(0, matchIndex - Math.floor(initialWindow / 2));
	let end = Math.min(compact.length, start + initialWindow);
	if (end === compact.length) start = Math.max(0, end - initialWindow);

	let prefix = start > 0 ? "…" : "";
	let suffix = end < compact.length ? "…" : "";
	const allowedWindow = Math.max(1, max - prefix.length - suffix.length);

	start = Math.max(0, matchIndex - Math.floor(allowedWindow / 2));
	end = Math.min(compact.length, start + allowedWindow);
	if (end - start < allowedWindow) start = Math.max(0, end - allowedWindow);

	prefix = start > 0 ? "…" : "";
	suffix = end < compact.length ? "…" : "";
	let snippet = `${prefix}${compact.slice(start, end)}${suffix}`;
	if (snippet.length > max) {
		snippet = `${snippet.slice(0, Math.max(0, max - 1))}…`;
	}
	return snippet;
}

interface MatchRange {
	start: number;
	end: number;
}

function findRegexMatchRanges(text: string, queryTokens: readonly CompiledHistoryQueryToken[]): MatchRange[] {
	const ranges: MatchRange[] = [];
	for (const token of queryTokens) {
		token.globalRegex.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = token.globalRegex.exec(text)) !== null) {
			if (match[0].length === 0) {
				token.globalRegex.lastIndex += 1;
				continue;
			}
			ranges.push({ start: match.index, end: match.index + match[0].length });
		}
	}

	return ranges
		.sort((a, b) => a.start - b.start || b.end - a.end)
		.reduce<MatchRange[]>((merged, range) => {
			const previous = merged[merged.length - 1];
			if (!previous || range.start > previous.end) {
				merged.push({ ...range });
				return merged;
			}
			previous.end = Math.max(previous.end, range.end);
			return merged;
		}, []);
}

export function highlightHistorySnippet(
	snippet: string,
	queryTokens: readonly string[],
	wrap: (text: string) => string,
): string {
	const compiledTokens = compileHistoryQueryTokens(queryTokens.filter((token) => token.trim().length > 0));
	if (compiledTokens.length === 0 || !snippet) return snippet;

	const ranges = findRegexMatchRanges(snippet, compiledTokens);
	if (ranges.length === 0) return snippet;

	const parts: string[] = [];
	let offset = 0;
	for (const range of ranges) {
		if (range.start > offset) parts.push(snippet.slice(offset, range.start));
		parts.push(wrap(snippet.slice(range.start, range.end)));
		offset = range.end;
	}
	if (offset < snippet.length) parts.push(snippet.slice(offset));
	return parts.join("");
}

export function collapseExpandedSkillReferences(text: string): string {
	return text
		.replace(
			EXPANDED_SKILL_BLOCK_PATTERN,
			(match: string, _quote: string, skillName: string, offset: number, fullText: string) => {
				const before = offset > 0 && !/\s$/.test(fullText.slice(0, offset)) ? " " : "";
				const afterIndex = offset + match.length;
				const after = afterIndex < fullText.length && !/^\s/.test(fullText.slice(afterIndex)) ? " " : "";
				return `${before}/skill:${skillName}${after}`;
			},
		)
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

export function extractMessageText(content: unknown): string {
	if (typeof content === "string") {
		return content.trim();
	}

	if (!Array.isArray(content)) {
		return "";
	}

	const parts: string[] = [];
	for (const part of content) {
		if (!isRecord(part)) continue;
		if (part.type === "text" && typeof part.text === "string") {
			const text = part.text.trim();
			if (text) parts.push(text);
		}
	}

	return parts.join("\n").trim();
}

export function parseSessionFileText(text: string, session: ProjectHistorySession): SearchDocument[] {
	let sessionId = session.id;
	let sessionCwd = cleanOptionalString(session.cwd);
	let sessionName = cleanOptionalString(session.name);
	const sessionCreated = dateFromUnknown(session.created);
	const sessionModified = dateFromUnknown(session.modified);
	const sessionFirstMessage = cleanOptionalString(session.firstMessage);
	const documents: InternalDocument[] = [];

	const lines = text.split(/\r?\n/);
	for (const [index, rawLine] of lines.entries()) {
		const line = rawLine.trim();
		if (!line) continue;

		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(entry)) continue;

		if (entry.type === "session") {
			const headerId = cleanOptionalString(entry.id);
			const headerCwd = cleanOptionalString(entry.cwd);
			if (headerId) sessionId = headerId;
			if (headerCwd) sessionCwd = headerCwd;
			continue;
		}

		if (entry.type === "session_info") {
			sessionName = cleanOptionalString(entry.name);
			continue;
		}

		if (entry.type !== "message" || !isRecord(entry.message)) continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;

		const extractedText = extractMessageText(entry.message.content);
		const messageText = role === "user" ? collapseExpandedSkillReferences(extractedText) : extractedText;
		if (!messageText) continue;

		const entryId = cleanOptionalString(entry.id) ?? `line-${index + 1}`;
		const timestamp = dateFromUnknown(entry.timestamp) ?? dateFromUnknown(entry.message.timestamp);
		const internalDocument: InternalDocument = {
			entryId,
			role,
			text: messageText,
			lineNumber: index + 1,
		};
		if (timestamp) internalDocument.timestamp = timestamp;
		documents.push(internalDocument);
	}

	return documents.map((document) => {
		const searchDocument: SearchDocument = {
			sessionPath: session.path,
			sessionId,
			entryId: document.entryId,
			role: document.role,
			text: document.text,
		};
		if (sessionName) searchDocument.sessionName = sessionName;
		if (sessionCwd) searchDocument.sessionCwd = sessionCwd;
		if (sessionCreated) searchDocument.sessionCreated = sessionCreated;
		if (sessionModified) searchDocument.sessionModified = sessionModified;
		if (sessionFirstMessage) searchDocument.sessionFirstMessage = sessionFirstMessage;
		if (document.timestamp) searchDocument.timestamp = document.timestamp;
		if (document.lineNumber !== undefined) searchDocument.lineNumber = document.lineNumber;
		return searchDocument;
	});
}

function documentChronologyValue(document: SearchDocument): number {
	return timeValue(document.timestamp) || timeValue(document.sessionModified) || timeValue(document.sessionCreated);
}

export function searchHistoryDocuments(
	documents: readonly SearchDocument[],
	options: ProjectHistorySearchOptions,
): ProjectHistorySearchResult[] {
	const role = options.role ?? "user";
	const limit = Math.min(Math.max(1, Math.floor(options.limit ?? DEFAULT_HISTORY_LIMIT)), MAX_HISTORY_LIMIT);
	const maxSnippetLength = Math.max(20, Math.floor(options.maxSnippetLength ?? DEFAULT_SNIPPET_LENGTH));
	const queryTokens = splitHistoryQuery(options.query);
	const compiledTokens = compileHistoryQueryTokens(queryTokens);

	return documents
		.filter((document) => role === "all" || document.role === role)
		.map((document) => {
			const scored = scoreDocument(document, compiledTokens);
			if (!scored) return undefined;
			const result: ProjectHistorySearchResult = {
				...document,
				score: scored.score,
				snippet: createSnippet(document.text, compiledTokens, maxSnippetLength),
				matchedTokens: scored.matchedTokens,
			};
			return result;
		})
		.filter((result): result is ProjectHistorySearchResult => result !== undefined)
		.sort(
			(a, b) =>
				documentChronologyValue(b) - documentChronologyValue(a) ||
				(b.lineNumber ?? 0) - (a.lineNumber ?? 0) ||
				a.sessionPath.localeCompare(b.sessionPath) ||
				a.entryId.localeCompare(b.entryId),
		)
		.slice(0, limit);
}

function excludedSessionPaths(value: string | readonly string[] | undefined): Set<string> {
	if (value === undefined) return new Set();
	return new Set((Array.isArray(value) ? value : [value]).filter((path) => path.trim().length > 0));
}

export function collectUserPromptHistory(
	documents: readonly SearchDocument[],
	options: PromptHistoryOptions = {},
): ProjectHistoryPrompt[] {
	const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_PROMPT_HISTORY_LIMIT));
	const excludedPaths = excludedSessionPaths(options.excludeSessionPath);
	const seenText = new Set<string>();
	const prompts: ProjectHistoryPrompt[] = [];

	const newestFirst = documents
		.filter((document) => document.role === "user" && !excludedPaths.has(document.sessionPath) && document.text.trim())
		.sort(
			(a, b) =>
				documentChronologyValue(b) - documentChronologyValue(a) ||
				b.sessionPath.localeCompare(a.sessionPath) ||
				b.entryId.localeCompare(a.entryId),
		);

	for (const document of newestFirst) {
		const text = document.text.trim();
		if (seenText.has(text)) continue;
		seenText.add(text);
		prompts.push({ ...document, role: "user", text });
		if (prompts.length >= limit) break;
	}

	return prompts;
}

export function seedPromptHistory(sink: PromptHistorySink, promptsNewestFirst: readonly ProjectHistoryPrompt[]): void {
	for (let index = promptsNewestFirst.length - 1; index >= 0; index -= 1) {
		const prompt = promptsNewestFirst[index];
		if (!prompt?.text.trim()) continue;
		sink.addToHistory(prompt.text);
	}
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}

function formatTimestamp(date: Date | undefined): string {
	return date ? date.toISOString() : "unknown time";
}

function resultSessionLabel(result: ProjectHistorySearchResult): string {
	return result.sessionName ? `${result.sessionName} (${result.sessionId})` : result.sessionId;
}

export function formatHistoryResults(
	results: readonly ProjectHistorySearchResult[],
	summary: HistoryResultsSummary,
): string {
	const role = summary.role ?? "user";
	const sessions = summary.searchedSessions === undefined ? undefined : plural(summary.searchedSessions, "session");
	const documents =
		summary.searchedDocuments === undefined ? undefined : plural(summary.searchedDocuments, "message");
	const scope = [sessions, documents].filter((part): part is string => part !== undefined).join(", ");
	const headerSuffix = scope ? ` across ${scope}` : "";

	if (results.length === 0) {
		return `No project history matches for "${summary.query}" (role: ${role})${headerSuffix}.\n${USAGE}`;
	}

	const lines = [`Project history matches for "${summary.query}" (role: ${role})${headerSuffix}:`];
	for (const [index, result] of results.entries()) {
		lines.push(
			`${index + 1}. ${resultSessionLabel(result)} — ${formatTimestamp(result.timestamp)} — role=${result.role} entry=${result.entryId} score=${result.score}`,
		);
		lines.push(`   path: ${result.sessionPath}`);
		if (result.lineNumber !== undefined) lines.push(`   line: ${result.lineNumber}`);
		lines.push(`   snippet: ${result.snippet}`);
	}

	const output = lines.join("\n");
	const maxOutputChars = Math.max(500, Math.floor(summary.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS));
	if (output.length <= maxOutputChars) return output;

	return `${output.slice(0, maxOutputChars - 80)}\n…\n[project history output truncated to ${maxOutputChars} characters]`;
}

function splitCommandArgs(args: string): string[] | HistoryCommandParseError {
	const words: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaping = false;

	for (const char of args) {
		if (escaping) {
			current += char;
			escaping = false;
			continue;
		}

		if (char === "\\" && quote !== "'") {
			escaping = true;
			continue;
		}

		if (quote) {
			if (char === quote) {
				quote = undefined;
			} else {
				current += char;
			}
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}

		if (/\s/.test(char)) {
			if (current) {
				words.push(current);
				current = "";
			}
			continue;
		}

		current += char;
	}

	if (escaping) current += "\\";
	if (quote) return { error: `Unclosed quote in history arguments. ${USAGE}` };
	if (current) words.push(current);
	return words;
}

function parseRole(value: string): ProjectHistoryRoleFilter | undefined {
	const normalized = value.toLowerCase();
	if (normalized === "user" || normalized === "assistant" || normalized === "all") return normalized;
	return undefined;
}

function parseLimit(value: string): number | undefined {
	if (!/^\d+$/.test(value)) return undefined;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_HISTORY_LIMIT) return undefined;
	return parsed;
}

export function parseHistoryCommandArgs(args: string): HistoryCommandOptions | HistoryCommandParseError {
	const wordsOrError = splitCommandArgs(args);
	if (!Array.isArray(wordsOrError)) return wordsOrError;

	let role: ProjectHistoryRoleFilter = "user";
	let limit = DEFAULT_HISTORY_LIMIT;
	const queryParts: string[] = [];
	let endOfOptions = false;

	for (let index = 0; index < wordsOrError.length; index += 1) {
		const word = wordsOrError[index];
		if (word === undefined) continue;

		if (endOfOptions || !word.startsWith("--")) {
			queryParts.push(word);
			continue;
		}

		if (word === "--") {
			endOfOptions = true;
			continue;
		}

		if (word === "--role") {
			const value = wordsOrError[index + 1];
			if (value === undefined) return { error: `Missing value for --role. ${USAGE}` };
			const parsed = parseRole(value);
			if (!parsed) return { error: `Invalid role "${value}". ${USAGE}` };
			role = parsed;
			index += 1;
			continue;
		}

		if (word.startsWith("--role=")) {
			const value = word.slice("--role=".length);
			const parsed = parseRole(value);
			if (!parsed) return { error: `Invalid role "${value}". ${USAGE}` };
			role = parsed;
			continue;
		}

		if (word === "--limit") {
			const value = wordsOrError[index + 1];
			if (value === undefined) return { error: `Missing value for --limit. ${USAGE}` };
			const parsed = parseLimit(value);
			if (parsed === undefined) return { error: `Invalid limit "${value}". ${USAGE}` };
			limit = parsed;
			index += 1;
			continue;
		}

		if (word.startsWith("--limit=")) {
			const value = word.slice("--limit=".length);
			const parsed = parseLimit(value);
			if (parsed === undefined) return { error: `Invalid limit "${value}". ${USAGE}` };
			limit = parsed;
			continue;
		}

		return { error: `Unknown history option "${word}". ${USAGE}` };
	}

	return {
		query: queryParts.join(" ").trim(),
		role,
		limit,
	};
}
