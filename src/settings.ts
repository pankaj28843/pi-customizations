import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const SETTINGS_NAMESPACE = "pi-customizations";
export const LEGACY_CODEX_FAST_NAMESPACE = "pi-codex-fast";

export type SettingsScope = "global" | "project";
export type JsonObject = Record<string, unknown>;

export interface SettingsReadError {
	scope: SettingsScope;
	path: string;
	error: Error;
}

export interface CodexFastPreference {
	enabled: boolean | undefined;
	source: string | undefined;
	errors: SettingsReadError[];
}

function isRecord(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorFromUnknown(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

export function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

export function getDefaultPiSettingsDir(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(expandHome(env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent")));
}

export function getGlobalSettingsPath(agentDir = getDefaultPiSettingsDir()): string {
	return join(agentDir, "settings.json");
}

export function getProjectSettingsPath(cwd: string): string {
	return join(cwd, ".pi", "settings.json");
}

function readJsonObject(path: string): JsonObject {
	if (!existsSync(path)) return {};
	const raw = readFileSync(path, "utf8");
	if (raw.trim() === "") return {};
	const parsed: unknown = JSON.parse(raw);
	if (!isRecord(parsed)) {
		throw new Error(`Expected ${path} to contain a JSON object`);
	}
	return parsed;
}

function readSettingsFile(scope: SettingsScope, path: string): { settings: JsonObject; error?: SettingsReadError } {
	try {
		return { settings: readJsonObject(path) };
	} catch (error) {
		return {
			settings: {},
			error: { scope, path, error: errorFromUnknown(error) },
		};
	}
}

export function mergeSettings(base: JsonObject, overrides: JsonObject): JsonObject {
	const merged: JsonObject = { ...base };
	for (const [key, overrideValue] of Object.entries(overrides)) {
		const baseValue = merged[key];
		if (isRecord(baseValue) && isRecord(overrideValue)) {
			merged[key] = mergeSettings(baseValue, overrideValue);
			continue;
		}
		merged[key] = overrideValue;
	}
	return merged;
}

function getNestedBoolean(settings: JsonObject, path: readonly string[]): boolean | undefined {
	let value: unknown = settings;
	for (const part of path) {
		if (!isRecord(value)) return undefined;
		value = value[part];
	}
	return typeof value === "boolean" ? value : undefined;
}

function getCodexFastEnabled(settings: JsonObject): boolean | undefined {
	return (
		getNestedBoolean(settings, [SETTINGS_NAMESPACE, "codexFast", "enabled"]) ??
		getNestedBoolean(settings, [LEGACY_CODEX_FAST_NAMESPACE, "enabled"])
	);
}

function getCodexFastSource(globalSettings: JsonObject, projectSettings: JsonObject): string | undefined {
	const projectNamespaced = getNestedBoolean(projectSettings, [SETTINGS_NAMESPACE, "codexFast", "enabled"]);
	if (typeof projectNamespaced === "boolean") return `project:${SETTINGS_NAMESPACE}.codexFast.enabled`;

	const projectLegacy = getNestedBoolean(projectSettings, [LEGACY_CODEX_FAST_NAMESPACE, "enabled"]);
	if (typeof projectLegacy === "boolean") return `project:${LEGACY_CODEX_FAST_NAMESPACE}.enabled`;

	const globalNamespaced = getNestedBoolean(globalSettings, [SETTINGS_NAMESPACE, "codexFast", "enabled"]);
	if (typeof globalNamespaced === "boolean") return `global:${SETTINGS_NAMESPACE}.codexFast.enabled`;

	const globalLegacy = getNestedBoolean(globalSettings, [LEGACY_CODEX_FAST_NAMESPACE, "enabled"]);
	if (typeof globalLegacy === "boolean") return `global:${LEGACY_CODEX_FAST_NAMESPACE}.enabled`;

	return undefined;
}

export function loadCodexFastPreference(cwd: string, agentDir = getDefaultPiSettingsDir()): CodexFastPreference {
	const globalPath = getGlobalSettingsPath(agentDir);
	const projectPath = getProjectSettingsPath(cwd);
	const globalResult = readSettingsFile("global", globalPath);
	const projectResult = readSettingsFile("project", projectPath);
	const errors = [globalResult.error, projectResult.error].filter((error): error is SettingsReadError => Boolean(error));
	const effectiveSettings = mergeSettings(globalResult.settings, projectResult.settings);

	return {
		enabled: getCodexFastEnabled(effectiveSettings),
		source: getCodexFastSource(globalResult.settings, projectResult.settings),
		errors,
	};
}

function setCodexFastEnabled(settings: JsonObject, enabled: boolean): JsonObject {
	const namespace = isRecord(settings[SETTINGS_NAMESPACE]) ? settings[SETTINGS_NAMESPACE] : {};
	const codexFast = isRecord(namespace.codexFast) ? namespace.codexFast : {};

	return {
		...settings,
		[SETTINGS_NAMESPACE]: {
			...namespace,
			codexFast: {
				...codexFast,
				enabled,
			},
		},
	};
}

export function writeCodexFastGlobalPreference(enabled: boolean, agentDir = getDefaultPiSettingsDir()): void {
	const settingsPath = getGlobalSettingsPath(agentDir);
	const nextSettings = setCodexFastEnabled(readJsonObject(settingsPath), enabled);
	const parentDir = dirname(settingsPath);
	mkdirSync(parentDir, { recursive: true });

	const tempPath = join(parentDir, `.settings.json.${process.pid}.${Date.now()}.tmp`);
	writeFileSync(tempPath, `${JSON.stringify(nextSettings, null, 2)}\n`, "utf8");
	renameSync(tempPath, settingsPath);
}
