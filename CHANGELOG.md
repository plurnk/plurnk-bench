# @plurnk/plurnk-bench

## 2.1.0

- Lock `@plurnk/plurnk-service` `^5.2.0`, `@plurnk/plurnk-contracts` `^7.2.0`, and `@plurnk/plurnk-digest` `^3.2.5`, and align live and demo fixtures with `DONE`, `FAIL`, `TODO`, ACP v2, and `plurnk://` / `mcp://` reference addresses (#82, #86, #87, #88).
- Airgap SWE-bench evaluation containers (`network_mode: "none"` with offline pip and host-loopback model endpoint bridging) and record `llama-server` reasoning tokens in `pi.mjs` (#83, #84, #85, #88).

## 2.0.0

- Join the one-time Plurnk 2.0 baseline, then version benchmark tooling for its own
  changes. This repository remains private as an npm package.
- Adopt the separate digest package and the service's public evidence reader.
  Optional forensic interviews use the service CLI's existing configuration and
  witness-selection path.
- Resolve compatible platform packages from npm and record exact tested versions
  in the lockfile; platform publication does not implicitly release the bench.
- Use the MCP SDK's OAuth issuer-binding security update.
