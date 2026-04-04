import { confirm, intro, isCancel, log, outro } from "@clack/prompts";
import chalk from "chalk";
import type { CommandModule } from "yargs";
import { cliContext } from "../../utils/context";
import { apiCwd, cliSpinner, ensureRemoteCloudflareAccount, executeD1, isTokenRow } from "./shared";
import type { TokenRow } from "./types";

type ClearTokensArgs = {
  local: boolean;
};

export const clearCommand: CommandModule = {
  command: "clear",
  describe: "Delete all tokens",
  builder: (yargsBuilder) =>
    yargsBuilder.option("local", {
      alias: "l",
      type: "boolean",
      default: false
    }),
  handler: async (parsedArguments) => {
    await cliContext.run({ packageManagerAgent: "pnpm" }, () =>
      clearAllTokens({
        local: Boolean(parsedArguments.local)
      })
    );
  }
};

async function clearAllTokens(args: ClearTokensArgs) {
  intro(chalk.bold(`npflared  token clear  ${chalk.gray(args.local ? "local" : "remote")}`));
  await ensureRemoteCloudflareAccount(args.local);

  try {
    cliSpinner.start("Loading token inventory…");

    const rawRows = await executeD1<TokenRow>("SELECT token, name, scopes, created_at, updated_at FROM token;", {
      rows: true,
      local: args.local,
      cwd: apiCwd
    });

    const rows = rawRows.filter(isTokenRow);

    cliSpinner.stop();

    if (!rows.length) {
      log.warn("No tokens found.");
      outro("Done.");
      return;
    }

    log.warn(`This will permanently delete ${rows.length} token(s).`);
    log.warn(
      "Impact: all clients using these tokens will lose package access until new tokens are created and configured."
    );

    const shouldDelete = await confirm({
      message: `Do you really want to delete all ${rows.length} token(s)?`
    });

    if (isCancel(shouldDelete) || !shouldDelete) {
      outro("Cancelled.");
      return;
    }

    cliSpinner.start("Deleting all tokens…");

    await executeD1("DELETE FROM token;", {
      local: args.local,
      cwd: apiCwd
    });

    cliSpinner.stop("All tokens deleted.");
    outro("Done.");
  } catch (error) {
    cliSpinner.stop("Token deletion failed.");
    throw error;
  }
}
