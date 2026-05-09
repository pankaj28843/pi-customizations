import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import {
	SessionManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type KeybindingsManager,
	type SessionInfo,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Input, truncateToWidth, visibleWidth, type AutocompleteItem, type Component, type Focusable } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { InlineSlashAutocompleteEditor } from "../inline-skill-slash.js";
import {
	collectUserPromptHistory,
	formatHistoryResults,
	highlightHistorySnippet,
	parseHistoryCommandArgs,
	parseSessionFileText,
	searchHistoryDocuments,
	seedPromptHistory,
	splitHistoryQuery,
	type ProjectHistoryPrompt,
	type ProjectHistoryRoleFilter,
	type ProjectHistorySearchResult,
	type ProjectHistorySession,
	type SearchDocument,
} from "../project-history.js";

const STATUS_KEY = "pi-customizations-project-history";
const PROMPT_HISTORY_STATUS_KEY = "pi-customizations-project-history-prompts";
const DEFAULT_TOOL_LIMIT = 8;
const MAX_TOOL_LIMIT = 50;
const TOOL_MAX_OUTPUT_CHARS = 10_000;
const EDITOR_PROMPT_HISTORY_LIMIT = 100;
const COMMAND_COMPLETION_LIMIT = 20;
const HISTORY_PICKER_SNIPPET_LENGTH = 420;

const ProjectHistorySearchParams = Type.Object({
	query: Type.String({ description: "Text to search for in saved pi sessions for the current project." }),
	role: Type.Optional(Type.String({ description: "Role filter: user, assistant, or all. Defaults to user." })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return. Defaults to 8, maximum 50." })),
	includeCurrentSession: Type.Optional(
		Type.Boolean({ description: "Whether to include the currently open session file. Defaults to true." }),
	),
});

interface CachedSessionDocuments {
	modifiedMs: number;
	size: number;
	documents: SearchDocument[];
}

interface LoadedHistory {
	sessions: SessionInfo[];
	documents: SearchDocument[];
	skipped: number;
}

interface ToolSearchOptions {
	query: string;
	role: ProjectHistoryRoleFilter;
	limit: number;
	includeCurrentSession: boolean;
}

interface HistorySearchDetails {
	query: string;
	role: ProjectHistoryRoleFilter;
	limit: number;
	searchedSessions: number;
	searchedDocuments: number;
	skippedSessions: number;
	results: Array<ReturnType<typeof serializeResult>>;
}

function sessionToProjectHistorySession(session: SessionInfo): ProjectHistorySession {
	const converted: ProjectHistorySession = {
		path: session.path,
		id: session.id,
		cwd: session.cwd,
		created: session.created,
		modified: session.modified,
		firstMessage: session.firstMessage,
	};
	if (session.name) converted.name = session.name;
	return converted;
}

function setStatus(ctx: ExtensionContext, text: string | undefined): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, text ? ctx.ui.theme.fg("dim", text) : undefined);
}

function notifyOrPrint(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
		return;
	}

	const stream = type === "error" ? console.error : console.log;
	stream(message);
}

function compactLabel(text: string, maxLength: number): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= maxLength) return compact;
	return `${compact.slice(0, Math.max(0, maxLength - 1))}…`;
}

function compactCompletionValue(text: string, maxLength: number): string {
	const compact = text.replace(/\s+/g, " ").trim();
	return compact.length <= maxLength ? compact : compact.slice(0, maxLength).trimEnd();
}

function serializeResult(result: ProjectHistorySearchResult) {
	return {
		sessionPath: result.sessionPath,
		sessionId: result.sessionId,
		sessionName: result.sessionName,
		entryId: result.entryId,
		role: result.role,
		timestamp: result.timestamp?.toISOString(),
		lineNumber: result.lineNumber,
		score: result.score,
		snippet: result.snippet,
		matchedTokens: result.matchedTokens,
	};
}

function normalizeToolParams(params: {
	query: string;
	role?: string;
	limit?: number;
	includeCurrentSession?: boolean;
}): ToolSearchOptions {
	const query = params.query.trim();
	const normalizedRole = (params.role ?? "user").toLowerCase();
	if (normalizedRole !== "user" && normalizedRole !== "assistant" && normalizedRole !== "all") {
		throw new Error(`Invalid role "${params.role}". Use user, assistant, or all.`);
	}

	const requestedLimit = params.limit ?? DEFAULT_TOOL_LIMIT;
	if (!Number.isFinite(requestedLimit)) {
		throw new Error("Invalid limit. Use a number from 1 to 50.");
	}
	const limit = Math.min(Math.max(1, Math.floor(requestedLimit)), MAX_TOOL_LIMIT);

	return {
		query,
		role: normalizedRole,
		limit,
		includeCurrentSession: params.includeCurrentSession !== false,
	};
}

async function readSessionDocuments(
	session: SessionInfo,
	cache: Map<string, CachedSessionDocuments>,
): Promise<{ documents: SearchDocument[]; skipped: boolean }> {
	let metadata;
	try {
		metadata = await stat(session.path);
	} catch {
		return { documents: [], skipped: true };
	}

	const modifiedMs = Math.max(session.modified.getTime(), metadata.mtimeMs);
	const size = metadata.size;
	const cached = cache.get(session.path);
	if (cached && cached.modifiedMs === modifiedMs && cached.size === size) {
		return { documents: cached.documents, skipped: false };
	}

	try {
		const content = await readFile(session.path, "utf8");
		const documents = parseSessionFileText(content, sessionToProjectHistorySession(session));
		cache.set(session.path, { modifiedMs, size, documents });
		return { documents, skipped: false };
	} catch {
		return { documents: [], skipped: true };
	}
}

async function loadProjectHistory(
	ctx: ExtensionContext,
	cache: Map<string, CachedSessionDocuments>,
	options: { includeCurrentSession: boolean } = { includeCurrentSession: true },
): Promise<LoadedHistory> {
	const currentSessionPath = ctx.sessionManager.getSessionFile();
	const sessions = await SessionManager.list(ctx.cwd, ctx.sessionManager.getSessionDir(), (loaded, total) => {
		setStatus(ctx, `history ${loaded}/${total}`);
	});
	const scopedSessions = sessions.filter(
		(session) => options.includeCurrentSession || !currentSessionPath || session.path !== currentSessionPath,
	);

	const documents: SearchDocument[] = [];
	let skipped = sessions.length - scopedSessions.length;
	for (const session of scopedSessions) {
		const loaded = await readSessionDocuments(session, cache);
		if (loaded.skipped) {
			skipped += 1;
			continue;
		}
		documents.push(...loaded.documents);
	}

	return { sessions: scopedSessions, documents, skipped };
}

async function runSearch(
	ctx: ExtensionContext,
	cache: Map<string, CachedSessionDocuments>,
	options: ToolSearchOptions,
): Promise<{ loaded: LoadedHistory; results: ProjectHistorySearchResult[]; formatted: string }> {
	setStatus(ctx, "history search");
	try {
		const loaded = await loadProjectHistory(ctx, cache, { includeCurrentSession: options.includeCurrentSession });
		const results = searchHistoryDocuments(loaded.documents, {
			query: options.query,
			role: options.role,
			limit: options.limit,
		});
		const formatted = formatHistoryResults(results, {
			query: options.query,
			role: options.role,
			searchedSessions: loaded.sessions.length,
			searchedDocuments: loaded.documents.length,
			limit: options.limit,
			maxOutputChars: TOOL_MAX_OUTPUT_CHARS,
		});
		return { loaded, results, formatted };
	} finally {
		setStatus(ctx, undefined);
	}
}

async function promptForQuery(args: string, ctx: ExtensionCommandContext): Promise<ToolSearchOptions | undefined> {
	const parsed = parseHistoryCommandArgs(args);
	if ("error" in parsed) {
		notifyOrPrint(ctx, parsed.error, "error");
		return undefined;
	}

	return {
		query: parsed.query,
		role: parsed.role,
		limit: parsed.limit,
		includeCurrentSession: true,
	};
}

function padToWidth(line: string, width: number): string {
	return `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`;
}

function formatHistoryResultMetadata(result: ProjectHistorySearchResult): string {
	const sessionLabel = result.sessionName ?? result.sessionId;
	const timestamp = result.timestamp?.toISOString().replace("T", " ").slice(0, 16) ?? "unknown time";
	return `${timestamp} ${result.role} ${sessionLabel} entry=${result.entryId}`;
}

class ProjectHistorySearchPicker implements Component, Focusable {
	private readonly input = new Input();
	private results: ProjectHistorySearchResult[] = [];
	private selectedIndex = 0;
	private readonly maxVisible = 8;
	private lastQuery = "";

	constructor(
		private readonly documents: readonly SearchDocument[],
		private readonly options: Pick<ToolSearchOptions, "role" | "limit" | "query">,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly done: (result: ProjectHistorySearchResult | null) => void,
		private readonly requestRender: () => void,
	) {
		this.input.setValue(options.query);
		this.input.onEscape = () => this.done(null);
		this.refreshResults(true);
	}

	get focused(): boolean {
		return this.input.focused;
	}

	set focused(value: boolean) {
		this.input.focused = value;
	}

	invalidate(): void {
		this.input.invalidate();
	}

	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.done(null);
			return;
		}

		if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.done(this.results[this.selectedIndex] ?? null);
			return;
		}

		if (this.keybindings.matches(data, "tui.select.up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.requestRender();
			return;
		}

		if (this.keybindings.matches(data, "tui.select.down")) {
			this.selectedIndex = Math.min(Math.max(0, this.results.length - 1), this.selectedIndex + 1);
			this.requestRender();
			return;
		}

		if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
			this.requestRender();
			return;
		}

		if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.selectedIndex = Math.min(Math.max(0, this.results.length - 1), this.selectedIndex + this.maxVisible);
			this.requestRender();
			return;
		}

		const before = this.input.getValue();
		this.input.handleInput(data);
		if (this.input.getValue() !== before) {
			this.refreshResults(true);
		}
		this.requestRender();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(20, width);
		const queryTokens = splitHistoryQuery(this.input.getValue());
		const lines = [
			this.theme.fg("accent", this.theme.bold("Project History")),
			this.theme.fg("dim", `Type regex tokens separated by spaces (OR). Results are newest first.`),
			...this.input.render(safeWidth),
			this.theme.fg("dim", "↑↓ select · type to filter · enter choose · esc cancel"),
			this.theme.fg("dim", `role=${this.options.role} · ${this.results.length} shown`),
		];

		if (this.results.length === 0) {
			lines.push(this.theme.fg("warning", "No matching project history prompts."));
			return lines.map((line) => truncateToWidth(line, safeWidth, "…"));
		}

		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.results.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.results.length);

		for (let index = startIndex; index < endIndex; index += 1) {
			const result = this.results[index];
			if (!result) continue;
			const selected = index === this.selectedIndex;
			const prefix = selected ? this.theme.fg("accent", "› ") : "  ";
			const metadata = truncateToWidth(`${prefix}${formatHistoryResultMetadata(result)}`, safeWidth, "…");
			const highlightedSnippet = highlightHistorySnippet(result.snippet, queryTokens, (text) =>
				this.theme.fg("accent", this.theme.bold(text)),
			);
			const snippet = truncateToWidth(`  ${highlightedSnippet}`, safeWidth, "…");
			lines.push(selected ? this.theme.bg("selectedBg", padToWidth(metadata, safeWidth)) : metadata);
			lines.push(selected ? this.theme.bg("selectedBg", padToWidth(snippet, safeWidth)) : snippet);
		}

		if (startIndex > 0 || endIndex < this.results.length) {
			lines.push(this.theme.fg("dim", `(${this.selectedIndex + 1}/${this.results.length})`));
		}

		return lines.map((line) => truncateToWidth(line, safeWidth, "…"));
	}

	private refreshResults(resetSelection: boolean): void {
		const query = this.input.getValue();
		this.results = searchHistoryDocuments(this.documents, {
			query,
			role: this.options.role,
			limit: this.options.limit,
			maxSnippetLength: HISTORY_PICKER_SNIPPET_LENGTH,
		});

		if (resetSelection || query !== this.lastQuery) {
			this.selectedIndex = 0;
		} else {
			this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.results.length - 1));
		}
		this.lastQuery = query;
	}
}

async function pickHistoryResult(
	ctx: ExtensionCommandContext,
	documents: readonly SearchDocument[],
	options: Pick<ToolSearchOptions, "role" | "limit" | "query">,
): Promise<ProjectHistorySearchResult | null> {
	return ctx.ui.custom<ProjectHistorySearchResult | null>((tui, theme, keybindings, done) =>
		new ProjectHistorySearchPicker(documents, options, theme, keybindings, done, () => tui.requestRender()),
	);
}

async function handleSelectedHistoryAction(
	ctx: ExtensionCommandContext,
	selected: ProjectHistorySearchResult,
): Promise<void> {
	const restoreAction = selected.role === "user" ? "Restore prompt to editor" : "Copy message text to editor";
	const action = await ctx.ui.select("History action", [restoreAction, "Switch to session", "Cancel"]);
	if (action === restoreAction) {
		ctx.ui.setEditorText(selected.text);
		ctx.ui.notify(
			selected.role === "user"
				? "Restored project history prompt to the editor."
				: "Copied project history message text to the editor.",
			"info",
		);
		return;
	}

	if (action === "Switch to session") {
		await ctx.waitForIdle();
		const sessionName = selected.sessionName ?? basename(selected.sessionPath);
		const result = await ctx.switchSession(selected.sessionPath, {
			withSession: async (nextCtx) => {
				if (nextCtx.hasUI) nextCtx.ui.notify(`Switched to history session: ${sessionName}`, "info");
			},
		});
		if (result.cancelled && ctx.hasUI) {
			ctx.ui.notify("Session switch cancelled by another extension.", "warning");
		}
	}
}

function historyArgumentCompletions(
	query: string,
	promptHistory: readonly ProjectHistoryPrompt[],
): AutocompleteItem[] | null {
	const results = searchHistoryDocuments(promptHistory, {
		query,
		role: "user",
		limit: COMMAND_COMPLETION_LIMIT,
		maxSnippetLength: 160,
	});
	if (results.length === 0) return null;

	return results.map((result) => {
		const value = compactCompletionValue(result.text, 240);
		return {
			value,
			label: compactLabel(result.text, 80),
			description: formatHistoryResultMetadata(result),
		};
	});
}

export default function projectHistoryExtension(pi: ExtensionAPI): void {
	const cache = new Map<string, CachedSessionDocuments>();
	let promptHistoryCompletions: ProjectHistoryPrompt[] = [];

	pi.on("session_start", async (event, ctx) => {
		if (!ctx.hasUI) return;

		setStatus(ctx, "history prompts");
		try {
			const includeCurrentSession = event.reason === "reload";
			const loaded = await loadProjectHistory(ctx, cache, { includeCurrentSession });
			const promptHistory = collectUserPromptHistory(loaded.documents, {
				limit: EDITOR_PROMPT_HISTORY_LIMIT,
			});
			promptHistoryCompletions = promptHistory;
			const previousEditorFactory = ctx.ui.getEditorComponent();

			ctx.ui.setEditorComponent((tui, theme, keybindings) => {
				const editor = previousEditorFactory
					? previousEditorFactory(tui, theme, keybindings)
					: new InlineSlashAutocompleteEditor(tui, theme, keybindings, () => pi.getCommands());
				const addToHistory = editor.addToHistory?.bind(editor);
				if (addToHistory) seedPromptHistory({ addToHistory }, promptHistory);
				return editor;
			});

			ctx.ui.setStatus(
				PROMPT_HISTORY_STATUS_KEY,
				promptHistory.length > 0 ? ctx.ui.theme.fg("dim", `history ↑↓ ${promptHistory.length}`) : undefined,
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Project history prompt history unavailable: ${message}`, "warning");
			ctx.ui.setStatus(PROMPT_HISTORY_STATUS_KEY, undefined);
		} finally {
			setStatus(ctx, undefined);
		}
	});

	pi.registerCommand("history", {
		description: "Search saved pi sessions for this project. Usage: /history [--role user|assistant|all] [--limit 1-50] <query>",
		getArgumentCompletions: (prefix) => historyArgumentCompletions(prefix, promptHistoryCompletions),
		handler: async (args, ctx) => {
			const options = await promptForQuery(args, ctx);
			if (!options) return;

			if (!ctx.hasUI) {
				const { formatted } = await runSearch(ctx, cache, options);
				notifyOrPrint(ctx, formatted, "info");
				return;
			}

			setStatus(ctx, "history search");
			let loaded: LoadedHistory;
			try {
				loaded = await loadProjectHistory(ctx, cache, { includeCurrentSession: options.includeCurrentSession });
			} finally {
				setStatus(ctx, undefined);
			}

			if (loaded.documents.length === 0) {
				ctx.ui.notify("No project history messages found for this project.", "info");
				return;
			}

			const selected = await pickHistoryResult(ctx, loaded.documents, options);
			if (!selected) return;
			await handleSelectedHistoryAction(ctx, selected);
		},
	});

	pi.registerTool({
		name: "project_history_search",
		label: "Project History Search",
		description:
			"Search saved local pi session JSONL files for the current project. Returns bounded snippets with session and entry metadata.",
		promptSnippet: "Search local saved pi session history for this current project.",
		promptGuidelines: [
			"Use project_history_search only when the user asks about prior pi conversations, saved asks, or project-session recall.",
			"Do not use project_history_search for code search, documentation lookup, web research, or facts not present in local pi session history.",
			"When using project_history_search, summarize bounded snippets and cite session id, entry id, role, and timestamp from the results.",
		],
		parameters: ProjectHistorySearchParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const options = normalizeToolParams(params);
			if (!options.query) {
				return {
					content: [{ type: "text", text: "project_history_search requires a non-empty query." }],
					details: {
						query: options.query,
						role: options.role,
						limit: options.limit,
						searchedSessions: 0,
						searchedDocuments: 0,
						skippedSessions: 0,
						results: [],
					} satisfies HistorySearchDetails,
				};
			}

			onUpdate?.({ content: [{ type: "text", text: "Searching local project pi session history..." }], details: undefined });
			if (signal?.aborted) {
				return {
					content: [{ type: "text", text: "project_history_search cancelled before reading session history." }],
					details: {
						query: options.query,
						role: options.role,
						limit: options.limit,
						searchedSessions: 0,
						searchedDocuments: 0,
						skippedSessions: 0,
						results: [],
					} satisfies HistorySearchDetails,
				};
			}

			const { loaded, results, formatted } = await runSearch(ctx, cache, options);
			return {
				content: [{ type: "text", text: formatted }],
				details: {
					query: options.query,
					role: options.role,
					limit: options.limit,
					searchedSessions: loaded.sessions.length,
					searchedDocuments: loaded.documents.length,
					skippedSessions: loaded.skipped,
					results: results.map((result) => serializeResult(result)),
				} satisfies HistorySearchDetails,
			};
		},
	});
}
