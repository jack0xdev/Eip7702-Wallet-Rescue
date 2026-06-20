# 👻 ghost-delegate

> **EIP-7702 nonce domination bot** — continuously floods your compromised wallet's nonce space so hackers can never override your delegation. Set it and forget it.

```
Hacker tries to override your wallet...
Ghost-Delegate already owns nonces 4820 → 4897
Hacker's tx: INVALID ❌
Your delegation: ACTIVE ✅
ETH received → auto-forwarded to your safe wallet 💸
```

---

## ✨ What It Does

You have a **compromised wallet** (private key leaked). A hacker is trying to use EIP-7702 to delegate it to *their* contract and drain it.

**Ghost-Delegate fights back by:**

- 🔫 Firing **30–80 EIP-7702 authorizations** every 400ms
- 🎲 Using **random nonce jumps** so hackers can't predict your pattern  
- 🎲 Using **random gas prices** so hackers can't front-run you
- ⚡ Submitting to **Base Sequencer directly** for lowest latency
- 🔌 **WebSocket listener** — fires instantly when ETH arrives at victim wallet
- 🔄 **Auto nonce sync** every 2 seconds from chain
- 🛡️ **Never crashes** — errors are caught, logged, and retried

---

## 🏗 How It Works

```
┌─────────────────────────────────────────────────┐
│          YOUR COMPROMISED WALLET                 │
│       (private key leaked / hacked)              │
└──────────────────┬──────────────────────────────┘
                   │  EIP-7702 delegation
                   ▼
┌─────────────────────────────────────────────────┐
│            Forwarder.sol                         │
│  receive() → sends ALL ETH to DESTINATION        │
└──────────────────┬──────────────────────────────┘
                   │  auto-forwards
                   ▼
┌─────────────────────────────────────────────────┐
│          YOUR SAFE WALLET 🔒                     │
└─────────────────────────────────────────────────┘

Meanwhile, Ghost-Delegate bot runs 24/7:

  Every 400ms → sign 30-80 EIP-7702 auths (parallel)
              → submit to Sequencer + QuickNode
              → nonce space FLOODED
              → hacker has no valid slot to enter ❌
```

---

## 📋 Requirements

- Node.js **v18+**
- A **sponsor wallet** with some ETH on Base (pays gas)
- Your **compromised wallet** private key
- A **QuickNode** account (free tier works) — [quicknode.com](https://quicknode.com)
- **Remix IDE** — [remix.ethereum.org](https://remix.ethereum.org)

---

## 🚀 Quick Start

### Step 1 — Clone

```bash
git clone https://github.com/YOUR_USERNAME/ghost-delegate.git
cd ghost-delegate
npm install
```

---

### Step 2 — Deploy Contracts (Remix)

#### 2a. Deploy `Forwarder.sol`

1. Open [remix.ethereum.org](https://remix.ethereum.org)
2. New file → paste `contracts/Forwarder.sol`
3. **Compiler tab** → version `0.8.27` → enable optimization ✅
4. **Advanced** → EVM Version → `prague`
5. **Deploy tab** → Environment → `Injected Provider (MetaMask)`
6. Switch MetaMask to **Base Mainnet**
7. Click **Deploy** → confirm in MetaMask
8. 📋 Copy the deployed address → save it

#### 2b. Deploy `AuthorizationExecutor.sol`

1. New file → paste `contracts/AuthorizationExecutor.sol`
2. Same settings (0.8.27, prague, optimizer ON)
3. Click **Deploy** → confirm
4. 📋 Copy the deployed address → save it

---

### Step 3 — Configure `.env`

```bash
cp .env.example .env
```

Fill in your values:

```env
# QuickNode — Base Mainnet endpoint
QUICKNODE_RPC=https://your-endpoint.quiknode.pro/your-key/
QUICKNODE_WS=wss://your-endpoint.quiknode.pro/your-key/

# Sponsor wallet — pays gas (needs ETH on Base)
SPONSOR_PK=0x...

# Compromised wallet — the one being attacked
COMPROMISED_PK=0x...

# From Step 2 deployments
FORWARDER_ADDRESS=0x...
AUTH_EXECUTOR_ADDRESS=0x...

# Your safe wallet — ETH auto-forwards here
DESTINATION_ADDRESS=0x...
```

---

### Step 4 — Dry Run (Test First!)

```bash
npm run dry
```

Expected output:

```
[INFO] ============================================================
[INFO] EIP-7702 NONCE DOMINATOR — GHOST DELEGATE v1.0
[INFO] Victim:      0xYourCompromisedWallet
[INFO] Sponsor:     0xYourSponsorWallet
[INFO] DRY_RUN:     true
[INFO] ============================================================
[INFO] Firing 47 auths | nonce 1000..1046 | gas 0.002341 gwei
[INFO] DRY RUN — skipping chain submission
[INFO] Firing 63 auths | nonce 1047..1109 | gas 0.001872 gwei
[INFO] DRY RUN — skipping chain submission
```

✅ If you see this — you're ready to go live!

---

### Step 5 — Go Live

```bash
# Set in .env:
DRY_RUN=false

# Run:
npm start
```

```
[INFO] Firing 52 auths | nonce 8340..8391 | gas 0.003102 gwei
[INFO] Tx confirmed on sequencer | hash: 0xa9b3...
[INFO] Firing 38 auths | nonce 8392..8429 | gas 0.001654 gwei
[INFO] Tx confirmed on quicknode | hash: 0xf4c2...
[INFO] Heartbeat | victimNonce=8430 | totalAuths=234 | OUR FORWARDER ✅
```

---

### Step 6 — Keep It Running 24/7 (VPS)

```bash
npm install -g pm2
pm2 start scripts/sweep.js --name ghost-delegate
pm2 save
pm2 logs ghost-delegate
```

---

## ⚙️ All Config Options

| Variable | Default | Description |
|---|---|---|
| `NONCE_JUMP_MIN` | `30` | Min auths per tx |
| `NONCE_JUMP_MAX` | `80` | Max auths per tx |
| `FIRE_INTERVAL_MS` | `400` | Fire every X milliseconds |
| `GAS_LIMIT` | `1000000` | Gas limit per tx |
| `GWEI_MIN` | `0.001` | Min random gas price |
| `GWEI_MAX` | `0.004` | Max random gas price |
| `DRY_RUN` | `true` | Test mode — no real txs |
| `SEQUENCER_RPC` | base sequencer | Override sequencer URL |

---

## 🗂 Project Structure

```
ghost-delegate/
├── contracts/
│   ├── Forwarder.sol              # ETH auto-forwarder (EIP-7702 target)
│   └── AuthorizationExecutor.sol  # One-time setup helper (onlyOwner)
├── scripts/
│   └── sweep.js                   # Main nonce domination bot
├── .env.example                   # Config template
├── package.json
└── README.md
```

---

## 🔐 Security

- ⚠️ **Never commit `.env`** — add it to `.gitignore`
- Sponsor wallet needs only ~0.01 ETH to run for hours
- `AuthorizationExecutor` is `onlyOwner` — only your wallet can call it
- `Forwarder` destination is set **once and locked** — hacker cannot change it

---

## ❓ FAQ

**Q: How much ETH does the sponsor need?**  
Each tx costs ~0.000001 ETH on Base. 0.01 ETH = thousands of txs.

**Q: What if my nonce gets out of sync?**  
The bot auto-syncs from chain every 2 seconds. If it falls behind, it catches up automatically.

**Q: Can I use this on chains other than Base?**  
Yes — change the `chain` import in `sweep.js`. The chain must support Prague fork (EIP-7702).

**Q: What if the bot stops?**  
Restart with `npm start` or use PM2 for auto-restart on crash.

---

## 📜 License

MIT — free to use, fork, and modify.

---

## 🤝 Contact

Need help with **airdrop rescue**, **wallet recovery**, or want a **custom Web3 tool** built?

Feel free to reach out:

<p>
  <a href="https://x.com/0xJackDev">
    <img src="https://img.shields.io/badge/X-%23000000.svg?style=for-the-badge&logo=X&logoColor=white" alt="X (Twitter)"/>
  </a>
  &nbsp;
  <a href="https://t.me/BinanceX360">
    <img src="https://img.shields.io/badge/Telegram-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram"/>
  </a>
</p>

---

## ☕ Support / Donation

If this tool helped you rescue funds, consider sending a tip!

**EVM Wallet (ETH / Base / any EVM chain):**
```
0xf69883d8804753fF730631C52AEf669016fB45b0
```

---

<p align="center">
  👻 <strong>ghost-delegate</strong><br/>
  Built for Base chain · EIP-7702 · Viem v2 · Node.js 18+<br/><br/>
  <a href="https://x.com/0xJackDev">𝕏 @OxJackDev</a> · 
  <a href="https://t.me/BinanceX360">✈️ @BinanceX360</a>
</p>
