# AutoPac — Project Progress & Context

> **Purpose:** This file captures the full state of the project so any AI coding agent
> can resume work without re-reading every file. Keep this updated as work progresses.

---

## Project Overview

AutoPac is a **semi-automated trading system** where:
1. TradingView sends trading signals via webhook to a Firebase backend
2. Backend validates, stores in Firestore, and sends a push notification (FCM)
3. Mobile app (React Native / Expo) notifies the user
4. User **manually approves or rejects** the trade
5. On approval, backend runs risk checks and executes via a broker API

**Human approval is mandatory** — this is NOT a fully automated trading bot.

---

## Tech Stack

| Layer              | Technology                         |
|--------------------|------------------------------------|
| Backend            | Firebase Cloud Functions (Node 20, TypeScript) |
| Database           | Firestore                          |
| Auth               | Firebase Authentication (email/password) |
| Push Notifications | Firebase Cloud Messaging (FCM)     |
| Mobile App         | React Native (Expo)                |
| Broker             | Mock (default), Alpaca (real)      |
| Testing            | Jest + ts-jest                     |

---

## Current Status (April 4 2026)

### ✅ Completed

| Component                  | Status | Notes |
|----------------------------|--------|-------|
| Project structure          | Done   | `backend/` + `mobile/` monorepo |
| Firebase config            | Done   | `firebase.json`, Firestore rules & indexes |
| Types & config             | Done   | `src/types/index.ts`, `src/config.ts` |
| Webhook endpoint           | Done   | `POST /webhook/tradingview` — validates secret, freshness, fields, deduplication |
| Trade approval API         | Done   | `POST /trade/approve` — auth required, Firestore transaction, risk checks |
| Signal/Order list APIs     | Done   | `GET /signals`, `GET /signals/:id`, `GET /orders` |
| FCM token registration     | Done   | `POST /fcm-token` |
| Broker abstraction layer   | Done   | `IBroker` interface → `MockBroker`, `AlpacaBroker` |
| Push notification service  | Done   | Send FCM on new signal, auto-cleanup invalid tokens |
| Audit trail                | Done   | Logs all actions to `audit` collection |
| Risk checks                | Done   | Daily trade limit, position value cap, market hours check |
| Middleware                 | Done   | Firebase Auth verification, rate limiting, Helmet |
| Firestore security rules   | Done   | No direct client writes; reads require auth |
| Unit tests (webhook)       | Done   | 16 tests — payload validation, secret, timing, normalization |
| Unit tests (decision)      | Done   | 5 tests — mock broker, state transition logic |
| Integration tests          | Done   | 5 tests — full webhook → approve → order flow |
| Mobile: Login screen       | Done   | Email/password, sign up toggle, error handling |
| Mobile: Signal Inbox       | Done   | Filterable list, pull-to-refresh |
| Mobile: Signal Detail      | Done   | Full info, Approve / Reject with confirmation dialogs |
| Mobile: Orders screen      | Done   | Executed trade history |
| Mobile: Settings screen    | Done   | User info, sign out |
| Mobile: Navigation         | Done   | Bottom tabs + stack navigation |
| Mobile: API service        | Done   | Token-authenticated fetch wrapper |
| Mobile: Auth service       | Done   | Firebase Auth wrapper + AuthContext |
| Secret management          | Done   | All secrets in env vars or gitignored `env.ts` |
| .gitignore                 | Done   | Covers `.env`, `env.ts`, google-services, .firebaserc |

### 🔲 Not Started / Future

- [ ] Firebase project creation & deployment
- [ ] FCM setup (mobile: `expo-notifications` integration)
- [ ] Real Alpaca broker testing (paper trading)
- [ ] MFA (optional multi-factor auth)
- [ ] Paper trading mode toggle in app
- [ ] Duplicate signal detection improvements
- [ ] Risk config UI (max daily trades setting)
- [ ] Second confirmation for large trades
- [ ] Portfolio syncing
- [ ] Multi-user support

---

## File Map

```
autopac/
├── .env.example                         # Env template (committed, safe)
├── .gitignore                           # Covers secrets, build output, env files
│
├── backend/
│   ├── firebase.json                    # Firebase project config
│   ├── firestore.rules                  # Security rules — no client writes
│   ├── firestore.indexes.json           # Composite indexes
│   └── functions/
│       ├── package.json                 # Node 20, deps: firebase-admin, express, etc.
│       ├── tsconfig.json                # Strict TS, target ES2022
│       ├── jest.config.js               # ts-jest preset
│       ├── src/
│       │   ├── index.ts                 # Entry — exports `webhook` and `api` Cloud Functions
│       │   ├── config.ts                # Constants + env-based secret loaders
│       │   ├── types/index.ts           # Signal, Decision, Order, Broker, Audit types
│       │   ├── webhooks/
│       │   │   └── tradingview.ts       # POST /webhook/tradingview handler + validation
│       │   ├── api/
│       │   │   ├── trade.ts             # POST /trade/approve — approval + order execution
│       │   │   └── signals.ts           # GET /signals, /signals/:id, /orders, POST /fcm-token
│       │   ├── brokers/
│       │   │   ├── interface.ts         # IBroker interface
│       │   │   ├── mock.ts              # MockBroker (testing / paper trading)
│       │   │   ├── alpaca.ts            # AlpacaBroker (real, uses fetch)
│       │   │   └── index.ts             # getBroker() factory
│       │   ├── services/
│       │   │   ├── audit.ts             # logAudit() — writes to audit collection
│       │   │   ├── notification.ts      # sendSignalNotification() — FCM multicast
│       │   │   └── risk.ts              # runRiskChecks() — daily limit, value, hours
│       │   └── middleware/
│       │       ├── auth.ts              # requireAuth — verifies Firebase ID token
│       │       └── rateLimit.ts         # express-rate-limit for webhook
│       └── test/
│           ├── webhook.test.ts          # 16 tests — payload validation
│           ├── decision.test.ts         # 5 tests — broker + state logic
│           └── integration.test.ts      # 5 tests — full flow with mocked Firestore
│
└── mobile/
    ├── app.json                         # Expo config
    ├── App.tsx                          # Root — AuthProvider + NavigationContainer
    ├── package.json                     # Expo 52, React Native 0.76, Firebase JS SDK
    ├── tsconfig.json
    └── src/
        ├── config/
        │   ├── firebase.ts              # Firebase init — imports from env.ts
        │   ├── env.ts                   # GITIGNORED — real Firebase config values
        │   └── env.template.ts          # Committed template — copy to env.ts
        ├── context/
        │   └── AuthContext.tsx           # React context for auth state
        ├── services/
        │   ├── auth.ts                  # signIn / signUp / signOut / onAuthChange
        │   └── api.ts                   # Authenticated API client (signals, orders, trade)
        ├── components/
        │   ├── SignalCard.tsx            # Signal list item card
        │   └── OrderCard.tsx            # Order list item card
        ├── screens/
        │   ├── LoginScreen.tsx          # Email/password login + signup
        │   ├── SignalInboxScreen.tsx     # Filterable signal list with pull-to-refresh
        │   ├── SignalDetailScreen.tsx    # Signal info + Approve/Reject buttons
        │   ├── OrdersScreen.tsx         # Order history list
        │   └── SettingsScreen.tsx       # User info + sign out
        └── navigation/
            └── AppNavigator.tsx         # Bottom tabs + signal stack navigation
```

---

## Firestore Collections

| Collection    | Key Fields | Notes |
|---------------|-----------|-------|
| `signals`     | strategy, symbol, action, timeframe, price, stopLoss, takeProfit, signalTime, status, idempotencyKey, createdAt, updatedAt | Status: PENDING → APPROVED/REJECTED → EXECUTED/FAILED |
| `decisions`   | signalId, userId, decision (APPROVE/REJECT), decisionTime | One per signal |
| `orders`      | signalId, broker, orderType, side, symbol, quantity, status, responsePayload, createdAt | Created on APPROVE |
| `audit`       | action, signalId, userId, details, timestamp | No client access |
| `userTokens`  | token, userId, updatedAt | FCM push tokens |

---

## API Endpoints

### Webhook (no auth — shared secret validation)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/webhook/tradingview` | Ingest TradingView signal |

### Authenticated API
| Method | Path | Description |
|--------|------|-------------|
| POST | `/trade/approve` | Approve or reject a signal |
| GET | `/signals` | List signals (optional `?status=PENDING`) |
| GET | `/signals/:id` | Get single signal |
| GET | `/orders` | List executed orders |
| POST | `/fcm-token` | Register FCM push token |

---

## Security Model

1. **Webhook**: Shared secret (timing-safe compare), replay prevention (5-min window), rate limiting, idempotency key deduplication
2. **Auth**: All user-facing APIs require Firebase ID token
3. **Secrets**: Backend reads from `process.env`; mobile reads from gitignored `env.ts`
4. **Firestore**: Security rules block all direct client writes
5. **Trade protection**: Transaction-based state check (only PENDING signals can be acted on), risk checks before execution

---

## Test Coverage

```
Test Suites: 3 passed, 3 total
Tests:       28 passed, 28 total

webhook.test.ts    — 16 tests (payload validation, secret, timing, normalization)
decision.test.ts   —  5 tests (mock broker, state transitions)
integration.test.ts —  5 tests (webhook → approve → order flow, rejection, auth check)
```

---

## Key Design Decisions

- **Single-user MVP** — no userId scoping on signals/orders (all belong to the one user)
- **Fixed trade quantity** — configurable in `config.ts` (`DEFAULT_TRADE_QUANTITY = 1`)
- **Market orders only** — `DEFAULT_ORDER_TYPE = "market"`
- **Mock broker by default** — set `ACTIVE_BROKER=alpaca` for real trading
- **Paper trading on** — `PAPER_TRADING=true` by default
- **Express apps** — Two separate Express apps exported as Cloud Functions: `webhook` (public, secret-validated) and `api` (auth-required)

---

## How to Resume Development

1. Read this file for full context
2. Run `cd backend/functions && npm test` to confirm tests pass (28/28)
3. Pick a task from the "Not Started" section above
4. Refer to the File Map for where code lives
5. Update this file when completing tasks
