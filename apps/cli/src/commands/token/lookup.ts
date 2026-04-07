import { intro, isCancel, log, outro, select } from "@clack/prompts";
import chalk from "chalk";
import type { CommandModule } from "yargs";
import { cliContext } from "../../utils/context";
import {
	apiCwd,
	cliSpinner,
	ensureRemoteCloudflareAccount,
	escapeSql,
	executeD1,
	fmtAge,
	fmtPerm,
	fmtToken,
	getAllTokenRows,
	getPackageNamesFromScopes,
	getTokenOptionsFromRows,
	isTokenRow,
	parseScopes,
	promptTokenValue,
	renderLegend,
	renderTable,
	resolvePerms
} from "./shared";
import type { LookupTokenArgs, TokenRow } from "./types";

export const lookupCommand: CommandModule = {
	command: "lookup",
	describe: "Inspect a token and show what packages and permissions it has",
	builder: (yargsBuilder) =>
		yargsBuilder
			.option("token", {
				alias: "t",
				type: "string",
				describe: "Token value to inspect"
			})
			.option("local", {
				alias: "l",
				type: "boolean",
				default: false
			}),
	handler: async (parsedArguments) => {
		await cliContext.run({ packageManagerAgent: "pnpm" }, () =>
			lookupToken({
				token: parsedArguments.token as string | undefined,
				local: Boolean(parsedArguments.local)
			})
		);
	}
};

async function lookupToken(argumentsValue: LookupTokenArgs) {
	intro(chalk.bold(`babadeluxe-registry  token lookup  ${chalk.gray(argumentsValue.local ? "local" : "remote")}`));
	await ensureRemoteCloudflareAccount(argumentsValue.local);

	const tokenValue = argumentsValue.token ?? (await promptTokenForLookup(argumentsValue.local));

	try {
		cliSpinner.start(`Looking up token ${fmtToken(tokenValue)}…`);

		const rawRows = await executeD1<TokenRow>(
			`SELECT token, name, scopes, created_at, updated_at FROM token WHERE token = '${escapeSql(tokenValue)}';`,
			{ rows: true, local: argumentsValue.local, cwd: apiCwd }
		);

		const row = rawRows.find(isTokenRow);

		cliSpinner.stop();

		if (!row) {
			log.error(`Token ${chalk.bold.white(fmtToken(tokenValue))} not found.`);
			outro("Done.");
			return;
		}

		const scopes = parseScopes(row.scopes);
		const allPackages = getPackageNamesFromScopes(scopes);

		log.info("");
		log.info(`  ${chalk.bold("Token")}    ${chalk.white(fmtToken(row.token))}`);
		log.info(`  ${chalk.bold("Label")}    ${chalk.white(row.name || "—")}`);
		log.info(`  ${chalk.bold("Created")}  ${chalk.gray(fmtAge(row.created_at))}`);
		log.info(`  ${chalk.bold("Target")}   ${chalk.gray(argumentsValue.local ? "local D1" : "remote D1")}`);

		if (!allPackages.length) {
			log.warn("This token has no package scopes defined.");
			outro("Done.");
			return;
		}

		const tableRows = allPackages.map((packageName) => {
			const packagePerms = resolvePerms(scopes, packageName);

			return [
				chalk.white(packageName),
				packagePerms.read ? chalk.green("✔") : chalk.dim("✖"),
				packagePerms.write ? chalk.green("✔") : chalk.dim("✖"),
				fmtPerm(packagePerms)
			];
		});

		renderTable(["Package", "Read", "Write", "Mode"], tableRows, [36, 6, 6, 6]);
		renderLegend();

		log.info(chalk.gray(`${allPackages.length} package scope(s) · token ${chalk.white(row.token)}`));
		outro("Done.");
	} catch (error) {
		cliSpinner.stop("Token lookup failed.");
		throw error;
	}
}

async function promptTokenForLookup(local: boolean): Promise<string> {
	const rows = await getAllTokenRows(local);
	const tokenOptions = getTokenOptionsFromRows(rows);

	if (!tokenOptions.length) {
		log.warn("No existing tokens found. Enter a token manually.");
		return promptTokenValue();
	}

	const tokenSelectionMode = await select<"select" | "manual">({
		message: "How do you want to choose the token?",
		options: [
			{ value: "select", label: "Select an existing token" },
			{ value: "manual", label: "Enter token manually" }
		]
	});

	if (isCancel(tokenSelectionMode)) process.exit(1);

	if (tokenSelectionMode === "manual") {
		return promptTokenValue();
	}

	const selectedToken = await select<string>({
		message: "Select token to inspect:",
		options: tokenOptions
	});

	if (isCancel(selectedToken)) process.exit(1);

	return selectedToken;
}
