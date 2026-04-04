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
  fmtPerm,
  getAllTokenRows,
  getPackageNamesFromScopes,
  getScopesFromRows,
  isTokenRow,
  normalizeScope,
  parseScopes,
  promptScopeName,
  renderLegend,
  renderTable,
  resolvePerms,
  validateScopeName
} from "./shared";
import type { ListScopeArgs, TokenRow } from "./types";

export const listScopeCommand: CommandModule = {
  command: "list-scope",
  describe: "Show a permission matrix for all packages under a scope",
  builder: (yargsBuilder) =>
    yargsBuilder
      .option("scope", {
        alias: "s",
        type: "string",
        describe: "Scope (e.g. @babadeluxe)"
      })
      .check((parsedArguments) => {
        if (parsedArguments.scope) {
          const error = validateScopeName(parsedArguments.scope as string | undefined);
          if (error) {
            throw new Error(error);
          }
        }

        return true;
      })
      .option("local", {
        alias: "l",
        type: "boolean",
        default: false
      }),
  handler: async (parsedArguments) => {
    await cliContext.run({ packageManagerAgent: "pnpm" }, () =>
      listTokensForScope({
        scope: parsedArguments.scope as string | undefined,
        local: Boolean(parsedArguments.local)
      })
    );
  }
};

export async function listTokensForScope(argumentsValue: ListScopeArgs) {
  if (!argumentsValue.skipIntro) {
    intro(chalk.bold(`npflared  token list-scope  ${chalk.gray(argumentsValue.local ? "local" : "remote")}`));
  }

  await ensureRemoteCloudflareAccount(argumentsValue.local);

  const inputScope = argumentsValue.scope ?? (await promptScopeForList(argumentsValue.local));
  const scope = normalizeScope(inputScope);

  try {
    cliSpinner.start(`Loading tokens under ${chalk.bold(scope)}…`);

    const rawRows = await executeD1<TokenRow>(
      `SELECT token, name, scopes, created_at, updated_at FROM token WHERE scopes LIKE '%${escapeSql(scope)}/%';`,
      { rows: true, local: argumentsValue.local, cwd: apiCwd }
    );

    const rows = rawRows.filter(isTokenRow);

    cliSpinner.stop();

    if (!rows.length) {
      log.warn(`No tokens found for scope ${chalk.bold.white(scope)}.`);
      outro("Done.");
      return;
    }

    const allPackages = Array.from(
      new Set(
        rows.flatMap((row) =>
          parseScopes(row.scopes)
            .flatMap((entry) => entry.values)
            .filter((value) => value.startsWith(`${scope}/`))
        )
      )
    ).sort();

    if (!allPackages.length) {
      log.warn(`Tokens exist but no packages under ${chalk.bold.white(scope)} were found.`);
      outro("Done.");
      return;
    }

    const maxPackageColumns = 4;
    const displayedPackages = allPackages.slice(0, maxPackageColumns);
    const hasMorePackages = allPackages.length > maxPackageColumns;

    const widths = [32, 24, ...displayedPackages.map(() => 8)];
    const header = [
      "Token",
      "Label",
      ...displayedPackages.map((packageName) => packageName.replace(`${scope}/`, "").slice(0, 8))
    ];

    const tableRows = rows.map((row) => {
      const scopes = parseScopes(row.scopes);

      return [
        chalk.white(row.token),
        chalk.gray(row.name || "—"),
        ...displayedPackages.map((packageName) => fmtPerm(resolvePerms(scopes, packageName)))
      ];
    });

    renderTable(header, tableRows, widths);
    renderLegend();

    if (hasMorePackages) {
      log.info(
        chalk.gray(
          `Showing ${maxPackageColumns} of ${allPackages.length} packages. Use ${chalk.white("token list --package <name>")} to inspect one package.`
        )
      );
    }

    log.info(
      chalk.gray(
        `${rows.length} token(s) · ${allPackages.length} package(s) · scope ${chalk.white(scope)} · ${argumentsValue.local ? "local" : "remote"} D1`
      )
    );

    outro("Done.");
  } catch (error) {
    cliSpinner.stop("Loading scope tokens failed.");
    throw error;
  }
}

async function promptScopeForList(local: boolean): Promise<string> {
  const rows = await getAllTokenRows(local);
  const scopeOptions = getScopeOptions(rows);

  if (!scopeOptions.length) {
    return promptScopeName();
  }

  const scopeSelectionMode = await select<"select" | "manual">({
    message: "How do you want to choose the scope?",
    options: [
      { value: "select", label: "Select from existing scopes" },
      { value: "manual", label: "Enter scope manually" }
    ]
  });

  if (isCancel(scopeSelectionMode)) {
    process.exit(1);
  }

  if (scopeSelectionMode === "manual") {
    return promptScopeName();
  }

  const selectedScope = await select<string>({
    message: "Select scope to inspect:",
    options: scopeOptions
  });

  if (isCancel(selectedScope)) {
    process.exit(1);
  }

  return selectedScope;
}

function getScopeOptions(rows: TokenRow[]) {
  const scopeToPackages = new Map<string, Set<string>>();

  for (const row of rows) {
    for (const packageName of getPackageNamesFromScopes(parseScopes(row.scopes))) {
      const scope = packageName.split("/")[0];

      if (!scopeToPackages.has(scope)) {
        scopeToPackages.set(scope, new Set());
      }

      scopeToPackages.get(scope)?.add(packageName);
    }
  }

  const allScopes = getScopesFromRows(rows);

  return allScopes.map((scope) => ({
    value: scope,
    label: scope,
    hint: `${scopeToPackages.get(scope)?.size ?? 0} package(s)`
  }));
}
