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

const withGoal = mod.addBoardItem(withDecision, {
	kind: "goal",
	text: "Ship a focused board workflow",
	status: "accepted",
	strength: "soft",
	source: "user",
});
assert.equal(withGoal.items.at(-1).id, "G1", "goals use G-prefixed ids");
assert.equal(withGoal.items.at(-1).kind, "goal", "goal items keep their distinct kind");
const withSecondGoal = mod.addBoardItem(withGoal, {
	kind: "goal",
	text: "Polish board taxonomy",
	status: "accepted",
	strength: "soft",
	source: "user",
});
assert.equal(withSecondGoal.items.find((item) => item.id === "G1").status, "archived", "adding a new goal archives the previous active goal");
assert.equal(withSecondGoal.items.at(-1).id, "G2", "new goals use the next G-prefixed id");
assert.equal(withSecondGoal.items.filter((item) => item.kind === "goal" && (item.status === "accepted" || item.status === "proposed")).length, 1, "only one goal remains active");
assert.match(mod.formatBoardStatus(withSecondGoal), /1 goal/, "status summary includes the active goal count");

const prompt = mod.formatBoardForPrompt(withSecondGoal);
assert.match(prompt, /Live Goal, Assumptions & Decisions — version 4/);
assert.match(prompt, /Goal:/);
assert.match(prompt, /G2: Polish board taxonomy/);
assert.doesNotMatch(prompt, /G1: Ship a focused board workflow/, "archived goals leave active prompt context");
assert.match(prompt, /A1: Backend uses Node 22/);
assert.match(prompt, /D1: Build as a Pi extension first/);
assert.match(prompt, /Treat accepted items as enforced current context before mutating files/);
assert.match(prompt, /Proposed items are visible drafts/, "prompt explains proposed-item drafts");
assert.doesNotMatch(prompt, /\bsoft\b|\bhard\b/, "prompt metadata should hide legacy strength labels");

const widgetDecisionOne = mod.addBoardItem(withAssumption, {
	kind: "decision",
	text: "First decision",
	status: "accepted",
	strength: "soft",
	source: "user",
});
const widgetDecisionTwo = mod.addBoardItem(widgetDecisionOne, {
	kind: "decision",
	text: "Second decision",
	status: "accepted",
	strength: "soft",
	source: "user",
});
const widgetBoardWithoutGoal = mod.addBoardItem(widgetDecisionTwo, {
	kind: "assumption",
	text: "Second assumption",
	status: "accepted",
	strength: "soft",
	source: "user",
});
const widgetBoard = mod.addBoardItem(widgetBoardWithoutGoal, {
	kind: "goal",
	text: "Current goal",
	status: "accepted",
	strength: "soft",
	source: "user",
});
const widget = mod.formatBoardWidget(widgetBoard, { maxItems: 5 });
assert.deepEqual(
	widget,
	[
		"Board v5 • 1 goal • 2 assumptions • 2 decisions",
		"Goal (1)",
		"• [G1] Current goal",
		"Decisions (2)",
		"• [D1] First decision",
		"• [D2] Second decision",
		"Assumptions (2)",
		"• [A1] Backend uses Node 22",
		"• [A2] Second assumption",
	],
	"widget groups goal, decisions, and assumptions; sorts ids ascending; and renders ids as bracketed keys",
);
const inactiveDecisionBoard = mod.updateBoardItem(widgetBoard, "D1", { status: "archived" });
assert.deepEqual(
	mod.formatBoardWidget(inactiveDecisionBoard, { maxItems: 5 }),
	[
		"Board v6 • 1 goal • 2 assumptions • 1 decision",
		"Goal (1)",
		"• [G1] Current goal",
		"Decisions (1)",
		"• [D2] Second decision",
		"Assumptions (2)",
		"• [A1] Backend uses Node 22",
		"• [A2] Second assumption",
	],
	"widget summary counts only active records shown in the widget body",
);
let overflowBoard = mod.createEmptyBoard();
for (let index = 1; index <= 9; index += 1) {
	overflowBoard = mod.addBoardItem(overflowBoard, { kind: "decision", text: `Decision ${index}` });
}
overflowBoard = mod.addBoardItem(overflowBoard, { kind: "assumption", text: "Assumption visible in counts" });
const overflowWidget = mod.formatBoardWidget(overflowBoard);
assert(overflowWidget.includes("• [D9] Decision 9"), "visible widget shows every active decision by default");
assert(overflowWidget.includes("Assumptions (1)"), "visible widget shows non-empty assumption sections after many decisions");
assert(overflowWidget.includes("• [A1] Assumption visible in counts"), "visible widget shows every active assumption by default");
assert(!overflowWidget.some((line) => line.startsWith("…")), "visible widget does not hide items behind overflow cues by default");

let cleanupBoard = mod.createEmptyBoard();
cleanupBoard = mod.addBoardItem(cleanupBoard, {
	kind: "decision",
	text: "Apply Round 5 review fixes for stale guards",
	status: "accepted",
	strength: "soft",
});
cleanupBoard = mod.addBoardItem(cleanupBoard, {
	kind: "decision",
	text: "Use keyboard-first board management",
	status: "accepted",
	strength: "hard",
});
cleanupBoard = mod.addBoardItem(cleanupBoard, {
	kind: "assumption",
	text: "Need user confirmation on archive wording",
	status: "proposed",
	strength: "soft",
});
cleanupBoard = mod.addBoardItem(cleanupBoard, {
	kind: "decision",
	text: "Current product direction remains board hygiene",
	status: "accepted",
	strength: "soft",
});

const cleanupRecommendations = mod.recommendBoardCleanup(cleanupBoard);
assert.equal(cleanupRecommendations.length, 4, "cleanup recommendations include active items");
const cleanupD1 = cleanupRecommendations.find((rec) => rec.id === "D1");
const cleanupD2 = cleanupRecommendations.find((rec) => rec.id === "D2");
const cleanupA1 = cleanupRecommendations.find((rec) => rec.id === "A1");
const cleanupD3 = cleanupRecommendations.find((rec) => rec.id === "D3");
assert(cleanupD1, "cleanup includes first decision");
assert.equal(cleanupD1.action, "archive");
assert.equal(cleanupD1.selected, true);
assert.match(cleanupD1.reason, /historical/i);
assert(cleanupD2, "cleanup includes accepted decision");
assert.equal(cleanupD2.action, "keep", "accepted items default keep");
assert.equal(cleanupD2.riskLevel, "low risk", "legacy strength no longer creates special cleanup risk");
assert.doesNotMatch(cleanupD2.reason, /Hard constraints/i, "recommendation reason does not reference legacy hard constraints");
assert(cleanupA1, "cleanup includes assumption");
assert.equal(cleanupA1.action, "needs_user_review", "proposed items need review");
assert.equal(cleanupA1.riskLevel, "medium risk", "proposed cleanup recommendations use explicit risk labels");
assert.equal(cleanupA1.selected, false);
assert(cleanupD3, "cleanup includes ambiguous decision");
assert.equal(cleanupD3.action, "keep", "ambiguous current items default keep");

const legacyHardHistoricalBoard = mod.addBoardItem(mod.createEmptyBoard(), {
	kind: "decision",
	text: "Apply Round 7 review fixes",
	status: "accepted",
	strength: "hard",
});
const legacyHardHistorical = mod.recommendBoardCleanup(legacyHardHistoricalBoard)[0];
assert(legacyHardHistorical, "legacy hard historical text is recommended for cleanup");
assert.equal(legacyHardHistorical.action, "archive", "legacy hard strength does not prevent historical cleanup suggestions");
assert.equal(legacyHardHistorical.selected, true, "historical cleanup suggestions are preselected");

const inactiveCleanupBoard = mod.updateBoardItem(cleanupBoard, "D1", { status: "archived" });
assert(!mod.recommendBoardCleanup(inactiveCleanupBoard).some((rec) => rec.id === "D1"), "inactive items are not recommended");

const archivePlan = cleanupRecommendations.map((rec) =>
	rec.id === "D1" ? { ...rec, selected: true } : { ...rec, selected: false },
);
const cleanupImpact = mod.summarizeBoardCleanupImpact(cleanupBoard, archivePlan);
assert.equal(cleanupImpact.activeBefore, 4);
assert.equal(cleanupImpact.activeAfter, 3);
assert.equal(cleanupImpact.acceptedBefore, 3);
assert.equal(cleanupImpact.acceptedAfter, 2);
assert.equal(cleanupImpact.archiveCount, 1);

const cleanedBoard = mod.applyBoardCleanup(cleanupBoard, archivePlan);
assert.equal(cleanedBoard.items.find((item) => item.id === "D1").status, "archived", "archive maps to first-class inactive retained status");
assert.equal(cleanedBoard.items.find((item) => item.id === "D2").strength, "hard", "cleanup preserves hard item strength");
assert.equal(mod.formatBoardForPrompt(cleanedBoard).includes("Apply Round 5"), false, "archived item leaves active prompt context");
const boardHistory = mod.formatBoardHistory(cleanedBoard);
assert.match(boardHistory, /Live Decision Board History/);
assert.match(boardHistory, /Active items:/);
assert.match(boardHistory, /Inactive history:/);
assert.match(boardHistory, /\[D1\].*Apply Round 5.*archived/, "board history exposes archived items with archive terminology");
assert.match(boardHistory, /\[D2\].*Use keyboard-first board management.*accepted/, "board history includes active items for context");

const directArchiveBoard = mod.archiveBoardItem(cleanupBoard, "D2", cleanupD2.itemVersion);
assert.equal(directArchiveBoard.items.find((item) => item.id === "D2").status, "archived", "direct archive maps to first-class inactive retained status");
assert.equal(mod.formatBoardForPrompt(directArchiveBoard).includes("Use keyboard-first board management"), false, "direct archived item leaves active prompt context");
assert(directArchiveBoard.items.find((item) => item.id === "D2"), "direct archive retains item history");
assert.throws(
	() => mod.archiveBoardItem(cleanupBoard, "D2", cleanupD2.itemVersion - 1),
	/changed since it was observed/,
	"direct archive rejects stale item versions",
);
assert.throws(
	() => mod.archiveBoardItem(directArchiveBoard, "D2", cleanupD2.itemVersion),
	/changed since it was observed/,
	"direct archive rejects stale item versions even when the item is already inactive",
);

const noOpCleanup = mod.applyBoardCleanup(cleanupBoard, cleanupRecommendations.map((rec) => ({ ...rec, selected: false })));
assert.equal(noOpCleanup, cleanupBoard, "cleanup with no selected actions is a no-op");

const keepNeedsPlan = cleanupRecommendations.map((rec) =>
	rec.action === "keep" || rec.action === "needs_user_review" ? { ...rec, selected: true } : { ...rec, selected: false },
);
const keepNeedsCleanup = mod.applyBoardCleanup(cleanupBoard, keepNeedsPlan);
assert.equal(keepNeedsCleanup, cleanupBoard, "keep and needs_user_review selections are no-ops");

const stalePlan = archivePlan.map((rec) =>
	rec.id === "D1" ? { ...rec, observedText: "old text" } : rec,
);
assert.throws(() => mod.applyBoardCleanup(cleanupBoard, stalePlan), /changed since cleanup was prepared/);

const archived = mod.updateBoardItem(withDecision, "A1", { status: "archived" });
assert.equal(archived.version, 3, "updating item increments version");
assert.equal(archived.items[0].status, "archived");
assert.throws(() => mod.updateBoardItem(withDecision, "A1", { status: "rejected" }), /Invalid board item status/, "legacy rejected status is no longer accepted");
assert.throws(() => mod.updateBoardItem(withDecision, "A1", { status: "superseded" }), /Invalid board item status/, "legacy superseded status is no longer accepted");

const unchangedByUndefined = mod.updateBoardItem(withDecision, "D1", { status: undefined, strength: undefined });
assert.equal(unchangedByUndefined.version, withDecision.version, "undefined-only patches are no-ops");
assert.equal(unchangedByUndefined.items[1].status, "accepted", "undefined patch fields are ignored");
assert.equal(unchangedByUndefined.items[1].strength, "hard", "undefined strength is ignored");

const unchangedBySameStrength = mod.updateBoardItem(withDecision, "D1", { strength: "hard" });
assert.equal(unchangedBySameStrength.version, withDecision.version, "same-value patches are no-ops");

const archivedAndAdded = mod.addBoardItem(mod.archiveBoardItem(withDecision, "D1", withDecision.items.find((item) => item.id === "D1").version), {
	kind: "decision",
	text: "Build extension MVP first",
	status: "accepted",
});
assert.equal(archivedAndAdded.items.find((item) => item.id === "D1").status, "archived");
assert.match(mod.formatBoardHistory(archivedAndAdded), /\[D1\].*archived/, "board history exposes archived items");
assert.equal(archivedAndAdded.items.at(-1).id, "D2");

const cleared = mod.clearBoard(withDecision);
assert.equal(cleared.version, 3, "clearing keeps versions monotonic");
assert.deepEqual(cleared.items, []);

assert.match(mod.formatBoardStatus(withDecision), /Board v2 • 1 assumption • 1 decision/);
assert.match(mod.formatBoardStatus(withSecondGoal), /Board v4 • 1 goal • 1 assumption • 1 decision/);
assert.doesNotMatch(mod.formatBoardStatus(withDecision), /hard constraint/, "status summary should not include legacy hard constraint counts");

const acceptedSoftBoard = mod.addBoardItem(mod.createEmptyBoard(), {
	kind: "decision",
	text: "Accepted decisions are enforced",
	status: "accepted",
	strength: "soft",
});
const acceptedSoftBoardEnforced = mod.hasUninjectedEnforcedChanges(acceptedSoftBoard, 0);
assert.equal(acceptedSoftBoardEnforced, true, "accepted items are enforced until injected");
assert.equal(mod.hasUninjectedHardChanges(acceptedSoftBoard, 0), acceptedSoftBoardEnforced, "legacy hard helper delegates to enforced helper");
assert.equal(
	mod.hasUninjectedEnforcedChanges(acceptedSoftBoard, acceptedSoftBoard.version),
	false,
	"accepted items stop blocking after the current board is injected",
);

const proposedOnlyBoard = mod.addBoardItem(mod.createEmptyBoard(), {
	kind: "decision",
	text: "Draft policy",
	status: "proposed",
	strength: "soft",
});
assert.equal(mod.hasUninjectedEnforcedChanges(proposedOnlyBoard, 0), false, "proposed items are visible but not enforced");

const acceptedFromProposed = mod.updateBoardItem(proposedOnlyBoard, "D1", { status: "accepted" });
assert.equal(
	mod.hasUninjectedEnforcedChanges(acceptedFromProposed, proposedOnlyBoard.version),
	true,
	"accepting a proposed item creates a stale enforced barrier",
);

assert.equal(mod.hasUninjectedEnforcedChanges(withDecision, 1), true, "accepted changes after injected version are detected");
assert.equal(mod.hasUninjectedEnforcedChanges(withDecision, 2), false, "injected accepted changes are not stale");
const archivedAccepted = mod.updateBoardItem(withDecision, "D1", { status: "archived" });
assert.equal(mod.hasUninjectedEnforcedChanges(archivedAccepted, 2), true, "archiving an accepted item remains stale-sensitive until injected");
const legacyStrengthChanged = mod.updateBoardItem(acceptedSoftBoard, "D1", { strength: "hard" });
assert.equal(
	mod.hasUninjectedEnforcedChanges(legacyStrengthChanged, acceptedSoftBoard.version),
	false,
	"legacy strength-only changes do not create enforcement barriers",
);
const clearedAcceptedBoard = mod.clearBoard(acceptedSoftBoard);
assert.equal(mod.hasUninjectedEnforcedChanges(clearedAcceptedBoard, acceptedSoftBoard.version), true, "clearing accepted items remains stale-sensitive until injected");

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
const fallbackRestored = mod.restoreBoardFromEntries([
	{ type: "custom", customType: "live-decision-board", data: withDecision },
	{
		type: "custom",
		customType: "live-decision-board",
		data: { version: 3, nextAssumptionId: 2, nextDecisionId: 2, items: [null] },
	},
]);
assert.deepEqual(fallbackRestored, withDecision, "restore falls back to the newest valid board when a later board entry is malformed");
const duplicateIdRestored = mod.restoreBoardFromEntries([
	{
		type: "custom",
		customType: "live-decision-board",
		data: { ...withAssumption, items: [withAssumption.items[0], withAssumption.items[0]] },
	},
]);
assert.deepEqual(duplicateIdRestored, mod.createEmptyBoard(), "restored board state rejects duplicate item ids");
const staleCounterRestored = mod.restoreBoardFromEntries([
	{
		type: "custom",
		customType: "live-decision-board",
		data: { ...withDecision, nextAssumptionId: 1, nextDecisionId: 1 },
	},
]);
assert.equal(staleCounterRestored.nextAssumptionId, 2, "restored assumption counter is clamped past existing ids");
assert.equal(staleCounterRestored.nextDecisionId, 2, "restored decision counter is clamped past existing ids");
assert.equal(mod.addBoardItem(staleCounterRestored, { kind: "assumption", text: "No duplicate A1" }).items.at(-1).id, "A2");
assert.equal(mod.addBoardItem(staleCounterRestored, { kind: "decision", text: "No duplicate D1" }).items.at(-1).id, "D2");
const restoredLowBarrier = mod.restoreBoardFromEntries([
	{
		type: "custom",
		customType: "live-decision-board",
		data: { ...withDecision, hardDecisionBarrierVersion: 0 },
	},
]);
assert.equal(restoredLowBarrier.hardDecisionBarrierVersion, 2, "restored barrier is at least the enforced item version");
assert.equal(mod.hasUninjectedEnforcedChanges(restoredLowBarrier, 0), true, "low restored barriers cannot bypass enforced items");
const restoredHighBarrier = mod.restoreBoardFromEntries([
	{
		type: "custom",
		customType: "live-decision-board",
		data: { ...withDecision, hardDecisionBarrierVersion: 999 },
	},
]);
assert.equal(restoredHighBarrier.hardDecisionBarrierVersion, withDecision.version, "restored barrier is clamped to board version");
assert.equal(mod.hasUninjectedEnforcedChanges(restoredHighBarrier, withDecision.version), false, "high restored barriers do not deadlock after injection");
const futureItemVersionRestored = mod.restoreBoardFromEntries([
	{
		type: "custom",
		customType: "live-decision-board",
		data: { ...withDecision, items: [{ ...withDecision.items[1], version: withDecision.version + 1 }] },
	},
]);
assert.deepEqual(futureItemVersionRestored, mod.createEmptyBoard(), "item versions newer than the board are rejected");
const zeroVersionAcceptedRestored = mod.restoreBoardFromEntries([
	{
		type: "custom",
		customType: "live-decision-board",
		data: { ...withDecision, version: 0, hardDecisionBarrierVersion: 0, items: [{ ...withDecision.items[1], version: 0 }] },
	},
]);
assert.deepEqual(zeroVersionAcceptedRestored, mod.createEmptyBoard(), "zero-version restored accepted items are rejected");

const legacyMarkdown = "# Live Decision Board\n\n- D1 | decision | accepted | hard | Legacy hard item\n";
assert.throws(
	() => mod.parseBoardMarkdown("# Live Decision Board\n\n- D1 | decision | rejected | soft | Old status\n", mod.createEmptyBoard()),
	/Invalid board item status/,
	"markdown parser rejects removed status values",
);
const parsedLegacy = mod.parseBoardMarkdown(legacyMarkdown, mod.createEmptyBoard());
assert.equal(parsedLegacy.items[0].strength, "hard", "legacy strength is still parsed for session compatibility");
assert.equal(mod.hasUninjectedEnforcedChanges(parsedLegacy, 0), true, "accepted legacy items are enforced regardless of strength");
assert.match(mod.serializeBoardMarkdown(parsedLegacy), /\| hard \|/, "serialize keeps strength as compatibility markdown format");

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
