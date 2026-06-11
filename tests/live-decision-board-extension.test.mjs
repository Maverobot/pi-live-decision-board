import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

function loadJiti() {
	return require("jiti").createJiti(fileURLToPath(import.meta.url));
}

const jiti = loadJiti();
const testDir = dirname(fileURLToPath(import.meta.url));
const extension = jiti(join(testDir, "../extensions/live-decision-board.ts")).default;

const commands = new Map();
const events = new Map();
const entries = [];
let registeredTool;
let latestWidget;
let latestStatus;
let latestMessage;
let latestSendOptions;
let branchEntries = [];

extension({
	on(eventName, callback) {
		events.set(eventName, callback);
	},
	registerCommand(name, def) {
		commands.set(name, def);
	},
	registerTool(tool) {
		registeredTool = tool;
	},
	appendEntry(customType, data) {
		entries.push({ type: "custom", customType, data });
	},
	sendMessage(message, options) {
		latestMessage = message;
		latestSendOptions = options;
	},
});

for (const name of [
	"board",
	"board-show",
	"assume",
	"decide",
	"board-hard",
	"board-soft",
	"board-reject",
	"board-accept",
	"board-supersede",
	"board-clear",
]) {
	assert(commands.has(name), `${name} command should be registered`);
}
assert.equal(registeredTool.name, "decision_board", "decision_board tool should be registered");
assert.equal(registeredTool.executionMode, "sequential", "decision_board runs sequentially before later tool preflights");

const ctx = {
	hasUI: true,
	isIdle: () => true,
	sessionManager: { getBranch: () => branchEntries },
	ui: {
		theme: {
			fg: (_color, text) => text,
		},
		setStatus: (_key, value) => {
			latestStatus = value;
		},
		setWidget: (_key, value) => {
			latestWidget = value;
		},
		notify: () => {},
		confirm: async () => true,
		editor: async (_title, initial) => initial,
	},
};

await events.get("session_start")({}, ctx);
await commands.get("assume").handler("Backend uses Node 22", ctx);
await commands.get("decide").handler("Build as a Pi extension first", ctx);
await commands.get("board-show").handler("", ctx);

assert.equal(entries.at(-1).data.version, 2, "commands persist board changes");
assert(latestWidget.some((line) => line.includes("A1")), "assume command updates widget");
assert(latestWidget.some((line) => line.includes("D1")), "decide command updates widget");
assert.match(latestStatus, /Board v2/);
assert.match(latestMessage.content, /Build as a Pi extension first/);
const initialBoard = entries.at(-1).data;

await commands.get("board-reject").handler("A1", ctx);
assert.equal(entries.at(-1).data.items.find((item) => item.id === "A1").status, "rejected");
await commands.get("board-accept").handler("A1", ctx);
assert.equal(entries.at(-1).data.items.find((item) => item.id === "A1").status, "accepted");
await commands.get("board-hard").handler("D1", ctx);
const lowHardBoard = entries.at(-1).data;
const beforeNoOp = entries.length;
await commands.get("board-hard").handler("D1", ctx);
assert.equal(entries.length, beforeNoOp, "same-value hard command should not persist a no-op change");

await commands.get("board-supersede").handler("D1 Build extension MVP first", ctx);
assert.equal(entries.at(-1).data.items.find((item) => item.id === "D1").status, "superseded");
assert.equal(entries.at(-1).data.items.at(-1).supersedes, "D1");

const addResult = await registeredTool.execute(
	"tool-1",
	{ action: "add", kind: "decision", text: "Prefer minimal MVP", status: "accepted", strength: "hard" },
	undefined,
	undefined,
	ctx,
);
assert.match(addResult.content[0].text, /D3/);
assert.equal(entries.at(-1).data.items.at(-1).strength, "hard");

await assert.rejects(
	() => registeredTool.execute("tool-2", { action: "set_status", id: "D3" }, undefined, undefined, ctx),
	/set_status requires status/,
	"missing status should be rejected without corrupting board state",
);
await assert.rejects(
	() => registeredTool.execute("tool-3", { action: "set_strength", id: "D3" }, undefined, undefined, ctx),
	/set_strength requires strength/,
	"missing strength should be rejected without corrupting board state",
);
const supersedeResult = await registeredTool.execute(
	"tool-4",
	{ action: "supersede", id: "D3", text: "Prefer smallest safe MVP" },
	undefined,
	undefined,
	ctx,
);
assert.match(supersedeResult.content[0].text, /Updated D3/);
assert.equal(entries.at(-1).data.items.find((item) => item.id === "D3").status, "superseded");
assert.equal(entries.at(-1).data.items.at(-1).supersedes, "D3");

assert(events.has("context"), "context hook should be registered");
const contextResult = await events.get("context")(
	{
		messages: [
			{ role: "custom", customType: "live-decision-board-context", content: "old", display: false, timestamp: 1 },
			{ role: "custom", customType: "live-decision-board-visible", content: "old visible", display: true, timestamp: 2 },
			{ role: "custom", customType: "live-decision-board-delta", content: "old delta", display: true, timestamp: 3 },
			{ role: "user", content: "Continue", timestamp: 4 },
		],
	},
	ctx,
);
assert.equal(contextResult.messages[0].customType, "live-decision-board-context");
assert.match(contextResult.messages[0].content, /Live Assumptions & Decisions/);
assert.equal(
	contextResult.messages.filter((message) => message.customType?.startsWith("live-decision-board")).length,
	1,
	"context hook keeps exactly one fresh board context message and filters stale visible/delta messages",
);

const busyCtx = { ...ctx, isIdle: () => false };
await commands.get("assume").handler("Implementation should stay surgical", busyCtx);
assert.equal(latestMessage.customType, "live-decision-board-delta");
assert.equal(latestSendOptions.deliverAs, "steer");
assert.equal(latestSendOptions.triggerTurn, true);
assert.match(latestMessage.content, /Live Decision Board changed/);

ctx.ui.editor = async (_title, initial) => initial.replace("soft", "hard");
await commands.get("board").handler("", busyCtx);
assert.equal(entries.at(-1).data.items.find((item) => item.id === "A1").strength, "hard");
assert.equal(latestMessage.customType, "live-decision-board-delta", "busy user board edits steer the worker");

assert(events.has("tool_call"), "tool_call guard should be registered");
const blocked = await events.get("tool_call")({ toolName: "write", input: { path: "x", content: "y" } }, ctx);
assert.equal(blocked.block, true);
assert.match(blocked.reason, /Live Decision Board changed/);

const blockedRedirect = await events.get("tool_call")({ toolName: "bash", input: { command: "echo hi > file.txt" } }, ctx);
assert.equal(blockedRedirect.block, true, "stale hard changes block shell redirection");

const allowed = await events.get("tool_call")({ toolName: "read", input: { path: "README.md" } }, ctx);
assert.equal(allowed, undefined, "read-only tools are not blocked");

branchEntries = [{ type: "custom", customType: "live-decision-board", data: lowHardBoard }];
await events.get("session_tree")({}, ctx);
const blockedAfterRestore = await events.get("tool_call")({ toolName: "write", input: { path: "x", content: "y" } }, ctx);
assert.equal(blockedAfterRestore.block, true, "restoring a branch resets injected version before writes");

await events.get("context")({ messages: [{ role: "user", content: "Sync restored board", timestamp: 5 }] }, ctx);
await commands.get("board-clear").handler("", ctx);
assert.equal(entries.at(-1).data.items.length, 0, "board-clear persists an empty board");
const clearContextResult = await events.get("context")(
	{ messages: [{ role: "user", content: "Continue after clear", timestamp: 6 }] },
	ctx,
);
assert.equal(
	clearContextResult.messages[0].customType,
	"live-decision-board-context",
	"cleared hard-decision boards still inject once to satisfy the stale barrier",
);
const allowedAfterClearInjection = await events.get("tool_call")({ toolName: "write", input: { path: "x", content: "y" } }, ctx);
assert.equal(allowedAfterClearInjection, undefined, "injecting the cleared board releases the stale hard-decision guard");

console.log("live decision board extension tests passed");
