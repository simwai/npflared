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

if (!$.quote) {
	$.quote = (arg: string) => {
		if (/^[a-zA-Z0-9_:./-]+$/.test(arg)) {
			return arg;
		}
		return `"${arg.replace(/"/g, '\\"')}"`;
	};
}

function getPackageManagerAgent(): string {
	return cliContext.getStore()?.packageManagerAgent ?? "npm";
}

async function runWrangler(args: string[], options: { cwd?: string } = {}): Promise<ProcessOutput> {
	const packageManager = getPackageManagerAgent();
	// @ts-ignore
	const command = getCommand(packageManager, "execute", args);
	return await executeCommand(command, { cwd: options.cwd });
}

async function runWranglerAndParseJson<T>(
	args: string[],
	schema: z.ZodSchema<T>,
	options?: { cwd?: string }
): Promise<T> {
	const result = await runWrangler(args, options);
	const parsed = parseJsonFromMixedOutput(result.stdout);
	return schema.parse(parsed);
}

function addConfigArgIfExists(args: string[], cwd?: string): string[] {
	const configPath = findWranglerConfig(cwd);
	if (configPath) {
		return ["--config", configPath, ...args];
	}
	return args;
}

const findWranglerConfig = (cwd?: string): string | undefined => {
	const base = cwd ? resolve(cwd) : process.cwd();
	const jsonPath = join(base, "wrangler.json");
	const tomlPath = join(base, "wrangler.toml");
	if (existsSync(jsonPath)) return jsonPath;
	if (existsSync(tomlPath)) return tomlPath;
	return undefined;
};

const executeCommand = (command: ExtendedResolvedCommand, options: { cwd?: string } = {}) => {
	return $({ quiet: true, ...options })`${command.command} ${command.args}`;
};

const D1MetaSchema = z
	.object({
		served_by: z.string().optional(),
		served_by_region: z.string().optional(),
		served_by_colo: z.string().optional(),
		served_by_primary: z.boolean().optional(),
		timings: z.record(z.string(), z.number()).optional(),
		duration: z.number().optional(),
		changes: z.number().optional(),
		last_row_id: z.number().optional(),
		changed_db: z.boolean().optional(),
		size_after: z.number().optional(),
		rows_read: z.number().optional(),
		rows_written: z.number().optional(),
		num_tables: z.number().optional(),
		total_attempts: z.number().optional()
	})
	.passthrough();

const D1StatementSchema = z
	.object({
		results: z.array(z.unknown()).default([]),
		success: z.boolean().optional(),
		finalBookmark: z.string().optional(),
		meta: D1MetaSchema.optional()
	})
	.passthrough();

const D1StatementArraySchema = z.array(D1StatementSchema);

const D1WrappedResultSchema = z
	.object({
		result: z.array(D1StatementSchema)
	})
	.passthrough();

const CreateD1DatabaseOutputSchema = z.object({
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

const CreateR2BucketOutputSchema = z.object({
	r2_buckets: z
		.array(
			z.object({
				binding: z.string(),
				bucket_name: z.string()
			})
		)
		.min(1)
});

function parseJsonFromMixedOutput(stdout: string): unknown {
	const trimmed = stdout.trim();

	try {
		return JSON.parse(trimmed);
	} catch {}

	const lines = trimmed.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const candidate = lines.slice(i).join("\n").trim();
		if (!candidate) continue;
		try {
			return JSON.parse(candidate);
		} catch {}
	}

	throw new Error(`Failed to parse Wrangler JSON output:\n${stdout}`);
}

function extractD1Results(payload: unknown): unknown[] {
	const asArray = D1StatementArraySchema.safeParse(payload);
	if (asArray.success) return asArray.data.at(-1)?.results ?? [];

	const asWrapped = D1WrappedResultSchema.safeParse(payload);
	if (asWrapped.success) return asWrapped.data.result.at(-1)?.results ?? [];

	const asSingle = D1StatementSchema.safeParse(payload);
	if (asSingle.success) return asSingle.data.results;

	throw new Error("Unexpected D1 JSON response shape.");
}

type ExecuteD1BaseOptions = {
	cwd?: string;
	local?: boolean;
	useFile?: boolean;
};

type ExecuteD1TextOptions = ExecuteD1BaseOptions & {
	json?: false;
	rows?: false;
	schema?: never;
};

type ExecuteD1RowsOptions<TRow = unknown> = ExecuteD1BaseOptions & {
	json?: true;
	rows: true;
	schema?: never;
};

type ExecuteD1SchemaOptions<TSchema extends z.ZodTypeAny> = ExecuteD1BaseOptions & {
	json?: true;
	rows: true;
	schema: TSchema;
};

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
	).slice(1);

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
	return runWranglerAndParseJson(["-y", "wrangler", "r2", "bucket", "create", name], CreateR2BucketOutputSchema);
};

export const createD1Database = async (name: string) => {
	return runWranglerAndParseJson(["-y", "wrangler", "d1", "create", name], CreateD1DatabaseOutputSchema);
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

export async function executeD1(sql: string, options?: ExecuteD1TextOptions): Promise<string>;

export async function executeD1<TRow = unknown>(sql: string, options: ExecuteD1RowsOptions<TRow>): Promise<TRow[]>;

export async function executeD1<TSchema extends z.ZodTypeAny>(
	sql: string,
	options: ExecuteD1SchemaOptions<TSchema>
): Promise<z.infer<TSchema>[]>;

export async function executeD1<TRow = unknown, TSchema extends z.ZodTypeAny = z.ZodNever>(
	sql: string,
	options: ExecuteD1TextOptions | ExecuteD1RowsOptions<TRow> | ExecuteD1SchemaOptions<TSchema> = {}
): Promise<string | TRow[] | z.infer<TSchema>[]> {
	const { cwd, local = false, useFile = false } = options;

	const wantRows = "rows" in options && options.rows === true;
	const wantJson = wantRows || ("json" in options && Boolean(options.json) === true);
	const forceFile = useFile || sql.length > 8000 || /[\r\n]/.test(sql);

	let args: string[];

	if (forceFile) {
		const tempDir = await mkdtemp(join(tmpdir(), "npflared-sql-"));
		const sqlFile = join(tempDir, "query.sql");
		await writeFile(sqlFile, sql, "utf8");
		args = ["d1", "execute", "DB", local ? "--local" : "--remote", "--file", sqlFile];
	} else {
		args = ["d1", "execute", "DB", local ? "--local" : "--remote", "--command", sql];
	}

	if (wantJson) args.push("--json");

	const configPath = findWranglerConfig(cwd);
	if (configPath) {
		args.unshift("--config", configPath);
	}

	const result = await $({ quiet: true, cwd })`wrangler ${args}`;
	const stdout = result.stdout as string;

	if (!wantJson) {
		return stdout;
	}

	const parsed = parseJsonFromMixedOutput(stdout);
	const rows = extractD1Results(parsed);

	if ("schema" in options && options.schema) {
		return z.array(options.schema).parse(rows);
	}

	return rows as TRow[];
}

export const executeD1Remote = async (sql: string, config: { cwd?: string } = {}) => {
	await executeD1(sql, { cwd: config.cwd, local: false });
};

export const executeD1Local = async (sql: string, config: { cwd?: string } = {}) => {
	await executeD1(sql, { cwd: config.cwd, local: true });
};
