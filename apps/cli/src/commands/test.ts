import { rmSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCancel, log, password, spinner, text } from "@clack/prompts";
import chalk from "chalk";
import dedent from "dedent";
import { $ } from "zx";

const cliSpinner = spinner();

export const test = async () => {
	const adminToken = await password({
		message: "Enter your admin token (from npflared install output):"
	});
	if (isCancel(adminToken)) process.exit(1);

	const deployedUrl = await text({
		message: "Enter your deployed worker URL (from npflared install output):",
		validate(value) {
			const v = value ?? "";
			if (!v.startsWith("http")) {
				return "Please enter a valid URL starting with http:// or https://";
			}
		}
	});
	if (isCancel(deployedUrl)) process.exit(1);

	const testScope = await text({
		message: "Enter test scope (default: @npflared-test):",
		initialValue: "@npflared-test",
		validate(value) {
			const v = value ?? "";
			if (!v.startsWith("@")) {
				return "Scope must start with '@'";
			}
		}
	});
	if (isCancel(testScope)) process.exit(1);

	const publishTmpDir = await mkdtemp(join(tmpdir(), "npflared-publish-"));
	const installTmpDir = await mkdtemp(join(tmpdir(), "npflared-install-"));

	const cleanup = () => {
		if (publishTmpDir) rmSync(publishTmpDir, { recursive: true, force: true });
		if (installTmpDir) rmSync(installTmpDir, { recursive: true, force: true });
	};

	process.on("exit", cleanup);
	process.on("SIGINT", cleanup);
	process.on("SIGTERM", cleanup);

	try {
		process.chdir(publishTmpDir);
		await $`pnpm init --scope=${testScope} -y`;
		await $`echo "// index.js" > index.js`;

		const registryHost = new URL(deployedUrl).hostname;
		await writeFile(
			join(publishTmpDir, ".npmrc"),
			`//${registryHost}/:_authToken=${adminToken}\nregistry=${deployedUrl}\n`
		);

		cliSpinner.start("Publishing test package...");
		try {
			await $({
				quiet: true,
				cwd: publishTmpDir
			})`pnpm publish --access public`;
			cliSpinner.stop("Successfully published test package");
		} catch (publishErr) {
			cliSpinner.stop(chalk.red(`Failed to publish: ${publishErr}`));
			throw publishErr;
		}

		process.chdir(installTmpDir);
		await $`pnpm init -y`;

		const { version } = JSON.parse(await readFile(join(publishTmpDir, "package.json"), "utf-8"));

		cliSpinner.start("Installing test package...");
		try {
			await $({
				quiet: true,
				cwd: installTmpDir
			})`pnpm add ${testScope}@${version}`;
			cliSpinner.stop("Successfully installed test package");
		} catch (installErr) {
			cliSpinner.stop(chalk.red(`Failed to install: ${installErr}`));
			throw installErr;
		}

		log.info(
			chalk.green(
				dedent`
          ✅ Test passed!
          📦 Published and installed test package successfully using:
            - Admin token: ${chalk.bold.white(adminToken.slice(0, 8)) + "..."}
            - Worker URL: ${chalk.bold.white(deployedUrl)}
            - Test scope: ${chalk.bold.white(testScope)}
        `
			)
		);
	} catch (error) {
		log.error(`${error}`);
		process.exit(1);
	} finally {
		cleanup();
	}
};
