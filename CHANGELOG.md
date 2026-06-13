# Changelog

All notable changes to this project are documented in this file.

Entries are inferred from conventional git commit messages. Regenerate with `npm run changelog`.

## 0.1.0 - 2026-06-13

### Added

- expose board history (39b16b7)
- add direct board archive tool (9a55ff1)
- add single goal board kind (1688faf)
- compact board widget layout (e478bcd)
- use single cleanup recommendation subagent (126ed1d)
- review cleanup recommendations in manager (bc684eb)
- fold subagent cleanup handoff (9786a35)
- trigger subagent board cleanup (73d0e27)
- clear board from manager (b50d76b)
- enforce accepted board items (fc4469e)
- apply confirmed board cleanup (ef1e139)
- add board cleanup review UI (5d38ee0)
- add board cleanup command shell (6c1571f)
- apply board cleanup plans (61c3262)
- add board cleanup recommendations (d399033)
- add board manager keyboard ui (7d2143b)
- add board widget toggle (c7d42a6)
- implement live decision board extension (1bdd225)

### Fixed

- clarify cleanup risk labels (abc5bdf)
- toggle selected board cleanup recommendation with space (7858491)
- harden cleanup recommendation imports (ef7dccc)
- clarify subagent cleanup docs (05c0be7)
- scope subagent cleanup prompt constraints (39aaf74)
- remove premature manager clear docs (4babb92)
- clarify manager-primary command docs (94c8b30)
- align enforced barrier test names (4bad00c)
- remove legacy enforcement wording (b9dbebd)
- align accepted enforcement wording (8d9d747)
- align cleanup with accepted enforcement (42a62d8)
- deprecate board strength controls (1f71ae4)
- hide legacy strength in board context (0ad6a25)
- hide widget board version (c2e7423)
- list cleanup confirmation items (7a4ed8a)
- clarify cleanup summary wording (5bbc636)
- keep cleanup keybindings visible (d6e5714)
- address board cleanup review findings (87ff738)
- keep board summary visible when collapsed (23d96e0)
- guard stale board dialogs by epoch (8b8cd4a)
- harden board review findings (fda7842)
- improve board widget readability (142680a)
- clarify board widget item keys (f97e234)
- group board widget sections (f0cca32)
- clarify board status counts (26cdba9)
- close final stale-guard bypasses (5005f8c)
- normalize hard-decision barriers (69b6420)
- harden decision board stale guards (c7c22c0)
- address live decision board review findings (02e1af0)

### Changed

- name enforced board barriers (d86fe98)

### Documentation

- mark package gallery todo complete (a83304c)
- document npm package install (68a0d92)
- todo: refresh task statuses and add follow-up board notes (f64c73b)
- define cleanup risk levels (077051d)
- clarify board edit versus supersede (b1f1ec2)
- plan cleanup recommendation manager (024ea56)
- align folded cleanup handoff plan (95641a9)
- document subagent board cleanup (8f34c7d)
- plan subagent cleanup trigger (b9b4524)
- make board manager primary (54f8b61)
- plan manager-primary board commands (1898025)
- document accepted board enforcement (254a448)
- plan accepted item enforcement (7a8e29a)
- clarify cleanup heuristic scope (bdadd0c)
- align cleanup brainstorm with mvp (b086317)
- document board cleanup workflow (fd8e17e)
- plan board cleanup mvp (000c741)
- clarify hard board constraints (61ce701)

### Maintenance

- ignore project worktrees (e1154c2)
