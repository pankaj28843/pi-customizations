import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	formatHistoryResults,
	parseHistoryCommandArgs,
	parseSessionFileText,
	searchHistoryDocuments,
	type ProjectHistoryRoleFilter,
	type ProjectHistorySearchResult,
	type ProjectHistorySession,
	type SearchDocument,
} from "../project-history.js";

const STATUS_KEY = "pi-customizations-project-history";
const DEFAULT_TOOL_LIMIT = 8;
const MAX_TOOL_LIMIT = 50;
const TOOL_MAX_OUTPUT_CHARS = 10_000;

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

function formatResultChoice(result: ProjectHistorySearchResult, index: number): string {
	const sessionLabel = result.sessionName ?? result.sessionId;
	const timestamp = result.timestamp?.toISOString().slice(0, 10) ?? "unknown";
	return compactLabel(
		`${index + 1}. ${sessionLabel} ${timestamp} ${result.role} entry=${result.entryId}: ${result.snippet}`,
		180,
	);
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

function buildInjectedHistoryContent(result: ProjectHistorySearchResult, query: string): string {
	const title = result.sessionName ? `${result.sessionName} (${result.sessionId})` : result.sessionId;
	return [
		`Project history match for query: ${query}`,
		`Session: ${title}`,
		`Session path: ${result.sessionPath}`,
		`Entry: ${result.entryId}`,
		`Role: ${result.role}`,
		`Timestamp: ${result.timestamp?.toISOString() ?? "unknown"}`,
		"",
		"Snippet:",
		result.snippet,
	].join("\n");
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

	let query = parsed.query;
	if (!query) {
		if (!ctx.hasUI) {
			notifyOrPrint(ctx, "Usage: /history [--role user|assistant|all] [--limit 1-50] <query>", "info");
			return undefined;
		}

		const prompted = await ctx.ui.input("Search project history", "What should pi remember from this project?");
		query = prompted?.trim() ?? "";
		if (!query) return undefined;
	}

	return {
		query,
		role: parsed.role,
		limit: parsed.limit,
		includeCurrentSession: true,
	};
}

async function handleInteractiveActions(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	query: string,
	results: readonly ProjectHistorySearchResult[],
): Promise<void> {
	const choices = results.map((result, index) => formatResultChoice(result, index));
	const selectedChoice = await ctx.ui.select("Project history matches", choices);
	if (!selectedChoice) return;

	const selectedIndex = choices.indexOf(selectedChoice);
	const selected = selectedIndex >= 0 ? results[selectedIndex] : undefined;
	if (!selected) return;

	const action = await ctx.ui.select("History action", ["Inject into next turn", "Switch to session", "Cancel"]);
	if (action === "Inject into next turn") {
		const content = buildInjectedHistoryContent(selected, query);
		pi.sendMessage(
			{
				customType: "project-history",
				content,
				display: true,
				details: { query, result: serializeResult(selected) },
			},
			{ deliverAs: "nextTurn" },
		);
		ctx.ui.setEditorText("Using the project history above, ");
		ctx.ui.notify("Project history snippet queued for the next turn.", "info");
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

export default function projectHistoryExtension(pi: ExtensionAPI): void {
	const cache = new Map<string, CachedSessionDocuments>();

	pi.registerCommand("history", {
		description: "Search saved pi sessions for this project. Usage: /history [--role user|assistant|all] [--limit 1-50] <query>",
		handler: async (args, ctx) => {
			const options = await promptForQuery(args, ctx);
			if (!options) return;

			const { loaded, results, formatted } = await runSearch(ctx, cache, options);
			if (!ctx.hasUI) {
				notifyOrPrint(ctx, formatted, "info");
				return;
			}

			if (results.length === 0) {
				ctx.ui.notify(formatted, "info");
				return;
			}

			ctx.ui.notify(
				`Found ${results.length} project history match(es) across ${loaded.sessions.length} session(s).`,
				"info",
			);
			await handleInteractiveActions(pi, ctx, options.query, results);
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
