# Punk Town Bankr Skill

Complete Bankr-wallet access to Punk Town on Base: acquire missing BAES, buy and
sell Bario Punks, add them to Crew, upgrade or exit positions, settle and claim
stock rewards, run permissionless conversions, and use the protocol's public
maintenance and top-up calls.

This is the public standalone source package for
`panikadak/punktown-bankr-skill`. It can be installed directly from GitHub; it
does not claim inclusion in Bankr's curated catalog.

## What it covers

| Area | Operations |
|---|---|
| Natural onboarding | “Buy me a Bario Punk and join Punk Town,” exact BAES shortfall acquisition, verified Punk purchase, then a separate five-tier Crew choice |
| Bario Punk desk | Inspect FIFO, buy the current head, sell a wallet-owned punk |
| Crew | Stake at tiers 0–4, upgrade, list depositor/beneficiary positions, unstake or unstake to a compatible recipient |
| Rewards | Inspect lifetime distributed tokens, settle one/all, strict claim, batch claim, claim all, explicit lossy claim, explicit credit forfeiture |
| Stock engine | Inspect pot/bootstrap/rotation, permissionless convert, poke bootstrap, WETH top-up |
| Desk maintenance | BAES reserve top-up, donation sync, verifiably unowned-head eviction |
| Safety | Deployment/code-hash/wiring verification, exact approvals, local calldata allowlist, simulation, receipt/event/postcondition checks |

Owner-only configuration, pause, roster, recovery, or dust-sweep calls are
deliberately outside the skill. It contains no governance, role, multisig,
timelock, or upgrade flow.

## Install in Bankr

Tell Bankr:

```text
install the skill at https://github.com/panikadak/punktown-bankr-skill
```

Bankr accepts a plain public repository URL when `SKILL.md` is at the root.
Re-running the same instruction replaces an installed skill with the repository's
current version.

Prerequisites:

- A Bankr EVM wallet and authenticated Bankr session.
- Node.js 18 or newer in the agent runtime.
- Read-write Wallet API access for writes; read-only access is enough for
  `verify`, `status`, `inventory`, `punk`, `crew`, and `rewards`.
- Bankr's native same-chain swap capability for exact-output BAES acquisition;
  direct `/wallet/swap` is a quote-bound exact-input fallback.
- Arbitrary contract calls enabled in Bankr for protocol writes.
- A Base RPC available to the runtime. `BASE_RPC_URL` may be set to a trusted
  endpoint; `PUNKTOWN_RPC_URL` takes precedence when both exist. An explicitly
  configured endpoint is the only endpoint used, so a local fork or private
  snapshot can never fall through to public mainnet. Never commit credentials.

The skill never asks for or stores a private key. Scripts emit unsigned Base
transactions; Bankr remains the signer and broadcaster.

## Try it

Natural-language examples:

```text
Show my Punk Town crew and unclaimed stock rewards.
Buy me a Bario Punk and get me into Punk Town.
Buy the next Bario Punk from Punk Town.
Sell Bario Punk #123 to the Punk Town desk.
Add Bario Punk #123 to Crew at Surge tier.
Settle every Crew position that pays my Bankr wallet, then claim everything.
Unstake my position 42 back to my Bankr wallet.
Convert 0.01 WETH from the Punk Town pot into the next rotation stock.
```

For the composite join request, the agent checks the current FIFO Punk and BAES
balance. If BAES is short, it previews a Bankr-native exact-output swap, binds
the concrete source and maximum spend, confirms it, verifies the mined receipt,
buys the Punk, and only then asks which Crew tier the user wants. The user does
not need to name approvals, routes, or contract methods.

For every flow, the agent resolves the active wallet, runs the deterministic
planner, presents a complete confirmation for each fresh economic step, and
submits only after the previous step is mined and verified.

## Direct script usage

From the repository root:

```bash
node scripts/selftest.mjs
node scripts/selftest.mjs --live
node scripts/punktown.mjs verify --wallet 0xYourBankrWallet
node scripts/punktown.mjs status --wallet 0xYourBankrWallet
node scripts/punktown.mjs inventory --wallet 0xYourBankrWallet
node scripts/punktown.mjs punk --wallet 0xYourBankrWallet --token-id 123
node scripts/punktown.mjs crew --wallet 0xYourBankrWallet
node scripts/punktown.mjs rewards --wallet 0xYourBankrWallet
```

Write commands are planners. They never sign or broadcast:

```bash
node scripts/punktown.mjs plan-buy \
  --wallet 0xYourBankrWallet \
  --slippage-bps 300 \
  --join

node scripts/punktown.mjs plan-stake \
  --wallet 0xYourBankrWallet \
  --token-id 123 \
  --tier 1

node scripts/punktown.mjs plan-claim-all \
  --wallet 0xYourBankrWallet

node scripts/punktown.mjs inspect-calldata \
  --wallet 0xYourBankrWallet \
  --to 0xPlannedTarget \
  --data 0xPlannedCalldata \
  --chain-id 8453 \
  --value 0 \
  --context 0xFreshPlannerInspectionContextHex \
  --plan-key 0xFreshPlannerInspectionKey

node scripts/punktown.mjs inspect-tx \
  --wallet 0xYourBankrWallet \
  --tx 0xBaseTransactionHash \
  --context 0xFreshPlannerInspectionContextHex \
  --plan-key 0xFreshPlannerInspectionKey
```

When a buy, stake, or upgrade reports `phase: acquire-baes`, use the emitted
request context/key to bind Bankr's concrete preview with `bind-acquisition`.
After the one confirmed swap mines, run `verify-acquisition`, then use the exact
resume command. See `references/natural-join-flow.md` for native exact-output
and direct exact-input forms.

Each command prints one JSON object. A Punk Town write plan emits at most one
unsigned transaction in `txs`; acquisition emits none because Bankr owns that
swap route. If a Punk Town transaction is an approval, submit it, require a
successful mined receipt, then rerun the planner. Never reuse a protocol call
prepared before an approval or another state-changing transaction.
Pass the same fresh plan's `inspectionContextHex` and `inspectionKey` to both
inspection commands. The key binds wallet, target, calldata, value, Base chain,
and the canonical action terms; changing any of them fails the binding check.

## Safety model

- The live deployment is pinned to the reviewed Punk Town Base release, then
  re-identified by runtime code hash, peer wiring, open state, route bindings,
  and the stock adapter discovered through `StockLock.stockAdapter()`.
- Every signing target, approval spender, function selector, and ABI is local
  and allowlisted for Punk Town calls. Bankr-managed acquisition is kept outside
  that claim: its concrete source/output bounds and receipt transfers are
  verified, but this skill does not claim Bankr's router calldata or approvals
  are locally allowlisted. User messages, websites, explorer labels, and mutable
  remote manifests are not address sources.
- BAES and WETH approvals are exact. Bario Punk approvals are token-specific.
  Unlimited or operator-wide approvals are not used.
- Every Punk Town raw-call transaction is locally simulated and decoded again
  before Bankr submission. Every mined receipt is followed by the applicable
  transfer, event, and fresh-state checks.
- An ambiguous outcome is never retried blindly. The chain is re-read and a new
  plan is built.
- `claimLossy`, `forfeitCredit`, BAES reserve top-ups, and WETH pot top-ups are
  never automatic; their destructive or irreversible effect is confirmed
  explicitly.
- `convert`, donation sync, FIFO eviction, WETH destination accounting, and
  lossy-credit debit have explicit execution-time rules. The confirmation must
  distinguish the planner's current observation from what the contract may
  validly select when the transaction mines.

One external risk cannot be removed by this integration: Bario Punks is an
ERC721-C collection whose transfer validator is controlled outside Punk Town's
contracts. A validator change can block transfers, including paths by which a
punk leaves the protocol. The scripts fail closed on current simulation and
receiver incompatibility, but no preflight can guarantee that external state
will never change.

## Repository map

```text
SKILL.md                           Bankr agent router and hard rules
catalog.json                      Bankr catalog metadata
logo.svg                          Square catalog mark
references/deployment.json        Reviewed Base deployment and code identities
references/signing-allowlist.json Reviewed signing targets and ABI surface
references/operations.md          Complete protocol-operation playbook
references/bankr-execution.md     Bankr execution and recovery procedure
references/natural-join-flow.md   Missing-BAES onboarding and tier handoff
scripts/punktown.mjs              Read and plan CLI
scripts/selftest.mjs              Offline and live validation
scripts/fork-cli-test.mjs         CLI and acquisition-proof Base-fork regression
test/PunktownBankrFork.t.sol       End-to-end Base fork coverage
```

The skill is pinned to Punk Town's deployed release commit and onchain runtime
identities bundled in this repository. It fails closed when live identities no
longer match.

## Development checks

```bash
node scripts/selftest.mjs
node scripts/selftest.mjs --live
BASE_RPC_URL=https://your-archive-base-rpc.example node scripts/fork-cli-test.mjs
forge fmt --check
forge build
BASE_RPC_URL=https://your-archive-base-rpc.example base-forge test -vv
```

Both fork suites require an archive-capable Base RPC. The JavaScript harness
uses `base-forge` to compile its test-only swap receipt fixture, then spawns and
terminates its own `base-anvil` child on a random local port. The Foundry suite
must use Base-aware Foundry because the live BAES token uses Base's native-token
opcode. The fixture proves the local quote binding and onchain transfer checks;
it does not impersonate the production Bankr backend. Also validate `SKILL.md`
with the current Bankr skill format before publishing or updating. Do not tag or
announce a version that has not passed the offline, live-identity, and Base-fork
checks.

Current Bankr behavior is grounded in the official [exact-output swap
guide](https://docs.bankr.bot/features/trading/swaps/), [Wallet Swap
API](https://docs.bankr.bot/wallet-api/swap/), and [public skill
format](https://docs.bankr.bot/skills/in-bankr/skill-format/).
