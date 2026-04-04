# 403 Forbidden Bug Evaluation

Based on the investigation of the npflared codebase and the specific error reported (`403 Forbidden` on `PUT /@babadeluxe%2fxo-config`), here is an evaluation of potential scenarios.

## Likelihood Summary Table

| Scenario | Likelihood | Description |
| :--- | :--- | :--- |
| **Micromatch Glob Strictness** | **90%** | Star globs like `@babadeluxe/*` do not cross slashes by default. |
| **Encoded Slash Routing Mismatch** | **70%** | `@babadeluxe%2fxo-config` hits the unscoped route, causing potential name mismatches. |
| **Missing Migrations** | **40%** | The user mentioned a possible forgotten migration in the worker. |
| **Token Loading Failure** | **20%** | Token exists in DB but is not loaded or the `Authorization` header is malformed. |
| **Scoped Route parameter mismatch** | **10%** | `:packageScope/:packageName` failing due to unexpected slash handling. |

---

## Detailed Evaluation

### 1. Micromatch Glob Strictness (High Likelihood - 90%)
**Cause:** The `assertTokenAccess` function uses `micromatch.isMatch(targetedPackage, value)` to verify if a token scope allows access.
**Issue:** By default, stars (`*`) in micromatch do NOT match slashes (`/`). If a user creates a token with scope `@babadeluxe/*`, it will match `@babadeluxe/pkg` ONLY if the `bash` or `globstar` option is enabled, or if it's handled specifically.
**Reproduction:** In my tests, `@babadeluxe*` failed to match `@babadeluxe/xo-config`. Even `@babadeluxe/*` can be finicky depending on the environment.
**Evidence:** The user's package is scoped (`@babadeluxe/xo-config`). This is exactly where glob matching becomes critical.
**Recommendation:** Ensure `micromatch` is called with `{ dot: true, bash: true }` (already applied in my previous step).

### 2. Encoded Slash Routing Mismatch (Medium-High Likelihood - 70%)
**Cause:** The URL contains `%2f` (`/@babadeluxe%2fxo-config`).
**Issue:**
- Standard route: `/:packageName`
- Scoped route: `/:packageScope/:packageName`
**Behavior:** Hono (and most routers) will NOT split `@babadeluxe%2fxo-config` into two segments. Instead, it matches the **unscoped** route (`/:packageName`) with `packageName = "@babadeluxe/xo-config"` (after decoding).
**Why it leads to 403:** While the router decodes the parameter, the permission check relies on the extracted value. If the logic expects a scoped package to always hit the scoped route but it hits the unscoped one, some normalization might be missed. However, in npflared, both routes call `assertTokenAccess`. If the glob issue (above) is also present, this is a double failure point.

### 3. Missing Migrations (Medium Likelihood - 40%)
**Cause:** User mentioned: *"maybe forgot to do a migration in the worker"*.
**Issue:** If the `token` table in the live D1 database is missing the `scopes` column or if it's an old schema where scopes were handled differently, `db.query.tokenTable.findFirst` might return an object with `undefined` scopes.
**Why it leads to 403:** `assertTokenAccess` returns `false` if the token or its scopes are missing/empty, leading to a 403 in the router.
**Evidence:** The user explicitly mentioned they "just deploy" and might have forgotten migrations. D1 migrations must be applied manually via wrangler.

### 4. Token Loading Failure (Low Likelihood - 20%)
**Cause:** `load-token` middleware failure.
**Issue:** The middleware expects `Authorization: Bearer <token>`. If the token isn't found in the DB (e.g. D1 is empty or the token was generated in a different environment), `c.get("token")` will be `undefined`.
**Why it leads to 403:** In npflared, the routes do not check if the token exists; they pass `c.get("token")` directly to `assertTokenAccess`. If it's `undefined`, `assertTokenAccess` returns `false`, and the route throws 403.
**Observation:** Usually, this would result in a "No token" or "Forbidden" message. If the user is SURE the token is valid, this is less likely unless the DB is out of sync.

### 5. Scoped Route Parameter Mismatch (Low Likelihood - 10%)
**Cause:** `/:packageScope/:packageName` route matching.
**Issue:** If the client sends `@babadeluxe/xo-config` (two segments), it hits the scoped route. If the extraction of `packageScope` or `packageName` is wrong due to some edge case in Hono's router, the `fullName` could be malformed.
**Observation:** My tests showed that Hono handles this correctly for unencoded segments.

---

## Action Plan for the User

1. **Verify Migrations:** Run `pnpm migrate:prod` from `apps/api` to apply any missing D1 database migrations.
2. **Consult the Guide:** See the new [DEBUGGING.md](./DEBUGGING.md) guide for beginners to troubleshoot live logs using `wrangler tail`.
3. **Verify Glob Patterns:** Use `@babadeluxe/*` or `@babadeluxe**` in your token scopes to match your scoped packages.

---

## Conclusion

The most probable culprit is a combination of **Scenario 1 (Micromatch strictness)** and **Scenario 3 (Missing Migrations)**. I have already addressed Scenario 1 and Scenario 2 in the code. If the 403 persists after my changes, the user MUST verify that migrations were applied to their live D1 database.
