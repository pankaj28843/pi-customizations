import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	loadCodexFastPreference,
	SETTINGS_NAMESPACE,
	writeCodexFastGlobalPreference,
	type SettingsReadError,
} from "../settings.js";

const STATUS_KEY = "pankaj-codex-fast";
const SUPPORTED_PROVIDERS = new Set(["openai", "openai-codex"]);

type CommandAction = "off" | "on" | "status" | "toggle";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function supportsPriorityServiceTier(ctx: ExtensionContext): boolean {
	return Boolean(ctx.model && SUPPORTED_PROVIDERS.has(ctx.model.provider));
}

function formatModel(ctx: ExtensionContext): string {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no active model";
}

function parseAction(args: string): CommandAction | undefined {
	const action = args.trim().toLowerCase();
	if (action === "") return "toggle";
	if (action === "on" || action === "enable" || action === "enabled") return "on";
	if (action === "off" || action === "disable" || action === "disabled") return "off";
	if (action === "status" || action === "show") return "status";
	if (action === "toggle") return "toggle";
	return undefined;
}

function reportLoadErrors(errors: readonly SettingsReadError[], ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	for (const { scope, path, error } of errors) {
		ctx.ui.notify(`pi-customizations: failed to read ${scope} settings (${path}): ${error.message}`, "warning");
	}
}

export default function codexFastExtension(pi: ExtensionAPI): void {
	let fastModeEnabled = false;
	let settingsWriteQueue: Promise<void> = Promise.resolve();
	let loadedPreferenceSource: string | undefined;

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!fastModeEnabled) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}

		const label = supportsPriorityServiceTier(ctx) ? "⚡ OpenAI priority" : "⚡ priority inactive";
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", label));
	}

	function notifyState(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!fastModeEnabled) {
			ctx.ui.notify("Codex fast mode disabled. OpenAI requests will use the default service tier.", "info");
			return;
		}

		if (supportsPriorityServiceTier(ctx)) {
			ctx.ui.notify("Codex fast mode enabled. OpenAI/OpenAI Codex requests will send service_tier=priority.", "info");
			return;
		}

		ctx.ui.notify(
			`Codex fast mode enabled, but inactive for ${formatModel(ctx)}. Switch to an OpenAI/OpenAI Codex model to use service_tier=priority.`,
			"info",
		);
	}

	function persistState(enabled: boolean, ctx: ExtensionContext): void {
		settingsWriteQueue = settingsWriteQueue
			.catch(() => undefined)
			.then(() => {
				writeCodexFastGlobalPreference(enabled);
			});

		void settingsWriteQueue.catch((error: unknown) => {
			if (!ctx.hasUI) return;
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`pi-customizations: failed to write ${SETTINGS_NAMESPACE}.codexFast.enabled: ${message}`, "warning");
		});
	}

	function setFastMode(
		enabled: boolean,
		ctx: ExtensionContext,
		options: { notify?: boolean; persist?: boolean } = {},
	): void {
		fastModeEnabled = enabled;
		loadedPreferenceSource = options.persist === false ? loadedPreferenceSource : `global:${SETTINGS_NAMESPACE}.codexFast.enabled`;
		if (options.persist !== false) persistState(enabled, ctx);
		updateStatus(ctx);
		if (options.notify !== false) notifyState(ctx);
	}

	async function reloadFastModeState(ctx: ExtensionContext, options: { includeStartupFlag?: boolean } = {}): Promise<void> {
		await settingsWriteQueue.catch(() => undefined);
		fastModeEnabled = false;
		loadedPreferenceSource = undefined;

		const preference = loadCodexFastPreference(ctx.cwd);
		reportLoadErrors(preference.errors, ctx);
		if (typeof preference.enabled === "boolean") {
			fastModeEnabled = preference.enabled;
			loadedPreferenceSource = preference.source;
		}

		if (options.includeStartupFlag && pi.getFlag("fast") === true) {
			fastModeEnabled = true;
			loadedPreferenceSource = "--fast";
		}

		updateStatus(ctx);
	}

	pi.registerFlag("fast", {
		description: "Start with Codex fast mode enabled (adds service_tier=priority to OpenAI/OpenAI Codex requests)",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("codex-fast", {
		description: "Toggle OpenAI/OpenAI Codex priority service tier. Usage: /codex-fast [on|off|status|toggle]",
		handler: async (args, ctx) => {
			const action = parseAction(args);
			if (!action) {
				ctx.ui.notify("Usage: /codex-fast [on|off|status|toggle]", "error");
				return;
			}

			if (action === "status") {
				const state = fastModeEnabled ? "enabled" : "disabled";
				const applicability = supportsPriorityServiceTier(ctx) ? "active" : `inactive for ${formatModel(ctx)}`;
				const source = loadedPreferenceSource ? ` Source: ${loadedPreferenceSource}.` : "";
				ctx.ui.notify(`Codex fast mode is ${state} (${applicability}).${source}`, "info");
				updateStatus(ctx);
				return;
			}

			setFastMode(action === "toggle" ? !fastModeEnabled : action === "on", ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await reloadFastModeState(ctx, { includeStartupFlag: true });
	});

	pi.on("model_select", async (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!fastModeEnabled || !supportsPriorityServiceTier(ctx) || !isRecord(event.payload)) {
			return;
		}

		if (Object.prototype.hasOwnProperty.call(event.payload, "service_tier")) {
			return;
		}

		return {
			...event.payload,
			service_tier: "priority",
		};
	});
}
