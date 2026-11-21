# Firebase Functions

## Personal bKash manual payment

The manual workflow is implemented in `src/manualPayment.ts`:

- Super Admin callable `updateBkashPaymentSettings` manages the public Send Money number, instructions, min/max BDT amount (in integer paisa), and enabled switch.
- Authenticated customers call `submitManualPayment`; the server validates settings, amount and Bangladesh sender number, normalizes TrxID, reserves its SHA-256 index in `transactions`, creates a unique Pending request, and rejects duplicate TrxIDs atomically.
- Optional screenshots upload to `paymentProofs/{uid}/{requestId}/{fileName}` (JPEG/PNG/WebP, under 5 MB) and are attached with `attachPaymentProof`.
- Admin/Super Admin call `reviewManualPayment`. Approval requires an explicit `manuallyVerified: true` and a verification note; the server atomically updates request/index, credits `users/{uid}.walletBalancePaisa` once, and writes an audit log. Rejection requires a reason. Repeated decisions fail because only Pending can transition.
- Firestore clients cannot write payment requests, transaction records, settings or audit logs. Users read only their own request/transaction; admins read all; only Super Admin reads audit logs. Settings are readable by authenticated users.

This is **manual verification**: the server cannot verify a personal Send Money transaction with a merchant API. An authorized admin must inspect the transaction in the official bKash account before approving. Screenshot alone is not sufficient. Do not collect customer bKash PIN/OTP. Wallet balance is credited in paisa; adapt the approval transaction if successful payment should instead trigger a specific top-up fulfillment workflow.

## Roles and initial settings

Set custom claims (`admin: true`, `superAdmin: true`) only through a trusted Admin SDK environment. Never expose a role-grant callable to clients. Super Admin also gets admin privileges. Before enabling the feature, have the trusted project owner seed or configure settings with the Super Admin callable and test all rules in the Emulator Suite.

## Setup and tests

```bash
cd functions
npm install
npm run build
cd ..
firebase emulators:start --only auth,firestore,storage,functions
```

Then use a test account with claims and seed `paymentSettings/bkashPersonal` through the callable. Deploy rules/functions only after reviewing them:

```bash
firebase deploy --only firestore:rules,storage,functions
```

No Firebase deployment, emulator test, real bKash transaction, Android build, or APK/AAB has been run from this environment. Project Console access and a native Android project are not available here. Configure required Firebase products and App Check before deployment.
