# Board Cleanup MVP Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Add a conservative, user-confirmed `/board-cleanup` workflow that helps archive obvious historical board clutter without automatic or subagent-driven mutation.

**Architecture:** Implement cleanup in three layers inside `extensions/live-decision-board.ts`: pure recommendation/apply helpers, a TUI review component, and a command handler that guards stale UI with `boardEpoch` and commits through existing board mutation paths. MVP uses board-only local heuristics, maps user-facing “archive” to inactive `rejected` status, keeps hard/proposed/ambiguous items by default, and applies only user-confirmed actions.

**Tech Stack:** TypeScript Pi extension API, `@earendil-works/pi-tui` custom components, existing board state helpers, Node test scripts (`tests/live-decision-board-state.test.mjs`, `tests/live-decision-board-extension.test.mjs`).

---

## Scope decisions

- `/board-cleanup` is TUI-only for MVP.
- No subagent/model cleanup in MVP.
- No git/docs/session-message gathering in MVP.
- “Archive” is UX wording; implementation maps archive to `status: "rejected"` for now.
- Cleanup recommendations are transient UI state, not board items.
- Hard accepted items are never selected for cleanup by default.
- Proposed items are not archived by default.
- Cancel/no-op must leave board state untouched.
- Stale UI must skip apply if `boardEpoch` changes while cleanup UI/confirmation is open.

## Acceptance criteria

- `decision_board` guidance remains anti-changelog.
- `/board-cleanup` is registered and documented.
- Non-TUI mode explains that `/board-cleanup` requires TUI mode.
- Empty or already-clean board notifies and persists nothing.
- Local cleanup classifies obvious historical soft accepted items as archive candidates.
- Hard/proposed/ambiguous items default to keep/needs-review.
- Review UI shows item id, status/strength, proposed action, reason, and keyboard help.
- User can toggle selected cleanup actions and cancel safely.
- Confirm screen shows active item count and hard constraint count before/after.
- Apply persists exactly once per confirmed cleanup operation.
- Applying archive removes items from active prompt/widget context but keeps them in board history.
- Hard item changes require explicit per-item confirmation or are not offered in MVP.
- Full verification passes.

---

### Task 1: Pure cleanup recommendation model

**Files:**
- Modify: `extensions/live-decision-board.ts` near board state helpers after `activeBoardItems()`
- Test: `tests/live-decision-board-state.test.mjs`

**Step 1: Write failing state tests**

Add tests after existing widget/active-item tests.

```js
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
assert.equal(cleanupRecommendations.length, 4, "cleanup reviews active items only");
assert.equal(cleanupRecommendations.find((rec) => rec.id === "D1").action, "archive");
assert.equal(cleanupRecommendations.find((rec) => rec.id === "D1").selected, true);
assert.match(cleanupRecommendations.find((rec) => rec.id === "D1").reason, /historical/i);
assert.equal(cleanupRecommendations.find((rec) => rec.id === "D2").action, "keep", "hard items default keep");
assert.equal(cleanupRecommendations.find((rec) => rec.id === "A1").action, "needs_user_review", "proposed items need review");
assert.equal(cleanupRecommendations.find((rec) => rec.id === "D3").action, "keep", "ambiguous current items default keep");
```

Also verify inactive items are not recommended:

```js
const inactiveCleanupBoard = mod.updateBoardItem(cleanupBoard, "D1", { status: "rejected" });
assert(!mod.recommendBoardCleanup(inactiveCleanupBoard).some((rec) => rec.id === "D1"));
```

**Step 2: Run test to verify failure**

Run:

```bash
node tests/live-decision-board-state.test.mjs
```

Expected: FAIL with `mod.recommendBoardCleanup is not a function`.

**Step 3: Implement minimal model/helpers**

Add exported types and function:

```ts
export type CleanupAction = "keep" | "archive" | "supersede" | "needs_user_review";
export type CleanupRiskLevel = "low" | "medium" | "high";

export interface CleanupRecommendation {
	id: string;
	itemVersion: number;
	observedText: string;
	observedStatus: BoardStatus;
	observedStrength: BoardStrength;
	action: CleanupAction;
	selected: boolean;
	reason: string;
	riskLevel: CleanupRiskLevel;
	requiresExplicitConfirmation: boolean;
	replacementText?: string;
}

export function recommendBoardCleanup(board: BoardState): CleanupRecommendation[] {
	return activeBoardItems(board).sort(compareWidgetItems).map(recommendCleanupForItem);
}
```

Implement conservative classifier:

```ts
function recommendCleanupForItem(item: BoardItem): CleanupRecommendation {
	const base = cleanupBase(item);
	if (isAcceptedHardItem(item)) {
		return { ...base, action: "keep", selected: false, riskLevel: "high", requiresExplicitConfirmation: true, reason: "Hard constraints are kept by default." };
	}
	if (item.status === "proposed") {
		return { ...base, action: "needs_user_review", selected: false, riskLevel: "medium", requiresExplicitConfirmation: true, reason: "Proposed items need user review before cleanup." };
	}
	if (looksHistorical(item.text)) {
		return { ...base, action: "archive", selected: true, riskLevel: "low", requiresExplicitConfirmation: false, reason: "Looks like a completed implementation or review-log entry." };
	}
	return { ...base, action: "keep", selected: false, riskLevel: "low", requiresExplicitConfirmation: false, reason: "No safe cleanup heuristic matched; keep by default." };
}
```

Use simple local heuristics only:

```ts
function looksHistorical(text: string): boolean {
	return /\b(apply round \d+|review fixes|implemented|after the next review round|rename[sd]? \/|add \/board-|fix(?:ed)? .*review|completed|pushed|installed cache)\b/i.test(text);
}
```

**Step 4: Run test to verify pass**

Run:

```bash
node tests/live-decision-board-state.test.mjs
```

Expected: `live decision board state tests passed`.

**Step 5: Commit**

```bash
git add extensions/live-decision-board.ts tests/live-decision-board-state.test.mjs
git commit -m "feat: add board cleanup recommendations"
```

---

### Task 2: Pure cleanup apply/impact helpers

**Files:**
- Modify: `extensions/live-decision-board.ts`
- Test: `tests/live-decision-board-state.test.mjs`

**Step 1: Write failing tests**

Add tests after Task 1 tests:

```js
const archivePlan = cleanupRecommendations.map((rec) =>
	rec.id === "D1" ? { ...rec, selected: true } : { ...rec, selected: false },
);
const cleanupImpact = mod.summarizeBoardCleanupImpact(cleanupBoard, archivePlan);
assert.equal(cleanupImpact.activeBefore, 4);
assert.equal(cleanupImpact.activeAfter, 3);
assert.equal(cleanupImpact.hardBefore, 1);
assert.equal(cleanupImpact.hardAfter, 1);
assert.equal(cleanupImpact.archiveCount, 1);

const cleanedBoard = mod.applyBoardCleanup(cleanupBoard, archivePlan);
assert.equal(cleanedBoard.items.find((item) => item.id === "D1").status, "rejected", "archive maps to inactive retained status");
assert.equal(cleanedBoard.items.find((item) => item.id === "D2").strength, "hard", "cleanup preserves hard item strength");
assert.equal(mod.formatBoardForPrompt(cleanedBoard).includes("Apply Round 5"), false, "archived item leaves active prompt context");

const noOpCleanup = mod.applyBoardCleanup(cleanupBoard, cleanupRecommendations.map((rec) => ({ ...rec, selected: false })));
assert.equal(noOpCleanup, cleanupBoard, "cleanup with no selected actions is a no-op");
```

Add stale recommendation test:

```js
const stalePlan = archivePlan.map((rec) => (rec.id === "D1" ? { ...rec, observedText: "old text" } : rec));
assert.throws(() => mod.applyBoardCleanup(cleanupBoard, stalePlan), /changed since cleanup was prepared/);
```

**Step 2: Run test to verify failure**

Run:

```bash
node tests/live-decision-board-state.test.mjs
```

Expected: FAIL with missing helper function.

**Step 3: Implement helpers**

Add:

```ts
export interface CleanupImpact {
	activeBefore: number;
	activeAfter: number;
	hardBefore: number;
	hardAfter: number;
	archiveCount: number;
	supersedeCount: number;
	needsUserReviewCount: number;
}

export function applyBoardCleanup(board: BoardState, recommendations: CleanupRecommendation[]): BoardState {
	let next = board;
	for (const recommendation of recommendations) {
		if (!recommendation.selected) continue;
		const current = next.items.find((item) => item.id === recommendation.id);
		if (!current) throw new Error(`Board cleanup item not found: ${recommendation.id}`);
		assertCleanupRecommendationFresh(current, recommendation);
		if (recommendation.action === "archive") {
			next = updateBoardItem(next, recommendation.id, { status: "rejected" });
		} else if (recommendation.action === "supersede") {
			if (!recommendation.replacementText?.trim()) throw new Error(`Cleanup supersede requires replacement text for ${recommendation.id}`);
			next = supersedeBoardItem(next, recommendation.id, recommendation.replacementText, "user");
		}
	}
	return next;
}
```

Freshness guard:

```ts
function assertCleanupRecommendationFresh(item: BoardItem, recommendation: CleanupRecommendation): void {
	if (
		item.version !== recommendation.itemVersion ||
		item.text !== recommendation.observedText ||
		item.status !== recommendation.observedStatus ||
		item.strength !== recommendation.observedStrength
	) {
		throw new Error(`Board item ${recommendation.id} changed since cleanup was prepared`);
	}
}
```

Impact can call `applyBoardCleanup` internally, but handle no-op safely.

**Step 4: Run test to verify pass**

Run:

```bash
node tests/live-decision-board-state.test.mjs
```

Expected: state tests pass.

**Step 5: Commit**

```bash
git add extensions/live-decision-board.ts tests/live-decision-board-state.test.mjs
git commit -m "feat: apply board cleanup plans"
```

---

### Task 3: Register `/board-cleanup` shell

**Files:**
- Modify: `extensions/live-decision-board.ts`
- Test: `tests/live-decision-board-extension.test.mjs`

**Step 1: Write failing extension tests**

Add `"board-cleanup"` to command registration assertions.

Add non-TUI guard test near `/board-manage` non-TUI test:

```js
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
assert.match(cleanupNonTuiNotification, /requires TUI mode/);
```

Add empty-board no-op test using a fresh extension instance:

```js
const cleanupCommands = new Map();
const cleanupEvents = new Map();
const cleanupEntries = [];
let cleanupNotification = "";
extension({
	on: (name, callback) => cleanupEvents.set(name, callback),
	registerCommand: (name, def) => cleanupCommands.set(name, def),
	registerTool: () => {},
	appendEntry: (customType, data) => cleanupEntries.push({ type: "custom", customType, data }),
	sendMessage: () => {},
});
const cleanupCtx = {
	mode: "tui",
	hasUI: true,
	isIdle: () => true,
	sessionManager: { getBranch: () => [] },
	ui: { ...ctx.ui, notify: (message) => { cleanupNotification = message; }, custom: async () => { throw new Error("empty cleanup should not open UI"); } },
};
await cleanupEvents.get("session_start")({}, cleanupCtx);
await cleanupCommands.get("board-cleanup").handler("", cleanupCtx);
assert.match(cleanupNotification, /No active board items/);
assert.equal(cleanupEntries.length, 0);
```

**Step 2: Run test to verify failure**

Run:

```bash
node tests/live-decision-board-extension.test.mjs
```

Expected: FAIL because `board-cleanup` is not registered.

**Step 3: Implement command shell**

Add command near `/board-manage`:

```ts
pi.registerCommand("board-cleanup", {
	description: "Review and archive historical board items with confirmation",
	handler: async (_args, ctx) => {
		if (ctx.mode !== "tui") return ctx.ui.notify("/board-cleanup requires TUI mode", "error");
		await cleanupBoard(ctx);
	},
});
```

Add minimal `cleanupBoard()`:

```ts
async function cleanupBoard(ctx: ExtensionContext): Promise<void> {
	const recommendations = recommendBoardCleanup(board);
	if (recommendations.length === 0) {
		ctx.ui.notify("No active board items to clean up", "info");
		return;
	}
	ctx.ui.notify("/board-cleanup UI is not implemented yet", "warning");
}
```

**Step 4: Run test to verify pass for shell**

Run:

```bash
node tests/live-decision-board-extension.test.mjs
```

Expected: extension tests pass or fail only on future UI tests not yet added.

**Step 5: Commit**

```bash
git add extensions/live-decision-board.ts tests/live-decision-board-extension.test.mjs
git commit -m "feat: add board cleanup command shell"
```

---

### Task 4: Cleanup review TUI component

**Files:**
- Modify: `extensions/live-decision-board.ts`
- Test: `tests/live-decision-board-extension.test.mjs`

**Step 1: Write failing TUI tests**

Add a fresh extension instance test similar to `/board-manage` tests:

```js
const cleanupRendered = [];
const cleanupKeys = ["j", " ", "q"];
const cleanupCtx = {
	mode: "tui",
	hasUI: true,
	isIdle: () => true,
	sessionManager: { getBranch: () => [] },
	ui: {
		...ctx.ui,
		notify: () => {},
		custom: async (factory) => {
			let result;
			const component = factory({ requestRender: () => {} }, testTheme, {}, (value) => { result = value; });
			cleanupRendered.push(component.render(100).join("\n"));
			component.handleInput(cleanupKeys.shift());
			cleanupRendered.push(component.render(100).join("\n"));
			component.handleInput(cleanupKeys.shift());
			cleanupRendered.push(component.render(100).join("\n"));
			component.handleInput(cleanupKeys.shift());
			return result;
		},
	},
};
```

Setup board with one historical item and one hard item. Assert:

```js
assert.match(cleanupRendered[0], /Board Cleanup/);
assert.match(cleanupRendered[0], /Archive from active board/);
assert.match(cleanupRendered[0], /Apply Round 5/);
assert.match(cleanupRendered[0], /Hard constraints are kept by default/);
assert.match(cleanupRendered[0], /space toggle/);
assert.notEqual(cleanupRendered[1], cleanupRendered[0], "j changes selection");
assert.notEqual(cleanupRendered[2], cleanupRendered[1], "space toggles selected action");
```

**Step 2: Run test to verify failure**

Run:

```bash
node tests/live-decision-board-extension.test.mjs
```

Expected: FAIL because cleanup UI is placeholder.

**Step 3: Implement component**

Add types:

```ts
type CleanupReviewResult = { type: "cancel" } | { type: "apply"; recommendations: CleanupRecommendation[] };
```

Add `BoardCleanupComponent` near `BoardManagerComponent`:

- Constructor accepts `recommendations`, `theme`, `done`, `requestRender`.
- `render(width)` displays:
  - title `Board Cleanup`
  - summary `N recommendations • M selected`
  - grouped recommendations in stable order: archive, supersede, needs_user_review, keep
  - row prefix: `>` selected cursor, `[x]` selected action, `[ ]` not selected
  - id/action/risk/text
  - reason line in dim text
  - help: `↑↓/j/k select • space toggle • enter apply selected • q/esc cancel`
- `handleInput()`:
  - `q`, escape, ctrl-c => cancel
  - up/down/j/k => move selection
  - space => toggle only actionable low-risk recommendations (`archive`, `supersede`) and not `requiresExplicitConfirmation`
  - enter => `done({ type: "apply", recommendations })`

**Step 4: Wire command to component without applying yet**

Update `cleanupBoard()`:

```ts
const result = await ctx.ui.custom<CleanupReviewResult>(
	(tui, theme, _keybindings, done) => new BoardCleanupComponent(recommendations, theme, done, () => tui.requestRender()),
	{ overlay: true, overlayOptions: { width: "90%", minWidth: 70, maxHeight: "80%" } },
);
if (result.type === "cancel") return;
ctx.ui.notify("Cleanup apply is not implemented yet", "warning");
```

**Step 5: Run tests**

Run:

```bash
npm test
```

Expected: tests pass or fail only on apply tests not yet added.

**Step 6: Commit**

```bash
git add extensions/live-decision-board.ts tests/live-decision-board-extension.test.mjs
git commit -m "feat: add board cleanup review UI"
```

---

### Task 5: Impact confirmation and apply

**Files:**
- Modify: `extensions/live-decision-board.ts`
- Test: `tests/live-decision-board-extension.test.mjs`

**Step 1: Write failing apply/cancel/stale tests**

Add fresh extension tests:

1. Cancel persists nothing:

```js
// custom returns { type: "cancel" }
await cleanupCommands.get("board-cleanup").handler("", cleanupCtx);
assert.equal(cleanupEntries.length, entriesBeforeCleanup);
```

2. Apply selected archive after confirmation persists once:

```js
let confirmMessage = "";
const cleanupCtx = {
	...
	ui: {
		...
		custom: async (factory) => {
			let result;
			const component = factory({ requestRender: () => {} }, testTheme, {}, (value) => { result = value; });
			component.handleInput("enter");
			return result;
		},
		confirm: async (_title, message) => {
			confirmMessage = message;
			return true;
		},
	},
};
await cleanupCommands.get("board-cleanup").handler("", cleanupCtx);
assert.match(confirmMessage, /active items/i);
assert.match(confirmMessage, /hard constraints/i);
assert.equal(cleanupEntries.at(-1).data.items.find((item) => item.id === "D1").status, "rejected");
assert.equal(cleanupEntries.length, entriesBeforeCleanup + 1, "cleanup persists one final board entry");
```

3. Declined confirmation persists nothing:

```js
confirm: async () => false
```

4. Stale epoch skips apply:

- Open cleanup UI.
- Before returning apply, trigger a board mutation or `session_tree` restore.
- Then return apply.
- Assert no cleanup append and notification mentions changed while cleanup was open.

**Step 2: Run test to verify failure**

Run:

```bash
node tests/live-decision-board-extension.test.mjs
```

Expected: FAIL because command does not apply.

**Step 3: Implement apply flow**

Update `cleanupBoard(ctx)`:

```ts
async function cleanupBoard(ctx: ExtensionContext): Promise<void> {
	const baseEpoch = boardEpoch;
	const recommendations = recommendBoardCleanup(board);
	if (recommendations.length === 0) { ... }
	const result = await ctx.ui.custom<CleanupReviewResult>(...);
	if (result.type === "cancel") return;
	if (boardEpoch !== baseEpoch) {
		ctx.ui.notify("Live Decision Board changed while cleanup was open; rerun /board-cleanup on the latest board.", "warning");
		return;
	}
	const selected = result.recommendations.filter((rec) => rec.selected && rec.action !== "keep" && rec.action !== "needs_user_review");
	if (selected.length === 0) {
		ctx.ui.notify("Board cleanup: no selected changes", "info");
		return;
	}
	const impact = summarizeBoardCleanupImpact(board, result.recommendations);
	const confirmed = await ctx.ui.confirm("Apply Board Cleanup?", formatCleanupImpactForConfirmation(impact));
	if (!confirmed) return;
	if (boardEpoch !== baseEpoch) { ...same stale guard... }
	safeApplyBoard(ctx, "Cleaned board", () => applyBoardCleanup(board, result.recommendations));
}
```

Add formatter:

```ts
function formatCleanupImpactForConfirmation(impact: CleanupImpact): string {
	return [
		`Active items: ${impact.activeBefore} → ${impact.activeAfter}`,
		`Hard constraints: ${impact.hardBefore} → ${impact.hardAfter}`,
		`Archive: ${impact.archiveCount}`,
		`Supersede: ${impact.supersedeCount}`,
		"Apply selected cleanup changes?",
	].join("\n");
}
```

**Step 4: Run tests**

Run:

```bash
npm test
```

Expected: all tests pass.

**Step 5: Commit**

```bash
git add extensions/live-decision-board.ts tests/live-decision-board-extension.test.mjs
git commit -m "feat: apply confirmed board cleanup"
```

---

### Task 6: Docs and prompt guidance examples

**Files:**
- Modify: `README.md`
- Modify: `docs/brainstorm/board-productivity.org` only if implementation deviates from brainstorm
- Modify: `TODO.org` if adding or completing checklist items

**Step 1: Update README command table**

Add row:

```md
| `/board-cleanup` | Review active board items and archive obvious historical entries after confirmation |
```

**Step 2: Add a “Board hygiene” README section**

Add after “Soft vs hard items”:

```md
## Board hygiene

The board is current working context, not a changelog. Add or keep an item only when it should affect future behavior.

Good board items:

- “Use keyboard-first board management unless Pi documents mouse support.”
- “Hard: never mutate files after a hard constraint changes until the fresh board is injected.”
- “Assumption: the user wants conservative cleanup defaults.”

Bad active board items:

- “Applied Round 5 review fixes.”
- “Ran npm test.”
- “Renamed `/board-show` to `/board-snapshot`.”

Use `/board-cleanup` to review active items and archive obvious historical entries. Archive removes an item from active context while retaining it in board history.
```

**Step 3: Update TODO**

If relevant, add/check:

```org
- [x] Add `/board-cleanup` MVP for user-confirmed board hygiene.
```

**Step 4: Run verification**

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

- tests pass
- discovery prints `extensions=1 errors=0`
- pack contains runtime package files only
- no whitespace errors

**Step 5: Commit**

```bash
git add README.md TODO.org docs/brainstorm/board-productivity.org extensions/live-decision-board.ts tests/live-decision-board-*.test.mjs
git commit -m "docs: document board cleanup workflow"
```

---

### Task 7: Final installed-cache verification

**Files:**
- No source changes expected

**Step 1: Inspect changed tests**

Run:

```bash
git diff --name-only HEAD~5..HEAD
```

Review every changed test file and ensure tests are durable behavior/regression tests, not exploratory implementation-detail tests.

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

- `npm ci` exits 0
- `npm test` exits 0
- pack dry-run includes `LICENSE`, `README.md`, `extensions/live-decision-board.ts`, `package.json`
- no diff-check errors
- worktree clean after commits

**Step 3: Push and update installed cache**

Run:

```bash
git push
pi update --extension git:github.com/Maverobot/pi-live-decision-board@main
node --input-type=module - <<'NODE'
import { discoverAndLoadExtensions } from 'file:///home/zheng/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
const source = '/home/zheng/.pi/agent/git/github.com/Maverobot/pi-live-decision-board';
const result = await discoverAndLoadExtensions([source], process.cwd(), '/tmp/pi-live-board-install-agent-dir');
const extension = result.extensions[0];
console.log(`extensions=${result.extensions.length} errors=${result.errors.length}`);
console.log(`commands=${[...(extension?.commands.keys() ?? [])].sort().join(',')}`);
if (result.errors.length || !extension?.commands.has('board-cleanup')) process.exit(1);
NODE
```

Expected:

- push succeeds
- update succeeds
- installed discovery includes `board-cleanup`

---

## Deferred follow-up plan items

Do not include these in the MVP unless the user explicitly expands scope:

- Subagent-assisted cleanup.
- First-class `archived` status.
- `/board-history`.
- Automatic cleanup prompts.
- Git/docs/session-message context gathering.
- Merge/duplicate rewriting beyond exact hints.
- Hard delete flows.
- Automatic harden/soften recommendations.
