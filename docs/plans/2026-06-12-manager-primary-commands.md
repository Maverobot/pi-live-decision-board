# Manager-Primary Board Commands Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Make `/board-manage` the primary user workflow for board item actions while keeping `/assume` and `/decide` as quick capture commands and preserving item IDs everywhere they are currently useful.

**Architecture:** Keep the board state model, item IDs, markdown format, agent tool, and existing slash commands compatible. Add the one missing manager workflow needed to replace `/board-clear` as the primary clear path, then reframe item-targeted slash commands as compatibility/power-user fallbacks in docs and command help. Do not remove any registered command in this pass.

**Tech Stack:** TypeScript Pi extension API, `@earendil-works/pi-tui` custom components, Node test scripts (`tests/live-decision-board-extension.test.mjs`, `tests/live-decision-board-state.test.mjs`), README docs.

---

## Product decisions

- `/board-manage` is the primary user mutation UI for existing board items.
- `/assume` and `/decide` remain primary quick-capture commands for adding accepted assumptions and decisions.
- Item-targeted slash commands (`/board-accept`, `/board-reject`, `/board-supersede`) remain registered as compatibility/power-user fallbacks but should be de-emphasized in docs/help.
- `/board-clear` remains registered as a power-user fallback, but `/board-manage` should gain a clear-board action so clearing has a primary TUI path.
- `/board`, the raw markdown editor, remains registered as a power-user escape hatch.
- `/board-hard`, `/board-soft`, and `decision_board.set_strength` remain deprecated compatibility no-ops as already implemented.
- Board item IDs stay visible in manager, widget, snapshots, cleanup confirmations, and markdown for stable references, auditability, cleanup recommendations, supersede links, and compatibility.

## Acceptance criteria

- `/board-manage` help and docs present it as the primary item-action UI.
- `/board-manage` supports clearing the board with explicit confirmation and stale-epoch protection.
- `/assume` and `/decide` remain documented as primary quick add/capture commands.
- Item-targeted slash commands remain registered and functional, but command descriptions and README classify them as compatibility/power-user fallbacks that prefer `/board-manage`.
- Item IDs remain visible in manager rows, widget output, snapshots, cleanup confirmations, and markdown.
- No changes to accepted-item enforcement, cleanup recommendation semantics, agent tool schema, or persisted board format.
- Existing tests plus new regression tests pass.
- Package discovery and installed-cache verification pass before completion.

---

### Task 1: Reframe command docs and command help around manager-primary workflows

**Files:**
- Modify: `README.md`
- Modify: `extensions/live-decision-board.ts`
- Test: `tests/live-decision-board-extension.test.mjs`

**Step 1: Write failing command-help tests**

In `tests/live-decision-board-extension.test.mjs`, near the existing command registration/description assertions, add assertions like:

```js
assert.match(commands.get("board-manage").description, /primary/i, "board-manage should be described as the primary item-action UI");
assert.match(commands.get("board-reject").description, /power-user|compatibility/i, "board-reject should be documented as a fallback command");
assert.match(commands.get("board-accept").description, /power-user|compatibility/i, "board-accept should be documented as a fallback command");
assert.match(commands.get("board-supersede").description, /power-user|compatibility/i, "board-supersede should be documented as a fallback command");
assert.match(commands.get("board-clear").description, /power-user|fallback/i, "board-clear should be documented as a fallback command");
```

Keep the existing assertions that IDs are visible in manager rows and widget output.

**Step 2: Run tests to verify failure**

Run:

```bash
node tests/live-decision-board-extension.test.mjs
```

Expected: FAIL because descriptions still present all commands as peer commands.

**Step 3: Update command descriptions**

In `extensions/live-decision-board.ts`:

- Change `/board-manage` description to something like:

```ts
description: "Primary UI for live board item actions: edit, accept/reject, supersede, or clear",
```

- Change item-targeted command descriptions to explicit fallback wording:

```ts
description: "Power-user fallback: reject a board item by id; prefer /board-manage",
description: "Power-user fallback: accept a board item by id; prefer /board-manage",
description: "Power-user fallback: supersede a board item by id; prefer /board-manage",
```

- Change `/board-clear` description to:

```ts
description: "Power-user fallback: clear the live board after confirmation; prefer /board-manage",
```

- Optionally change `/board` description to:

```ts
description: "Power-user editor for the live board markdown",
```

Do not change handlers or command registration names in this task.

**Step 4: Update README command sections**

Restructure `README.md` command documentation into:

```md
## Commands

### Primary commands

| Command | Purpose |
| --- | --- |
| `/board-manage` | Primary keyboard UI to select board items and edit, accept/reject, supersede, or clear with confirmation |
| `/assume <text>` | Quick capture: add an accepted assumption |
| `/decide <text>` | Quick capture: add an accepted decision |
| `/board-cleanup` | Review active board items and archive obvious historical entries after confirmation |
| `/board-snapshot` | Show the active board context snapshot as a visible message |
| `/board-toggle` | Collapse or expand the persistent board body while keeping the summary line visible |

### Power-user and compatibility commands

| Command | Purpose |
| --- | --- |
| `/board` | Power-user markdown editor for the board |
| `/board-reject <id>` | Power-user fallback for rejecting an item by id; prefer `/board-manage` |
| `/board-accept <id>` | Power-user fallback for accepting an item by id; prefer `/board-manage` |
| `/board-supersede <id> <new text>` | Power-user fallback for superseding an item by id; prefer `/board-manage` |
| `/board-clear` | Power-user fallback for clearing the board after confirmation; prefer `/board-manage` |
| `/board-hard <id>` | Deprecated compatibility no-op: accepted-item enforcement now replaces hard/soft commands |
| `/board-soft <id>` | Deprecated compatibility no-op: accepted-item enforcement now replaces hard/soft commands |
```

Also update “How it works” to say `/board-manage` is the primary TUI mutation UI, while item-targeted commands are kept for compatibility and power users.

**Step 5: Run tests**

Run:

```bash
node tests/live-decision-board-extension.test.mjs
npm test
```

Expected: all tests pass.

**Step 6: Commit**

```bash
git add README.md extensions/live-decision-board.ts tests/live-decision-board-extension.test.mjs
git commit -m "docs: make board manager primary"
```

---

### Task 2: Add clear-board action to `/board-manage`

**Files:**
- Modify: `extensions/live-decision-board.ts`
- Test: `tests/live-decision-board-extension.test.mjs`

**Step 1: Write failing manager clear tests**

Add tests near the existing board-manager tests in `tests/live-decision-board-extension.test.mjs`.

Test the help text:

```js
assert.match(rendered[0], /c clear/i, "manager help should expose clear-board action");
```

Add a new TUI test block with queued key `"c"`:

```js
{
	const localCommands = new Map();
	const localEvents = new Map();
	const localEntries = [];
	let confirmTitle = "";
	let confirmMessage = "";
	let latestNotification = "";
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
			notify: (message) => { latestNotification = message; },
			confirm: async (title, message) => {
				confirmTitle = title;
				confirmMessage = message;
				return true;
			},
			editor: async (_title, initial) => initial,
			custom: async (factory) => {
				let result;
				const component = factory({ requestRender: () => {} }, testTheme, {}, (value) => { result = value; });
				component.handleInput("c");
				return result;
			},
		},
	};

	extension({
		on(eventName, callback) { localEvents.set(eventName, callback); },
		registerCommand(name, def) { localCommands.set(name, def); },
		registerTool() {},
		appendEntry(customType, data) { localEntries.push({ type: "custom", customType, data }); },
		sendMessage() {},
	});

	await localEvents.get("session_start")({}, localCtx);
	await localCommands.get("assume").handler("Manager clear assumption", localCtx);
	await localCommands.get("decide").handler("Manager clear decision", localCtx);
	const entriesBeforeClear = localEntries.length;
	await localCommands.get("board-manage").handler("", localCtx);
	assert.equal(confirmTitle, "Clear Live Decision Board?");
	assert.match(confirmMessage, /clears assumptions and decisions/i);
	assert.equal(localEntries.length, entriesBeforeClear + 1, "manager clear persists exactly once after confirmation");
	assert.deepEqual(localEntries.at(-1).data.items, [], "manager clear removes all board items");
	assert.match(latestNotification, /Cleared board/i);
}
```

Add a stale-confirmation test if not too large: open manager, return `clear`, mutate the board while confirm is open, then resolve confirmation and assert no clear persisted plus stale warning. If this is too much duplication, at minimum ensure the implementation reuses a clear helper that already has stale confirmation coverage from `/board-clear` tests.

**Step 2: Run tests to verify failure**

Run:

```bash
node tests/live-decision-board-extension.test.mjs
```

Expected: FAIL because manager help has no `c clear` and `c` is ignored.

**Step 3: Implement manager clear action**

In `extensions/live-decision-board.ts`:

1. Extend `BoardManagerAction`:

```ts
type BoardManagerAction =
	| { type: "close" }
	| { type: "clear" }
	| { type: "edit" | "accept" | "reject" | "supersede"; id: string };
```

2. In `BoardManagerComponent.handleInput()`, handle `c` before requiring a selected item:

```ts
if (data === "c") {
	this.done({ type: "clear" });
	return;
}
```

3. Update the help line:

```ts
"↑↓/j/k select • enter/e edit • a accept • r reject/remove • u supersede • c clear • q/esc close"
```

4. In `applyBoardManagerAction()`, handle clear before reading `action.id`:

```ts
if (action.type === "clear") {
	await confirmAndClearBoard(ctx, "Live Decision Board changed while clear confirmation was open; rerun /board-manage on the latest board.");
	return;
}
```

5. Extract `/board-clear` confirmation logic into a reusable helper, e.g.:

```ts
async function confirmAndClearBoard(ctx: ExtensionContext, staleMessage: string): Promise<void> {
	const baseEpoch = boardEpoch;
	if (ctx.hasUI) {
		const confirmed = await ctx.ui.confirm(
			"Clear Live Decision Board?",
			"This clears assumptions and decisions for this branch.",
		);
		if (!confirmed) return;
		if (boardEpoch !== baseEpoch) {
			ctx.ui.notify(staleMessage, "warning");
			return;
		}
	}
	safeApplyBoard(ctx, "Cleared board", () => clearBoard(board));
}
```

Use that helper from both `/board-clear` and manager clear, with command-specific stale messages.

**Step 4: Run tests**

Run:

```bash
node tests/live-decision-board-extension.test.mjs
npm test
```

Expected: all tests pass.

**Step 5: Commit**

```bash
git add extensions/live-decision-board.ts tests/live-decision-board-extension.test.mjs
git commit -m "feat: clear board from manager"
```

---

### Task 3: Final docs/compatibility review and package verification

**Files:**
- Modify only if review finds wording drift: `README.md`, `extensions/live-decision-board.ts`, tests.

**Step 1: Inspect command surface**

Run:

```bash
rg -n "board-(accept|reject|supersede|clear)|board-manage|quick capture|power-user|compatibility" README.md extensions/live-decision-board.ts tests/live-decision-board-extension.test.mjs
```

Verify:

- `/board-manage` is presented as primary.
- `/assume` and `/decide` are quick capture.
- Item-targeted slash commands are compatibility/power-user fallbacks.
- IDs are still visible in manager/widget/snapshot/cleanup docs/tests.
- No command was accidentally removed.

**Step 2: Run full verification**

Run:

```bash
npm ci
npm test
node - <<'NODE'
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverAndLoadExtensions } from '@earendil-works/pi-coding-agent';
const agentDir = await mkdtemp(join(tmpdir(), 'pi-live-decision-board-agent-'));
const result = await discoverAndLoadExtensions(['.'], process.cwd(), agentDir);
const extension = result.extensions[0];
console.log(`extensions=${result.extensions.length} errors=${result.errors.length}`);
console.log(`commands=${[...(extension?.commands.keys() ?? [])].sort().join(',')}`);
if (result.errors.length || !extension?.commands.has('board-manage')) process.exit(1);
NODE
npm pack --dry-run --json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const p=JSON.parse(s)[0]; console.log(`${p.name}@${p.version} entries=${p.entryCount} size=${p.size}`); console.log(p.files.map(f=>f.path).join("\n"));})'
git diff --check
git status --short
```

Expected:

- `npm ci` exits 0.
- `npm test` exits 0.
- discovery prints `extensions=1 errors=0` and includes `board-manage`.
- pack dry-run includes `LICENSE`, `README.md`, `extensions/live-decision-board.ts`, `package.json`.
- no whitespace errors.
- worktree is clean after commits.

**Step 3: Request final review**

Ask reviewers to inspect `origin/main...HEAD` for:

- manager-primary UX consistency,
- compatibility safety,
- clear-board confirmation/stale safety,
- command docs/help clarity,
- test hygiene.

Fix any blockers with TDD and review again.

**Step 4: Push and update installed cache**

After reviews pass:

```bash
git push origin HEAD:main
pi update --extension git:github.com/Maverobot/pi-live-decision-board@main
node --input-type=module - <<'NODE'
import { discoverAndLoadExtensions } from 'file:///home/zheng/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
const source = '/home/zheng/.pi/agent/git/github.com/Maverobot/pi-live-decision-board';
const result = await discoverAndLoadExtensions([source], process.cwd(), '/tmp/pi-live-board-install-agent-dir-manager-primary');
const extension = result.extensions[0];
console.log(`extensions=${result.extensions.length} errors=${result.errors.length}`);
console.log(`commands=${[...(extension?.commands.keys() ?? [])].sort().join(',')}`);
if (result.errors.length || !extension?.commands.has('board-manage')) process.exit(1);
NODE
```

Expected:

- push succeeds,
- update succeeds,
- installed discovery includes the extension and expected commands.

**Step 5: Final report**

Report:

- commits,
- tests/verification evidence,
- installed discovery output,
- compatibility notes,
- residual risks or follow-ups.

---

## Deferred follow-up items

Do not include these unless explicitly requested:

- Removing item-targeted slash commands entirely.
- Hiding item IDs from manager, widget, snapshots, cleanup confirmations, or markdown.
- Removing `/board`, `/board-clear`, `/board-accept`, `/board-reject`, or `/board-supersede` registrations.
- Removing or migrating legacy `strength` data.
- Changing agent `decision_board` tool action names.
- Adding mouse support to the manager.
- Adding manager item-creation forms; `/assume` and `/decide` remain quick capture for now.
