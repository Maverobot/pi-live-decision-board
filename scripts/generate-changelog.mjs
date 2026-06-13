#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const changelogPath = resolve(root, "CHANGELOG.md");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

const sectionOrder = ["Breaking Changes", "Added", "Fixed", "Changed", "Documentation", "Tests", "Maintenance", "Other"];
const typeSections = new Map([
	["feat", "Added"],
	["fix", "Fixed"],
	["perf", "Changed"],
	["refactor", "Changed"],
	["docs", "Documentation"],
	["test", "Tests"],
	["ci", "Maintenance"],
	["build", "Maintenance"],
	["chore", "Maintenance"],
	["revert", "Other"],
]);

function git(args) {
	return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function maybeGit(args) {
	try {
		return git(args);
	} catch {
		return "";
	}
}

function parseCommit(record) {
	const [hash, date, subject] = record.split("\x1f");
	return { hash, date, subject };
}

function parseSubject(subject) {
	const match = /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<breaking>!)?:\s*(?<description>.+)$/iu.exec(subject);
	if (!match?.groups) return { section: "Other", description: subject, breaking: false };
	const section = typeSections.get(match.groups.type.toLowerCase()) ?? "Other";
	const scope = match.groups.scope ? `${match.groups.scope}: ` : "";
	return {
		section,
		description: `${scope}${match.groups.description}`,
		breaking: Boolean(match.groups.breaking),
	};
}

function isChangelogMaintenanceCommit(subject) {
	return /^(?:docs|chore)(?:\([^)]+\))?:\s+.*\b(changelog|release)\b/iu.test(subject);
}

function collectCommits() {
	const latestTag = maybeGit(["describe", "--tags", "--abbrev=0"]);
	const head = maybeGit(["rev-parse", "HEAD"]);
	let range = [];
	if (latestTag) {
		const latestTagCommit = maybeGit(["rev-list", "-n", "1", latestTag]);
		if (latestTagCommit === head) {
			const previousTag = maybeGit(["describe", "--tags", "--abbrev=0", `${latestTag}^`]);
			range = previousTag ? [`${previousTag}..${latestTag}`] : [latestTag];
		} else {
			range = [`${latestTag}..HEAD`];
		}
	}
	const raw = git(["log", "--format=%H%x1f%cs%x1f%s%x1e", ...range]);
	return raw
		.split("\x1e")
		.map((record) => record.trim())
		.filter(Boolean)
		.map(parseCommit)
		.filter((commit) => !isChangelogMaintenanceCommit(commit.subject));
}

function buildChangelog(commits) {
	const groups = new Map(sectionOrder.map((section) => [section, []]));
	for (const commit of commits) {
		const parsed = parseSubject(commit.subject);
		const targetSections = parsed.breaking ? ["Breaking Changes", parsed.section] : [parsed.section];
		for (const section of targetSections) {
			groups.get(section)?.push(`- ${parsed.description} (${commit.hash.slice(0, 7)})`);
		}
	}

	const latestCommitDate = commits[0]?.date ?? new Date().toISOString().slice(0, 10);
	const lines = [
		"# Changelog",
		"",
		"All notable changes to this project are documented in this file.",
		"",
		"Entries are inferred from conventional git commit messages. Regenerate with `npm run changelog`.",
		"",
		`## ${packageJson.version} - ${latestCommitDate}`,
		"",
	];

	for (const section of sectionOrder) {
		const entries = groups.get(section) ?? [];
		if (entries.length === 0) continue;
		lines.push(`### ${section}`, "", ...entries, "");
	}

	return `${lines.join("\n").trimEnd()}\n`;
}

const next = buildChangelog(collectCommits());
if (process.argv.includes("--check")) {
	const current = readFileSync(changelogPath, "utf8");
	if (current !== next) {
		console.error("CHANGELOG.md is out of date. Run `npm run changelog`.");
		process.exit(1);
	}
	process.exit(0);
}

writeFileSync(changelogPath, next);
console.log(`Wrote ${changelogPath}`);
