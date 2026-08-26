#!/usr/bin/env node

// End-to-end CLI regression harness for the live Punk Town Base deployment.
//
// This test forks Base with base-anvil, impersonates a known EOA at the pinned
// block, and exercises the exact unsigned flow Bankr uses:
// planner -> context-bound calldata inspection -> send -> receipt inspection.
// It never signs, never logs BASE_RPC_URL, and terminates only the child process
// it spawned.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { keccak256, selector } from "./lib/keccak256.mjs";

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = resolve(SKILL_DIR, "scripts/punktown.mjs");
const FORK_BLOCK = 50_477_817;
const CHAIN_ID = 8453;
const FORK_WALLET = "0x702ba46435D1E55B18440100BC81EB055574875e";
const BAES = "0xa9F6d9EcA1F803854A13CECad0f21d43e007DB07";
const PUNKS = "0xDC1C20Df3F8EDeDF1466399C5d5D17d864bD3F0f";
const WETH = "0x4200000000000000000000000000000000000006";
const BANKR_NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const PUNK_AMM = "0x555c246d004D2F24b5BaDDd186Fc773eB6fb8445";
const LOCK_VAULT = "0x69a60eae4Af0cAF965472f1268C723B1d60bcbE9";
const STOCK_LOCK = "0x4570F784d35ab06a0FA22F42bb6329fAA998a6BA";
const MUTATION_RECIPIENT = "0x000000000000000000000000000000000000bEEF";
const ALT_RECIPIENT = "0x000000000000000000000000000000000000cafE";
const ERC8021_MARKER = "80218021802180218021802180218021";
const archiveRpc = process.env.BASE_RPC_URL;
const baseAnvilBin = process.env.BASE_ANVIL_BIN || "base-anvil";
const baseForgeBin = process.env.BASE_FORGE_BIN || "base-forge";

let localRpc = null;
let anvil = null;
let anvilDiagnostics = "";
let rpcId = 1;
let checkCount = 0;
const failures = [];

function redact(value) {
  let text = String(value ?? "");
  if (archiveRpc) text = text.split(archiveRpc).join("[REDACTED_BASE_RPC_URL]");
  return text.replace(/https?:\/\/[^\s"']+/gi, (url) =>
    /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/i.test(url)
      ? url
      : "[REDACTED_RPC_URL]");
}

function detail(value) {
  const rendered = typeof value === "string" ? value : JSON.stringify(value);
  return redact(rendered.length > 600 ? `${rendered.slice(0, 600)}…` : rendered);
}

function pass(name, value = null) {
  checkCount += 1;
  console.log(`PASS  ${name}${value === null ? "" : `  (${detail(value)})`}`);
}

function assert(name, condition, value = null) {
  if (!condition) throw new Error(`${name}${value === null ? "" : `: ${detail(value)}`}`);
  pass(name, value);
}

function hexQuantity(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function normalizeAddress(value) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`invalid address: ${value}`);
  }
  return value.toLowerCase();
}

function wordAddress(address) {
  return normalizeAddress(address).slice(2).padStart(64, "0");
}

function wordUint(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

function rawAmount(value, decimals = 18) {
  const [whole, fraction = ""] = String(value).split(".");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction) || fraction.length > decimals) {
    throw new Error(`invalid decimal amount: ${value}`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals)
    + BigInt((fraction || "0").padEnd(decimals, "0"));
}

function humanAmount(raw, decimals) {
  const value = BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function encodeErc20Transfer(recipient, amount) {
  return `0xa9059cbb${wordAddress(recipient)}${wordUint(amount)}`;
}

function encodeErc20Approve(spender, amount) {
  return `0x095ea7b3${wordAddress(spender)}${wordUint(amount)}`;
}

function encodePunkTransfer(source, recipient, tokenId) {
  return `0x23b872dd${wordAddress(source)}${wordAddress(recipient)}${wordUint(tokenId)}`;
}

function flipLastNibble(hex) {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]+$/.test(hex)) throw new Error("cannot mutate non-hex value");
  const last = hex.at(-1).toLowerCase() === "0" ? "1" : "0";
  return `${hex.slice(0, -1)}${last}`;
}

function utf8Hex(value) {
  return `0x${Buffer.from(value, "utf8").toString("hex")}`;
}

function withErc8021(calldata, builderCode = "punktown_bankr") {
  const codeHex = Buffer.from(builderCode, "utf8").toString("hex");
  const length = Buffer.byteLength(builderCode, "utf8");
  if (length < 1 || length > 255) throw new Error("invalid ERC-8021 builder code length");
  return `${calldata}${codeHex}${length.toString(16).padStart(2, "0")}00${ERC8021_MARKER}`;
}

async function randomPort() {
  const server = createServer();
  server.unref();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  if (!port) throw new Error("failed to allocate a local port");
  return port;
}

async function rpc(method, params = []) {
  if (!localRpc) throw new Error("local fork RPC is not initialized");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(localRpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`local RPC HTTP ${response.status} for ${method}`);
    const body = await response.json();
    if (body.error) throw new Error(`local RPC ${method} failed (${body.error.code}): ${redact(body.error.message)}`);
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForFork() {
  let lastError = new Error("base-anvil did not answer");
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (anvil?.exitCode !== null) {
      throw new Error(`base-anvil exited before readiness (code ${anvil?.exitCode}): ${redact(anvilDiagnostics)}`);
    }
    try {
      const chain = Number(BigInt(await rpc("eth_chainId")));
      if (chain === CHAIN_ID) return;
      lastError = new Error(`unexpected local chain id ${chain}`);
    } catch (error) {
      lastError = error;
    }
    await delay(125);
  }
  throw new Error(`base-anvil readiness timeout: ${redact(lastError.message)} ${redact(anvilDiagnostics)}`);
}

async function startFork() {
  if (!archiveRpc) throw new Error("BASE_RPC_URL must be set to an archive-capable Base RPC; its value is never logged");
  const port = await randomPort();
  localRpc = `http://127.0.0.1:${port}`;
  anvil = spawn(baseAnvilBin, [
    "--fork-url", archiveRpc,
    "--fork-block-number", String(FORK_BLOCK),
    "--chain-id", String(CHAIN_ID),
    "--auto-impersonate",
    "--no-storage-caching",
    "--host", "127.0.0.1",
    "--port", String(port),
    "--quiet",
  ], {
    cwd: SKILL_DIR,
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = (chunk) => {
    anvilDiagnostics = `${anvilDiagnostics}${chunk.toString("utf8")}`.slice(-8_000);
  };
  anvil.stdout.on("data", capture);
  anvil.stderr.on("data", capture);
  anvil.once("error", capture);
  await waitForFork();
}

async function stopFork() {
  const child = anvil;
  anvil = null;
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    once(child, "exit").then(() => true),
    delay(3_000).then(() => false),
  ]);
  if (!exited && child.exitCode === null) {
    child.kill("SIGKILL");
    await Promise.race([once(child, "exit"), delay(2_000)]);
  }
}

async function compileSwapReceiptFixture() {
  const result = await runProcess(baseForgeBin, ["inspect", "BankrSwapReceiptFixture", "bytecode"], {
    cwd: SKILL_DIR,
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.code !== 0) {
    throw new Error(`failed to compile BankrSwapReceiptFixture: ${redact(result.stderr || result.stdout)}`);
  }
  const bytecode = result.stdout.match(/0x[0-9a-fA-F]+/g)?.at(-1);
  if (!bytecode || bytecode.length < 4) throw new Error("base-forge emitted no fixture bytecode");
  return bytecode;
}

async function deploySwapReceiptFixture(bytecode) {
  const hash = await rpc("eth_sendTransaction", [{
    from: FORK_WALLET,
    data: bytecode,
    value: "0x0",
    gas: "0x989680",
  }]);
  const receipt = await waitForReceipt(hash);
  assert("swap receipt fixture deployed", BigInt(receipt.status) === 1n && Boolean(receipt.contractAddress), receipt);
  return normalizeAddress(receipt.contractAddress);
}

function runProcess(executable, args, options) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, options);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 2_000_000) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 2_000_000) child.kill("SIGKILL");
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolveRun({ code, signal, stdout, stderr }));
  });
}

async function cli(args) {
  const result = await runProcess(process.execPath, [CLI, ...args], {
    cwd: SKILL_DIR,
    env: {
      ...process.env,
      PUNKTOWN_RPC_URL: localRpc,
      BASE_RPC_URL: localRpc,
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let json;
  try {
    json = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error(`CLI emitted non-JSON output (exit ${result.code}, signal ${result.signal ?? "none"}): stdout=${redact(result.stdout)} stderr=${redact(result.stderr)}`);
  }
  return { ...result, json };
}

async function expectCliSuccess(name, args) {
  const result = await cli(args);
  assert(`${name} exits 0`, result.code === 0, { code: result.code, json: result.json, stderr: result.stderr });
  assert(`${name} reports ok`, result.json.ok === true, result.json);
  return result.json;
}

async function expectCliFailure(name, args, expectedGate = null) {
  const result = await cli(args);
  assert(`${name} exits 1`, result.code === 1, { code: result.code, json: result.json, stderr: result.stderr });
  assert(`${name} reports not ok`, result.json.ok === false, result.json);
  if (expectedGate) assert(`${name} gate`, result.json.gate === expectedGate, result.json.gate);
  return result.json;
}

function inspectCalldataArgs(plan, overrides = {}) {
  const tx = plan.txs[0];
  return [
    "inspect-calldata",
    "--wallet", overrides.wallet ?? plan.wallet,
    "--to", overrides.to ?? tx.to,
    "--data", overrides.data ?? tx.data,
    "--chain-id", String(overrides.chainId ?? tx.chainId),
    "--value", String(overrides.value ?? tx.value),
    "--context", overrides.context ?? plan.inspectionContextHex,
    "--plan-key", overrides.planKey ?? plan.inspectionKey,
  ];
}

function inspectTxArgs(plan, hash, overrides = {}) {
  return [
    "inspect-tx",
    "--wallet", overrides.wallet ?? plan.wallet,
    "--tx", hash,
    "--context", overrides.context ?? plan.inspectionContextHex,
    "--plan-key", overrides.planKey ?? plan.inspectionKey,
  ];
}

async function send(tx, dataOverride = null, from = FORK_WALLET) {
  return await rpc("eth_sendTransaction", [{
    from,
    to: tx.to,
    data: dataOverride ?? tx.data,
    value: hexQuantity(tx.value),
    gas: "0x989680",
  }]);
}

async function mineRaw({ from, to, data = "0x", value = 0n, gas = "0x989680" }, label) {
  const hash = await rpc("eth_sendTransaction", [{ from, to, data, value: hexQuantity(value), gas }]);
  const receipt = await waitForReceipt(hash);
  assert(`${label} mined`, BigInt(receipt.status) === 1n, { hash, status: receipt.status });
  return { hash, receipt };
}

async function waitForReceipt(hash, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await rpc("eth_getTransactionReceipt", [hash]);
    if (receipt) return receipt;
    await delay(100);
  }
  throw new Error(`receipt timeout for ${hash}`);
}

async function minePlan(plan, { attributed = false, label = "planned transaction" } = {}) {
  const tx = plan.txs[0];
  const inspection = await expectCliSuccess(`${label} calldata inspection`, inspectCalldataArgs(plan));
  assert(`${label} inspection key round-trip`, inspection.inspectionKey === plan.inspectionKey, inspection.inspectionKey);
  const submittedData = attributed ? withErc8021(tx.data) : tx.data;
  const hash = await send(tx, submittedData, plan.wallet);
  const receipt = await waitForReceipt(hash);
  assert(`${label} mined successfully`, BigInt(receipt.status) === 1n, receipt.status);
  const proof = await expectCliSuccess(`${label} receipt inspection`, inspectTxArgs(plan, hash));
  assert(`${label} receipt is proven`, proof.state === "confirmed-and-receipt-proven", proof.state);
  if (attributed) {
    assert(`${label} ERC-8021 attribution decoded`, proof.attribution?.standard === "ERC-8021", proof.attribution);
    assert(`${label} ERC-8021 builder code preserved`, proof.attribution?.codes?.[0] === "punktown_bankr", proof.attribution);
  }
  return { hash, receipt, proof };
}

async function executePlannerFlow(label, plannerArgs, initialPlan = null) {
  let plan = initialPlan ?? await expectCliSuccess(`${label} plan`, plannerArgs);
  assert(`${label} planner emits one transaction`, plan.txs?.length === 1, plan.txs?.length);
  const confirmationKey = plan.confirmationKey;
  const inspectionContextHex = plan.inspectionContextHex;
  let approvalCount = 0;
  while (plan.phase === "approval") {
    approvalCount += 1;
    if (approvalCount > 4) throw new Error(`${label} exceeded four serial approval phases`);
    await minePlan(plan, { label: `${label} approval ${approvalCount}` });
    const next = await expectCliSuccess(`${label} fresh re-plan ${approvalCount}`, plannerArgs);
    assert(`${label} confirmation continuity ${approvalCount}`, next.confirmationKey === confirmationKey, {
      before: confirmationKey,
      after: next.confirmationKey,
    });
    assert(`${label} context continuity ${approvalCount}`, next.inspectionContextHex === inspectionContextHex, {
      before: inspectionContextHex,
      after: next.inspectionContextHex,
    });
    plan = next;
  }
  assert(`${label} reaches action`, plan.phase === "action", plan.phase);
  const result = await minePlan(plan, { label: `${label} action` });
  return { plan, result, approvalCount, confirmationKey, inspectionContextHex };
}

function encodedWord(data, index) {
  const hex = String(data).replace(/^0x/, "");
  const word = hex.slice(index * 64, (index + 1) * 64);
  if (word.length !== 64) throw new Error(`missing ABI word ${index}`);
  return word;
}

async function rawCall(to, data, block = "latest") {
  return await rpc("eth_call", [{ to, data }, block]);
}

async function currentCredits(wallet) {
  const count = BigInt(await rawCall(STOCK_LOCK, "0x98811973"));
  const credits = [];
  for (let index = 0n; index < count; index += 1n) {
    const tokenData = await rawCall(STOCK_LOCK, `0x37a15503${wordUint(index)}`);
    const token = normalizeAddress(`0x${tokenData.slice(-40)}`);
    const amount = BigInt(await rawCall(
      STOCK_LOCK,
      `0x0c2c6722${wordAddress(token)}${wordAddress(wallet)}`,
    ));
    const decimals = Number(BigInt(await rawCall(token, "0x313ce567")));
    if (amount > 0n) credits.push({ token, amount: String(amount), decimals });
  }
  return credits;
}

async function positionFromOpened(flow, tokenId, wallet, label) {
  const opened = flow.result.proof.recognizedEvents.find((event) => event.name === "PositionOpened");
  assert(`${label} PositionOpened event found`, Boolean(opened), flow.result.proof.recognizedEvents);
  const positionId = BigInt(opened.indexed[0]);
  const encoded = await rawCall(LOCK_VAULT, `0x99fbab88${wordUint(positionId)}`);
  const position = {
    id: String(positionId),
    tokenId: String(BigInt(`0x${encodedWord(encoded, 0)}`)),
    depositor: normalizeAddress(`0x${encodedWord(encoded, 1).slice(-40)}`),
    beneficiary: normalizeAddress(`0x${encodedWord(encoded, 2).slice(-40)}`),
    active: BigInt(`0x${encodedWord(encoded, 5)}`) === 1n,
  };
  assert(`${label} direct position postcondition`,
    position.tokenId === String(tokenId)
      && position.depositor === normalizeAddress(wallet)
      && position.beneficiary === normalizeAddress(wallet)
      && position.active,
    position,
  );
  return position;
}

async function executeConversions(wallet, count, amountWeth, label) {
  const conversions = [];
  for (let index = 0; index < count; index += 1) {
    if (index > 0) {
      await rpc("evm_mine");
      pass(`${label} ${index + 1}/${count} advanced beyond prior conversion block`);
    }
    conversions.push(await executePlannerFlow(
      `${label} ${index + 1}/${count}`,
      ["plan-convert", "--wallet", wallet, "--amount-weth", amountWeth],
    ));
  }
  return conversions;
}

async function settlePositions(wallet, positionIds, label) {
  const results = [];
  for (const positionId of positionIds) {
    results.push(await executePlannerFlow(`${label} position ${positionId}`, [
      "plan-settle", "--wallet", wallet, "--position-id", String(positionId),
    ]));
  }
  return results;
}

async function buyPunk(wallet, label, { join = false } = {}) {
  const args = ["plan-buy", "--wallet", wallet, "--slippage-bps", "300", ...(join ? ["--join"] : [])];
  const initial = await expectCliSuccess(`${label} initial plan`, args);
  const tokenId = initial.terms.tokenId;
  const flow = await executePlannerFlow(label, args, initial);
  assert(`${label} ownership`, await ownerOf(tokenId) === normalizeAddress(wallet), { tokenId });
  if (join) {
    assert(`${label} asks for Crew tier only after buy`, flow.plan.afterSuccess?.action === "ask-crew-tier", flow.plan.afterSuccess);
    assert(`${label} exposes all five tier choices`, flow.plan.afterSuccess?.choices?.length === 5, flow.plan.afterSuccess?.choices);
  }
  return { tokenId, ...flow };
}

async function stakePunk(wallet, tokenId, label) {
  const flow = await executePlannerFlow(label, [
    "plan-stake", "--wallet", wallet, "--token-id", String(tokenId), "--tier", "0",
  ]);
  const position = await positionFromOpened(flow, tokenId, wallet, label);
  return { position, ...flow };
}

async function runComprehensiveFlows(boughtTokenId, pendingPlan, pendingHash) {
  if (checkCount !== 71) throw new Error(`legacy regression expected 71 checks before expansion, saw ${checkCount}`);
  pass("legacy planner/inspector regression remains intact", checkCount);

  const pendingMined = await expectCliSuccess(
    "formerly pending approval mined proof",
    inspectTxArgs(pendingPlan, pendingHash),
  );
  assert(
    "formerly pending receipt is proven",
    pendingMined.state === "confirmed-and-receipt-proven",
    pendingMined.state,
  );

  await rpc("anvil_setBalance", [MUTATION_RECIPIENT, hexQuantity(100n * 10n ** 18n)]);
  await rpc("anvil_impersonateAccount", [MUTATION_RECIPIENT]);
  await rpc("anvil_setBalance", [ALT_RECIPIENT, hexQuantity(10n * 10n ** 18n)]);
  await rpc("anvil_impersonateAccount", [ALT_RECIPIENT]);
  assert("isolated E2E wallet is code-free", await rpc("eth_getCode", [MUTATION_RECIPIENT, "latest"]) === "0x");

  const joinArgs = [
    "plan-buy", "--wallet", MUTATION_RECIPIENT, "--slippage-bps", "300",
    "--acquisition-slippage-bps", "300", "--join",
  ];
  const unfundedJoin = await expectCliSuccess("unfunded natural join plan", joinArgs);
  assert("unfunded join enters Bankr BAES acquisition", unfundedJoin.phase === "acquire-baes", unfundedJoin.phase);
  assert("acquisition emits no raw transaction", Array.isArray(unfundedJoin.txs) && unfundedJoin.txs.length === 0, unfundedJoin.txs);
  assert(
    "acquisition binds the pinned BAES output",
    unfundedJoin.acquisition?.operation === "bankr-native-same-chain-exact-output"
      && normalizeAddress(unfundedJoin.acquisition.outputToken.address) === normalizeAddress(BAES)
      && BigInt(unfundedJoin.acquisition.requestedOutput) === rawAmount("6600000"),
    unfundedJoin.acquisition,
  );
  assert("natural join emits a distinct acquisition request binding", /^0x[0-9a-f]{64}$/.test(unfundedJoin.acquisitionRequestKey), unfundedJoin.acquisitionRequestKey);
  assert("natural join emits canonical acquisition request context", /^0x(?:[0-9a-f]{2})+$/.test(unfundedJoin.acquisitionRequestContextHex), unfundedJoin.acquisitionRequestContextHex);
  const acquisitionBindArgs = [
    "bind-acquisition", "--wallet", MUTATION_RECIPIENT,
    "--request-context", unfundedJoin.acquisitionRequestContextHex,
    "--request-key", unfundedJoin.acquisitionRequestKey,
    "--mode", "wallet-api-exact-input",
    "--source-token", WETH, "--source-symbol", "WETH", "--source-decimals", "18",
    "--source-amount", "0.01", "--min-baes-out", "6600000",
    "--idempotency-key", "123e4567-e89b-42d3-a456-426614174000",
    "--quote-id", "fork-quote-1", "--fee-bps", "100", "--price-impact-bps", "7",
    "--swap-impact-bps", "5", "--max-price-impact-bps", "500", "--network-costs-usd", "0.01",
  ];
  const boundAcquisition = await expectCliSuccess("structured Bankr fallback quote binding", acquisitionBindArgs);
  assert("fallback quote reaches acquisition authorization", boundAcquisition.phase === "acquisition-authorization", boundAcquisition.phase);
  assert("authorization binds exact source token", normalizeAddress(boundAcquisition.execution.request.fromToken) === normalizeAddress(WETH), boundAcquisition.execution);
  assert("authorization binds BAES minBuyAmount", boundAcquisition.execution.request.minBuyAmount === "6600000", boundAcquisition.execution);
  assert(
    "Wallet API request emits numeric slippageBps",
    typeof boundAcquisition.execution.request.slippageBps === "number"
      && boundAcquisition.execution.request.slippageBps === 300,
    boundAcquisition.execution.request,
  );
  assert(
    "fallback confirmation names the canonical source address",
    boundAcquisition.report.includes(`WETH (${normalizeAddress(WETH)})`),
    boundAcquisition.report,
  );
  assert(
    "fallback confirmation displays max price-impact protection",
    boundAcquisition.report.includes("wallet max price-impact protection 500 bps"),
    boundAcquisition.report,
  );
  assert("authorization emits a distinct confirmation key", /^0x[0-9a-f]{64}$/.test(boundAcquisition.acquisitionAuthorizationKey), boundAcquisition.acquisitionAuthorizationKey);
  assert("authorization emits canonical verification context", /^0x(?:[0-9a-f]{2})+$/.test(boundAcquisition.authorizationContextHex), boundAcquisition.authorizationContextHex);
  const nativeAcquisition = await expectCliSuccess("Bankr native exact-output preview binding", [
    "bind-acquisition", "--wallet", MUTATION_RECIPIENT,
    "--request-context", unfundedJoin.acquisitionRequestContextHex,
    "--request-key", unfundedJoin.acquisitionRequestKey,
    "--mode", "bankr-native-exact-output",
    "--source-token", BANKR_NATIVE_TOKEN, "--source-symbol", "ETH", "--source-decimals", "18",
    "--source-amount", "0.011", "--min-baes-out", "6600000",
    "--quote-id", "fork-native-quote-1", "--fee-bps", "100", "--price-impact-bps", "7",
  ]);
  assert("native authorization binds maximum source spend", nativeAcquisition.authorizationTerms.quote.sourceAmountMode === "maximum-input", nativeAcquisition.authorizationTerms.quote);
  assert("native authorization binds exact BAES intent", nativeAcquisition.execution.intent.exactOutput === "6600000", nativeAcquisition.execution);
  assert(
    "native Bankr intent emits numeric slippageBps",
    typeof nativeAcquisition.execution.intent.slippageBps === "number"
      && nativeAcquisition.execution.intent.slippageBps === 300,
    nativeAcquisition.execution.intent,
  );
  assert(
    "native confirmation names the canonical source address",
    nativeAcquisition.report.includes(`ETH (${normalizeAddress(BANKR_NATIVE_TOKEN)})`),
    nativeAcquisition.report,
  );
  assert("native authorization canonicalizes Bankr ETH sentinel", nativeAcquisition.authorizationTerms.quote.sourceToken === normalizeAddress(BANKR_NATIVE_TOKEN), nativeAcquisition.authorizationTerms.quote);
  const zeroNativeAcquisition = await expectCliSuccess("zero-address native ETH preview binding", [
    "bind-acquisition", "--wallet", MUTATION_RECIPIENT,
    "--request-context", unfundedJoin.acquisitionRequestContextHex,
    "--request-key", unfundedJoin.acquisitionRequestKey,
    "--mode", "bankr-native-exact-output",
    "--source-token", ZERO_ADDRESS, "--source-symbol", "ETH", "--source-decimals", "18",
    "--source-amount", "0.011", "--min-baes-out", "6600000",
    "--quote-id", "fork-native-quote-1", "--fee-bps", "100", "--price-impact-bps", "7",
  ]);
  assert("Bankr ETH sentinel and zero address bind identically", zeroNativeAcquisition.acquisitionAuthorizationKey === nativeAcquisition.acquisitionAuthorizationKey, {
    sentinel: nativeAcquisition.acquisitionAuthorizationKey,
    zero: zeroNativeAcquisition.acquisitionAuthorizationKey,
  });
  await expectCliFailure("native exact-output preview cannot raise the receipt floor", [
    "bind-acquisition", "--wallet", MUTATION_RECIPIENT,
    "--request-context", unfundedJoin.acquisitionRequestContextHex,
    "--request-key", unfundedJoin.acquisitionRequestKey,
    "--mode", "bankr-native-exact-output",
    "--source-token", BANKR_NATIVE_TOKEN, "--source-symbol", "ETH", "--source-decimals", "18",
    "--source-amount", "0.011", "--min-baes-out", "6600001",
  ], "acquisition-quote");
  assert("native and fallback economics have different keys", nativeAcquisition.acquisitionAuthorizationKey !== boundAcquisition.acquisitionAuthorizationKey, {
    native: nativeAcquisition.acquisitionAuthorizationKey,
    fallback: boundAcquisition.acquisitionAuthorizationKey,
  });
  await expectCliFailure(
    "fallback quote below the BAES deficit",
    acquisitionBindArgs.map((value, index, values) => values[index - 1] === "--min-baes-out" ? "6599999" : value),
    "acquisition-quote",
  );
  await expectCliFailure(
    "acquisition rejects an unverified ERC-20 source",
    acquisitionBindArgs.map((value, index, values) => values[index - 1] === "--source-token" ? ALT_RECIPIENT : value),
    "acquisition-quote",
  );
  const joinConfirmationKey = unfundedJoin.confirmationKey;
  const joinTokenId = unfundedJoin.terms.tokenId;

  await mineRaw({
    from: MUTATION_RECIPIENT,
    to: WETH,
    data: "0xd0e30db0",
    value: rawAmount("0.2"),
  }, "isolated wallet WETH wrapping");
  const swapFixture = await deploySwapReceiptFixture(await compileSwapReceiptFixture());
  await mineRaw({
    from: FORK_WALLET,
    to: BAES,
    data: encodeErc20Transfer(swapFixture, rawAmount("33000000")),
  }, "swap receipt fixture BAES funding");
  await mineRaw({
    from: MUTATION_RECIPIENT,
    to: WETH,
    data: encodeErc20Approve(swapFixture, rawAmount("0.01")),
  }, "swap receipt fixture WETH approval");
  const fixtureSwapData = `${selector("swap(address,address,uint256,uint256)").slice(2)}`
    + `${wordAddress(WETH)}${wordAddress(BAES)}${wordUint(rawAmount("0.01"))}${wordUint(rawAmount("6600000"))}`;
  const acquisitionResult = await mineRaw({
    from: MUTATION_RECIPIENT,
    to: swapFixture,
    data: `0x${fixtureSwapData}`,
  }, "Bankr-managed swap receipt fixture");
  const verifiedAcquisition = await expectCliSuccess("Bankr acquisition receipt verification", [
    "verify-acquisition", "--wallet", MUTATION_RECIPIENT,
    "--tx", acquisitionResult.hash,
    "--authorization-context", boundAcquisition.authorizationContextHex,
    "--authorization-key", boundAcquisition.acquisitionAuthorizationKey,
  ]);
  assert("acquisition proof binds exact WETH debit", BigInt(verifiedAcquisition.sourceAmountObserved) === rawAmount("0.01"), verifiedAcquisition);
  assert("acquisition proof labels ERC-20 net debit", verifiedAcquisition.sourceObservation === "erc20-net-transfer-debit", verifiedAcquisition);
  assert("acquisition proof binds minimum BAES receipt", BigInt(verifiedAcquisition.baesReceived) === rawAmount("6600000"), verifiedAcquisition);
  const unsupportedModeContext = structuredClone(boundAcquisition.authorizationContext);
  unsupportedModeContext.terms.mode = "unsupported-acquisition-mode";
  const unsupportedModeKey = keccak256(JSON.stringify({
    chainId: CHAIN_ID,
    action: unsupportedModeContext.action,
    terms: unsupportedModeContext.terms,
  }));
  await expectCliFailure("acquisition verifier rejects a crafted unknown mode", [
    "verify-acquisition", "--wallet", MUTATION_RECIPIENT,
    "--tx", acquisitionResult.hash,
    "--authorization-context", utf8Hex(JSON.stringify(unsupportedModeContext)),
    "--authorization-key", unsupportedModeKey,
  ], "acquisition-binding");
  await mineRaw({
    from: MUTATION_RECIPIENT,
    to: WETH,
    data: encodeErc20Approve(swapFixture, rawAmount("0.01")),
  }, "self-transfer fixture WETH approval");
  await mineRaw({
    from: MUTATION_RECIPIENT,
    to: BAES,
    data: encodeErc20Approve(swapFixture, rawAmount("6600000")),
  }, "self-transfer fixture BAES approval");
  const fakeSelfSwapData = `${selector("fakeSwapSelf(address,address,uint256,uint256)").slice(2)}`
    + `${wordAddress(WETH)}${wordAddress(BAES)}${wordUint(rawAmount("0.01"))}${wordUint(rawAmount("6600000"))}`;
  const fakeSelfSwapResult = await mineRaw({
    from: MUTATION_RECIPIENT,
    to: swapFixture,
    data: `0x${fakeSelfSwapData}`,
  }, "self-transfer acquisition bypass fixture");
  await expectCliFailure("acquisition rejects source and BAES self-transfer receipts", [
    "verify-acquisition", "--wallet", MUTATION_RECIPIENT,
    "--tx", fakeSelfSwapResult.hash,
    "--authorization-context", boundAcquisition.authorizationContextHex,
    "--authorization-key", boundAcquisition.acquisitionAuthorizationKey,
  ], "acquisition-receipt");
  const nativeFixtureSwapData = `${selector("swapNative(address,uint256)").slice(2)}`
    + `${wordAddress(BAES)}${wordUint(rawAmount("6600000"))}`;
  const nativeAcquisitionResult = await mineRaw({
    from: MUTATION_RECIPIENT,
    to: swapFixture,
    data: `0x${nativeFixtureSwapData}`,
    value: rawAmount("0.011"),
  }, "Bankr native ETH swap receipt fixture");
  const verifiedNativeAcquisition = await expectCliSuccess("Bankr native ETH acquisition receipt verification", [
    "verify-acquisition", "--wallet", MUTATION_RECIPIENT,
    "--tx", nativeAcquisitionResult.hash,
    "--authorization-context", nativeAcquisition.authorizationContextHex,
    "--authorization-key", nativeAcquisition.acquisitionAuthorizationKey,
  ]);
  assert("native acquisition proof measures transaction value", BigInt(verifiedNativeAcquisition.sourceAmountObserved) === rawAmount("0.011"), verifiedNativeAcquisition);
  assert("native acquisition proof labels value sent", verifiedNativeAcquisition.sourceObservation === "native-transaction-value-sent", verifiedNativeAcquisition);
  assert("native acquisition proof binds minimum BAES receipt", BigInt(verifiedNativeAcquisition.baesReceived) === rawAmount("6600000"), verifiedNativeAcquisition);
  const overLimitNativeResult = await mineRaw({
    from: MUTATION_RECIPIENT,
    to: swapFixture,
    data: `0x${nativeFixtureSwapData}`,
    value: rawAmount("0.012"),
  }, "over-limit native ETH acquisition fixture");
  await expectCliFailure("native acquisition rejects value above confirmed maximum", [
    "verify-acquisition", "--wallet", MUTATION_RECIPIENT,
    "--tx", overLimitNativeResult.hash,
    "--authorization-context", nativeAcquisition.authorizationContextHex,
    "--authorization-key", nativeAcquisition.acquisitionAuthorizationKey,
  ], "acquisition-receipt");
  const wrongSignerNativeResult = await mineRaw({
    from: ALT_RECIPIENT,
    to: swapFixture,
    data: `0x${nativeFixtureSwapData}`,
    value: rawAmount("0.001"),
  }, "wrong-signer native ETH acquisition fixture");
  await expectCliFailure("native acquisition rejects a different signer", [
    "verify-acquisition", "--wallet", MUTATION_RECIPIENT,
    "--tx", wrongSignerNativeResult.hash,
    "--authorization-context", nativeAcquisition.authorizationContextHex,
    "--authorization-key", nativeAcquisition.acquisitionAuthorizationKey,
  ], "acquisition-receipt");
  const zeroValueData = `${selector("deliverOutput(address,uint256)").slice(2)}`
    + `${wordAddress(BAES)}${wordUint(rawAmount("6600000"))}`;
  const zeroValueNativeResult = await mineRaw({
    from: MUTATION_RECIPIENT,
    to: swapFixture,
    data: `0x${zeroValueData}`,
  }, "zero-value native acquisition fixture");
  await expectCliFailure("native acquisition rejects zero transaction value", [
    "verify-acquisition", "--wallet", MUTATION_RECIPIENT,
    "--tx", zeroValueNativeResult.hash,
    "--authorization-context", nativeAcquisition.authorizationContextHex,
    "--authorization-key", nativeAcquisition.acquisitionAuthorizationKey,
  ], "acquisition-receipt");
  const revertedNativeHash = await rpc("eth_sendTransaction", [{
    from: MUTATION_RECIPIENT,
    to: swapFixture,
    data: `0x${nativeFixtureSwapData}`,
    value: hexQuantity(rawAmount("0.001")),
    gas: "0x989680",
  }]);
  const revertedNativeReceipt = await waitForReceipt(revertedNativeHash);
  assert("reverted native acquisition fixture has failed receipt", BigInt(revertedNativeReceipt.status) === 0n, revertedNativeReceipt.status);
  await expectCliFailure("native acquisition rejects a reverted receipt", [
    "verify-acquisition", "--wallet", MUTATION_RECIPIENT,
    "--tx", revertedNativeHash,
    "--authorization-context", nativeAcquisition.authorizationContextHex,
    "--authorization-key", nativeAcquisition.acquisitionAuthorizationKey,
  ], "acquisition-receipt");
  const fundedJoin = await expectCliSuccess("funded natural join re-plan", [
    ...joinArgs,
    "--expected-token-id", String(joinTokenId),
  ]);
  assert("funded join advances to exact approval", fundedJoin.phase === "approval", fundedJoin.phase);
  assert("acquisition preserves final buy confirmation terms", fundedJoin.confirmationKey === joinConfirmationKey, {
    before: joinConfirmationKey,
    after: fundedJoin.confirmationKey,
  });
  assert("join intent remains bound after acquisition", fundedJoin.terms.joinCrew === true, fundedJoin.terms);
  await mineRaw({
    from: FORK_WALLET,
    to: BAES,
    data: encodeErc20Transfer(MUTATION_RECIPIENT, rawAmount("43400000")),
  }, "subsequent workflow BAES fixture funding");
  const sell = await executePlannerFlow("sell", [
    "plan-sell", "--wallet", MUTATION_RECIPIENT,
    "--token-id", String(boughtTokenId), "--slippage-bps", "300",
  ]);
  assert("sell used token-specific approval", sell.approvalCount === 1, sell.approvalCount);
  assert("sold punk returned to desk", await ownerOf(boughtTokenId) === normalizeAddress(PUNK_AMM));

  const firstBuy = await buyPunk(MUTATION_RECIPIENT, "first isolated buy", { join: true });
  const secondBuy = await buyPunk(MUTATION_RECIPIENT, "second isolated buy");

  const preStakeBalance = await tokenBalance(BAES, MUTATION_RECIPIENT);
  await mineRaw({
    from: MUTATION_RECIPIENT,
    to: BAES,
    data: encodeErc20Transfer(FORK_WALLET, preStakeBalance),
  }, "stake acquisition shortfall setup");
  const firstStakeArgs = [
    "plan-stake", "--wallet", MUTATION_RECIPIENT,
    "--token-id", String(firstBuy.tokenId), "--tier", "0",
  ];
  await mineRaw({
    from: MUTATION_RECIPIENT,
    to: PUNKS,
    data: encodePunkTransfer(MUTATION_RECIPIENT, ALT_RECIPIENT, firstBuy.tokenId),
  }, "stake ownership pre-acquisition gate setup");
  await expectCliFailure("unowned Punk never requests tier BAES", firstStakeArgs, "ownership");
  await mineRaw({
    from: ALT_RECIPIENT,
    to: PUNKS,
    data: encodePunkTransfer(ALT_RECIPIENT, MUTATION_RECIPIENT, firstBuy.tokenId),
  }, "stake ownership pre-acquisition gate restore");
  const unfundedStake = await expectCliSuccess("unfunded Crew stake plan", firstStakeArgs);
  assert("unfunded stake enters Bankr BAES acquisition", unfundedStake.phase === "acquire-baes", unfundedStake.phase);
  assert("Signal acquisition targets the exact tier deficit", BigInt(unfundedStake.acquisition.requestedOutput) === rawAmount("600000"), unfundedStake.acquisition);
  await mineRaw({
    from: FORK_WALLET,
    to: BAES,
    data: encodeErc20Transfer(MUTATION_RECIPIENT, rawAmount("600000")),
  }, "stake acquisition completion setup");
  const fundedStake = await expectCliSuccess("funded Crew stake re-plan", firstStakeArgs);
  assert("funded stake advances to approval", fundedStake.phase === "approval", fundedStake.phase);
  assert("stake acquisition preserves tier confirmation terms", fundedStake.confirmationKey === unfundedStake.confirmationKey, {
    before: unfundedStake.confirmationKey,
    after: fundedStake.confirmationKey,
  });
  const firstStakeFlow = await executePlannerFlow("first stake", firstStakeArgs, fundedStake);
  const firstStake = {
    position: await positionFromOpened(firstStakeFlow, firstBuy.tokenId, MUTATION_RECIPIENT, "first stake"),
    ...firstStakeFlow,
  };

  await mineRaw({
    from: FORK_WALLET,
    to: BAES,
    data: encodeErc20Transfer(MUTATION_RECIPIENT, rawAmount("20000000")),
  }, "remaining workflow BAES funding");
  const secondStake = await stakePunk(MUTATION_RECIPIENT, secondBuy.tokenId, "second stake");
  assert("first stake used exact BAES then token approval", firstStake.approvalCount === 2, firstStake.approvalCount);
  assert("second stake used exact BAES then token approval", secondStake.approvalCount === 2, secondStake.approvalCount);

  const firstPositionId = firstStake.position.id;
  const secondPositionId = secondStake.position.id;
  const preUpgradeBalance = await tokenBalance(BAES, MUTATION_RECIPIENT);
  await mineRaw({
    from: MUTATION_RECIPIENT,
    to: BAES,
    data: encodeErc20Transfer(FORK_WALLET, preUpgradeBalance),
  }, "upgrade acquisition shortfall setup");
  const upgradeArgs = [
    "plan-upgrade", "--wallet", MUTATION_RECIPIENT,
    "--position-id", String(firstPositionId), "--new-tier", "1",
  ];
  const unfundedUpgrade = await expectCliSuccess("unfunded Crew upgrade plan", upgradeArgs);
  assert("unfunded upgrade enters Bankr BAES acquisition", unfundedUpgrade.phase === "acquire-baes", unfundedUpgrade.phase);
  assert("upgrade acquisition targets exact tier delta", BigInt(unfundedUpgrade.acquisition.requestedOutput) === rawAmount("900000"), unfundedUpgrade.acquisition);
  await mineRaw({
    from: FORK_WALLET,
    to: BAES,
    data: encodeErc20Transfer(MUTATION_RECIPIENT, rawAmount("900000")),
  }, "upgrade acquisition completion setup");
  const fundedUpgrade = await expectCliSuccess("funded Crew upgrade re-plan", upgradeArgs);
  assert("upgrade acquisition preserves confirmation terms", fundedUpgrade.confirmationKey === unfundedUpgrade.confirmationKey, {
    before: unfundedUpgrade.confirmationKey,
    after: fundedUpgrade.confirmationKey,
  });
  const upgrade = await executePlannerFlow("upgrade", upgradeArgs, fundedUpgrade);
  assert("upgrade used one exact BAES approval", upgrade.approvalCount === 1, upgrade.approvalCount);

  await mineRaw({
    from: FORK_WALLET,
    to: BAES,
    data: encodeErc20Transfer(MUTATION_RECIPIENT, rawAmount("20000000")),
  }, "post-upgrade workflow BAES funding");

  await mineRaw({
    from: MUTATION_RECIPIENT,
    to: BAES,
    data: encodeErc20Approve(PUNK_AMM, 123n),
  }, "mismatched PunkAMM allowance setup");
  const reserveArgs = [
    "plan-reserve-topup", "--wallet", MUTATION_RECIPIENT, "--amount-baes", "1",
  ];
  const reserveInitial = await expectCliSuccess("reserve top-up reset plan", reserveArgs);
  assert(
    "reserve top-up first resets mismatched allowance",
    reserveInitial.phase === "approval" && BigInt(`0x${reserveInitial.txs[0].data.slice(-64)}`) === 0n,
    reserveInitial,
  );
  const reserve = await executePlannerFlow("reserve top-up", reserveArgs, reserveInitial);
  assert("reserve top-up used reset then exact approval", reserve.approvalCount === 2, reserve.approvalCount);

  await expectCliFailure(
    "zero WETH source id rejection",
    [
      "plan-weth-topup", "--wallet", MUTATION_RECIPIENT, "--amount-weth", "0.1",
      "--source-id", `0x${"0".repeat(64)}`,
    ],
    "args",
  );
  const wethTopup = await executePlannerFlow("WETH top-up", [
    "plan-weth-topup", "--wallet", MUTATION_RECIPIENT,
    "--amount-weth", "0.1", "--source-id", "BANKR-E2E",
  ]);
  assert("WETH top-up used one exact approval", wethTopup.approvalCount === 1, wethTopup.approvalCount);

  await executePlannerFlow("bootstrap poke", ["plan-poke-bootstrap", "--wallet", MUTATION_RECIPIENT]);
  await executeConversions(MUTATION_RECIPIENT, 4, "0.01", "initial reward conversion");

  await executePlannerFlow("single-position settle", [
    "plan-settle", "--wallet", MUTATION_RECIPIENT, "--position-id", String(firstPositionId),
  ]);
  await settlePositions(MUTATION_RECIPIENT, [secondPositionId], "remaining reward settle");

  let credits = await currentCredits(MUTATION_RECIPIENT);
  assert("four conversions produced four claimable stocks", credits.length === 4, credits);

  await executePlannerFlow("strict claim", [
    "plan-claim", "--wallet", MUTATION_RECIPIENT, "--token", credits[0].token,
  ]);
  await executePlannerFlow("strict claimTo", [
    "plan-claim", "--wallet", MUTATION_RECIPIENT, "--token", credits[1].token,
    "--recipient", ALT_RECIPIENT,
  ]);
  await executePlannerFlow("strict batch claim", [
    "plan-claim-batch", "--wallet", MUTATION_RECIPIENT,
    "--tokens", credits.slice(2).map((entry) => entry.token).join(","),
    "--recipient", MUTATION_RECIPIENT,
  ]);
  credits = await currentCredits(MUTATION_RECIPIENT);
  assert("strict claim variants cleared all credits", credits.length === 0, credits);

  await executeConversions(MUTATION_RECIPIENT, 1, "0.01", "claim-all reward conversion");
  await settlePositions(
    MUTATION_RECIPIENT,
    [firstPositionId, secondPositionId],
    "claim-all reward settlement",
  );
  await executePlannerFlow("claim-all step", [
    "plan-claim-all", "--wallet", MUTATION_RECIPIENT, "--recipient", MUTATION_RECIPIENT,
  ]);

  await executeConversions(MUTATION_RECIPIENT, 1, "0.01", "lossy reward conversion");
  await settlePositions(
    MUTATION_RECIPIENT,
    [firstPositionId, secondPositionId],
    "lossy reward settlement",
  );
  credits = await currentCredits(MUTATION_RECIPIENT);
  assert("lossy claim has current credit", credits.length === 1, credits);
  const lossyCredit = credits[0];
  await executePlannerFlow("lossy claim", [
    "plan-claim-lossy", "--wallet", MUTATION_RECIPIENT,
    "--token", lossyCredit.token,
    "--min-received", humanAmount(1n, lossyCredit.decimals),
    "--recipient", MUTATION_RECIPIENT,
  ]);

  await executeConversions(MUTATION_RECIPIENT, 1, "0.01", "forfeit reward conversion");
  await settlePositions(
    MUTATION_RECIPIENT,
    [firstPositionId, secondPositionId],
    "forfeit reward settlement",
  );
  credits = await currentCredits(MUTATION_RECIPIENT);
  assert("forfeit has current credit", credits.length === 1, credits);
  const forfeitCredit = credits[0];
  await executePlannerFlow("credit forfeit", [
    "plan-forfeit", "--wallet", MUTATION_RECIPIENT,
    "--token", forfeitCredit.token,
    "--amount", humanAmount(forfeitCredit.amount, forfeitCredit.decimals),
  ]);

  await mineRaw({
    from: MUTATION_RECIPIENT,
    to: BAES,
    data: encodeErc20Transfer(PUNK_AMM, rawAmount("1")),
  }, "raw BAES donation setup");
  await executePlannerFlow("donation sync", ["plan-sync-donation", "--wallet", MUTATION_RECIPIENT]);

  const inventoryBefore = await expectCliSuccess(
    "pre-eviction inventory read",
    ["inventory", "--wallet", MUTATION_RECIPIENT, "--limit", "1"],
  );
  const brokenHead = inventoryBefore.inventory.values[0];
  assert("eviction setup found a FIFO head", Boolean(brokenHead), inventoryBefore.inventory);
  await rpc("anvil_setBalance", [PUNK_AMM, hexQuantity(10n * 10n ** 18n)]);
  await rpc("anvil_impersonateAccount", [PUNK_AMM]);
  await mineRaw({
    from: PUNK_AMM,
    to: PUNKS,
    data: encodePunkTransfer(PUNK_AMM, ALT_RECIPIENT, brokenHead),
    gas: "0x1e8480",
  }, "broken FIFO head setup");
  assert("FIFO head is externally unowned for repair", await ownerOf(brokenHead) === normalizeAddress(ALT_RECIPIENT));
  const eviction = await executePlannerFlow("FIFO head eviction", [
    "plan-evict-head", "--wallet", MUTATION_RECIPIENT,
  ]);
  assert("eviction receipt names broken head", eviction.plan.terms.tokenId === String(brokenHead), eviction.plan.terms);

  await executePlannerFlow("default unstake", [
    "plan-unstake", "--wallet", MUTATION_RECIPIENT, "--position-id", String(secondPositionId),
  ]);
  assert("default unstake returned NFT to depositor", await ownerOf(secondBuy.tokenId) === normalizeAddress(MUTATION_RECIPIENT));
  await executePlannerFlow("unstakeTo", [
    "plan-unstake", "--wallet", MUTATION_RECIPIENT,
    "--position-id", String(firstPositionId), "--recipient", ALT_RECIPIENT,
  ]);
  assert("unstakeTo delivered NFT to explicit recipient", await ownerOf(firstBuy.tokenId) === normalizeAddress(ALT_RECIPIENT));

  pass("comprehensive planner/inspector E2E suite complete", {
    sell: boughtTokenId,
    stakes: [firstPositionId, secondPositionId],
    claims: ["strict", "claimTo", "batch", "all", "lossy", "forfeit"],
  });
}

async function ownerOf(tokenId, block = "latest") {
  const data = `0x6352211e${wordUint(tokenId)}`;
  const encoded = await rpc("eth_call", [{ to: PUNKS, data }, block]);
  return normalizeAddress(`0x${encoded.slice(-40)}`);
}

async function tokenBalance(token, account, block = "latest") {
  const data = `0x70a08231${wordAddress(account)}`;
  return BigInt(await rpc("eth_call", [{ to: token, data }, block]));
}

async function mutateBoughtPunkOwner(tokenId) {
  const data = `0x23b872dd${wordAddress(FORK_WALLET)}${wordAddress(MUTATION_RECIPIENT)}${wordUint(tokenId)}`;
  const hash = await rpc("eth_sendTransaction", [{
    from: FORK_WALLET,
    to: PUNKS,
    data,
    value: "0x0",
    gas: "0x1e8480",
  }]);
  const receipt = await waitForReceipt(hash);
  assert("post-buy ownership mutation mined", BigInt(receipt.status) === 1n, receipt.status);
  assert("latest owner differs after mutation", await ownerOf(tokenId) === normalizeAddress(MUTATION_RECIPIENT));
}

async function run() {
  await startFork();
  pass("base-anvil archive fork started", { forkBlock: FORK_BLOCK, chainId: CHAIN_ID });

  const chainId = Number(BigInt(await rpc("eth_chainId")));
  const forkHeight = Number(BigInt(await rpc("eth_blockNumber")));
  assert("fork chain id is Base", chainId === CHAIN_ID, chainId);
  assert("fork begins at pinned archive block", forkHeight === FORK_BLOCK, forkHeight);
  await rpc("anvil_setBalance", [FORK_WALLET, hexQuantity(100n * 10n ** 18n)]);
  await rpc("anvil_impersonateAccount", [FORK_WALLET]);
  assert("known fork EOA funded", BigInt(await rpc("eth_getBalance", [FORK_WALLET, "latest"])) === 100n * 10n ** 18n);
  const signerCode = await rpc("eth_getCode", [FORK_WALLET, "latest"]);
  assert(
    "known fork signer is an EOA or EIP-7702-delegated EOA",
    signerCode === "0x" || /^0xef0100[0-9a-fA-F]{40}$/.test(signerCode),
    signerCode,
  );

  const verify = await expectCliSuccess("fork deployment verification", ["verify", "--wallet", FORK_WALLET]);
  assert("reviewed release pin verified on fork", verify.release?.commit === "2bbf9e3", verify.release);

  let plan = await expectCliSuccess("initial buy plan", ["plan-buy", "--wallet", FORK_WALLET, "--slippage-bps", "300"]);
  assert("buy starts with an approval", plan.phase === "approval", plan.phase);
  assert("planner emits one transaction", plan.txs?.length === 1, plan.txs?.length);
  assert("planner emits canonical inspection context", /^0x(?:[0-9a-f]{2})+$/.test(plan.inspectionContextHex), plan.inspectionContextHex);
  assert("planner emits inspection key", /^0x[0-9a-f]{64}$/.test(plan.inspectionKey), plan.inspectionKey);
  const initialConfirmationKey = plan.confirmationKey;
  const initialContext = plan.inspectionContextHex;
  const boughtTokenId = plan.terms.tokenId;

  await expectCliSuccess("original approval envelope", inspectCalldataArgs(plan));
  await expectCliFailure(
    "mutated calldata binding",
    inspectCalldataArgs(plan, { data: flipLastNibble(plan.txs[0].data) }),
    "plan-binding",
  );
  const changedContext = structuredClone(plan.inspectionContext);
  changedContext.terms.tokenId = String(BigInt(changedContext.terms.tokenId) + 1n);
  await expectCliFailure(
    "mutated context binding",
    inspectCalldataArgs(plan, { context: utf8Hex(JSON.stringify(changedContext)) }),
    "plan-binding",
  );
  await expectCliFailure(
    "malformed context",
    inspectCalldataArgs(plan, { context: "0x00" }),
    "args",
  );
  await expectCliFailure(
    "mutated plan key binding",
    inspectCalldataArgs(plan, { planKey: flipLastNibble(plan.inspectionKey) }),
    "plan-binding",
  );
  await expectCliFailure(
    "wrong chain rejection",
    inspectCalldataArgs(plan, { chainId: 1 }),
    "chain",
  );
  await expectCliFailure(
    "nonzero native value rejection",
    inspectCalldataArgs(plan, { value: "1" }),
    "value",
  );

  let approvalCount = 0;
  while (plan.phase === "approval") {
    approvalCount += 1;
    if (approvalCount > 3) throw new Error("buy planner did not progress from approvals to action");
    await minePlan(plan);
    const nextPlan = await expectCliSuccess("fresh buy re-plan", [
      "plan-buy", "--wallet", FORK_WALLET,
      "--expected-token-id", String(boughtTokenId),
      "--slippage-bps", "300",
    ]);
    assert("approval/action confirmation continuity", nextPlan.confirmationKey === initialConfirmationKey, {
      before: initialConfirmationKey,
      after: nextPlan.confirmationKey,
    });
    assert("approval/action context continuity", nextPlan.inspectionContextHex === initialContext, {
      before: initialContext,
      after: nextPlan.inspectionContextHex,
    });
    plan = nextPlan;
  }
  assert("buy planner reaches action", plan.phase === "action", plan.phase);

  const buyResult = await minePlan(plan, { attributed: true });
  assert("bought FIFO punk belongs to fork wallet", await ownerOf(boughtTokenId) === normalizeAddress(FORK_WALLET));

  await mutateBoughtPunkOwner(boughtTokenId);
  const historicalProof = await expectCliSuccess(
    "historical buy receipt remains provable",
    inspectTxArgs(plan, buyResult.hash),
  );
  assert("historical proof uses receipt-block state", historicalProof.state === "confirmed-and-receipt-proven", historicalProof.state);

  const pendingPlan = await expectCliSuccess("next buy approval plan", [
    "plan-buy", "--wallet", FORK_WALLET, "--slippage-bps", "300",
  ]);
  assert("next buy requires fresh exact approval", pendingPlan.phase === "approval", pendingPlan.phase);
  await expectCliSuccess("pending approval calldata inspection", inspectCalldataArgs(pendingPlan));
  await rpc("evm_setAutomine", [false]);
  const pendingHash = await send(pendingPlan.txs[0]);
  const pendingProof = await expectCliFailure(
    "pending receipt is not completion",
    inspectTxArgs(pendingPlan, pendingHash),
  );
  assert("pending receipt state is explicit", pendingProof.state === "pending-or-unavailable", pendingProof.state);
  await rpc("evm_mine");
  await rpc("evm_setAutomine", [true]);

  // Sanity check that the buy path used the pinned token/spender rather than a
  // state-dependent address derived by this harness.
  assert("buy approval target is pinned BAES", normalizeAddress(pendingPlan.txs[0].to) === normalizeAddress(BAES));
  assert("buy action target is pinned PunkAMM", normalizeAddress(plan.txs[0].to) === normalizeAddress(PUNK_AMM));

  await runComprehensiveFlows(boughtTokenId, pendingPlan, pendingHash);
}

let interrupted = false;
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.once(signal, () => {
    interrupted = true;
    void stopFork().finally(() => process.exit(code));
  });
}

try {
  await run();
} catch (error) {
  failures.push(redact(error?.stack || error?.message || error));
  console.error(`FAIL  ${redact(error?.message || error)}`);
} finally {
  if (!interrupted) await stopFork();
}

console.log(JSON.stringify({ ok: failures.length === 0, checks: checkCount, failed: failures }, null, 2));
if (failures.length > 0) process.exitCode = 1;
