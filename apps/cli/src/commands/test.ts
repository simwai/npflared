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

type RegistryConfig = {
	local: boolean;
	deployedUrl: string;
	registryBase: string;
	registryHost: string;
	testScope: string;
	testToken: string;
};

type PublishedPackage = {
	name: string;
	version: string;
};

async function writeScopedNpmrc(dir: string, cfg: RegistryConfig) {
	const npmrc = [
		`${cfg.testScope}:registry=${cfg.registryBase}`,
		`//${cfg.registryHost}/:_authToken=${cfg.testToken}`,
		""
	].join("\n");

	await writeFile(join(dir, ".npmrc"), npmrc, "utf-8");

	log.info(
		chalk.gray(
			`Using .npmrc in ${dir}:\n${npmrc
				.split("\n")
				.map((l) => `  ${l}`)
				.join("\n")}`
		)
	);
}

async function createAndPublishTestPackage(publishTmpDir: string, cfg: RegistryConfig): Promise<PublishedPackage> {
	await $({ cwd: publishTmpDir })`pnpm init --bare`;

	const pkgJsonPath = join(publishTmpDir, "package.json");
	const pkg = JSON.parse(await readFile(pkgJsonPath, "utf-8")) as {
		name?: string;
		version?: string;
		publishConfig?: { access: string; registry: string };
	};

	if (!pkg.name || typeof pkg.name !== "string") {
		pkg.name = `${cfg.testScope}/test-package`;
	}

	const uniqueVersion = `0.0.0-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	pkg.version = uniqueVersion;

	const bareName = pkg.name.replace(/^@[^/]+\//, "");
	pkg.name = `${cfg.testScope}/${bareName}`;

	pkg.publishConfig = {
		access: "public",
		registry: cfg.deployedUrl
	};

	log.info(
		chalk.cyan(
			`Test package:\n  name: ${pkg.name}\n  version: ${pkg.version}\n  registry: ${pkg.publishConfig.registry}`
		)
	);

	await writeFile(pkgJsonPath, JSON.stringify(pkg, null, 2), "utf-8");
	await writeFile(join(publishTmpDir, "index.js"), "// index.js\n", "utf-8");

	await writeScopedNpmrc(publishTmpDir, cfg);

	cliSpinner.start("Publishing test package...");
	try {
		await $({ quiet: true, cwd: publishTmpDir })`pnpm publish --access public`;
		cliSpinner.stop("Successfully published test package");
	} catch (publishErr) {
		cliSpinner.stop(chalk.red(`Failed to publish: ${publishErr}`));
		throw publishErr;
	}

	return {
		name: pkg.name,
		version: pkg.version
	};
}

async function runSmokeTest(cfg: RegistryConfig): Promise<PublishedPackage> {
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

	try {
		const published = await createAndPublishTestPackage(publishTmpDir, cfg);

		await $({ cwd: installTmpDir })`pnpm init --bare`;
		await writeScopedNpmrc(installTmpDir, cfg);

		log.info(chalk.cyan(`Smoke install:\n  spec: ${published.name}@${published.version}\n  from: ${cfg.registryBase}`));

		cliSpinner.start("Smoke: installing exact version...");
		await $({ quiet: true, cwd: installTmpDir })`pnpm add ${published.name}@${published.version}`;
		cliSpinner.stop("Smoke: successfully installed exact version");

		cleanup();
		return published;
	} catch (err) {
		cliSpinner.stop(chalk.red(`Smoke test failed: ${err}`));
		cleanup();
		throw err;
	}
}

async function runCompatTests(cfg: RegistryConfig, published: PublishedPackage) {
	const compatDir = await mkdtemp(join(tmpdir(), "npflared-compat-"));

	const cleanup = () => {
		try {
			rmSync(compatDir, { recursive: true, force: true });
		} catch {}
	};

	try {
		await $({ cwd: compatDir })`pnpm init --bare`;
		await writeScopedNpmrc(compatDir, cfg);

		log.info(chalk.cyan(`Compat metadata check:\n  package: ${published.name}`));

		cliSpinner.start("Compat: pnpm view metadata...");
		await $({ quiet: true, cwd: compatDir })`pnpm view ${published.name} --json`;
		cliSpinner.stop("Compat: metadata fetch succeeded");

		cliSpinner.start("Compat: pnpm add without explicit version...");
		await $({ quiet: true, cwd: compatDir })`pnpm add ${published.name}`;
		cliSpinner.stop("Compat: unpinned add succeeded");

		const fixtureDir = join(compatDir, "fixture");
		await $({ cwd: compatDir })`mkdir fixture`;

		await writeFile(
			join(fixtureDir, "package.json"),
			JSON.stringify(
				{
					name: "npflared-compat-fixture",
					version: "0.0.0",
					private: true,
					dependencies: {
						[published.name]: published.version,
						chalk: "^5.4.1"
					}
				},
				null,
				2
			),
			"utf-8"
		);

		await writeScopedNpmrc(fixtureDir, cfg);

		cliSpinner.start("Compat: pnpm install in fixture project...");
		await $({ quiet: true, cwd: fixtureDir })`pnpm install`;
		cliSpinner.stop("Compat: fixture install succeeded");

		cleanup();
	} catch (err) {
		cliSpinner.stop(chalk.red(`Compat tests failed: ${err}`));
		cleanup();
		throw err;
	}
}

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
				if (!v.startsWith("http://") && !v.startsWith("https://")) {
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

	const url = new URL(deployedUrl);
	const registryHost = url.host;
	const registryBase = deployedUrl.replace(/\/$/, "");

	const placeholderPkgName = `${testScope}/test-package`;
	const scopeType: TokenScopeType = "package:read+write";
	const tokenLabel = `cli-test-${placeholderPkgName}`;

	log.info("Minting test token...");
	const testToken = await createTokenProgrammatically({
		pkgName: placeholderPkgName,
		scopeType,
		tokenLabel,
		local
	});

	const cfg: RegistryConfig = {
		local,
		deployedUrl,
		registryBase,
		registryHost,
		testScope,
		testToken
	};

	const published = await runSmokeTest(cfg);
	await runCompatTests(cfg, published);

	log.info(
		chalk.green(
			dedent`
        ✅ Full registry test passed!
        📦 Published and installed test package successfully using:
          - Minted test token: ${chalk.bold.white(`${testToken.slice(0, 8)}...`)}
          - Worker URL: ${chalk.bold.white(deployedUrl)}${local ? " (local)" : ""}
          - Test scope: ${chalk.bold.white(testScope)}
          - Package: ${chalk.bold.white(`${published.name}@${published.version}`)}
          - Checks:
            - publish
            - smoke install with exact version
            - metadata lookup via pnpm view
            - unpinned add
            - fixture pnpm install
      `
		)
	);
};
