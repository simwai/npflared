import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type ExtendedResolvedCommand, getCommand } from "@antfu/ni";
import { z } from "zod";
import { $, type ProcessOutput } from "zx";
import type { D1Database, R2Bucket } from "../types";
import { cliContext } from "./context";

$.verbose = false;

// Configure zx for PowerShell/cmd on Windows
if (!$.quote) {
	$.quote = (arg: string) => {
		if (/^[a-zA-Z0-9_:./-]+$/.test(arg)) {
			return arg;
		}
		return `"${arg.replace(/"/g, '\\"')}"`;
	};
}

// ----------------------------------------------------------------------------
// Shared helpers (DRY)
// ----------------------------------------------------------------------------

function getPackageManagerAgent(): string {
	return cliContext.getStore()?.packageManagerAgent ?? "npm";
}

/**
 * Executes a wrangler command via the package manager (npx, yarn, etc.)
 * Converts ProcessOutput errors into standard Errors with stderr/stdout message.
 */
async function runWrangler(args: string[], options: { cwd?: string } = {}): Promise<ProcessOutput> {
	const packageManager = getPackageManagerAgent();
	const command = getCommand(packageManager, "execute", args);
	// executeCommand already sets quiet: true, we only forward cwd
	return await executeCommand(command, { cwd: options.cwd });
}

/**
 * Runs a wrangler command that outputs a JSON object, parses and validates it.
 */
async function runWranglerAndParseJson<T>(
	args: string[],
	schema: z.ZodSchema<T>,
	options?: { cwd?: string }
): Promise<T> {
	const result = await runWrangler(args, options);
	const match = result.stdout.match(/\{(?:[^{}]*|\{(?:[^{}]*|\{[^{}]*\})*\})*\}/gim);
	const jsonStr = match?.[0] ?? "";
	const parsed = schema.safeParse(JSON.parse(jsonStr));
	if (!parsed.success) {
		throw new Error(`Failed to parse JSON output: ${parsed.error.message}`);
	}
	return parsed.data;
}

/**
 * Adds --config <path> to the argument list if a wrangler config file exists in cwd.
 * Returns the mutated args array (does not modify original).
 */
function addConfigArgIfExists(args: string[], cwd?: string): string[] {
	const configPath = findWranglerConfig(cwd);
	if (configPath) {
		return ["--config", configPath, ...args];
	}
	return args;
}

/**
 * Locates wrangler.json or wrangler.toml in the given directory (default: cwd).
 */
const findWranglerConfig = (cwd?: string): string | undefined => {
	const base = cwd ? resolve(cwd) : process.cwd();
	const jsonPath = join(base, "wrangler.json");
	const tomlPath = join(base, "wrangler.toml");
	if (existsSync(jsonPath)) return jsonPath;
	if (existsSync(tomlPath)) return tomlPath;
	return undefined;
};

// ----------------------------------------------------------------------------
// Original executeCommand wrapper (unchanged, but its options type is explicit)
// ----------------------------------------------------------------------------

const executeCommand = (command: ExtendedResolvedCommand, options: { cwd?: string } = {}) => {
	return $({ quiet: true, ...options })`${command.command} ${command.args}`;
};

// ----------------------------------------------------------------------------
// Refactored public functions
// ----------------------------------------------------------------------------

export const getLocalAccountId = async () => {
	const result = await runWrangler(["wrangler", "whoami"]);
	const match = result.stdout.match(/([0-9a-f]{32})/);
	const [accountId] = match ?? [];
	return accountId;
};

export const listD1Databases = async () => {
	const result = await runWrangler(["-y", "wrangler", "d1", "list"]);
	const matches = Array.from(
		result.stdout.matchAll(
			/│\s*([^│]+?)\s*│\s*([^│]+?)\s*│\s*([^│]+?)\s*│\s*([^│]+?)\s*│\s*([^│]+?)\s*│\s*([^│]+?)\s*│\s*([^│]+?)\s*│/gm
		)
	).slice(1); // Skip header row

	const d1Databases: D1Database[] = [];
	for (const match of matches) {
		const [, id, name, createdAt, version, numberOfTables, size] = match;
		if (id || name || createdAt || version || numberOfTables || size) {
			d1Databases.push({
				id: id.trim(),
				name: name.trim(),
				createdAt: createdAt.trim(),
				version: version.trim(),
				numberOfTables: Number.parseInt(numberOfTables, 10),
				size: Number.parseInt(size, 10)
			});
		}
	}
	return d1Databases;
};

export const listR2Buckets = async () => {
	const result = await runWrangler(["-y", "wrangler", "r2", "bucket", "list"]);
	const matches = result.stdout.matchAll(/name:(.*)\ncreation_date:(.*)/gim);
	const r2Buckets: R2Bucket[] = [];
	for (const match of matches) {
		const [, name, createdAt] = match;
		if (name || createdAt) {
			r2Buckets.push({
				name: name.trim(),
				createdAt: createdAt.trim()
			});
		}
	}
	return r2Buckets;
};

export const createR2Bucket = async (name: string) => {
	return runWranglerAndParseJson(["-y", "wrangler", "r2", "bucket", "create", name], createR2BucketOutputSchema);
};

export const createD1Database = async (name: string) => {
	return runWranglerAndParseJson(["-y", "wrangler", "d1", "create", name], createD1DatabaseOutputSchema);
};

export const applyD1Migrations = async (d1DatabaseName: string, config: { cwd?: string; local?: boolean } = {}) => {
	const { cwd, local = false } = config;
	const baseArgs = ["-y", "wrangler", "d1", "migrations", "apply", d1DatabaseName];
	if (local) baseArgs.push("--local");
	else baseArgs.push("--remote");
	const argsWithConfig = addConfigArgIfExists(baseArgs, cwd);
	await runWrangler(argsWithConfig, { cwd });
};

export const deploy = async (config: { cwd?: string } = {}) => {
	const baseArgs = ["-y", "wrangler", "deploy"];
	const argsWithConfig = addConfigArgIfExists(baseArgs, config.cwd);
	const result = await runWrangler(argsWithConfig, { cwd: config.cwd });
	const match = result.stdout.match(/([a-z0-9-]+\.[a-z0-9-]+\.workers\.dev)/i);
	return match ? `https://${match[0]}` : "<unknown>";
};

// executeD1 is kept with its original direct `wrangler` invocation (no npx) to preserve behavior.
// However, we extract config path building and error handling to stay DRY.
export const executeD1 = async (sql: string, options: { cwd?: string; local?: boolean; json?: boolean } = {}) => {
	const { cwd, local = false, json = false } = options;

	const tempDir = await mkdtemp(join(tmpdir(), "npflared-sql-"));
	const sqlFile = join(tempDir, "query.sql");
	await writeFile(sqlFile, sql, "utf8");

	const args: string[] = ["d1", "execute", "DB", local ? "--local" : "--remote", "--file", sqlFile];
	if (json) args.push("--json");

	const configPath = findWranglerConfig(cwd);
	if (configPath) {
		args.unshift("--config", configPath);
	}

	const result = await $({ quiet: true, cwd })`wrangler ${args}`;
	return result.stdout as string;
};

export const executeD1Remote = async (sql: string, config: { cwd?: string } = {}) => {
	await executeD1(sql, { cwd: config.cwd, local: false });
};

export const executeD1Local = async (sql: string, config: { cwd?: string } = {}) => {
	await executeD1(sql, { cwd: config.cwd, local: true });
};

// ----------------------------------------------------------------------------
// Zod schemas (unchanged)
// ----------------------------------------------------------------------------

const createD1DatabaseOutputSchema = z.object({
	d1_databases: z
		.array(
			z.object({
				binding: z.string(),
				database_name: z.string(),
				database_id: z.string()
			})
		)
		.min(1)
});

const createR2BucketOutputSchema = z.object({
	r2_buckets: z
		.array(
			z.object({
				binding: z.string(),
				bucket_name: z.string()
			})
		)
		.min(1)
});
