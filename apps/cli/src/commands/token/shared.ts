import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { isCancel, log, select, spinner, text } from "@clack/prompts";
import chalk from "chalk";
import { encode as encodeBase32 } from "uuid-b32";
import { executeD1, getLocalAccountId } from "../../utils/cloudflare";
import type { PackagePerms, ParsedScope, TokenRow, TokenScopeType } from "./types";

export const apiCwd = resolve(import.meta.dirname, "../../../../api");
export const cliSpinner = spinner();

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const isTokenRow = (value: unknown): value is TokenRow =>
  isRecord(value) &&
  typeof value.token === "string" &&
  typeof value.name === "string" &&
  typeof value.scopes === "string" &&
  typeof value.created_at === "number" &&
  typeof value.updated_at === "number";

export const isScopeOnly = (value: string) => value.startsWith("@") && !value.includes("/");

export const parseScopes = (value: string): ParsedScope[] => {
  try {
    const parsed: unknown = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? (parsed as ParsedScope[]) : [];
  } catch {
    return [];
  }
};

export const getPackageNamesFromScopes = (scopes: ParsedScope[]): string[] =>
  Array.from(
    new Set(
      scopes.flatMap((entry) =>
        Array.isArray(entry.values)
          ? entry.values.filter((value): value is string => typeof value === "string" && value.includes("/"))
          : []
      )
    )
  ).sort();

export const getPackagesFromRows = (rows: TokenRow[]): string[] =>
  Array.from(new Set(rows.flatMap((row) => getPackageNamesFromScopes(parseScopes(row.scopes))))).sort();

export const getScopesFromRows = (rows: TokenRow[]): string[] =>
  Array.from(
    new Set(
      getPackagesFromRows(rows)
        .map((packageName) => packageName.split("/")[0])
        .filter(Boolean)
    )
  ).sort();

export const resolvePerms = (scopes: ParsedScope[], packageName: string): PackagePerms => {
  const entries = scopes.filter((entry) => Array.isArray(entry.values) && entry.values.includes(packageName));

  return {
    read: entries.some((entry) => entry.type === "package:read" || entry.type === "package:read+write"),
    write: entries.some((entry) => entry.type === "package:write" || entry.type === "package:read+write"),
    types: entries.map((entry) => entry.type)
  };
};

export const fmtPerm = (packagePerms: PackagePerms): string => {
  if (packagePerms.read && packagePerms.write) return chalk.green("R/W");
  if (packagePerms.read) return chalk.cyan("R");
  if (packagePerms.write) return chalk.yellow("W");
  return chalk.dim("·");
};

export const renderLegend = () => {
  log.info(
    chalk.gray("Legend: ") +
      `${chalk.green("R/W")} read+write  ` +
      `${chalk.cyan("R")} read/install  ` +
      `${chalk.yellow("W")} write/publish  ` +
      `${chalk.dim("·")} no access`
  );
};

export const fmtToken = (token: string) => token;

export const formatTokenPreview = (token: string) =>
  token.length <= 18 ? token : `${token.slice(0, 8)}…${token.slice(-8)}`;

export const fmtAge = (createdAt: number): string => {
  const seconds = Math.floor(Date.now() / 1000) - createdAt;

  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
};

// biome-ignore lint/suspicious/noControlCharactersInRegex: valid pattern
export const stripAnsi = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");

export const formatRow = (columns: string[], widths: number[]) =>
  columns
    .map((column, index) => {
      const width = widths[index];
      const plain = stripAnsi(column);
      const truncated = plain.length > width ? `${plain.slice(0, width - 1)}…` : plain;
      return truncated + " ".repeat(Math.max(width - truncated.length, 0));
    })
    .join("  ");

export const renderTable = (header: string[], rows: string[][], widths: number[]) => {
  log.info("");
  log.info(
    formatRow(
      header.map((value) => chalk.bold(value)),
      widths
    )
  );
  log.info(chalk.gray("─".repeat(widths.reduce((total, width) => total + width + 2, -2))));
  for (const row of rows) {
    log.info(formatRow(row, widths));
  }
  log.info("");
};

export const ensureCloudflareAccount = async (): Promise<string> => {
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

export const ensureRemoteCloudflareAccount = async (local: boolean) => {
  if (!local) {
    await ensureCloudflareAccount();
  }
};

export const validateScopedPackageName = (value?: string): string | undefined => {
  const trimmed = value?.trim();

  if (!trimmed) return "Please enter a package name.";
  if (!trimmed.startsWith("@")) return "Package must start with '@'.";
  if (!trimmed.includes("/")) return "Enter a full package name like @scope/pkg, not just a scope.";

  const [, name] = trimmed.split("/");
  if (!name?.trim()) return "Package name must include both scope and package, e.g. @scope/pkg.";

  return undefined;
};

export const validateScopeName = (value?: string): string | undefined => {
  const trimmed = value?.trim();

  if (!trimmed) return "Please enter a scope.";
  if (!trimmed.startsWith("@")) return "Scope must start with '@'.";
  if (trimmed.includes("/")) return "Enter only the scope prefix, e.g. @babadeluxe.";

  return undefined;
};

export const validatePackageOrScopeName = (value?: string): string | undefined => {
  const trimmed = value?.trim();

  if (!trimmed) return "Please enter a package or scope.";
  if (isScopeOnly(trimmed)) return undefined;

  return validateScopedPackageName(trimmed);
};

export const parsePackageList = (value?: string | string[]): string[] => {
  const rawValues = Array.isArray(value) ? value : [value ?? ""];

  return Array.from(
    new Set(
      rawValues
        .flatMap((entry) => entry.split(","))
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
  );
};

export const validatePackageList = (values?: string[]): string | undefined => {
  if (!values?.length) return "Please enter at least one package.";

  for (const packageName of values) {
    const error = validateScopedPackageName(packageName);
    if (error) return `${packageName}: ${error}`;
  }

  return undefined;
};

export const promptPackageNames = async (): Promise<string[]> => {
  const value = await text({
    message: "Package names (comma-separated, e.g. @scope/a, @scope/b):",
    validate(inputValue) {
      return validatePackageList(parsePackageList(inputValue));
    }
  });

  if (isCancel(value)) process.exit(1);

  return parsePackageList(value);
};

export const buildScopesJson = (scopeType: TokenScopeType, packageNames: string[]) =>
  JSON.stringify([{ type: scopeType, values: packageNames }]);

export const promptPackageName = async (): Promise<string> => {
  const packageName = await text({
    message: "Package name (e.g. @scope/pkg):",
    validate: validateScopedPackageName
  });

  if (isCancel(packageName)) process.exit(1);

  return packageName.trim();
};

export const normalizeScope = (value: string) => (value.startsWith("@") ? value : `@${value}`);

export const promptScopeName = async (initialValue = "@babadeluxe"): Promise<string> => {
  const scope = await text({
    message: "Package scope (e.g. @babadeluxe):",
    initialValue,
    validate: validateScopeName
  });

  if (isCancel(scope)) process.exit(1);

  return normalizeScope(scope.trim());
};

export const promptTokenValue = async (): Promise<string> => {
  const token = await text({
    message: "Token value:",
    validate(value) {
      if (!value?.trim()) return "Please enter a token value.";
    }
  });

  if (isCancel(token)) process.exit(1);

  return token.trim();
};

export const promptScopeMode = async (): Promise<TokenScopeType> => {
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

export const promptTokenName = async (packageNames: string[]): Promise<string> => {
  const initialValue =
    packageNames.length === 1 ? `${packageNames[0]}-token` : `${packageNames[0].split("/")[0]}-multi-package-token`;

  const name = await text({
    message: "Token label (for your reference):",
    initialValue,
    validate(value) {
      if (!value?.trim()) return "Please enter a label.";
    }
  });

  if (isCancel(name)) process.exit(1);

  return name.trim();
};

export const escapeSql = (value: string) => value.replace(/'/g, "''");

export const getAllTokenRows = async (local: boolean): Promise<TokenRow[]> => {
  const rawRows = await executeD1<TokenRow>(
    "SELECT token, name, scopes, created_at, updated_at FROM token ORDER BY updated_at DESC;",
    { rows: true, local, cwd: apiCwd }
  );

  return rawRows.filter(isTokenRow);
};

export const getTokenOptionsFromRows = (rows: TokenRow[]) =>
  [...rows]
    .sort((left, right) => right.updated_at - left.updated_at)
    .map((row) => ({
      value: row.token,
      label: row.name || formatTokenPreview(row.token),
      hint: `${getPackageNamesFromScopes(parseScopes(row.scopes)).length} package(s) · ${fmtAge(row.updated_at)}`
    }));

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
VALUES ('${tokenValue}', '${escapeSql(tokenLabel)}', '${scopesJson}', ${nowSql}, ${nowSql});`,
    { local, cwd: apiCwd, useFile: true }
  );

  return tokenValue;
};

export { executeD1 };
