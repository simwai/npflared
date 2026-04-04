import { env } from "cloudflare:workers";
import { describeRoute, resolver } from "hono-openapi";
import { standardOpenApiErrorResponses } from "#openapi";
import { packageService } from "#services/package-service";
import { assertTokenAccess } from "#utils/access";
import { $ } from "#utils/factory";
import { HttpError } from "#utils/http";
import { zValidator } from "#utils/validation";
import { validators } from "./validators";

type DebugCapableContext = {
  req: {
    query: (key: string) => string | undefined;
    header: (key: string) => string | undefined;
  };
};

function isDebugRequest(c: DebugCapableContext) {
  return Boolean(env.DEBUG_ERRORS) || c.req.query("debug") === "1" || c.req.header("x-npflared-debug") === "1";
}

export const packageRouter = $.createApp()
  .get(
    "/:packageName",
    describeRoute({
      description: "Get a package from the registry or fallback registry",
      responses: {
        ...standardOpenApiErrorResponses,
        200: {
          description: "Returns the package",
          content: {
            "application/json": {
              schema: resolver(validators.get.response[200])
            }
          }
        }
      }
    }),
    zValidator("param", validators.get.request.param),
    async (c) => {
      const { packageName } = c.req.valid("param");
      const can = assertTokenAccess(c.get("token"));

      const publishedPackage = await packageService.getPackage(packageName);

      if (!publishedPackage) {
        if (env.FALLBACK_REGISTRY_ENDPOINT) {
          const fallbackURL = new URL(env.FALLBACK_REGISTRY_ENDPOINT);
          fallbackURL.pathname = `/${packageName}`;
          return fetch(fallbackURL);
        }
        throw HttpError.notFound();
      }

      if (!can("read", "package", packageName)) throw HttpError.forbidden();

      return c.json(publishedPackage);
    }
  )
  .get(
    "/:packageScope/:packageName",
    describeRoute({
      description: "Get a scoped package from the registry or fallback registry",
      responses: {
        ...standardOpenApiErrorResponses,
        200: {
          description: "Returns the package",
          content: {
            "application/json": {
              schema: resolver(validators.get.response[200])
            }
          }
        }
      }
    }),
    zValidator("param", validators.get.scoped.request.param),
    async (c) => {
      const { packageScope, packageName } = c.req.valid("param");
      const fullName = `${packageScope}/${packageName}`;
      const can = assertTokenAccess(c.get("token"));

      const publishedPackage = await packageService.getPackage(fullName);

      if (!publishedPackage) {
        if (env.FALLBACK_REGISTRY_ENDPOINT) {
          const fallbackURL = new URL(env.FALLBACK_REGISTRY_ENDPOINT);
          fallbackURL.pathname = `/${fullName}`;
          return fetch(fallbackURL);
        }
        throw HttpError.notFound();
      }

      if (!can("read", "package", fullName)) throw HttpError.forbidden();

      return c.json(publishedPackage);
    }
  )
  .get("/:packageName/-/:tarballName", zValidator("param", validators.getTarball.request.param), async (c) => {
    const { packageName, tarballName } = c.req.valid("param");
    const can = assertTokenAccess(c.get("token"));
    const debug = isDebugRequest(c);

    if (!can("read", "package", packageName)) throw HttpError.forbidden();

    const tarball = await packageService.getPackageTarball(packageName, tarballName, { debug });

    return new Response(tarball.body, {
      headers: { "Content-Type": "application/gzip" }
    });
  })
  .get("/:packageScope/:packageName/-/:tarballPath{.+}", async (c) => {
    const packageScope = c.req.param("packageScope");
    const packageName = c.req.param("packageName");
    const tarballPath = c.req.param("tarballPath");
    const debug = isDebugRequest(c);

    const fullName = `${packageScope}/${packageName}`;
    const can = assertTokenAccess(c.get("token"));

    if (!can("read", "package", fullName)) throw HttpError.forbidden();

    if (!tarballPath) throw HttpError.badRequest("Missing tarball name");

    const tarballName = tarballPath.split("/").pop() ?? tarballPath;

    const tarball = await packageService.getPackageTarball(fullName, tarballName, { debug });

    return new Response(tarball.body, {
      headers: { "Content-Type": "application/gzip" }
    });
  })
  .put(
    "/:packageName",
    describeRoute({
      description: "Publish a new version of a package",
      responses: {
        ...standardOpenApiErrorResponses,
        200: {
          description: "Package updated",
          content: {
            "application/json": {
              schema: resolver(validators.put.response[200])
            }
          }
        }
      }
    }),
    zValidator("param", validators.put.request.param),
    zValidator("json", validators.put.request.json),
    async (c) => {
      const can = assertTokenAccess(c.get("token"));
      const { packageName } = c.req.valid("param");
      const body = c.req.valid("json");
      const debug = isDebugRequest(c);

      if (!can("write", "package", packageName)) throw HttpError.forbidden();

      await packageService.putPackage(packageName, body, { debug });

      return c.json({ message: "ok" });
    }
  )
  .put(
    "/:packageScope/:packageName",
    describeRoute({
      description: "Publish a new version of a scoped package",
      responses: {
        ...standardOpenApiErrorResponses,
        200: {
          description: "Package updated",
          content: {
            "application/json": {
              schema: resolver(validators.put.response[200])
            }
          }
        }
      }
    }),
    zValidator("param", validators.put.scoped.request.param),
    zValidator("json", validators.put.request.json),
    async (c) => {
      const can = assertTokenAccess(c.get("token"));
      const { packageScope, packageName } = c.req.valid("param");
      const fullName = `${packageScope}/${packageName}`;
      const body = c.req.valid("json");
      const debug = isDebugRequest(c);

      if (!can("write", "package", fullName)) throw HttpError.forbidden();

      await packageService.putPackage(fullName, body, { debug });

      return c.json({ message: "ok" });
    }
  );
