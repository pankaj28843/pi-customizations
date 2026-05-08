import type { ExtensionAPI, ExtensionContext, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import {
	InlineSlashAutocompleteEditor,
	createInlineSlashAutocompleteProvider,
	expandInlineSkillReferences,
} from "../inline-skill-slash.js";

const STATUS_KEY = "pi-customizations-inline-skill-slash";

function reportSkillReadError(ctx: ExtensionContext, error: Error, command: SlashCommandInfo): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify(`inline skill expansion failed for /${command.name} (${command.sourceInfo.path}): ${error.message}`, "warning");
}

export default function inlineSkillSlashAutocompleteExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.addAutocompleteProvider((current) =>
			createInlineSlashAutocompleteProvider(current, () => pi.getCommands()),
		);

		ctx.ui.setEditorComponent((tui, theme, keybindings) =>
			new InlineSlashAutocompleteEditor(tui, theme, keybindings, () => pi.getCommands()),
		);

		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "inline /skill"));
		}
	});

	pi.on("input", (event, ctx) => {
		if (event.source === "extension") {
			return { action: "continue" as const };
		}

		const transformed = expandInlineSkillReferences(event.text, pi.getCommands(), (error, command) => {
			reportSkillReadError(ctx, error, command);
		});
		if (transformed === event.text) {
			return { action: "continue" as const };
		}

		return {
			action: "transform" as const,
			text: transformed,
			...(event.images && { images: event.images }),
		};
	});
}
