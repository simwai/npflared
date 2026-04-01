// biome-ignore lint/correctness/noUnusedVariables: Wrong linter information
interface AppEnv {
	Bindings: Env;
	Variables: {
		token: typeof import("./src/db/schema").tokenTable.$inferSelect;
		can: ReturnType<typeof assertTokenAccess>;
	};
}
