# pi-live-decision-board

A [Pi](https://pi.dev) package that adds a live, mutable assumptions and decisions board to Pi coding sessions.

The board is visible while the agent works, editable by the user, writable by the model through a tool, injected into future model context, and enforced before stale hard-decision mutations.

## Install

```bash
pi install git:github.com/Maverobot/pi-live-decision-board
```

Or test from a local checkout:

```bash
pi -e .
```

## Commands

| Command | Purpose |
| --- | --- |
| `/board` | Edit the board as markdown in Pi's multi-line editor |
| `/board-snapshot` | Show the active board context snapshot as a visible message |
| `/board-toggle` | Collapse or expand the persistent board body while keeping the summary line visible |
| `/board-manage` | Open a keyboard UI to select, edit, accept/reject, harden/soften, or supersede board items |
| `/assume <text>` | Add an accepted soft assumption |
| `/decide <text>` | Add an accepted soft decision |
| `/board-hard <id>` | Mark an item as an enforced hard constraint |
| `/board-soft <id>` | Mark an item as non-enforced soft guidance |
| `/board-reject <id>` | Reject an item |
| `/board-accept <id>` | Accept a proposed or rejected item |
| `/board-supersede <id> <new text>` | Supersede an item and create a replacement |
| `/board-cleanup` | Review active board items and archive obvious historical entries after confirmation |
| `/board-clear` | Clear the board after confirmation |

## Agent tool

The extension registers a `decision_board` tool with actions:

- `list`
- `add`
- `update`
- `set_status`
- `set_strength`
- `supersede`

Prompt guidance tells the model to record only assumptions and decisions that should affect future behavior, not routine implementation progress.

## How it works

- Board state is persisted in Pi session custom entries and restored from the active branch.
- The widget shows all active board items by default; `/board-toggle` collapses the body while keeping the summary line visible. Footer status is intentionally suppressed to avoid duplicate board summaries.
- `/board-snapshot` records the active context view (accepted/proposed items plus board rules) as a visible message.
- `/board-manage` is a TUI-only keyboard manager: `↑↓/j/k` select, `enter/e` edit, `a` accept, `r` reject/remove from the active board, `h` hard, `s` soft, `u` supersede, `q/esc` close.
- The `context` hook removes stale board-generated context and injects exactly one fresh board snapshot into provider requests.
- User/discussion-loop edits while the agent is busy queue a steering message so the next model turn sees the updated board.
- Hard accepted decisions block stale `write`, `edit`, and non-read-only `bash` calls until the fresh board has been injected into provider context.

## Markdown board format

`/board` edits this format:

```md
# Live Decision Board

- A1 | assumption | accepted | soft | Backend uses Node 22
- D1 | decision | accepted | hard | Build as extension first
```

Valid statuses: `proposed`, `accepted`, `rejected`, `superseded`.

Valid strengths: `soft`, `hard`.

## Soft vs hard items

Use `soft` for normal guidance: preferences, assumptions, and decisions the agent should consider but that should not block tool use.

Use `hard` only for enforced constraints:

- explicit user-stated constraints,
- safety-critical rules,
- architectural boundaries that must not be violated,
- decisions that should block stale mutating tools until the model has seen the latest board.

Do **not** use `hard` merely to mean "important". A hard accepted item participates in stale-mutation protection: if it changes, mutating tools such as `write`, `edit`, and unsafe `bash` are blocked until the fresh board has been injected into model context.

## Board hygiene

The board is the current working context, not a changelog. Add or keep board items only when they affect future behavior.

Good board items:

- "Use keyboard-first board management unless Pi documents mouse support."
- "Hard: never mutate files after a hard constraint changes until the fresh board is injected."
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

The tests exercise state helpers, command/tool registration, context injection, steering, markdown parsing, and stale hard-decision mutation blocking.

## License

MIT
