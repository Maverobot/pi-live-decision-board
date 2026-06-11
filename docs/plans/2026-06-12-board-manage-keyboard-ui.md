# Board Manage Keyboard UI Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Add a keyboard-driven `/board-manage` command for selecting and updating live board items without relying on mouse support.

**Architecture:** Keep the persistent board widget passive. Add a focused custom TUI component that returns an action (`edit`, `accept`, `reject`, `harden`, `soften`, `supersede`, `close`) to the command handler. The command handler performs existing board mutations through the same safe commit path as slash commands, preserving stale epoch guards and board persistence semantics.

**Tech Stack:** Pi extension API, `ctx.ui.custom()`, `@earendil-works/pi-tui` keyboard helpers/components, current board state helpers/tests.

---

### Task 1: Register `/board-manage` and cover command surface

**Files:**
- Modify: `extensions/live-decision-board.ts`
- Test: `tests/live-decision-board-extension.test.mjs`

**Step 1: Write failing test**
- Assert `board-manage` is registered.
- Assert it rejects non-TUI mode with a notification.

**Step 2: Run test to verify failure**
- Run: `node tests/live-decision-board-extension.test.mjs`
- Expected: missing `board-manage` assertion fails.

**Step 3: Implement minimal command shell**
- Register `/board-manage`.
- Guard with `ctx.mode === "tui"`; otherwise notify.

**Step 4: Verify**
- Run: `npm test`.

### Task 2: Add selectable manager component

**Files:**
- Modify: `extensions/live-decision-board.ts`
- Test: `tests/live-decision-board-extension.test.mjs`

**Step 1: Write failing test**
- Use a fake `ctx.ui.custom()` to instantiate the manager.
- Render should show title, active/inactive counts, item ids/text, and keyboard help.
- Simulate down/up and ensure selected item changes in rendered output.

**Step 2: Run test to verify failure**
- Run: `node tests/live-decision-board-extension.test.mjs`.

**Step 3: Implement component**
- Create `BoardManagerComponent` with `render`, `handleInput`, `invalidate`.
- Use `matchesKey`, `Key`, and `truncateToWidth`.
- Keep lines within width.

**Step 4: Verify**
- Run: `npm test`.

### Task 3: Wire item actions

**Files:**
- Modify: `extensions/live-decision-board.ts`
- Test: `tests/live-decision-board-extension.test.mjs`

**Step 1: Write failing tests**
- Simulate keys: `h` hardens, `s` softens, `a` accepts, `r` rejects, `e` edits text via editor, `u` supersedes via editor/input, `q` exits.
- Assert each real mutation persists once and updates board state.
- Assert no-op actions do not persist duplicate entries.

**Step 2: Run test to verify failure**
- Run: `node tests/live-decision-board-extension.test.mjs`.

**Step 3: Implement command loop**
- `ctx.ui.custom()` returns a manager action.
- Command handler applies the action with `safeApplyBoard` and reopens manager until close/cancel.
- Use existing `updateBoardItem` and `supersedeBoardItem` helpers.

**Step 4: Verify**
- Run: `npm test`.

### Task 4: Docs and final verification

**Files:**
- Modify: `README.md`
- Optional: `TODO.org`

**Step 1: Update docs**
- Add `/board-manage` to command table.
- Explain keyboard shortcuts and that reject is the non-destructive removal path.

**Step 2: Full verification**
- Run: `npm ci`.
- Run: `npm test`.
- Run: local Pi discovery script.
- Run: `npm pack --dry-run --json`.
- Run: `git diff --check`.

**Step 3: Commit**
- Commit with `feat: add board manager keyboard ui`.
