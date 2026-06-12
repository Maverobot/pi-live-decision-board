/**
 * Live Decision Board
 *
 * A Pi extension that keeps a visible, editable assumptions/decisions board,
 * injects the latest board into model context, and blocks stale hard-decision
 * mutations until the board has been injected into a provider request.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ContextEvent, ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
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
	hardDecisionBarrierVersion: number;
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
type ContextMessage = ContextEvent["messages"][number];

const CUSTOM_TYPE = "live-decision-board";
const CONTEXT_CUSTOM_TYPE = "live-decision-board-context";
const VISIBLE_CUSTOM_TYPE = "live-decision-board-visible";
const DELTA_CUSTOM_TYPE = "live-decision-board-delta";
const BOARD_CONTEXT_TYPES = new Set([CONTEXT_CUSTOM_TYPE, VISIBLE_CUSTOM_TYPE, DELTA_CUSTOM_TYPE]);

const BOARD_ITEM_STATUSES: BoardStatus[] = ["proposed", "accepted", "rejected", "superseded"];
const BOARD_ITEM_STRENGTHS: BoardStrength[] = ["soft", "hard"];
const BOARD_ITEM_KINDS: BoardKind[] = ["assumption", "decision"];
const BOARD_ITEM_SOURCES: BoardSource[] = ["user", "agent", "discussion-loop"];

export function createEmptyBoard(): BoardState {
	return { version: 0, hardDecisionBarrierVersion: 0, nextAssumptionId: 1, nextDecisionId: 1, items: [] };
}

export function clearBoard(board: BoardState): BoardState {
	const nextVersion = board.version + 1;
	return {
		version: nextVersion,
		hardDecisionBarrierVersion: board.items.some(isAcceptedHardItem)
			? nextVersion
			: getHardDecisionBarrierVersion(board),
		nextAssumptionId: 1,
		nextDecisionId: 1,
		items: [],
	};
}

function now(): number {
	return Date.now();
}

function normalizeBoardText(text: string): string {
	return text.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
}

function isAcceptedHardItem(item: Pick<BoardItem, "status" | "strength">): boolean {
	return item.status === "accepted" && item.strength === "hard";
}

function getHardDecisionBarrierVersion(board: BoardState): number {
	return board.hardDecisionBarrierVersion ?? maxAcceptedHardItemVersion(board.items);
}

function maxAcceptedHardItemVersion(items: BoardItem[]): number {
	return items.reduce((maxVersion, item) => (isAcceptedHardItem(item) ? Math.max(maxVersion, item.version) : maxVersion), 0);
}

export function addBoardItem(board: BoardState, input: NewBoardItem): BoardState {
	const text = normalizeBoardText(input.text);
	if (!text) throw new Error("Board item text is required");

	const nextVersion = board.version + 1;
	const status = input.status ?? "accepted";
	const strength = input.strength ?? "soft";
	const id = input.kind === "assumption" ? `A${board.nextAssumptionId}` : `D${board.nextDecisionId}`;
	const timestamp = now();
	const item: BoardItem = {
		id,
		kind: input.kind,
		text,
		status,
		strength,
		source: input.source ?? "user",
		version: nextVersion,
		createdAt: timestamp,
		updatedAt: timestamp,
		supersedes: input.supersedes,
	};

	return {
		version: nextVersion,
		hardDecisionBarrierVersion: isAcceptedHardItem(item) ? nextVersion : getHardDecisionBarrierVersion(board),
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

	const text = cleanPatch.text === undefined ? existing.text : normalizeBoardText(cleanPatch.text);
	if (!text) throw new Error("Board item text is required");
	const effective: BoardItem = { ...existing, ...cleanPatch, text };
	const changed =
		existing.text !== effective.text ||
		existing.status !== effective.status ||
		existing.strength !== effective.strength ||
		existing.source !== effective.source ||
		existing.supersedes !== effective.supersedes;
	if (!changed) return board;

	const nextVersion = board.version + 1;
	const hardDecisionChanged = isAcceptedHardItem(existing) || isAcceptedHardItem(effective);
	return {
		...board,
		version: nextVersion,
		hardDecisionBarrierVersion: hardDecisionChanged ? nextVersion : getHardDecisionBarrierVersion(board),
		items: board.items.map((item) =>
			item.id === normalizedId ? { ...effective, version: nextVersion, updatedAt: now() } : item,
		),
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

function isActiveItem(item: Pick<BoardItem, "status">): boolean {
	return item.status === "accepted" || item.status === "proposed";
}

function activeBoardItems(board: BoardState): BoardItem[] {
	return board.items.filter(isActiveItem);
}

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

function recommendCleanupForItem(item: BoardItem): CleanupRecommendation {
	const base = cleanupBase(item);
	if (isAcceptedHardItem(item)) {
		return {
			...base,
			action: "keep",
			selected: false,
			reason: "Hard constraints are kept by default.",
			riskLevel: "high",
			requiresExplicitConfirmation: true,
		};
	}
	if (item.status === "proposed") {
		return {
			...base,
			action: "needs_user_review",
			selected: false,
			reason: "Proposed items need user review before cleanup.",
			riskLevel: "medium",
			requiresExplicitConfirmation: true,
		};
	}
	if (looksHistorical(item.text)) {
		return {
			...base,
			action: "archive",
			selected: true,
			reason: "Looks historical: completed implementation or review-log entry.",
			riskLevel: "low",
			requiresExplicitConfirmation: false,
		};
	}
	return {
		...base,
		action: "keep",
		selected: false,
		reason: "No safe cleanup heuristic matched; keep by default.",
		riskLevel: "low",
		requiresExplicitConfirmation: false,
	};
	}

function cleanupBase(item: BoardItem): Omit<CleanupRecommendation, "action" | "selected" | "reason" | "riskLevel" | "requiresExplicitConfirmation" | "replacementText"> {
	return {
		id: item.id,
		itemVersion: item.version,
		observedText: item.text,
		observedStatus: item.status,
		observedStrength: item.strength,
	};
}

function looksHistorical(text: string): boolean {
	return /\b(apply round \d+|review fixes|implemented|after the next review round|rename[sd]? \/|add \/board-|fix(?:ed)? .*review|completed|pushed|installed cache)\b/i.test(text);
}

export interface CleanupImpact {
	activeBefore: number;
	activeAfter: number;
	hardBefore: number;
	hardAfter: number;
	archiveCount: number;
	supersedeCount: number;
	needsUserReviewCount: number;
}

export function summarizeBoardCleanupImpact(board: BoardState, recommendations: CleanupRecommendation[]): CleanupImpact {
	const activeBefore = activeBoardItems(board).length;
	const hardBefore = activeBoardItems(board).filter((item) => item.status === "accepted" && item.strength === "hard").length;
	const nextBoard = applyBoardCleanup(board, recommendations);
	return {
		activeBefore,
		activeAfter: activeBoardItems(nextBoard).length,
		hardBefore,
		hardAfter: activeBoardItems(nextBoard).filter((item) => item.status === "accepted" && item.strength === "hard").length,
		archiveCount: recommendations.filter((rec) => rec.selected && rec.action === "archive").length,
		supersedeCount: recommendations.filter((rec) => rec.selected && rec.action === "supersede").length,
		needsUserReviewCount: recommendations.filter((rec) => rec.selected && rec.action === "needs_user_review").length,
	};
}

export function applyBoardCleanup(board: BoardState, recommendations: CleanupRecommendation[]): BoardState {
	let next = board;
	for (const recommendation of recommendations) {
		if (!recommendation.selected) continue;
		const current = next.items.find((item) => item.id === recommendation.id);
		if (!current) {
			throw new Error(`Board cleanup item not found: ${recommendation.id}`);
		}
		assertCleanupRecommendationFresh(current, recommendation);
		switch (recommendation.action) {
			case "archive":
				next = updateBoardItem(next, recommendation.id, { status: "rejected" });
				break;
			case "supersede":
				if (!recommendation.replacementText?.trim()) {
					throw new Error(`Cleanup supersede requires replacement text for ${recommendation.id}`);
				}
				next = supersedeBoardItem(next, recommendation.id, recommendation.replacementText, "user");
				break;
			case "keep":
			case "needs_user_review":
				break;
			default:
				break;
		}
	}
	return next;
}

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

export function formatBoardForPrompt(board: BoardState): string {
	const active = activeBoardItems(board);
	const assumptions = active.filter((item) => item.kind === "assumption");
	const decisions = active.filter((item) => item.kind === "decision");
	const lines = [`## Live Assumptions & Decisions — version ${board.version}`, ""];
	lines.push("Rules:");
	lines.push("- Treat hard accepted decisions as constraints before mutating files.");
	lines.push("- Hard means an enforced constraint: use it only for user-stated constraints, safety-critical rules, or decisions that should block stale mutating tools; do not use hard merely to mean important.");
	lines.push("- If current work conflicts with this board, reconcile before continuing.");
	lines.push("- Record only assumptions or decisions that should affect future behavior; do not use the board as an implementation log.", "");
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
	const active = activeBoardItems(board);
	const assumptions = active.filter((item) => item.kind === "assumption").length;
	const decisions = active.filter((item) => item.kind === "decision").length;
	const hardCount = active.filter((item) => item.status === "accepted" && item.strength === "hard").length;
	return `Board v${board.version} • ${pluralize(assumptions, "assumption")} • ${pluralize(decisions, "decision")} • ${pluralize(hardCount, "hard constraint")}`;
}

function pluralize(count: number, label: string): string {
	return `${count} ${label}${count === 1 ? "" : "s"}`;
}

function formatBoardStatusForWidget(board: BoardState, theme: Theme): string {
	const active = activeBoardItems(board);
	const assumptions = active.filter((item) => item.kind === "assumption").length;
	const decisions = active.filter((item) => item.kind === "decision").length;
	const hardCount = active.filter((item) => item.status === "accepted" && item.strength === "hard").length;
	return [
		theme.fg("muted", "Board"),
		theme.fg("accent", `v${board.version}`),
		theme.fg("success", pluralize(assumptions, "assumption")),
		theme.fg("success", pluralize(decisions, "decision")),
		theme.fg(hardCount > 0 ? "warning" : "dim", pluralize(hardCount, "hard constraint")),
	].join(" • ");
}

function formatBoardWidgetText(board: BoardState, theme: Theme, options: { collapsed?: boolean } = {}): string {
	if (options.collapsed) return formatBoardStatusForWidget(board, theme);
	const [, ...bodyLines] = formatBoardWidget(board);
	return [renderBoardSeparator(theme), formatBoardStatusForWidget(board, theme), ...bodyLines.map((line) => colorizeWidgetLine(line, theme))].join("\n");
}

function renderBoardSeparator(theme: Theme): string {
	return `${theme.fg("dim", "────────────────")} ${theme.fg("accent", "Live Decision Board")} ${theme.fg("dim", "────────────────")}`;
}

function colorizeWidgetLine(line: string, theme: Theme): string {
	const section = /^(Decisions|Assumptions) \((\d+)\)$/.exec(line);
	if (section) return `${theme.fg("accent", section[1])} ${theme.fg("muted", `(${section[2]})`)}`;

	const item = /^([!•]) \[([AD]\d+)] (.*)$/.exec(line);
	if (!item) return line;
	const marker = item[1] === "!" ? theme.fg("warning", "!") : theme.fg("dim", "•");
	return `${marker} ${theme.fg("accent", `[${item[2]}]`)} ${theme.fg("muted", item[3])}`;
}

export function formatBoardWidget(board: BoardState, options: { maxItems?: number } = {}): string[] {
	const maxItems = options.maxItems ?? Number.POSITIVE_INFINITY;
	const active = activeBoardItems(board).sort(compareWidgetItems);
	const decisions = active.filter((item) => item.kind === "decision");
	const assumptions = active.filter((item) => item.kind === "assumption");

	const lines = [formatBoardStatus(board)];
	let remainingItems = maxItems;
	remainingItems = appendWidgetSection(lines, "Decisions", decisions, remainingItems);
	appendWidgetSection(lines, "Assumptions", assumptions, remainingItems);
	return lines;
}

function compareWidgetItems(a: BoardItem, b: BoardItem): number {
	const aNumber = Number.parseInt(a.id.slice(1), 10);
	const bNumber = Number.parseInt(b.id.slice(1), 10);
	return Number.isFinite(aNumber) && Number.isFinite(bNumber) ? aNumber - bNumber : a.id.localeCompare(b.id);
}

function appendWidgetSection(lines: string[], label: string, items: BoardItem[], remainingItems: number): number {
	if (items.length === 0) return remainingItems;
	const singularLabel = label.endsWith("s") ? label.slice(0, -1).toLowerCase() : label.toLowerCase();
	lines.push(`${label} (${items.length})`);
	if (remainingItems <= 0) {
		lines.push(`… ${pluralize(items.length, singularLabel)} hidden`);
		return 0;
	}
	const visibleItems = items.slice(0, remainingItems);
	for (const item of visibleItems) {
		const marker = item.strength === "hard" ? "!" : "•";
		lines.push(`${marker} [${item.id}] ${item.text}`);
	}
	const hiddenItems = items.length - visibleItems.length;
	if (hiddenItems > 0) lines.push(`… ${pluralize(hiddenItems, `more ${singularLabel}`)}`);
	return remainingItems - visibleItems.length;
}

export function hasUninjectedHardChanges(board: BoardState, injectedVersion: number): boolean {
	return getHardDecisionBarrierVersion(board) > injectedVersion;
}

export function restoreBoardFromEntries(entries: SessionEntryLike[]): BoardState {
	const boardEntries = entries.filter((entry) => entry.type === "custom" && entry.customType === CUSTOM_TYPE);
	for (let index = boardEntries.length - 1; index >= 0; index -= 1) {
		const restored = normalizeBoardState(boardEntries[index]?.data);
		if (restored) return restored;
	}
	return createEmptyBoard();
}

function normalizeBoardState(value: unknown): BoardState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<BoardState>;
	if (
		!isNonNegativeInteger(candidate.version) ||
		!isPositiveInteger(candidate.nextAssumptionId) ||
		!isPositiveInteger(candidate.nextDecisionId) ||
		!Array.isArray(candidate.items) ||
		(candidate.hardDecisionBarrierVersion !== undefined && !isNonNegativeInteger(candidate.hardDecisionBarrierVersion))
	) {
		return undefined;
	}
	if (!candidate.items.every(isBoardItem)) return undefined;

	const version = candidate.version;
	const items = candidate.items.map((item) => ({ ...item, text: normalizeBoardText(item.text) }));
	if (items.some((item) => item.version > version)) return undefined;

	const seenIds = new Set<string>();
	let maxAssumptionId = 0;
	let maxDecisionId = 0;
	for (const item of items) {
		if (seenIds.has(item.id)) return undefined;
		seenIds.add(item.id);
		const numericId = Number.parseInt(item.id.slice(1), 10);
		if (item.kind === "assumption") maxAssumptionId = Math.max(maxAssumptionId, numericId);
		else maxDecisionId = Math.max(maxDecisionId, numericId);
	}

	const requiredBarrier = maxAcceptedHardItemVersion(items);
	const restoredBarrier = candidate.hardDecisionBarrierVersion ?? requiredBarrier;
	return {
		version,
		hardDecisionBarrierVersion: Math.min(version, Math.max(restoredBarrier, requiredBarrier)),
		nextAssumptionId: Math.max(candidate.nextAssumptionId, maxAssumptionId + 1),
		nextDecisionId: Math.max(candidate.nextDecisionId, maxDecisionId + 1),
		items,
	};
}

function isBoardItem(value: unknown): value is BoardItem {
	if (!value || typeof value !== "object") return false;
	const item = value as Partial<BoardItem>;
	return (
		typeof item.id === "string" &&
		/^[AD]\d+$/.test(item.id) &&
		isBoardKind(item.kind ?? "") &&
		((item.id.startsWith("A") && item.kind === "assumption") || (item.id.startsWith("D") && item.kind === "decision")) &&
		typeof item.text === "string" &&
		normalizeBoardText(item.text).length > 0 &&
		isBoardStatus(item.status ?? "") &&
		isBoardStrength(item.strength ?? "") &&
		isBoardSource(item.source ?? "") &&
		isPositiveInteger(item.version) &&
		isNonNegativeFiniteNumber(item.createdAt) &&
		isNonNegativeFiniteNumber(item.updatedAt) &&
		(item.supersedes === undefined || typeof item.supersedes === "string")
	);
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
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
		hardDecisionBarrierVersion: hardDecisionBoundaryChanged(previousBoard.items, items)
			? nextVersion
			: getHardDecisionBarrierVersion(previousBoard),
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
	const text = normalizeBoardText(input.text);
	if (!text) throw new Error(`Missing board item text on line ${input.lineIndex + 1}`);
	if ((id.startsWith("A") && input.kind !== "assumption") || (id.startsWith("D") && input.kind !== "decision")) {
		throw new Error(`Board item ${id} prefix does not match kind ${input.kind}`);
	}

	const previous = input.previousById.get(id);
	const base: BoardItem = previous ?? {
		id,
		kind: input.kind,
		text,
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
		previous.text !== text ||
		previous.status !== input.status ||
		previous.strength !== input.strength;

	return {
		...base,
		kind: input.kind,
		text,
		status: input.status,
		strength: input.strength,
		version: materiallyChanged ? input.nextVersion : base.version,
		updatedAt: materiallyChanged ? input.timestamp : base.updatedAt,
	};
}

function hardDecisionBoundaryChanged(previousItems: BoardItem[], nextItems: BoardItem[]): boolean {
	const nextById = new Map(nextItems.map((item) => [item.id, item]));
	const previousById = new Map(previousItems.map((item) => [item.id, item]));

	for (const previous of previousItems) {
		if (!isAcceptedHardItem(previous)) continue;
		const next = nextById.get(previous.id);
		if (!next || !isSameDecisionBoundary(previous, next)) return true;
	}

	for (const next of nextItems) {
		if (!isAcceptedHardItem(next)) continue;
		const previous = previousById.get(next.id);
		if (!previous || !isSameDecisionBoundary(previous, next)) return true;
	}

	return false;
}

function isSameDecisionBoundary(left: BoardItem, right: BoardItem): boolean {
	return (
		left.kind === right.kind &&
		left.text === right.text &&
		left.status === right.status &&
		left.strength === right.strength &&
		left.supersedes === right.supersedes
	);
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

function isBoardSource(value: string): value is BoardSource {
	return BOARD_ITEM_SOURCES.includes(value as BoardSource);
}

export function isReadOnlyBashCommand(command: string): boolean {
	const tokens = parseSingleSimpleCommand(command);
	if (!tokens) return false;
	if (tokens.length === 0) return true;

	const [program, ...args] = tokens;
	if (!program) return true;

	switch (program) {
		case "pwd":
			return args.length === 0;
		case "ls":
		case "cat":
		case "head":
		case "tail":
		case "grep":
			return true;
		case "rg":
			return isReadOnlyRipgrepCommand(args);
		case "find":
			return isReadOnlyFindCommand(args);
		case "git":
			return isReadOnlyGitCommand(args);
		case "npm":
		case "pnpm":
			return ["list", "outdated"].includes(args[0] ?? "");
		case "yarn":
			return ["list", "info", "outdated"].includes(args[0] ?? "");
		default:
			return false;
	}
}

function parseSingleSimpleCommand(command: string): string[] | undefined {
	const trimmed = command.trim();
	if (!trimmed) return [];
	if (/[\r\n]/.test(trimmed)) return undefined;

	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;

	for (const char of trimmed) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}

		if (char === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}

		if (quote) {
			if (char === quote) {
				quote = undefined;
				continue;
			}
			if (quote === '"' && (char === "$" || char === "`")) return undefined;
			current += char;
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		if (";&|`$()<>".includes(char)) return undefined;
		current += char;
	}

	if (quote || escaped) return undefined;
	if (current) tokens.push(current);
	return tokens;
}

function isReadOnlyRipgrepCommand(args: string[]): boolean {
	return !args.some((arg) => arg === "--pre" || arg.startsWith("--pre=") || arg === "--pre-glob" || arg.startsWith("--pre-glob="));
}

function isReadOnlyFindCommand(args: string[]): boolean {
	const mutatingActions = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]);
	return !args.some((arg) => mutatingActions.has(arg));
}

function hasGitUnsafeOption(args: string[]): boolean {
	return args.some(
		(arg) =>
			arg === "--output" ||
			arg.startsWith("--output=") ||
			arg === "--ext-diff" ||
			arg.startsWith("--ext-diff=") ||
			arg === "--textconv" ||
			arg.startsWith("--textconv="),
	);
}

function isReadOnlyGitCommand(args: string[]): boolean {
	if (hasGitUnsafeOption(args)) return false;
	const subcommand = args[0] ?? "";
	const rest = args.slice(1);
	if (["status", "log", "show"].includes(subcommand)) return true;
	if (subcommand === "diff") return true;
	if (subcommand === "branch") return isReadOnlyGitBranchCommand(rest);
	return false;
}

function isReadOnlyGitBranchCommand(args: string[]): boolean {
	let index = 0;
	while (index < args.length) {
		const arg = args[index];
		if (["--show-current", "-a", "--all", "-r", "-v", "-vv"].includes(arg)) {
			index += 1;
			continue;
		}
		if (["--contains", "--merged", "--no-merged"].includes(arg)) {
			index += 1;
			if (args[index] && !args[index].startsWith("-")) index += 1;
			continue;
		}
		return false;
	}
	return true;
}

export function isMutatingToolCall(toolName: string, input: Record<string, unknown>): boolean {
	if (toolName === "edit" || toolName === "write") return true;
	if (toolName !== "bash") return false;
	return !isReadOnlyBashCommand(String(input.command ?? ""));
}

function getCustomType(message: unknown): string {
	if (!message || typeof message !== "object" || !("customType" in message)) return "";
	const customType = (message as { customType?: unknown }).customType;
	return typeof customType === "string" ? customType : "";
}

type BoardManagerAction =
	| { type: "close" }
	| { type: "edit" | "accept" | "reject" | "harden" | "soften" | "supersede"; id: string };

function compareManagerItems(a: BoardItem, b: BoardItem): number {
	const activeRank = Number(isActiveItem(b)) - Number(isActiveItem(a));
	if (activeRank !== 0) return activeRank;
	const kindRank = Number(a.kind === "assumption") - Number(b.kind === "assumption");
	if (kindRank !== 0) return kindRank;
	return compareWidgetItems(a, b);
}

class BoardManagerComponent {
	private readonly items: BoardItem[];
	private selectedIndex = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly board: BoardState,
		private readonly theme: Theme,
		private readonly done: (action: BoardManagerAction) => void,
		private readonly requestRender: () => void,
	) {
		this.items = [...board.items].sort(compareManagerItems);
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") {
			this.done({ type: "close" });
			return;
		}

		if (matchesKey(data, Key.down) || data === "j") {
			this.moveSelection(1);
			return;
		}
		if (matchesKey(data, Key.up) || data === "k") {
			this.moveSelection(-1);
			return;
		}

		const selected = this.items[this.selectedIndex];
		if (!selected) return;
		if (matchesKey(data, Key.enter) || data === "e") this.done({ type: "edit", id: selected.id });
		else if (data === "a") this.done({ type: "accept", id: selected.id });
		else if (data === "r") this.done({ type: "reject", id: selected.id });
		else if (data === "h") this.done({ type: "harden", id: selected.id });
		else if (data === "s") this.done({ type: "soften", id: selected.id });
		else if (data === "u") this.done({ type: "supersede", id: selected.id });
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const activeCount = this.items.filter(isActiveItem).length;
		const inactiveCount = this.items.length - activeCount;
		const hardCount = this.items.filter((item) => isAcceptedHardItem(item)).length;
		const lines = [
			this.header(width),
			truncateToWidth(
				`Board v${this.board.version} • ${pluralize(activeCount, "active item")} • ${pluralize(inactiveCount, "inactive item")} • ${pluralize(hardCount, "hard constraint")}`,
				width,
			),
			"",
		];

		if (this.items.length === 0) {
			lines.push(truncateToWidth(this.theme.fg("dim", "No board items yet. Use /assume or /decide to add one."), width));
		} else {
			for (const [index, item] of this.items.entries()) {
				lines.push(this.renderItem(item, index, width));
			}
		}

		lines.push("", truncateToWidth(this.theme.fg("dim", "↑↓/j/k select • enter/e edit • a accept • r reject/remove • h hard • s soft • u supersede • q/esc close"), width));
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private header(width: number): string {
		const title = ` ${this.theme.fg("accent", "Live Decision Board Manager")} `;
		return truncateToWidth(`${this.theme.fg("dim", "────")} ${title}${this.theme.fg("dim", "────")}`, width);
	}

	private renderItem(item: BoardItem, index: number, width: number): string {
		const selected = index === this.selectedIndex;
		const marker = selected ? this.theme.fg("accent", ">") : " ";
		const id = this.theme.fg("accent", `[${item.id}]`);
		const strength = item.strength === "hard" ? this.theme.fg("warning", item.strength) : this.theme.fg("dim", item.strength);
		const statusColor = item.status === "accepted" ? "success" : item.status === "proposed" ? "warning" : "dim";
		const status = this.theme.fg(statusColor, item.status);
		const text = isActiveItem(item) ? this.theme.fg("muted", item.text) : this.theme.fg("dim", item.text);
		return truncateToWidth(`${marker} ${id} ${status}/${strength} ${text}`, width);
	}

	private moveSelection(delta: number): void {
		if (this.items.length === 0) return;
		this.selectedIndex = Math.max(0, Math.min(this.items.length - 1, this.selectedIndex + delta));
		this.invalidate();
		this.requestRender();
	}
}

export default function liveDecisionBoard(pi: ExtensionAPI): void {
	let board = createEmptyBoard();
	let lastInjectedBoardVersion = 0;
	let boardEpoch = 0;
	let widgetExpanded = true;

	function persist(): void {
		pi.appendEntry(CUSTOM_TYPE, board);
	}

	function updateUi(ctx: ExtensionContext): void {
		ctx.ui.setStatus("decision-board", undefined);
		if (board.items.length === 0) {
			ctx.ui.setWidget("decision-board", undefined);
			return;
		}
		ctx.ui.setWidget("decision-board", (_tui, theme) => new Text(formatBoardWidgetText(board, theme, { collapsed: !widgetExpanded }), 0, 0));
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

	function commitBoard(next: BoardState, ctx: ExtensionContext, source: BoardSource): { changed: boolean; previousVersion: number } {
		if (next === board) return { changed: false, previousVersion: board.version };
		const previousVersion = board.version;
		board = next;
		boardEpoch += 1;
		persist();
		updateUi(ctx);
		notifyBoardChanged(previousVersion, ctx, source);
		return { changed: true, previousVersion };
	}

	function applyBoard(next: BoardState, ctx: ExtensionContext, reason: string, source: BoardSource = "user"): boolean {
		const result = commitBoard(next, ctx, source);
		if (!result.changed) {
			ctx.ui.notify(`${reason}: no change`, "info");
			return false;
		}
		ctx.ui.notify(`${reason} (Board v${result.previousVersion} → v${board.version})`, "info");
		return true;
	}

	function safeApplyBoard(
		ctx: ExtensionContext,
		reason: string,
		mutate: () => BoardState,
		source: BoardSource = "user",
	): boolean {
		try {
			return applyBoard(mutate(), ctx, reason, source);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			return false;
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

	function boardContextForProvider(): ContextMessage {
		return {
			role: "custom" as const,
			customType: CONTEXT_CUSTOM_TYPE,
			content: formatBoardForPrompt(board),
			display: false,
			details: { boardVersion: board.version },
			timestamp: Date.now(),
		} as ContextMessage;
	}

	function restoreBoard(ctx: ExtensionContext): void {
		board = restoreBoardFromEntries(ctx.sessionManager.getBranch() as SessionEntryLike[]);
		lastInjectedBoardVersion = 0;
		boardEpoch += 1;
		updateUi(ctx);
	}

	async function manageBoard(ctx: ExtensionContext): Promise<void> {
		while (true) {
			const baseEpoch = boardEpoch;
			const action = await ctx.ui.custom<BoardManagerAction>(
				(tui, theme, _keybindings, done) => new BoardManagerComponent(board, theme, done, () => tui.requestRender()),
				{ overlay: true, overlayOptions: { width: "90%", minWidth: 60, maxHeight: "80%" } },
			);
			if (action.type === "close") return;
			if (boardEpoch !== baseEpoch) {
				ctx.ui.notify("Live Decision Board changed while manager was open; action skipped and manager refreshed.", "warning");
				continue;
			}
			await applyBoardManagerAction(ctx, action);
		}
	}

	async function applyBoardManagerAction(ctx: ExtensionContext, action: Exclude<BoardManagerAction, { type: "close" }>): Promise<void> {
		const item = board.items.find((candidate) => candidate.id === action.id);
		if (!item) {
			ctx.ui.notify(`Board item not found: ${action.id}`, "error");
			return;
		}

		if (action.type === "edit") {
			await editBoardManagerItem(ctx, item);
			return;
		}
		if (action.type === "supersede") {
			await supersedeBoardManagerItem(ctx, item);
			return;
		}

		switch (action.type) {
			case "accept":
				safeApplyBoard(ctx, "Accepted item", () => updateBoardItem(board, item.id, { status: "accepted" }));
				return;
			case "reject":
				safeApplyBoard(ctx, "Rejected item", () => updateBoardItem(board, item.id, { status: "rejected" }));
				return;
			case "harden":
				safeApplyBoard(ctx, "Marked hard", () => updateBoardItem(board, item.id, { strength: "hard" }));
				return;
			case "soften":
				safeApplyBoard(ctx, "Marked soft", () => updateBoardItem(board, item.id, { strength: "soft" }));
				return;
		}
	}

	async function editBoardManagerItem(ctx: ExtensionContext, item: BoardItem): Promise<void> {
		const baseEpoch = boardEpoch;
		const edited = await ctx.ui.editor(`Edit ${item.id}`, item.text);
		if (!edited || edited.trim() === item.text.trim()) return;
		if (boardEpoch !== baseEpoch) {
			ctx.ui.notify("Live Decision Board changed while item editor was open; reopen /board-manage and apply your edit to the latest board.", "warning");
			return;
		}
		safeApplyBoard(ctx, "Edited item", () => updateBoardItem(board, item.id, { text: edited }));
	}

	async function supersedeBoardManagerItem(ctx: ExtensionContext, item: BoardItem): Promise<void> {
		const baseEpoch = boardEpoch;
		const replacementText = await ctx.ui.editor(`Supersede ${item.id}`, item.text);
		if (!replacementText?.trim()) return;
		if (boardEpoch !== baseEpoch) {
			ctx.ui.notify("Live Decision Board changed while supersede editor was open; reopen /board-manage and apply your edit to the latest board.", "warning");
			return;
		}
		safeApplyBoard(ctx, "Superseded item", () => supersedeBoardItem(board, item.id, replacementText, "user"));
	}

	async function cleanupBoard(ctx: ExtensionContext): Promise<void> {
		const recommendations = recommendBoardCleanup(board);
		if (recommendations.length === 0) {
			ctx.ui.notify("No active board items to clean up", "info");
			return;
		}
		ctx.ui.notify("/board-cleanup UI is not implemented yet", "warning");
	}

	pi.on("session_start", async (_event, ctx) => {
		restoreBoard(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreBoard(ctx);
	});

	pi.registerCommand("board-snapshot", {
		description: "Show the active context snapshot of the live assumptions/decisions board as a visible message",
		handler: async (_args, _ctx) => showBoard(),
	});

	pi.registerCommand("board-toggle", {
		description: "Collapse or expand the persistent live assumptions/decisions board widget body",
		handler: async (_args, ctx) => {
			widgetExpanded = !widgetExpanded;
			updateUi(ctx);
			ctx.ui.notify(
				widgetExpanded
					? "Live Decision Board widget expanded"
					: "Live Decision Board widget collapsed; summary remains visible, and the board still updates, injects into context, and enforces hard decisions.",
				"info",
			);
		},
	});

	pi.registerCommand("board-manage", {
		description: "Manage live board items with a keyboard UI",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return ctx.ui.notify("/board-manage requires TUI mode", "error");
			await manageBoard(ctx);
		},
	});

	pi.registerCommand("board-cleanup", {
		description: "Review and archive historical board items with confirmation",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return ctx.ui.notify("/board-cleanup requires TUI mode", "error");
			await cleanupBoard(ctx);
		},
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
		description: "Mark an item as an enforced hard constraint: /board-hard A1",
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

	pi.registerCommand("board-accept", {
		description: "Accept a proposed or rejected board item: /board-accept A1",
		handler: async (args, ctx) => {
			safeApplyBoard(ctx, "Accepted item", () => updateBoardItem(board, args.trim(), { status: "accepted" }));
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
			const baseEpoch = boardEpoch;
			if (ctx.hasUI) {
				const confirmed = await ctx.ui.confirm(
					"Clear Live Decision Board?",
					"This clears assumptions and decisions for this branch.",
				);
				if (!confirmed) return;
				if (boardEpoch !== baseEpoch) {
					ctx.ui.notify("Live Decision Board changed while confirmation was open; rerun /board-clear on the latest board.", "warning");
					return;
				}
			}
			safeApplyBoard(ctx, "Cleared board", () => clearBoard(board));
		},
	});

	pi.registerCommand("board", {
		description: "Edit the live assumptions/decisions board as markdown",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return ctx.ui.notify("/board requires UI mode", "error");
			const baseBoard = board;
			const baseEpoch = boardEpoch;
			const initial = serializeBoardMarkdown(baseBoard);
			const edited = await ctx.ui.editor("Edit Live Decision Board", initial);
			if (!edited || edited.trim() === initial.trim()) return;
			if (boardEpoch !== baseEpoch) {
				ctx.ui.notify("Live Decision Board changed while editor was open; reopen /board and apply your edit to the latest board.", "warning");
				return;
			}
			safeApplyBoard(ctx, "Edited board", () => parseBoardMarkdown(edited, baseBoard));
		},
	});

	pi.registerTool({
		name: "decision_board",
		label: "Decision Board",
		description: "List or update the live assumptions/decisions board.",
		promptSnippet: "List or update live assumptions and decisions for the current project.",
		promptGuidelines: [
			"Use decision_board only for currently actionable assumptions or decisions that should affect future behavior.",
			"Use decision_board before acting on a decision that is not already recorded in the live board.",
			"Do not use decision_board as an implementation log for progress updates, tests run, files changed, or completed review batches.",
			"Use hard only for explicit user constraints, safety-critical rules, or decisions that should block stale mutating tools; do not use hard merely to mean important.",
		],
		executionMode: "sequential",
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
				const nextBoard = addBoardItem(board, {
					kind: params.kind,
					text: params.text,
					status: params.status ?? "proposed",
					strength: params.strength ?? "soft",
					source: "agent",
				});
				const item = nextBoard.items.at(-1)!;
				commitBoard(nextBoard, ctx, "agent");
				return { content: [{ type: "text", text: `Added ${item.id}: ${item.text}` }], details: { board, item } };
			}

			if (!params.id) throw new Error(`decision_board ${params.action} requires id`);
			let nextBoard: BoardState;
			if (params.action === "supersede") {
				if (!params.text?.trim()) throw new Error("decision_board supersede requires replacement text");
				nextBoard = supersedeBoardItem(board, params.id, params.text, "agent");
			} else if (params.action === "update") {
				if (!params.text?.trim()) throw new Error("decision_board update requires non-empty text");
				nextBoard = updateBoardItem(board, params.id, { text: params.text });
			} else if (params.action === "set_status") {
				if (!params.status) throw new Error("decision_board set_status requires status");
				nextBoard = updateBoardItem(board, params.id, { status: params.status });
			} else {
				if (!params.strength) throw new Error("decision_board set_strength requires strength");
				nextBoard = updateBoardItem(board, params.id, { strength: params.strength });
			}
			const result = commitBoard(nextBoard, ctx, "agent");
			return {
				content: [{ type: "text", text: result.changed ? `Updated ${params.id}` : `No change for ${params.id}` }],
				details: { board },
			};
		},
	});

	pi.on("context", async (event) => {
		const filtered = event.messages.filter((message) => !BOARD_CONTEXT_TYPES.has(getCustomType(message)));
		if (board.items.length === 0 && !hasUninjectedHardChanges(board, lastInjectedBoardVersion)) {
			return { messages: filtered };
		}
		lastInjectedBoardVersion = board.version;
		return { messages: [boardContextForProvider(), ...filtered] };
	});

	pi.on("before_agent_start", async () => {
		if (board.items.length === 0 && getHardDecisionBarrierVersion(board) === 0) return;
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
