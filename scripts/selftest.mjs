#!/usr/bin/env node
// Offline ABI/policy tests. Add --live for read-only Base deployment checks.

import { readFileSync, statSync } from "node:fs";
import {
  asciiBytes32,
  decodeCallArguments,
  decodePositionsPage,
  decodeStockEntry,
  encodeAddress,
  encodeCall,
  encodeUint,
  formatUnits,
  parseUnits,
  stripErc8021Suffix,
} from "./lib/abi.mjs";
import { eventTopic, keccak256, selector } from "./lib/keccak256.mjs";
import {
  ADDR,
  BUY_TOTAL,
  DEPLOYMENT,
  SIG,
  inventoryPage,
  protocolStatus,
  sanitizeTokenSymbol,
  verifyDeployment,
} from "./lib/protocol.mjs";

const allowlist = JSON.parse(readFileSync(new URL("../references/signing-allowlist.json", import.meta.url), "utf8"));
const results = [];

function check(name, pass, detail = "") {
  results.push({ name, pass: Boolean(pass), detail });
}

function equal(name, actual, expected) {
  check(name, actual === expected, actual === expected ? "" : `actual=${actual} expected=${expected}`);
}

function rejects(name, fn, expectedMessage) {
  try {
    fn();
    check(name, false, "did not reject");
  } catch (error) {
    check(name, String(error.message).includes(expectedMessage), error.message);
  }
}

// Keccak and selectors: Ethereum Keccak, not NIST SHA3.
equal("keccak empty vector", keccak256(""), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
equal("ERC20 transfer selector", selector("transfer(address,uint256)"), "0xa9059cbb");
equal("approve selector", selector(SIG.approve), "0x095ea7b3");
equal("PunkAMM buy selector", selector(SIG.buy), "0x8828735d");
equal("StockLock settle batch selector", selector(SIG.settleBatch), "0x8e28fc9e");
equal("NFTBought topic", eventTopic("NFTBought(address,uint256,uint256,uint256)"), "0x8c68226ed6c7256cb4dc9d9d1d0d84141ffb9ff4cac6ca9fa08dc46ad0a08936");
equal("token symbol strips control characters", sanitizeTokenSymbol("A\n\u001b[31mB"), "A ?[31mB");
equal("token symbol caps untrusted display length", sanitizeTokenSymbol("X".repeat(40)), "X".repeat(32));
equal("token symbol uses safe fallback", sanitizeTokenSymbol("\n\t", "0x1234...abcd"), "0x1234...abcd");

// Static and dynamic ABI encoding.
const wallet = "0x1111111111111111111111111111111111111111";
const buy = encodeCall(SIG.buy, ["uint256", "uint256", "uint256", "uint256"], [123n, BUY_TOTAL, 99n, 456n]);
equal("buy calldata byte length", (buy.length - 2) / 2, 4 + 4 * 32);
equal("buy selector prefix", buy.slice(0, 10), "0x8828735d");
const decodedBuy = decodeCallArguments(["uint256", "uint256", "uint256", "uint256"], buy);
equal("buy decoded token", decodedBuy[0], 123n);
equal("buy decoded exact amount", decodedBuy[1], BUY_TOTAL);
equal("buy decoded deadline", decodedBuy[3], 456n);

const settleBatch = encodeCall(SIG.settleBatch, ["uint256[]"], [[1n, 2n]]);
const expectedSettleBatch =
  "0x8e28fc9e" + encodeUint(32n) + encodeUint(2n) + encodeUint(1n) + encodeUint(2n);
equal("dynamic uint array calldata", settleBatch, expectedSettleBatch);
const decodedSettleBatch = decodeCallArguments(["uint256[]"], settleBatch);
equal("dynamic uint array decoded length", decodedSettleBatch[0].length, 2);
equal("dynamic uint array decoded item", decodedSettleBatch[0][1], 2n);

const claimBatch = encodeCall(SIG.claimBatch, ["address[]", "address"], [[ADDR.baes, ADDR.weth], wallet]);
const expectedClaimBatch =
  "0x02dc3020" + encodeUint(64n) + encodeAddress(wallet) + encodeUint(2n) + encodeAddress(ADDR.baes) + encodeAddress(ADDR.weth);
equal("dynamic address array with static tail", claimBatch, expectedClaimBatch);
const decodedClaimBatch = decodeCallArguments(["address[]", "address"], claimBatch);
equal("dynamic address array decoded item", decodedClaimBatch[0][1], ADDR.weth.toLowerCase());
equal("dynamic static tail decoded", decodedClaimBatch[1], wallet);

const attributedBuy = `${buy}62635f73336a35766637680b0080218021802180218021802180218021`;
const strippedBuy = stripErc8021Suffix(attributedBuy);
equal("ERC-8021 suffix stripped to canonical call", strippedBuy.calldata, buy);
equal("ERC-8021 builder code decoded", strippedBuy.attribution.codes[0], "bc_s3j5vf7h");
const schema1Buy = `${buy}${"cc".repeat(20)}210502626173656170702c6d6f7270686f0e0180218021802180218021802180218021`;
const strippedSchema1 = stripErc8021Suffix(schema1Buy);
equal("ERC-8021 schema 1 stripped to canonical call", strippedSchema1.calldata, buy);
equal("ERC-8021 schema 1 registry address", strippedSchema1.attribution.codeRegistry.address, `0x${"cc".repeat(20)}`);
equal("ERC-8021 schema 1 registry chain", strippedSchema1.attribution.codeRegistry.chainId, 8453);
equal("ERC-8021 schema 1 codes", strippedSchema1.attribution.codes.join(","), "baseapp,morpho");
const schema2Buy = `${buy}a161616762617365617070000b0280218021802180218021802180218021`;
const strippedSchema2 = stripErc8021Suffix(schema2Buy);
equal("ERC-8021 schema 2 stripped to canonical call", strippedSchema2.calldata, buy);
equal("ERC-8021 schema 2 is reported opaque", strippedSchema2.attribution.opaque, true);
equal("ERC-8021 schema 2 byte length", strippedSchema2.attribution.cborBytes, 11);
rejects(
  "reject malformed ERC-8021 builder code",
  () => stripErc8021Suffix(`${buy}612c2c62040080218021802180218021802180218021`),
  "invalid ERC-8021 builder codes",
);

rejects(
  "reject calldata trailing word",
  () => decodeCallArguments(["uint256", "uint256", "uint256", "uint256"], `${buy}${"0".repeat(64)}`),
  "non-canonical trailing",
);
rejects(
  "reject overlapping dynamic offset",
  () => decodeCallArguments(["uint256[]"], `0x8e28fc9e${encodeUint(0n)}`),
  "invalid dynamic offset",
);
const gappedSettleBatch =
  `0x8e28fc9e${encodeUint(64n)}${encodeUint(0xdeadn)}${encodeUint(2n)}${encodeUint(1n)}${encodeUint(2n)}`;
rejects(
  "reject gapped non-canonical dynamic calldata",
  () => decodeCallArguments(["uint256[]"], gappedSettleBatch),
  "canonical ABI re-encoding",
);
const nonCanonicalApproval = `0x095ea7b3${"01"}${"0".repeat(22)}${"11".repeat(20)}${encodeUint(1n)}`;
rejects(
  "reject non-canonical address word",
  () => decodeCallArguments(["address", "uint256"], nonCanonicalApproval),
  "non-canonical ABI address",
);

equal("ASCII bytes32", asciiBytes32("BANKR-PUNKTOWN"), "0x42414e4b522d50554e4b544f574e000000000000000000000000000000000000");
equal("parse BAES units", parseUnits("6600000", 18), BUY_TOTAL);
equal("format tiny WETH", formatUnits(81750413962n, 18), "0.000000081750413962");

// Position[] page: head(offset=64,nextCursor=2), array length=1, six static tuple words.
const fakePage =
  "0x" +
  encodeUint(64n) + encodeUint(2n) + encodeUint(1n) +
  encodeUint(44n) + encodeAddress(wallet) + encodeAddress(ADDR.owner) +
  encodeUint(158n) + encodeUint(1n) + encodeUint(1n);
const decodedPage = decodePositionsPage(fakePage, 1n);
equal("position page id", decodedPage.positions[0].id, 1n);
equal("position page token", decodedPage.positions[0].tokenId, 44n);
equal("position page beneficiary", decodedPage.positions[0].beneficiary, ADDR.owner.toLowerCase());
equal("position page next cursor", decodedPage.nextCursor, 2n);

// Dynamic stock tuple: top-level tuple offset, token, path offset, decimals, enabled, empty path.
const fakeStock =
  "0x" + encodeUint(32n) + encodeAddress(ADDR.baes) + encodeUint(128n) +
  encodeUint(8n) + encodeUint(1n) + encodeUint(0n);
const decodedStock = decodeStockEntry(fakeStock);
equal("stock tuple token", decodedStock.token, ADDR.baes.toLowerCase());
equal("stock tuple decimals", decodedStock.decimals, 8);
check("stock tuple enabled", decodedStock.enabled);

// Every catalogued signature must carry its actual Ethereum selector/topic.
let signatureCount = 0;
for (const target of Object.values(allowlist.targets)) {
  for (const entry of [...(target.reads ?? []), ...(target.writes ?? [])]) {
    signatureCount += 1;
    equal(`allowlist selector ${target.kind}.${entry.signature}`, entry.selector.toLowerCase(), selector(entry.signature));
  }
}
for (const event of allowlist.events) {
  equal(`event topic ${event.signature}`, event.topic0.toLowerCase(), eventTopic(event.signature));
}
check("broad selector coverage", signatureCount >= 100, `count=${signatureCount}`);
check("default deny policy", allowlist.policy.defaultDeny === true);
check("one tx at a time policy", allowlist.policy.submitOneTransactionAtATime === true);
check("exact ERC20 policy", /Exact amount only/.test(allowlist.policy.approvals.erc20));
check("token-specific ERC721 policy", /Token-specific/.test(allowlist.policy.approvals.erc721));

const userWriteSignatures = Object.values(allowlist.targets).flatMap((target) => (target.writes ?? []).map((entry) => entry.signature));
for (const forbidden of [
  "recoverExcess(uint8,address,uint256,address)", "wirePeersAndLock(address,address)",
  "pauseFeeRoute()", "pauseStockRoute()", "setRevenueSource(address,bool)",
  "sweepStockDust(address,address)", "queueStock(uint256,address,bytes,uint8)",
]) {
  check(`privileged call excluded: ${forbidden}`, !userWriteSignatures.includes(forbidden));
}

// Bankr loads these files; keep each below its 100 KB limit.
for (const relative of [
  "SKILL.md", "references/operations.md", "references/bankr-execution.md",
  "references/deployment.json", "references/signing-allowlist.json",
]) {
  try {
    const bytes = statSync(new URL(`../${relative}`, import.meta.url)).size;
    check(`${relative} under 100 KB`, bytes < 100_000, `${bytes} bytes`);
  } catch (error) {
    check(`${relative} exists`, false, error.message);
  }
}

if (process.argv.includes("--live")) {
  const integrity = await verifyDeployment();
  check("live deployment integrity", integrity.ok, integrity.failed.join(", "));
  const status = await protocolStatus();
  check("live system open inventory read", BigInt(status.desk.inventoryCount) >= 0n);
  check("live route booleans", typeof status.routes.feeRoutePaused === "boolean" && typeof status.routes.stockRoutePaused === "boolean");
  const page = await inventoryPage(0n, 1n);
  check("live FIFO page decodes", Array.isArray(page.values) && page.values.length <= 1);
  equal("live release pin", DEPLOYMENT.release.commit, "2bbf9e3");
}

const failed = results.filter((result) => !result.pass);
for (const result of results) {
  console.error(`${result.pass ? "PASS" : "FAIL"}  ${result.name}${result.detail ? `  (${result.detail})` : ""}`);
}
console.log(JSON.stringify({ ok: failed.length === 0, checks: results.length, failed: failed.map((result) => result.name) }));
process.exitCode = failed.length === 0 ? 0 : 1;
