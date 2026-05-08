import assert from "node:assert/strict";
import {
	extractMessageText,
	formatHistoryResults,
	parseHistoryCommandArgs,
	parseSessionFileText,
	searchHistoryDocuments,
	type ProjectHistorySession,
} from "../src/project-history.js";

const session: ProjectHistorySession = {
	path: "/tmp/pi-history/fixture.jsonl",
	id: "session-1",
	cwd: "/work/project",
	name: "Original Name",
	created: new Date("2026-05-01T00:00:00.000Z"),
	modified: new Date("2026-05-05T00:00:00.000Z"),
	firstMessage: "Please implement semantic scholar adapter retries",
};

const longMessage = `${"prefix ".repeat(30)}needle phrase${" suffix".repeat(30)}`;
const jsonl = [
	JSON.stringify({ type: "session", version: 3, id: "session-1", timestamp: "2026-05-01T00:00:00.000Z", cwd: "/work/project" }),
	JSON.stringify({
		type: "message",
		id: "u1",
		parentId: null,
		timestamp: "2026-05-01T00:00:01.000Z",
		message: { role: "user", content: "Please implement semantic scholar adapter retries with a budget", timestamp: 1770000001000 },
	}),
	"{ malformed json line",
	JSON.stringify({
		type: "message",
		id: "a1",
		parentId: "u1",
		timestamp: "2026-05-01T00:00:02.000Z",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "The assistant mentioned database vacuum and semantic scholar retries." },
				{ type: "toolCall", name: "read", arguments: { path: "src/adapter.ts" } },
			],
			timestamp: 1770000002000,
		},
	}),
	JSON.stringify({ type: "session_info", id: "info1", parentId: "a1", timestamp: "2026-05-01T00:00:03.000Z", name: "Adapter Planning" }),
	JSON.stringify({
		type: "message",
		id: "u2",
		parentId: "info1",
		timestamp: "2026-05-02T00:00:01.000Z",
		message: {
			role: "user",
			content: [
				{ type: "text", text: "Could you add project history search?" },
				{ type: "image", data: "abc", mimeType: "image/png" },
				{ type: "text", text: "It should find adapter retry with budget tokens." },
			],
			timestamp: 1770086401000,
		},
	}),
	JSON.stringify({
		type: "message",
		id: "tool1",
		parentId: "u2",
		timestamp: "2026-05-02T00:00:02.000Z",
		message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "database vacuum in a tool result" }], isError: false },
	}),
	JSON.stringify({
		type: "message",
		id: "u3",
		parentId: "tool1",
		timestamp: "2026-05-03T00:00:01.000Z",
		message: { role: "user", content: longMessage, timestamp: 1770172801000 },
	}),
	"",
].join("\n");

assert.equal(extractMessageText("hello"), "hello");
assert.equal(
	extractMessageText([
		{ type: "text", text: "hello" },
		{ type: "image", data: "ignored" },
		{ type: "text", text: "world" },
	]),
	"hello\nworld",
);
assert.equal(extractMessageText([{ type: "image", data: "ignored" }]), "");

const documents = parseSessionFileText(jsonl, session);
assert.deepEqual(
	documents.map((doc) => `${doc.role}:${doc.entryId}`),
	["user:u1", "assistant:a1", "user:u2", "user:u3"],
);
assert.equal(documents[0]?.sessionName, "Adapter Planning");
assert.equal(documents[0]?.lineNumber, 2);

const userOnlyNoAssistant = searchHistoryDocuments(documents, { query: "database vacuum" });
assert.equal(userOnlyNoAssistant.length, 0);

const allRoles = searchHistoryDocuments(documents, { query: "database vacuum", role: "all" });
assert.equal(allRoles.length, 1);
assert.equal(allRoles[0]?.role, "assistant");
assert.equal(allRoles[0]?.entryId, "a1");

const ranked = searchHistoryDocuments(documents, { query: "adapter retries budget", role: "user", limit: 5 });
assert.equal(ranked[0]?.entryId, "u1", "exact phrase-ish user ask should outrank token-only user ask");
assert.ok((ranked[0]?.score ?? 0) > (ranked[1]?.score ?? 0));

const snippetResult = searchHistoryDocuments(documents, {
	query: "needle phrase",
	role: "user",
	limit: 1,
	maxSnippetLength: 80,
});
assert.equal(snippetResult.length, 1);
assert.match(snippetResult[0]?.snippet ?? "", /needle phrase/);
assert.ok((snippetResult[0]?.snippet.length ?? 0) <= 80);
assert.ok(snippetResult[0]?.snippet.startsWith("…"));
assert.ok(snippetResult[0]?.snippet.endsWith("…"));

const formatted = formatHistoryResults(snippetResult, {
	query: "needle phrase",
	role: "user",
	searchedSessions: 1,
	searchedDocuments: documents.length,
});
assert.match(formatted, /Adapter Planning/);
assert.match(formatted, /session-1/);
assert.match(formatted, /fixture\.jsonl/);
assert.match(formatted, /entry=u3/);
assert.ok(formatted.length < 1200);
assert.equal(formatted.includes(longMessage), false);

assert.deepEqual(parseHistoryCommandArgs('--role all --limit 12 "semantic scholar"'), {
	query: "semantic scholar",
	role: "all",
	limit: 12,
});
assert.deepEqual(parseHistoryCommandArgs("--role=assistant adapter retries"), {
	query: "adapter retries",
	role: "assistant",
	limit: 8,
});
assert.equal("error" in parseHistoryCommandArgs("--role tool stuff"), true);
assert.equal("error" in parseHistoryCommandArgs("--limit 0 stuff"), true);

console.log("project history tests passed");
