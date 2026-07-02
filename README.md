# Biggy

Telegram bot that delivers data-driven World Cup parlay combinations using TxLINE odds, Google News context, and Gemini.

## Prerequisites (you provide)

| Item | How to get it |
|------|----------------|
| `TELEGRAM_BOT_TOKEN` | [@BotFather](https://t.me/BotFather) → `/newbot` |
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/apikey) |
| `SOLANA_PRIVATE_KEY` | New Phantom/Solflare wallet or `solana-keygen new` — fund with **~0.01 SOL** (mainnet gas only) |
| `USDC_RECEIVER_WALLET` | Public address that receives user subscriptions (can be same wallet) |

## Setup

```bash
cp .env.example .env
# Fill in TELEGRAM_BOT_TOKEN, GEMINI_API_KEY, SOLANA_PRIVATE_KEY, USDC_RECEIVER_WALLET

npm install
npm run db:migrate

# One-time: register free World Cup TxLINE access (~0.01 SOL gas)
npm run txline:activate

# Generate today's picks (TxLINE + Google News + Gemini)
npm run picks:generate

npm run dev
```

## Test commands

```bash
npm run test:gemini
npm run test:solana
npm run test:txline
npm run picks:generate
```

## Bot commands (Telegram)

- `/start` — welcome + trial + daily menu
- `/picks` — today's tier buttons
- `/status` — trial or subscription
- `/help` — help text

## Locked decisions

- **Network:** Mainnet
- **Stack:** Node 20 + TypeScript + grammY
- **Data:** TxLINE World Cup free tier (SL 12 real-time)
- **Context:** Google News RSS → Gemini
- **Trial:** 7 days from `/start`
- **Pricing:** 5 USDC/month · 54 USDC/year (early bird)
