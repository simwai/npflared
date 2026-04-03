import { hideBin } from "yargs/helpers";
import yargs from "yargs/yargs";
import { install } from "./commands/install";
import { test } from "./commands/test";
import { tokenCommands } from "./commands/token";

yargs(hideBin(process.argv))
	.scriptName("npflared")
	.fail(false)
	.command(
		"install",
		"Configure and deploy your own npflared instance on your cloudflare account",
		(yargs) => yargs,
		async () => {
			await install();
		}
	)
	.command(tokenCommands)
	.command(
		"test",
		"Test publishing and installing a scoped package via your worker",
		(yargs) =>
			yargs
				.option("local", {
					type: "boolean",
					default: false,
					describe: "Use local dev worker URL (http://127.0.0.1:8787)"
				})
				.option("port", {
					type: "number",
					default: false,
					describe: "Override port in local dev worker URL"
				}),
		async (argv) => {
			await test({
				local: argv.local === true,
				port: typeof argv.port === "number" ? argv.port : undefined
			});
		}
	)
	.demandCommand(1)
	.strict()
	.help("help")
	.alias("help", "h")
	.showHelpOnFail(true)
	.parse();

process.on("uncaughtException", console.error);