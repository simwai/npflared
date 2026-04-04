import type { CommandModule } from "yargs";
import { addCommand } from "./add";
import { clearCommand } from "./clear";
import { deleteCommand } from "./delete";
import { editPackagesCommand } from "./edit-packages";
import { listCommand } from "./list";
import { listScopeCommand } from "./list-scope";
import { lookupCommand } from "./lookup";

export const tokenCommands: CommandModule = {
  command: "token <sub>",
  describe: "Manage npflared tokens (multi-package read/write permissions)",
  builder: (yargsBuilder) =>
    yargsBuilder
      .command(addCommand)
      .command(clearCommand)
      .command(deleteCommand)
      .command(editPackagesCommand)
      .command(listCommand)
      .command(listScopeCommand)
      .command(lookupCommand)
      .demandCommand(1),
  handler: () => {}
};
