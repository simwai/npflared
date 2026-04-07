# What is BabaDeluxe Registry?

BabaDeluxe Registry is a lightweight, serverless private npm registry that we use at **BabaDeluxe** to deploy and share all our libraries and common code. Built on the [Npflared](https://github.com/thomas-cogez/npflared) substrate, it is architected to be a high-performance, low-cost node in our development ecosystem.

By leveraging Cloudflare Workers, D1, and R2, we have manifested a registry that allows us to manage package access across our teams without the overhead of traditional npm hosting.

:::info
A big contribution and credit to [Thomas Cogez](https://github.com/thomas-cogez), the original creator of Npflared, upon which this registry is founded.
:::

## Why BabaDeluxe Registry?

If you seek a frictionless, low-cost way to distribute npm packages within your own team's cognitive network, BabaDeluxe Registry provides the substrate for this exchange.

We are not looking to replace the global registry, but rather to complement it with private, serverless nodes that offer maximum agency and minimum marginal cost for our teams.

## Interacting with the Mesh

### Publishing an Artifact
Signal your `publishConfig` to point toward your registry node.

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

Establish your authentication signal (`_authToken`) in your `.npmrc`:

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
