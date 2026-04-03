import { Scalar } from "@scalar/hono-api-reference";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { TrieRouter } from "hono/router/trie-router";
import { openAPIRouteHandler } from "hono-openapi";
import { loadToken } from "#middlewares/load-token";
import { HttpError } from '#utils/http';
import { version } from "../package.json";
import { packageRouter } from "./routers/package";
import { tokenRouter } from "./routers/token";

const app = new Hono<AppEnv>({ router: new TrieRouter() });
// const app = new Hono<AppEnv>()
app.use("*", logger());
app.use("*", loadToken);

const routes = app.route("/", tokenRouter).route("/", packageRouter);

app
	.get(
		"/_/openapi.json",
		openAPIRouteHandler(routes, {
			documentation: {
				info: { title: "Npflared registry", version },
				security: [{ bearerAuth: [] }]
			}
		})
	)
	.get("/_/docs", Scalar({ theme: "saturn", url: "/_/openapi.json" }));

app.all("*", () => {
	throw HttpError.notFound("Unsupported URL");
});

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return app.fetch(request, env, ctx);
	}
};
