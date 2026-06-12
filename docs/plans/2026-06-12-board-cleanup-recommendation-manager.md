# Board Cleanup Recommendation Manager Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Let the current agent pass subagent cleanup recommendations into a board-manager-style review UI where suggested archive/supersede actions are preselected and the user can toggle/apply them without `ask_user`.

**Architecture:** Keep `/board-cleanup-subagent` as the handoff that asks the current agent to launch read-only subagents. Add a `decision_board` tool action that accepts recommendation objects from the current agent, normalizes and freshness-validates them against current board items, then opens the existing `BoardCleanupComponent` with imported archive/supersede suggestions preselected. Reuse the existing cleanup confirmation, stale epoch guard, and `applyBoardCleanup()` freshness checks.

**Tech Stack:** TypeScript Pi extension API (`decision_board` tool, `ctx.ui.custom`, TypeBox schemas), existing cleanup recommendation/component/apply helpers, Node test scripts.

---

## Product requirements

- Add a tool-mediated flow, not another raw `ask_user` confirmation path.
- The current/parent agent can call `decision_board` with action `review_cleanup` and a list of recommendations from subagents.
- The review UI should reuse the cleanup/manager-style keyboard surface: visible item IDs, action labels, reasons, selected checkboxes, space toggles, enter applies.
- Imported archive/supersede recommendations should be selected by default, even when `requiresExplicitConfirmation: true`; the existing final confirmation still gates mutation.
- Imported keep/needs_user_review recommendations should be visible but unselected.
- Stale or malformed recommendations should be skipped before opening/applying, based on id/version/text/status/strength.
- If no fresh recommendations are actionable, do not mutate the board; notify/report why.
- Preserve local `/board-cleanup` behavior unless explicitly required for shared component support.
- Preserve board schema, markdown, accepted-item enforcement, item ID display, and existing command names.

## Acceptance criteria

- `decision_board` tool schema includes `review_cleanup` and a `recommendations` array matching the subagent recommendation shape.
- `decision_board.review_cleanup` requires TUI/UI mode; in non-TUI mode it reports that interactive review is required and does not mutate.
- Fresh imported archive/supersede recommendations open the cleanup review UI preselected and can be applied through existing confirmation.
- User can toggle an imported high-risk/explicit-confirmation archive/supersede recommendation before apply.
- Stale recommendation objects are skipped and reported; fresh ones can still be reviewed.
- Existing local `/board-cleanup` tests continue to pass.
- README and brainstorm docs explain that the current agent should feed subagent recommendations into `decision_board.review_cleanup` for user review/apply.

---

### Task 1: TDD coverage for imported recommendation review

**Files:**
- Modify: `tests/live-decision-board-extension.test.mjs`

**Steps:**
1. Add assertions that `decision_board` prompt guidance mentions `review_cleanup` for subagent cleanup recommendations.
2. Add a fresh extension-instance test that creates two board decisions, calls `decision_board.execute()` with `action: "review_cleanup"` and two recommendations:
   - archive D1 with `requiresExplicitConfirmation: true`, `riskLevel: "high"`, expected selected by default and toggleable in the UI.
   - keep D2, expected unselected.
3. Mock `ctx.ui.custom` to render the cleanup component, verify D1 is selected in the initial render, press space to toggle it off/on, then enter.
4. Mock `ctx.ui.confirm` to accept and assert the board archives D1 only after confirmation.
5. Add a stale-recommendation test where one recommendation has a mismatched version/text and is skipped/reported while a fresh recommendation remains reviewable.
6. Run `node tests/live-decision-board-extension.test.mjs` and verify it fails for missing `review_cleanup` support.

### Task 2: Implement `review_cleanup` action and shared cleanup review runner

**Files:**
- Modify: `extensions/live-decision-board.ts`

**Steps:**
1. Extend the `decision_board` schema/action enum with `review_cleanup` and optional `recommendations` array fields: id, itemVersion, observedText, observedStatus, observedStrength, action, replacementText, confidence, riskLevel, requiresExplicitConfirmation, reason, evidence, selected.
2. Add prompt guidance telling the current agent to call `decision_board` `review_cleanup` after subagent-assisted cleanup recommendations, instead of using `ask_user`.
3. Add normalization helper that validates recommendation freshness against current board items and returns `{ recommendations, skipped }`.
4. For fresh imported recommendations, default `selected` to true for `archive`/`supersede`, false for `keep`/`needs_user_review`; downgrade invalid supersede-without-replacement to unselected `needs_user_review`.
5. Allow imported actionable recommendations to be toggled regardless of risk/explicit-confirmation while keeping local `/board-cleanup` toggle restrictions if needed.
6. Refactor `cleanupBoard()` to call a shared `reviewBoardCleanupRecommendations()` runner and use it from `review_cleanup`.
7. Ensure `review_cleanup` returns useful text/details including applied/skipped counts, and never mutates in non-TUI/no-UI mode.
8. Run focused and full tests.

### Task 3: Documentation, review, install

**Files:**
- Modify: `README.md`
- Modify: `docs/brainstorm/board-productivity.org`
- Modify: `docs/plans/2026-06-12-board-cleanup-subagent-trigger.md` if needed

**Steps:**
1. Document that `/board-cleanup-subagent` hands off to the current agent, which should call `decision_board.review_cleanup` with read-only subagent recommendations to open the manager-style review UI.
2. Run `npm ci`, `npm test`, extension discovery, `npm pack --dry-run --json`, `git diff --check`.
3. Request spec and quality review.
4. Fix blockers with TDD, commit, push to `main`, run `pi update --extension git:github.com/Maverobot/pi-live-decision-board@main`, and verify installed discovery includes `board-cleanup-subagent` and the updated tool schema loads.
