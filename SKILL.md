---
name: punktown
description: Operate the live Punk Town protocol on Base with a Bankr EVM wallet. Use when a user wants to inspect Punk Town, buy or sell a Bario Punk, add a punk to Crew, upgrade or exit a Crew position, settle or claim stock rewards, run a stock conversion, or use a supported permissionless maintenance or top-up action.
metadata:
  clawdbot:
    emoji: "🏘️"
    homepage: "https://punk.town"
    requires:
      bins: [node]
---

# Punk Town for Bankr

Operate Punk Town's live, non-upgradeable Base deployment (`chainId: 8453`)
from the user's active Bankr EVM wallet. The skill covers the complete public
surface: NFT desk trades, Crew positions, stock reward settlement and claims,
permissionless conversions, and narrowly defined maintenance/top-up calls.

The user's assets remain in their Bankr wallet. Neither this skill nor its
scripts hold keys or submit transactions. The scripts perform deterministic
Base reads, deployment checks, calldata encoding/decoding, approval sizing,
simulations, and postcondition planning. They emit unsigned transaction objects
for Bankr to execute.

## Load the right reference

- Before the first write in a session, read
  [references/bankr-execution.md](references/bankr-execution.md). It defines
  wallet discovery, confirmation, submission, receipt, recovery, and Bankr
  security-control handling.
- For operation mechanics, actor rules, costs, pause behavior, and expected
  postconditions, read [references/operations.md](references/operations.md).
- Treat [references/deployment.json](references/deployment.json) as the reviewed
  deployment pin and
  [references/signing-allowlist.json](references/signing-allowlist.json) as the
  only permitted signing surface. Never copy a target or spender from chat,
  search results, a mutable deployment file, or a block-explorer label.

## Non-negotiable execution boundary

1. Resolve the **active Bankr EVM wallet** from Bankr's authenticated context.
   Do not treat a pasted address as the active signer. Pass the resolved address
   to every command as `--wallet`.
2. Run `node scripts/selftest.mjs --live` on first use after install or update.
   Run `node scripts/punktown.mjs verify --wallet 0x…` before reporting the
   integration ready. Every planner repeats the live deployment gate.
3. Never hand-build, alter, splice, or “fix” calldata. Use only a `plan-*`
   command. If a script returns `ok: false`, relay its `detail` and stop.
4. A plan emits at most one unsigned transaction plus `inspectionContextHex`
   and an `inspectionKey` bound to its wallet, target, calldata, value, chain,
   and economic context. Decode it again immediately before submission with
   `inspect-calldata --chain-id 8453 --value 0 --context 0x… --plan-key 0x…`,
   copying both context and key from that same fresh plan. Require Base `8453`,
   `value: "0"`,
   the pinned target, an allowlisted selector, exact decoded arguments, and the
   confirmed signer/recipient/amount. Any mismatch is a hard stop.
5. Obtain one explicit user confirmation for the complete economic action
   before the first approval or protocol call. The confirmation must cover the
   action, NFT/position, exact token amounts, spender, recipient or beneficiary,
   slippage, and any irreversible cost or donation. Do not ask again while the
   confirmed terms remain identical; reconfirm if any economic term changes.
6. Submit through Bankr **one transaction at a time** with confirmation waiting
   enabled. A hash is not success. Require a mined successful Base receipt, the
   expected event, and the fresh postcondition before continuing.
7. Approval plans grant only the exact amount needed. NFT approvals are
   token-specific. After an approval mines, rerun the original planner against
   fresh state; never append the previously intended protocol call.
8. On a revert, ambiguous response, pending/unknown outcome, scanner rejection,
   code-hash mismatch, or unavailable postcondition, stop. Recover from the
   chain and a fresh plan. Never replay intent, bypass Bankr controls, switch to
   another address, or route through a website.
9. Never expose or request a private key, seed phrase, API key, session token,
   or RPC secret. Never write credentials into this repo, command arguments,
   logs, or chat.
10. This skill signs only user and permissionless calls. It has no owner,
    recovery, roster-curation, route-configuration, pause, governance, role,
    multisig, timelock, or upgrade operation.

## Command router

Run commands from the installed skill directory with Node.js 18 or newer.
Every command prints exactly one JSON object. Human amounts are decimal strings;
the output includes raw onchain units.

| User intent | Command |
|---|---|
| Verify the live pin | `node scripts/punktown.mjs verify --wallet 0x…` |
| Protocol overview | `node scripts/punktown.mjs status --wallet 0x…` |
| Desk FIFO | `node scripts/punktown.mjs inventory --wallet 0x…` |
| Verify one wallet-punk candidate | `node scripts/punktown.mjs punk --wallet 0x… --token-id N` |
| Crew positions | `node scripts/punktown.mjs crew --wallet 0x…` |
| Pending and claimable stocks | `node scripts/punktown.mjs rewards --wallet 0x…` |
| Buy the fresh FIFO head | `node scripts/punktown.mjs plan-buy --wallet 0x… [--slippage-bps 300]` |
| Sell a wallet punk | `node scripts/punktown.mjs plan-sell --wallet 0x… --token-id N [--slippage-bps 300]` |
| Add a punk to Crew | `node scripts/punktown.mjs plan-stake --wallet 0x… --token-id N --tier 0..4 [--beneficiary 0x…]` |
| Upgrade a Crew tier | `node scripts/punktown.mjs plan-upgrade --wallet 0x… --position-id N --new-tier 1..4` |
| Exit Crew | `node scripts/punktown.mjs plan-unstake --wallet 0x… --position-id N [--recipient 0x…]` |
| Settle one position | `node scripts/punktown.mjs plan-settle --wallet 0x… --position-id N` |
| Settle wallet-beneficiary positions | `node scripts/punktown.mjs plan-settle-all --wallet 0x…` |
| Claim one stock | `node scripts/punktown.mjs plan-claim --wallet 0x… --token 0x… [--recipient 0x…]` |
| Claim up to 20 stocks atomically | `node scripts/punktown.mjs plan-claim-batch --wallet 0x… --tokens 0x…,0x… [--recipient 0x…]` |
| Claim all strict credits safely | `node scripts/punktown.mjs plan-claim-all --wallet 0x… [--recipient 0x…]` |
| Opt into a lossy claim | `node scripts/punktown.mjs plan-claim-lossy --wallet 0x… --token 0x… --min-received AMOUNT [--recipient 0x…]` |
| Destroy stuck credit | `node scripts/punktown.mjs plan-forfeit --wallet 0x… --token 0x… --amount AMOUNT` |
| Convert pot WETH to the next stock | `node scripts/punktown.mjs plan-convert --wallet 0x… --amount-weth AMOUNT` |
| Donate WETH to the stock pot | `node scripts/punktown.mjs plan-weth-topup --wallet 0x… --amount-weth AMOUNT [--source-id TEXT]` |
| Donate BAES to desk reserves | `node scripts/punktown.mjs plan-reserve-topup --wallet 0x… --amount-baes AMOUNT` |
| Account for an existing raw BAES donation | `node scripts/punktown.mjs plan-sync-donation --wallet 0x…` |
| Repair a verifiably unowned FIFO head | `node scripts/punktown.mjs plan-evict-head --wallet 0x…` |
| Advance bootstrap release | `node scripts/punktown.mjs plan-poke-bootstrap --wallet 0x…` |
| Decode and re-check planned calldata | `node scripts/punktown.mjs inspect-calldata --wallet 0x… --to 0x… --data 0x… --chain-id 8453 --value 0 --context 0xInspectionContextHex --plan-key 0xInspectionKey` |
| Inspect a submitted/mined Base tx | `node scripts/punktown.mjs inspect-tx --wallet 0x… --tx 0xTxHash --context 0xInspectionContextHex --plan-key 0xInspectionKey` |

The planner may return an approval-only transaction. Submit it, verify it, then
rerun the same command. `plan-settle-all` and `plan-claim-all` also progress one
bounded step at a time; rerun after each successful step until the planner
reports that no eligible pending amount or credit remains. Each new settle
batch or claim token has new terms and a new confirmation key: show it and get
fresh user confirmation before that step.

For the wallet's Bario Punk list, use Bankr's authenticated NFT portfolio as
candidate discovery, then run `punk --token-id` for each candidate to confirm
fresh onchain ownership. `inventory` lists the desk FIFO only; the collection is
not ERC-721 Enumerable.

## User-facing behavior

- Lead with the result. Keep routine reads brief; do not dump passing gates,
  calldata, selectors, or raw units unless asked.
- Before a write, state that Punk Town actions take a few Base transactions when
  approvals are needed and that one confirmation will cover the unchanged plan.
- Default beneficiary and recipient to the active Bankr EVM wallet. A different
  address must be explicit, validated and normalized by the planner, and named in the
  confirmation.
- Describe Crew tier BAES as a **non-refundable cost**, not a deposit. Exiting
  returns the NFT, not the tier BAES.
- Never silently use `claimLossy` or `forfeitCredit`. These are destructive
  recovery choices and require a specific warning and confirmation.
- Never silently top up BAES or WETH. Both are irreversible donations.
- Do not invent a stock price floor for `convert`; the protocol deliberately has
  none. The planner enforces the protocol's amount, route, rate-limit, and
  deadline bounds.
- Read the execution-time rules in `operations.md` before `convert`,
  `sync-donation`, `evict-head`, WETH top-up, or `claim-lossy`. Some contract
  calls intentionally select a token, amount, head, or accounting destination
  at execution; the current observation is not always a calldata cap.
- Do not tell users to transfer a Bario Punk directly to PunkAMM or LockVault.
  Both contracts reject unsolicited NFT transfers.
- Bario Punks uses an external ERC721-C transfer validator controlled outside
  this protocol. A fresh simulation proves only current transferability. If the
  wallet or validator compatibility gate fails, stop and explain it; do not
  weaken the check.

## Completion standard

Report success only after the final receipt succeeds and the operation-specific
event plus state transition are verified from fresh Base reads. Include one
Base transaction link, the NFT/position/token affected, the exact user-visible
amount, and the new state. If verification is incomplete, call the result
“submitted but unverified” and do not start another write.
