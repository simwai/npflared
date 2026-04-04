import { intro, isCancel, log, outro, select } from "@clack/prompts";
import chalk from "chalk";
import type { CommandModule } from "yargs";
import { cliContext } from "../../utils/context";
import { listTokensForScope } from "./list-scope";
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
  isScopeOnly,
  isTokenRow,
  parseScopes,
  promptPackageName,
  renderLegend,
  renderTable,
  resolvePerms,
  validatePackageOrScopeName
} from "./shared";
import type { ListTokensArgs, PackagePerms, TokenRow } from "./types";

type TokenWithPerms = {
  row: TokenRow;
  packagePerms: PackagePerms;
};

export const listCommand: CommandModule = {
  command: "list",
  describe: "List tokens for a package or scope",
  builder: (yargsBuilder) =>
    yargsBuilder
      .option("package", {
        alias: "p",
        type: "string",
        describe: "Full package name (e.g. @scope/pkg) or scope (e.g. @scope)"
      })
      .check((parsedArguments) => {
        if (parsedArguments.package) {
          const error = validatePackageOrScopeName(parsedArguments.package as string | undefined);
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
    await cliContext.run({ packageManagerAgent: "pnpm" }, async () => {
      const packageOrScope = parsedArguments.package as string | undefined;
      const local = Boolean(parsedArguments.local);

      if (packageOrScope && isScopeOnly(packageOrScope.trim())) {
        await listTokensForScope({ scope: packageOrScope, local });
        return;
      }

      if (packageOrScope) {
        await listTokensForPackage({ package: packageOrScope, local });
        return;
      }

      await listTokensInteractively(local);
    });
  }
};

async function listTokensInteractively(local: boolean) {
  intro(chalk.bold(`npflared  token list  ${chalk.gray(local ? "local" : "remote")}`));

  const listMode = await select<"package" | "scope">({
    message: "What do you want to inspect?",
    options: [
      { value: "package", label: "A single package" },
      { value: "scope", label: "An entire scope" }
    ]
  });

  if (isCancel(listMode)) {
    process.exit(1);
  }

  if (listMode === "scope") {
    await listTokensForScope({ local, skipIntro: true });
    return;
  }

  await listTokensForPackage({ local, skipIntro: true });
}

async function listTokensForPackage(argumentsValue: ListTokensArgs) {
  if (!argumentsValue.skipIntro) {
    intro(chalk.bold(`npflared  token list  ${chalk.gray(argumentsValue.local ? "local" : "remote")}`));
  }

  await ensureRemoteCloudflareAccount(argumentsValue.local);

  const packageName = argumentsValue.package ?? (await promptPackageForList(argumentsValue.local));

  if (isScopeOnly(packageName)) {
    log.warn(`"${packageName}" is a scope, not a package. Redirecting to scope view…`);
    await listTokensForScope({
      scope: packageName,
      local: argumentsValue.local,
      skipIntro: true
    });
    return;
  }

  try {
    cliSpinner.start(`Loading tokens for ${chalk.bold(packageName)}…`);

    const rawRows = await executeD1<TokenRow>(
      `SELECT token, name, scopes, created_at, updated_at FROM token WHERE scopes LIKE '%${escapeSql(packageName)}%';`,
      { rows: true, local: argumentsValue.local, cwd: apiCwd }
    );

    const rows: TokenRow[] = rawRows.filter(isTokenRow);

    cliSpinner.stop();

    if (!rows.length) {
      log.warn(`No tokens found for ${chalk.bold.white(packageName)}.`);
      outro("Done.");
      return;
    }

    const tokenRowsWithPerms: TokenWithPerms[] = rows.map((row: TokenRow) => ({
      row,
      packagePerms: resolvePerms(parseScopes(row.scopes), packageName)
    }));

    const tableRows = tokenRowsWithPerms
      .sort(
        (left: TokenWithPerms, right: TokenWithPerms) =>
          getPackagePermWeight(right.packagePerms) - getPackagePermWeight(left.packagePerms)
      )
      .map(({ row, packagePerms }: TokenWithPerms) => [
        chalk.white(fmtToken(row.token)),
        chalk.gray(row.name || "—"),
        packagePerms.read ? chalk.green("✔") : chalk.dim("✖"),
        packagePerms.write ? chalk.green("✔") : chalk.dim("✖"),
        fmtPerm(packagePerms),
        chalk.dim(fmtAge(row.created_at))
      ]);

    renderTable(["Token", "Label", "Read", "Write", "Mode", "Created"], tableRows, [32, 28, 6, 6, 6, 10]);

    renderLegend();

    log.info(
      chalk.gray(
        `${rows.length} token(s) for ${chalk.white(packageName)} on ${argumentsValue.local ? "local" : "remote"} D1`
      )
    );

    outro("Done.");
  } catch (error) {
    cliSpinner.stop("Loading tokens failed.");
    throw error;
  }
}

async function promptPackageForList(local: boolean): Promise<string> {
  const rows = await getAllTokenRows(local);
  const packageOptions = getPackageOptions(rows);

  if (!packageOptions.length) {
    return promptPackageName();
  }

  const packageSelectionMode = await select<"select" | "manual">({
    message: "How do you want to choose the package?",
    options: [
      { value: "select", label: "Select from existing packages" },
      { value: "manual", label: "Enter package manually" }
    ]
  });

  if (isCancel(packageSelectionMode)) {
    process.exit(1);
  }

  if (packageSelectionMode === "manual") {
    return promptPackageName();
  }

  const selectedPackage = await select<string>({
    message: "Select package to inspect:",
    options: packageOptions
  });

  if (isCancel(selectedPackage)) {
    process.exit(1);
  }

  return selectedPackage;
}

function getPackageOptions(rows: TokenRow[]) {
  const counts = new Map<string, number>();

  for (const row of rows) {
    const packageNames = new Set(getPackageNamesFromScopes(parseScopes(row.scopes)));

    for (const packageName of packageNames) {
      counts.set(packageName, (counts.get(packageName) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([value, count]) => ({
      value,
      label: value,
      hint: `${count} token(s)`
    }));
}

function getPackagePermWeight(packagePerms: PackagePerms) {
  if (packagePerms.read && packagePerms.write) return 2;
  if (packagePerms.write) return 1;
  if (packagePerms.read) return 0;
  return -1;
}
