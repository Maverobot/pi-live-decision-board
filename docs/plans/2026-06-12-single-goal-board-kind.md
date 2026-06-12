# Single Goal Board Kind Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Keep Decisions as durable choices while adding exactly one current Goal as a third board item kind.

**Architecture:** Extend the existing board item model from Assumptions/Decisions to Goal/Assumptions/Decisions while preserving existing session data. Goals use `G#` ids, render in a singular Goal section, and only one active goal is kept at a time by superseding prior active goals when a new goal is added.

**Tech Stack:** TypeScript Pi extension, TypeBox tool schema, Node test runner via `node tests/*.mjs` and `npm test`.

---

### Task 1: State/model and formatting

**Files:**
- Modify: `extensions/live-decision-board.ts`
- Test: `tests/live-decision-board-state.test.mjs`
- Test: `tests/live-decision-board-extension.test.mjs`

**Steps:**
1. Add failing tests for `goal` kind, `G#` ids, one active goal, prompt/widget Goal section, and existing assumptions/decisions compatibility.
2. Run focused tests and confirm failures.
3. Extend `BoardKind`, `BoardState`, `createEmptyBoard`, state normalization, id validation, markdown parsing, `formatBoardForPrompt`, `formatBoardStatus`, and widget formatting.
4. Ensure adding a new goal supersedes any active existing goal.
5. Run focused tests and `npm test`.

### Task 2: Commands, tool schema, docs

**Files:**
- Modify: `extensions/live-decision-board.ts`
- Modify: `README.md`
- Modify: `docs/brainstorm/board-productivity.org`
- Test: `tests/live-decision-board-extension.test.mjs`

**Steps:**
1. Add failing tests for `/goal <text>` command registration/behavior and `decision_board add kind: goal`.
2. Run focused tests and confirm failures.
3. Add `/goal` quick-capture command and include `goal` in tool/schema guidance.
4. Document that Decisions remain for durable choices, Goal is singular current objective, Assumptions capture uncertain context.
5. Run focused tests, `npm test`, and `git diff --check`.

### Task 3: Finish TODO item

**Files:**
- Modify: `TODO.org`

**Steps:**
1. Mark the Decisions vs Goal/Assumptions TODO item complete.
2. Run `npm test` and `git diff --check`.
3. Commit implementation with `feat: add single goal board kind`.
