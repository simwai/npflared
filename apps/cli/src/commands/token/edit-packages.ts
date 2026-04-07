import { confirm, intro, isCancel, log, multiselect, outro, select } from '@clack/prompts'
import chalk from 'chalk'
import type { CommandModule } from 'yargs'
import { cliContext } from '../../utils/context'
import {
  apiCwd,
  cliSpinner,
  ensureRemoteCloudflareAccount,
  escapeSql,
  executeD1,
  fmtToken,
  getAllTokenRows,
  getPackagesFromRows,
  getTokenOptionsFromRows,
  isTokenRow,
  parsePackageList,
  parseScopes,
  promptPackageNames,
  promptTokenValue,
  validatePackageList,
} from './shared'
import type { ParsedScope, TokenRow } from './types'

type EditPackagesArgs = {
  token?: string
  packages?: string[]
  local: boolean
}

export const editPackagesCommand: CommandModule = {
  command: ['edit-packages', 'set-packages', 'override-packages'],
  describe: 'Override the packages associated with a token',
  builder: (yargsBuilder) =>
    yargsBuilder
      .option('token', {
        alias: 't',
        type: 'string',
        describe: 'Token value to edit',
      })
      .option('package', {
        alias: 'p',
        type: 'string',
        array: true,
        describe: 'Package name(s), repeatable or comma-separated (e.g. -p @scope/a -p @scope/b)',
      })
      .check((parsedArguments) => {
        const packageNames = parsePackageList(parsedArguments.package as string[] | string | undefined)

        if (parsedArguments.package) {
          const error = validatePackageList(packageNames)
          if (error) {
            throw new Error(error)
          }
        }

        return true
      })
      .option('local', {
        alias: 'l',
        type: 'boolean',
        default: false,
        describe: 'Use local D1',
      }),
  handler: async (parsedArguments) => {
    await cliContext.run({ packageManagerAgent: 'npm' }, () =>
      editTokenPackages({
        token: parsedArguments.token as string | undefined,
        packages: parsePackageList(parsedArguments.package as string[] | string | undefined),
        local: Boolean(parsedArguments.local),
      })
    )
  },
}

async function editTokenPackages(args: EditPackagesArgs) {
  intro(chalk.bold(`npflared  token edit-packages  ${chalk.gray(args.local ? 'local' : 'remote')}`))
  await ensureRemoteCloudflareAccount(args.local)

  const tokenValue = args.token ?? (await promptTokenForEdit(args.local))

  try {
    cliSpinner.start(`Loading token ${fmtToken(tokenValue)}…`)

    const rawRows = await executeD1<TokenRow>(
      `SELECT token, name, scopes, created_at, updated_at FROM token WHERE token = '${escapeSql(tokenValue)}';`,
      { rows: true, local: args.local, cwd: apiCwd }
    )

    const row = rawRows.find(isTokenRow)

    cliSpinner.stop()

    if (!row) {
      log.error(`Token ${chalk.bold.white(fmtToken(tokenValue))} not found.`)
      outro('Done.')
      return
    }

    const parsedScopes = parseScopes(row.scopes)
    const scopeType = getSingleScopeType(parsedScopes)

    if (!scopeType) {
      log.error('This token has no editable package scope definition.')
      outro('Done.')
      return
    }

    const currentPackages = getPackagesFromParsedScopes(parsedScopes)
    const packageNames = args.packages?.length
      ? args.packages
      : await promptPackagesForEdit(args.local, currentPackages)

    const shouldUpdate = await confirm({
      message: `Override package access for token ${fmtToken(tokenValue)}?`,
    })

    if (isCancel(shouldUpdate) || !shouldUpdate) {
      outro('Cancelled.')
      return
    }

    log.warn(
      `Impact: this token will keep mode ${chalk.bold.white(scopeType)} but lose access to ${currentPackages.length} previous package(s) and gain access only to ${packageNames.length} selected package(s).`
    )

    const shouldProceed = await confirm({
      message: `Apply package override now?`,
    })

    if (isCancel(shouldProceed) || !shouldProceed) {
      outro('Cancelled.')
      return
    }

    const nextScopes = JSON.stringify([{ type: scopeType, values: packageNames }])
    const nowSql = "strftime('%s','now')"

    cliSpinner.start('Updating token packages…')

    await executeD1(
      `UPDATE token SET scopes = '${escapeSql(nextScopes)}', updated_at = ${nowSql} WHERE token = '${escapeSql(tokenValue)}';`,
      { local: args.local, cwd: apiCwd, useFile: true }
    )

    cliSpinner.stop('Token packages updated.')

    log.success(
      [
        '',
        `  Token     ${chalk.bold.white(tokenValue)}`,
        `  Label     ${chalk.bold.white(row.name || '—')}`,
        `  Mode      ${chalk.bold.white(scopeType)}`,
        `  Packages  ${chalk.bold.white(String(packageNames.length))}`,
        '',
        ...packageNames.map((packageName) => `  - ${chalk.white(packageName)}`),
        '',
      ].join('\n')
    )

    outro('Done.')
  } catch (error) {
    cliSpinner.stop('Token update failed.')
    throw error
  }
}

async function promptTokenForEdit(local: boolean): Promise<string> {
  const rows = await getAllTokenRows(local)
  const tokenOptions = getTokenOptionsFromRows(rows)

  if (!tokenOptions.length) {
    log.warn('No existing tokens found. Enter a token manually.')
    return promptTokenValue()
  }

  const tokenSelectionMode = await select<'select' | 'manual'>({
    message: 'How do you want to choose the token?',
    options: [
      { value: 'select', label: 'Select an existing token' },
      { value: 'manual', label: 'Enter token manually' },
    ],
  })

  if (isCancel(tokenSelectionMode)) {
    process.exit(1)
  }

  if (tokenSelectionMode === 'manual') {
    return promptTokenValue()
  }

  const selectedToken = await select<string>({
    message: 'Select token to edit:',
    options: tokenOptions,
  })

  if (isCancel(selectedToken)) {
    process.exit(1)
  }

  return selectedToken
}

async function promptPackagesForEdit(local: boolean, currentPackages: string[]): Promise<string[]> {
  const existingPackages = getPackagesFromRows(await getAllTokenRows(local))
  const initialValues = currentPackages.filter((packageName) => existingPackages.includes(packageName))

  if (!existingPackages.length) {
    return promptPackageNames()
  }

  const packageSelectionMode = await select<'select' | 'manual'>({
    message: 'How do you want to choose packages?',
    options: [
      { value: 'select', label: 'Select from existing packages' },
      { value: 'manual', label: 'Enter package names manually' },
    ],
  })

  if (isCancel(packageSelectionMode)) {
    process.exit(1)
  }

  if (packageSelectionMode === 'manual') {
    return promptPackageNames()
  }

  const selectedPackages = await multiselect<string>({
    message: 'Select package access:',
    initialValues,
    options: existingPackages.map((value) => ({
      value,
      label: value,
    })),
    required: true,
  })

  if (isCancel(selectedPackages)) {
    process.exit(1)
  }

  return Array.from(new Set(selectedPackages)).sort()
}

function getSingleScopeType(scopes: ParsedScope[]): string | undefined {
  const firstEntry = scopes.find((entry) => Array.isArray(entry.values))
  return firstEntry?.type
}

function getPackagesFromParsedScopes(scopes: ParsedScope[]): string[] {
  return Array.from(
    new Set(
      scopes.flatMap((entry) =>
        Array.isArray(entry.values)
          ? entry.values.filter((value): value is string => typeof value === 'string' && value.includes('/'))
          : []
      )
    )
  ).sort()
}
