import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import codexFastExtension from "./src/extensions/codex-fast.js";
import inlineSkillSlashAutocompleteExtension from "./src/extensions/inline-skill-slash-autocomplete.js";

export default function piCustomizations(pi: ExtensionAPI): void {
	codexFastExtension(pi);
	inlineSkillSlashAutocompleteExtension(pi);
}
