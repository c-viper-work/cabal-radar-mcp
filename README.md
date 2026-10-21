# cabal-radar-mcp

**Solana & Base token risk intelligence for MCP assistants and the terminal.** Zero external runtime dependencies. Open-source Node.js ESM. Built by [c-viper-work](https://github.com/c-viper-work).

Inspect Solana mint/freeze authorities, Token-2022 controls, holder-account concentration, early acquisition coordination, Jito tips and mother-wallet funding clusters. Inspect Base ERC20 metadata, dangerous bytecode patterns, earliest observed Transfer concentration and transfer restrictions. Activate local Pro with an on-chain payment receipt; no central license server, private keys or wallet connection.

[Landing page](https://c-viper-work.github.io/cabal-radar-mcp/) · [Source](https://github.com/c-viper-work/cabal-radar-mcp) · [Trust model](#limitations-and-trust-model)

> This is heuristic investigation software, not a completed security audit. A high safety score does not establish safety. Tax and honeypot results remain **UNKNOWN** when the available evidence cannot establish them. Launch coverage is never implied by a bounded historical sample.

## Zero-clone MCP setup

```sh
npx -y github:c-viper-work/cabal-radar-mcp mcp
```

For MCP clients, use `command: "npx"` with `args: ["-y", "github:c-viper-work/cabal-radar-mcp", "mcp"]`. The globally installed configuration below remains supported.

## Installation

Requires **Node.js 22+**. No dependency install is needed to run a source checkout:

```sh
git clone https://github.com/c-viper-work/cabal-radar-mcp.git
cd cabal-radar-mcp
node bin/cabal-radar.js --help
npm test
npm install -g .
```

Or install from the public GitHub repository when available:

```sh
npm install -g github:c-viper-work/cabal-radar-mcp
```

After the maintainer publishes version 1.0.0 to npm, `npm install -g cabal-radar-mcp@1.0.0` and `npx -y cabal-radar-mcp@1.0.0 mcp` are equivalent distribution options. This source tree does not imply that npm publication, registry listing or a hosted deployment has occurred.

Both `cabal-radar` and `cabal-radar-mcp` are executable aliases. No arguments starts MCP stdio. `npm start` also starts MCP; clients should use the binary directly to avoid npm's stdout banners.

## CLI

```sh
cabal-radar scan DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 --chain solana --json
cabal-radar scan 0x532f27101965dd16442E59d40670FaF5eBB142E4 --chain base --json
cabal-radar upgrade
cabal-radar activate --tx <transaction_hash_or_signature> --chain <base|solana>
cabal-radar status
cabal-radar scan <token_address> --chain solana --pro --json
cabal-radar mcp
```

Replace angle-bracket placeholders before running. Single-token scans infer Base for a valid `0x` address, otherwise Solana. Explicit `--chain` values take precedence. `--pro` returns both basic and deep results after activation; without a valid license it prints upgrade information and exits with status 1. Input/RPC failures also exit 1; successful commands exit 0. CLI activation only reads chain state and writes a local license. No command submits transactions or approves tokens.

## MCP setup: Claude Desktop, Cursor and Windsurf

Install the binary globally first, ensure the client can find it on `PATH`, then merge this entry into the client's MCP server configuration:

```json
{
  "mcpServers": {
    "cabal-radar": {
      "command": "cabal-radar-mcp",
      "args": ["mcp"],
      "env": {
        "SOLANA_RPC_URL": "https://api.mainnet-beta.solana.com",
        "BASE_RPC_URL": "https://mainnet.base.org"
      }
    }
  }
}
```

In Claude Desktop, open its developer/MCP configuration. In Cursor or Windsurf, use MCP server settings and add a stdio command, or merge the object above into the JSON editor if provided. Exact settings labels vary by client version. Restart/reconnect the server and confirm six tools appear. Keep RPC credentials in client environment configuration; do not commit them.

### OpenClaw

The CLI works as a local process tool: invoke `cabal-radar scan <address> --chain <chain> --json`. If your OpenClaw installation has an MCP bridge, register `cabal-radar-mcp` with argument `mcp` through that bridge. The `mcpServers` object above is not asserted to be a native OpenClaw configuration schema. Configure any process-tool approval rules in your agent host; this package never requires wallet-signing permissions.

### Tools

| Tool | Tier | Inputs / behavior |
|---|---|---|
| `scan_token_safety` | Free | `address`, optional `chain`; score, flags, evidence and Pro preview |
| `get_pro_upgrade_info` | Free | No arguments; exact payment routes, machine label and activation instructions |
| `activate_pro_license` | Free | `chain`, `txHash`; validates receipt and saves local Pro license |
| `detect_block0_bundler` | Pro | `address`, `chain`; bounded acquisition/Transfer history, coverage and coordination indicators |
| `trace_funding_clusters` | Pro | `holderAddresses` (1–20 wallet owners), `chain`; Solana funder clusters; Base explicitly unsupported without an indexer |
| `batch_audit_watchlist` | Pro | `tokens` (1–20 `{address,chain}`), `format`: `json` or `markdown`; basic + deep analysis, three concurrent token jobs |

The deep Base tool also accepts `fromBlock` (nonnegative integer, within 10,000 blocks of the head), `simulationFrom`, `simulationTo` and `simulationAmount` (raw-unit decimal string). All three simulation fields are required together. The sender needs a real token balance for a meaningful `eth_call`; no transaction is broadcast. Markdown reports are returned alongside structured results, not written to arbitrary filesystem paths.

Example MCP `tools/call` arguments:

```json
{
  "name": "batch_audit_watchlist",
  "arguments": {
    "tokens": [
      {"chain": "base", "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"},
      {"chain": "solana", "address": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"}
    ],
    "format": "markdown"
  }
}
```

Transport is newline-delimited JSON-RPC 2.0 on stdio. Supported methods: `initialize`, `notifications/initialized`, `notifications/cancelled`, `ping`, `tools/list`, `tools/call`. Protocol versions: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05; an unknown requested version receives the newest supported version. Stdout contains only protocol responses. Notifications have no responses. Tool calls run at most four at a time with up to 64 pending calls; excess calls return JSON-RPC error `-32000 Server busy`. Initialization requires a nonempty string `clientInfo.version`. Ping, initialization, tool listing and notifications bypass the tool queue; clients must match responses by ID. Cancellation removes queued calls immediately, aborts in-flight fetch RPCs and suppresses the cancelled tool response. Input is limited to 1 MiB per line; MCP batches and legacy Content-Length framing are not supported.

## Pro activation

Run `cabal-radar upgrade` to obtain the deterministic `CR-<12 hex characters>` local machine label. Send **one** qualifying payment using the correct network and asset:

| Network | Recipient | Asset | Minimum raw amount |
|---|---|---|---|
| Base mainnet (8453) | `0x3018577736ebcdd3ddca916Bef44e7dC6E27e33E` | Native ETH | `6000000000000000` wei = **0.006 ETH** |
| Base mainnet (8453) | `0x3018577736ebcdd3ddca916Bef44e7dC6E27e33E` | USDC | `15000000` units = **15 USDC** |
| Solana mainnet-beta | `HFBvBikfatVJgZFyisHTatMdQEJHnJRC1a31fJhoNmGR` | Native SOL | `100000000` lamports = **0.1 SOL** |
| Solana mainnet-beta | `HFBvBikfatVJgZFyisHTatMdQEJHnJRC1a31fJhoNmGR` | SPL USDC | `15000000` units = **15 USDC** |

Official USDC identities (six decimals):

- Base contract: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- Solana mint: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`

Keep native currency for network fees. Do not send a different token, use a testnet, or send Base USDC to the token contract as the recipient. Then:

```sh
cabal-radar activate --tx <base_transaction_hash> --chain base
# OR
cabal-radar activate --tx <solana_signature> --chain solana
cabal-radar status
```

Base verification checks `eth_chainId`, transaction/receipt consistency, successful mined status, and either a direct native payment or a matching official USDC Transfer event. Native internal transfers are not accepted. The USDC threshold applies to the sum of valid official USDC Transfer events to the recipient in one successful receipt; malformed matching logs fail verification. Solana verification checks the mainnet genesis hash, successful confirmed parsed transaction, signature and slot, then the recipient's net SOL increase or net USDC increase across its token accounts. Transfers between the recipient's own accounts do not create a qualifying USDC net increase. Precision-unsafe numeric balances fail closed.

Default storage is `~/.cabal-radar/license.json`, privately created and atomically replaced. The saved record contains only version, hashed machine ID, transaction identifier, chain and HMAC. Machine input strings are not saved or sent to a server. Activation does not require putting the challenge in a memo. Reinstalling or moving machines can change the local ID; reactivate on the destination machine.

## Configuration and library use

| Setting | Default | Purpose |
|---|---|---|
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | Solana mainnet RPC |
| `BASE_RPC_URL` | `https://mainnet.base.org` | Base mainnet RPC |
| `CABAL_RADAR_LICENSE_PATH` | `~/.cabal-radar/license.json` | Local license override |

Basic scans verify Base mainnet chain ID or Solana mainnet genesis before reading token data. Solana funding tracing verifies mainnet genesis once before reading holder histories. RPC requests have a 15-second timeout and support `options.signal` cancellation for fetch transports. Errors do not print endpoint URLs or provider messages that might contain credentials. Public providers may rate-limit or lack archive history. The library supports `rpcUrl`, `timeoutMs`, `fetch` or an injected async `rpc(method, params)` for custom transport/testing. Explicit programmatic options take precedence over defaults. Do not inject untrusted RPC implementations: all chain evidence is only as trustworthy as the provider.

```js
import {
  scanSolanaTokenBasic,
  detectBaseEarlyBundlerAndHoneypot,
  getMachineChallenge,
  saveLicense
} from 'cabal-radar-mcp';

const report = await scanSolanaTokenBasic(
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
);
console.log(report.safetyScore, report.flags);
```

Deep scans return their `basic` result and accept `options.basic` for trusted internal reuse of a completed basic scan for the same token, chain and provider. CLI, Worker and batch paths perform each basic scan once. No public tool argument can bypass network verification.

Solana deep scans also sample up to five top holder token-account histories (one page and ten transactions each), deduplicating signatures across all sampled accounts before fetching transactions. `coverage.holderAccountsSampled` reports this additional coverage; transaction counts are unique across histories. Solana acquisition clusters connect events whose consecutive slots differ by at most two; connected clusters may span more than two slots. Unresolved holder accounts are reported in `coverage.unresolvedHolderAccounts` and `coverage.unresolvedSupplyPct`; clustered exposure is `null` when all holder accounts are unresolved.

Low-level scanner exports are intentionally callable directly in an open-source library. The Pro tier is enforced at the MCP/CLI interface, not as an anti-circumvention security boundary. `saveLicense({chain, txHash}, options)` independently verifies payment before writing; a caller-supplied `verified` flag cannot bypass verification. `checkProStatus(options)` returns `{active,tier,machine_id,challenge,...}`. Status is offline and does not re-query the chain.

## Detection methodology

- **Solana basic:** validates decoded 32-byte base58 keys and parsed mint ownership; checks mint/freeze control, permanent delegates, transfer hooks, ≥10% transfer-fee (`HIGH_TRANSFER_FEE`) and non-zero <10% transfer-fee (`NONZERO_TRANSFER_FEE`) configuration, `scaledUiAmountConfig`, `interestBearingConfig`, `mintCloseAuthority`, `confidentialTransferMint`, default frozen accounts and top-ten non-pool token-account share. RPC token-account concentration falls back to RugCheck when `getTokenLargestAccounts` is restricted or rate-limited and labels known pool owners.
- **Solana coordination:** paginates up to three pages of 100 signatures, then loads up to 40 of the oldest successful transactions in that sample. Positive owner token deltas are acquisition candidates, excluding known DEX/AMM/launchpad programs and non-signer pool PDAs. Windows of at most two slots flag coordinated buys (at least three distinct wallets, or two wallets sharing a fee payer, same transaction or Jito tip); actual parsed system transfers to the documented Jito tip accounts are noted. These are not proven DEX buys or atomic bundles. `bundledSupplyPct` is current top-account exposure to flagged owners, not original bought supply.
- **Solana funding:** up to 20 provided wallet owners; default one page and ten oldest sampled transactions per owner. Orders same-slot signatures by reverse RPC response index and interleaves each top-level instruction with its CPI instructions in execution order. Groups the first observed inbound SOL transfer of at least 1,000,000 lamports (0.001 SOL) by source; library callers can set `options.minFundingLamports`. `coverage.ignoredDustTransfers` counts ignored smaller transfers, and per-wallet coverage is in `coverage.holders`. Different-source events form connected timing groups when consecutive times differ by at most 60 seconds; a connected group may span longer than 60 seconds. `sybilClusterPct` is the fraction of provided unique wallets sharing a source, not supply percentage; timing-only groups are excluded.
- **Base basic:** reads code and ERC20 metadata, disassembles PUSH instructions to avoid interpreting PUSH data as opcodes, detects EIP-7702 delegation designators, inspects EIP-1167 / EIP-1967 / ZeppelinOS proxy implementations one level deep, and identifies selected control selectors. All bytecode is scanned, including metadata, to prevent forged metadata from hiding executable jump targets. This conservative choice can flag bytes in genuine metadata. Dynamic code paths, computed selectors, deeper proxy chains and role access are not fully analyzed.
- **Base deep:** defaults to the last 2,000 blocks, queried in 500-block chunks. Anchors on the earliest positive-amount non-mint/non-burn Transfer block and its successor (`coverage.firstTransferBlock`), reports the earliest observed block including mints as `coverage.firstObservedBlock`, excludes zero amounts, known routers/bridges, self-transfers and transfer-source pair addresses, and aggregates gross recipient transfer volume. Gross volume is not token supply and can include repeated transfers. Optional `eth_call` checks an explicitly provided transfer scenario; reverts, false returns and nonstandard returns are review signals, not proof of honeypot. Generic RPC/node failures propagate instead of being treated as reverts. Live scans can supplement unknown tax with honeypot.is simulation; unavailable simulation remains unknown. Standard approve/permit capability is informational, not evidence of malicious approval behavior.

Scores start at 100 and subtract explicit per-flag penalties, clamped at zero. Risk bands: LOW 81–100, MEDIUM 51–80, HIGH 26–50, CRITICAL 0–25. A zero-flag report still carries evidence limitations. Unknown data is not a safety guarantee.

## Limitations and trust model

**Zero central server does not mean zero network access.** Token addresses and transaction identifiers are sent to configured RPC providers (with automatic public failover to `*.publicnode.com` when the default public RPC is rate-limited or forbidden) and read-only enrichment endpoints (`api.rugcheck.xyz` when Solana `getTokenLargestAccounts` is restricted, and `api.honeypot.is` for Base tax simulation; the browser web scanner also queries `api.dexscreener.com` and `api.gopluslabs.io`). Set `CABAL_RADAR_NO_FAILOVER=1` to disable automatic RPC failover and `CABAL_RADAR_NO_ENRICHMENT=1` to disable third-party enrichment in the CLI/MCP server. There is no first-party telemetry, hosted activation database or private-key input; the CLI and MCP server never request wallet connections or sign transactions.

**Public receipts are replayable.** A transaction hash alone cannot prove that the caller paid, bind a payment to a machine challenge, or enforce globally unique use. The deterministic HMAC provides machine-bound local consistency, not a secret that a local attacker cannot reproduce. This release does not claim payer authentication, tamper-proof licensing or one-payment-per-machine enforcement. Solving those requires a different authorization scheme, such as a signed payer challenge plus an on-chain entitlement or shared redemption state.

**Confirmation is not finality.** Base accepts a mined successful receipt; Solana uses `confirmed`. Reorganizations remain possible. Saved licenses are not continuously revalidated. Neither the machine challenge nor tokens are transmitted to an activation backend.

**Coverage is bounded.** RPC history can be pruned, omit mint-related transfers that do not reference the mint account, or omit original wallet funding. The oldest available transaction is not proof of launch. Common exchange funding can resemble a sybil cluster. No historical absence result establishes absence of coordination.

## Optional edge API

`cloud-worker/worker.js` uses only portable Web APIs and the shared scanner/payment modules. Local operation does not depend on it. Cloudflare's module-worker entry exports `{fetch}`; the deployment bundle must include the relative `src/` imports. A deployment configuration is included in `cloud-worker/wrangler.toml`. Use an installed deployment CLI from the project root:

```sh
wrangler deploy --config cloud-worker/wrangler.toml
```

For Deno, the included entry module is `cloud-worker/deno.js`. Free-tier feasibility depends on current provider CPU/subrequest limits and RPC throughput; no hosting or always-free SLA is promised. Deep scans may exceed low-tier quotas. Deployments, provider accounts and publication are not performed by this package.

Endpoints:

- `GET /health`: package/version metadata.
- `POST /scan`: body `{ "address": "...", "chain": "base" }`. Without payment headers, returns HTTP **402** and exact payment instructions. Retry with `X-Payment-Tx` and `X-Payment-Chain`; a qualifying receipt unlocks basic + deep scanning for that request.

This is the **`onchain-receipt-v1` HTTP 402 scheme**, not the x402 `exact` payment-signature/facilitator settlement protocol. It does not advertise standards-compliant x402 support. Receipts act as reusable public bearer proofs, so this endpoint is unsuitable for authenticated billing or per-request paywalls. The operator should understand this before public deployment. Client-supplied RPC endpoints are rejected. Configure RPC URLs in deployment environment variables. The worker has no persistent license storage, CORS relaxation or automatic payment settlement.

## Registry metadata and GitHub Pages

The root `Dockerfile` uses Node.js 22 Alpine and starts `node bin/cabal-radar.js --mcp` for MCP stdio introspection without extra configuration. Build with `docker build -t cabal-radar-mcp .` and run with `docker run --rm -i cabal-radar-mcp`. The CLI accepts both `mcp` and `--mcp`.

`glama.json` supplies the maintainer claim for [Glama](https://glama.ai/blog/2025-07-08-what-is-glamajson). `smithery.yaml` supplies the stdio launch command/configuration. Registry acceptance, organization ownership and current hosting capabilities must be verified by the maintainer; metadata does not automatically publish or guarantee one-click installation. Local license persistence is host-specific in containers.

For MCP directories such as mcp.so, Smithery, Glama and Awesome-MCP, use:

> cabal-radar-mcp — zero-dependency Solana and Base MCP server and CLI for token risk heuristics, Token-2022 controls, early bundler signals, shared-funder clusters and on-chain Pro activation.

Category: blockchain / security / developer tools. License: MIT. Transport: stdio. Repository owner: `c-viper-work`.

The static, self-contained `docs/index.html` is ready for a GitHub Pages source of **branch /docs** after the repository is published. It has a live browser token scanner, accessible setup tabs, clipboard buttons, mobile layout, exact payment routes and no third-party script tags or external fonts. Clipboard access requires HTTPS or a secure local origin; otherwise the text is selected for manual copy. Scanning requires no wallet connection; optional in-browser Base wallet checkout (`window.ethereum`) is only invoked when the user explicitly clicks a Base payment button.

## Development and verification

```sh
npm test
node bin/cabal-radar.js --help
npm pack --dry-run
```

Temporary test files fall back to a workspace directory if the OS temporary directory is read-only or permission-restricted. Audit regression cases are in `test/audit.test.js`; CLI, Worker and batch integration tests also reject or count duplicate basic scans.

Test helpers try the system temp directory, then the workspace. If both deny writes, a test-only virtual filesystem preserves license integrity and CLI subprocess coverage without changing production storage. Run `NODE_OPTIONS='--import=./test/readonly-preload.js' npm test` to inject read-only write failures across the suite; virtual file modes do not verify operating-system permission enforcement.

Tests use Node's built-in test runner and synthetic chain fixtures. They cover minimums, wrong networks/assets/recipients, failed transactions, integer precision, license tampering, Solana/Base analysis, opcode disassembly, protocol framing, gating, CLI subprocesses and edge 402 responses. Spawned CLI tests use a preload fixture at the fetch boundary so they do not require listening sockets or paid RPC access. They do not establish live mainnet availability, actual transfer execution, public deployment or registry acceptance. No real payments, private data or testnet transactions are required.

Architecture: `constants` → `rpc` / `payments` → scanners → `service` → CLI/MCP. `license` is Node-only; the Worker imports the portable payment module directly. No runtime dependency lockfile is needed.

## References

- [Solana RPC getTransaction](https://solana.com/docs/rpc/http/gettransaction)
- [Token-2022 extensions](https://www.solana-program.com/docs/token-2022)
- [Jito tip accounts and bundle semantics](https://docs.jito.wtf/lowlatencytxnsend/)
- [MCP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

## License

MIT © 2026 c-viper-work. See [LICENSE](LICENSE).

## Live browser scanner and audit coverage

The landing page scans without installation: DexScreener market telemetry, RugCheck/GoPlus Solana authorities and holders, Base bytecode/metadata, and GoPlus/honeypot.is controls and simulated taxes. Public APIs may block CORS or rate-limit; partial evidence is labeled and an unavailable security score remains unknown. Known pools are excluded from the browser concentration estimate, but the lists are incomplete and account owners are not verified beneficial owners.

Browser Pro verifies the same mainnet receipt rules as the CLI, stores only the receipt reference in localStorage and re-verifies on reload. Optional Base wallet buttons send exactly 0.006 ETH or 15 official USDC (plus network gas) only after wallet confirmation. Existing Solana receipts can also activate Pro. Browser storage is separate from machine-bound CLI activation; the UI provides the exact CLI command. Pro reveals provider holder/insider evidence, supports JSON/Markdown export, and runs bounded launch/funding analysis on demand. It cannot infer unavailable launch history or prove shared control.

CLI/MCP single-token scans infer Base for a valid `0x` address when chain is omitted; explicit chain values retain validation. Live RPC calls retry transient limits twice; injected `rpc`/`fetch` transports remain single-attempt unless `maxRetries` is positive. Backoff respects cancellation. Solana transaction version errors retry with version 1; unavailable individual historical transactions count as missing. RugCheck holder fallback and honeypot.is simulation use four-second timeouts and can be exercised with `enrichmentFetch` in tests.

Solana clustering excludes curated pool/program addresses and signer sells into non-signer pools. Known exchange funding is reported separately in `exchangeFundedGroups`. Empty/unresolved holders yield null bundled exposure. `launchWindowReached` indicates exhaustion of the RPC sample, not proof of creation. Base scans inspect known minimal/EIP-1967/ZeppelinOS implementations one level deep, recognize EIP-7702 delegation and exclude known routers from recipient counts. Rate-limited log history is marked incomplete.

New machine labels omit hostname and use `CABAL_RADAR_MACHINE_ID` (if set), otherwise the home directory, plus platform and architecture. Use a stable home path or explicit machine ID for container persistence; persist the license file too. Legacy hostname-based licenses remain readable on their original machine; after a hostname change, an old license can be reactivated with its receipt.

Worker JSON responses support CORS; `/health` and `/scan` accept OPTIONS preflights. Successful receipts are cached in memory (at most 256 entries; injected payment options bypass it). This is an optimization, not payer authentication or replay protection.

The static site deploys from `docs/`. After changing portable modules run `node scripts/build-browser.mjs`; tests verify the generated `docs/scanner-core.js` matches source. No bundler or runtime dependencies are required. Social assets are `docs/og-card.svg` and `docs/og-card.png`.
