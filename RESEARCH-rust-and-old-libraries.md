# Rust and old libraries: where a rewrite would pay off

Date: 2026-11-10. Companion to `mcp-gaps.md`.

Question: which libraries in the MCP stack are old or slow, and where would a rewrite in a faster
language such as Rust really pay off for this project?

## Short answer

A Rust rewrite is not the next step. In ranked order:

1. **Make idle servers lazy.** 753 of 847 sessions called no server, and the proxy connects upstream before it answers. No language fixes that.
2. **Upgrade the SDK.** 1.32.2 is the v1 maintenance line and stops at 2025-11-25. v2 (2.4.0, stable since 2026-07-27) speaks 2026-07-28.
3. **Take the cheap Node wins.** The compile cache cut proxy ready time from 295 to 270 ms and saved 25 MB (measured today). Ship built JavaScript. Stop using `npx` for upstream servers.
4. **Use Rust in one place only, later:** a thin proxy front that starts in every session. Node costs about 150 ms and 107 MB per proxied server. Rust would cost a few ms and a few MB (estimate). Keep the layers in TypeScript.
5. **Do not build on agentgateway.** It listens on HTTP only, and its hooks cannot serve a call from a cache or call upstream twice.
6. **Leave alone:** zod, JSON handling, stdio framing and the network path. They cost microseconds against 450 ms calls.

How to read the numbers below. "Measured today" means I ran it on this machine on 2026-11-10 (Apple
Silicon, Node 26.12.1, rustc 1.98.1, median of 20 to 30 runs after 3 warm up runs, scripts kept outside
the repo). "Estimate" means I reasoned from those numbers. Everything else has a source link.

---

## 1. SDK freshness

### The spec

- The latest released revision is **2026-07-28**, published 2026-07-28. A `draft` folder exists for the
  next one. Source: [spec releases](https://github.com/modelcontextprotocol/modelcontextprotocol/releases/tag/2026-07-28),
  [schema folder](https://github.com/modelcontextprotocol/modelcontextprotocol/tree/main/schema).
- The 2026-07-28 schema has `resultType` on `Result`, `ttlMs` and `cacheScope`, `server/discover` and
  `subscriptions/listen`. Source: [schema/2026-07-28/schema.ts](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts)
  (lines 30, 234, 666, 1094, 1109, 1315 as read today).

### TypeScript: there are two lines, and this project is on the old one

- **v1 line:** `@modelcontextprotocol/sdk` 1.32.2, released 2026-10-23. It is the npm `latest` tag for
  that package name. Source: [npm registry](https://registry.npmjs.org/@modelcontextprotocol/sdk),
  [release 1.32.2](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/1.32.2).
- The `v1.x` branch still has `LATEST_PROTOCOL_VERSION = '2025-11-25'` and no 2026 entry in
  `SUPPORTED_PROTOCOL_VERSIONS`. Source: [src/types.ts on v1.x](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/src/types.ts).
- **v2 line:** split packages `@modelcontextprotocol/client`, `/server` and `/core`, all at 2.4.0,
  released 2026-10-23. Version 2.0.0 was published on 2026-07-27. Source:
  [npm registry, client](https://registry.npmjs.org/@modelcontextprotocol/client),
  [release v2.4.0](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/v2.4.0).
- The README says `main` is "v2 of the SDK ... the stable release line, implementing the 2026-07-28 MCP
  spec". It says v1.x "continues to receive bug fixes and security updates for at least six months
  after the v2 release (2026-07-27)". That is at least until 2027-01-27. Source:
  [README](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/README.md).
- So there is **no open tracking issue to wait for**. 2026-07-28 support has shipped, in v2 only. I
  found no issue or PR that back-ports it to v1.x. Open v2 issues that mention 2026-07-28 are bug
  reports (for example #2873, #3159, #3163, #3171). Source:
  [issue search](https://github.com/modelcontextprotocol/typescript-sdk/issues?q=is%3Aissue+is%3Aopen+2026-07-28).

What v2 gives this project, all from the SDK's own docs:

- **2026-07-28 is opt in.** A plain `Client` still does the 2025 handshake. You ask for the new
  revision with `versionNegotiation: { mode: 'auto' }` or a pin. Source:
  [docs/protocol-versions.md](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md).
- **Zero round trip connect.** `connect(transport, { prior })` reuses a stored `server/discover`
  result and "sends nothing on the wire". The guide is written for gateways and proxies. Source:
  [docs/advanced/gateway.md](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/advanced/gateway.md).
- **A response cache is built in.** The client caches results for the server's `ttlMs`, honours
  `cacheScope`, and caps any `ttlMs` at 24 hours. A server sets hints with `ServerOptions.cacheHints`.
  Source: [docs/clients/caching.md](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/clients/caching.md).
  This overlaps with our cache layer for list and read results. It does not cover `tools/call`.
- **`subscriptions/listen`** is `client.listen(filter)`. On a 2026-07-28 connection the server sends
  list changes only on a stream the client opened. Source:
  [docs/migration/support-2026-07-28.md](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md).
- **`resultType` is hidden.** It is removed from every public result type and consumed by the protocol
  layer. `ttlMs` and `cacheScope` on a discover result are hidden in the types but still on the object.
  A layer that needs the raw fields must read them with a cast or from raw frames. Source: same file,
  section "Wire-only members hidden from public types".
- **One trap for a stdio proxy.** With `mode: 'auto'` on stdio, the probe runs in "a short-lived sibling
  process spawned from the same parameters". That is one extra upstream start per connect. The docs
  warn: "Do not default a spawn-per-invocation CLI tool to 'auto'". Keep the default for stdio
  upstreams, or store the verdict and pass it as `prior`. Source:
  [docs/protocol-versions.md](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md).
- **Migration path.** There is a codemod: `npx @modelcontextprotocol/codemod@latest v1-to-v2 .`. It
  handles renames. Adopting 2026-07-28 is "architectural and not codemod-automatable". Source:
  [docs/migration/index.md](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/index.md).

### Other official SDKs

| SDK | Latest release | Date | 2026-07-28 support | Source |
| --- | --- | --- | --- | --- |
| TypeScript v2 | 2.4.0 | 2026-10-23 | Yes, opt in | see above |
| TypeScript v1 | 1.32.2 | 2026-10-23 | No, stops at 2025-11-25 | see above |
| Python | 2.3.0 | 2026-10-02 | Yes. `MODERN_PROTOCOL_VERSIONS = ("2026-07-28",)` | [release](https://github.com/modelcontextprotocol/python-sdk/releases/tag/v2.3.0), [version.py](https://github.com/modelcontextprotocol/python-sdk/blob/main/src/mcp-types/mcp_types/version.py), [PyPI](https://pypi.org/project/mcp/) |
| Rust `rmcp` | 3.9.0 | 2026-11-05 | Yes. `ProtocolVersion::LATEST = V_2026_07_28` | [release](https://github.com/modelcontextprotocol/rust-sdk/releases/tag/rmcp-v3.9.0), [model.rs](https://github.com/modelcontextprotocol/rust-sdk/blob/main/crates/rmcp/src/model.rs), [crates.io](https://crates.io/crates/rmcp) |
| Go | 1.8.0 | 2026-09-14 | Yes, since v1.7.0 | [release](https://github.com/modelcontextprotocol/go-sdk/releases/tag/v1.8.0), [README version table](https://github.com/modelcontextprotocol/go-sdk/blob/main/README.md#version-compatibility) |
| C# | 2.4.0 | 2026-11-07 | Yes, per its roadmap ("as it did for the 2026-07-28 revision") | [release](https://github.com/modelcontextprotocol/csharp-sdk/releases/tag/v2.4.0), [docs/roadmap.md](https://github.com/modelcontextprotocol/csharp-sdk/blob/main/docs/roadmap.md) |
| Ruby | 1.9.0 | 2026-11-03 | Yes, per its roadmap | [release](https://github.com/modelcontextprotocol/ruby-sdk/releases/tag/v1.9.0), [ROADMAP.md](https://github.com/modelcontextprotocol/ruby-sdk/blob/main/ROADMAP.md) |
| PHP | 0.10.0 | 2026-11-10 | Yes, "both protocol eras" | [release](https://github.com/modelcontextprotocol/php-sdk/releases/tag/v0.10.0), [README](https://github.com/modelcontextprotocol/php-sdk/blob/main/README.md) |
| Java | 2.1.0 | 2026-10-16 | Preview only. Full support is planned for 3.x | [release](https://github.com/modelcontextprotocol/java-sdk/releases/tag/v2.1.0), [ROADMAP.md](https://github.com/modelcontextprotocol/java-sdk/blob/main/ROADMAP.md), [docs/index.md](https://github.com/modelcontextprotocol/java-sdk/blob/main/docs/index.md) |
| Swift | 0.12.1 | 2026-05-07 | No. README names 2025-11-25 as latest | [release](https://github.com/modelcontextprotocol/swift-sdk/releases/tag/0.12.1), [README](https://github.com/modelcontextprotocol/swift-sdk/blob/main/README.md) |
| Kotlin | 0.16.0 | 2026-10-27 | Not verified | [release](https://github.com/modelcontextprotocol/kotlin-sdk/releases/tag/0.16.0) |

The Rust README says the SDK "implements the stable MCP 2026-07-28 specification while remaining fully
compatible with the 2025-11-25 release", and lists "response caching" and "transport-neutral
subscriptions" among the features. Source: [rust-sdk README](https://github.com/modelcontextprotocol/rust-sdk/blob/main/README.md).

**What this decides.** TypeScript, Python, Rust and Go all support 2026-07-28 today. No language is
ahead on protocol support. The "old library" problem is real, but the fix is `npm install`, not a
rewrite. Rust is a valid choice for a rewrite on protocol grounds, and `rmcp` is the most recently
released of the four.

---

## 2. Existing fast proxies and gateways

### agentgateway (Rust)

- Latest release v1.7.0, 2026-10-27. Apache 2.0. Source:
  [releases](https://github.com/agentgateway/agentgateway/releases/tag/v1.7.0).
- It is built on `rmcp` 3.9.0, so it is current on the protocol. Source:
  [crates/agentgateway/Cargo.toml](https://github.com/agentgateway/agentgateway/blob/main/crates/agentgateway/Cargo.toml).
- It handles 2026-07-28 and translates between old and new clients and servers. Its own notes say
  `subscriptions/listen` "requires Streamable HTTP upstreams. Stdio and SSE use legacy protocol
  negotiation". Source:
  [crates/agentgateway/src/mcp/README.md](https://github.com/agentgateway/agentgateway/blob/main/crates/agentgateway/src/mcp/README.md).
- **Stdio is an upstream target type only.** The gateway listens on HTTP ports. I found no stdio
  listener in the source. A client that wants a stdio server cannot spawn it directly. Source:
  [types/agent.rs, `McpTargetSpec::Stdio`](https://github.com/agentgateway/agentgateway/blob/main/crates/agentgateway/src/types/agent.rs),
  [README feature list](https://github.com/agentgateway/agentgateway/blob/main/README.md).
- **Plugin model: "MCP guardrails".** A processor is either an in-process CEL expression or a remote
  gRPC policy server (`ExtMcp`). It runs in a request phase or a response phase. The request hook can
  return pass, mutated params, or an error. The response hook can return pass, a mutated result, or an
  error. Source: [ext_mcp.proto](https://github.com/agentgateway/agentgateway/blob/main/crates/protos/proto/ext_mcp.proto),
  [CEL guardrails example](https://github.com/agentgateway/agentgateway/blob/main/examples/mcp-guardrails/expression/README.md).
- What that means for our three layers:
  - **compact** fits. It is a response mutation.
  - **cache** does not fit. A request hook cannot return a result, so it cannot skip the upstream call.
  - **consolidate** does not fit. A hook cannot call upstream more than once.
- The gateway does not cache MCP results itself. It stamps `ttlMs: 0` and `cacheScope: private` on the
  results it builds. Source:
  [mcp/handler.rs](https://github.com/agentgateway/agentgateway/blob/main/crates/agentgateway/src/mcp/handler.rs).
- Published startup or per-call numbers: none found in the README or the MCP docs pages. Source:
  [MCP docs](https://agentgateway.dev/docs/standalone/latest/mcp/).

### Bifrost (Go)

- An LLM gateway with an MCP gateway. Its README claims 11 µs of added latency per request at a
  sustained 5 000 requests per second. That number is for the LLM request path, not for MCP calls.
  Source: [README](https://github.com/maximhq/bifrost/blob/main/README.md).
- Plugin model: a Go `MCPPlugin` interface with `PreMCPHook` and `PostMCPHook`. The pre hook can return
  an `MCPPluginShortCircuit`, so a cache could live there. Source:
  [core/schemas/plugin.go](https://github.com/maximhq/bifrost/blob/main/core/schemas/plugin.go).
- It is an HTTP service. The README lists MCP tool use as a feature and also names an "MCP gateway"
  among the things enterprise deployments unlock.

### Docker MCP Gateway (Go)

- A `docker mcp` CLI plugin that runs servers in containers. Latest tag v0.44.3. Source:
  [repo](https://github.com/docker/mcp-gateway).
- Plugin model: "interceptors" that run before or after a tool call, as a shell script, a container or
  an HTTP call. A before interceptor can "bypass the call and return a custom response". Source:
  [examples/interceptors/README.md](https://github.com/docker/mcp-gateway/blob/main/examples/interceptors/README.md).
- Each interceptor is a process start or an HTTP call per tool call. That is slower than our in-process
  layers.
- Its `go.mod` pins `go-sdk` v1.4.1, which the Go SDK table maps to 2025-11-25. Source:
  [go.mod](https://github.com/docker/mcp-gateway/blob/main/go.mod).

### Others seen

- **Toolport** (Rust, v2.3.4, 2026-11-08): a desktop app and local gateway with tool search. Not a
  layer host. Source: [README](https://github.com/btsouth/toolport/blob/main/README.md).
- **lazy-mcp** (Go): a stdio proxy that loads servers on demand behind two meta tools. It is the
  closest existing work to Gap 7, but it changes the tool list the model sees. Source:
  [README](https://github.com/voicetreelab/lazy-mcp/blob/main/README.md).

### Would building on one beat our own?

No. None of them can host all three layers as written, and none publishes a startup number for MCP.
The `Layer` contract in `src/layer.ts` lets a layer call `next()` zero times or many times. That is the
whole point of cache and consolidate, and it is what the gateway hook models leave out. Bifrost comes
closest, but it means writing Go plugins inside an LLM gateway. Reuse one idea instead: agentgateway's
written notes on old and new protocol negotiation are a good checklist for our own proxy.

---

## 3. Where a Rust rewrite would save time

### Where the 145 ms goes (measured today)

My runs reproduce the owner's numbers: fixture server direct 145 ms ready, proxy in front 295 ms ready.

The proxy process alone, loading its modules and doing nothing else:

| Step | Time |
| --- | --- |
| Node boot, empty script | 75 ms |
| `zod` | 18 ms |
| SDK `types.js` | 7 ms |
| SDK client (Ajv is 9 ms of it) | 19 ms |
| SDK stdio and HTTP client transports | 8 ms |
| First `.ts` file, which loads the type stripper | 26 to 29 ms |
| **Total, `node` importing `src/proxy/cli.ts`** | **152 ms, 97 MB peak RSS** |

So the proxy overhead is about half Node boot and half module loading. Almost none of it is our code.

### What Rust would cost instead

- **Measured today:** a Rust binary using only the standard library that copies stdin lines to stdout
  starts and exits in 2.6 ms with 1.9 MB peak RSS. `rg --version` takes 3.1 ms and 3.0 MB.
- **Estimate:** a real proxy with tokio, `rmcp`, a TLS stack and SQLite should be ready in 5 to 15 ms
  and use 8 to 20 MB. I found no published number for a comparable MCP proxy, so treat this as a guess
  until someone builds one.
- **Estimate:** ready time through a Rust proxy in front of the same Node fixture server would be about
  150 to 160 ms, against 295 ms today. That saves about 140 ms per stdio server start and about 90 MB
  per running proxy.

That saving is real but it is small next to the 0.5 to 1.5 s connects and 450 ms calls of remote
servers. It becomes important in one case: after idle servers are made lazy (section 4), the proxy is
the only thing that still starts in every session, once per proxied server. Then 150 ms and 107 MB per
server, per session, is the whole remaining cost, and Rust removes almost all of it.

### Cheaper options that stay in JavaScript

| Option | Status in Node 26 | What it gives | Source |
| --- | --- | --- | --- |
| Compile cache | Stable. `module.enableCompileCache()` or `NODE_COMPILE_CACHE=dir`. Covers CommonJS, ESM and TypeScript | **Measured today:** proxy import 152 to 117 ms, peak RSS 97 to 71 MB. Proxy ready 295 to 270 ms. With the upstream Node server using it too, 240 ms | [module docs](https://nodejs.org/docs/latest-v26.x/api/module.html#module-compile-cache) |
| Ship a read-only cache | `readOnly: true`, added in v26.8.0, for a cache "generated ahead of time ... to be shipped inside an application package" | Same gain on the first run after install | same page |
| Build to JavaScript | Needed anyway. Node "refuses to handle TypeScript files inside folders under a `node_modules` path" | Removes the 26 to 29 ms type stripper load without a cache. Makes `npm install -g mcp-faster` work at all | [typescript docs](https://nodejs.org/docs/latest-v26.x/api/typescript.html) |
| Bundle to one file | Recommended by the Node docs for snapshots and single executables | Fewer file reads. Not measured, I did not run a bundler | [SEA docs](https://nodejs.org/docs/latest-v26.x/api/single-executable-applications.html) |
| Startup snapshot | `--build-snapshot` is no longer experimental since v25.4.0. It "only supports loading a single entrypoint ... but not additional user-land modules", so it needs a bundle first | Could skip module execution (zod and Ajv setup). Not measured. Some built-in modules cannot be serialized | [CLI docs](https://nodejs.org/docs/latest-v26.x/api/cli.html#--build-snapshot) |
| Single executable | Stability 1.1, active development. Built with `node --build-sea` since v25.5.0. `useCodeCache` "would improve the startup performance". ESM main cannot be combined with `useSnapshot` | Easier install. It is still Node, so the 75 ms boot stays | [SEA docs](https://nodejs.org/docs/latest-v26.x/api/single-executable-applications.html) |
| `bun build --compile` | Bundles the code "along with a copy of the Bun runtime". "All built-in Bun and Node.js APIs are supported". With bytecode, "`tsc` starts 2x faster" | Possibly faster boot than Node. Not measured, Bun is not installed here | [Bun executables](https://bun.com/docs/compiler/executables), [Bun bytecode](https://bun.com/docs/compiler/bytecode) |
| `deno compile` | Embeds the program in `denort`. Embeds the whole `node_modules` tree by default, which "can make binaries large and slow to start". `--bundle` is experimental | No startup numbers published. Not measured | [Deno compile](https://docs.deno.com/runtime/reference/cli/compile/) |

The TypeScript SDK says it runs on Node, Bun and Deno. Source:
[README](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/README.md).

**Limit of the JavaScript route (estimate).** Node boot is 75 ms and nothing above removes it. The best
case for a Node proxy is about 75 ms boot plus 20 to 40 ms of module work, so about 100 to 115 ms of
overhead instead of 150 ms. A Rust front would be about 5 to 15 ms. The gap between "best Node" and
"Rust" is roughly 90 to 100 ms and 60 to 90 MB per proxied server per session.

### Recommendation for this section

Turn on the compile cache now. Put the call in a plain JavaScript entry file, or set
`NODE_COMPILE_CACHE` in the server's `env`. **Measured today:** calling `module.enableCompileCache()`
from a `.ts` entry file gives only part of the gain (136 ms, 95 MB), because Node must load the type
stripper for that first file before the cache is on. From a `.mjs` entry or the environment variable
the result is 118 ms and 72 MB. Add a build step when the package is first published. Hold the Rust decision until idle servers are lazy and `mcp-faster stats`
can show what the proxy itself costs per session. If Rust is then worth it, write only the front: stdio
framing, the handshake answered from a disk cache, and pass-through. Keep the layers in TypeScript
behind it, started on the first real call.

---

## 4. What is not worth rewriting

- **Network-bound calls.** Remote connectors take 0.5 to 1.5 s to connect and about 450 ms per call
  (owner's logs). The proxy adds 0.07 ms per call (owner's measurement). A faster language cannot
  improve the 450 ms. Only fewer calls (consolidate), skipped calls (cache) and smaller answers
  (compact) can.
- **Idle servers.** This is the largest measured cost, and it is a design problem. `src/proxy/proxy.ts`
  runs `await upstream.connect(...)` before `server.connect(downstream)`. So a proxied server that is
  never called still pays its full connect, plus the proxy start. A Rust proxy with the same design
  would still pay the full upstream connect in every session.
- **The fix is the same in any language:** answer the handshake and the tool list from a stored copy,
  and connect upstream on the first `tools/call`. The 2026-07-28 revision is built for this. There is
  no `initialize`, the `server/discover` result carries `ttlMs` and `cacheScope`, and SDK v2 can connect
  from a stored discover result with zero round trips. Source:
  [docs/advanced/gateway.md](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/advanced/gateway.md).
  The SDK warns that a stored result must be keyed on the credential that got it and never shared
  across principals. That matches the `principal` rule in `src/layer.ts`.
- **The cheapest fix of all** is to remove servers that are never called. `mcp-faster stats` already
  shows which ones those are.
- **The layers.** Cache, compact and consolidate run only when a call happens, and a call costs
  hundreds of ms on the network. Their own run time does not matter.

---

## 5. Other old or slow parts

Checked, with evidence. Only the first two are worth acting on.

| Part | Finding | Verdict |
| --- | --- | --- |
| `npx` for upstream servers | **Measured today:** `npx --version` alone takes 111 ms and 60 MB (npm 11.20.0). That is the floor before npm looks for the package, and the owner measured about 500 ms per start | Replace. Install the server once and run `node /path/to/bin.js`. This saves more per start than a Rust proxy would |
| Running `.ts` directly | **Measured today:** 26 to 29 ms and about 25 MB per start for the type stripper. It also breaks once the package sits in `node_modules` ([docs](https://nodejs.org/docs/latest-v26.x/api/typescript.html)) | Fix with the compile cache now and a build step at publish time |
| zod on the hot path | **Measured today:** `CallToolResultSchema.parse` takes under 0.001 ms, even on a 1 MB tool result. Loading zod costs 18 ms at start | Leave it |
| JSON handling | **Measured today:** one proxy hop (frame, parse, validate, stringify) costs 0.006 ms at 1 KB, 0.02 ms at 11 KB, 0.17 ms at 111 KB, 2.3 ms at 1.1 MB | Leave it. A 111 KB result is already far too big for a model |
| Stdio framing | The SDK `ReadBuffer` joins every chunk with `Buffer.concat` and searches for the newline from the start each time. **Measured today:** 30 ms for an 8.9 MB message against 7.9 ms for the JSON parse alone. The buffer is capped at 10 MB | Leave it. It only shows on results that should never be sent |
| Ajv in the SDK client | **Measured today:** 9 ms at start. The v1 client always imports it | Leave it. A bundle or snapshot would cover it |
| SQLite | The project uses the built-in `node:sqlite` in `src/bench/strategies.ts`. There is no native add-on to compile or load | Leave it |

---

## What I could not verify

- **Kotlin SDK support for 2026-07-28.** The README mentions the revision, but I did not find a version
  constant or a support statement.
- **C#, Ruby and PHP support** is taken from their roadmap or README text, not from source constants.
- **Java 3.x.** The roadmap planned first milestones for September 2026. The six most recent releases
  show none, but I did not page through the full list.
- **Whether Claude Code or the claude.ai connectors speak 2026-07-28 today.** I did not check. This
  decides how soon the zero round trip connect helps in practice.
- **Whether the proxy can sit in front of claude.ai connectors at all.** The remote numbers come from
  connectors that the client connects to itself. The proxy only helps servers that are routed through it.
- **Import cost of SDK v2.** I did not install it, so I do not know if v2 starts faster or slower than
  1.32.2. The v2 client still depends on zod.
- **Bundling, startup snapshots, single executables, Bun and Deno.** I checked the docs but ran none of
  them. Their gains above are from docs or are marked as not measured.
- **A real Rust MCP proxy.** The 5 to 15 ms and 8 to 20 MB figures are my estimate from a
  standard-library-only binary. I found no first-party startup or memory numbers for agentgateway or
  any other Rust or Go MCP proxy.
- **agentgateway stdio listener.** I searched the source and docs and found only stdio upstream
  targets. I did not find a sentence that says "HTTP only".
- **Bifrost's MCP path.** The 11 µs number is for LLM requests. I found no MCP-specific number, and I
  did not confirm which MCP features need the enterprise build.
- **The Bun docs page for single executables** moved. The first two URLs I tried returned 404. The
  quotes above come from `bun.com/docs/compiler/executables` and `bun.com/docs/compiler/bytecode`.
- **The `npx` 500 ms figure** is the owner's. I measured only the npm start floor, because running a
  package through `npx` would have meant running downloaded code.
