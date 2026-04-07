import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { intro, isCancel, log, outro, select, spinner, text } from "@clack/prompts";
import chalk from "chalk";
import { encode as encodeBase32 } from "uuid-b32";
import type { Argv, CommandModule } from "yargs";
import { executeD1, getLocalAccountId } from "../utils/cloudflare";
import { cliContext } from "../utils/context";

const apiCwd = resolve(import.meta.dirname, "../../../api");
const cliSpinner = spinner();

export type TokenScopeType = "package:read" | "package:write" | "package:read+write";

type TokenRow = {
	token: string;
	name: string;
	scopes: string;
	created_at: number;
	updated_at: number;
};

type ParsedScope = {
	type: string;
	values: string[];
};

type PackagePerms = {
	read: boolean;
	write: boolean;
	types: string[];
};

type CreateTokenArgs = { packages?: string[]; mode?: TokenScopeType; name?: string; local: boolean };
type ClearTokensArgs = { package?: string; local: boolean };
type RemoveTokenArgs = { token?: string; local: boolean };
type ListTokensArgs = { package?: string; local: boolean };
type ListScopeArgs = { scope?: string; package?: string; local: boolean };
type LookupTokenArgs = { token?: string; local: boolean };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const isTokenRow = (v: unknown): v is TokenRow =>
	isRecord(v) &&
	typeof v.token === "string" &&
	typeof v.name === "string" &&
	typeof v.scopes === "string" &&
	typeof v.created_at === "number" &&
	typeof v.updated_at === "number";

const isScopeOnly = (v: string) => v.startsWith("@") && !v.includes("/");

const parseScopes = (value: string): ParsedScope[] => {
	try {
		const parsed: unknown = JSON.parse(value ?? "[]");
		return Array.isArray(parsed) ? (parsed as ParsedScope[]) : [];
	} catch {
		return [];
	}
};

const resolvePerms = (scopes: ParsedScope[], pkg: string): PackagePerms => {
	const entries = scopes.filter((s) => Array.isArray(s.values) && s.values.includes(pkg));
	return {
		read: entries.some((s) => s.type === "package:read" || s.type === "package:read+write"),
		write: entries.some((s) => s.type === "package:write" || s.type === "package:read+write"),
		types: entries.map((s) => s.type)
	};
};

const fmtPerm = (p: PackagePerms): string => {
	if (p.read && p.write) return chalk.green("R/W");
	if (p.read) return chalk.cyan("R");
	if (p.write) return chalk.yellow("W");
	return chalk.dim("·");
};

const renderLegend = () => {
	log.info(
		chalk.gray("Legend: ") +
			`${chalk.green("R/W")} read+write  ` +
			`${chalk.cyan("R")} read/install  ` +
			`${chalk.yellow("W")} write/publish  ` +
			`${chalk.dim("·")} no access`
	);
};

const fmtToken = (token: string) => token;

const fmtAge = (createdAt: number): string => {
	const secs = Math.floor(Date.now() / 1000) - createdAt;
	if (secs < 60) return `${secs}s ago`;
	if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
	if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
	return `${Math.floor(secs / 86400)}d ago`;
};

const stripAnsi = (v: string) => v.replace(/\x1b\[[0-9;]*m/g, "");

const formatRow = (cols: string[], widths: number[]) =>
	cols
		.map((col, i) => {
			const w = widths[i];
			const plain = stripAnsi(col);
			const truncated = plain.length > w ? `${plain.slice(0, w - 1)}…` : plain;
			return truncated + " ".repeat(Math.max(w - truncated.length, 0));
		})
		.join("  ");

const renderTable = (header: string[], rows: string[][], widths: number[]) => {
	log.info("");
	log.info(
		formatRow(
			header.map((h) => chalk.bold(h)),
			widths
		)
	);
	log.info(chalk.gray("─".repeat(widths.reduce((a, b) => a + b + 2, -2))));
	for (const row of rows) log.info(formatRow(row, widths));
	log.info("");
};

const ensureCloudflareAccount = async (): Promise<string> => {
	cliSpinner.start("Retrieving Cloudflare account…");
	const accountId = await getLocalAccountId();
	cliSpinner.stop();

	if (!accountId) {
		log.error(chalk.red(`Could not retrieve account. Login with ${chalk.bold.white("wrangler login")}.`));
		process.exit(1);
	}

	log.info(chalk.gray(`Account: ${chalk.white(accountId)}`));
	return accountId;
};

const ensureRemoteCloudflareAccount = async (local: boolean) => {
	if (!local) {
		await ensureCloudflareAccount();
	}
};

const validateScopedPackageName = (value?: string): string | undefined => {
	const v = value?.trim();

	if (!v) return "Please enter a package name.";
	if (!v.startsWith("@")) return "Package must start with '@'.";
	if (!v.includes("/")) return "Enter a full package name like @scope/pkg, not just a scope.";

	const [, name] = v.split("/");
	if (!name?.trim()) return "Package name must include both scope and package, e.g. @scope/pkg.";

	return undefined;
};

const parsePackageList = (value?: string | string[]): string[] => {
	const rawValues = Array.isArray(value) ? value : [value ?? ""];
	return Array.from(
		new Set(
			rawValues
				.flatMap((v) => v.split(","))
				.map((v) => v.trim())
				.filter(Boolean)
		)
	);
};

const validatePackageList = (values?: string[]): string | undefined => {
	if (!values?.length) return "Please enter at least one package.";

	for (const pkg of values) {
		const error = validateScopedPackageName(pkg);
		if (error) return `${pkg}: ${error}`;
	}

	return undefined;
};

const promptPackageNames = async (): Promise<string[]> => {
	const value = await text({
		message: "Package names (comma-separated, e.g. @scope/a, @scope/b):",
		validate(v) {
			return validatePackageList(parsePackageList(v));
		}
	});

	if (isCancel(value)) process.exit(1);

	return parsePackageList(value);
};

const buildScopesJson = (scopeType: TokenScopeType, packageNames: string[]) =>
	JSON.stringify([{ type: scopeType, values: packageNames }]);

const promptPackageName = async (): Promise<string> => {
	const pkg = await text({
		message: "Package name (e.g. @scope/pkg):",
		validate: validateScopedPackageName
	});

	if (isCancel(pkg)) process.exit(1);
	return pkg.trim();
};

const promptScopeName = async (initial = "@babadeluxe"): Promise<string> => {
	const scope = await text({
		message: "Package scope (e.g. @babadeluxe):",
		initialValue: initial,
		validate(v) {
			if (!v?.trim()) return "Please enter a scope.";
			if (!v.startsWith("@")) return "Scope must start with '@'.";
			if (v.includes("/")) return "Enter only the scope prefix, e.g. @babadeluxe.";
		}
	});
	if (isCancel(scope)) process.exit(1);
	return scope.trim();
};

const promptTokenValue = async (): Promise<string> => {
	const t = await text({
		message: "Token value:",
		validate(v) {
			if (!v?.trim()) return "Please enter a token value.";
		}
	});
	if (isCancel(t)) process.exit(1);
	return t.trim();
};

const promptScopeMode = async (): Promise<TokenScopeType> => {
	const mode = await select<TokenScopeType>({
		message: "Select token permissions:",
		options: [
			{ value: "package:read", label: "R    — read / install only" },
			{ value: "package:write", label: "W    — write / publish only" },
			{ value: "package:read+write", label: "R/W  — read + write" }
		]
	});
	if (isCancel(mode)) process.exit(1);
	return mode;
};

const promptTokenName = async (packageNames: string[]): Promise<string> => {
	const initialValue =
		packageNames.length === 1 ? `${packageNames[0]}-token` : `${packageNames[0].split("/")[0]}-multi-package-token`;

	const name = await text({
		message: "Token label (for your reference):",
		initialValue,
		validate(v) {
			if (!v?.trim()) return "Please enter a label.";
		}
	});
	if (isCancel(name)) process.exit(1);
	return name.trim();
};

export const createTokenProgrammatically = async (options: {
	packageNames: string[];
	scopeType: TokenScopeType;
	tokenLabel: string;
	local: boolean;
}): Promise<string> => {
	const { packageNames, scopeType, tokenLabel, local } = options;
	const tokenValue = encodeBase32(randomUUID()).toLowerCase();
	const scopesJson = buildScopesJson(scopeType, packageNames).replace(/'/g, "''");
	const nowSql = "strftime('%s','now')";

	await executeD1(
		`INSERT INTO token (token, name, scopes, created_at, updated_at)
VALUES ('${tokenValue}', '${tokenLabel.replace(/'/g, "''")}', '${scopesJson}', ${nowSql}, ${nowSql});`,
		{ local, cwd: apiCwd, useFile: true }
	);

	return tokenValue;
};

const createToken = async (args: CreateTokenArgs) => {
	intro(chalk.bold(`babadeluxe-registry  token add  ${chalk.gray(args.local ? "local" : "remote")}`));
	await ensureRemoteCloudflareAccount(args.local);

	const packageNames = args.packages?.length ? args.packages : await promptPackageNames();
	const scopeType = args.mode ?? (await promptScopeMode());
	const tokenLabel = args.name ?? (await promptTokenName(packageNames));

	try {
		cliSpinner.start("Creating token…");
		const tokenValue = await createTokenProgrammatically({
			packageNames,
			scopeType,
			tokenLabel,
			local: args.local
		});
		cliSpinner.stop("Token created.");

		log.success(
			[
				"",
				`  Token     ${chalk.bold.white(tokenValue)}`,
				`  Packages  ${chalk.bold.white(String(packageNames.length))}`,
				`  Mode      ${chalk.bold.white(scopeType)}`,
				`  Label     ${chalk.bold.white(tokenLabel)}`,
				`  Target    ${chalk.bold.white(args.local ? "local D1" : "remote D1")}`,
				"",
				...packageNames.map((pkg) => `  - ${chalk.white(pkg)}`),
				"",
				chalk.gray("Add to .npmrc:"),
				chalk.gray(`  @babadeluxe:registry=https://your-babadeluxe-registry-url`),
				chalk.gray(`  //your-babadeluxe-registry-url/:_authToken=${tokenValue}`),
				""
			].join("\n")
		);

		outro("Done.");
	} catch (error) {
		cliSpinner.stop("Token creation failed.");
		throw error;
	}
};

const clearTokensForPackage = async (args: ClearTokensArgs) => {
	intro(chalk.bold(`babadeluxe-registry  token clear  ${chalk.gray(args.local ? "local" : "remote")}`));
	await ensureRemoteCloudflareAccount(args.local);

	const packageName = args.package ?? (await promptPackageName());

	try {
		cliSpinner.start(`Deleting tokens for ${chalk.bold(packageName)}…`);
		await executeD1(`DELETE FROM token WHERE scopes LIKE '%${packageName.replace(/'/g, "''")}%';`, {
			local: args.local,
			cwd: apiCwd
		});
		cliSpinner.stop("Tokens deleted.");

		outro("Done.");
	} catch (error) {
		cliSpinner.stop("Token deletion failed.");
		throw error;
	}
};

const removeTokenByValue = async (args: RemoveTokenArgs) => {
	intro(chalk.bold(`babadeluxe-registry  token delete  ${chalk.gray(args.local ? "local" : "remote")}`));
	await ensureRemoteCloudflareAccount(args.local);

	const tokenValue = args.token ?? (await promptTokenValue());

	try {
		cliSpinner.start(`Deleting token ${fmtToken(tokenValue)}…`);
		await executeD1(`DELETE FROM token WHERE token = '${tokenValue.replace(/'/g, "''")}';`, {
			local: args.local,
			cwd: apiCwd
		});
		cliSpinner.stop("Token deleted.");

		outro("Done.");
	} catch (error) {
		cliSpinner.stop("Token deletion failed.");
		throw error;
	}
};

const listTokensForPackage = async (args: ListTokensArgs) => {
	intro(chalk.bold(`babadeluxe-registry  token list  ${chalk.gray(args.local ? "local" : "remote")}`));

	const packageName = args.package ?? (await promptPackageName());

	if (isScopeOnly(packageName)) {
		log.warn(`"${packageName}" is a scope, not a package. Redirecting to scope view…`);
		await listTokensForScope({ scope: packageName, local: args.local });
		return;
	}

	await ensureRemoteCloudflareAccount(args.local);

	try {
		cliSpinner.start(`Loading tokens for ${chalk.bold(packageName)}…`);
		const rawRows = await executeD1<TokenRow>(
			`SELECT token, name, scopes, created_at, updated_at FROM token WHERE scopes LIKE '%${packageName.replace(/'/g, "''")}%';`,
			{ rows: true, local: args.local, cwd: apiCwd }
		);
		const rows = rawRows.filter(isTokenRow);
		cliSpinner.stop();

		if (!rows.length) {
			log.warn(`No tokens found for ${chalk.bold.white(packageName)}.`);
			outro("Done.");
			return;
		}

		const tableRows = rows
			.map((row) => {
				const perms = resolvePerms(parseScopes(row.scopes), packageName);
				return { row, perms };
			})
			.sort((a, b) => {
				const weight = (p: PackagePerms) => (p.read && p.write ? 2 : p.write ? 1 : p.read ? 0 : -1);
				return weight(b.perms) - weight(a.perms);
			})
			.map(({ row, perms }) => [
				chalk.white(fmtToken(row.token)),
				chalk.gray(row.name || "—"),
				perms.read ? chalk.green("✔") : chalk.dim("✖"),
				perms.write ? chalk.green("✔") : chalk.dim("✖"),
				fmtPerm(perms),
				chalk.dim(fmtAge(row.created_at))
			]);

		renderTable(["Token", "Label", "Read", "Write", "Mode", "Created"], tableRows, [32, 28, 6, 6, 6, 10]);

		renderLegend();
		log.info(
			chalk.gray(`${rows.length} token(s) for ${chalk.white(packageName)} on ${args.local ? "local" : "remote"} D1`)
		);

		outro("Done.");
	} catch (error) {
		cliSpinner.stop("Loading tokens failed.");
		throw error;
	}
};

const listTokensForScope = async (args: ListScopeArgs) => {
	if (!args.package) {
		intro(chalk.bold(`babadeluxe-registry  token list-scope  ${chalk.gray(args.local ? "local" : "remote")}`));
	}

	const inputScope = args.scope ?? (await promptScopeName());
	const scope = inputScope.startsWith("@") ? inputScope : `@${inputScope}`;

	await ensureRemoteCloudflareAccount(args.local);

	try {
		cliSpinner.start(`Loading tokens under ${chalk.bold(scope)}…`);
		const rawRows = await executeD1<TokenRow>(
			`SELECT token, name, scopes, created_at, updated_at FROM token WHERE scopes LIKE '%${scope.replace(/'/g, "''")}/%';`,
			{ rows: true, local: args.local, cwd: apiCwd }
		);
		const rows = rawRows.filter(isTokenRow);
		cliSpinner.stop();

		if (!rows.length) {
			log.warn(`No tokens found for scope ${chalk.bold.white(scope)}.`);
			outro("Done.");
			return;
		}

		const allPkgs = Array.from(
			new Set(
				rows.flatMap((row) =>
					parseScopes(row.scopes)
						.flatMap((s) => s.values)
						.filter((v) => v.startsWith(`${scope}/`))
				)
			)
		).sort();

		if (!allPkgs.length) {
			log.warn(`Tokens exist but no packages under ${chalk.bold.white(scope)} were found.`);
			outro("Done.");
			return;
		}

		const MAX_PKG_COLS = 4;
		const displayedPkgs = allPkgs.slice(0, MAX_PKG_COLS);
		const hasMore = allPkgs.length > MAX_PKG_COLS;

		const widths = [32, 24, ...displayedPkgs.map(() => 8)];
		const header = ["Token", "Label", ...displayedPkgs.map((p) => p.replace(`${scope}/`, "").slice(0, 8))];

		const tableRows = rows.map((row) => {
			const scopes = parseScopes(row.scopes);
			return [
				chalk.white(fmtToken(row.token)),
				chalk.gray(row.name || "—"),
				...displayedPkgs.map((pkg) => fmtPerm(resolvePerms(scopes, pkg)))
			];
		});

		renderTable(header, tableRows, widths);

		renderLegend();

		if (hasMore) {
			log.info(
				chalk.gray(
					`Showing ${MAX_PKG_COLS} of ${allPkgs.length} packages. Use ${chalk.white("token list --package <name>")} to inspect one package.`
				)
			);
		}

		log.info(
			chalk.gray(
				`${rows.length} token(s) · ${allPkgs.length} package(s) · scope ${chalk.white(scope)} · ${args.local ? "local" : "remote"} D1`
			)
		);

		outro("Done.");
	} catch (error) {
		cliSpinner.stop("Loading scope tokens failed.");
		throw error;
	}
};

const lookupToken = async (args: LookupTokenArgs) => {
	intro(chalk.bold(`babadeluxe-registry  token lookup  ${chalk.gray(args.local ? "local" : "remote")}`));
	await ensureRemoteCloudflareAccount(args.local);

	const tokenValue = args.token ?? (await promptTokenValue());

	try {
		cliSpinner.start(`Looking up token ${fmtToken(tokenValue)}…`);
		const rawRows = await executeD1<TokenRow>(
			`SELECT token, name, scopes, created_at, updated_at FROM token WHERE token = '${tokenValue.replace(/'/g, "''")}';`,
			{ rows: true, local: args.local, cwd: apiCwd }
		);
		const row = rawRows.find(isTokenRow);
		cliSpinner.stop();

		if (!row) {
			log.error(`Token ${chalk.bold.white(fmtToken(tokenValue))} not found.`);
			outro("Done.");
			return;
		}

		const scopes = parseScopes(row.scopes);
		const allPkgs = Array.from(new Set(scopes.flatMap((s) => (Array.isArray(s.values) ? s.values : [])))).sort();

		log.info("");
		log.info(`  ${chalk.bold("Token")}    ${chalk.white(fmtToken(row.token))}`);
		log.info(`  ${chalk.bold("Label")}    ${chalk.white(row.name || "—")}`);
		log.info(`  ${chalk.bold("Created")}  ${chalk.gray(fmtAge(row.created_at))}`);
		log.info(`  ${chalk.bold("Target")}   ${chalk.gray(args.local ? "local D1" : "remote D1")}`);

		if (!allPkgs.length) {
			log.warn("This token has no package scopes defined.");
			outro("Done.");
			return;
		}

		const tableRows = allPkgs.map((pkg) => {
			const perms = resolvePerms(scopes, pkg);
			return [
				chalk.white(pkg),
				perms.read ? chalk.green("✔") : chalk.dim("✖"),
				perms.write ? chalk.green("✔") : chalk.dim("✖"),
				fmtPerm(perms)
			];
		});

		renderTable(["Package", "Read", "Write", "Mode"], tableRows, [36, 6, 6, 6]);

		renderLegend();
		log.info(chalk.gray(`${allPkgs.length} package scope(s) · token ${chalk.white(row.token)}`));

		outro("Done.");
	} catch (error) {
		cliSpinner.stop("Token lookup failed.");
		throw error;
	}
};

export const tokenCommands: CommandModule = {
	command: "token <sub>",
	describe: "Manage babadeluxe-registry tokens (multi-package read/write permissions)",
	builder: (yargs: Argv) =>
		yargs
			.command(
				["add", "create"],
				"Create a new token scoped to one or more packages",
				(yy) =>
					yy
						.option("package", {
							alias: "p",
							type: "string",
							array: true,
							describe: "Package name(s), repeatable or comma-separated (e.g. -p @scope/a -p @scope/b)"
						})
						.check((argv) => {
							const packages = parsePackageList(argv.package as string[] | string | undefined);
							if (argv.package) {
								const error = validatePackageList(packages);
								if (error) throw new Error(error);
							}
							return true;
						})
						.option("mode", {
							alias: "m",
							choices: ["package:read", "package:write", "package:read+write"] as const
						})
						.option("name", { alias: "n", type: "string", describe: "Label for this token" })
						.option("local", { alias: "l", type: "boolean", default: false, describe: "Use local D1" }),
				async (argv) => {
					await cliContext.run({ packageManagerAgent: "npm" }, () =>
						createToken({
							packages: parsePackageList(argv.package as string[] | string | undefined),
							mode: argv.mode as TokenScopeType | undefined,
							name: argv.name as string | undefined,
							local: Boolean(argv.local)
						})
					);
				}
			)
			.command(
				"clear",
				"Delete all tokens that grant access to a given package",
				(yy) =>
					yy
						.option("package", { alias: "p", type: "string", describe: "Full package name (e.g. @scope/pkg)" })
						.check((argv) => {
							if (argv.package) {
								const error = validateScopedPackageName(argv.package);
								if (error) throw new Error(error);
							}
							return true;
						})
						.option("local", { alias: "l", type: "boolean", default: false }),
				async (argv) => {
					await cliContext.run({ packageManagerAgent: "npm" }, () =>
						clearTokensForPackage({
							package: argv.package as string | undefined,
							local: Boolean(argv.local)
						})
					);
				}
			)
			.command(
				["delete", "remove"],
				"Delete a single token by its value",
				(yy) =>
					yy
						.option("token", { alias: "t", type: "string", describe: "Token value to delete" })
						.option("local", { alias: "l", type: "boolean", default: false, describe: "Use local D1" }),
				async (argv) => {
					await cliContext.run({ packageManagerAgent: "npm" }, () =>
						removeTokenByValue({
							token: argv.token as string | undefined,
							local: Boolean(argv.local)
						})
					);
				}
			)
			.command(
				"list",
				"List all tokens that grant access to a specific package",
				(yy) =>
					yy
						.option("package", { alias: "p", type: "string", describe: "Full package name (e.g. @scope/pkg)" })
						.check((argv) => {
							if (argv.package) {
								const error = validateScopedPackageName(argv.package);
								if (error) throw new Error(error);
							}
							return true;
						})
						.option("local", { alias: "l", type: "boolean", default: false }),
				async (argv) => {
					await cliContext.run({ packageManagerAgent: "npm" }, () =>
						listTokensForPackage({
							package: argv.package as string | undefined,
							local: Boolean(argv.local)
						})
					);
				}
			)
			.command(
				"list-scope",
				"Show a permission matrix for all packages under a scope",
				(yy) =>
					yy
						.option("scope", { alias: "s", type: "string", describe: "Scope (e.g. @babadeluxe)" })
						.option("local", { alias: "l", type: "boolean", default: false }),
				async (argv) => {
					await cliContext.run({ packageManagerAgent: "npm" }, () =>
						listTokensForScope({
							scope: argv.scope as string | undefined,
							local: Boolean(argv.local)
						})
					);
				}
			)
			.command(
				"lookup",
				"Inspect a token and show what packages and permissions it has",
				(yy) =>
					yy
						.option("token", { alias: "t", type: "string", describe: "Token value to inspect" })
						.option("local", { alias: "l", type: "boolean", default: false }),
				async (argv) => {
					await cliContext.run({ packageManagerAgent: "npm" }, () =>
						lookupToken({
							token: argv.token as string | undefined,
							local: Boolean(argv.local)
						})
					);
				}
			)
			.demandCommand(1),
	handler: () => {}
};
