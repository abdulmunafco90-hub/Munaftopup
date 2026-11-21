# TOPUPBUZZ Android + Firebase backend

## Source audit (2026-11-21)

- `abdulmunafco90-hub/topupbuzz-android` started as an empty repository (only README/LICENSE; no Android Gradle project, no Firebase configuration, Functions, UI, or existing native features).
- The supplied `Shozon-Roy/topupbuzz` is a Next.js 15 / React 18 / TypeScript website, not a native Android project. Inspected pages include home, login, contact, top-up listing and product checkout. Login is UI-only; checkout has payment-method UI but not a real submission. The original source repository is unchanged.
- Firebase IDs and the Realtime Database URL are user-provided and not verified from Firebase Console. This work does not read, delete, or change Realtime Database.

## Implemented backend foundation

Personal bKash Send Money manual-payment backend is in `functions/src/manualPayment.ts`: Super Admin settings; authenticated pending payment submission; normalized, unique TrxID enforcement; optional proof attachment; Admin review with explicit manual verification; atomic wallet credit; and audit logs. Merchant gateway integration is not used. Approval is not automatic and screenshot alone cannot approve.

Firestore and Storage rules deny client writes to payment state, transaction index, settings and audit logs. Cloud Functions are trusted writers. Admin access depends on Firebase Auth custom claims (`admin` / `superAdmin`), which must be granted by a trusted project owner using Admin SDK. No public privilege-escalation API exists.

## Before deployment

1. Confirm project owner access to `com-aistudio-topupbuzz-k-ca562` and enable Firebase Authentication, Firestore, Storage, Functions, App Check, and billing as required by Firebase.
2. Register Android package `com.topupbuzz.app`; download `google-services.json` into a native Android app (not present yet). Never place payment secrets in APK/source.
3. Set admin claims securely for trusted accounts; configure payment settings through the Super Admin callable.
4. Review the `functions/README.md`, test rules and Functions with Firebase Emulator Suite, then deploy:

```bash
firebase deploy --only firestore:rules,storage,functions
```

## Test status and limitations

Static source changes have been committed, but compilation, automated tests, Firebase deployment, payment transaction, and APK/AAB builds have not been run in this environment. This backend records customer-submitted data and provides admin review; it cannot independently verify bKash personal Send Money transactions. Admin must verify in the official account. The current implementation credits a wallet field; connect actual top-up fulfillment before using it as a product payment flow.
