# Scoped Package & Forbidden (403) Debugging Guide

This guide is for developers with little to no experience with Wrangler or Cloudflare Workers who are troubleshooting `403 Forbidden` errors in `npflared`.

## 1. Quick Start: Are Migrations Applied?
If you've recently updated `npflared` or added tables, the most common reason for a `403 Forbidden` is a missing database migration in production.

**To apply migrations to your live Worker:**
1. Navigate to the API directory: `cd apps/api`
2. Run the production migration command:
   ```bash
   pnpm migrate:prod
   ```
   *Note: This applies migrations to the Cloudflare D1 database linked to your worker.*

---

## 2. Real-time Log Inspection
If the error persists, you can watch the live logs as you perform an `npm publish` or `npm install`.

**To view live logs:**
1. Navigate to the API directory: `cd apps/api`
2. Run the tail command:
   ```bash
   npx wrangler tail
   ```
3. Now, try to publish your package. You will see every request and any associated error messages or stack traces in your terminal.

---

## 3. Verifying Your Token & Scopes
A `403 Forbidden` means your token is valid but doesn't have permission for the specific package.

**Check these things:**
- **Glob Patterns:** Stars (`*`) in your token scope do NOT match slashes (`/`) by default in older versions of `npflared`. Ensure you're using the latest code which has the `{ dot: true, bash: true }` fix.
- **Example Scopes:**
  - `@babadeluxe/*` matches `@babadeluxe/xo-config`.
  - `@babadeluxe**` also matches `@babadeluxe/xo-config` with the new fix.
  - `*` matches everything.

**To list your tokens and their scopes:**
You can use the built-in API reference. Go to `https://<your-worker-url>/_/docs` and use the `GET /-/npm/v1/tokens` endpoint.

---

## 4. Encoded Slashes (`%2f`)
Some npm clients or tools might encode the slash in a scoped package (e.g., `@babadeluxe%2fxo-config`).
- `npflared` handles this by decoding the name before checking permissions.
- If you're seeing a 403 specifically on an encoded URL, it's likely a mismatch between the decoded name and your token's scope glob.

---

## 5. Common Wrangler Commands for Beginners
- `npx wrangler d1 execute <DATABASE_BINDING> --command "SELECT * FROM token"`: Directly query your production database.
- `npx wrangler whoami`: Verify you're logged into the correct Cloudflare account.
- `npx wrangler deploy`: Redeploy the latest code to production.

---

## Still Stuck?
1. Run `npx wrangler tail` in one terminal.
2. Run your `npm publish` in another.
3. Look for "HttpError: Forbidden" in the tail output and check the "customMetadata" or surrounding logs for clues about the package name being matched.
