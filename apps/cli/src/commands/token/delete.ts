import { confirm, intro, isCancel, log, outro, select } from "@clack/prompts";
import chalk from "chalk";
import type { CommandModule } from "yargs";
import { cliContext } from "../../utils/context";
import {
	apiCwd,
	cliSpinner,
	ensureRemoteCloudflareAccount,
	escapeSql,
	executeD1,
	fmtToken,
	getAllTokenRows,
	getTokenOptionsFromRows,
	promptTokenValue
} from "./shared";
import type { RemoveTokenArgs } from "./types";

export const deleteCommand: CommandModule = {
	command: ["delete", "remove"],
	describe: "Delete a single token by its value",
	builder: (yargsBuilder) =>
		yargsBuilder
			.option("token", {
				alias: "t",
				type: "string",
				describe: "Token value to delete"
			})
			.option("local", {
				alias: "l",
				type: "boolean",
				default: false,
				describe: "Use local D1"
			}),
	handler: async (parsedArguments) => {
		await cliContext.run({ packageManagerAgent: "pnpm" }, () =>
			removeTokenByValue({
				token: parsedArguments.token as string | undefined,
				local: Boolean(parsedArguments.local)
			})
		);
	}
};

async function removeTokenByValue(argumentsValue: RemoveTokenArgs) {
	intro(chalk.bold(`npflared  token delete  ${chalk.gray(argumentsValue.local ? "local" : "remote")}`));
	await ensureRemoteCloudflareAccount(argumentsValue.local);

	const tokenValue = argumentsValue.token ?? (await promptTokenForDelete(argumentsValue.local));

	const shouldDelete = await confirm({
		message: `Delete token ${fmtToken(tokenValue)}?`
	});

	if (isCancel(shouldDelete) || !shouldDelete) {
		outro("Cancelled.");
		return;
	}

	try {
		cliSpinner.start(`Deleting token ${fmtToken(tokenValue)}…`);

		await executeD1(`DELETE FROM token WHERE token = '${escapeSql(tokenValue)}';`, {
			local: argumentsValue.local,
			cwd: apiCwd
		});

		cliSpinner.stop("Token deleted.");
		outro("Done.");
	} catch (error) {
		cliSpinner.stop("Token deletion failed.");
		throw error;
	}
}

async function promptTokenForDelete(local: boolean): Promise<string> {
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
		message: "Select token to delete:",
		options: tokenOptions
	});

	if (isCancel(selectedToken)) process.exit(1);

	return selectedToken;
}
