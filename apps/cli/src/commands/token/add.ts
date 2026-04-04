import { intro, isCancel, log, multiselect, outro, select } from "@clack/prompts";
import chalk from "chalk";
import type { CommandModule } from "yargs";
import { cliContext } from "../../utils/context";
import {
  cliSpinner,
  createTokenProgrammatically,
  ensureRemoteCloudflareAccount,
  getAllTokenRows,
  getPackagesFromRows,
  parsePackageList,
  promptPackageNames,
  promptScopeMode,
  promptTokenName,
  validatePackageList
} from "./shared";
import type { CreateTokenArgs, TokenScopeType } from "./types";

export const addCommand: CommandModule = {
  command: ["add", "create"],
  describe: "Create a new token scoped to one or more packages",
  builder: (yargsBuilder) =>
    yargsBuilder
      .option("package", {
        alias: "p",
        type: "string",
        array: true,
        describe: "Package name(s), repeatable or comma-separated (e.g. -p @scope/a -p @scope/b)"
      })
      .check((parsedArguments) => {
        const packageNames = parsePackageList(parsedArguments.package as string[] | string | undefined);

        if (parsedArguments.package) {
          const error = validatePackageList(packageNames);
          if (error) throw new Error(error);
        }

        return true;
      })
      .option("mode", {
        alias: "m",
        choices: ["package:read", "package:write", "package:read+write"] as const
      })
      .option("name", {
        alias: "n",
        type: "string",
        describe: "Label for this token"
      })
      .option("local", {
        alias: "l",
        type: "boolean",
        default: false,
        describe: "Use local D1"
      }),
  handler: async (parsedArguments) => {
    await cliContext.run({ packageManagerAgent: "pnpm" }, () =>
      createToken({
        packages: parsePackageList(parsedArguments.package as string[] | string | undefined),
        mode: parsedArguments.mode as TokenScopeType | undefined,
        name: parsedArguments.name as string | undefined,
        local: Boolean(parsedArguments.local)
      })
    );
  }
};

async function createToken(argumentsValue: CreateTokenArgs) {
  intro(chalk.bold(`npflared  token add  ${chalk.gray(argumentsValue.local ? "local" : "remote")}`));
  await ensureRemoteCloudflareAccount(argumentsValue.local);

  const packageNames = argumentsValue.packages?.length
    ? argumentsValue.packages
    : await promptPackageNamesForCreate(argumentsValue.local);

  const scopeType = argumentsValue.mode ?? (await promptScopeMode());
  const tokenLabel = argumentsValue.name ?? (await promptTokenName(packageNames));

  try {
    cliSpinner.start("Creating token…");

    const tokenValue = await createTokenProgrammatically({
      packageNames,
      scopeType,
      tokenLabel,
      local: argumentsValue.local
    });

    cliSpinner.stop("Token created.");

    log.success(
      [
        "",
        `  Token     ${chalk.bold.white(tokenValue)}`,
        `  Packages  ${chalk.bold.white(String(packageNames.length))}`,
        `  Mode      ${chalk.bold.white(scopeType)}`,
        `  Label     ${chalk.bold.white(tokenLabel)}`,
        `  Target    ${chalk.bold.white(argumentsValue.local ? "local D1" : "remote D1")}`,
        "",
        ...packageNames.map((packageName) => `  - ${chalk.white(packageName)}`),
        "",
        chalk.gray("Add to .npmrc:"),
        chalk.gray("  @babadeluxe:registry=https://your-npflared-url"),
        chalk.gray(`  //your-npflared-url/:_authToken=${tokenValue}`),
        ""
      ].join("\n")
    );

    outro("Done.");
  } catch (error) {
    cliSpinner.stop("Token creation failed.");
    throw error;
  }
}

async function promptPackageNamesForCreate(local: boolean): Promise<string[]> {
  const existingPackages = getPackagesFromRows(await getAllTokenRows(local));

  if (!existingPackages.length) {
    return promptPackageNames();
  }

  const packageSelectionMode = await select<"select" | "manual">({
    message: "How do you want to choose packages?",
    options: [
      { value: "select", label: "Select from existing packages" },
      { value: "manual", label: "Enter package names manually" }
    ]
  });

  if (isCancel(packageSelectionMode)) process.exit(1);

  if (packageSelectionMode === "manual") {
    return promptPackageNames();
  }

  const selectedPackages = await multiselect<string>({
    message: "Select package access:",
    options: existingPackages.map((value) => ({
      value,
      label: value
    }))
  });

  if (isCancel(selectedPackages)) process.exit(1);

  return Array.from(new Set(selectedPackages)).sort();
}
