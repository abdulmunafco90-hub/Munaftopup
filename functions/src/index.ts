import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";

initializeApp();
const db = getFirestore();

// Deprecated gateway placeholder is retained as a fail-closed endpoint for clients
// that may still call it. Manual personal bKash requests use manualPayment.ts.
export const createPayment = onCall({ region: "asia-southeast1", enforceAppCheck: true }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  throw new HttpsError("failed-precondition", "Merchant gateway checkout is not enabled. Use manual bKash payment.");
});

export const paymentCallback = onRequest({ region: "asia-southeast1" }, async (req, res) => {
  logger.warn("No merchant callback is configured for personal Send Money payments.");
  res.status(404).json({ error: "No gateway callback is configured." });
});

export async function reserveIdempotencyKey(uid: string, key: string): Promise<boolean> {
  const ref = db.collection("paymentRequests").doc(`${uid}_${key}`);
  return db.runTransaction(async (tx) => {
    const existing = await tx.get(ref);
    if (existing.exists) return false;
    tx.create(ref, { uid, state: "reserved", createdAt: FieldValue.serverTimestamp() });
    return true;
  });
}
