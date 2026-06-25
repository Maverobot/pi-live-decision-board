import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Check } from "typebox/value";

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
let latestStatus = "unset";
let latestMessage;
let latestSendOptions;
let latestNotificationMessage = "";
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
	"board-snapshot",
	"board-inject",
	"board-history",
	"board-toggle",
	"board-manage",
	"board-cleanup",
	"goal",
	"assume",
	"decide",
	"board-archive",
	"board-clear",
]) {
	assert(commands.has(name), `${name} command should be registered`);
}
assert.equal(commands.has("board-show"), false, "board-show should be renamed to board-snapshot");
assert.match(commands.get("board-snapshot").description, /active board snapshot/, "board-snapshot should describe the visible-only snapshot output it records");
assert.match(commands.get("board-inject").description, /inject/i, "board-inject should describe explicit context injection");
assert.match(commands.get("board-inject").description, /review|cleanup/i, "board-inject should mention the cleanup checkpoint");
assert.match(commands.get("board-history").description, /inactive|history|archived/i, "board-history should describe inactive board history");
assert.match(commands.get("assume").description, /active assumption/i, "assume command should use active-item wording");
assert.doesNotMatch(commands.get("assume").description, /soft|hard/i, "assume command should not expose legacy strength wording");
assert.match(commands.get("decide").description, /active decision/i, "decide command should use active-item wording");
assert.doesNotMatch(commands.get("decide").description, /soft|hard/i, "decide command should not expose legacy strength wording");
assert.match(commands.get("board-manage").description, /primary/i, "board-manage should be described as the primary item-action UI");
assert.match(commands.get("board-manage").description, /TUI/i, "board-manage should advertise that it needs TUI mode");
assert.match(commands.get("board-manage").description, /\bclear\b/i, "board-manage should advertise clear after Task 2");
assert.match(commands.get("board-cleanup").description, /TUI/i, "board-cleanup should advertise that it needs TUI mode");
assert.equal(commands.has("board-cleanup-manual"), false, "board-cleanup-manual should be renamed to board-cleanup");
assert.equal(commands.has("board-cleanup-auto"), false, "board-cleanup-auto should not be user-facing");
assert.equal(commands.has("board-cleanup-subagent"), false, "board-cleanup-subagent should stay removed");
assert.match(commands.get("board-archive").description, /fallback/i, "board-archive should be documented as a fallback command");
assert.match(commands.get("board-archive").description, /prefer\s+\/board-manage/i, "board-archive should prefer board-manage");
assert.equal(commands.has("board-reject"), false, "board-reject compatibility alias should not be registered");
assert.equal(commands.has("board-accept"), false, "board-accept should not be registered in active-vs-archived model");
assert.equal(commands.has("board-supersede"), false, "board-supersede compatibility alias should not be registered");
assert.match(commands.get("board-clear").description, /fallback/i, "board-clear should be documented as a fallback command");
assert.match(commands.get("board-clear").description, /archive.*active|active.*archive/i, "board-clear should describe archive-only clear semantics");
assert.match(commands.get("board-clear").description, /prefer\s+\/board-manage/i, "board-clear should prefer board-manage once manager clear exists");
assert.equal(commands.has("board-hard"), false, "board-hard compatibility no-op should not be registered");
assert.equal(commands.has("board-soft"), false, "board-soft compatibility no-op should not be registered");
assert.equal(registeredTool.name, "decision_board", "decision_board tool should be registered");
assert.equal(registeredTool.executionMode, "sequential", "decision_board runs sequentially before later tool preflights");
const promptGuidelines = registeredTool.promptGuidelines.join("\n");
assert.match(promptGuidelines, /visible-only by default/i, "tool guidance should explain the passive default");
assert.match(promptGuidelines, /explicitly injected|explicitly listed|decision_board/i, "tool guidance should describe explicit context paths");
assert.doesNotMatch(promptGuidelines, /enforce.*current contract/i, "tool guidance should not force hidden board authority");
assert.doesNotMatch(promptGuidelines, /before mutating files/i, "tool guidance should not imply default write-blocking");
assert.match(promptGuidelines, /one current goal/i, "decision_board prompt guidance should mention the single current goal");
assert.match(promptGuidelines, /high-signal/i, "decision_board prompt guidance should keep the active board high-signal");
assert.match(promptGuidelines, /meaningfully change future behavior if forgotten/i, "decision_board prompt guidance should define when context belongs on the board");
assert.match(promptGuidelines, /pinned preferences or session-critical assumptions/i, "decision_board prompt guidance should allow explicit adaptive-strictness exceptions");
assert.match(promptGuidelines, /active/i, "decision_board prompt guidance should mention active items");
assert.doesNotMatch(promptGuidelines, /accepted|proposed/i, "decision_board prompt guidance should not expose proposed/accepted states");
assert.doesNotMatch(promptGuidelines, /board-cleanup-auto/i, "prompt guidance should not mention removed auto command");
assert.doesNotMatch(promptGuidelines, /single read-only recommendation subagent/i, "prompt guidance should not promote subagent cleanup handoffs");
assert.match(promptGuidelines, /review_cleanup/i, "decision_board prompt guidance should mention cleanup recommendation review");
assert.match(promptGuidelines, /decision_board\.review_cleanup/i, "prompt guidance should direct to review_cleanup action");
assert.match(promptGuidelines, /archive.*deprecated|deprecated.*archive/i, "prompt guidance should describe direct deprecated-item archiving");
assert.match(promptGuidelines, /reconcile it before using it as current context/, "prompt guidance should allow same-turn use after tool-returned fresh board snapshot");
assert.doesNotMatch(promptGuidelines, /Ask the user/i, "prompt guidance should not direct ask_user in cleanup workflow");
assert.doesNotMatch(promptGuidelines, /Use hard only/i, "prompt guidance should not promote hard/soft distinction");

const testTheme = {
	fg: (color, text) => `<${color}>${text}</${color}>`,
};

function renderLatestWidgetText() {
	assert.equal(typeof latestWidget, "function", "board widget should use a custom component factory like plan-tracker");
	const rendered = latestWidget(undefined, testTheme);
	assert.equal(rendered.paddingX, 0, "board widget text should use zero horizontal padding for plan-tracker alignment");
	assert.equal(rendered.paddingY, 0, "board widget text should use zero vertical padding for plan-tracker alignment");
	return rendered.text;
}

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
		notify: (message) => {
			latestNotificationMessage = message;
		},
		confirm: async () => true,
		editor: async (_title, initial) => initial,
	},
};

await events.get("session_start")({}, ctx);
await commands.get("assume").handler("Backend uses Node 22", ctx);
await commands.get("decide").handler("Build as a Pi extension first", ctx);
await commands.get("board-snapshot").handler("", ctx);

assert.equal(entries.at(-1).data.version, 2, "commands persist board changes");
const widgetText = renderLatestWidgetText();
const widgetLines = widgetText.split("\n");
assert(!widgetText.startsWith(" "), "board widget summary should remain flush with the widget edge");
assert.match(widgetLines[0], /Board/, "board widget starts with the compact summary");
assert.doesNotMatch(widgetLines[0], /\bv\d+\b/, "persistent board widget summary should hide implementation-detail board versions");
assert.doesNotMatch(widgetText, /hard constraints?/i, "persistent board widget summary should not show hard constraint counts");
assert.doesNotMatch(widgetText, /Live Decision Board/, "persistent board widget should omit the titled separator");
assert.doesNotMatch(widgetText, /─/, "persistent board widget should omit separator lines");
assert.match(widgetText, /\n  <accent>Decisions<\/accent>/, "expanded board sections should be indented for visual grouping");
assert.match(widgetText, /\n    <dim>•<\/dim> <muted>Build as a Pi extension first<\/muted>/, "expanded board items should be indented under sections without item keys");
assert.doesNotMatch(widgetText, /\[[GAD]\d+]/, "persistent widget hides item keys by default");
assert.equal(latestStatus, undefined, "board summary should not be duplicated in the footer status");
assert.match(latestMessage.content, /Build as a Pi extension first/);
await commands.get("board-history").handler("", ctx);
assert.match(latestMessage.content, /Live Decision Board History/);
assert.match(latestMessage.content, /Active items:/);
assert.match(latestMessage.content, /Backend uses Node 22/, "board-history includes active assumptions");
const entriesBeforeToggle = entries.length;
await commands.get("board-toggle").handler("", ctx);
assert.match(latestNotificationMessage, /visible-only/i, "collapse notification should describe visible-only default behavior");
assert.match(latestNotificationMessage, /collapsed/i, "collapse notification should describe the collapsed widget state");
const collapsedWidgetText = renderLatestWidgetText();
assert.match(collapsedWidgetText, /Board/, "board-toggle keeps the board summary visible when collapsed");
assert.doesNotMatch(collapsedWidgetText, /\bv\d+\b/, "collapsed board widget summary should also hide implementation-detail board versions");
assert.doesNotMatch(collapsedWidgetText, /hard constraints?/i, "collapsed widget summary should not show hard constraint counts");
assert.doesNotMatch(collapsedWidgetText, /Decisions \(/, "board-toggle hides the board body when collapsed");
assert.equal(entries.length, entriesBeforeToggle, "board-toggle does not persist board state changes");
await commands.get("board-toggle").handler("", ctx);
assert.match(renderLatestWidgetText(), /Decisions.*\(1\)/, "board-toggle expands the persistent widget body again");
assert.equal(entries.length, entriesBeforeToggle, "expanding the widget also does not persist board state changes");
const initialBoard = entries.at(-1).data;

await commands.get("board-archive").handler("A1", ctx);
assert.equal(entries.at(-1).data.items.find((item) => item.id === "A1").status, "archived");
await commands.get("board-history").handler("", ctx);
assert.match(latestMessage.content, /Inactive history:/);
assert.match(latestMessage.content, /\[A1\].*Backend uses Node 22.*archived/, "board-history exposes archived items with archive terminology");
const activeBoardForRestore = initialBoard;

const addResult = await registeredTool.execute(
	"tool-1",
	{ action: "add", kind: "decision", text: "Prefer minimal MVP" },
	undefined,
	undefined,
	ctx,
);
assert.match(addResult.content[0].text, /D2/);
assert.match(addResult.content[0].text, /fresh board snapshot/i, "agent board mutations should return fresh context for same-turn continuation");
assert.match(addResult.content[0].text, /Explicit Board Snapshot/, "changed decision_board results should include the current board context");
assert.equal(entries.at(-1).data.items.at(-1).strength, "soft");
const allowedAfterToolBoardMutation = await events.get("tool_call")({ toolName: "write", input: { path: "x", content: "y" } }, ctx);
assert.equal(allowedAfterToolBoardMutation, undefined, "agent-sourced board mutations should not block same-turn file edits after returning fresh context");

assert(!JSON.stringify(registeredTool.parameters).includes('"strength"'), "decision_board schema should not expose stored metadata fields");
assert(!JSON.stringify(registeredTool.parameters).includes('"set_strength"'), "decision_board schema should not expose set_strength actions");
assert(!JSON.stringify(registeredTool.parameters).includes('"set_status"'), "decision_board schema should not expose set_status actions");
assert(!JSON.stringify(registeredTool.parameters).includes('"supersede"'), "decision_board schema should not expose supersede actions");
assert(!JSON.stringify(registeredTool.parameters).includes('"rejected"'), "decision_board schema should not expose retired rejected status");
assert(!JSON.stringify(registeredTool.parameters).includes('"archived"'), "decision_board tool schema should require direct archive action instead of archived status");
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
assert.deepEqual(contextResult.messages, [{ role: "user", content: "Continue", timestamp: 4 }], "default context hook filters old board messages but injects no board snapshot");

let cleanupReviewOpened = false;
let injectReviewText = "";
ctx.mode = "tui";
ctx.ui.custom = async (factory) => {
	cleanupReviewOpened = true;
	const component = factory({ requestRender: () => {} }, { fg: (_color, text) => text }, {}, () => {});
	injectReviewText = component.render(100).join("\n");
	return { type: "apply", recommendations: [] };
};
await commands.get("board-inject").handler("", ctx);
assert.equal(cleanupReviewOpened, true, "board-inject opens cleanup review in TUI mode");
assert.match(injectReviewText, /Board Inject Review/, "board-inject review title should describe injection, not only cleanup");
assert.match(injectReviewText, /enter continue to inject/, "board-inject review help should explain that enter continues to injection");
assert.match(latestNotificationMessage, /next model call/i);

const injectedContext = await events.get("context")(
	{ messages: [{ role: "user", content: "Use the injected board", timestamp: 7 }] },
	ctx,
);
assert.equal(injectedContext.messages[0].customType, "live-decision-board-context", "manual injection adds one hidden board snapshot");
assert.match(injectedContext.messages[0].content, /Explicit Board Snapshot/);
assert.match(injectedContext.messages[0].content, /Build as a Pi extension first/);

const repeatedContext = await events.get("context")(
	{ messages: [{ role: "user", content: "Continue after injection", timestamp: 8 }] },
	ctx,
);
assert.deepEqual(repeatedContext.messages, [{ role: "user", content: "Continue after injection", timestamp: 8 }], "manual injection is one-shot by default");

ctx.ui.custom = async () => ({ type: "cancel" });
await commands.get("board-inject").handler("", ctx);
const cancelledContext = await events.get("context")(
	{ messages: [{ role: "user", content: "No board please", timestamp: 9 }] },
	ctx,
);
assert.deepEqual(cancelledContext.messages, [{ role: "user", content: "No board please", timestamp: 9 }], "cancelling cleanup review cancels injection");

ctx.ui.custom = async () => ({ type: "apply", recommendations: [] });
await commands.get("board-inject").handler("", ctx);
ctx.ui.custom = async () => ({ type: "cancel" });
await commands.get("board-inject").handler("", ctx);
const cancelledQueuedContext = await events.get("context")(
	{ messages: [{ role: "user", content: "Do not use older queued injection", timestamp: 10 }] },
	ctx,
);
assert.deepEqual(cancelledQueuedContext.messages, [{ role: "user", content: "Do not use older queued injection", timestamp: 10 }], "a cancelled injection command clears any earlier pending injection");

ctx.ui.custom = async () => ({ type: "apply", recommendations: [] });
await commands.get("board-inject").handler("", ctx);
const sessionInjection = await events.get("before_agent_start")({}, ctx);
assert.equal(sessionInjection, undefined, "manual injection uses provider context, not before_agent_start session messages");
const contextAfterSessionStart = await events.get("context")(
	{ messages: [{ role: "user", content: "Use board after session start", timestamp: 11 }] },
	ctx,
);
assert.equal(contextAfterSessionStart.messages[0].customType, "live-decision-board-context", "before_agent_start does not consume pending injection");

const nonTuiCtx = { ...ctx, mode: "headless" };
await commands.get("board-inject").handler("", nonTuiCtx);
const nonTuiInjected = await events.get("context")(
	{ messages: [{ role: "user", content: "Use board without TUI", timestamp: 12 }] },
	ctx,
);
assert.equal(nonTuiInjected.messages[0].customType, "live-decision-board-context", "non-TUI injection skips cleanup UI but still injects explicitly");

ctx.ui.custom = async () => {
	await commands.get("assume").handler("Board changed during injection review", ctx);
	return { type: "apply", recommendations: [] };
};
await commands.get("board-inject").handler("", ctx);
const staleReviewContext = await events.get("context")(
	{ messages: [{ role: "user", content: "Do not inject stale review", timestamp: 13 }] },
	ctx,
);
assert.deepEqual(staleReviewContext.messages, [{ role: "user", content: "Do not inject stale review", timestamp: 13 }], "board-inject does not inject after a stale cleanup review");

ctx.ui.custom = async () => ({ type: "apply", recommendations: [] });
await commands.get("board-inject").handler("", ctx);
await commands.get("assume").handler("Board changed after injection was queued", ctx);
const changedBeforeContext = await events.get("context")(
	{ messages: [{ role: "user", content: "Do not inject changed board", timestamp: 14 }] },
	ctx,
);
assert.deepEqual(changedBeforeContext.messages, [{ role: "user", content: "Do not inject changed board", timestamp: 14 }], "queued injection is bound to the reviewed board version");
const consumedAfterRace = await events.get("context")(
	{ messages: [{ role: "user", content: "Still no stale injection", timestamp: 15 }] },
	ctx,
);
assert.deepEqual(consumedAfterRace.messages, [{ role: "user", content: "Still no stale injection", timestamp: 15 }], "stale queued injection is consumed instead of leaking into a later board version");

ctx.ui.custom = async () => ({ type: "apply", recommendations: [] });
await commands.get("board-inject").handler("", ctx);
const reviewedBoard = entries.at(-1).data;
branchEntries = [{
	type: "custom",
	customType: "live-decision-board",
	data: {
		...reviewedBoard,
		items: reviewedBoard.items.map((item) => item.id === "D1" ? { ...item, text: "Unreviewed same-version restored board" } : item),
	},
}];
await events.get("session_tree")({}, ctx);
const sameVersionRestoreContext = await events.get("context")(
	{ messages: [{ role: "user", content: "Do not inject same-version restore", timestamp: 16 }] },
	ctx,
);
assert.deepEqual(sameVersionRestoreContext.messages, [{ role: "user", content: "Do not inject same-version restore", timestamp: 16 }], "queued injection is bound to board epoch as well as version");

const defaultSessionContext = await events.get("before_agent_start")({}, ctx);
assert.equal(defaultSessionContext, undefined, "before_agent_start does not inject board context by default");

const busyCtx = { ...ctx, isIdle: () => false };
const previousMessage = latestMessage;
await commands.get("assume").handler("Implementation should stay surgical", busyCtx);
assert.equal(latestMessage, previousMessage, "busy board edits update the widget but do not steer hidden context by default");

ctx.ui.editor = async (_title, initial) => {
	assert.doesNotMatch(initial, /\bsoft\b|\bhard\b|strength/i, "board editor should hide stored metadata fields");
	return initial.replace("Implementation should stay surgical", "Implementation should stay tiny");
};
await commands.get("board").handler("", busyCtx);
assert(entries.at(-1).data.items.some((item) => item.text === "Implementation should stay tiny"));
assert.equal(latestMessage, previousMessage, "busy user board edits update the widget but do not steer hidden context by default");

assert(events.has("tool_call"), "tool_call hook should be registered");
const allowedWrite = await events.get("tool_call")({ toolName: "write", input: { path: "x", content: "y" } }, ctx);
assert.equal(allowedWrite, undefined, "visible-only default does not block writes after board changes");

const allowedRedirect = await events.get("tool_call")({ toolName: "bash", input: { command: "echo hi > file.txt" } }, ctx);
assert.equal(allowedRedirect, undefined, "visible-only default does not block mutating shell commands");

const allowed = await events.get("tool_call")({ toolName: "read", input: { path: "README.md" } }, ctx);
assert.equal(allowed, undefined, "read-only tools are not blocked");

branchEntries = [
	{ type: "custom", customType: "live-decision-board", data: activeBoardForRestore },
	{
		type: "custom",
		customType: "live-decision-board",
		data: { version: activeBoardForRestore.version + 1, nextAssumptionId: 2, nextDecisionId: 3, items: [null] },
	},
];
await events.get("session_tree")({}, ctx);
const allowedAfterRestore = await events.get("tool_call")({ toolName: "write", input: { path: "x", content: "y" } }, ctx);
assert.equal(allowedAfterRestore, undefined, "visible-only default mode does not create a stale-write barrier after restore");

await events.get("context")({ messages: [{ role: "user", content: "Sync restored board", timestamp: 5 }] }, ctx);
await commands.get("board-clear").handler("", ctx);
assert.equal(entries.at(-1).data.items.length, 2, "board-clear retains board history");
assert.deepEqual(entries.at(-1).data.items.map((item) => item.status), ["archived", "archived"], "board-clear archives active items instead of deleting them");
assert.equal(latestWidget, undefined, "archived-only boards hide the persistent widget");
const clearContextResult = await events.get("context")(
	{ messages: [{ role: "user", content: "Continue after clear", timestamp: 6 }] },
	ctx,
);
assert.deepEqual(clearContextResult.messages, [{ role: "user", content: "Continue after clear", timestamp: 6 }], "cleared boards do not inject stale-barrier context by default");
const allowedAfterClearInjection = await events.get("tool_call")({ toolName: "write", input: { path: "x", content: "y" } }, ctx);
assert.equal(allowedAfterClearInjection, undefined, "visible-only default does not block writes after clear");
const sessionContextAfterClearInjection = await events.get("before_agent_start")({}, ctx);
assert.equal(sessionContextAfterClearInjection, undefined, "before_agent_start stays default no-op even after clear");

{
	const localCommands = new Map();
	const localEvents = new Map();
	const localEntries = [];
	let localTool;
	const localCtx = {
		hasUI: true,
		isIdle: () => true,
		sessionManager: { getBranch: () => [] },
		ui: {
			theme: { fg: (_color, text) => text },
			setStatus: () => {},
			setWidget: () => {},
			notify: () => {},
			confirm: async () => true,
			editor: async (_title, initial) => initial,
		},
	};

	extension({
		on(eventName, callback) {
			localEvents.set(eventName, callback);
		},
		registerCommand(name, def) {
			localCommands.set(name, def);
		},
		registerTool(tool) {
			localTool = tool;
		},
		appendEntry(customType, data) {
			localEntries.push({ type: "custom", customType, data });
		},
		sendMessage() {},
	});

	await localEvents.get("session_start")({}, localCtx);
	await localCommands.get("goal").handler("Ship the board taxonomy", localCtx);
	await localCommands.get("goal").handler("Polish the board taxonomy", localCtx);
	let board = localEntries.at(-1).data;
	assert.equal(board.items.find((item) => item.id === "G1")?.status, "archived", "/goal should archive the previous active goal");
	assert.equal(board.items.find((item) => item.id === "G2")?.text, "Polish the board taxonomy", "/goal should create the current goal");
	assert.equal(board.items.filter((item) => item.kind === "goal" && item.status === "active").length, 1, "/goal keeps one active current goal");

	await assert.rejects(
		() => localTool.execute("bad-kind-tool", { action: "add", kind: "bogus", text: "Bad kind" }, undefined, undefined, localCtx),
		/Invalid board item kind/,
		"direct tool execution should not persist invalid board kinds when schema validation is bypassed",
	);
	await localTool.execute(
		"goal-tool",
		{ action: "add", kind: "goal", text: "Tool-set current goal", status: "active" },
		undefined,
		undefined,
		localCtx,
	);
	board = localEntries.at(-1).data;
	assert.equal(board.items.find((item) => item.id === "G2")?.status, "archived", "decision_board add kind=goal should archive the previous goal");
	assert.equal(board.items.at(-1).id, "G3", "tool-created goals use G-prefixed ids");
	assert(JSON.stringify(localTool.parameters).includes('"goal"'), "decision_board schema should accept goal kind");
}

{
	const localCommands = new Map();
	const localEvents = new Map();
	const localEntries = [];
	let localTool;
	const localCtx = {
		hasUI: true,
		isIdle: () => true,
		sessionManager: { getBranch: () => [] },
		ui: {
			theme: { fg: (_color, text) => text },
			setStatus: () => {},
			setWidget: () => {},
			notify: () => {},
			confirm: async () => true,
			editor: async (_title, initial) => initial,
		},
	};

	extension({
		on(eventName, callback) {
			localEvents.set(eventName, callback);
		},
		registerCommand(name, def) {
			localCommands.set(name, def);
		},
		registerTool(tool) {
			localTool = tool;
		},
		appendEntry(customType, data) {
			localEntries.push({ type: "custom", customType, data });
		},
		sendMessage() {},
	});

	await localEvents.get("session_start")({}, localCtx);
	await localCommands.get("decide").handler("Completed implementation detail", localCtx);
	const board = localEntries.at(-1).data;
	const d1 = board.items.find((item) => item.id === "D1");
	assert.equal(typeof d1?.version, "number");
	const toolSchema = JSON.stringify(localTool.parameters);
	assert(toolSchema.includes('"archive"'), "decision_board schema should expose direct archive action");
	assert(!toolSchema.includes('"remove"'), "decision_board schema should not expose remove alias");
	assert(toolSchema.includes("itemVersion"), "decision_board archive action should accept an itemVersion freshness guard");
	assert(toolSchema.includes("reason"), "decision_board archive action should accept a reason");

	await assert.rejects(
		() => localTool.execute("archive-missing-reason", { action: "archive", id: "D1", itemVersion: d1.version }, undefined, undefined, localCtx),
		/archive requires reason/,
		"direct archive requires a reason",
	);
	await assert.rejects(
		() => localTool.execute("archive-stale", { action: "archive", id: "D1", itemVersion: d1.version + 1, reason: "Deprecated implementation note" }, undefined, undefined, localCtx),
		/changed since it was observed/,
		"direct archive rejects stale item versions",
	);
	const archiveResult = await localTool.execute(
		"archive-direct",
		{ action: "archive", id: "D1", itemVersion: d1.version, reason: "Deprecated implementation note" },
		undefined,
		undefined,
		localCtx,
	);
	assert.match(archiveResult.content[0].text, /Archived D1/);
	const archivedBoard = localEntries.at(-1).data;
	const archivedD1 = archivedBoard.items.find((item) => item.id === "D1");
	assert.equal(archivedD1?.status, "archived", "direct archive removes item from active context");
	assert.doesNotMatch(archiveResult.details.boardContext, /Completed implementation detail/, "direct archived item leaves active prompt context");
	const beforeNoOp = localEntries.length;
	await assert.rejects(
		() => localTool.execute("archive-inactive-stale", { action: "archive", id: "D1", itemVersion: d1.version, reason: "Already archived" }, undefined, undefined, localCtx),
		/changed since it was observed/,
		"direct archive still rejects stale item versions for inactive items",
	);
	const noChangeResult = await localTool.execute(
		"archive-inactive",
		{ action: "archive", id: "D1", itemVersion: archivedD1.version, reason: "Already archived" },
		undefined,
		undefined,
		localCtx,
	);
	assert.equal(localEntries.length, beforeNoOp, "direct archive is a no-op for inactive items");
	assert.match(noChangeResult.content[0].text, /already inactive/i);
}

{
	const localCommands = new Map();
	const localEvents = new Map();
	const localEntries = [];
	let localTool;
	const localCtx = {
		hasUI: true,
		isIdle: () => true,
		sessionManager: { getBranch: () => [] },
		ui: {
			theme: { fg: (_color, text) => text },
			setStatus: () => {},
			setWidget: () => {},
			notify: () => {},
			confirm: async () => true,
			editor: async (_title, initial) => initial,
		},
	};

	extension({
		on(eventName, callback) {
			localEvents.set(eventName, callback);
		},
		registerCommand(name, def) {
			localCommands.set(name, def);
		},
		registerTool(tool) {
			localTool = tool;
		},
		appendEntry(customType, data) {
			localEntries.push({ type: "custom", customType, data });
		},
		sendMessage() {},
	});

	await localEvents.get("session_start")({}, localCtx);
	await localCommands.get("decide").handler("Original active decision", localCtx);
	const originalD1 = localEntries.at(-1).data.items.find((item) => item.id === "D1");
	await assert.rejects(
		() => localTool.execute("update-missing-version", { action: "update", id: "D1", text: "Missing version edit" }, undefined, undefined, localCtx),
		/update requires itemVersion/,
		"direct update requires an itemVersion freshness guard",
	);
	await assert.rejects(
		() => localTool.execute("update-stale-version", { action: "update", id: "D1", itemVersion: originalD1.version + 1, text: "Stale edit" }, undefined, undefined, localCtx),
		/changed since it was observed/,
		"direct update rejects stale item versions",
	);
	const updateResult = await localTool.execute(
		"update-current-version",
		{ action: "update", id: "D1", itemVersion: originalD1.version, text: "Corrected active decision" },
		undefined,
		undefined,
		localCtx,
	);
	assert.match(updateResult.content[0].text, /Updated D1/);
	assert.equal(localEntries.at(-1).data.items.find((item) => item.id === "D1")?.text, "Corrected active decision");
	await assert.rejects(
		() => localTool.execute("update-old-version", { action: "update", id: "D1", itemVersion: originalD1.version, text: "Overwrite newer edit" }, undefined, undefined, localCtx),
		/changed since it was observed/,
		"direct update cannot overwrite a newer board item edit",
	);
}

{
	let nonTuiNotification = "";
	await commands.get("board-manage").handler("", {
		...ctx,
		mode: "rpc",
		ui: {
			...ctx.ui,
			notify: (message) => {
				nonTuiNotification = message;
			},
			custom: async () => {
				throw new Error("board-manage should not open a custom TUI outside TUI mode");
			},
		},
	});
	assert.match(nonTuiNotification, /requires TUI mode/, "board-manage should explain that it needs TUI mode");
}

{
	const localCommands = new Map();
	const localEvents = new Map();
	let customCalls = 0;
	const localCtx = {
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		sessionManager: { getBranch: () => [] },
		ui: {
			theme: { fg: (_color, text) => text },
			setStatus: () => {},
			setWidget: () => {},
			notify: () => {},
			confirm: async () => true,
			editor: async (_title, initial) => initial,
			custom: async () => {
				customCalls += 1;
				if (customCalls > 1) throw new Error("board-manage reopened after overlay dismissal");
				return undefined;
			},
		},
	};

	extension({
		on(eventName, callback) {
			localEvents.set(eventName, callback);
		},
		registerCommand(name, def) {
			localCommands.set(name, def);
		},
		registerTool() {},
		appendEntry() {},
		sendMessage() {},
	});

	await localEvents.get("session_start")({}, localCtx);
	await localCommands.get("board-manage").handler("", localCtx);
	assert.equal(customCalls, 1, "board-manage treats overlay dismissal as cancel instead of reopening");
}

{
	let cleanupNonTuiNotification = "";
	await commands.get("board-cleanup").handler("", {
		...ctx,
		mode: "rpc",
		ui: {
			...ctx.ui,
			notify: (message) => {
				cleanupNonTuiNotification = message;
			},
			custom: async () => {
				throw new Error("board-cleanup should not open a custom TUI outside TUI mode");
			},
		},
	});
	assert.match(cleanupNonTuiNotification, /requires TUI mode/, "board-cleanup should explain that it needs TUI mode");
}

{
	const localCommands = new Map();
	const localEvents = new Map();
	const localEntries = [];
	let latestNotification = "";
	const localCtx = {
		mode: "rpc",
		hasUI: false,
		isIdle: () => true,
		sessionManager: { getBranch: () => [] },
		ui: {
			theme: { fg: (_color, text) => text },
			setStatus: () => {},
			setWidget: () => {},
			notify: (message) => {
				latestNotification = message;
			},
			confirm: async () => {
				throw new Error("board-clear should not bypass confirmation in non-UI mode");
			},
			editor: async (_title, initial) => initial,
		},
	};

	extension({
		on(eventName, callback) {
			localEvents.set(eventName, callback);
		},
		registerCommand(name, def) {
			localCommands.set(name, def);
		},
		registerTool() {},
		appendEntry(customType, data) {
			localEntries.push({ type: "custom", customType, data });
		},
		sendMessage() {},
	});

	await localEvents.get("session_start")({}, localCtx);
	await localCommands.get("decide").handler("Non-UI clear must not mutate", localCtx);
	const entriesBeforeClear = localEntries.length;
	await localCommands.get("board-clear").handler("", localCtx);
	assert.equal(localEntries.length, entriesBeforeClear, "board-clear should not mutate without a UI confirmation surface");
	assert.match(latestNotification, /requires UI mode|requires an interactive confirmation/i, "board-clear should explain non-UI confirmation requirements");
}

{
	const cleanupCommands = new Map();
	const cleanupEvents = new Map();
	const cleanupEntries = [];
	let cleanupNotification = "";
	extension({
		on(eventName, callback) {
			cleanupEvents.set(eventName, callback);
		},
		registerCommand(name, def) {
			cleanupCommands.set(name, def);
		},
		registerTool() {},
		appendEntry(customType, data) {
			cleanupEntries.push({ type: "custom", customType, data });
		},
		sendMessage() {},
	});
	const cleanupCtx = {
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		sessionManager: { getBranch: () => [] },
		ui: {
			...ctx.ui,
			notify: (message) => {
				cleanupNotification = message;
			},
			custom: async () => {
				throw new Error("empty cleanup should not open UI");
			},
		},
	};
	await cleanupEvents.get("session_start")({}, cleanupCtx);
	await cleanupCommands.get("board-cleanup").handler("", cleanupCtx);
	assert.match(cleanupNotification, /No active board items/);
	assert.equal(cleanupEntries.length, 0);
}

{
	const cleanupCommands = new Map();
	const cleanupEvents = new Map();
	const cleanupEntries = [];
	const cleanupRendered = [];
	const cleanupKeys = ["j", "k", "\x1b[32u", "q"];
	let cleanupResult;
	const testTheme = { fg: (_color, text) => text };
	const cleanupCtx = {
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		sessionManager: { getBranch: () => [] },
		ui: {
			theme: testTheme,
			setStatus: () => {},
			setWidget: () => {},
			notify: () => {},
			confirm: async () => true,
			editor: async () => "",
			custom: async (factory) => {
				let result;
				const component = factory({ requestRender: () => {} }, testTheme, {}, (value) => {
					result = value;
				});
				cleanupRendered.push(component.render(100).join("\n"));
				component.handleInput(cleanupKeys.shift());
				cleanupRendered.push(component.render(100).join("\n"));
				component.handleInput(cleanupKeys.shift());
				cleanupRendered.push(component.render(100).join("\n"));
				component.handleInput(cleanupKeys.shift());
				cleanupRendered.push(component.render(100).join("\n"));
				component.handleInput(cleanupKeys.shift());
				cleanupResult = result;
				return result;
			},
		},
	};

	extension({
		on(eventName, callback) {
			cleanupEvents.set(eventName, callback);
		},
		registerCommand(name, def) {
			cleanupCommands.set(name, def);
		},
		registerTool() {},
		appendEntry(customType, data) {
			cleanupEntries.push({ type: "custom", customType, data });
		},
		sendMessage() {},
	});

	await cleanupEvents.get("session_start")({}, cleanupCtx);
	await cleanupCommands.get("decide").handler("Apply Round 5 review fixes", cleanupCtx);
	await cleanupCommands.get("decide").handler("Core implementation constraint", cleanupCtx);
	for (let index = 3; index <= 10; index += 1) {
		await cleanupCommands.get("decide").handler(`Apply Round ${index} review fixes`, cleanupCtx);
	}
	await cleanupCommands.get("board-cleanup").handler("", cleanupCtx);
	assert.match(cleanupRendered[0], /Board Cleanup/);
	assert.match(cleanupRendered[0], /10 board items to review/);
	assert.match(cleanupRendered[0], /9 archive suggestions selected/);
	assert.doesNotMatch(cleanupRendered[0], /10 recommendations • 9 selected/);
	assert.match(cleanupRendered[0], /Archive from active board/);
	assert.match(cleanupRendered[0], /low risk/);
	assert.match(cleanupRendered[0], /Apply Round 5/);
	assert.match(cleanupRendered[0], /\[D1\].*active/);
	assert.doesNotMatch(cleanupRendered[0], /active\/soft|active\/hard/);
	assert.doesNotMatch(cleanupRendered[0], /Hard constraints are kept by default|Hard constraints/i);
	assert.match(cleanupRendered[0], /space toggle/);
	const cleanupInitialTop = cleanupRendered[0].split("\n").slice(0, 4).join("\n");
	assert.match(cleanupInitialTop, /space toggle/, "cleanup keybinding help should be visible before long recommendation lists can push lower content out of the overlay");
	assert.match(cleanupInitialTop, /risk: low risk=safe cleanup/i, "cleanup UI should define risk levels before long recommendation lists can push lower content out of the overlay");
	assert(cleanupRendered[0].indexOf("[D3]") < cleanupRendered[0].indexOf("[D10]"), "cleanup preserves numeric board order within action groups");
	assert.notEqual(cleanupRendered[1], cleanupRendered[0], "j changes selection");
	assert.notEqual(cleanupRendered[3], cleanupRendered[2], "Space key CSI-u input toggles selected action");
	assert.equal(cleanupResult.type, "cancel");
}

{
	const cleanupCommands = new Map();
	const cleanupEvents = new Map();
	const cleanupEntries = [];
	const cleanupCtx = {
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		sessionManager: { getBranch: () => [] },
		ui: {
			theme: { fg: (_color, text) => text },
			setStatus: () => {},
			setWidget: () => {},
			notify: () => {},
			confirm: async () => true,
			editor: async (_title, initial) => initial,
			custom: async () => ({ type: "cancel" }),
		},
	};

	extension({
		on(eventName, callback) {
			cleanupEvents.set(eventName, callback);
		},
		registerCommand(name, def) {
			cleanupCommands.set(name, def);
		},
		registerTool() {},
		appendEntry(customType, data) {
			cleanupEntries.push({ type: "custom", customType, data });
		},
		sendMessage() {},
	});

	await cleanupEvents.get("session_start")({}, cleanupCtx);
	await cleanupCommands.get("decide").handler("Apply Round 11 review fixes", cleanupCtx);
	const entriesBeforeCleanup = cleanupEntries.length;
	await cleanupCommands.get("board-cleanup").handler("", cleanupCtx);
	assert.equal(cleanupEntries.length, entriesBeforeCleanup, "cleanup cancel should persist nothing");
}

{
	const cleanupCommands = new Map();
	const cleanupEvents = new Map();
	const cleanupEntries = [];
	const cleanupCtx = {
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		sessionManager: { getBranch: () => [] },
		ui: {
			theme: { fg: (_color, text) => text },
			setStatus: () => {},
			setWidget: () => {},
			notify: () => {},
			confirm: async () => {
				throw new Error("dismissed cleanup should not ask for confirmation");
			},
			editor: async (_title, initial) => initial,
			custom: async () => undefined,
		},
	};

	extension({
		on(eventName, callback) {
			cleanupEvents.set(eventName, callback);
		},
		registerCommand(name, def) {
			cleanupCommands.set(name, def);
		},
		registerTool() {},
		appendEntry(customType, data) {
			cleanupEntries.push({ type: "custom", customType, data });
		},
		sendMessage() {},
	});

	await cleanupEvents.get("session_start")({}, cleanupCtx);
	await cleanupCommands.get("decide").handler("Apply Round 12 review fixes", cleanupCtx);
	const entriesBeforeCleanup = cleanupEntries.length;
	await cleanupCommands.get("board-cleanup").handler("", cleanupCtx);
	assert.equal(cleanupEntries.length, entriesBeforeCleanup, "cleanup overlay dismissal should cancel without persisting");
}

{
	const cleanupCommands = new Map();
	const cleanupEvents = new Map();
	const cleanupEntries = [];
	const cleanupRendered = [];
	let confirmCalled = false;
	const cleanupCtx = {
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		sessionManager: { getBranch: () => [] },
		ui: {
			theme: { fg: (_color, text) => text },
			setStatus: () => {},
			setWidget: () => {},
			notify: () => {},
			confirm: async () => {
				confirmCalled = true;
				return true;
			},
			editor: async (_title, initial) => initial,
			custom: async (factory) => {
				let result;
				const component = factory({ requestRender: () => {} }, { fg: (_color, text) => text }, {}, (value) => {
					result = value;
				});
				cleanupRendered.push(component.render(120).join("\n"));
				component.handleInput("\x1b[32u");
				cleanupRendered.push(component.render(120).join("\n"));
				component.handleInput("\r");
				return result;
			},
		},
	};

	extension({
		on(eventName, callback) {
			cleanupEvents.set(eventName, callback);
		},
		registerCommand(name, def) {
			cleanupCommands.set(name, def);
		},
		registerTool() {},
		appendEntry(customType, data) {
			cleanupEntries.push({ type: "custom", customType, data });
		},
		sendMessage() {},
	});

	await cleanupEvents.get("session_start")({}, cleanupCtx);
	await cleanupCommands.get("decide").handler("Core implementation constraint", cleanupCtx);
	const entriesBeforeCleanup = cleanupEntries.length;
	await cleanupCommands.get("board-cleanup").handler("", cleanupCtx);
	assert.match(cleanupRendered[0], /\[ \]\s*\[D1\] active Keep/i, "keep recommendations start unselected");
	assert.match(cleanupRendered[1], /\[x\]\s*\[D1\] active Archive from active board/i, "Space marks keep recommendations as manual archive overrides");
	assert.equal(confirmCalled, true, "manual archive override opens cleanup confirmation");
	assert.equal(cleanupEntries.length, entriesBeforeCleanup + 1, "manual archive override persists cleanup");
	assert.equal(cleanupEntries.at(-1).data.items.find((item) => item.id === "D1")?.status, "archived");
}

{
	const cleanupCommands = new Map();
	const cleanupEvents = new Map();
	const cleanupEntries = [];
	let latestNotification = "";
	let confirmCalled = false;
	const cleanupCtx = {
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		sessionManager: { getBranch: () => [] },
		ui: {
			theme: { fg: (_color, text) => text },
			setStatus: () => {},
			setWidget: () => {},
			notify: (message) => {
				latestNotification = message;
			},
			confirm: async () => {
				confirmCalled = true;
				return true;
			},
			editor: async (_title, initial) => initial,
			custom: async (factory) => {
				let result;
				const component = factory({ requestRender: () => {} }, { fg: (_color, text) => text }, {}, (value) => {
					result = value;
				});
				component.handleInput("\r");
				return result;
			},
		},
	};

	extension({
		on(eventName, callback) {
			cleanupEvents.set(eventName, callback);
		},
		registerCommand(name, def) {
			cleanupCommands.set(name, def);
		},
		registerTool() {},
		appendEntry(customType, data) {
			cleanupEntries.push({ type: "custom", customType, data });
		},
		sendMessage() {},
	});

	await cleanupEvents.get("session_start")({}, cleanupCtx);
	await cleanupCommands.get("decide").handler("Core implementation constraint", cleanupCtx);
	latestNotification = "";
	const entriesBeforeCleanup = cleanupEntries.length;
	await cleanupCommands.get("board-cleanup").handler("", cleanupCtx);
	assert.equal(confirmCalled, false, "cleanup should skip confirmation when no actionable selected changes");
	assert.equal(latestNotification, "Board cleanup: no selected changes");
	assert.equal(cleanupEntries.length, entriesBeforeCleanup, "no selected cleanup actions should persist nothing");
}

{
	const cleanupCommands = new Map();
	const cleanupEvents = new Map();
	const cleanupEntries = [];
	let confirmMessage = "";
	let confirmTitle = "";
	let latestNotification = "";
	const cleanupCtx = {
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		sessionManager: { getBranch: () => [] },
		ui: {
			theme: { fg: (_color, text) => text },
			setStatus: () => {},
			setWidget: () => {},
			notify: (message) => {
				latestNotification = message;
			},
			confirm: async (title, message) => {
				confirmTitle = title;
				confirmMessage = message;
				return true;
			},
			editor: async (_title, initial) => initial,
			custom: async (factory) => {
				let result;
				const component = factory({ requestRender: () => {} }, { fg: (_color, text) => text }, {}, (value) => {
					result = value;
				});
				component.handleInput("\r");
				return result;
			},
		},
	};

	extension({
		on(eventName, callback) {
			cleanupEvents.set(eventName, callback);
		},
		registerCommand(name, def) {
			cleanupCommands.set(name, def);
		},
		registerTool() {},
		appendEntry(customType, data) {
			cleanupEntries.push({ type: "custom", customType, data });
		},
		sendMessage() {},
	});

	await cleanupEvents.get("session_start")({}, cleanupCtx);
	await cleanupCommands.get("decide").handler("Apply Round 11 historical cleanup", cleanupCtx);
	await cleanupCommands.get("decide").handler("Core implementation constraint", cleanupCtx);
	const entriesBeforeCleanup = cleanupEntries.length;
	await cleanupCommands.get("board-cleanup").handler("", cleanupCtx);
	assert.equal(confirmTitle, "Apply Board Cleanup?");
	assert.match(confirmMessage, /Active items:\s*2\s*→\s*1/i);
	assert.match(confirmMessage, /Archive:\s*1/i);
	assert.doesNotMatch(confirmMessage, /Supersede:/i);
	assert.doesNotMatch(confirmMessage, /Hard constraints/i);
	assert.match(confirmMessage, /Archive from active board:/i);
	assert.match(confirmMessage, /\[D1] Apply Round 11 historical cleanup/);
	assert.doesNotMatch(confirmMessage, /\[D2].*Core implementation constraint/, "confirmation should list only selected cleanup changes");
	assert.match(latestNotification, /Cleaned board/i);
	assert.equal(cleanupEntries.length, entriesBeforeCleanup + 1, "confirmed board cleanup persists once");
	assert.equal(cleanupEntries.at(-1).data.items.find((item) => item.id === "D1").status, "archived");
	assert(cleanupEntries.at(-1).data.items.find((item) => item.id === "D1"));
}

{
	const cleanupCommands = new Map();
	const cleanupEvents = new Map();
	const cleanupEntries = [];
	let confirmCalled = false;
	let latestNotification = "";
	const cleanupCtx = {
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		sessionManager: { getBranch: () => [] },
		ui: {
			theme: { fg: (_color, text) => text },
			setStatus: () => {},
			setWidget: () => {},
			notify: (message) => {
				latestNotification = message;
			},
			confirm: async () => {
				confirmCalled = true;
				return false;
			},
			editor: async (_title, initial) => initial,
			custom: async (factory) => {
				let result;
				const component = factory({ requestRender: () => {} }, { fg: (_color, text) => text }, {}, (value) => {
					result = value;
				});
				component.handleInput("\r");
				return result;
			},
		},
	};

	extension({
		on(eventName, callback) {
			cleanupEvents.set(eventName, callback);
		},
		registerCommand(name, def) {
			cleanupCommands.set(name, def);
		},
		registerTool() {},
		appendEntry(customType, data) {
			cleanupEntries.push({ type: "custom", customType, data });
		},
		sendMessage() {},
	});

	await cleanupEvents.get("session_start")({}, cleanupCtx);
	await cleanupCommands.get("decide").handler("Apply Round 11 historical cleanup", cleanupCtx);
	await cleanupCommands.get("decide").handler("Core implementation constraint", cleanupCtx);
	latestNotification = "";
	const entriesBeforeCleanup = cleanupEntries.length;
	await cleanupCommands.get("board-cleanup").handler("", cleanupCtx);
	assert.equal(confirmCalled, true);
	assert.equal(latestNotification, "");
	assert.equal(cleanupEntries.length, entriesBeforeCleanup, "declined confirmation should persist nothing");
}

{
	const cleanupCommands = new Map();
	const cleanupEvents = new Map();
	const cleanupEntries = [];
	let latestNotification = "";
	let confirmCalled = false;
	const localBranchEntries = [];
	const cleanupCtx = {
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		sessionManager: { getBranch: () => localBranchEntries },
		ui: {
			theme: { fg: (_color, text) => text },
			setStatus: () => {},
			setWidget: () => {},
			notify: (message) => {
				latestNotification = message;
			},
			confirm: async () => {
				confirmCalled = true;
				return true;
			},
			editor: async (_title, initial) => initial,
			custom: async (factory) => {
				let result;
				const component = factory({ requestRender: () => {} }, { fg: (_color, text) => text }, {}, (value) => {
					result = value;
				});
				const baseBoard = cleanupEntries.at(-1).data;
				const staleBoard = {
					...baseBoard,
					version: baseBoard.version + 1,
					hardDecisionBarrierVersion: baseBoard.hardDecisionBarrierVersion,
					items: baseBoard.items.map((item) => ({
						...item,
						text: `${item.text} (stale restore while cleanup open)`,
					})),
				};
				localBranchEntries.length = 0;
				localBranchEntries.push({ type: "custom", customType: "live-decision-board", data: staleBoard });
				await cleanupEvents.get("session_tree")({}, cleanupCtx);
				component.handleInput("\r");
				return result;
			},
		},
	};

	extension({
		on(eventName, callback) {
			cleanupEvents.set(eventName, callback);
		},
		registerCommand(name, def) {
			cleanupCommands.set(name, def);
		},
		registerTool() {},
		appendEntry(customType, data) {
			cleanupEntries.push({ type: "custom", customType, data });
		},
		sendMessage() {},
	});

	await cleanupEvents.get("session_start")({}, cleanupCtx);
	await cleanupCommands.get("decide").handler("Apply Round 11 stale cleanup candidate", cleanupCtx);
	const entriesBeforeCleanup = cleanupEntries.length;
	await cleanupCommands.get("board-cleanup").handler("", cleanupCtx);
	assert.equal(cleanupEntries.length, entriesBeforeCleanup, "stale cleanup should persist nothing");
	assert.match(latestNotification, /changed while cleanup was open/i);
	assert.equal(confirmCalled, false, "stale cleanup should not open confirmation");
}

{
	const localCommands = new Map();
	const localEvents = new Map();
	const localEntries = [];
	let reviewCleanupRender = [];
	let confirmCalled = false;
	let confirmationMessage = "";
	let localTool;
	const localCtx = {
		hasUI: true,
		mode: "tui",
		isIdle: () => true,
		sessionManager: { getBranch: () => localEntries },
		ui: {
			theme: { fg: (_color, text) => text },
			setStatus: () => {},
			setWidget: () => {},
			notify: () => {},
			confirm: async (title, message) => {
				confirmCalled = true;
				confirmationMessage = `${title}: ${message}`;
				return true;
			},
			editor: async (_title, initial) => initial,
			custom: async (factory) => {
				let result;
				const component = factory({ requestRender: () => {} }, { fg: (_color, text) => text }, {}, (value) => {
					result = value;
				});
				reviewCleanupRender.push(component.render(120).join("\n"));
				component.handleInput(" ");
				reviewCleanupRender.push(component.render(120).join("\n"));
				component.handleInput(" ");
				reviewCleanupRender.push(component.render(120).join("\n"));
				component.handleInput("\r");
				return result;
			},
		},
	};

	extension({
		on(eventName, callback) {
			localEvents.set(eventName, callback);
		},
		registerCommand(name, def) {
			localCommands.set(name, def);
		},
		registerTool(tool) {
			localTool = tool;
		},
		appendEntry(customType, data) {
			localEntries.push({ type: "custom", customType, data });
		},
		sendMessage() {},
	});

	await localEvents.get("session_start")({}, localCtx);
	await localCommands.get("decide").handler("Decision one", localCtx);
	await localCommands.get("decide").handler("Decision two", localCtx);
	const startingBoard = localEntries.at(-1).data;
	const d1 = startingBoard.items.find((item) => item.id === "D1");
	const d2 = startingBoard.items.find((item) => item.id === "D2");
	assert.equal(typeof d1?.id, "string");
	assert.equal(typeof d2?.id, "string");

	const toolResult = await localTool.execute(
		"review-tool-1",
		{
			action: "review_cleanup",
			recommendations: [
				{
					id: "D1",
					itemVersion: d1.version,
					observedText: d1.text,
					observedStatus: d1.status,
					observedStrength: d1.strength,
					action: "archive",
					riskLevel: "high risk",
					requiresExplicitConfirmation: true,
					reason: "Historical decision",
					confidence: "high",
					evidence: ["local test"],
				},
				{
					id: "D2",
					itemVersion: d2.version,
					observedText: d2.text,
					observedStatus: d2.status,
					observedStrength: d2.strength,
					action: "keep",
					riskLevel: "low risk",
					requiresExplicitConfirmation: false,
					reason: "Keep by default",
					confidence: "low",
					evidence: ["local test"],
				},
			],
		},
		undefined,
		undefined,
		localCtx,
	);

	assert.equal(confirmCalled, true, "review_cleanup should open confirmation for actionable imported recommendations");
	assert.match(confirmationMessage, /Apply Board Cleanup\?/);
	assert.match(reviewCleanupRender[0], /\[x\]\s*\[D1\] active Archive/i, "imported archive recommendations should be initially selected");
	assert.match(reviewCleanupRender[1], /\[ \]\s*\[D1\] active Archive/i, "space toggles imported archive recommendation off");
	assert.match(reviewCleanupRender[2], /\[x\]\s*\[D1\] active Archive/i, "space toggles imported archive recommendation back on");
	assert.match(toolResult.content[0].text, /reviewed\s+2/i);
	assert.equal(localEntries.at(-1).data.items.find((item) => item.id === "D1")?.status, "archived");
	assert.equal(localEntries.at(-1).data.items.find((item) => item.id === "D2")?.status, "active");
}

{
	const localCommands = new Map();
	const localEvents = new Map();
	const localEntries = [];
	let localTool;
	let reviewCleanupRender = [];
	let confirmCalled = false;
	let toolResult;
	const localCtx = {
		hasUI: true,
		mode: "tui",
		isIdle: () => true,
		sessionManager: { getBranch: () => localEntries },
		ui: {
			theme: { fg: (_color, text) => text },
			setStatus: () => {},
			setWidget: () => {},
			notify: () => {},
			confirm: async () => {
				confirmCalled = true;
				return true;
			},
			editor: async (_title, initial) => initial,
			custom: async (factory) => {
				let result;
				const component = factory({ requestRender: () => {} }, { fg: (_color, text) => text }, {}, (value) => {
					result = value;
				});
				reviewCleanupRender.push(component.render(120).join("\n"));
				component.handleInput("\r");
				return result;
			},
		},
	};

	extension({
		on(eventName, callback) {
			localEvents.set(eventName, callback);
		},
		registerCommand(name, def) {
			localCommands.set(name, def);
		},
		registerTool(tool) {
			localTool = tool;
		},
		appendEntry(customType, data) {
			localEntries.push({ type: "custom", customType, data });
		},
		sendMessage() {},
	});

	await localEvents.get("session_start")({}, localCtx);
	await localCommands.get("decide").handler("Archive recommendation", localCtx);
	await localCommands.get("decide").handler("Keep recommendation", localCtx);
	const startingBoard = localEntries.at(-1).data;
	const latest = startingBoard.items.find((item) => item.id === "D2");
	const stale = startingBoard.items.find((item) => item.id === "D1");
	assert.equal(typeof stale?.id, "string");
	assert.equal(typeof latest?.id, "string");

	const mixedRecommendationsPayload = {
		action: "review_cleanup",
		recommendations: [
			{
				id: "malformed-missing-reason",
				itemVersion: latest.version,
				observedText: latest.text,
				observedStatus: latest.status,
				observedStrength: latest.strength,
				action: "archive",
				riskLevel: "low risk",
				requiresExplicitConfirmation: false,
				confidence: "high",
				evidence: ["local test"],
			},
			{
				id: "D1",
				itemVersion: stale.version - 1,
				observedText: "does-not-match-stale-text",
				observedStatus: stale.status,
				observedStrength: stale.strength,
				action: "archive",
				riskLevel: "low risk",
				requiresExplicitConfirmation: false,
				reason: "Stale suggestion",
				confidence: "high",
				evidence: ["local test"],
			},
			{
				id: "D2",
				itemVersion: latest.version,
				observedText: latest.text,
				observedStatus: latest.status,
				observedStrength: latest.strength,
				action: "archive",
				riskLevel: "low risk",
				requiresExplicitConfirmation: false,
				reason: "Fresh recommendation",
				confidence: "low",
				evidence: ["local test"],
			},
		],
	};
	assert.equal(Check(localTool.parameters, mixedRecommendationsPayload), true, "tool schema should allow malformed recommendations through so normalization can skip/report them");

	toolResult = await localTool.execute(
		"review-tool-stale",
		mixedRecommendationsPayload,
		undefined,
		undefined,
		localCtx,
	);
	assert.match(reviewCleanupRender[0], /\[x\]\s*\[D2\] active Archive/i);
	assert.doesNotMatch(reviewCleanupRender[0], /\[D1\]/, "stale recommendations should be skipped before opening UI");
	assert.equal(confirmCalled, true, "fresh imported recommendation should still allow confirmation");
	assert.match(toolResult.content[0].text, /2 skipped/i);
	assert.equal(localEntries.at(-1).data.items.find((item) => item.id === "D2")?.status, "archived");
	assert.equal(localEntries.at(-1).data.items.find((item) => item.id === "D1")?.status, stale.status);
	assert.equal(toolResult.details?.skipped?.length, 2, "tool result should report skipped recommendations");
	assert.equal(toolResult.details?.skipped?.[0]?.id, "malformed-missing-reason");
	assert.equal(toolResult.details?.skipped?.[1]?.id, "D1");
}

{
	const localCommands = new Map();
	const localEvents = new Map();
	const localEntries = [];
	let localTool;
	let confirmCalled = false;
	let toolResult;
	const localCtx = {
		hasUI: true,
		mode: "tui",
		isIdle: () => true,
		sessionManager: { getBranch: () => localEntries },
		ui: {
			theme: { fg: (_color, text) => text },
			setStatus: () => {},
			setWidget: () => {},
			notify: () => {},
			confirm: async () => {
				confirmCalled = true;
				return true;
			},
			editor: async (_title, initial) => initial,
			custom: async (factory) => {
				let result;
				const component = factory({ requestRender: () => {} }, { fg: (_color, text) => text }, {}, (value) => {
					result = value;
				});
				component.handleInput("\r");
				return result;
			},
		},
	};

	extension({
		on(eventName, callback) {
			localEvents.set(eventName, callback);
		},
		registerCommand(name, def) {
			localCommands.set(name, def);
		},
		registerTool(tool) {
			localTool = tool;
		},
		appendEntry(customType, data) {
			localEntries.push({ type: "custom", customType, data });
		},
		sendMessage() {},
	});

	await localEvents.get("session_start")({}, localCtx);
	await localCommands.get("decide").handler("Duplicate cleanup target", localCtx);
	const startingBoard = localEntries.at(-1).data;
	const d1 = startingBoard.items.find((item) => item.id === "D1");
	assert.equal(typeof d1?.id, "string");

	toolResult = await localTool.execute(
		"review-tool-duplicate",
		{
			action: "review_cleanup",
			recommendations: [
				{
					id: "D1",
					itemVersion: d1.version,
					observedText: d1.text,
					observedStatus: d1.status,
					observedStrength: d1.strength,
					action: "archive",
					riskLevel: "low risk",
					requiresExplicitConfirmation: false,
					reason: "First duplicate recommendation",
					confidence: "high",
					evidence: ["local test"],
				},
				{
					id: "D1",
					itemVersion: d1.version,
					observedText: d1.text,
					observedStatus: d1.status,
					observedStrength: d1.strength,
					action: "archive",
					riskLevel: "low risk",
					requiresExplicitConfirmation: false,
					reason: "Second duplicate recommendation",
					confidence: "medium",
					evidence: ["local test"],
				},
			],
		},
		undefined,
		undefined,
		localCtx,
	);
	assert.equal(confirmCalled, true, "first duplicate should remain reviewable and confirmable");
	assert.match(toolResult.content[0].text, /1 skipped/i, "duplicate imported recommendations should be skipped and reported");
	assert.equal(toolResult.details?.skipped?.[0]?.id, "D1");
	assert.match(toolResult.details?.skipped?.[0]?.reason, /duplicate/i);
	assert.equal(localEntries.at(-1).data.items.find((item) => item.id === "D1")?.status, "archived");
}

{
	const localCommands = new Map();
	const localEvents = new Map();
	const localEntries = [];
	let localTool;
	let customCalled = false;
	const localCtx = {
		hasUI: false,
		mode: "rpc",
		isIdle: () => true,
		sessionManager: { getBranch: () => localEntries },
		ui: {
			theme: { fg: (_color, text) => text },
			setStatus: () => {},
			setWidget: () => {},
			notify: () => {},
			confirm: async () => {
				return true;
			},
			editor: async () => "",
			custom: async () => {
				customCalled = true;
				throw new Error("non-TUI review_cleanup should not render custom component");
			},
		},
	};

	extension({
		on(eventName, callback) {
			localEvents.set(eventName, callback);
		},
		registerCommand(name, def) {
			localCommands.set(name, def);
		},
		registerTool(tool) {
			localTool = tool;
		},
		appendEntry(customType, data) {
			localEntries.push({ type: "custom", customType, data });
		},
		sendMessage() {},
	});

	await localEvents.get("session_start")({}, localCtx);
	await localCommands.get("decide").handler("Non-TUI review", localCtx);
	const beforeNoUi = localEntries.length;
	const board = localEntries.at(-1).data;
	const d1 = board.items.find((item) => item.id === "D1");
	const result = await localTool.execute("review-tool-noui", {
		action: "review_cleanup",
		recommendations: [
			{
				id: "D1",
				itemVersion: d1.version,
				observedText: d1.text,
				observedStatus: d1.status,
				observedStrength: d1.strength,
				action: "archive",
				riskLevel: "low risk",
				requiresExplicitConfirmation: false,
				reason: "No UI",
				confidence: "low",
				evidence: ["local test"],
			},
		],
	},
	undefined,
	undefined,
	localCtx,
	);
	assert.equal(customCalled, false, "non-TUI review_cleanup should avoid interactive UI");
	assert.match(result.content[0].text, /interactive/i);
	assert.match(result.content[0].text, /TUI/i);
	assert.equal(localEntries.length, beforeNoUi, "non-TUI review_cleanup should not mutate board");
}

{
	const localCommands = new Map();
	const localEvents = new Map();
	const localEntries = [];
	let localTool;
	let latestNotification = "";
	let resolveEditor;
	let editorInitial = "";
	const editorResult = new Promise((resolve) => {
		resolveEditor = resolve;
	});
	const localCtx = {
		hasUI: true,
		isIdle: () => true,
		sessionManager: { getBranch: () => [] },
		ui: {
			theme: { fg: (_color, text) => text },
			setStatus: () => {},
			setWidget: () => {},
			notify: (message) => {
				latestNotification = message;
			},
			confirm: async () => true,
			editor: async (_title, initial) => {
				editorInitial = initial;
				return editorResult;
			},
		},
	};

	extension({
		on(eventName, callback) {
			localEvents.set(eventName, callback);
		},
		registerCommand(name, def) {
			localCommands.set(name, def);
		},
		registerTool(tool) {
			localTool = tool;
		},
		appendEntry(customType, data) {
			localEntries.push({ type: "custom", customType, data });
		},
		sendMessage() {},
	});

	await localEvents.get("session_start")({}, localCtx);
	await localCommands.get("assume").handler("Initial assumption", localCtx);
	const editPromise = localCommands.get("board").handler("", localCtx);
	await localTool.execute(
		"local-tool-1",
		{ action: "add", kind: "decision", text: "Concurrent active decision", status: "active", strength: "hard" },
		undefined,
		undefined,
		localCtx,
	);
	const entriesBeforeStaleEditorSave = localEntries.length;
	resolveEditor(editorInitial.replace("Initial assumption", "Stale editor rewrite"));
	await editPromise;
	assert.equal(localEntries.length, entriesBeforeStaleEditorSave, "stale /board editor saves should not append board entries");
	assert(localEntries.at(-1).data.items.some((item) => item.text === "Concurrent active decision"), "stale /board editor saves must not drop concurrent board updates");
	assert.match(latestNotification, /changed while editor was open/, "stale /board editor saves should notify the user to reopen");
}

{
	const localCommands = new Map();
	const localEvents = new Map();
	const localEntries = [];
	let latestNotification = "";
	let localBranchEntries = [];
	let resolveEditor;
	let editorInitial = "";
	const editorResult = new Promise((resolve) => {
		resolveEditor = resolve;
	});
	const sameVersionActiveBoard = {
		version: 1,
		hardDecisionBarrierVersion: 1,
		nextAssumptionId: 1,
		nextDecisionId: 2,
		items: [
			{
				id: "D1",
				kind: "decision",
				text: "Same-version active decision",
				status: "active",
				strength: "hard",
				source: "user",
				version: 1,
				createdAt: 1,
				updatedAt: 1,
			},
		],
	};
	const localCtx = {
		hasUI: true,
		isIdle: () => true,
		sessionManager: { getBranch: () => localBranchEntries },
		ui: {
			theme: { fg: (_color, text) => text },
			setStatus: () => {},
			setWidget: () => {},
			notify: (message) => {
				latestNotification = message;
			},
			confirm: async () => true,
			editor: async (_title, initial) => {
				editorInitial = initial;
				return editorResult;
			},
		},
	};

	extension({
		on(eventName, callback) {
			localEvents.set(eventName, callback);
		},
		registerCommand(name, def) {
			localCommands.set(name, def);
		},
		registerTool() {},
		appendEntry(customType, data) {
			localEntries.push({ type: "custom", customType, data });
		},
		sendMessage() {},
	});

	await localEvents.get("session_start")({}, localCtx);
	await localCommands.get("assume").handler("Initial assumption", localCtx);
	const editPromise = localCommands.get("board").handler("", localCtx);
	localBranchEntries = [{ type: "custom", customType: "live-decision-board", data: sameVersionActiveBoard }];
	await localEvents.get("session_tree")({}, localCtx);
	const entriesBeforeStaleEditorSave = localEntries.length;
	resolveEditor(editorInitial.replace("Initial assumption", "Same-version stale editor rewrite"));
	await editPromise;
	assert.equal(localEntries.length, entriesBeforeStaleEditorSave, "same-version branch changes should make open /board editor saves stale");
	assert.match(latestNotification, /changed while editor was open/, "same-version stale /board editor saves should notify the user to reopen");
	const blockedAfterSameVersionRestore = await localEvents.get("tool_call")({ toolName: "write", input: { path: "x", content: "y" } }, localCtx);
	assert.equal(blockedAfterSameVersionRestore, undefined, "default visible-only mode does not restore enforced barriers");
}

{
	const localCommands = new Map();
	const localEvents = new Map();
	const localEntries = [];
	let latestNotification = "";
	let localBranchEntries = [];
	let resolveConfirm;
	const confirmResult = new Promise((resolve) => {
		resolveConfirm = resolve;
	});
	const sameVersionActiveBoard = {
		version: 1,
		hardDecisionBarrierVersion: 0,
		nextAssumptionId: 2,
		nextDecisionId: 1,
		items: [
			{
				id: "A1",
				kind: "assumption",
				text: "Same-version restored assumption",
				status: "active",
				strength: "soft",
				source: "user",
				version: 1,
				createdAt: 1,
				updatedAt: 1,
			},
		],
	};
	const localCtx = {
		hasUI: true,
		isIdle: () => true,
		sessionManager: { getBranch: () => localBranchEntries },
		ui: {
			theme: { fg: (_color, text) => text },
			setStatus: () => {},
			setWidget: () => {},
			notify: (message) => {
				latestNotification = message;
			},
			confirm: async () => confirmResult,
			editor: async (_title, initial) => initial,
		},
	};

	extension({
		on(eventName, callback) {
			localEvents.set(eventName, callback);
		},
		registerCommand(name, def) {
			localCommands.set(name, def);
		},
		registerTool() {},
		appendEntry(customType, data) {
			localEntries.push({ type: "custom", customType, data });
		},
		sendMessage() {},
	});

	await localEvents.get("session_start")({}, localCtx);
	await localCommands.get("decide").handler("Initial decision", localCtx);
	const clearPromise = localCommands.get("board-clear").handler("", localCtx);
	localBranchEntries = [{ type: "custom", customType: "live-decision-board", data: sameVersionActiveBoard }];
	await localEvents.get("session_tree")({}, localCtx);
	const entriesBeforeStaleClear = localEntries.length;
	resolveConfirm(true);
	await clearPromise;
	assert.equal(localEntries.length, entriesBeforeStaleClear, "same-version branch changes should make open board-clear confirmations stale");
	assert.match(latestNotification, /changed while confirmation was open/, "stale board-clear confirmations should notify the user to retry");
}

{
	const localCommands = new Map();
	const localEvents = new Map();
	const localEntries = [];
	const rendered = [];
	const testTheme = { fg: (_color, text) => text };
	const localCtx = {
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		sessionManager: { getBranch: () => [] },
		ui: {
			theme: testTheme,
			setStatus: () => {},
			setWidget: () => {},
			notify: () => {},
			confirm: async () => true,
			editor: async (_title, initial) => initial,
			custom: async (factory) => {
				let result;
				const component = factory({ requestRender: () => {} }, testTheme, {}, (value) => {
					result = value;
				});
				rendered.push(component.render(100).join("\n"));
				component.handleInput("j");
				rendered.push(component.render(100).join("\n"));
				component.handleInput("q");
				return result;
			},
		},
	};

	extension({
		on(eventName, callback) {
			localEvents.set(eventName, callback);
		},
		registerCommand(name, def) {
			localCommands.set(name, def);
		},
		registerTool() {},
		appendEntry(customType, data) {
			localEntries.push({ type: "custom", customType, data });
		},
		sendMessage() {},
	});

	await localEvents.get("session_start")({}, localCtx);
	await localCommands.get("assume").handler("Managed assumption", localCtx);
	await localCommands.get("decide").handler("Managed decision", localCtx);
	await localCommands.get("goal").handler("Managed goal", localCtx);
	await localCommands.get("board-manage").handler("", localCtx);
	assert.match(rendered[0], /Live Decision Board Manager/, "board-manage should render a titled keyboard UI");
	assert.match(rendered[0], /> goal active Managed goal/, "manager initially selects the active goal and shows kind context without item keys");
	assert.match(rendered[0], /decision active Managed decision/, "manager rows include kind labels now that item keys are hidden");
	assert.doesNotMatch(rendered[0], /\[[GAD]\d+]/, "manager hides item keys in primary UI");
	assert.match(rendered[0], /e edit/, "manager renders keyboard help");
	assert.match(rendered[0], /edit rewrites item text/i, "manager help should explain edit semantics");
	assert.match(rendered[0], /archive keeps history/i, "manager help should explain archive semantics");
	assert.doesNotMatch(rendered[0], /supersede/i, "manager help should not expose supersede actions");
	assert.match(rendered[0], /c clear active/, "manager help should expose archive-only clear action");
	assert.doesNotMatch(rendered[0], /\bh hard\b/, "manager help should not show harden action");
	assert.doesNotMatch(rendered[0], /\bs soft\b/, "manager help should not show soften action");
	assert.match(rendered[1], /> decision active Managed decision/, "j/down moves selection to the next item without showing item keys");
}

{
	const localCommands = new Map();
	const localEvents = new Map();
	const localEntries = [];
	let confirmTitle = "";
	let confirmMessage = "";
	let latestNotification = "";
	const testTheme = { fg: (_color, text) => text };
	const queuedKeys = ["c", "q"];
	const localCtx = {
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		sessionManager: { getBranch: () => [] },
		ui: {
			theme: testTheme,
			setStatus: () => {},
			setWidget: () => {},
			notify: (message) => {
				latestNotification = message;
			},
			confirm: async (title, message) => {
				confirmTitle = title;
				confirmMessage = message;
				return true;
			},
			editor: async (_title, initial) => initial,
			custom: async (factory) => {
				let result;
				const component = factory({ requestRender: () => {} }, testTheme, {}, (value) => {
					result = value;
				});
				component.handleInput(queuedKeys.shift());
				return result;
			},
		},
	};

	extension({
		on(eventName, callback) {
			localEvents.set(eventName, callback);
		},
		registerCommand(name, def) {
			localCommands.set(name, def);
		},
		registerTool() {},
		appendEntry(customType, data) {
			localEntries.push({ type: "custom", customType, data });
		},
		sendMessage() {},
	});

	await localEvents.get("session_start")({}, localCtx);
	await localCommands.get("assume").handler("Manager clear assumption", localCtx);
	await localCommands.get("decide").handler("Manager clear decision", localCtx);
	const entriesBeforeClear = localEntries.length;
	await localCommands.get("board-manage").handler("", localCtx);
	assert.equal(confirmTitle, "Clear Active Board?");
	assert.match(confirmMessage, /archives all active goal, assumptions, and decisions/i);
	assert.equal(localEntries.length, entriesBeforeClear + 1, "manager clear persists exactly once after confirmation");
	assert.equal(localEntries.at(-1).data.items.length, 2, "manager clear retains board history");
	assert.deepEqual(localEntries.at(-1).data.items.map((item) => item.status), ["archived", "archived"], "manager clear archives active board items");
	assert.match(latestNotification, /Cleared active board/);
}

{
	const localCommands = new Map();
	const localEvents = new Map();
	const localEntries = [];
	let latestNotification = "";
	let localBranchEntries = [];
	let resolveConfirm;
	let managerKeyIndex = 0;
	const managerKeys = ["c", "q"];
	const confirmResult = new Promise((resolve) => {
		resolveConfirm = resolve;
	});
	const sameVersionActiveBoard = {
		version: 1,
		hardDecisionBarrierVersion: 1,
		nextAssumptionId: 2,
		nextDecisionId: 1,
		items: [
			{
				id: "A1",
				kind: "assumption",
				text: "Manager stale clear assumption",
				status: "active",
				strength: "soft",
				source: "user",
				version: 1,
				createdAt: 1,
				updatedAt: 1,
			},
		],
	};
	const localCtx = {
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		sessionManager: { getBranch: () => localBranchEntries },
		ui: {
			theme: { fg: (_color, text) => text },
			setStatus: () => {},
			setWidget: () => {},
			notify: (message) => {
				latestNotification = message;
			},
			confirm: async () => confirmResult,
			editor: async (_title, initial) => initial,
			custom: async (factory) => {
				let result;
				const component = factory({ requestRender: () => {} }, { fg: (_color, text) => text }, {}, (value) => {
					result = value;
				});
				component.handleInput(managerKeys[managerKeyIndex] ?? "q");
				managerKeyIndex += 1;
				return result;
			},
		},
	};

	extension({
		on(eventName, callback) {
			localEvents.set(eventName, callback);
		},
		registerCommand(name, def) {
			localCommands.set(name, def);
		},
		registerTool() {},
		appendEntry(customType, data) {
			localEntries.push({ type: "custom", customType, data });
		},
		sendMessage() {},
	});

	await localEvents.get("session_start")({}, localCtx);
	await localCommands.get("decide").handler("Manager stale clear decision", localCtx);
	const managePromise = localCommands.get("board-manage").handler("", localCtx);
	await Promise.resolve();
	const staleBoard = {
		...sameVersionActiveBoard,
	};
	localBranchEntries.length = 0;
	localBranchEntries.push({ type: "custom", customType: "live-decision-board", data: staleBoard });
	await localEvents.get("session_tree")({}, localCtx);
	const entriesBeforeStaleClear = localEntries.length;
	resolveConfirm(true);
	await managePromise;
	assert.equal(localEntries.length, entriesBeforeStaleClear, "stale manager clear confirmations should persist nothing");
	assert.match(latestNotification, /changed while clear confirmation was open/i);
}

{
	const localCommands = new Map();
	const localEvents = new Map();
	const localEntries = [];
	let rendered = "";
	const localCtx = {
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		sessionManager: { getBranch: () => [] },
		ui: {
			theme: { fg: (_color, text) => text },
			setStatus: () => {},
			setWidget: () => {},
			notify: () => {},
			confirm: async () => true,
			editor: async (_title, initial) => initial,
			custom: async (factory) => {
				let result;
				const component = factory({ requestRender: () => {} }, { fg: (_color, text) => text }, {}, (value) => {
					result = value;
				});
				rendered = component.render(100).join("\n");
				component.handleInput("q");
				return result;
			},
		},
	};

	extension({
		on(eventName, callback) {
			localEvents.set(eventName, callback);
		},
		registerCommand(name, def) {
			localCommands.set(name, def);
		},
		registerTool() {},
		appendEntry(customType, data) {
			localEntries.push({ type: "custom", customType, data });
		},
		sendMessage() {},
	});

	await localEvents.get("session_start")({}, localCtx);
	await localCommands.get("board-manage").handler("", localCtx);
	assert.match(rendered, /Use \/goal, \/assume, or \/decide/, "empty manager guidance should mention every quick-capture command");
}

{
	const localCommands = new Map();
	const localEvents = new Map();
	const localEntries = [];
	const testTheme = { fg: (_color, text) => text };
	const queuedKeys = ["s", "q"];
	const localCtx = {
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		sessionManager: { getBranch: () => [] },
		ui: {
			theme: testTheme,
			setStatus: () => {},
			setWidget: () => {},
			notify: () => {},
			confirm: async () => true,
			editor: async (_title, initial) => initial,
			custom: async (factory) => {
				let result;
				const component = factory({ requestRender: () => {} }, testTheme, {}, (value) => {
					result = value;
				});
				component.handleInput(queuedKeys.shift());
				return result;
			},
		},
	};

	extension({
		on(eventName, callback) {
			localEvents.set(eventName, callback);
		},
		registerCommand(name, def) {
			localCommands.set(name, def);
		},
		registerTool() {},
		appendEntry(customType, data) {
			localEntries.push({ type: "custom", customType, data });
		},
		sendMessage() {},
	});

	await localEvents.get("session_start")({}, localCtx);
	await localCommands.get("decide").handler("Already active decision", localCtx);
	const entriesBeforeNoOpManager = localEntries.length;
	await localCommands.get("board-manage").handler("", localCtx);
	assert.equal(localEntries.length, entriesBeforeNoOpManager, "manager no-op actions should not persist duplicate board entries");
}
{
	const localCommands = new Map();
	const localEvents = new Map();
	const localEntries = [];
	const testTheme = { fg: (_color, text) => text };
	const queuedKeys = ["h", "s", "r", "a", "e", "u", "q"];
	const editorTexts = ["Managed decision edited"];
	let editorTitle = "";
	const localCtx = {
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		sessionManager: { getBranch: () => [] },
		ui: {
			theme: testTheme,
			setStatus: () => {},
			setWidget: () => {},
			notify: () => {},
			confirm: async () => true,
			editor: async (title) => {
				editorTitle = title;
				return editorTexts.shift();
			},
			custom: async (factory) => {
				let result;
				const component = factory({ requestRender: () => {} }, testTheme, {}, (value) => {
					result = value;
				});
				while (result === undefined && queuedKeys.length > 0) {
					component.handleInput(queuedKeys.shift());
				}
				return result;
			},
		},
	};

	extension({
		on(eventName, callback) {
			localEvents.set(eventName, callback);
		},
		registerCommand(name, def) {
			localCommands.set(name, def);
		},
		registerTool() {},
		appendEntry(customType, data) {
			localEntries.push({ type: "custom", customType, data });
		},
		sendMessage() {},
	});

	await localEvents.get("session_start")({}, localCtx);
	await localCommands.get("decide").handler("Managed decision", localCtx);
	const entriesBeforeManagerActions = localEntries.length;
	await localCommands.get("board-manage").handler("", localCtx);
	const finalBoard = localEntries.at(-1).data;
	assert.equal(localEntries.length, entriesBeforeManagerActions + 2, "manager persists archive/edit exactly once and ignores unknown keys");
	assert.equal(finalBoard.items.find((item) => item.id === "D1").status, "archived", "manager keeps archived items archived without an accept action");
	assert.equal(finalBoard.items.find((item) => item.id === "D1").text, "Managed decision edited", "manager can edit selected item text");
	assert.equal(editorTitle, "Edit decision", "manager edit title hides item keys while preserving kind context");
	assert.equal(finalBoard.items.length, 1, "manager no longer creates extra items");
}

console.log("live decision board extension tests passed");
