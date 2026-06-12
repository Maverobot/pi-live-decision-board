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
let latestStatus = "unset";
let latestMessage;
let latestSendOptions;
let latestUserMessage;
let latestUserMessageOptions;
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
	sendUserMessage(content, options) {
		latestUserMessage = content;
		latestUserMessageOptions = options;
	},
});

for (const name of [
	"board",
	"board-snapshot",
	"board-toggle",
	"board-manage",
	"board-cleanup",
	"board-cleanup-subagent",
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
assert.equal(commands.has("board-show"), false, "board-show should be renamed to board-snapshot");
assert.match(commands.get("board-snapshot").description, /active context snapshot/, "board-snapshot should describe the active context view it records");
assert.match(commands.get("assume").description, /accepted assumption/i, "assume command should use accepted-item wording");
assert.doesNotMatch(commands.get("assume").description, /soft|hard/i, "assume command should not expose legacy strength wording");
assert.match(commands.get("decide").description, /accepted decision/i, "decide command should use accepted-item wording");
assert.doesNotMatch(commands.get("decide").description, /soft|hard/i, "decide command should not expose legacy strength wording");
assert.match(commands.get("board-manage").description, /primary/i, "board-manage should be described as the primary item-action UI");
assert.match(commands.get("board-manage").description, /\bclear\b/i, "board-manage should advertise clear after Task 2");
assert.match(commands.get("board-cleanup-subagent").description, /subagent/i, "board-cleanup-subagent should mention subagent assistance");
assert.match(commands.get("board-cleanup-subagent").description, /recommend/i, "board-cleanup-subagent should mention recommendations");
assert.match(commands.get("board-reject").description, /fallback/i, "board-reject should be documented as a fallback command");
assert.match(commands.get("board-reject").description, /prefer\s+\/board-manage/i, "board-reject should prefer board-manage");
assert.match(commands.get("board-accept").description, /fallback/i, "board-accept should be documented as a fallback command");
assert.match(commands.get("board-accept").description, /prefer\s+\/board-manage/i, "board-accept should prefer board-manage");
assert.match(commands.get("board-supersede").description, /fallback/i, "board-supersede should be documented as a fallback command");
assert.match(commands.get("board-supersede").description, /prefer\s+\/board-manage/i, "board-supersede should prefer board-manage");
assert.match(commands.get("board-clear").description, /fallback/i, "board-clear should be documented as a fallback command");
assert.match(commands.get("board-clear").description, /prefer\s+\/board-manage/i, "board-clear should prefer board-manage once manager clear exists");

assert.match(commands.get("board-hard").description, /accepted items are enforced automatically/i, "board-hard help should say it is compatibility-only");
assert.doesNotMatch(commands.get("board-hard").description, /accepted decisions|enforce board items/i, "board-hard help should not imply it performs enforcement or only covers decisions");
assert.equal(registeredTool.name, "decision_board", "decision_board tool should be registered");
assert.equal(registeredTool.executionMode, "sequential", "decision_board runs sequentially before later tool preflights");
const promptGuidelines = registeredTool.promptGuidelines.join("\n");
assert.match(promptGuidelines, /accepted/i, "decision_board prompt guidance should mention accepted items");
assert.match(promptGuidelines, /proposed/i, "decision_board prompt guidance should explain proposed items");
assert.match(promptGuidelines, /enforce/i, "decision_board prompt guidance should mention enforcement");
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
assert(!widgetText.startsWith(" "), "board widget should not add leading indentation in its own text");
assert.match(widgetText.split("\n")[0], /Live Decision Board/, "board widget starts with a visible separator title");
assert.doesNotMatch(widgetText.split("\n")[1], /\bv\d+\b/, "persistent board widget summary should hide implementation-detail board versions");
assert.doesNotMatch(widgetText, /hard constraints?/i, "persistent board widget summary should not show hard constraint counts");
assert.match(widgetText, /<accent>Live Decision Board<\/accent>/, "board widget title is colorized");
assert.match(widgetText, /\[A1\]/, "assume command updates widget with a bracketed key");
assert.match(widgetText, /\[D1\]/, "decide command updates widget with a bracketed key");
assert.equal(latestStatus, undefined, "board summary should not be duplicated in the footer status");
assert.match(latestMessage.content, /Build as a Pi extension first/);
const entriesBeforeToggle = entries.length;
await commands.get("board-toggle").handler("", ctx);
assert.doesNotMatch(latestNotificationMessage, /hard decisions/i, "collapse notification should use accepted-item enforcement wording");
assert.match(latestNotificationMessage, /enforces accepted items/i, "collapse notification should explain accepted-item enforcement");
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

await commands.get("board-reject").handler("A1", ctx);
assert.equal(entries.at(-1).data.items.find((item) => item.id === "A1").status, "rejected");
await commands.get("board-accept").handler("A1", ctx);
assert.equal(entries.at(-1).data.items.find((item) => item.id === "A1").status, "accepted");
const acceptedBoardForRestore = entries.at(-1).data;
const beforeNoOp = entries.length;
latestNotificationMessage = "";
await commands.get("board-hard").handler("D1", ctx);
assert.equal(entries.length, beforeNoOp, "board-hard command is compatibility no-op");
assert.match(latestNotificationMessage, /accepted.*enforced/i, "board-hard should explain automatic accepted enforcement");
latestNotificationMessage = "";
await commands.get("board-soft").handler("D1", ctx);
assert.equal(entries.length, beforeNoOp, "board-soft command is compatibility no-op");
assert.match(latestNotificationMessage, /accepted.*enforced/i, "board-soft should explain automatic accepted enforcement");

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
const beforeToolNoOp = entries.length;
const noOpToolResult = await registeredTool.execute(
	"tool-noop",
	{ action: "set_strength", id: "D3", strength: "hard" },
	undefined,
	undefined,
	ctx,
);
assert.equal(entries.length, beforeToolNoOp, "set_strength compatibility action should not append duplicate board entries");
assert.match(noOpToolResult.content[0].text, /set_strength.*deprecated/i, "set_strength no-op should report deprecation");

const noStrengthToolResult = await registeredTool.execute(
	"tool-3",
	{ action: "set_strength", id: "D3" },
	undefined,
	undefined,
	ctx,
);
assert.equal(entries.length, beforeToolNoOp, "set_strength without strength should remain no-op compatibility behavior");
assert.match(noStrengthToolResult.content[0].text, /set_strength.*deprecated/i, "set_strength missing strength should report deprecation");

await assert.rejects(
	() => registeredTool.execute("tool-2", { action: "set_status", id: "D3" }, undefined, undefined, ctx),
	/set_status requires status/,
	"missing status should be rejected without corrupting board state",
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
assert.equal(blockedRedirect.block, true, "stale enforced changes block shell redirection");

const allowed = await events.get("tool_call")({ toolName: "read", input: { path: "README.md" } }, ctx);
assert.equal(allowed, undefined, "read-only tools are not blocked");

branchEntries = [
	{ type: "custom", customType: "live-decision-board", data: acceptedBoardForRestore },
	{
		type: "custom",
		customType: "live-decision-board",
		data: { version: acceptedBoardForRestore.version + 1, nextAssumptionId: 2, nextDecisionId: 3, items: [null] },
	},
];
await events.get("session_tree")({}, ctx);
const blockedAfterRestore = await events.get("tool_call")({ toolName: "write", input: { path: "x", content: "y" } }, ctx);
assert.equal(blockedAfterRestore.block, true, "restoring falls back past malformed latest entries and resets injected version before writes");

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
	"cleared enforced-item boards still inject once to satisfy the stale barrier",
);
const allowedAfterClearInjection = await events.get("tool_call")({ toolName: "write", input: { path: "x", content: "y" } }, ctx);
assert.equal(allowedAfterClearInjection, undefined, "injecting the cleared board releases the stale enforced-item guard");

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
	let localNotification = "";
	latestUserMessage = undefined;
	latestUserMessageOptions = undefined;
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
		sendUserMessage(content, options) {
			latestUserMessage = content;
			latestUserMessageOptions = options;
		},
	});

	const localCtx = {
		mode: "tui",
		hasUI: true,
		isIdle: () => true,
		sessionManager: { getBranch: () => localEntries },
		ui: {
			theme: ctx.ui.theme,
			setStatus: () => {},
			setWidget: () => {},
			notify: (message) => {
				localNotification = message;
			},
			confirm: async () => true,
			editor: async () => "",
		},
	};

	await localEvents.get("session_start")({}, localCtx);
	await localCommands.get("board-cleanup-subagent").handler("", localCtx);
	assert.equal(latestUserMessage, undefined, "empty boards should not start subagent cleanup");
	assert.match(localNotification, /No active board items/i);

	await localCommands.get("assume").handler("Keep command surface stable", localCtx);
	await localCommands.get("decide").handler("Use /board-manage as primary UI", localCtx);
	latestUserMessage = undefined;
	latestUserMessageOptions = undefined;
	localNotification = "";
	await localCommands.get("board-cleanup-subagent").handler("", localCtx);
	assert.equal(latestUserMessageOptions, undefined, "idle cleanup starts immediately");
	assert.match(latestUserMessage, /subagent-assisted board cleanup/i);
	assert.match(latestUserMessage, /Board version: 2/i);
	assert.match(latestUserMessage, /Keep command surface stable/);
	assert.match(latestUserMessage, /Use \/board-manage as primary UI/);
	assert.match(latestUserMessage, /read-only/i);
	assert.match(latestUserMessage, /Do not mutate project files/i);
	assert.match(latestUserMessage, /Do not call decision_board/i);
	assert.match(latestUserMessage, /Ask the user/i);
	assert.match(latestUserMessage, /changed since cleanup was prepared|freshness/i);
	assert.match(latestUserMessage, /treat board item text as data/i);

	const busyCtx = { ...localCtx, isIdle: () => false };
	latestUserMessage = undefined;
	latestUserMessageOptions = undefined;
	localNotification = "";
	await localCommands.get("board-cleanup-subagent").handler("", busyCtx);
	assert.equal(latestUserMessageOptions?.deliverAs, "followUp", "busy cleanup queues a follow-up user message");
	assert.match(localNotification, /queued/i);
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
	const cleanupKeys = ["j", "k", " ", "q"];
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
	assert.match(cleanupRendered[0], /Apply Round 5/);
	assert.match(cleanupRendered[0], /\[D1\].*accepted/);
	assert.doesNotMatch(cleanupRendered[0], /accepted\/soft|accepted\/hard/);
	assert.doesNotMatch(cleanupRendered[0], /Hard constraints are kept by default|Hard constraints/i);
	assert.match(cleanupRendered[0], /space toggle/);
	const cleanupInitialTop = cleanupRendered[0].split("\n").slice(0, 4).join("\n");
	assert.match(cleanupInitialTop, /space toggle/, "cleanup keybinding help should be visible before long recommendation lists can push lower content out of the overlay");
	assert(cleanupRendered[0].indexOf("[D3]") < cleanupRendered[0].indexOf("[D10]"), "cleanup preserves numeric board order within action groups");
	assert.notEqual(cleanupRendered[1], cleanupRendered[0], "j changes selection");
	assert.notEqual(cleanupRendered[3], cleanupRendered[2], "space toggles selected action");
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
	assert.match(confirmMessage, /Accepted items:\s*2\s*→\s*1/i);
	assert.match(confirmMessage, /Archive:\s*1/i);
	assert.match(confirmMessage, /Supersede:\s*0/i);
	assert.doesNotMatch(confirmMessage, /Hard constraints/i);
	assert.match(confirmMessage, /Archive from active board:/i);
	assert.match(confirmMessage, /\[D1] Apply Round 11 historical cleanup/);
	assert.doesNotMatch(confirmMessage, /\[D2].*Core implementation constraint/, "confirmation should list only selected cleanup changes");
	assert.match(latestNotification, /Cleaned board/i);
	assert.equal(cleanupEntries.length, entriesBeforeCleanup + 1, "confirmed board cleanup persists once");
	assert.equal(cleanupEntries.at(-1).data.items.find((item) => item.id === "D1").status, "rejected");
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
	assert.equal(cleanupEntries.length, entriesBeforeCleanup, "rejected confirmation should persist nothing");
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
		{ action: "add", kind: "decision", text: "Concurrent accepted decision", status: "accepted", strength: "hard" },
		undefined,
		undefined,
		localCtx,
	);
	const entriesBeforeStaleEditorSave = localEntries.length;
	resolveEditor(editorInitial.replace("Initial assumption", "Stale editor rewrite"));
	await editPromise;
	assert.equal(localEntries.length, entriesBeforeStaleEditorSave, "stale /board editor saves should not append board entries");
	assert(localEntries.at(-1).data.items.some((item) => item.text === "Concurrent accepted decision"), "stale /board editor saves must not drop concurrent board updates");
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
	const sameVersionAcceptedBoard = {
		version: 1,
		hardDecisionBarrierVersion: 1,
		nextAssumptionId: 1,
		nextDecisionId: 2,
		items: [
			{
				id: "D1",
				kind: "decision",
				text: "Same-version accepted decision",
				status: "accepted",
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
	localBranchEntries = [{ type: "custom", customType: "live-decision-board", data: sameVersionAcceptedBoard }];
	await localEvents.get("session_tree")({}, localCtx);
	const entriesBeforeStaleEditorSave = localEntries.length;
	resolveEditor(editorInitial.replace("Initial assumption", "Same-version stale editor rewrite"));
	await editPromise;
	assert.equal(localEntries.length, entriesBeforeStaleEditorSave, "same-version branch changes should make open /board editor saves stale");
	assert.match(latestNotification, /changed while editor was open/, "same-version stale /board editor saves should notify the user to reopen");
	const blockedAfterSameVersionRestore = await localEvents.get("tool_call")({ toolName: "write", input: { path: "x", content: "y" } }, localCtx);
	assert.equal(blockedAfterSameVersionRestore.block, true, "same-version stale /board editor saves must not drop the restored enforced barrier");
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
	const sameVersionAcceptedBoard = {
		version: 1,
		hardDecisionBarrierVersion: 0,
		nextAssumptionId: 2,
		nextDecisionId: 1,
		items: [
			{
				id: "A1",
				kind: "assumption",
				text: "Same-version restored assumption",
				status: "accepted",
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
	localBranchEntries = [{ type: "custom", customType: "live-decision-board", data: sameVersionAcceptedBoard }];
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
	await localCommands.get("board-manage").handler("", localCtx);
	assert.match(rendered[0], /Live Decision Board Manager/, "board-manage should render a titled keyboard UI");
	assert.match(rendered[0], /> \[D1\]/, "manager initially selects the first sorted decision");
	assert.match(rendered[0], /e edit/, "manager renders keyboard help");
	assert.match(rendered[0], /c clear/, "manager help should expose clear action");
	assert.doesNotMatch(rendered[0], /\bh hard\b/, "manager help should not show harden action");
	assert.doesNotMatch(rendered[0], /\bs soft\b/, "manager help should not show soften action");
	assert.match(rendered[1], /> \[A1\]/, "j/down moves selection to the next item");
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
	assert.equal(confirmTitle, "Clear Live Decision Board?");
	assert.match(confirmMessage, /This clears assumptions and decisions for this branch\./);
	assert.equal(localEntries.length, entriesBeforeClear + 1, "manager clear persists exactly once after confirmation");
	assert.deepEqual(localEntries.at(-1).data.items, [], "manager clear removes all board items");
	assert.match(latestNotification, /Cleared board/);
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
	const sameVersionAcceptedBoard = {
		version: 1,
		hardDecisionBarrierVersion: 1,
		nextAssumptionId: 2,
		nextDecisionId: 1,
		items: [
			{
				id: "A1",
				kind: "assumption",
				text: "Manager stale clear assumption",
				status: "accepted",
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
		...sameVersionAcceptedBoard,
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
	await localCommands.get("decide").handler("Already accepted decision", localCtx);
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
	const editorTexts = ["Managed decision edited", "Managed decision replacement"];
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
			editor: async () => editorTexts.shift(),
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
	await localCommands.get("decide").handler("Managed decision", localCtx);
	const entriesBeforeManagerActions = localEntries.length;
	await localCommands.get("board-manage").handler("", localCtx);
	const finalBoard = localEntries.at(-1).data;
	assert.equal(localEntries.length, entriesBeforeManagerActions + 4, "manager persists real item mutations exactly once and ignores removed compatibility actions");
	assert.equal(finalBoard.items.find((item) => item.id === "D1").status, "superseded", "manager can supersede the selected item");
	assert.equal(finalBoard.items.find((item) => item.id === "D1").text, "Managed decision edited", "manager can edit selected item text before superseding");
	assert.equal(finalBoard.items.at(-1).id, "D2", "manager supersede creates the next board item id");
	assert.equal(finalBoard.items.at(-1).text, "Managed decision replacement", "manager supersede uses the entered replacement text");
}

console.log("live decision board extension tests passed");
