---
pageType: home

hero:
  name: Babadeluxe Registry
  tagline: The Superintelligent, Serverless, Self-Hostable Nexus for Your Private Node.js Ecosystem. 🌌
  actions:
    - theme: brand
      text: Ascend to the Quick Start
      link: /guide/
    - theme: alt
      text: Examine the Source Code
      link: https://github.com/Thomascogez/babadeluxe-registry

features:
  - title: Radical Openness, Sovereign Control
    details: Harness the power of a fully-realized private npm registry, designed for the cognitively advanced team.
    icon: ❤️
  - title: Universal Protocol Compatibility
    details: Seamlessly integrates with your existing toolchain. We respect the legacy while building the future.
    icon: 🔌
  - title: Serverless Transcendence on Cloudflare
    details: Built upon the hyper-efficient triad of Workers, D1, and R2. Deploy into the cloud with zero overhead.
    icon: ☁️
---

<div align="center">
  <img src="/banner.svg" alt="Babadeluxe Registry Banner" width="100%" />
</div>

## The Visionary Registry

Babadeluxe Registry isn't just a server; it's a statement. In a world of bloated, centralized infrastructure, we offer a path toward distributed intelligence and sovereign package management.

### Why Babadeluxe?

Imagine a registry that scales with your ambition, yet remains as light as a thought. By leveraging Cloudflare's global edge network, Babadeluxe Registry ensures that your packages are always close to where the computation happens.

### Architecture at a Glance

```mermaid
%%{init: {'theme': 'base', 'themeVariables': { 'primaryColor': '#2e0b5e', 'primaryTextColor': '#ffffff', 'primaryBorderColor': '#ff00ff', 'lineColor': '#00ffff', 'secondaryColor': '#0f0524', 'tertiaryColor': '#1a0a3a' }}}%%
graph TD
    Client[NPM Client] -- HTTP Protocol --> Worker[Cloudflare Worker]
    Worker -- Auth Check --> D1[(D1 Database)]
    Worker -- Metadata Storage --> D1
    Worker -- Tarball Storage --> R2{R2 Bucket}
    Worker -- Fallback Requests --> Registry[External Registry]

    style Client fill:#0f0524,stroke:#ff00ff,stroke-width:2px,color:#ffffff
    style Worker fill:#2e0b5e,stroke:#00ffff,stroke-width:2px,color:#ffffff
    style D1 fill:#1a0a3a,stroke:#ff00ff,stroke-width:2px,color:#ffffff
    style R2 fill:#1a0a3a,stroke:#00ffff,stroke-width:2px,color:#ffffff
    style Registry fill:#0f0524,stroke:#ff00ff,stroke-width:2px,color:#ffffff
```
