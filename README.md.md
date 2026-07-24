# GemStream — High-Performance Crypto-Bridge Tipping Engine

GemStream is a non-custodial, micro-tipping SaaS engine built for live-streamers. It bridges fiat payments (Stripe) to decentralized Web3 payouts (Polygon USDT) with a focus on atomic ledger integrity and 14-day chargeback protection.

## 🚀 Core Philosophy (The 3 Axioms)
1. **Axiom 2.1 (The Peg):** 1 Gem = $0.10 USDT.
2. **Axiom 2.2 (Zero Floats):** Every balance and monetary field is a strictly validated integer (`Int`). No floating-point math is ever performed.
3. **Axiom 2.3 (Conservation):** Gems only enter the ledger via fiat deposit and exit only via blockchain payout.

## 🛠 Tech Stack
* **Runtime:** Node.js (TypeScript)
* **ORM:** Prisma + PostgreSQL (ACID-compliant transactions)
* **Fiat Layer:** Stripe API (3D-Secure enforced)
* **Web3 Layer:** Ethers.js v6 + Polygon PoS (ERC-20 USDT)
* **Real-time:** Socket.io (Room-based isolation)

## 📁 Architecture Overview
* **LedgerService:** The financial brain. Manages tip dispatching and the 14-day maturation "clearing fortress".
* **StripeService:** Fiat on-ramp. Enforces 3DS and handles webhook idempotency.
* **CryptoService:** Blockchain off-ramp. Handles EOA-based USDT transfers with two-phase commit (PROCESSING → COMPLETED/FAILED).
* **AlertService:** Real-time megaphone. Dispatches alerts to OBS browser sources via isolated Socket.io rooms.

## ⚙️ Environment Configuration
Required variables in `.env`:
- `DATABASE_URL`: PostgreSQL connection string.
- `STRIPE_SECRET_KEY`: Stripe API key.
- `STRIPE_WEBHOOK_SECRET`: Secret for HMAC signature verification.
- `POLYGON_RPC_URL`: Polygon Mainnet/Amoy RPC endpoint.
- `HOT_WALLET_PRIVATE_KEY`: Platform hot-wallet private key.
- `ALLOWED_ORIGINS`: Comma-separated list of permitted frontend domains.

## 🧪 Testing (TDD First)
This project is built using Test-Driven Development. Every module has a dedicated suite.
To run the full suite:
```bash
npx jest --verbose
🔒 Security Invariants
Chargeback Defense: Tips are held in pendingBalance for 14 days. Tips funded by disputed Stripe payments are reversed by clawing back Gems from pendingBalance only. The Streamer's availableBalance is never touched.

Double-Spend Prevention: Ledger updates use atomic SQL operators ({ increment } / { decrement }) inside transactions, preventing race conditions from concurrent tip requests.

Global Broadcast Block: AlertService strictly forbids global broadcasts (io.emit). All alerts are scoped to io.to(streamerId).emit, ensuring Streamer A never receives Streamer B's alerts.

🚀 Deployment Notes
Middleware Order: In routes/index.ts, express.raw() for Stripe webhooks MUST precede express.json().

Database: PostgreSQL is mandatory. Do not use MySQL or SQLite for production, as integer arithmetic precision and transaction isolation levels differ significantly.