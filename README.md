# AutoPac — Semi-Automated Trading System

A secure, production-ready MVP where TradingView signals are received via webhook, reviewed by a human on mobile, and executed through a broker API only after manual approval.

## Architecture

```
TradingView Alert
       │
       ▼
  Webhook (Cloud Function)
       │
       ▼
  Firestore (signal stored)
       │
       ▼
  FCM Push Notification ──▶ Mobile App
                                │
                          User Reviews
                           ┌────┴────┐
                        Approve    Reject
                           │          │
                     Risk Checks   Update status
                           │
                     Broker API
                           │
                     Order Executed
```

## Tech Stack

| Component       | Technology                           |
|----------------|--------------------------------------|
| Backend        | Firebase Cloud Functions (Node.js 20)|
| Database       | Firestore                            |
| Auth           | Firebase Authentication              |
| Notifications  | Firebase Cloud Messaging (FCM)       |
| Mobile App     | React Native (Expo)                  |
| Broker         | Mock (default) / Alpaca              |

## Project Structure

```
autopac/
├── backend/
│   ├── functions/
│   │   ├── src/
│   │   │   ├── index.ts              # Cloud Functions entry point
│   │   │   ├── config.ts             # App configuration
│   │   │   ├── types/index.ts        # TypeScript types
│   │   │   ├── webhooks/
│   │   │   │   └── tradingview.ts    # Webhook handler
│   │   │   ├── api/
│   │   │   │   ├── trade.ts          # Trade approval handler
│   │   │   │   └── signals.ts        # Signals & orders API
│   │   │   ├── services/
│   │   │   │   ├── audit.ts          # Audit trail logging
│   │   │   │   ├── notification.ts   # FCM push notifications
│   │   │   │   └── risk.ts           # Risk checks
│   │   │   ├── middleware/
│   │   │   │   ├── auth.ts           # Firebase Auth middleware
│   │   │   │   └── rateLimit.ts      # Rate limiting
│   │   │   └── brokers/
│   │   │       ├── interface.ts      # Broker interface
│   │   │       ├── index.ts          # Broker factory
│   │   │       ├── mock.ts           # Mock broker
│   │   │       └── alpaca.ts         # Alpaca broker
│   │   ├── test/
│   │   │   ├── webhook.test.ts       # Webhook validation tests
│   │   │   ├── decision.test.ts      # Decision logic tests
│   │   │   └── integration.test.ts   # End-to-end flow tests
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── jest.config.js
│   ├── firebase.json
│   ├── firestore.rules
│   └── firestore.indexes.json
├── mobile/
│   ├── App.tsx                        # App entry point
│   ├── src/
│   │   ├── config/
│   │   │   ├── firebase.ts            # Firebase init (imports from env.ts)
│   │   │   ├── env.template.ts        # Template — committed, safe
│   │   │   └── env.ts                 # GITIGNORED — your real Firebase config
│   │   ├── context/AuthContext.tsx     # Auth state management
│   │   ├── services/
│   │   │   ├── api.ts                 # Backend API client
│   │   │   └── auth.ts               # Auth service
│   │   ├── screens/
│   │   │   ├── LoginScreen.tsx        # Login / Sign Up
│   │   │   ├── SignalInboxScreen.tsx   # Signal list
│   │   │   ├── SignalDetailScreen.tsx  # Signal details + approve/reject
│   │   │   ├── OrdersScreen.tsx       # Order history
│   │   │   └── SettingsScreen.tsx     # Settings + sign out
│   │   ├── components/
│   │   │   ├── SignalCard.tsx         # Signal list item
│   │   │   └── OrderCard.tsx          # Order list item
│   │   └── navigation/
│   │       └── AppNavigator.tsx       # Navigation setup
│   ├── app.json
│   ├── package.json
│   └── tsconfig.json
├── .env.example                        # Backend env template
├── .gitignore                          # Covers all secrets and env files
├── PROGRESS.md                         # AI agent context file
└── README.md
```

## Setup

### Prerequisites

- Node.js 20+
- Firebase CLI (`npm install -g firebase-tools`)
- Expo CLI (`npm install -g expo-cli`)
- A Firebase project with Firestore, Auth, and FCM enabled

### 1. Firebase Project

```bash
# Login to Firebase
firebase login

# Initialize (select your project)
cd backend
firebase init
```

### 2. Backend Setup

```bash
cd backend/functions
npm install

# Set environment secrets
firebase functions:secrets:set WEBHOOK_SECRET
# Enter a strong random string (e.g., openssl rand -hex 32)

# Build
npm run build

# Run locally with emulators
npm run serve

# Deploy
npm run deploy
```

### 3. Mobile App Setup

```bash
cd mobile
npm install

# Create your local env config (gitignored — never committed)
cp src/config/env.template.ts src/config/env.ts
```

Edit `mobile/src/config/env.ts` with your Firebase project values:

```ts
export const FIREBASE_CONFIG = {
  apiKey: "AIza...",                       // From Firebase console
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc123",
};

export const API_BASE_URL =
  "https://us-central1-your-project.cloudfunctions.net/api";
```

> **Important:** `env.ts` is gitignored. It will **never** be committed. Only `env.template.ts` (with placeholder values) is tracked in git.

Then start the app:

```bash
npx expo start
```

### 4. Configure TradingView Alert

In TradingView, create an alert with:

- **Webhook URL**: `https://us-central1-YOUR_PROJECT.cloudfunctions.net/webhook/tradingview`
- **Message** (JSON):

```json
{
  "strategy": "{{strategy.order.action}}",
  "symbol": "{{ticker}}",
  "action": "{{strategy.order.action}}",
  "timeframe": "{{interval}}",
  "price": {{close}},
  "stopLoss": 0,
  "takeProfit": 0,
  "signalTime": "{{timenow}}",
  "secret": "YOUR_WEBHOOK_SECRET"
}
```

## Testing

### Run Unit & Integration Tests

```bash
cd backend/functions
npm test
```

### Simulate a Webhook (curl)

```bash
curl -X POST https://us-central1-YOUR_PROJECT.cloudfunctions.net/webhook/tradingview \
  -H "Content-Type: application/json" \
  -d '{
    "strategy": "EMA_Cross",
    "symbol": "AAPL",
    "action": "BUY",
    "timeframe": "5m",
    "price": 212.45,
    "stopLoss": 210.80,
    "takeProfit": 216.20,
    "signalTime": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'",
    "secret": "YOUR_WEBHOOK_SECRET"
  }'
```

### Simulate Full Flow

1. Send webhook (curl above)
2. Open mobile app → see signal in inbox
3. Tap signal → view details
4. Tap "Approve Trade" → order is placed via mock broker
5. Check Orders tab → see executed order

### Test Against Local Emulators

```bash
cd backend
firebase emulators:start

# Then send webhook to localhost:
curl -X POST http://localhost:5001/YOUR_PROJECT/us-central1/webhook/tradingview \
  -H "Content-Type: application/json" \
  -d '{ ... }'
```

## Security

### Implemented

- **Webhook secret validation** with timing-safe comparison
- **Replay attack prevention** — rejects signals older than 5 minutes
- **Rate limiting** on webhook endpoint (30 req/min)
- **Firebase Auth required** for all user-facing APIs
- **Firestore security rules** — no direct client writes
- **Idempotency** — duplicate signals are detected and ignored
- **Risk checks** — daily trade limit, max position value, market hours
- **Audit trail** — all actions logged to Firestore `audit` collection
- **Secrets** stored in Firebase environment/Secret Manager
- **Input validation** on all endpoints
- **Helmet.js** security headers on Express apps

### Security Notes

No secrets are committed to the repository. Here's where each one lives:

| Secret | Location | Notes |
|--------|----------|-------|
| Webhook shared secret | `WEBHOOK_SECRET` env var on Cloud Functions | Set via `firebase functions:secrets:set WEBHOOK_SECRET` |
| Alpaca API key/secret | `ALPACA_API_KEY`, `ALPACA_API_SECRET` env vars | Only needed for real broker |
| Firebase client config | `mobile/src/config/env.ts` | Gitignored — copy from `env.template.ts` |
| Firebase Admin SDK | Automatic in Cloud Functions | No manual key needed |
| `google-services.json` | `mobile/google-services.json` | Gitignored — download from Firebase console |
| `GoogleService-Info.plist` | `mobile/GoogleService-Info.plist` | Gitignored — download from Firebase console |

**Files gitignored for safety:**
- `.env`, `.env.*` (except `.env.example`)
- `mobile/src/config/env.ts`
- `google-services.json`, `GoogleService-Info.plist`
- `.firebaserc`
- `backend/functions/.secret.local`

### Security Notes
- Broker API keys are **never** exposed to the mobile app
- All trade execution runs server-side with human approval required
- The `audit` collection accepts no client reads or writes

## API Reference

### Webhook

```
POST /webhook/tradingview
```

No auth required. Validates shared secret in payload.

### Authenticated Endpoints (require Bearer token)

| Method | Path              | Description           |
|--------|------------------|-----------------------|
| GET    | /signals         | List signals          |
| GET    | /signals/:id     | Get signal detail     |
| POST   | /trade/approve   | Approve or reject     |
| GET    | /orders          | List orders           |
| POST   | /fcm-token       | Register FCM token    |

## Firestore Collections

| Collection    | Purpose                     | Client Access        |
|--------------|-----------------------------|---------------------|
| `signals`    | Trade signals               | Read (auth)         |
| `decisions`  | Approval decisions          | Read own (auth)     |
| `orders`     | Executed orders             | Read (auth)         |
| `audit`      | Audit trail                 | None                |
| `userTokens` | FCM push tokens            | Own (auth)          |

## Configuration

Key settings in `backend/functions/src/config.ts`:

| Setting                | Default   | Description                      |
|-----------------------|-----------|----------------------------------|
| `DEFAULT_TRADE_QUANTITY` | 1       | Shares per trade                 |
| `MAX_SIGNAL_AGE_SECONDS` | 300    | Max signal age (5 min)           |
| `MAX_DAILY_TRADES`      | 20      | Daily trade limit                |
| `MAX_POSITION_VALUE`    | 50000   | Max single position ($)          |
| `ACTIVE_BROKER`         | mock    | Broker to use (mock/alpaca)      |
| `PAPER_TRADING`         | true    | Paper trading mode               |

## Extending

### Add a New Broker

1. Create `backend/functions/src/brokers/newbroker.ts`
2. Implement the `IBroker` interface
3. Add to the factory in `brokers/index.ts`
4. Update `CONFIG.ACTIVE_BROKER` type

### Add Risk Rules

Add new check functions in `backend/functions/src/services/risk.ts` and call them from `runRiskChecks()`.
