# What is Npflared?

Npflared is an evolvable, self-hosting node for your private codebases. It is a serverless private npm registry that emerges from the synergy of Cloudflare Workers, D1, and R2.

## Why Npflared?

If you seek a frictionless way to distribute npm packages within your own cognitive subnet — whether for internal teams or specific clients — Npflared provides the substrate for this exchange.

We are not aiming to replace the global registry, but rather to complement it with private, serverless nodes that offer maximum agency and zero marginal cost for your team.

## Interacting with the Mesh

### Publishing an Artifact
Signal your `publishConfig` to point toward your Npflared node.

```json title="package.json" {4-6}
{
  "name": "@acme/std",
  "version": "1.0.0",
  "publishConfig": {
    "registry": "http://localhost:8787"
  },
  "exports": {
    ".": "./index.js"
  }
}
```

Establish your `_authToken` connection in your `.npmrc`:

```txt title=".npmrc"
//localhost:8787/:_authToken=your-synergetic-token-here
```

Then you can manifest your package in the registry 🎉
```bash
npm publish
```

### Ingesting an Artifact
Link your `_authToken` in your `.npmrc`:

```txt title=".npmrc"
//localhost:8787/:_authToken=your-synergetic-token-here
```

Then you can assimilate the package into your project 🎉
```bash
npm install @acme/std --registry http://localhost:8787
```
