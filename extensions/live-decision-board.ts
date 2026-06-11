/**
 * Live Decision Board
 *
 * A Pi extension that keeps a visible, editable assumptions/decisions board,
 * injects the latest board into model context, and blocks stale hard-decision
 * mutations until the board has been injected into a provider request.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export type BoardKind = "assumption" | "decision";
export type BoardStatus = "proposed" | "accepted" | "rejected" | "superseded";
export type BoardStrength = "soft" | "hard";
export type BoardSource = "user" | "agent" | "discussion-loop";

export interface BoardItem {
	id: string;
	kind: BoardKind;
	text: string;
	status: BoardStatus;
	strength: BoardStrength;
	source: BoardSource;
	version: number;
	createdAt: number;
	updatedAt: number;
	supersedes?: string;
}

export interface BoardState {
	version: number;
	nextAssumptionId: number;
	nextDecisionId: number;
	items: BoardItem[];
}

export interface NewBoardItem {
	kind: BoardKind;
	text: string;
	status?: BoardStatus;
	strength?: BoardStrength;
	source?: BoardSource;
	supersedes?: string;
}

type BoardPatch = Partial<Pick<BoardItem, "text" | "status" | "strength" | "source" | "supersedes">>;

type SessionEntryLike = { type: string; customType?: string; data?: unknown };
type MessageLike = { role?: string; customType?: string; content?: unknown; display?: boolean; timestamp?: number };

const CUSTOM_TYPE = "live-decision-board";
const CONTEXT_CUSTOM_TYPE = "live-decision-board-context";
const VISIBLE_CUSTOM_TYPE = "live-decision-board-visible";
const DELTA_CUSTOM_TYPE = "live-decision-board-delta";
const BOARD_CONTEXT_TYPES = new Set([CONTEXT_CUSTOM_TYPE, VISIBLE_CUSTOM_TYPE, DELTA_CUSTOM_TYPE]);

const BOARD_ITEM_STATUSES: BoardStatus[] = ["proposed", "accepted", "rejected", "superseded"];
const BOARD_ITEM_STRENGTHS: BoardStrength[] = ["soft", "hard"];
const BOARD_ITEM_KINDS: BoardKind[] = ["assumption", "decision"];

export function createEmptyBoard(): BoardState {
	return { version: 0, nextAssumptionId: 1, nextDecisionId: 1, items: [] };
}

export function clearBoard(board: BoardState): BoardState {
	return { version: board.version + 1, nextAssumptionId: 1, nextDecisionId: 1, items: [] };
}

function now(): number {
	return Date.now();
}

export function addBoardItem(board: BoardState, input: NewBoardItem): BoardState {
	const text = input.text.trim();
	if (!text) throw new Error("Board item text is required");

	const nextVersion = board.version + 1;
	const id = input.kind === "assumption" ? `A${board.nextAssumptionId}` : `D${board.nextDecisionId}`;
	const timestamp = now();
	const item: BoardItem = {
		id,
		kind: input.kind,
		text,
		status: input.status ?? "accepted",
		strength: input.strength ?? "soft",
		source: input.source ?? "user",
		version: nextVersion,
		createdAt: timestamp,
		updatedAt: timestamp,
		supersedes: input.supersedes,
	};

	return {
		version: nextVersion,
		nextAssumptionId: input.kind === "assumption" ? board.nextAssumptionId + 1 : board.nextAssumptionId,
		nextDecisionId: input.kind === "decision" ? board.nextDecisionId + 1 : board.nextDecisionId,
		items: [...board.items, item],
	};
}

export function updateBoardItem(board: BoardState, id: string, patch: BoardPatch): BoardState {
	const normalizedId = id.trim();
	const existing = board.items.find((item) => item.id === normalizedId);
	if (!existing) throw new Error(`Board item not found: ${normalizedId}`);

	const cleanPatch = Object.fromEntries(
		Object.entries(patch).filter(([, value]) => value !== undefined),
	) as BoardPatch;
	if (Object.keys(cleanPatch).length === 0) return board;

	const nextVersion = board.version + 1;
	return {
		...board,
		version: nextVersion,
		items: board.items.map((item) => {
			if (item.id !== normalizedId) return item;
			const text = cleanPatch.text?.trim() ?? item.text;
			if (!text) throw new Error("Board item text is required");
			return { ...item, ...cleanPatch, text, version: nextVersion, updatedAt: now() };
		}),
	};
}

export function supersedeBoardItem(
	board: BoardState,
	id: string,
	replacementText: string,
	source: BoardSource = "user",
): BoardState {
	const normalizedId = id.trim();
	const existing = board.items.find((item) => item.id === normalizedId);
	if (!existing) throw new Error(`Board item not found: ${normalizedId}`);
	const superseded = updateBoardItem(board, normalizedId, { status: "superseded" });
	return addBoardItem(superseded, {
		kind: existing.kind,
		text: replacementText,
		status: "accepted",
		strength: existing.strength,
		source,
		supersedes: normalizedId,
	});
}

export function formatBoardForPrompt(board: BoardState): string {
	const active = board.items.filter((item) => item.status === "accepted" || item.status === "proposed");
	const assumptions = active.filter((item) => item.kind === "assumption");
	const decisions = active.filter((item) => item.kind === "decision");
	const lines = [`## Live Assumptions & Decisions — version ${board.version}`, ""];
	lines.push("Rules:");
	lines.push("- Treat hard accepted decisions as constraints before mutating files.");
	lines.push("- If current work conflicts with this board, reconcile before continuing.");
	lines.push("- Record meaningful new assumptions or decisions with the decision_board tool.", "");
	lines.push("Assumptions:");
	lines.push(...(assumptions.length ? assumptions.map(formatPromptItem) : ["- none"]));
	lines.push("", "Decisions:");
	lines.push(...(decisions.length ? decisions.map(formatPromptItem) : ["- none"]));
	return lines.join("\n");
}

function formatPromptItem(item: BoardItem): string {
	return `- ${item.id}: ${item.text} [${item.status}, ${item.strength}, source:${item.source}, v${item.version}]`;
}

export function formatBoardStatus(board: BoardState): string {
	const assumptions = board.items.filter((item) => item.kind === "assumption").length;
	const decisions = board.items.filter((item) => item.kind === "decision").length;
	const hardCount = board.items.filter((item) => item.status === "accepted" && item.strength === "hard").length;
	return `Board v${board.version} • A${assumptions} D${decisions} • hard:${hardCount}`;
}

export function formatBoardWidget(board: BoardState, options: { maxItems?: number } = {}): string[] {
	const maxItems = options.maxItems ?? 8;
	const active = board.items
		.filter((item) => item.status === "accepted" || item.status === "proposed")
		.sort((a, b) => (a.strength === b.strength ? b.version - a.version : a.strength === "hard" ? -1 : 1))
		.slice(0, maxItems);

	const lines = [formatBoardStatus(board)];
	for (const item of active) {
		const marker = item.strength === "hard" ? "!" : "•";
		lines.push(`${marker} ${item.id} ${item.text}`);
	}
	return lines;
}

export function hasUninjectedHardChanges(board: BoardState, injectedVersion: number): boolean {
	return board.items.some(
		(item) => item.strength === "hard" && item.status === "accepted" && item.version > injectedVersion,
	);
}

export function restoreBoardFromEntries(entries: SessionEntryLike[]): BoardState {
	const latest = entries.filter((entry) => entry.type === "custom" && entry.customType === CUSTOM_TYPE).at(-1);
	return isBoardState(latest?.data) ? latest.data : createEmptyBoard();
}

function isBoardState(value: unknown): value is BoardState {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<BoardState>;
	return (
		typeof candidate.version === "number" &&
		typeof candidate.nextAssumptionId === "number" &&
		typeof candidate.nextDecisionId === "number" &&
		Array.isArray(candidate.items)
	);
}

export function serializeBoardMarkdown(board: BoardState): string {
	const lines = ["# Live Decision Board", ""];
	if (board.items.length === 0) {
		lines.push("_No assumptions or decisions yet._");
		return `${lines.join("\n")}\n`;
	}

	for (const item of board.items) {
		lines.push(`- ${item.id} | ${item.kind} | ${item.status} | ${item.strength} | ${item.text}`);
	}
	return `${lines.join("\n")}\n`;
}

export function parseBoardMarkdown(markdown: string, previousBoard: BoardState): BoardState {
	const previousById = new Map(previousBoard.items.map((item) => [item.id, item]));
	const nextVersion = previousBoard.version + 1;
	const timestamp = now();
	const items: BoardItem[] = [];
	let maxAssumptionId = 0;
	let maxDecisionId = 0;

	for (const [lineIndex, rawLine] of markdown.split(/\r?\n/).entries()) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#") || line.startsWith("_")) continue;
		if (!line.startsWith("- ")) {
			throw new Error(`Invalid board markdown line ${lineIndex + 1}: expected '- ID | kind | status | strength | text'`);
		}

		const fields = line.slice(2).split("|").map((field) => field.trim());
		if (fields.length < 5) {
			throw new Error(`Invalid board markdown line ${lineIndex + 1}: expected 5 pipe-separated fields`);
		}

		const [id, kind, status = "accepted", strength = "soft", ...textParts] = fields;
		const text = textParts.join(" | ").trim();
		const parsedItem = parseMarkdownItem({ id, kind, status, strength, text, lineIndex, previousById, nextVersion, timestamp });

		if (items.some((item) => item.id === parsedItem.id)) {
			throw new Error(`Duplicate board item id: ${parsedItem.id}`);
		}

		items.push(parsedItem);
		const numericId = Number.parseInt(parsedItem.id.slice(1), 10);
		if (parsedItem.kind === "assumption") maxAssumptionId = Math.max(maxAssumptionId, numericId);
		else maxDecisionId = Math.max(maxDecisionId, numericId);
	}

	return {
		version: nextVersion,
		nextAssumptionId: maxAssumptionId + 1,
		nextDecisionId: maxDecisionId + 1,
		items,
	};
}

function parseMarkdownItem(input: {
	id: string;
	kind: string;
	status: string;
	strength: string;
	text: string;
	lineIndex: number;
	previousById: Map<string, BoardItem>;
	nextVersion: number;
	timestamp: number;
}): BoardItem {
	const id = input.id.trim();
	if (!/^[AD]\d+$/.test(id)) throw new Error(`Invalid board item id on line ${input.lineIndex + 1}: ${id}`);
	if (!isBoardKind(input.kind)) throw new Error(`Invalid board item kind on line ${input.lineIndex + 1}: ${input.kind}`);
	if (!isBoardStatus(input.status)) throw new Error(`Invalid board item status on line ${input.lineIndex + 1}: ${input.status}`);
	if (!isBoardStrength(input.strength)) {
		throw new Error(`Invalid board item strength on line ${input.lineIndex + 1}: ${input.strength}`);
	}
	if (!input.text) throw new Error(`Missing board item text on line ${input.lineIndex + 1}`);
	if ((id.startsWith("A") && input.kind !== "assumption") || (id.startsWith("D") && input.kind !== "decision")) {
		throw new Error(`Board item ${id} prefix does not match kind ${input.kind}`);
	}

	const previous = input.previousById.get(id);
	const base: BoardItem = previous ?? {
		id,
		kind: input.kind,
		text: input.text,
		status: input.status,
		strength: input.strength,
		source: "user",
		version: input.nextVersion,
		createdAt: input.timestamp,
		updatedAt: input.timestamp,
	};

	const materiallyChanged =
		!previous ||
		previous.kind !== input.kind ||
		previous.text !== input.text ||
		previous.status !== input.status ||
		previous.strength !== input.strength;

	return {
		...base,
		kind: input.kind,
		text: input.text,
		status: input.status,
		strength: input.strength,
		version: materiallyChanged ? input.nextVersion : base.version,
		updatedAt: materiallyChanged ? input.timestamp : base.updatedAt,
	};
}

function isBoardKind(value: string): value is BoardKind {
	return BOARD_ITEM_KINDS.includes(value as BoardKind);
}

function isBoardStatus(value: string): value is BoardStatus {
	return BOARD_ITEM_STATUSES.includes(value as BoardStatus);
}

function isBoardStrength(value: string): value is BoardStrength {
	return BOARD_ITEM_STRENGTHS.includes(value as BoardStrength);
}

export function isReadOnlyBashCommand(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return true;
	if (/[;&|`$()<>]/.test(trimmed)) return false;
	return /^(pwd|ls(\s|$)|cat\s|head\s|tail\s|grep\s|rg\s|find\s|git\s+(status|diff|log|show|branch)(\s|$)|npm\s+(list|outdated)(\s|$)|pnpm\s+(list|outdated)(\s|$)|yarn\s+(list|info|outdated)(\s|$))/.test(trimmed);
}

export function isMutatingToolCall(toolName: string, input: Record<string, unknown>): boolean {
	if (toolName === "edit" || toolName === "write") return true;
	if (toolName !== "bash") return false;
	return !isReadOnlyBashCommand(String(input.command ?? ""));
}

export default function liveDecisionBoard(pi: ExtensionAPI): void {
	let board = createEmptyBoard();
	let lastInjectedBoardVersion = 0;

	function persist(): void {
		pi.appendEntry(CUSTOM_TYPE, board);
	}

	function updateUi(ctx: ExtensionContext): void {
		if (board.items.length === 0) {
			ctx.ui.setStatus("decision-board", undefined);
			ctx.ui.setWidget("decision-board", undefined);
			return;
		}
		ctx.ui.setStatus("decision-board", ctx.ui.theme.fg("accent", formatBoardStatus(board)));
		ctx.ui.setWidget("decision-board", formatBoardWidget(board));
	}

	function notifyBoardChanged(previousVersion: number, ctx: ExtensionContext, source: BoardSource): void {
		if (ctx.isIdle() || source === "agent") return;
		pi.sendMessage(
			{
				customType: DELTA_CUSTOM_TYPE,
				content: `Live Decision Board changed from v${previousVersion} to v${board.version}. The next model call will receive the fresh board context before continuing.`,
				display: true,
				details: { previousVersion, boardVersion: board.version },
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
	}

	function applyBoard(next: BoardState, ctx: ExtensionContext, reason: string, source: BoardSource = "user"): void {
		const previousVersion = board.version;
		board = next;
		persist();
		updateUi(ctx);
		ctx.ui.notify(`${reason} (Board v${previousVersion} → v${board.version})`, "info");
		notifyBoardChanged(previousVersion, ctx, source);
	}

	function safeApplyBoard(
		ctx: ExtensionContext,
		reason: string,
		mutate: () => BoardState,
		source: BoardSource = "user",
	): void {
		try {
			applyBoard(mutate(), ctx, reason, source);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	}

	function showBoard(): void {
		pi.sendMessage({
			customType: VISIBLE_CUSTOM_TYPE,
			content: formatBoardForPrompt(board),
			display: true,
			details: { boardVersion: board.version },
		});
	}

	function boardContextForSession() {
		return {
			customType: CONTEXT_CUSTOM_TYPE,
			content: formatBoardForPrompt(board),
			display: false,
			details: { boardVersion: board.version },
		};
	}

	function boardContextForProvider() {
		return {
			role: "custom" as const,
			customType: CONTEXT_CUSTOM_TYPE,
			content: formatBoardForPrompt(board),
			display: false,
			details: { boardVersion: board.version },
			timestamp: Date.now(),
		};
	}

	pi.on("session_start", async (_event, ctx) => {
		board = restoreBoardFromEntries(ctx.sessionManager.getBranch() as SessionEntryLike[]);
		updateUi(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		board = restoreBoardFromEntries(ctx.sessionManager.getBranch() as SessionEntryLike[]);
		updateUi(ctx);
	});

	pi.registerCommand("board-show", {
		description: "Show the current live assumptions/decisions board",
		handler: async (_args, _ctx) => showBoard(),
	});

	pi.registerCommand("assume", {
		description: "Add an accepted soft assumption to the live board",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) return ctx.ui.notify("Usage: /assume <text>", "warning");
			safeApplyBoard(ctx, "Added assumption", () => addBoardItem(board, { kind: "assumption", text, source: "user" }));
		},
	});

	pi.registerCommand("decide", {
		description: "Add an accepted soft decision to the live board",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) return ctx.ui.notify("Usage: /decide <text>", "warning");
			safeApplyBoard(ctx, "Added decision", () => addBoardItem(board, { kind: "decision", text, source: "user" }));
		},
	});

	pi.registerCommand("board-hard", {
		description: "Mark a board item hard: /board-hard A1",
		handler: async (args, ctx) => {
			safeApplyBoard(ctx, "Marked hard", () => updateBoardItem(board, args.trim(), { strength: "hard" }));
		},
	});

	pi.registerCommand("board-soft", {
		description: "Mark a board item soft: /board-soft A1",
		handler: async (args, ctx) => {
			safeApplyBoard(ctx, "Marked soft", () => updateBoardItem(board, args.trim(), { strength: "soft" }));
		},
	});

	pi.registerCommand("board-reject", {
		description: "Reject a board item: /board-reject A1",
		handler: async (args, ctx) => {
			safeApplyBoard(ctx, "Rejected item", () => updateBoardItem(board, args.trim(), { status: "rejected" }));
		},
	});

	pi.registerCommand("board-supersede", {
		description: "Supersede a board item: /board-supersede A1 <new text>",
		handler: async (args, ctx) => {
			const [id, ...textParts] = args.trim().split(/\s+/);
			const replacementText = textParts.join(" ");
			if (!id || !replacementText) return ctx.ui.notify("Usage: /board-supersede <id> <new text>", "warning");
			safeApplyBoard(ctx, "Superseded item", () => supersedeBoardItem(board, id, replacementText));
		},
	});

	pi.registerCommand("board-clear", {
		description: "Clear the live board after confirmation",
		handler: async (_args, ctx) => {
			if (ctx.hasUI) {
				const confirmed = await ctx.ui.confirm(
					"Clear Live Decision Board?",
					"This clears assumptions and decisions for this branch.",
				);
				if (!confirmed) return;
			}
			safeApplyBoard(ctx, "Cleared board", () => clearBoard(board));
		},
	});

	pi.registerCommand("board", {
		description: "Edit the live assumptions/decisions board as markdown",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return ctx.ui.notify("/board requires UI mode", "error");
			const initial = serializeBoardMarkdown(board);
			const edited = await ctx.ui.editor("Edit Live Decision Board", initial);
			if (!edited || edited.trim() === initial.trim()) return;
			safeApplyBoard(ctx, "Edited board", () => parseBoardMarkdown(edited, board));
		},
	});

	pi.registerTool({
		name: "decision_board",
		label: "Decision Board",
		description: "List or update the live assumptions/decisions board.",
		promptSnippet: "List or update live assumptions and decisions for the current project.",
		promptGuidelines: [
			"Use decision_board when you make a meaningful project assumption or implementation decision.",
			"Use decision_board before acting on a decision that is not already recorded in the live board.",
		],
		parameters: Type.Object({
			action: StringEnum(["list", "add", "update", "set_status", "set_strength", "supersede"] as const),
			id: Type.Optional(Type.String()),
			kind: Type.Optional(StringEnum(["assumption", "decision"] as const)),
			text: Type.Optional(Type.String()),
			status: Type.Optional(StringEnum(["proposed", "accepted", "rejected", "superseded"] as const)),
			strength: Type.Optional(StringEnum(["soft", "hard"] as const)),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.action === "list") {
				return { content: [{ type: "text", text: formatBoardForPrompt(board) }], details: { board } };
			}

			if (params.action === "add") {
				if (!params.kind || !params.text?.trim()) throw new Error("decision_board add requires kind and text");
				board = addBoardItem(board, {
					kind: params.kind,
					text: params.text,
					status: params.status ?? "proposed",
					strength: params.strength ?? "soft",
					source: "agent",
				});
				persist();
				updateUi(ctx);
				const item = board.items.at(-1)!;
				return { content: [{ type: "text", text: `Added ${item.id}: ${item.text}` }], details: { board, item } };
			}

			if (!params.id) throw new Error(`decision_board ${params.action} requires id`);
			if (params.action === "supersede") {
				if (!params.text?.trim()) throw new Error("decision_board supersede requires replacement text");
				board = supersedeBoardItem(board, params.id, params.text, "agent");
			} else if (params.action === "update") {
				if (!params.text?.trim()) throw new Error("decision_board update requires non-empty text");
				board = updateBoardItem(board, params.id, { text: params.text });
			} else if (params.action === "set_status") {
				if (!params.status) throw new Error("decision_board set_status requires status");
				board = updateBoardItem(board, params.id, { status: params.status });
			} else {
				if (!params.strength) throw new Error("decision_board set_strength requires strength");
				board = updateBoardItem(board, params.id, { strength: params.strength });
			}
			persist();
			updateUi(ctx);
			return { content: [{ type: "text", text: `Updated ${params.id}` }], details: { board } };
		},
	});

	pi.on("context", async (event) => {
		const filtered = (event.messages as MessageLike[]).filter(
			(message) => !BOARD_CONTEXT_TYPES.has(message.customType ?? ""),
		);
		if (board.items.length === 0) return { messages: filtered };
		lastInjectedBoardVersion = board.version;
		return { messages: [boardContextForProvider(), ...filtered] };
	});

	pi.on("before_agent_start", async () => {
		if (board.items.length === 0) return;
		return { message: boardContextForSession() };
	});

	pi.on("tool_call", async (event) => {
		if (!isMutatingToolCall(event.toolName, event.input as Record<string, unknown>)) return;
		if (!hasUninjectedHardChanges(board, lastInjectedBoardVersion)) return;
		return {
			block: true,
			reason: `Live Decision Board changed after the agent last received it in provider context. Current board v${board.version}, injected v${lastInjectedBoardVersion}. Re-read/reconcile the board before mutating files.`,
		};
	});
}
