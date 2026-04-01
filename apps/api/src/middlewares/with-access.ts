import { assertTokenAccess } from "#utils/access";
import { $ } from "#utils/factory";

export const withAccess = $.createMiddleware(async (c, next) => {
	c.set("can", assertTokenAccess(c.get("token")));
	await next();
});
