import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import {
	createInlineSlashAutocompleteProvider,
	expandInlineSkillReferences,
	extractSlashLikeToken,
	extractSlashTokenContext,
	stripFrontmatter,
} from "../src/inline-skill-slash.js";

function skillCommand(name: string, filePath: string, baseDir: string): SlashCommandInfo {
	return {
		name: `skill:${name}`,
		description: `${name} skill`,
		source: "skill",
		sourceInfo: {
			path: filePath,
			source: "local",
			scope: "project",
			origin: "top-level",
			baseDir,
		},
	};
}

assert.deepEqual(extractSlashTokenContext("please /ski"), { token: "/ski", query: "ski" });
assert.deepEqual(extractSlashTokenContext("please /skill:dev"), { token: "/skill:dev", query: "skill:dev" });
assert.equal(extractSlashLikeToken("please /tmp/foo"), "/tmp/foo");
assert.equal(extractSlashTokenContext("please /tmp/foo"), undefined);
assert.equal(extractSlashTokenContext("https://example.com/path"), undefined);
assert.equal(stripFrontmatter("---\nname: test\n---\n# Body"), "# Body");

const fallbackCalls: string[] = [];
const fallbackProvider: AutocompleteProvider = {
	async getSuggestions(_lines, _cursorLine, _cursorCol, _options) {
		fallbackCalls.push("getSuggestions");
		return {
			items: [{ value: "/tmp/", label: "tmp/" }],
			prefix: "/tmp",
		};
	},
	applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
		fallbackCalls.push("applyCompletion");
		const line = lines[cursorLine] ?? "";
		const before = line.slice(0, cursorCol - prefix.length);
		const after = line.slice(cursorCol);
		const nextLines = [...lines];
		nextLines[cursorLine] = before + item.value + after;
		return { lines: nextLines, cursorLine, cursorCol: before.length + item.value.length };
	},
	shouldTriggerFileCompletion() {
		fallbackCalls.push("shouldTriggerFileCompletion");
		return false;
	},
};

const commands: SlashCommandInfo[] = [
	{
		name: "review",
		description: "Review prompt",
		source: "prompt",
		sourceInfo: { path: "/virtual/review.md", source: "local", scope: "project", origin: "top-level" },
	},
	{
		name: "template",
		description: "Template prompt",
		source: "prompt",
		sourceInfo: { path: "/virtual/template.md", source: "local", scope: "project", origin: "top-level" },
	},
	{
		name: "skill:dev-go",
		description: "Go development",
		source: "skill",
		sourceInfo: { path: "/virtual/dev-go/SKILL.md", source: "local", scope: "project", origin: "top-level" },
	},
	{
		name: "skill:dev-tdd",
		description: "TDD workflow",
		source: "skill",
		sourceInfo: { path: "/virtual/dev-tdd/SKILL.md", source: "local", scope: "project", origin: "top-level" },
	},
	{
		name: "skill:plan-prp",
		description: "Plan PRP workflow",
		source: "skill",
		sourceInfo: { path: "/virtual/plan-prp/SKILL.md", source: "local", scope: "project", origin: "top-level" },
	},
];
const provider = createInlineSlashAutocompleteProvider(fallbackProvider, () => commands);

const inlineSki = await provider.getSuggestions(["please /ski"], 0, "please /ski".length, {
	signal: new AbortController().signal,
});
assert.equal(inlineSki?.prefix, "/ski");
assert.deepEqual(inlineSki?.items.map((item) => item.value), ["skill:dev-go", "skill:dev-tdd", "skill:plan-prp"]);

const inlineSkillDev = await provider.getSuggestions(["please /skill:dev"], 0, "please /skill:dev".length, {
	signal: new AbortController().signal,
});
assert.equal(inlineSkillDev?.prefix, "/skill:dev");
assert.deepEqual(inlineSkillDev?.items.map((item) => item.value), ["skill:dev-go", "skill:dev-tdd"]);

const inlineBareDev = await provider.getSuggestions(["please /dev"], 0, "please /dev".length, {
	signal: new AbortController().signal,
});
assert.equal(inlineBareDev?.prefix, "/dev");
assert.deepEqual(inlineBareDev?.items.map((item) => item.value), ["skill:dev-go", "skill:dev-tdd"]);

const inlinePrp = await provider.getSuggestions(["please /prp"], 0, "please /prp".length, {
	signal: new AbortController().signal,
});
assert.equal(inlinePrp?.prefix, "/prp");
assert.deepEqual(inlinePrp?.items.map((item) => item.value), ["skill:plan-prp"]);

const applied = provider.applyCompletion(
	["please /ski"],
	0,
	"please /ski".length,
	{ value: "skill:dev-go", label: "skill:dev-go" },
	"/ski",
);
assert.equal(applied.lines[0], "please /skill:dev-go ");
assert.equal(applied.cursorCol, "please /skill:dev-go ".length);

const appliedPrp = provider.applyCompletion(
	["please /prp"],
	0,
	"please /prp".length,
	{ value: "skill:plan-prp", label: "skill:plan-prp" },
	"/prp",
);
assert.equal(appliedPrp.lines[0], "please /skill:plan-prp ");
assert.equal(appliedPrp.cursorCol, "please /skill:plan-prp ".length);

const pathResult = await provider.getSuggestions(["please /tmp"], 0, "please /tmp".length, {
	signal: new AbortController().signal,
	force: true,
});
assert.equal(pathResult?.prefix, "/tmp");
assert.equal(pathResult?.items[0]?.value, "/tmp/");
assert.equal(provider.shouldTriggerFileCompletion?.(["please /tmp"], 0, "please /tmp".length), true);
assert.equal(provider.shouldTriggerFileCompletion?.(["/tmp/foo"], 0, "/tmp/foo".length), true);
assert.ok(fallbackCalls.includes("getSuggestions"));
assert.equal(fallbackCalls.includes("shouldTriggerFileCompletion"), false);

const tempDir = mkdtempSync(join(tmpdir(), "pi-inline-skill-"));
try {
	const skillPath = join(tempDir, "SKILL.md");
	writeFileSync(skillPath, "---\nname: test\n---\n# Test Skill\n\nUse the skill body.");
	const skillCommands = [skillCommand("test", skillPath, tempDir)];

	const expanded = expandInlineSkillReferences("Please use /skill:test explain this", skillCommands);
	assert.match(expanded, /Please use\s+<skill name="test" location="/);
	assert.match(expanded, /References are relative to /);
	assert.match(expanded, /Use the skill body\./);
	assert.match(expanded, /explain this/);

	assert.equal(
		expandInlineSkillReferences("Please use /skill:missing explain this", skillCommands),
		"Please use /skill:missing explain this",
	);
	assert.equal(expandInlineSkillReferences("/skill:test explain this", skillCommands), "/skill:test explain this");
} finally {
	rmSync(tempDir, { recursive: true, force: true });
}

console.log("inline skill slash tests passed");
