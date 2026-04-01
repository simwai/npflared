import { rmSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCancel, log, spinner, text } from "@clack/prompts";
import chalk from "chalk";
import dedent from "dedent";
import { $ } from "zx";
import { createTokenProgrammatically, type TokenScopeType } from "./token";

const cliSpinner = spinner();

type TestOptions = {
	local?: boolean;
	port?: number;
};

export const test = async ({ local = false, port = 8787 }: TestOptions = {}) => {
	let deployedUrl: string;

	if (local) {
		deployedUrl = `http://127.0.0.1:${port}`;
		log.info(`Using local dev registry at ${deployedUrl}`);
	} else {
		const urlInput = await text({
			message: "Enter your deployed worker URL (from npflared install output):",
			validate(value) {
				const v = value ?? "";
				if (!v.startsWith("http")) {
					return "Please enter a valid URL starting with http:// or https://";
				}
			}
		});
		if (isCancel(urlInput)) process.exit(1);
		deployedUrl = urlInput;
	}

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
		try {
			rmSync(publishTmpDir, { recursive: true, force: true });
		} catch {}
		try {
			rmSync(installTmpDir, { recursive: true, force: true });
		} catch {}
	};

	// 1. Create test package
	await $({ cwd: publishTmpDir })`pnpm init --bare`;

	const pkgJsonPath = join(publishTmpDir, "package.json");
	const pkg = JSON.parse(
		await readFile(pkgJsonPath, "utf-8")
	) as {
		name?: string;
		version?: string;
		publishConfig?: { access: string; registry: string };
	};

	if (!pkg.name || typeof pkg.name !== "string") {
		pkg.name = `${testScope}/test-package`;
	}

	// Generate a unique version for each test run
	const uniqueVersion = `0.0.0-test-${Date.now()}-${Math.random()
		.toString(36)
		.slice(2, 8)}`;
	pkg.version = uniqueVersion;

	const bareName = pkg.name.replace(/^@[^/]+\//, "");
	pkg.name = `${testScope}/${bareName}`;

	pkg.publishConfig = {
		access: "public",
		registry: deployedUrl
	};

	// Log the package we are going to publish
	log.info(
		chalk.cyan(
			`Test package:\n  name: ${pkg.name}\n  version: ${pkg.version}\n  registry: ${pkg.publishConfig.registry}`
		)
	);

	await writeFile(pkgJsonPath, JSON.stringify(pkg, null, 2), "utf-8");

	await $({ cwd: publishTmpDir })`node -e "require('fs').writeFileSync('index.js','// index.js')"`;

	// 2. Mint a short-lived test token scoped to this package (read+write)
	const scopeType: TokenScopeType = "package:read+write";
	const tokenLabel = `cli-test-${pkg.name}`;
	log.info("Minting test token...");
	const testToken = await createTokenProgrammatically({
		pkgName: pkg.name,
		scopeType,
		tokenLabel,
		local
	});

	// 3. Configure .npmrc for PUBLISH dir
	const url = new URL(deployedUrl);
	const registryHost = url.host;
	const registryBase = deployedUrl.replace(/\/$/, "");

	const publishNpmrc = [
		`${testScope}:registry=${registryBase}`,
		`//${registryHost}/:_authToken=${testToken}`,
		""
	].join("\n");

	await writeFile(join(publishTmpDir, ".npmrc"), publishNpmrc, "utf-8");

	log.info(
		chalk.gray(
			`Publish .npmrc:\n${publishNpmrc
				.split("\n")
				.map((l) => `  ${l}`)
				.join("\n")}`
		)
	);

	// 4. Publish
	cliSpinner.start("Publishing test package...");
	try {
		await $({ quiet: true, cwd: publishTmpDir })`pnpm publish --access public`;
		cliSpinner.stop("Successfully published test package");
	} catch (publishErr) {
		cliSpinner.stop(chalk.red(`Failed to publish: ${publishErr}`));
		throw publishErr;
	}

	// 5. Prepare INSTALL dir & .npmrc
	await $({ cwd: installTmpDir })`pnpm init --bare`;

	const installNpmrc = [
		`${testScope}:registry=${registryBase}`,
		`//${registryHost}/:_authToken=${testToken}`,
		""
	].join("\n");

	await writeFile(join(installTmpDir, ".npmrc"), installNpmrc, "utf-8");

	log.info(
		chalk.gray(
			`Install .npmrc:\n${installNpmrc
				.split("\n")
				.map((l) => `  ${l}`)
				.join("\n")}`
		)
	);

	// 6. Install
	cliSpinner.start("Installing test package...");
	try {
		const { name, version } = JSON.parse(
			await readFile(pkgJsonPath, "utf-8")
		) as { name: string; version: string };

		// Log the exact spec pnpm will install
		log.info(
			chalk.cyan(
				`Installing package:\n  spec: ${name}@${version}\n  from: ${registryBase}`
			)
		);

		await $({ quiet: true, cwd: installTmpDir })`pnpm add ${name}@${version}`;
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
            - Minted test token: ${chalk.bold.white(`${testToken.slice(0, 8)}...`)}
            - Worker URL: ${chalk.bold.white(deployedUrl)}${local ? " (local)" : ""}
            - Test scope: ${chalk.bold.white(testScope)}
        `
		)
	);

	cleanup();
};