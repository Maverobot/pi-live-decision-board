# Accepted Items Enforced Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Redesign the Live Decision Board so every accepted active board item is enforced for stale-mutation safety, while removing the hard/soft distinction from the user-facing product.

**Architecture:** Keep the existing persisted `strength` field and `hardDecisionBarrierVersion` storage as compatibility data, but reinterpret enforcement around accepted board items. Introduce accepted-item enforcement helpers, update stale-guard and barrier calculations, hide/deprecate hard/soft UI affordances, and revise cleanup/docs to speak in terms of accepted/proposed/archive behavior instead of hard/soft constraints.

**Tech Stack:** TypeScript Pi extension API, `@earendil-works/pi-tui`, Node test scripts (`tests/live-decision-board-state.test.mjs`, `tests/live-decision-board-extension.test.mjs`), README/org docs.

---

## Product decisions

- Accepted board items are the enforced current working contract.
- Proposed board items are visible drafts but are not enforced until accepted.
- Rejected and superseded items are retained history and are not active/enforced.
- Changing any accepted item boundary is stale-sensitive:
  - adding an accepted item,
  - editing accepted item text,
  - accepting a proposed/rejected item,
  - rejecting/superseding/removing/clearing an accepted item.
- Legacy `strength: "soft" | "hard"` remains in persisted state and markdown parsing for backward compatibility, but is ignored for enforcement and hidden from normal UI/prompt/docs.
- `/board-hard`, `/board-soft`, and `decision_board.set_strength` should become compatibility no-ops with clear deprecation messages. They must not mutate board state or create new stale barriers.
- `/board-manage` should stop showing hard/soft actions and keybindings.
- `/board-cleanup` should no longer protect legacy hard items by default; it should use the same accepted/proposed/ambiguous rules as the rest of the product.

## Acceptance criteria

- A newly added accepted soft item blocks stale mutating tools until the fresh board context is injected.
- A proposed item does not block stale mutating tools until it is accepted.
- Editing/rejecting/superseding/clearing accepted items blocks stale mutating tools until fresh context is injected.
- Changing only legacy strength does not mutate board state through public commands/tool calls and does not create stale barriers.
- Prompt, widget, board manager, cleanup UI, README, and tool guidance no longer present `soft` as a maybe-considered tier or `hard` as the main product concept.
- Board versions remain available in prompt/snapshot/debug contexts.
- Existing persisted boards with `strength` and `hardDecisionBarrierVersion` still restore safely.
- Existing tests plus new regression tests pass.
- Package discovery and installed-cache verification pass.

---

### Task 1: Replace hard-only stale barrier with accepted-item enforcement helpers

**Files:**
- Modify: `extensions/live-decision-board.ts`
- Test: `tests/live-decision-board-state.test.mjs`

**Step 1: Write failing state tests**

Add tests near the existing `hasUninjectedHardChanges` tests. Keep the existing exported function name initially if that minimizes churn, but write assertions for the new semantics.

```js
const acceptedSoftBoard = mod.addBoardItem(mod.createEmptyBoard(), {
	kind: "decision",
	text: "Accepted decisions are enforced",
	status: "accepted",
	strength: "soft",
});
assert.equal(
	mod.hasUninjectedHardChanges(acceptedSoftBoard, 0),
	true,
	"accepted soft items are enforced until injected",
);
assert.equal(
	mod.hasUninjectedHardChanges(acceptedSoftBoard, acceptedSoftBoard.version),
	false,
	"accepted items stop blocking after the current board is injected",
);

const proposedOnlyBoard = mod.addBoardItem(mod.createEmptyBoard(), {
	kind: "decision",
	text: "Draft policy",
	status: "proposed",
	strength: "soft",
});
assert.equal(
	mod.hasUninjectedHardChanges(proposedOnlyBoard, 0),
	false,
	"proposed items are visible but not enforced",
);

const acceptedFromProposed = mod.updateBoardItem(proposedOnlyBoard, "D1", { status: "accepted" });
assert.equal(
	mod.hasUninjectedHardChanges(acceptedFromProposed, proposedOnlyBoard.version),
	true,
	"accepting a proposed item creates a stale enforcement barrier",
);

const rejectedAccepted = mod.updateBoardItem(acceptedSoftBoard, "D1", { status: "rejected" });
assert.equal(
	mod.hasUninjectedHardChanges(rejectedAccepted, acceptedSoftBoard.version),
	true,
	"rejecting an accepted item remains stale-sensitive until injected",
);

const legacyStrengthChanged = mod.updateBoardItem(acceptedSoftBoard, "D1", { strength: "hard" });
assert.equal(
	mod.hasUninjectedHardChanges(legacyStrengthChanged, acceptedSoftBoard.version),
	false,
	"legacy strength-only changes do not create enforcement barriers",
);

const clearedAccepted = mod.clearBoard(acceptedSoftBoard);
assert.equal(
	mod.hasUninjectedHardChanges(clearedAccepted, acceptedSoftBoard.version),
	true,
	"clearing accepted items remains stale-sensitive until injected",
);
```

Also update existing tests that mention hard-only behavior:

```js
assert.equal(mod.hasUninjectedHardChanges(withDecision, 1), true, "accepted changes after injected version are detected");
assert.equal(mod.hasUninjectedHardChanges(withDecision, 2), false, "injected accepted changes are not stale");
```

**Step 2: Run tests to verify failure**

Run:

```bash
node tests/live-decision-board-state.test.mjs
```

Expected: FAIL because accepted soft items do not currently create barriers and strength-only changes currently do.

**Step 3: Implement accepted-item enforcement helpers**

In `extensions/live-decision-board.ts`:

- Keep `BoardStrength` and `strength` fields for persisted compatibility.
- Add helpers near `isAcceptedHardItem`:

```ts
function isEnforcedItem(item: Pick<BoardItem, "status">): boolean {
	return item.status === "accepted";
}

function maxEnforcedItemVersion(items: BoardItem[]): number {
	return items.reduce((maxVersion, item) => (isEnforcedItem(item) ? Math.max(maxVersion, item.version) : maxVersion), 0);
}
```

- Reinterpret `getHardDecisionBarrierVersion()` as the compatibility-backed enforcement barrier:

```ts
function getHardDecisionBarrierVersion(board: BoardState): number {
	return board.hardDecisionBarrierVersion ?? maxEnforcedItemVersion(board.items);
}
```

- Add a boundary predicate that ignores legacy strength:

```ts
function isSameEnforcedBoundary(left: BoardItem, right: BoardItem): boolean {
	return (
		left.kind === right.kind &&
		left.text === right.text &&
		left.status === right.status &&
		left.supersedes === right.supersedes
	);
}

function enforcedBoundaryChanged(previous: BoardItem, next: BoardItem): boolean {
	return isEnforcedItem(previous) || isEnforcedItem(next)
		? !isSameEnforcedBoundary(previous, next)
		: false;
}
```

- Update `addBoardItem()` barrier assignment:

```ts
hardDecisionBarrierVersion: isEnforcedItem(item) ? nextVersion : getHardDecisionBarrierVersion(board),
```

- Update `updateBoardItem()` barrier assignment:

```ts
const enforcementChanged = enforcedBoundaryChanged(existing, effective);
...
hardDecisionBarrierVersion: enforcementChanged ? nextVersion : getHardDecisionBarrierVersion(board),
```

- Update `clearBoard()`:

```ts
hardDecisionBarrierVersion: board.items.some(isEnforcedItem) ? nextVersion : getHardDecisionBarrierVersion(board),
```

- Update `normalizeBoardState()` required barrier to use `maxEnforcedItemVersion(items)`.
- Keep `isAcceptedHardItem()` temporarily if other tasks still use it; do not remove it in this task unless all references are updated here.

**Step 4: Run tests**

Run:

```bash
node tests/live-decision-board-state.test.mjs
npm test
```

Expected: all tests pass after updating old assertion text.

**Step 5: Commit**

```bash
git add extensions/live-decision-board.ts tests/live-decision-board-state.test.mjs
git commit -m "feat: enforce accepted board items"
```

---

### Task 2: Remove hard/soft wording from prompt, widget, and status formatting

**Files:**
- Modify: `extensions/live-decision-board.ts`
- Test: `tests/live-decision-board-state.test.mjs`
- Test: `tests/live-decision-board-extension.test.mjs`

**Step 1: Write failing prompt/widget tests**

Update prompt tests near `formatBoardForPrompt(withDecision)`:

```js
assert.match(prompt, /Accepted items are enforced current context/, "prompt explains accepted item enforcement");
assert.doesNotMatch(prompt, /Hard means an enforced constraint/);
assert.doesNotMatch(prompt, /\bsoft\b|\bhard\b/, "prompt hides legacy strength labels");
assert.match(prompt, /D1: Build as a Pi extension first \[accepted, source:user, v2\]/);
```

Update widget tests to expect no hard count and no hard marker:

```js
assert.deepEqual(
	widget,
	[
		"Board v4 • 2 assumptions • 2 decisions",
		"Decisions (2)",
		"• [D1] First decision",
		"• [D2] Second decision",
		"Assumptions (2)",
		"• [A1] Backend uses Node 22",
		"• [A2] Second assumption",
	],
	"widget groups sections without exposing legacy strength",
);
```

Update `formatBoardStatus(withDecision)` expectation:

```js
assert.match(mod.formatBoardStatus(withDecision), /Board v2 • 1 assumption • 1 decision$/);
assert.doesNotMatch(mod.formatBoardStatus(withDecision), /hard constraint/);
```

In extension tests, assert the persistent widget summary has no hard count:

```js
assert.doesNotMatch(widgetText, /hard constraint/, "persistent widget should not show legacy hard counts");
```

**Step 2: Run tests to verify failure**

Run:

```bash
node tests/live-decision-board-state.test.mjs
node tests/live-decision-board-extension.test.mjs
```

Expected: FAIL with old prompt/widget hard/soft text.

**Step 3: Implement formatting changes**

In `formatBoardForPrompt()` replace rules with:

```ts
lines.push("- Treat accepted board items as enforced current context before mutating files.");
lines.push("- Proposed items are visible drafts; reconcile or accept them before relying on them as enforced context.");
lines.push("- If current work conflicts with this board, reconcile before continuing.");
lines.push("- Record only assumptions or decisions that should affect future behavior; do not use the board as an implementation log.", "");
```

Change `formatPromptItem()` to omit strength:

```ts
return `- ${item.id}: ${item.text} [${item.status}, source:${item.source}, v${item.version}]`;
```

Change `formatBoardStatus()` and `formatBoardStatusForWidget()` to omit hard counts:

```ts
return `Board v${board.version} • ${pluralize(assumptions, "assumption")} • ${pluralize(decisions, "decision")}`;
```

```ts
return [
	theme.fg("muted", "Board"),
	theme.fg("success", pluralize(assumptions, "assumption")),
	theme.fg("success", pluralize(decisions, "decision")),
].join(" • ");
```

Change `appendWidgetSection()` to stop using `!` for legacy hard items:

```ts
lines.push(`• [${item.id}] ${item.text}`);
```

Change `colorizeWidgetLine()` regex to only handle `•`, or keep it tolerant but never emit `!`.

**Step 4: Run tests**

Run:

```bash
npm test
```

Expected: tests pass.

**Step 5: Commit**

```bash
git add extensions/live-decision-board.ts tests/live-decision-board-state.test.mjs tests/live-decision-board-extension.test.mjs
git commit -m "fix: hide legacy strength in board context"
```

---

### Task 3: Deprecate hard/soft commands and remove strength actions from board manager UI

**Files:**
- Modify: `extensions/live-decision-board.ts`
- Test: `tests/live-decision-board-extension.test.mjs`

**Step 1: Write failing extension tests**

Update command/tool guidance tests:

```js
assert(
	registeredTool.promptGuidelines.some((line) => line.includes("accepted board items are enforced")),
	"decision_board prompt guidance should explain accepted item enforcement",
);
assert(
	!registeredTool.promptGuidelines.some((line) => /Use hard only|soft/i.test(line)),
	"decision_board prompt guidance should not promote hard/soft distinctions",
);
```

Add deprecated command behavior tests after existing board-hard/soft command coverage:

```js
let deprecatedStrengthNotification = "";
const deprecatedStrengthCtx = {
	...ctx,
	ui: { ...ctx.ui, notify: (message) => { deprecatedStrengthNotification = message; } },
};
const beforeDeprecatedStrength = entries.length;
await commands.get("board-hard").handler("D1", deprecatedStrengthCtx);
assert.equal(entries.length, beforeDeprecatedStrength, "deprecated /board-hard should not persist changes");
assert.match(deprecatedStrengthNotification, /accepted board items are enforced/i);
await commands.get("board-soft").handler("D1", deprecatedStrengthCtx);
assert.equal(entries.length, beforeDeprecatedStrength, "deprecated /board-soft should not persist changes");
```

Update `decision_board.set_strength` tests:

```js
const beforeToolDeprecatedStrength = entries.length;
const deprecatedStrengthToolResult = await registeredTool.execute(
	"tool-strength-deprecated",
	{ action: "set_strength", id: "D3", strength: "hard" },
	undefined,
	undefined,
	ctx,
);
assert.equal(entries.length, beforeToolDeprecatedStrength, "deprecated set_strength should not persist changes");
assert.match(deprecatedStrengthToolResult.content[0].text, /deprecated/i);
```

Update board manager TUI test expectations:

```js
assert.doesNotMatch(rendered[0], /h hard|s soft|\/soft|\/hard/i);
assert.doesNotMatch(rendered[0], /hard constraint/);
```

Also simulate `h`/`s` in manager if existing tests do so; expected result should be no action/no persistence, or remove those key simulations from durable tests.

**Step 2: Run tests to verify failure**

Run:

```bash
node tests/live-decision-board-extension.test.mjs
```

Expected: FAIL because hard/soft still mutate and manager still shows h/s.

**Step 3: Implement command/tool deprecation and manager UI changes**

In `BoardManagerAction`, remove `"harden" | "soften"` from the action union.

In `BoardManagerComponent.handleInput()`, remove `h`/`s` cases.

In `BoardManagerComponent.render()`, remove hard count and update help:

```ts
`Board v${this.board.version} • ${pluralize(activeCount, "active item")} • ${pluralize(inactiveCount, "inactive item")}`
```

```ts
"↑↓/j/k select • enter/e edit • a accept • r reject/remove • u supersede • q/esc close"
```

In `BoardManagerComponent.renderItem()`, render status only:

```ts
return truncateToWidth(`${marker} ${id} ${status} ${text}`, width);
```

Remove harden/soften cases in `applyBoardManagerAction()`.

Change `/board-hard` and `/board-soft` handlers:

```ts
function notifyStrengthDeprecated(ctx: ExtensionContext): void {
	ctx.ui.notify("Hard/soft strength is deprecated; accepted board items are enforced automatically.", "info");
}
```

```ts
pi.registerCommand("board-hard", {
	description: "Deprecated: accepted board items are enforced automatically",
	handler: async (_args, ctx) => notifyStrengthDeprecated(ctx),
});
```

Same for `board-soft`.

Update `decision_board` promptGuidelines:

```ts
"Accepted board items are enforced for stale-mutation safety; proposed items are drafts until accepted.",
```

Keep `set_strength` in the schema for compatibility, but return a no-op result:

```ts
} else {
	return {
		content: [{ type: "text", text: "set_strength is deprecated; accepted board items are enforced automatically. No change." }],
		details: { board },
	};
}
```

Do not require `params.strength` before returning the deprecation result; older agents may call it with or without strength.

**Step 4: Run tests**

Run:

```bash
npm test
```

Expected: all tests pass.

**Step 5: Commit**

```bash
git add extensions/live-decision-board.ts tests/live-decision-board-extension.test.mjs
git commit -m "fix: deprecate board strength controls"
```

---

### Task 4: Update cleanup recommendations and confirmation impact for accepted-item enforcement

**Files:**
- Modify: `extensions/live-decision-board.ts`
- Test: `tests/live-decision-board-state.test.mjs`
- Test: `tests/live-decision-board-extension.test.mjs`

**Step 1: Write failing cleanup state tests**

Replace hard-specific cleanup expectations:

```js
assert.equal(cleanupRecommendations.find((rec) => rec.id === "D2").action, "keep", "ambiguous accepted items default keep");
assert.equal(cleanupRecommendations.find((rec) => rec.id === "D2").riskLevel, "low", "legacy hard strength no longer creates special cleanup risk");
assert.doesNotMatch(cleanupRecommendations.find((rec) => rec.id === "D2").reason, /Hard constraints/i);
```

Add a historical legacy-hard item case:

```js
let legacyHardHistoricalBoard = mod.createEmptyBoard();
legacyHardHistoricalBoard = mod.addBoardItem(legacyHardHistoricalBoard, {
	kind: "decision",
	text: "Apply Round 7 review fixes",
	status: "accepted",
	strength: "hard",
});
const legacyHardHistorical = mod.recommendBoardCleanup(legacyHardHistoricalBoard)[0];
assert.equal(legacyHardHistorical.action, "archive", "legacy hard strength does not prevent historical cleanup suggestions");
assert.equal(legacyHardHistorical.selected, true);
```

Update impact expectations from hard counts to accepted counts after implementation. If retaining field names temporarily, still change user-facing confirmation text in extension tests.

**Step 2: Write failing extension tests for cleanup UI/confirmation wording**

Update cleanup render assertions:

```js
assert.doesNotMatch(cleanupRendered[0], /accepted\/hard|Hard constraints/i);
assert.match(cleanupRendered[0], /accepted /, "cleanup rows show status without legacy strength");
```

Update confirmation tests:

```js
assert.match(confirmMessage, /Accepted items:\s*2\s*→\s*1/i);
assert.doesNotMatch(confirmMessage, /Hard constraints/i);
```

**Step 3: Run tests to verify failure**

Run:

```bash
node tests/live-decision-board-state.test.mjs
node tests/live-decision-board-extension.test.mjs
```

Expected: FAIL with hard-specific cleanup behavior and confirmation text.

**Step 4: Implement cleanup changes**

In `recommendCleanupForItem()` remove the `isAcceptedHardItem()` special case entirely. Proposed items still return `needs_user_review`; historical accepted items return selected archive; ambiguous accepted items keep.

Change `CleanupImpact`:

```ts
export interface CleanupImpact {
	activeBefore: number;
	activeAfter: number;
	acceptedBefore: number;
	acceptedAfter: number;
	archiveCount: number;
	supersedeCount: number;
	needsUserReviewCount: number;
}
```

In `summarizeBoardCleanupImpact()` count accepted active items:

```ts
const acceptedBefore = activeBoardItems(board).filter((item) => item.status === "accepted").length;
...
acceptedAfter: activeBoardItems(nextBoard).filter((item) => item.status === "accepted").length,
```

Change confirmation formatter:

```ts
`Accepted items: ${impact.acceptedBefore} → ${impact.acceptedAfter}`,
```

Update `BoardCleanupComponent.renderRecommendation()` to hide legacy strength:

```ts
main: truncateToWidth(`${cursor} ${checkbox} ${id} ${status} ${action} • ${risk} • ${text}`, width),
```

Keep `observedStrength` in `CleanupRecommendation` for stale validation only.

**Step 5: Run tests**

Run:

```bash
npm test
```

Expected: all tests pass.

**Step 6: Commit**

```bash
git add extensions/live-decision-board.ts tests/live-decision-board-state.test.mjs tests/live-decision-board-extension.test.mjs
git commit -m "fix: align cleanup with accepted enforcement"
```

---

### Task 5: Update markdown compatibility and docs

**Files:**
- Modify: `README.md`
- Modify: `docs/brainstorm/board-productivity.org`
- Modify: `extensions/live-decision-board.ts` only if markdown help text/comments need small compatibility wording changes
- Test: `tests/live-decision-board-state.test.mjs`

**Step 1: Write/update tests for markdown compatibility**

Keep durable tests proving old markdown still parses:

```js
const legacyMarkdown = "# Live Decision Board\n\n- D1 | decision | accepted | hard | Legacy hard item\n";
const parsedLegacy = mod.parseBoardMarkdown(legacyMarkdown, mod.createEmptyBoard());
assert.equal(parsedLegacy.items[0].strength, "hard", "legacy strength is still parsed for session compatibility");
assert.equal(mod.hasUninjectedHardChanges(parsedLegacy, 0), true, "accepted legacy items are enforced regardless of strength");
```

If `serializeBoardMarkdown()` continues to emit strength, add assertion/comment in tests that it is compatibility format, not product semantics.

**Step 2: Run tests to verify current compatibility**

Run:

```bash
node tests/live-decision-board-state.test.mjs
```

Expected: should pass if parser remains compatible; if it fails, fix parser compatibility before docs.

**Step 3: Update README**

Revise top description:

```md
The board is visible while the agent works, editable by the user, writable by the model through a tool, injected into future model context, and enforced before stale accepted-item mutations.
```

Update command table:

- `/board-manage`: remove harden/soften.
- `/assume`: “Add an accepted assumption”.
- `/decide`: “Add an accepted decision”.
- `/board-hard` and `/board-soft`: mark deprecated compatibility no-ops, or remove from table if command autocomplete docs should not advertise them. For this plan, keep them under a short “Compatibility commands” subsection, not the main command table.

Update “How it works”:

```md
Accepted board items block stale `write`, `edit`, and non-read-only `bash` calls until the fresh board has been injected into provider context. Proposed items are visible drafts and become enforced when accepted.
```

Replace “Soft vs hard items” with:

```md
## Accepted vs proposed items

Accepted items are enforced current context. The agent should treat every accepted assumption or decision as relevant before mutating files.

Proposed items are visible drafts. Use them for uncertain assumptions or decisions that need user confirmation before they become enforced.

The legacy `soft`/`hard` strength field may appear in older session data or markdown exports. It is retained for compatibility only and does not affect enforcement.
```

Update board hygiene examples to remove hard wording.

Update development summary:

```md
The tests exercise state helpers, command/tool registration, context injection, steering, markdown parsing, and stale accepted-item mutation blocking.
```

**Step 4: Update brainstorm doc**

In `docs/brainstorm/board-productivity.org`, update hard/soft sections to accepted/proposed/enforced semantics:

- Active accepted items are enforced.
- Proposed items need review.
- Remove hard-item preservation language or reframe as accepted-item preservation.
- Leave historical notes only if clearly labeled as old/deprecated.

Do not edit old implementation plans unless needed; they are historical plans and may mention old hard/soft behavior.

**Step 5: Run verification**

Run:

```bash
npm test
node - <<'NODE'
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverAndLoadExtensions } from '@earendil-works/pi-coding-agent';
const agentDir = await mkdtemp(join(tmpdir(), 'pi-live-decision-board-agent-'));
const result = await discoverAndLoadExtensions(['.'], process.cwd(), agentDir);
console.log(`extensions=${result.extensions.length} errors=${result.errors.length}`);
if (result.errors.length) process.exit(1);
NODE
npm pack --dry-run --json
git diff --check
```

Expected:
- tests pass,
- discovery prints `extensions=1 errors=0`,
- pack dry-run includes `LICENSE`, `README.md`, `extensions/live-decision-board.ts`, `package.json`,
- no whitespace errors.

**Step 6: Commit**

```bash
git add README.md docs/brainstorm/board-productivity.org extensions/live-decision-board.ts tests/live-decision-board-state.test.mjs
git commit -m "docs: document accepted board enforcement"
```

---

### Task 6: Compatibility cleanup and naming review

**Files:**
- Modify: `extensions/live-decision-board.ts`
- Test: `tests/live-decision-board-state.test.mjs`
- Test: `tests/live-decision-board-extension.test.mjs`

**Step 1: Review internal names**

Search:

```bash
rg -n "hard|soft|strength|constraint|barrier|hasUninjectedHardChanges|hardDecision" extensions tests README.md docs/brainstorm/board-productivity.org
```

Decide which internal compatibility names stay:

- `BoardStrength`, `strength`, `hardDecisionBarrierVersion`, and `hasUninjectedHardChanges()` may remain for session/API compatibility.
- User-facing strings and test names should not say hard/soft except where explicitly testing legacy compatibility/deprecation.

**Step 2: Add alias helpers if useful**

If readability is suffering, add wrapper helpers without breaking old tests/API:

```ts
export function hasUninjectedEnforcedChanges(board: BoardState, injectedVersion: number): boolean {
	return getHardDecisionBarrierVersion(board) > injectedVersion;
}

export function hasUninjectedHardChanges(board: BoardState, injectedVersion: number): boolean {
	return hasUninjectedEnforcedChanges(board, injectedVersion);
}
```

Update internal `context` and `tool_call` hooks to call `hasUninjectedEnforcedChanges()`.

**Step 3: Run tests**

Run:

```bash
npm test
```

Expected: all tests pass.

**Step 4: Commit if changes were needed**

```bash
git add extensions/live-decision-board.ts tests/live-decision-board-state.test.mjs tests/live-decision-board-extension.test.mjs
git commit -m "refactor: name enforced board barriers"
```

If no changes are needed, do not create an empty commit; note “Task 6 no-op after review” in the final report.

---

### Task 7: Final review and installed-cache verification

**Files:**
- No source changes expected.

**Step 1: Inspect changed tests for hygiene**

Run:

```bash
git diff --name-only origin/main...HEAD
```

Review every changed test file. Keep tests only if they verify public behavior, real regressions, or compatibility contracts. Remove any exploratory/private-helper-only tests unless they protect a needed exported compatibility contract.

**Step 2: Full local verification**

Run:

```bash
npm ci
npm test
npm pack --dry-run --json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const p=JSON.parse(s)[0]; console.log(`${p.name}@${p.version} entries=${p.entryCount} size=${p.size}`); console.log(p.files.map(f=>f.path).join("\n"));})'
git diff --check
git status --short
```

Expected:
- `npm ci` exits 0,
- `npm test` exits 0,
- pack dry-run includes runtime package files only,
- no diff-check errors,
- worktree clean after commits.

**Step 3: Push and update installed cache**

Run:

```bash
git push origin HEAD:main
pi update --extension git:github.com/Maverobot/pi-live-decision-board@main
node --input-type=module - <<'NODE'
import { discoverAndLoadExtensions } from 'file:///home/zheng/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
const source = '/home/zheng/.pi/agent/git/github.com/Maverobot/pi-live-decision-board';
const result = await discoverAndLoadExtensions([source], process.cwd(), '/tmp/pi-live-board-install-agent-dir-accepted-enforced');
const extension = result.extensions[0];
console.log(`extensions=${result.extensions.length} errors=${result.errors.length}`);
console.log(`commands=${[...(extension?.commands.keys() ?? [])].sort().join(',')}`);
if (result.errors.length || !extension?.commands.has('board-cleanup')) process.exit(1);
NODE
```

Expected:
- push succeeds,
- update succeeds,
- installed discovery includes the extension and expected commands.

---

## Deferred follow-up items

Do not include these unless the user explicitly expands scope:

- First-class schema migration that removes `strength` from persisted board items.
- Removing `/board-hard`, `/board-soft`, or `decision_board.set_strength` entirely instead of compatibility no-ops.
- Changing Pi core/widget APIs for widget-neighbor-aware separators.
- Subagent-assisted board cleanup.
- Duplicate/merge cleanup workflows.
- `/board-history`.
