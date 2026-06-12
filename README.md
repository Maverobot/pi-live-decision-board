# pi-live-decision-board

A [Pi](https://pi.dev) package that adds a live, mutable assumptions and decisions board to Pi coding sessions.

The board is visible while the agent works, editable by the user, writable by the model through a tool, injected into future model context, and enforced before stale accepted-item mutations.

## Install

```bash
pi install git:github.com/Maverobot/pi-live-decision-board
```

Or test from a local checkout:

```bash
pi -e .
```

## Commands

### Primary commands

| Command | Purpose |
| --- | --- |
| `/board-manage` | Primary keyboard workflow for managing live board items |
| `/assume <text>` | Add an accepted assumption |
| `/decide <text>` | Add an accepted decision |
| `/board-snapshot` | Show the active board context snapshot as a visible message |
| `/board-toggle` | Collapse or expand the persistent board body while keeping the summary line visible |

### Power-user / compatibility commands

| Command | Purpose |
| --- | --- |
| `/board` | Power-user editor for the live board markdown |
| `/board-reject <id>` | Power-user fallback to reject an item |
| `/board-accept <id>` | Power-user fallback to accept a proposed or rejected item |
| `/board-supersede <id> <new text>` | Power-user fallback to supersede an item |
| `/board-cleanup` | Review active board items and archive obvious historical entries after confirmation |
| `/board-clear` | Power-user fallback to clear the board after confirmation |
| `/board-hard <id>` | Deprecated compatibility no-op: accepted-item enforcement now replaces hard/soft commands |
| `/board-soft <id>` | Deprecated compatibility no-op: accepted-item enforcement now replaces hard/soft commands |

## Agent tool

The extension registers a `decision_board` tool with actions:

- `list`
- `add`
- `update`
- `set_status`
- `set_strength` (compatibility no-op; accepted/proposed status controls enforcement)
- `supersede`

Prompt guidance tells the model to record only assumptions and decisions that should affect future behavior, not routine implementation progress.

## How it works

- Board state is persisted in Pi session custom entries and restored from the active branch.
- The widget shows all active board items by default; `/board-toggle` collapses the body while keeping the summary line visible. Footer status is intentionally suppressed to avoid duplicate board summaries.
- `/board-snapshot` records the active context view (accepted/proposed items plus board rules) as a visible message.
- `/board-manage` is a TUI-only keyboard manager: `↑↓/j/k` select, `enter/e` edit, `a` accept, `r` reject/remove from the active board, `u` supersede, `q/esc` close.
- The `context` hook removes stale board-generated context and injects exactly one fresh board snapshot into provider requests.
- User/discussion-loop edits while the agent is busy queue a steering message so the next model turn sees the updated board.
- Accepted items are enforced in context and block stale `write`, `edit`, and non-read-only `bash` calls until the fresh board has been injected.

## Markdown board format

`/board` edits this format:

```md
# Live Decision Board

- A1 | assumption | accepted | soft | Backend uses Node 22
- D1 | decision | accepted | hard | Build as a Pi extension first
```

Valid statuses: `proposed`, `accepted`, `rejected`, `superseded`.

`strength` is legacy compatibility data (`soft`/`hard`) and is not a product semantic for enforcement.

## Accepted vs proposed items

Accepted items are enforced as current context. The agent should treat every accepted assumption or decision as relevant before mutating files.

Proposed items are visible drafts. Use them for uncertain assumptions or decisions that need review before they become enforced.

The legacy `soft`/`hard` strength field may appear in older session data and markdown exports. It is retained for compatibility only and does not affect enforcement.

## Board hygiene

The board is the current working context, not a changelog. Add or keep board items only when they affect future behavior.

Good board items:

- "Use keyboard-first board management unless Pi documents mouse support."
- "Accepted items should block stale mutations until the next board injection."
- "Assumption: keep defaults stable until the user requests a cleanup policy change."

Bad active board items:

- "Applied Round 5 review fixes."
- "Ran npm test."
- "Renamed `/board-show` to `/board-snapshot`."

Use `/board-cleanup` to review active items and archive obvious historical entries. Archive removes an item from active context while retaining it in board history.

## Development

This repository is a Pi package. Pi discovers the extension through the `pi.extensions` manifest in `package.json`.

Run tests:

```bash
npm install
npm test
```

The tests exercise state helpers, command/tool registration, context injection, steering, markdown parsing, and stale accepted-item mutation blocking.

## License

MIT
