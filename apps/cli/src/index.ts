import { hideBin } from "yargs/helpers";
import yargs from "yargs/yargs";
import { clean } from "./commands/clean";
import { install } from "./commands/install";
import { test } from "./commands/test";
import { tokenCommands } from "./commands/token";

yargs(hideBin(process.argv))
	.command(
		"install",
		"Configure and deploy your own npflared instance on your cloudflare account",
		(yargs) => yargs,
		async () => {
			await install();
		}
	)
	.command(
		"clean",
		"Clean the local npflared folder",
		(yargs) => yargs,
		async () => {
			await clean();
		}
	)
	.command(tokenCommands)
	.command(
		"test",
		"Test publishing and installing a scoped package via your worker",
		(yargs) => yargs,
		async () => {
			await test();
		}
	)
	.demandCommand(1)
	.strict()
	.parse();
