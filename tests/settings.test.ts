import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import {
	getDefaultPiSettingsDir,
	loadCodexFastPreference,
	mergeSettings,
	SETTINGS_NAMESPACE,
	writeCodexFastGlobalPreference,
} from "../src/settings.js";

function withTempDir(test: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "pi-customizations-"));
	try {
		test(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

withTempDir((dir) => {
	const merged = mergeSettings(
		{ nested: { a: true, b: "keep" }, top: 1 },
		{ nested: { a: false }, other: 2 },
	);
	assert.deepEqual(merged, { nested: { a: false, b: "keep" }, top: 1, other: 2 });

	const agentDir = join(dir, "agent");
	const cwd = join(dir, "project");
	writeCodexFastGlobalPreference(true, agentDir);
	assert.equal(loadCodexFastPreference(cwd, agentDir).enabled, true);
	assert.equal(loadCodexFastPreference(cwd, agentDir).source, `global:${SETTINGS_NAMESPACE}.codexFast.enabled`);

	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ [SETTINGS_NAMESPACE]: { codexFast: { enabled: false } } }), {
		encoding: "utf8",
		flag: "w",
	});
	assert.equal(loadCodexFastPreference(cwd, agentDir).enabled, false);
	assert.equal(loadCodexFastPreference(cwd, agentDir).source, `project:${SETTINGS_NAMESPACE}.codexFast.enabled`);

	const globalSettings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
	assert.deepEqual(globalSettings[SETTINGS_NAMESPACE], { codexFast: { enabled: true } });
});

withTempDir((dir) => {
	const agentDir = join(dir, "agent");
	const cwd = join(dir, "project");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ "pi-codex-fast": { enabled: true } }), {
		encoding: "utf8",
		flag: "w",
	});
	const preference = loadCodexFastPreference(cwd, agentDir);
	assert.equal(preference.enabled, true);
	assert.equal(preference.source, "global:pi-codex-fast.enabled");
});

assert.equal(getDefaultPiSettingsDir({ PI_CODING_AGENT_DIR: "~/custom-pi" }).endsWith("/custom-pi"), true);

console.log("settings tests passed");
