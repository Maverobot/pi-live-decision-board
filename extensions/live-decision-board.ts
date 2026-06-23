/**
 * Live Decision Board
 *
 * A Pi extension that keeps a visible, editable goal/assumptions/decisions board,
 * injects the latest board into model context, and blocks stale active-item
 * mutations until the board has been injected or returned by the tool.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ContextEvent, ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export type BoardKind = "goal" | "assumption" | "decision";
export type BoardStatus = "active" | "archived";
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
}

export interface BoardState {
	version: number;
	hardDecisionBarrierVersion: number;
	nextGoalId: number;
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
}

type BoardPatch = Partial<Pick<BoardItem, "text" | "status" | "strength" | "source">>;

type SessionEntryLike = { type: string; customType?: string; data?: unknown };
type ContextMessage = ContextEvent["messages"][number];

const CUSTOM_TYPE = "live-decision-board";
const CONTEXT_CUSTOM_TYPE = "live-decision-board-context";
const VISIBLE_CUSTOM_TYPE = "live-decision-board-visible";
const DELTA_CUSTOM_TYPE = "live-decision-board-delta";
const BOARD_CONTEXT_TYPES = new Set([CONTEXT_CUSTOM_TYPE, VISIBLE_CUSTOM_TYPE, DELTA_CUSTOM_TYPE]);

const ACTIVE_BOARD_NUDGE_LIMIT = 12;
const MAX_BOARD_ITEM_TEXT_LENGTH = 500;
const BOARD_MUTATION_BATCH_RULE = "After decision_board mutates the board, reconcile the fresh board context returned by the tool before continuing file edits.";
const BOARD_MUTATION_FRESH_CONTEXT_HINT = "Board changed; this tool result includes the fresh board context, so same-turn file edits may continue after reconciling it.";

const BOARD_ITEM_STATUSES: BoardStatus[] = ["active", "archived"];
const BOARD_ITEM_STRENGTHS: BoardStrength[] = ["soft", "hard"];
const BOARD_ITEM_KINDS: BoardKind[] = ["goal", "assumption", "decision"];
const BOARD_ITEM_SOURCES: BoardSource[] = ["user", "agent", "discussion-loop"];
const BOARD_PATCH_FIELDS = new Set(["text", "status", "strength", "source"]);

export function createEmptyBoard(): BoardState {
	return { version: 0, hardDecisionBarrierVersion: 0, nextGoalId: 1, nextAssumptionId: 1, nextDecisionId: 1, items: [] };
}

export function clearBoard(board: BoardState): BoardState {
	if (!board.items.some(isActiveItem)) return board;
	const nextVersion = board.version + 1;
	const timestamp = now();
	return {
		...board,
		version: nextVersion,
		hardDecisionBarrierVersion: nextVersion,
		items: board.items.map((item) => isActiveItem(item)
			? { ...item, status: "archived" as const, version: nextVersion, updatedAt: timestamp }
			: item),
	};
}

function now(): number {
	return Date.now();
}

function normalizeBoardText(text: string): string {
	const normalized = stripTerminalControlSequences(text).replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
	if (normalized.length > MAX_BOARD_ITEM_TEXT_LENGTH) {
		throw new Error(`Board item text must be ${MAX_BOARD_ITEM_TEXT_LENGTH} characters or fewer`);
	}
	return normalized;
}

function stripTerminalControlSequences(text: string): string {
	return text
		.replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\)|[@-Z\\-_])/g, "")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
}

function tryNormalizeBoardText(text: string): string | undefined {
	try {
		return normalizeBoardText(text);
	} catch {
		return undefined;
	}
}

function isEnforcedItem(item: Pick<BoardItem, "status">): boolean {
	return item.status === "active";
}

function getHardDecisionBarrierVersion(board: BoardState): number {
	return board.hardDecisionBarrierVersion ?? maxEnforcedItemVersion(board.items);
}

function maxEnforcedItemVersion(items: BoardItem[]): number {
	return items.reduce((maxVersion, item) => (isEnforcedItem(item) ? Math.max(maxVersion, item.version) : maxVersion), 0);
}

export function addBoardItem(board: BoardState, input: NewBoardItem): BoardState {
	const text = normalizeBoardText(input.text);
	if (!text) throw new Error("Board item text is required");
	if (!isBoardKind(input.kind)) throw new Error(`Invalid board item kind: ${String(input.kind)}`);

	const nextVersion = board.version + 1;
	const status = input.status ?? "active";
	if (!isBoardStatus(status)) throw new Error(`Invalid board item status: ${String(status)}`);
	const strength = input.strength ?? "soft";
	if (!isBoardStrength(strength)) throw new Error(`Invalid board item strength: ${String(strength)}`);
	const source = input.source ?? "user";
	if (!isBoardSource(source)) throw new Error(`Invalid board item source: ${String(source)}`);
	const id = nextBoardItemId(board, input.kind);
	const timestamp = now();
	const item: BoardItem = {
		id,
		kind: input.kind,
		text,
		status,
		strength,
		source,
		version: nextVersion,
		createdAt: timestamp,
		updatedAt: timestamp,
	};

	const addsActiveGoal = item.kind === "goal" && isActiveItem(item);
	const archivedActiveGoal = addsActiveGoal && board.items.some((existing) => isActiveGoal(existing));
	const existingItems = addsActiveGoal
		? board.items.map((existing) => isActiveGoal(existing) ? { ...existing, status: "archived" as const, version: nextVersion, updatedAt: timestamp } : existing)
		: board.items;

	return {
		version: nextVersion,
		hardDecisionBarrierVersion: isEnforcedItem(item) || archivedActiveGoal
			? nextVersion
			: getHardDecisionBarrierVersion(board),
		nextGoalId: input.kind === "goal" ? board.nextGoalId + 1 : board.nextGoalId,
		nextAssumptionId: input.kind === "assumption" ? board.nextAssumptionId + 1 : board.nextAssumptionId,
		nextDecisionId: input.kind === "decision" ? board.nextDecisionId + 1 : board.nextDecisionId,
		items: [...existingItems, item],
	};
}

function nextBoardItemId(board: BoardState, kind: BoardKind): string {
	if (kind === "goal") return `G${board.nextGoalId}`;
	if (kind === "assumption") return `A${board.nextAssumptionId}`;
	if (kind === "decision") return `D${board.nextDecisionId}`;
	throw new Error(`Invalid board item kind: ${String(kind)}`);
}

function isActiveGoal(item: BoardItem): boolean {
	return item.kind === "goal" && isActiveItem(item);
}

export function updateBoardItem(board: BoardState, id: string, patch: BoardPatch): BoardState {
	const normalizedId = id.trim();
	const existing = board.items.find((item) => item.id === normalizedId);
	if (!existing) throw new Error(`Board item not found: ${normalizedId}`);

	const patchEntries = Object.entries(patch).filter(([, value]) => value !== undefined);
	const unknownField = patchEntries.find(([field]) => !BOARD_PATCH_FIELDS.has(field))?.[0];
	if (unknownField) throw new Error(`Invalid board item patch field: ${unknownField}`);
	const cleanPatch = Object.fromEntries(patchEntries) as BoardPatch;
	if (Object.keys(cleanPatch).length === 0) return board;

	if (cleanPatch.status !== undefined && !isBoardStatus(cleanPatch.status)) {
		throw new Error(`Invalid board item status: ${String(cleanPatch.status)}`);
	}
	if (cleanPatch.strength !== undefined && !isBoardStrength(cleanPatch.strength)) {
		throw new Error(`Invalid board item strength: ${String(cleanPatch.strength)}`);
	}
	if (cleanPatch.source !== undefined && !isBoardSource(cleanPatch.source)) {
		throw new Error(`Invalid board item source: ${String(cleanPatch.source)}`);
	}
	const text = cleanPatch.text === undefined ? existing.text : normalizeBoardText(cleanPatch.text);
	if (!text) throw new Error("Board item text is required");
	const effective: BoardItem = { ...existing, ...cleanPatch, text };
	const changed =
		existing.text !== effective.text ||
		existing.status !== effective.status ||
		existing.strength !== effective.strength ||
		existing.source !== effective.source;
	if (!changed) return board;

	const nextVersion = board.version + 1;
	const timestamp = now();
	const activatesGoal = effective.kind === "goal" && isActiveItem(effective);
	const items = board.items.map((item) => {
		if (item.id === normalizedId) return { ...effective, version: nextVersion, updatedAt: timestamp };
		if (activatesGoal && isActiveGoal(item)) return { ...item, status: "archived" as const, version: nextVersion, updatedAt: timestamp };
		return item;
	});
	const enforcementChanged = hasEnforcedBoundaryChanged(board.items, items);
	return {
		...board,
		version: nextVersion,
		hardDecisionBarrierVersion: enforcementChanged ? nextVersion : getHardDecisionBarrierVersion(board),
		items,
	};
}

function isActiveItem(item: Pick<BoardItem, "status">): boolean {
	return item.status === "active";
}

function activeBoardItems(board: BoardState): BoardItem[] {
	return board.items.filter(isActiveItem);
}

function boardBudgetWarning(board: BoardState): string | undefined {
	const activeCount = activeBoardItems(board).length;
	return activeCount > ACTIVE_BOARD_NUDGE_LIMIT ? `Board has ${activeCount} active items; archive or consolidate before adding more.` : undefined;
}

function formatDecisionBoardToolResult(message: string, board: BoardState, changed = false): string {
	return [message, boardBudgetWarning(board), changed ? BOARD_MUTATION_FRESH_CONTEXT_HINT : undefined, changed ? formatBoardForPrompt(board) : undefined]
		.filter(Boolean)
		.join("\n\n");
}

export type CleanupAction = "keep" | "archive" | "needs_user_review";
export type CleanupRiskLevel = "low risk" | "medium risk" | "high risk";
export type CleanupConfidence = "low" | "medium" | "high";
export type CleanupRecommendationSource = "local" | "imported";

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
	confidence?: CleanupConfidence;
	evidence?: string[];
	source?: CleanupRecommendationSource;
}

interface ReviewCleanupRecommendationInput {
	id: string;
	itemVersion: number;
	observedText: string;
	observedStatus: BoardStatus;
	observedStrength: BoardStrength;
	action: CleanupAction;
	reason: string;
	riskLevel: CleanupRiskLevel;
	requiresExplicitConfirmation: boolean;
	confidence?: CleanupConfidence;
	evidence?: string[];
	selected?: boolean;
}

interface SkippedRecommendation {
	id: string;
	reason: string;
}

const reviewCleanupRecommendationSchema = Type.Record(Type.String(), Type.Any());

export function recommendBoardCleanup(board: BoardState): CleanupRecommendation[] {
	return activeBoardItems(board).sort(compareWidgetItems).map(recommendCleanupForItem);
}

function recommendCleanupForItem(item: BoardItem): CleanupRecommendation {
	const base = cleanupBase(item);
	if (looksHistorical(item.text)) {
		return {
			...base,
			action: "archive",
			selected: true,
			reason: "Looks historical: completed implementation or review-log entry.",
			riskLevel: "low risk",
			requiresExplicitConfirmation: false,
			source: "local",
		};
	}
	return {
		...base,
		action: "keep",
		selected: false,
		reason: "No safe cleanup heuristic matched; keep by default.",
		riskLevel: "low risk",
		requiresExplicitConfirmation: false,
		source: "local",
	};
	}

function cleanupBase(item: BoardItem): Omit<CleanupRecommendation, "action" | "selected" | "reason" | "riskLevel" | "requiresExplicitConfirmation"> {
	return {
		id: item.id,
		itemVersion: item.version,
		observedText: item.text,
		observedStatus: item.status,
		observedStrength: item.strength,
	};
}

function looksHistorical(text: string): boolean {
	return /\b(apply round \d+|review fixes|after the next review round|rename[sd]? \/|add \/board-|fix(?:ed)? .*review|completed|pushed|installed cache|ran (?:npm )?(?:test|tests|typecheck|lint)|npm test|typecheck passed|lint passed)\b/i.test(text);
}

function isCleanupAction(value: unknown): value is CleanupAction {
	return value === "keep" || value === "archive" || value === "needs_user_review";
}

function isCleanupRiskLevel(value: unknown): value is CleanupRiskLevel {
	return value === "low risk" || value === "medium risk" || value === "high risk";
}

function isCleanupConfidence(value: unknown): value is CleanupConfidence {
	return value === "low" || value === "medium" || value === "high";
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReviewCleanupRecommendation(value: unknown): value is ReviewCleanupRecommendationInput {
	if (!isObject(value)) return false;
	const itemVersion = value.itemVersion;
	const observedText = value.observedText;
	const observedStatus = value.observedStatus;
	const observedStrength = value.observedStrength;
	const action = value.action;
	const riskLevel = value.riskLevel;
	const requiresExplicitConfirmation = value.requiresExplicitConfirmation;
	const reason = value.reason;
	const confidence = value.confidence;
	const evidence = value.evidence;
	const selected = value.selected;
	if (typeof value.id !== "string" || !value.id.trim()) return false;
	if (typeof itemVersion !== "number" || !Number.isInteger(itemVersion) || itemVersion <= 0) return false;
	if (typeof observedText !== "string" || !observedText.trim()) return false;
	if (typeof observedStatus !== "string" || !isBoardStatus(observedStatus)) return false;
	if (typeof observedStrength !== "string" || !isBoardStrength(observedStrength)) return false;
	if (typeof action !== "string" || !isCleanupAction(action)) return false;
	if (typeof riskLevel !== "string" || !isCleanupRiskLevel(riskLevel)) return false;
	if (typeof requiresExplicitConfirmation !== "boolean") return false;
	if (typeof reason !== "string" || !reason.trim()) return false;
	if (confidence !== undefined && !isCleanupConfidence(confidence)) return false;
	if (evidence !== undefined && !Array.isArray(evidence)) return false;
	if (Array.isArray(evidence) && !evidence.every((entry) => typeof entry === "string")) return false;
	if (selected !== undefined && typeof selected !== "boolean") return false;
	return true;
}

function normalizeImportedCleanupRecommendations(
	board: BoardState,
	rawRecommendations: unknown[] | undefined,
): { recommendations: CleanupRecommendation[]; skipped: SkippedRecommendation[] } {
	if (!Array.isArray(rawRecommendations)) {
		return { recommendations: [], skipped: [] };
	}
	const boardItems = new Map(board.items.map((item) => [item.id, item] as const));
	const recommendations: CleanupRecommendation[] = [];
	const skipped: SkippedRecommendation[] = [];
	const importedRecommendationIds = new Set<string>();

	for (const rawRecommendation of rawRecommendations) {
		if (!isReviewCleanupRecommendation(rawRecommendation)) {
			const malformedId = isObject(rawRecommendation) && typeof rawRecommendation.id === "string" && rawRecommendation.id.trim() ? rawRecommendation.id : "unknown";
			skipped.push({ id: malformedId, reason: "Malformed cleanup recommendation" });
			continue;
		}
		const recommendation = rawRecommendation as ReviewCleanupRecommendationInput;
		const current = boardItems.get(recommendation.id);
		if (!current) {
			skipped.push({ id: recommendation.id, reason: `Board item ${recommendation.id} not found` });
			continue;
		}
		if (recommendation.itemVersion !== current.version) {
			skipped.push({ id: recommendation.id, reason: `Board item ${recommendation.id} changed since cleanup was prepared` });
			continue;
		}
		if (recommendation.observedText !== current.text || recommendation.observedStatus !== current.status || recommendation.observedStrength !== current.strength) {
			skipped.push({ id: recommendation.id, reason: `Board item ${recommendation.id} changed since cleanup was prepared` });
			continue;
		}
		if (importedRecommendationIds.has(recommendation.id)) {
			skipped.push({ id: recommendation.id, reason: `Duplicate cleanup recommendation for ${recommendation.id}` });
			continue;
		}
		importedRecommendationIds.add(recommendation.id);

		const action = recommendation.action;
		const selected = action === "archive";

		recommendations.push({
			id: recommendation.id,
			itemVersion: recommendation.itemVersion,
			observedText: recommendation.observedText,
			observedStatus: recommendation.observedStatus,
			observedStrength: recommendation.observedStrength,
			action,
			selected,
			reason: recommendation.reason,
			riskLevel: recommendation.riskLevel,
			requiresExplicitConfirmation: recommendation.requiresExplicitConfirmation,
			confidence: recommendation.confidence,
			evidence: recommendation.evidence,
			source: "imported",
		});
	}
	return { recommendations, skipped };
}

export interface CleanupImpact {
	activeBefore: number;
	activeAfter: number;
	archiveCount: number;
	needsUserReviewCount: number;
}

export function summarizeBoardCleanupImpact(board: BoardState, recommendations: CleanupRecommendation[]): CleanupImpact {
	const activeBefore = activeBoardItems(board).length;
	const nextBoard = applyBoardCleanup(board, recommendations);
	return {
		activeBefore,
		activeAfter: activeBoardItems(nextBoard).length,
		archiveCount: recommendations.filter((rec) => rec.selected && rec.action === "archive").length,
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
				next = updateBoardItem(next, recommendation.id, { status: "archived" });
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

export function archiveBoardItem(board: BoardState, id: string, itemVersion: number): BoardState {
	const normalizedId = id.trim();
	const existing = board.items.find((item) => item.id === normalizedId);
	if (!existing) throw new Error(`Board item not found: ${normalizedId}`);
	if (!Number.isInteger(itemVersion) || itemVersion <= 0) {
		throw new Error("Board archive requires a current positive itemVersion");
	}
	if (existing.version !== itemVersion) {
		throw new Error(`Board item ${normalizedId} changed since it was observed`);
	}
	if (!isActiveItem(existing)) return board;
	return updateBoardItem(board, normalizedId, { status: "archived" });
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

function formatCleanupImpactForConfirmation(impact: CleanupImpact, selectedRecommendations: CleanupRecommendation[]): string {
	const archiveRecommendations = selectedRecommendations.filter((recommendation) => recommendation.action === "archive");
	const lines = [
		`Active items: ${impact.activeBefore} → ${impact.activeAfter}`,
		`Archive: ${impact.archiveCount}`,
	];
	if (archiveRecommendations.length > 0) {
		lines.push("", "Archive from active board:", ...archiveRecommendations.map(formatCleanupArchiveConfirmationItem));
	}
	lines.push("", "Apply selected cleanup changes?");
	return lines.join("\n");
}

function formatCleanupArchiveConfirmationItem(recommendation: CleanupRecommendation): string {
	return `- [${recommendation.id}] ${recommendation.observedText}`;
}

export function formatBoardForPrompt(board: BoardState): string {
	const active = activeBoardItems(board);
	const goals = active.filter((item) => item.kind === "goal");
	const assumptions = active.filter((item) => item.kind === "assumption");
	const decisions = active.filter((item) => item.kind === "decision");
	const lines = [`## Live Goal, Assumptions & Decisions — version ${board.version}`, ""];
	lines.push("Rules:");
	lines.push("- Treat every active item as enforced current context before mutating files.");
	lines.push("- If current work conflicts with this board, reconcile before continuing.");
	lines.push("- Keep at most one active Goal plus assumptions or decisions that affect future behavior; do not use the board as an implementation log.");
	lines.push("- When scope or goal changes, archive routine stale/deprecated items after listing the board; use decision_board.review_cleanup for ambiguous current-context changes.");
	lines.push(`- ${BOARD_MUTATION_BATCH_RULE}`);
	const budgetWarning = boardBudgetWarning(board);
	if (budgetWarning) lines.push(`- ${budgetWarning}`);
	lines.push("");
	lines.push("Goal:");
	lines.push(...(goals.length ? goals.map(formatPromptItem) : ["- none"]));
	lines.push("", "Assumptions:");
	lines.push(...(assumptions.length ? assumptions.map(formatPromptItem) : ["- none"]));
	lines.push("", "Decisions:");
	lines.push(...(decisions.length ? decisions.map(formatPromptItem) : ["- none"]));
	return lines.join("\n");
}

function formatPromptItem(item: BoardItem): string {
	return `- ${item.id}: ${item.text} [source:${item.source}, v${item.version}]`;
}

export function formatBoardHistory(board: BoardState): string {
	const active = board.items.filter(isActiveItem);
	const inactive = board.items.filter((item) => !isActiveItem(item));
	const lines = ["# Live Decision Board History", "", formatBoardStatus(board), ""];
	appendHistorySection(lines, "Active items", active);
	lines.push("");
	appendHistorySection(lines, "Inactive history", inactive);
	return lines.join("\n");
}

function appendHistorySection(lines: string[], label: string, items: BoardItem[]): void {
	lines.push(`${label}:`);
	if (items.length === 0) {
		lines.push("- none");
		return;
	}
	lines.push(...items.map(formatHistoryItem));
}

function formatHistoryItem(item: BoardItem): string {
	return `- [${item.id}] ${item.text} [${item.kind}, ${item.status}, source:${item.source}, v${item.version}]`;
}

export function formatBoardStatus(board: BoardState): string {
	const active = activeBoardItems(board);
	const goals = active.filter((item) => item.kind === "goal").length;
	const assumptions = active.filter((item) => item.kind === "assumption").length;
	const decisions = active.filter((item) => item.kind === "decision").length;
	return [`Board v${board.version}`, ...(goals > 0 ? [pluralize(goals, "goal")] : []), pluralize(assumptions, "assumption"), pluralize(decisions, "decision")].join(" • ");
}

function pluralize(count: number, label: string): string {
	return `${count} ${label}${count === 1 ? "" : "s"}`;
}

function formatBoardStatusForWidget(board: BoardState, theme: Theme): string {
	const active = activeBoardItems(board);
	const goals = active.filter((item) => item.kind === "goal").length;
	const assumptions = active.filter((item) => item.kind === "assumption").length;
	const decisions = active.filter((item) => item.kind === "decision").length;
	return [
		theme.fg("muted", "Board"),
		...(goals > 0 ? [theme.fg("success", pluralize(goals, "goal"))] : []),
		theme.fg("success", pluralize(assumptions, "assumption")),
		theme.fg("success", pluralize(decisions, "decision")),
	].join(" • ");
}

function formatBoardWidgetText(board: BoardState, theme: Theme, options: { collapsed?: boolean } = {}): string {
	if (options.collapsed) return formatBoardStatusForWidget(board, theme);
	const [, ...bodyLines] = formatBoardWidget(board);
	return [formatBoardStatusForWidget(board, theme), ...bodyLines.map((line) => colorizeWidgetLine(line, theme))].join("\n");
}

function colorizeWidgetLine(line: string, theme: Theme): string {
	const section = /^(Goal|Decisions|Assumptions) \((\d+)\)$/.exec(line);
	if (section) return `  ${theme.fg("accent", section[1])} ${theme.fg("muted", `(${section[2]})`)}`;

	const item = /^([!•]) (.*)$/.exec(line);
	if (!item) return line;
	return `    ${theme.fg("dim", "•")} ${theme.fg("muted", item[2])}`;
}

export function formatBoardWidget(board: BoardState, options: { maxItems?: number } = {}): string[] {
	const maxItems = options.maxItems ?? Number.POSITIVE_INFINITY;
	const active = activeBoardItems(board).sort(compareWidgetItems);
	const goals = active.filter((item) => item.kind === "goal");
	const decisions = active.filter((item) => item.kind === "decision");
	const assumptions = active.filter((item) => item.kind === "assumption");

	const lines = [formatBoardStatus(board)];
	let remainingItems = maxItems;
	remainingItems = appendWidgetSection(lines, "Goal", goals, remainingItems);
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
		lines.push(`• ${item.text}`);
	}
	const hiddenItems = items.length - visibleItems.length;
	if (hiddenItems > 0) lines.push(`… ${pluralize(hiddenItems, `more ${singularLabel}`)}`);
	return remainingItems - visibleItems.length;
}

export function hasUninjectedEnforcedChanges(board: BoardState, injectedVersion: number): boolean {
	return getHardDecisionBarrierVersion(board) > injectedVersion;
}

export function hasUninjectedHardChanges(board: BoardState, injectedVersion: number): boolean {
	return hasUninjectedEnforcedChanges(board, injectedVersion);
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
		(candidate.nextGoalId !== undefined && !isPositiveInteger(candidate.nextGoalId)) ||
		!isPositiveInteger(candidate.nextAssumptionId) ||
		!isPositiveInteger(candidate.nextDecisionId) ||
		!Array.isArray(candidate.items) ||
		(candidate.hardDecisionBarrierVersion !== undefined && !isNonNegativeInteger(candidate.hardDecisionBarrierVersion))
	) {
		return undefined;
	}
	const restoredItems = candidate.items.map(normalizeRestoredBoardItem);
	if (restoredItems.some((item) => item === undefined)) return undefined;

	const version = candidate.version;
	const items = restoredItems as BoardItem[];
	if (items.some((item) => item.version > version)) return undefined;

	const seenIds = new Set<string>();
	let maxGoalId = 0;
	let maxAssumptionId = 0;
	let maxDecisionId = 0;
	let activeGoalCount = 0;
	for (const item of items) {
		if (seenIds.has(item.id)) return undefined;
		seenIds.add(item.id);
		const numericId = Number.parseInt(item.id.slice(1), 10);
		if (item.kind === "goal") {
			maxGoalId = Math.max(maxGoalId, numericId);
			if (isActiveItem(item)) activeGoalCount += 1;
		} else if (item.kind === "assumption") maxAssumptionId = Math.max(maxAssumptionId, numericId);
		else maxDecisionId = Math.max(maxDecisionId, numericId);
	}
	if (activeGoalCount > 1) return undefined;

	const requiredBarrier = maxEnforcedItemVersion(items);
	const restoredBarrier = candidate.hardDecisionBarrierVersion ?? requiredBarrier;
	return {
		version,
		hardDecisionBarrierVersion: Math.min(version, Math.max(restoredBarrier, requiredBarrier)),
		nextGoalId: Math.max(candidate.nextGoalId ?? 1, maxGoalId + 1),
		nextAssumptionId: Math.max(candidate.nextAssumptionId, maxAssumptionId + 1),
		nextDecisionId: Math.max(candidate.nextDecisionId, maxDecisionId + 1),
		items,
	};
}

function normalizeRestoredBoardItem(value: unknown): BoardItem | undefined {
	if (!value || typeof value !== "object") return undefined;
	const item = value as Partial<BoardItem> & { status?: unknown };
	const status = normalizeRestoredBoardStatus(item.status);
	const text = typeof item.text === "string" ? tryNormalizeBoardText(item.text) : undefined;
	if (
		typeof item.id !== "string" ||
		!/^[GAD]\d+$/.test(item.id) ||
		!isBoardKind(item.kind ?? "") ||
		!((item.id.startsWith("G") && item.kind === "goal") || (item.id.startsWith("A") && item.kind === "assumption") || (item.id.startsWith("D") && item.kind === "decision")) ||
		!text ||
		!status ||
		!isBoardStrength(item.strength ?? "") ||
		!isBoardSource(item.source ?? "") ||
		!isPositiveInteger(item.version) ||
		!isNonNegativeFiniteNumber(item.createdAt) ||
		!isNonNegativeFiniteNumber(item.updatedAt)
	) {
		return undefined;
	}
	return {
		id: item.id,
		kind: item.kind,
		text,
		status,
		strength: item.strength as BoardStrength,
		source: item.source as BoardSource,
		version: item.version,
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
	};
}

function normalizeRestoredBoardStatus(value: unknown): BoardStatus | undefined {
	if (value === "active" || value === "archived") return value;
	if (value === "proposed" || value === "accepted") return "active";
	if (value === "rejected" || value === "superseded") return "archived";
	return undefined;
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
		lines.push("_No goal, assumptions, or decisions yet._");
		return `${lines.join("\n")}\n`;
	}

	for (const item of board.items) {
		lines.push(`- ${item.id} | ${item.kind} | ${item.status} | ${item.text}`);
	}
	return `${lines.join("\n")}\n`;
}

export function parseBoardMarkdown(markdown: string, previousBoard: BoardState): BoardState {
	const previousById = new Map(previousBoard.items.map((item) => [item.id, item]));
	const nextVersion = previousBoard.version + 1;
	const timestamp = now();
	const items: BoardItem[] = [];
	let maxGoalId = 0;
	let maxAssumptionId = 0;
	let maxDecisionId = 0;

	for (const [lineIndex, rawLine] of markdown.split(/\r?\n/).entries()) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#") || line.startsWith("_")) continue;
		if (!line.startsWith("- ")) {
			throw new Error(`Invalid board markdown line ${lineIndex + 1}: expected '- ID | kind | status | text'`);
		}

		const fields = line.slice(2).split("|").map((field) => field.trim());
		if (fields.length < 4) {
			throw new Error(`Invalid board markdown line ${lineIndex + 1}: expected 4 pipe-separated fields`);
		}

		const [id, kind, status = "active"] = fields;
		const previous = previousById.get(id.trim());
		const hasStoredMetadataColumn = fields.length >= 5 && isBoardStrength(fields[3]);
		const strength = hasStoredMetadataColumn ? fields[3] : previous?.strength ?? "soft";
		const text = (hasStoredMetadataColumn ? fields.slice(4) : fields.slice(3)).join(" | ").trim();
		const parsedItem = parseMarkdownItem({ id, kind, status, strength, text, lineIndex, previousById, nextVersion, timestamp });

		if (items.some((item) => item.id === parsedItem.id)) {
			throw new Error(`Duplicate board item id: ${parsedItem.id}`);
		}

		items.push(parsedItem);
		const numericId = Number.parseInt(parsedItem.id.slice(1), 10);
		if (parsedItem.kind === "goal") maxGoalId = Math.max(maxGoalId, numericId);
		else if (parsedItem.kind === "assumption") maxAssumptionId = Math.max(maxAssumptionId, numericId);
		else maxDecisionId = Math.max(maxDecisionId, numericId);
	}
	if (items.filter(isActiveGoal).length > 1) {
		throw new Error("Live Decision Board can have only one active goal");
	}
	const parsedIds = new Set(items.map((item) => item.id));
	for (const previous of previousBoard.items) {
		if (!parsedIds.has(previous.id)) {
			throw new Error(`Board markdown cannot omit existing board item ${previous.id}; archive it instead`);
		}
	}

	return {
		version: nextVersion,
		hardDecisionBarrierVersion: hasEnforcedBoundaryChanged(previousBoard.items, items)
			? nextVersion
			: getHardDecisionBarrierVersion(previousBoard),
		nextGoalId: Math.max(previousBoard.nextGoalId, maxGoalId + 1),
		nextAssumptionId: Math.max(previousBoard.nextAssumptionId, maxAssumptionId + 1),
		nextDecisionId: Math.max(previousBoard.nextDecisionId, maxDecisionId + 1),
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
	if (!/^[GAD]\d+$/.test(id)) throw new Error(`Invalid board item id on line ${input.lineIndex + 1}: ${id}`);
	if (!isBoardKind(input.kind)) throw new Error(`Invalid board item kind on line ${input.lineIndex + 1}: ${input.kind}`);
	if (!isBoardStatus(input.status)) throw new Error(`Invalid board item status on line ${input.lineIndex + 1}: ${input.status}`);
	if (!isBoardStrength(input.strength)) {
		throw new Error(`Invalid board item metadata on line ${input.lineIndex + 1}`);
	}
	const text = normalizeBoardText(input.text);
	if (!text) throw new Error(`Missing board item text on line ${input.lineIndex + 1}`);
	if ((id.startsWith("G") && input.kind !== "goal") || (id.startsWith("A") && input.kind !== "assumption") || (id.startsWith("D") && input.kind !== "decision")) {
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

function hasEnforcedBoundaryChanged(previousItems: BoardItem[], nextItems: BoardItem[]): boolean {
	const nextById = new Map(nextItems.map((item) => [item.id, item]));
	const previousById = new Map(previousItems.map((item) => [item.id, item]));

	for (const previous of previousItems) {
		if (!isEnforcedItem(previous)) continue;
		const next = nextById.get(previous.id);
		if (!next || enforcedBoundaryChanged(previous, next)) return true;
	}

	for (const next of nextItems) {
		if (!isEnforcedItem(next)) continue;
		const previous = previousById.get(next.id);
		if (!previous || enforcedBoundaryChanged(previous, next)) return true;
	}

	return false;
}

function isSameEnforcedBoundary(left: BoardItem, right: BoardItem): boolean {
	return (
		left.kind === right.kind &&
		left.text === right.text &&
		left.status === right.status
	);
}

function enforcedBoundaryChanged(left: BoardItem, right: BoardItem): boolean {
	return isEnforcedItem(left) || isEnforcedItem(right) ? !isSameEnforcedBoundary(left, right) : false;
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
	| { type: "clear" }
	| { type: "edit" | "archive"; id: string };

type CleanupReviewResult = { type: "cancel" } | { type: "apply"; recommendations: CleanupRecommendation[] };

function compareManagerItems(a: BoardItem, b: BoardItem): number {
	const activeRank = Number(isActiveItem(b)) - Number(isActiveItem(a));
	if (activeRank !== 0) return activeRank;
	const kindRank = managerKindRank(a.kind) - managerKindRank(b.kind);
	if (kindRank !== 0) return kindRank;
	return compareWidgetItems(a, b);
}

function managerKindRank(kind: BoardKind): number {
	if (kind === "goal") return 0;
	if (kind === "decision") return 1;
	return 2;
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
		if (data === "c") {
			this.done({ type: "clear" });
			return;
		}

		const selected = this.items[this.selectedIndex];
		if (!selected) return;
		if (matchesKey(data, Key.enter) || data === "e") this.done({ type: "edit", id: selected.id });
		else if (data === "r") this.done({ type: "archive", id: selected.id });
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const activeCount = this.items.filter(isActiveItem).length;
		const inactiveCount = this.items.length - activeCount;
		const lines = [
			this.header(width),
			truncateToWidth(`Board v${this.board.version} • ${pluralize(activeCount, "active item")} • ${pluralize(inactiveCount, "inactive item")}`, width),
			"",
		];

		if (this.items.length === 0) {
			lines.push(truncateToWidth(this.theme.fg("dim", "No board items yet. Use /goal, /assume, or /decide to add one."), width));
		} else {
			for (const [index, item] of this.items.entries()) {
				lines.push(this.renderItem(item, index, width));
			}
		}

		lines.push(
			"",
			truncateToWidth(this.theme.fg("dim", "↑↓/j/k select • enter/e edit • r archive • c clear active • q/esc close"), width),
			truncateToWidth(this.theme.fg("dim", "edit rewrites item text • clear/archive keeps history"), width),
		);
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
		const kind = this.theme.fg("accent", item.kind);
		const statusColor = item.status === "active" ? "success" : "dim";
		const status = this.theme.fg(statusColor, item.status);
		const text = isActiveItem(item) ? this.theme.fg("muted", item.text) : this.theme.fg("dim", item.text);
		return truncateToWidth(`${marker} ${kind} ${status} ${text}`, width);
	}

	private moveSelection(delta: number): void {
		if (this.items.length === 0) return;
		this.selectedIndex = Math.max(0, Math.min(this.items.length - 1, this.selectedIndex + delta));
		this.invalidate();
		this.requestRender();
	}
}

class BoardCleanupComponent {
	private readonly recommendations: CleanupRecommendation[];
	private readonly originalActions: Map<string, CleanupAction>;
	private selectedIndex = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		recommendations: CleanupRecommendation[],
		private readonly theme: Theme,
		private readonly done: (result: CleanupReviewResult) => void,
		private readonly requestRender: () => void,
	) {
		this.recommendations = recommendations
			.map((recommendation, index) => ({ recommendation: { ...recommendation }, index }))
			.sort((left, right) => {
				const actionOrder = this.actionOrder(left.recommendation.action) - this.actionOrder(right.recommendation.action);
				if (actionOrder !== 0) return actionOrder;
				return left.index - right.index;
			})
			.map(({ recommendation }) => recommendation);
		this.originalActions = new Map(this.recommendations.map((recommendation) => [recommendation.id, recommendation.action]));
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") {
			this.done({ type: "cancel" });
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

		if (matchesKey(data, Key.space)) {
			this.toggleSelection();
			return;
		}

		if (matchesKey(data, Key.enter)) {
			this.done({ type: "apply", recommendations: this.recommendations.map((recommendation) => ({ ...recommendation })) });
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const helpLine = truncateToWidth(this.theme.fg("dim", "↑↓/j/k select • space toggle • enter apply selected • q/esc cancel"), width);
		const riskLegend = truncateToWidth(this.theme.fg("dim", "risk: low risk=safe cleanup • medium risk=needs judgment • high risk=likely current context"), width);
		const lines = [
			this.header(width),
			truncateToWidth(this.summaryLine(), width),
			helpLine,
			riskLegend,
			"",
		];

		if (this.recommendations.length === 0) {
			lines.push(truncateToWidth(this.theme.fg("dim", "No cleanup recommendations."), width));
		} else {
			for (const [index, recommendation] of this.recommendations.entries()) {
				const rendered = this.renderRecommendation(recommendation, index, width);
				lines.push(rendered.main);
				lines.push(rendered.reason);
			}
		}

		lines.push("");
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private header(width: number): string {
		const title = ` ${this.theme.fg("accent", "Board Cleanup")} `;
		return truncateToWidth(`${this.theme.fg("dim", "────")} ${title}${this.theme.fg("dim", "────")}`, width);
	}

	private summaryLine(): string {
		const archiveCount = this.recommendations.filter((rec) => rec.selected && rec.action === "archive").length;
		const selectedParts = [
			...(archiveCount > 0 ? [`${pluralize(archiveCount, "archive suggestion")} selected`] : []),
		];
		return `${pluralize(this.recommendations.length, "board item")} to review • ${selectedParts.length ? selectedParts.join(" • ") : "no cleanup changes selected"}`;
	}

	private moveSelection(delta: number): void {
		if (this.recommendations.length === 0) return;
		this.selectedIndex = Math.max(0, Math.min(this.recommendations.length - 1, this.selectedIndex + delta));
		this.invalidate();
		this.requestRender();
	}

	private toggleSelection(): void {
		const recommendation = this.recommendations[this.selectedIndex];
		if (!recommendation) return;
		if (recommendation.selected) {
			recommendation.selected = false;
			this.restoreManualArchiveOverride(recommendation);
		} else {
			recommendation.selected = true;
			this.applyManualArchiveOverride(recommendation);
		}
		this.invalidate();
		this.requestRender();
	}

	private applyManualArchiveOverride(recommendation: CleanupRecommendation): void {
		if (recommendation.action === "keep" || recommendation.action === "needs_user_review") {
			recommendation.action = "archive";
		}
	}

	private restoreManualArchiveOverride(recommendation: CleanupRecommendation): void {
		const originalAction = this.originalActions.get(recommendation.id);
		if (originalAction && recommendation.action === "archive") {
			recommendation.action = originalAction;
		}
	}

	private renderRecommendation(recommendation: CleanupRecommendation, index: number, width: number): { main: string; reason: string } {
		const selected = index === this.selectedIndex;
		const cursor = selected ? this.theme.fg("accent", ">") : " ";
		const checkbox = recommendation.selected ? this.theme.fg("success", "[x]") : this.theme.fg("dim", "[ ]");
		const id = this.theme.fg("accent", `[${recommendation.id}]`);
		const statusColor = recommendation.observedStatus === "active" ? "success" : "dim";
		const status = this.theme.fg(statusColor, recommendation.observedStatus);
		const action = this.theme.fg("warning", this.actionLabel(recommendation.action));
		const risk = this.theme.fg("muted", recommendation.riskLevel);
		const text = this.theme.fg("muted", recommendation.observedText);
		return {
			main: truncateToWidth(`${cursor} ${checkbox} ${id} ${status} ${action} • ${risk} • ${text}`, width),
			reason: truncateToWidth(this.theme.fg("dim", `  ${recommendation.reason}`), width),
		};
	}

	private actionLabel(action: CleanupAction): string {
		switch (action) {
			case "archive":
				return "Archive from active board";
			case "needs_user_review":
				return "Needs user review";
			case "keep":
				return "Keep";
		}
	}

	private actionOrder(action: CleanupAction): number {
		switch (action) {
			case "archive":
				return 0;
			case "needs_user_review":
				return 1;
			case "keep":
				return 2;
		}
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
		if (activeBoardItems(board).length === 0) {
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

	function showBoardHistory(): void {
		pi.sendMessage({
			customType: VISIBLE_CUSTOM_TYPE,
			content: formatBoardHistory(board),
			display: true,
			details: {
				boardVersion: board.version,
				activeItemCount: activeBoardItems(board).length,
				inactiveItemCount: board.items.filter((item) => !isActiveItem(item)).length,
			},
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

	function markBoardObservedFromToolResult(changed: boolean): void {
		if (changed) lastInjectedBoardVersion = board.version;
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
			if (!action) return;
			if (action.type === "close") return;
			if (boardEpoch !== baseEpoch) {
				ctx.ui.notify("Live Decision Board changed while manager was open; action skipped and manager refreshed.", "warning");
				continue;
			}
			await applyBoardManagerAction(ctx, action);
		}
	}

	async function applyBoardManagerAction(ctx: ExtensionContext, action: Exclude<BoardManagerAction, { type: "close" }>): Promise<void> {
		if (action.type === "clear") {
			await confirmAndClearBoard(ctx, "Live Decision Board changed while clear confirmation was open; rerun /board-manage on the latest board.");
			return;
		}

		const item = board.items.find((candidate) => candidate.id === action.id);
		if (!item) {
			ctx.ui.notify(`Board item not found: ${action.id}`, "error");
			return;
		}

		if (action.type === "edit") {
			await editBoardManagerItem(ctx, item);
			return;
		}
		switch (action.type) {
			case "archive":
				safeApplyBoard(ctx, "Archived item", () => updateBoardItem(board, item.id, { status: "archived" }));
				return;
		}
	}

	async function editBoardManagerItem(ctx: ExtensionContext, item: BoardItem): Promise<void> {
		const baseEpoch = boardEpoch;
		const edited = await ctx.ui.editor(`Edit ${item.kind}`, item.text);
		if (!edited || edited.trim() === item.text.trim()) return;
		if (boardEpoch !== baseEpoch) {
			ctx.ui.notify("Live Decision Board changed while item editor was open; reopen /board-manage and apply your edit to the latest board.", "warning");
			return;
		}
		safeApplyBoard(ctx, "Edited item", () => updateBoardItem(board, item.id, { text: edited }));
	}

	async function confirmAndClearBoard(ctx: ExtensionContext, staleMessage: string): Promise<void> {
		const baseEpoch = boardEpoch;
		if (!ctx.hasUI) {
			ctx.ui.notify("/board-clear requires UI mode for interactive confirmation.", "error");
			return;
		}
		const confirmed = await ctx.ui.confirm(
			"Clear Active Board?",
			"This archives all active goal, assumptions, and decisions for this branch while keeping board history.",
		);
		if (!confirmed) return;
		if (boardEpoch !== baseEpoch) {
			ctx.ui.notify(staleMessage, "warning");
			return;
		}
		safeApplyBoard(ctx, "Cleared active board", () => clearBoard(board));
	}

	type CleanupReviewRunResult = {
		changed: boolean;
		appliedRecommendations: number;
	};

	async function runCleanupReview(
		ctx: ExtensionContext,
		recommendations: CleanupRecommendation[],
		options?: {
			noActionableMessage?: string;
			staleMessage?: string;
		},
	): Promise<CleanupReviewRunResult> {
		const noActionableMessage = options?.noActionableMessage ?? "Board cleanup: no selected changes";
		const staleMessage = options?.staleMessage ?? "Live Decision Board changed while cleanup was open; rerun /board-cleanup on the latest board.";
		const baseEpoch = boardEpoch;
		const result = await ctx.ui.custom<CleanupReviewResult>(
			(tui, theme, _keybindings, done) => new BoardCleanupComponent(recommendations, theme, done, () => tui.requestRender()),
			{ overlay: true, overlayOptions: { width: "90%", minWidth: 70, maxHeight: "80%" } },
		);
		if (!result || result.type === "cancel") return { changed: false, appliedRecommendations: 0 };
		if (boardEpoch !== baseEpoch) {
			ctx.ui.notify(staleMessage, "warning");
			return { changed: false, appliedRecommendations: 0 };
		}

		const actionableRecommendations = result.recommendations.filter(
			(recommendation) => recommendation.selected && recommendation.action === "archive",
		);
		if (actionableRecommendations.length === 0) {
			ctx.ui.notify(noActionableMessage, "info");
			return { changed: false, appliedRecommendations: 0 };
		}

		const impact = summarizeBoardCleanupImpact(board, result.recommendations);
		const confirmed = await ctx.ui.confirm("Apply Board Cleanup?", formatCleanupImpactForConfirmation(impact, actionableRecommendations));
		if (!confirmed) return { changed: false, appliedRecommendations: 0 };
		if (boardEpoch !== baseEpoch) {
			ctx.ui.notify(staleMessage, "warning");
			return { changed: false, appliedRecommendations: 0 };
		}
		const changed = safeApplyBoard(ctx, "Cleaned board", () => applyBoardCleanup(board, result.recommendations));
		return { changed, appliedRecommendations: actionableRecommendations.length };
	}

	async function cleanupBoard(ctx: ExtensionContext): Promise<void> {
		const recommendations = recommendBoardCleanup(board);
		if (recommendations.length === 0) {
			ctx.ui.notify("No active board items to clean up", "info");
			return;
		}
		await runCleanupReview(ctx, recommendations);
	}

	pi.on("session_start", async (_event, ctx) => {
		restoreBoard(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreBoard(ctx);
	});

	pi.registerCommand("board-snapshot", {
		description: "Show the active context snapshot of the live goal/assumptions/decisions board as a visible message",
		handler: async (_args, _ctx) => showBoard(),
	});

	pi.registerCommand("board-history", {
		description: "Show active and inactive archived board history as a visible message",
		handler: async (_args, _ctx) => showBoardHistory(),
	});

	pi.registerCommand("board-toggle", {
		description: "Collapse or expand the persistent live goal/assumptions/decisions board widget body",
		handler: async (_args, ctx) => {
			widgetExpanded = !widgetExpanded;
			updateUi(ctx);
			ctx.ui.notify(
				widgetExpanded
					? "Live Decision Board widget expanded"
					: "Live Decision Board widget collapsed; summary remains visible, and the board still updates, injects into context, and enforces active items.",
				"info",
			);
		},
	});

	pi.registerCommand("board-manage", {
		description: "Primary TUI for live board item actions: edit, archive, or clear active",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return ctx.ui.notify("/board-manage requires TUI mode", "error");
			await manageBoard(ctx);
		},
	});

	pi.registerCommand("board-cleanup", {
		description: "TUI review of active board items with user-confirmed archive cleanup",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return ctx.ui.notify("/board-cleanup requires TUI mode", "error");
			await cleanupBoard(ctx);
		},
	});

	pi.registerCommand("goal", {
		description: "Set the single current goal on the live board",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) return ctx.ui.notify("Usage: /goal <text>", "warning");
			safeApplyBoard(ctx, "Set current goal", () => addBoardItem(board, { kind: "goal", text, source: "user" }));
		},
	});

	pi.registerCommand("assume", {
		description: "Add an active assumption to the live board",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) return ctx.ui.notify("Usage: /assume <text>", "warning");
			safeApplyBoard(ctx, "Added assumption", () => addBoardItem(board, { kind: "assumption", text, source: "user" }));
		},
	});

	pi.registerCommand("decide", {
		description: "Add an active decision to the live board",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) return ctx.ui.notify("Usage: /decide <text>", "warning");
			safeApplyBoard(ctx, "Added decision", () => addBoardItem(board, { kind: "decision", text, source: "user" }));
		},
	});

	function archiveBoardById(args: string, ctx: ExtensionContext): boolean {
		return safeApplyBoard(ctx, "Archived item", () => updateBoardItem(board, args.trim(), { status: "archived" }));
	}

	pi.registerCommand("board-archive", {
		description: "Power-user fallback: archive a board item by id; prefer /board-manage",
		handler: async (args, ctx) => {
			archiveBoardById(args, ctx);
		},
	});

	pi.registerCommand("board-clear", {
		description: "Power-user fallback: archive all active board items after confirmation; prefer /board-manage",
		handler: async (_args, ctx) => {
			await confirmAndClearBoard(ctx, "Live Decision Board changed while confirmation was open; rerun /board-clear on the latest board.");
		},
	});

	pi.registerCommand("board", {
		description: "Power-user editor for the live board markdown",
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
		description: "List or update the live goal/assumptions/decisions board.",
		promptSnippet: "List or update the current goal, assumptions, and decisions for the current project.",
		promptGuidelines: [
			"Use decision_board to record one current goal plus active assumptions or decisions and enforce them as the current contract for this work.",
			"Use decision_board before acting on a decision that is not already recorded in the live board.",
			"Use decision_board as a current-context contract, not as an implementation log for progress updates, tests run, files changed, or completed review batches.",
			BOARD_MUTATION_BATCH_RULE,
			"When scope changes, goals change, or active board items become stale, clean the board automatically: list it, archive routine deprecated items with observed itemVersion and reason, and use decision_board.review_cleanup for ambiguous current-context changes.",
			"Do not add active board items saying cleanup happened; do not spawn separate cleanup agents unless the user explicitly requests them.",
			"Use decision_board update only for same-meaning text corrections after listing the current board; include the observed itemVersion.",
			"Use decision_board archive only for routine deprecated or stale active items after listing the current board; include the observed itemVersion and a reason, and prefer review_cleanup when current-context impact is ambiguous.",
			"Avoid using ask_user for cleanup recommendations; invoke review_cleanup and let that workflow handle interactive confirmation before mutation.",
		],
		executionMode: "sequential",
		parameters: Type.Object({
			action: StringEnum(["list", "add", "update", "archive", "review_cleanup"] as const),
			id: Type.Optional(Type.String()),
			kind: Type.Optional(StringEnum(["goal", "assumption", "decision"] as const)),
			text: Type.Optional(Type.String()),
			itemVersion: Type.Optional(Type.Number()),
			reason: Type.Optional(Type.String()),
			recommendations: Type.Optional(Type.Array(reviewCleanupRecommendationSchema)),
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
					status: "active",
					source: "agent",
				});
				const item = nextBoard.items.at(-1)!;
				const result = commitBoard(nextBoard, ctx, "agent");
				markBoardObservedFromToolResult(result.changed);
				return { content: [{ type: "text", text: formatDecisionBoardToolResult(`Added ${item.id}: ${item.text}`, board, result.changed) }], details: { board, item } };
			}

			if (params.action === "review_cleanup") {
				if (!ctx.hasUI || ctx.mode !== "tui") {
					return {
						content: [
							{
								type: "text",
								text: "decision_board review_cleanup requires an interactive TUI review surface and cannot run in non-UI mode.",
							},
						],
						details: { board },
					};
				}
				const normalized = normalizeImportedCleanupRecommendations(board, params.recommendations);
				if (normalized.recommendations.length === 0) {
					return {
						content: [{
							type: "text",
							text: `${normalized.skipped.length > 0 ? `${normalized.skipped.length} recommendations skipped before review. ` : ""}No fresh recommendations available for review_cleanup.`,
						}],
						details: { skipped: normalized.skipped, boardVersion: board.version },
					};
				}
				const result = await runCleanupReview(ctx, normalized.recommendations, {
					noActionableMessage: "review_cleanup: no selected actionable imported recommendations",
					staleMessage: "Live Decision Board changed while review_cleanup was open; rerun decision_board.review_cleanup on the latest board.",
				});
				markBoardObservedFromToolResult(result.changed);
				return {
					content: [{
						type: "text",
						text: formatDecisionBoardToolResult(`Reviewed ${normalized.recommendations.length} recommendation(s) for cleanup. ${result.changed ? `Applied ${result.appliedRecommendations} action(s).` : "No changes applied."}${
							normalized.skipped.length > 0 ? ` ${normalized.skipped.length} skipped.` : ""
						}`, board, result.changed),
					}],
					details: {
						board,
						reviewed: normalized.recommendations.length,
						skipped: normalized.skipped,
						applied: result.appliedRecommendations,
					},
				};
			}

			const targetId = params.id?.trim();
			if (!targetId) throw new Error(`decision_board ${params.action} requires id`);

			if (params.action === "archive") {
				const reason = params.reason?.trim();
				if (!reason) throw new Error("decision_board archive requires reason explaining why the item is deprecated or stale");
				if (typeof params.itemVersion !== "number") throw new Error("decision_board archive requires itemVersion from the current board listing");
				const current = board.items.find((item) => item.id === targetId);
				if (!current) throw new Error(`Board item not found: ${targetId}`);
				const nextBoard = archiveBoardItem(board, targetId, params.itemVersion);
				if (nextBoard === board) {
					return {
						content: [{ type: "text", text: `No change: ${targetId} is already inactive` }],
						details: { board, item: current, boardContext: formatBoardForPrompt(board) },
					};
				}
				const result = commitBoard(nextBoard, ctx, "agent");
				markBoardObservedFromToolResult(result.changed);
				return {
					content: [{ type: "text", text: formatDecisionBoardToolResult(result.changed ? `Archived ${targetId}: ${reason}` : `No change for ${targetId}`, board, result.changed) }],
					details: { board, item: board.items.find((item) => item.id === targetId), boardContext: formatBoardForPrompt(board) },
				};
			}

			let nextBoard: BoardState;
			if (params.action === "update") {
				if (!params.text?.trim()) throw new Error("decision_board update requires non-empty text");
				if (typeof params.itemVersion !== "number") throw new Error("decision_board update requires itemVersion from the current board listing");
				const current = board.items.find((item) => item.id === targetId);
				if (!current) throw new Error(`Board item not found: ${targetId}`);
				if (!Number.isInteger(params.itemVersion) || params.itemVersion <= 0) throw new Error("decision_board update requires a current positive itemVersion");
				if (current.version !== params.itemVersion) throw new Error(`Board item ${targetId} changed since it was observed`);
				nextBoard = updateBoardItem(board, targetId, { text: params.text });
			} else {
				throw new Error(`Unsupported decision_board action: ${String(params.action)}`);
			}
			const result = commitBoard(nextBoard, ctx, "agent");
			markBoardObservedFromToolResult(result.changed);
			return {
				content: [{ type: "text", text: formatDecisionBoardToolResult(result.changed ? `Updated ${targetId}` : `No change for ${targetId}`, board, result.changed) }],
				details: { board },
			};
		},
	});

	pi.on("context", async (event) => {
		const filtered = event.messages.filter((message) => !BOARD_CONTEXT_TYPES.has(getCustomType(message)));
		if (activeBoardItems(board).length === 0 && !hasUninjectedEnforcedChanges(board, lastInjectedBoardVersion)) {
			return { messages: filtered };
		}
		lastInjectedBoardVersion = board.version;
		return { messages: [boardContextForProvider(), ...filtered] };
	});

	pi.on("before_agent_start", async () => {
		if (activeBoardItems(board).length === 0 && !hasUninjectedEnforcedChanges(board, lastInjectedBoardVersion)) return;
		return { message: boardContextForSession() };
	});

	pi.on("tool_call", async (event) => {
		if (!isMutatingToolCall(event.toolName, event.input as Record<string, unknown>)) return;
		if (!hasUninjectedEnforcedChanges(board, lastInjectedBoardVersion)) return;
		return {
			block: true,
			reason: `Live Decision Board changed after the agent last received it in provider context. Current board v${board.version}, injected v${lastInjectedBoardVersion}. Re-read/reconcile the board before mutating files.`,
		};
	});
}
