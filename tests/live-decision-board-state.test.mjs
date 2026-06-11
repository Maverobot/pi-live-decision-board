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
const mod = jiti(join(testDir, "../extensions/live-decision-board.ts"));

const board = mod.createEmptyBoard();
const withAssumption = mod.addBoardItem(board, {
	kind: "assumption",
	text: "Backend uses Node 22",
	status: "accepted",
	strength: "soft",
	source: "user",
});

assert.equal(withAssumption.version, 1, "adding item increments board version");
assert.equal(withAssumption.items[0].id, "A1", "assumptions use A-prefixed ids");

const withDecision = mod.addBoardItem(withAssumption, {
	kind: "decision",
	text: "Build as a Pi extension first",
	status: "accepted",
	strength: "hard",
	source: "user",
});

assert.equal(withDecision.version, 2, "second add increments version again");
assert.equal(withDecision.items[1].id, "D1", "decisions use D-prefixed ids");

const prompt = mod.formatBoardForPrompt(withDecision);
assert.match(prompt, /Live Assumptions & Decisions — version 2/);
assert.match(prompt, /A1: Backend uses Node 22/);
assert.match(prompt, /D1: Build as a Pi extension first/);
assert.match(prompt, /hard/);

const widget = mod.formatBoardWidget(withDecision, { maxItems: 5 });
assert(widget.some((line) => line.includes("Board v2")), "widget includes board version");
assert(widget.some((line) => line.includes("A1")), "widget includes assumption id");
assert(widget.some((line) => line.includes("D1")), "widget includes decision id");

const rejected = mod.updateBoardItem(withDecision, "A1", { status: "rejected" });
assert.equal(rejected.version, 3, "updating item increments version");
assert.equal(rejected.items[0].status, "rejected");

const unchangedByUndefined = mod.updateBoardItem(withDecision, "D1", { status: undefined, strength: undefined });
assert.equal(unchangedByUndefined.version, withDecision.version, "undefined-only patches are no-ops");
assert.equal(unchangedByUndefined.items[1].status, "accepted", "undefined patch fields are ignored");
assert.equal(unchangedByUndefined.items[1].strength, "hard", "undefined strength is ignored");

const unchangedBySameStrength = mod.updateBoardItem(withDecision, "D1", { strength: "hard" });
assert.equal(unchangedBySameStrength.version, withDecision.version, "same-value patches are no-ops");

const superseded = mod.supersedeBoardItem(withDecision, "D1", "Build extension MVP first");
assert.equal(superseded.items.find((item) => item.id === "D1").status, "superseded");
assert.equal(superseded.items.at(-1).supersedes, "D1");
assert.equal(superseded.items.at(-1).id, "D2");

const cleared = mod.clearBoard(withDecision);
assert.equal(cleared.version, 3, "clearing keeps versions monotonic");
assert.deepEqual(cleared.items, []);

assert.match(mod.formatBoardStatus(withDecision), /Board v2 • A1 D1 • hard:1/);

assert.equal(mod.hasUninjectedHardChanges(withDecision, 1), true, "hard changes after injected version are detected");
assert.equal(mod.hasUninjectedHardChanges(withDecision, 2), false, "injected hard changes are not stale");
const rejectedHard = mod.updateBoardItem(withDecision, "D1", { status: "rejected" });
assert.equal(mod.hasUninjectedHardChanges(rejectedHard, 2), true, "rejected hard decisions remain stale until injected");
const softenedHard = mod.updateBoardItem(withDecision, "D1", { strength: "soft" });
assert.equal(mod.hasUninjectedHardChanges(softenedHard, 2), true, "softened hard decisions remain stale until injected");
const clearedHard = mod.clearBoard(withDecision);
assert.equal(mod.hasUninjectedHardChanges(clearedHard, 2), true, "cleared hard decisions remain stale until injected");

const restored = mod.restoreBoardFromEntries([
	{ type: "custom", customType: "live-decision-board", data: withAssumption },
	{ type: "custom", customType: "other", data: { ignored: true } },
	{ type: "custom", customType: "live-decision-board", data: withDecision },
]);
assert.deepEqual(restored, withDecision, "restore uses latest live-decision-board custom entry from supplied branch");
const invalidRestored = mod.restoreBoardFromEntries([
	{
		type: "custom",
		customType: "live-decision-board",
		data: { version: 1, nextAssumptionId: 1, nextDecisionId: 1, items: [null] },
	},
]);
assert.deepEqual(invalidRestored, mod.createEmptyBoard(), "malformed persisted board state is ignored");
const restoredLowBarrier = mod.restoreBoardFromEntries([
	{
		type: "custom",
		customType: "live-decision-board",
		data: { ...withDecision, hardDecisionBarrierVersion: 0 },
	},
]);
assert.equal(restoredLowBarrier.hardDecisionBarrierVersion, 2, "restored barrier is at least the hard item version");
assert.equal(mod.hasUninjectedHardChanges(restoredLowBarrier, 0), true, "low restored barriers cannot bypass hard decisions");
const restoredHighBarrier = mod.restoreBoardFromEntries([
	{
		type: "custom",
		customType: "live-decision-board",
		data: { ...withDecision, hardDecisionBarrierVersion: 999 },
	},
]);
assert.equal(restoredHighBarrier.hardDecisionBarrierVersion, withDecision.version, "restored barrier is clamped to board version");
assert.equal(mod.hasUninjectedHardChanges(restoredHighBarrier, withDecision.version), false, "high restored barriers do not deadlock after injection");
const futureItemVersionRestored = mod.restoreBoardFromEntries([
	{
		type: "custom",
		customType: "live-decision-board",
		data: { ...withDecision, items: [{ ...withDecision.items[1], version: withDecision.version + 1 }] },
	},
]);
assert.deepEqual(futureItemVersionRestored, mod.createEmptyBoard(), "item versions newer than the board are rejected");
const zeroVersionHardRestored = mod.restoreBoardFromEntries([
	{
		type: "custom",
		customType: "live-decision-board",
		data: { ...withDecision, version: 0, hardDecisionBarrierVersion: 0, items: [{ ...withDecision.items[1], version: 0 }] },
	},
]);
assert.deepEqual(zeroVersionHardRestored, mod.createEmptyBoard(), "zero-version restored hard items are rejected");

const markdown = mod.serializeBoardMarkdown(withDecision);
const parsed = mod.parseBoardMarkdown(markdown.replace("soft", "hard"), withDecision);
assert.equal(parsed.items.find((item) => item.id === "A1").strength, "hard");
assert.equal(parsed.version, withDecision.version + 1);
assert.equal(parsed.items.find((item) => item.id === "A1").version, parsed.version, "changed items get new item version");
const multilineBoard = mod.addBoardItem(board, {
	kind: "assumption",
	text: "Line one\nline two",
	status: "accepted",
	strength: "soft",
	source: "user",
});
assert.equal(multilineBoard.items[0].text, "Line one line two", "stored board text is single-line for markdown round-tripping");
const multilineRoundTrip = mod.parseBoardMarkdown(mod.serializeBoardMarkdown(multilineBoard), multilineBoard);
assert.equal(multilineRoundTrip.items[0].text, "Line one line two", "serialized multiline input parses back safely");

assert.equal(mod.isMutatingToolCall("write", { path: "x" }), true);
assert.equal(mod.isMutatingToolCall("edit", { path: "x" }), true);
assert.equal(mod.isMutatingToolCall("bash", { command: "git diff --stat" }), false);
assert.equal(mod.isMutatingToolCall("bash", { command: "git branch --show-current" }), false);
assert.equal(mod.isMutatingToolCall("bash", { command: "git branch --contains HEAD" }), false);
assert.equal(mod.isMutatingToolCall("bash", { command: "grep -E 'foo|bar' README.md" }), false);
assert.equal(mod.isMutatingToolCall("bash", { command: "echo hi > file.txt" }), true);
assert.equal(mod.isMutatingToolCall("bash", { command: "sed -i s/a/b/g file.txt" }), true);
assert.equal(mod.isMutatingToolCall("bash", { command: "find . -delete" }), true);
assert.equal(mod.isMutatingToolCall("bash", { command: "find . -exec rm {} +" }), true);
assert.equal(mod.isMutatingToolCall("bash", { command: "git branch -D stale" }), true);
assert.equal(mod.isMutatingToolCall("bash", { command: "git diff --output=patch.diff" }), true);
assert.equal(mod.isMutatingToolCall("bash", { command: "git show --output=patch.diff HEAD" }), true);
assert.equal(mod.isMutatingToolCall("bash", { command: "git log --output=log.patch -1" }), true);
assert.equal(mod.isMutatingToolCall("bash", { command: "git diff --ext-diff" }), true);
assert.equal(mod.isMutatingToolCall("bash", { command: "git show --ext-diff HEAD" }), true);
assert.equal(mod.isMutatingToolCall("bash", { command: "git log --ext-diff -p -1" }), true);
assert.equal(mod.isMutatingToolCall("bash", { command: "git diff --textconv" }), true);
assert.equal(mod.isMutatingToolCall("bash", { command: "git diff --no-ext-diff --no-textconv" }), false);
assert.equal(mod.isMutatingToolCall("bash", { command: "ls\nrm victim.txt" }), true);
assert.equal(mod.isMutatingToolCall("bash", { command: "find . -fprintf out.txt %p" }), true);
assert.equal(mod.isMutatingToolCall("bash", { command: "find . -fls out.txt" }), true);
assert.equal(mod.isMutatingToolCall("bash", { command: "rg --pre=rm needle README.md" }), true);

console.log("live decision board state tests passed");
