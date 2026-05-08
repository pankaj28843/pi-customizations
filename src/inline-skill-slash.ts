import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	AutocompleteSuggestions,
	EditorOptions,
	EditorTheme,
	TUI,
} from "@earendil-works/pi-tui";
import { CustomEditor, type KeybindingsManager, type SlashCommandInfo } from "@earendil-works/pi-coding-agent";

const SKILL_COMMAND_PREFIX = "skill:";
const INLINE_SKILL_TOKEN_PATTERN = /(^|\s)\/skill:([a-z0-9-]+)(?=$|\s)/g;
const COMMAND_CHARACTER_PATTERN = /^[a-zA-Z0-9.:_-]$/;
const FRONTMATTER_PATTERN = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

export interface SlashTokenContext {
	token: string;
	query: string;
}

export type CommandProvider = () => readonly SlashCommandInfo[];

type PrivateAutocompleteEditor = {
	autocompletePrefix?: string;
	tryTriggerAutocomplete?: () => void;
	handleSlashCommandCompletion?: () => void;
	forceFileAutocomplete?: (explicitTab?: boolean) => void;
};

export function extractSlashLikeToken(textBeforeCursor: string): string | undefined {
	const match = textBeforeCursor.match(/(?:^|[ \t])(\/[^\s]*)$/);
	return match?.[1];
}

export function extractSlashTokenContext(textBeforeCursor: string): SlashTokenContext | undefined {
	const token = extractSlashLikeToken(textBeforeCursor);
	if (!token) return undefined;

	// Treat tokens containing another slash as path/URL-like, not command-like.
	if (token.slice(1).includes("/")) return undefined;

	return {
		token,
		query: token.slice(1),
	};
}

export function stripFrontmatter(content: string): string {
	return content.replace(FRONTMATTER_PATTERN, "");
}

export function getInlineSlashCommands(getCommands: CommandProvider): AutocompleteItem[] {
	return getCommands().map((command) => ({
		value: command.name,
		label: command.name,
		...(command.description && { description: command.description }),
	}));
}

function tokenizeCommandText(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

function commandSearchAliases(item: AutocompleteItem): string[] {
	const aliases = new Set([item.value.toLowerCase(), item.label.toLowerCase()]);

	for (const alias of [...aliases]) {
		const colonIndex = alias.indexOf(":");
		if (colonIndex !== -1 && colonIndex < alias.length - 1) {
			aliases.add(alias.slice(colonIndex + 1));
		}
	}

	return [...aliases];
}

function slashCommandMatchScore(item: AutocompleteItem, query: string): number | undefined {
	const aliases = commandSearchAliases(item);
	let bestScore: number | undefined;
	const recordScore = (score: number): void => {
		bestScore = bestScore === undefined ? score : Math.min(bestScore, score);
	};

	for (const alias of aliases) {
		if (alias === query) recordScore(0);
		else if (alias.startsWith(query)) recordScore(10);
	}

	const tokens = new Set(aliases.flatMap(tokenizeCommandText));
	for (const token of tokens) {
		if (token === query) recordScore(20);
		else if (token.startsWith(query)) recordScore(30);
	}

	return bestScore;
}

export function filterSlashCommands(commands: readonly AutocompleteItem[], query: string): AutocompleteItem[] {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) return commands.slice(0, 20);

	return commands
		.map((item, index) => ({ item, index, score: slashCommandMatchScore(item, normalizedQuery) }))
		.filter((entry): entry is { item: AutocompleteItem; index: number; score: number } => entry.score !== undefined)
		.sort((a, b) => a.score - b.score || a.index - b.index)
		.slice(0, 20)
		.map((entry) => entry.item);
}

function getSlashCommandSuggestions(
	getCommands: CommandProvider,
	context: SlashTokenContext,
): AutocompleteSuggestions | null {
	const filtered = filterSlashCommands(getInlineSlashCommands(getCommands), context.query);
	if (filtered.length === 0) return null;

	return {
		items: filtered,
		prefix: context.token,
	};
}

function isSlashCommandCompletion(prefix: string, item: AutocompleteItem): boolean {
	return prefix.startsWith("/") && !prefix.slice(1).includes("/") && !item.value.startsWith("/");
}

export function createInlineSlashAutocompleteProvider(
	current: AutocompleteProvider,
	getCommands: CommandProvider,
): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const currentLine = lines[cursorLine] ?? "";
			const textBeforeCursor = currentLine.slice(0, cursorCol);
			const context = extractSlashTokenContext(textBeforeCursor);

			// Inline slash-command autocomplete is command-first only when a real command matches.
			// Otherwise, delegate so forced Tab remains useful for absolute paths like /tmp/foo.
			if (context) {
				const suggestions = getSlashCommandSuggestions(getCommands, context);
				if (suggestions) return suggestions;
			}

			return current.getSuggestions(lines, cursorLine, cursorCol, options);
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (isSlashCommandCompletion(prefix, item)) {
				const currentLine = lines[cursorLine] ?? "";
				const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
				const afterCursor = currentLine.slice(cursorCol);
				const nextLines = [...lines];
				nextLines[cursorLine] = `${beforePrefix}/${item.value} ${afterCursor}`;

				return {
					lines: nextLines,
					cursorLine,
					cursorCol: beforePrefix.length + item.value.length + 2,
				};
			}

			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			const currentLine = lines[cursorLine] ?? "";
			const textBeforeCursor = currentLine.slice(0, cursorCol);
			if (extractSlashLikeToken(textBeforeCursor)) {
				return true;
			}
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

function findSkillCommand(commands: readonly SlashCommandInfo[], skillName: string): SlashCommandInfo | undefined {
	return commands.find((command) => command.source === "skill" && command.name === `${SKILL_COMMAND_PREFIX}${skillName}`);
}

function buildSkillBlock(command: SlashCommandInfo): string {
	const skillPath = command.sourceInfo.path;
	const baseDir = command.sourceInfo.baseDir ?? dirname(skillPath);
	const content = readFileSync(skillPath, "utf8");
	const body = stripFrontmatter(content).trim();
	const skillName = command.name.slice(SKILL_COMMAND_PREFIX.length);
	return `<skill name="${skillName}" location="${skillPath}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
}

export function expandInlineSkillReferences(
	text: string,
	commands: readonly SlashCommandInfo[],
	onReadError?: (error: Error, command: SlashCommandInfo) => void,
): string {
	if (text.startsWith("/skill:")) return text;

	return text.replace(INLINE_SKILL_TOKEN_PATTERN, (match: string, leadingWhitespace: string, skillName: string) => {
		const command = findSkillCommand(commands, skillName);
		if (!command) return match;

		try {
			return `${leadingWhitespace}\n\n${buildSkillBlock(command)}\n\n`;
		} catch (error) {
			onReadError?.(error instanceof Error ? error : new Error(String(error)), command);
			return match;
		}
	});
}

export class InlineSlashAutocompleteEditor extends CustomEditor {
	private readonly appKeybindings: KeybindingsManager;
	private readonly getCommands: CommandProvider;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		getCommands: CommandProvider,
		options?: EditorOptions,
	) {
		super(tui, theme, keybindings, options);
		this.appKeybindings = keybindings;
		this.getCommands = getCommands;
	}

	override handleInput(data: string): void {
		if (this.shouldAcceptInlineSlashCompletion(data)) {
			// Enter should accept an inline slash completion, not submit the prompt.
			super.handleInput("\t");
			return;
		}

		if (this.shouldRouteSlashTokenTab(data)) {
			return;
		}

		super.handleInput(data);
		this.maybeTriggerInlineSlashAutocomplete(data);
	}

	private shouldAcceptInlineSlashCompletion(data: string): boolean {
		if (!this.appKeybindings.matches(data, "tui.select.confirm")) return false;
		if (!this.isShowingAutocomplete()) return false;

		const prefix = this.getAutocompletePrefix();
		if (!prefix || !prefix.startsWith("/") || prefix.slice(1).includes("/")) return false;

		const { line, col } = this.getCursor();
		const currentLine = this.getLines()[line] ?? "";
		const beforePrefix = currentLine.slice(0, col - prefix.length);
		return beforePrefix.trim() !== "";
	}

	private shouldRouteSlashTokenTab(data: string): boolean {
		if (!this.appKeybindings.matches(data, "tui.input.tab")) return false;
		if (this.isShowingAutocomplete()) return false;

		const slashLikeToken = this.getCurrentSlashLikeToken();
		if (!slashLikeToken) return false;

		const context = this.getCurrentSlashTokenContext();
		if (context) {
			const commands = getInlineSlashCommands(this.getCommands);
			const hasCommandMatches = filterSlashCommands(commands, context.query).length > 0;
			if (hasCommandMatches) {
				this.getPrivateAutocompleteEditor().handleSlashCommandCompletion?.();
				return true;
			}
		}

		// No command matches, or the token is path-like: forced file completion handles /tmp and /tmp/foo.
		this.getPrivateAutocompleteEditor().forceFileAutocomplete?.(true);
		return true;
	}

	private maybeTriggerInlineSlashAutocomplete(data: string): void {
		if (this.isShowingAutocomplete()) return;
		if (!this.shouldTriggerAfterInput(data)) return;

		const context = this.getCurrentSlashTokenContext();
		if (!context) return;

		const commands = getInlineSlashCommands(this.getCommands);
		if (filterSlashCommands(commands, context.query).length === 0) return;

		this.getPrivateAutocompleteEditor().tryTriggerAutocomplete?.();
	}

	private shouldTriggerAfterInput(data: string): boolean {
		return (
			data === "/" ||
			COMMAND_CHARACTER_PATTERN.test(data) ||
			this.appKeybindings.matches(data, "tui.editor.deleteCharBackward") ||
			this.appKeybindings.matches(data, "tui.editor.deleteCharForward")
		);
	}

	private getCurrentSlashLikeToken(): string | undefined {
		const { line, col } = this.getCursor();
		const currentLine = this.getLines()[line] ?? "";
		return extractSlashLikeToken(currentLine.slice(0, col));
	}

	private getCurrentSlashTokenContext(): SlashTokenContext | undefined {
		const { line, col } = this.getCursor();
		const currentLine = this.getLines()[line] ?? "";
		return extractSlashTokenContext(currentLine.slice(0, col));
	}

	private getAutocompletePrefix(): string | undefined {
		const prefix = this.getPrivateAutocompleteEditor().autocompletePrefix;
		return typeof prefix === "string" ? prefix : undefined;
	}

	private getPrivateAutocompleteEditor(): PrivateAutocompleteEditor {
		return this as unknown as PrivateAutocompleteEditor;
	}
}
