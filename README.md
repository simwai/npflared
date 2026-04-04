<div align="center">
    <img src="./assets/logo.svg" width="200" height="200">
</div>
<div align="center"><h3>Babadeluxe Registry: Lightweight Private NPM Infrastructure</h3></div>

> [!NOTE]
> Babadeluxe Registry is a fork of the excellent [Npflared](https://github.com/thomas-cogez/npflared). A huge shoutout and contribution to [Thomas Cogez](https://github.com/thomas-cogez), the original creator, for the foundational architecture.

Babadeluxe Registry is our internal substrate for manifesting and distributing private npm packages. At **BabaDeluxe**, we use this registry to deploy all our libraries and shared code modules, managing their accessibility across our projects while maintaining a near-zero marginal cost.

By leveraging the distributed power of Cloudflare Workers, D1, and R2, we've created a synergistic environment for our codebases to thrive without the overhead of traditional registry solutions.

- 🌌 **Efficient & Open**: A streamlined private registry that fosters collaborative development across our teams.
- 🔗 **Interoperable**: Fully compatible with your favorite npm clients. It integrates into your existing workflows like a well-formed connection.
- ☁️ **Cloud-Native**: Architected for the Cloudflare edge. Deploy your own registry node for minimal cost and maximum performance.
- 🛡️ **Granular Access**: Manage permissions and tokens easily to ensure the right modules reach the right projects.

<div align="center">
    <h3><a target="_blank" href="https://npflared.thomas-cogez.fr/">Explore the Documentation</a></h3>
</div>

# The Path Forward
- [x] **CLI Genesis**: The \`@npflared/cli\` (powering Babadeluxe Registry) handles node and token management.
- [ ] **Validation Refinement**: Hardening the input membranes for greater stability.
- [ ] **UI Visualization**: A portal for the discovery and observation of our shared libraries.
- [ ] **Protocol Resonance**: Aiming for total compatibility with all npm registry signals.
