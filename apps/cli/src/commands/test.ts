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

type PublishedSet = {
	dependency: PublishedPackage;
	main: PublishedPackage;
};

async function writeScopedNpmrc(dir: string, cfg: RegistryConfig) {
	const npmrc = [
		`${cfg.testScope}:registry=${cfg.registryBase}`,
		`//${cfg.registryHost}/:_authToken=${cfg.testToken}`,
		`//${cfg.registryHost}/:always-auth=true`,
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

async function initPackage(dir: string) {
	await $({ cwd: dir })`pnpm init --bare`;
}

async function createPackage(
	dir: string,
	cfg: RegistryConfig,
	name: string,
	version: string,
	dependencies?: Record<string, string>
) {
	await initPackage(dir);

	const pkgJsonPath = join(dir, "package.json");
	const pkg = JSON.parse(await readFile(pkgJsonPath, "utf-8")) as Record<string, unknown>;

	pkg.name = name;
	pkg.version = version;
	pkg.private = false;
	pkg.publishConfig = {
		access: "public",
		registry: cfg.registryBase
	};

	if (dependencies && Object.keys(dependencies).length > 0) {
		pkg.dependencies = dependencies;
	}

	await writeFile(pkgJsonPath, JSON.stringify(pkg, null, 2), "utf-8");

	const jsBody =
		name.endsWith("/test-dep")
			? `module.exports = { value: "dep-ok" };\n`
			: `module.exports = { value: "main-ok" };\n`;

	await writeFile(join(dir, "index.js"), jsBody, "utf-8");
	await writeScopedNpmrc(dir, cfg);
}

async function publishPackage(dir: string, label: string) {
	cliSpinner.start(`Publishing ${label}...`);
	try {
		await $({ quiet: true, cwd: dir })`pnpm publish --access public`;
		cliSpinner.stop(`Published ${label}`);
	} catch (err) {
		cliSpinner.stop(chalk.red(`Failed to publish ${label}: ${err}`));
		throw err;
	}
}

async function createAndPublishTestPackages(baseTmpDir: string, cfg: RegistryConfig): Promise<PublishedSet> {
	const dependencyDir = join(baseTmpDir, "dep");
	const mainDir = join(baseTmpDir, "main");

	await $({ cwd: baseTmpDir })`mkdir dep`;
	await $({ cwd: baseTmpDir })`mkdir main`;

	const version = `0.0.0-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const dependencyName = `${cfg.testScope}/test-dep`;
	const mainName = `${cfg.testScope}/test-package`;

	await createPackage(dependencyDir, cfg, dependencyName, version);
	await publishPackage(dependencyDir, dependencyName);

	await createPackage(mainDir, cfg, mainName, version, {
		[dependencyName]: version
	});
	await publishPackage(mainDir, mainName);

	return {
		dependency: {
			name: dependencyName,
			version
		},
		main: {
			name: mainName,
			version
		}
	};
}

async function runSmokeTest(cfg: RegistryConfig): Promise<PublishedSet> {
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
		const published = await createAndPublishTestPackages(publishTmpDir, cfg);

		await initPackage(installTmpDir);
		await writeScopedNpmrc(installTmpDir, cfg);

		log.info(
			chalk.cyan(
				[
					"Smoke install:",
					`  spec: ${published.main.name}@${published.main.version}`,
					`  implicit dependency: ${published.dependency.name}@${published.dependency.version}`,
					`  from: ${cfg.registryBase}`
				].join("\n")
			)
		);

		cliSpinner.start("Smoke: installing main package with private dependency...");
		await $({ quiet: true, cwd: installTmpDir })`pnpm add ${published.main.name}@${published.main.version}`;
		cliSpinner.stop("Smoke: successfully installed main package and dependency");

		cleanup();
		return published;
	} catch (err) {
		cliSpinner.stop(chalk.red(`Smoke test failed: ${err}`));
		cleanup();
		throw err;
	}
}

async function runCompatTests(cfg: RegistryConfig, published: PublishedSet) {
	const compatDir = await mkdtemp(join(tmpdir(), "npflared-compat-"));

	const cleanup = () => {
		try {
			rmSync(compatDir, { recursive: true, force: true });
		} catch {}
	};

	try {
		await initPackage(compatDir);
		await writeScopedNpmrc(compatDir, cfg);

		log.info(
			chalk.cyan(
				[
					"Compat metadata check:",
					`  main: ${published.main.name}`,
					`  dep: ${published.dependency.name}`
				].join("\n")
			)
		);

		cliSpinner.start("Compat: pnpm view main metadata...");
		await $({ quiet: true, cwd: compatDir })`pnpm view ${published.main.name} --json`;
		cliSpinner.stop("Compat: main metadata fetch succeeded");

		cliSpinner.start("Compat: pnpm view dependency metadata...");
		await $({ quiet: true, cwd: compatDir })`pnpm view ${published.dependency.name} --json`;
		cliSpinner.stop("Compat: dependency metadata fetch succeeded");

		cliSpinner.start("Compat: pnpm add without explicit version...");
		await $({ quiet: true, cwd: compatDir })`pnpm add ${published.main.name}`;
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
						[published.main.name]: published.main.version,
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

	const testScopeInput = await text({
		message: "Enter test scope (default: @npflared-test):",
		initialValue: "@npflared-test",
		validate(value) {
			const v = value ?? "";
			if (!v.startsWith("@")) {
				return "Scope must start with '@'";
			}
		}
	});

	if (isCancel(testScopeInput)) process.exit(1);
	const testScope = testScopeInput;

	const url = new URL(deployedUrl);
	const registryHost = url.host;
	const registryBase = deployedUrl.replace(/\/$/, "");

	const depPkgName = `${testScope}/test-dep`;
	const mainPkgName = `${testScope}/test-package`;
	const scopeType: TokenScopeType = "package:read+write";
	const tokenLabel = `cli-test-${testScope.replace(/^@/, "")}`;

	log.info("Minting multi-package test token...");
	const testToken = await createTokenProgrammatically({
		packageNames: [depPkgName, mainPkgName],
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
				📦 Published and installed multi-package test setup successfully using:
				  - Minted test token: ${chalk.bold.white(`${testToken.slice(0, 8)}...`)}
				  - Worker URL: ${chalk.bold.white(deployedUrl)}${local ? " (local)" : ""}
				  - Test scope: ${chalk.bold.white(testScope)}
				  - Main package: ${chalk.bold.white(`${published.main.name}@${published.main.version}`)}
				  - Dependency package: ${chalk.bold.white(`${published.dependency.name}@${published.dependency.version}`)}
				  - Checks:
				    - publish dependency
				    - publish main package depending on private dependency
				    - smoke install with transitive private dependency
				    - metadata lookup via pnpm view
				    - unpinned add
				    - fixture pnpm install
			`
		)
	);
};