import { createHash, randomUUID } from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";

initializeApp();
const db = getFirestore();
const REGION = "asia-southeast1";
const SETTINGS = db.collection("paymentSettings").doc("bkashPersonal");
const BDT_PAISE = 100;
const trxHash = (value: string) => createHash("sha256").update(value.trim().toUpperCase()).digest("hex");
const requireUser = (auth: { uid: string; token: Record<string, unknown> } | undefined) => {
  if (!auth) throw new HttpsError("unauthenticated", "সাইন ইন করুন।");
};
const isAdmin = (token: Record<string, unknown>) => token.admin === true || token.superAdmin === true;
const isSuperAdmin = (token: Record<string, unknown>) => token.superAdmin === true;
const stringField = (value: unknown, name: string, max: number) => {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > max) {
    throw new HttpsError("invalid-argument", `Invalid ${name}.`);
  }
  return value.trim();
};

/** Owner-only configuration. Amounts are represented in paisa (integer). */
export const updateBkashPaymentSettings = onCall({ region: REGION, enforceAppCheck: true }, async (request) => {
  requireUser(request.auth);
  if (!isSuperAdmin(request.auth!.token as Record<string, unknown>)) {
    throw new HttpsError("permission-denied", "Super Admin permission required.");
  }
  const phone = stringField(request.data?.phoneNumber, "phone number", 20).replace(/[\s-]/g, "");
  if (!/^01[3-9]\d{8}$/.test(phone)) throw new HttpsError("invalid-argument", "Enter a valid Bangladesh mobile number.");
  const instructions = stringField(request.data?.instructions, "instructions", 2000);
  const minAmountPaisa = request.data?.minAmountPaisa;
  const maxAmountPaisa = request.data?.maxAmountPaisa;
  if (!Number.isSafeInteger(minAmountPaisa) || minAmountPaisa < BDT_PAISE ||
      !Number.isSafeInteger(maxAmountPaisa) || maxAmountPaisa < minAmountPaisa || maxAmountPaisa > 500000000) {
    throw new HttpsError("invalid-argument", "Invalid min/max payment amount.");
  }
  if (typeof request.data?.enabled !== "boolean") throw new HttpsError("invalid-argument", "enabled must be boolean.");

  await db.runTransaction(async (tx) => {
    const before = await tx.get(SETTINGS);
    tx.set(SETTINGS, {
      method: "bkash_personal_send_money",
      phoneNumber: phone,
      instructions,
      minAmountPaisa,
      maxAmountPaisa,
      enabled: request.data.enabled,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: request.auth!.uid,
    });
    const log = db.collection("adminAuditLogs").doc();
    tx.create(log, {
      actorUid: request.auth!.uid,
      action: "UPDATE_BKASH_SETTINGS",
      targetId: SETTINGS.id,
      before: before.exists ? before.data() : null,
      after: { phoneNumber: phone, instructions, minAmountPaisa, maxAmountPaisa, enabled: request.data.enabled },
      createdAt: FieldValue.serverTimestamp(),
    });
  });
  return { ok: true };
});

/** Create a pending request only. Never represents a verified payment. */
export const submitManualPayment = onCall({ region: REGION, enforceAppCheck: true }, async (request) => {
  requireUser(request.auth);
  const uid = request.auth!.uid;
  const amountPaisa = request.data?.amountPaisa;
  if (!Number.isSafeInteger(amountPaisa) || amountPaisa <= 0) throw new HttpsError("invalid-argument", "Amount must be an integer in paisa.");
  const senderNumber = stringField(request.data?.senderNumber, "sender number", 20).replace(/[\s-]/g, "");
  if (!/^01[3-9]\d{8}$/.test(senderNumber)) throw new HttpsError("invalid-argument", "Enter a valid Bangladesh mobile number.");
  const trxId = stringField(request.data?.trxId, "TrxID", 100).replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z0-9-]{6,100}$/.test(trxId)) throw new HttpsError("invalid-argument", "Invalid TrxID format.");
  const settingsSnap = await SETTINGS.get();
  if (!settingsSnap.exists) throw new HttpsError("failed-precondition", "Payment method is not configured.");
  const settings = settingsSnap.data()!;
  if (settings.enabled !== true) throw new HttpsError("failed-precondition", "Payment method is currently disabled.");
  if (amountPaisa < settings.minAmountPaisa || amountPaisa > settings.maxAmountPaisa) {
    throw new HttpsError("failed-precondition", "Amount is outside the configured limit.");
  }
  const userSnap = await db.collection("users").doc(uid).get();
  const requestId = randomUUID();
  const indexRef = db.collection("transactions").doc(trxHash(trxId));
  const paymentRef = db.collection("paymentRequests").doc(requestId);
  await db.runTransaction(async (tx) => {
    const existing = await tx.get(indexRef);
    if (existing.exists) throw new HttpsError("already-exists", "This TrxID has already been submitted.");
    tx.create(indexRef, {
      uid, requestId, trxId, amountPaisa, method: "bkash_personal_send_money",
      status: "Pending", createdAt: FieldValue.serverTimestamp(),
    });
    tx.create(paymentRef, {
      uid,
      customerName: userSnap.data()?.displayName ?? request.auth!.token.name ?? "",
      customerEmail: request.auth!.token.email ?? "",
      amountPaisa,
      senderNumber,
      trxId,
      trxHash: trxHash(trxId),
      screenshotPath: null,
      status: "Pending",
      method: "bkash_personal_send_money",
      createdAt: FieldValue.serverTimestamp(),
      reviewedAt: null,
      reviewedBy: null,
      rejectReason: null,
    });
  });
  return { requestId, status: "Pending" as const };
});

/** Attach optional proof after request creation; Storage rules constrain its owner/path. */
export const attachPaymentProof = onCall({ region: REGION, enforceAppCheck: true }, async (request) => {
  requireUser(request.auth);
  const requestId = stringField(request.data?.requestId, "request ID", 80);
  const path = stringField(request.data?.storagePath, "storage path", 300);
  if (!path.startsWith(`paymentProofs/${request.auth!.uid}/${requestId}/`) || path.includes("..")) {
    throw new HttpsError("invalid-argument", "Proof must be uploaded to your own request folder.");
  }
  const ref = db.collection("paymentRequests").doc(requestId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data()?.uid !== request.auth!.uid) throw new HttpsError("not-found", "Payment request not found.");
    if (snap.data()?.status !== "Pending") throw new HttpsError("failed-precondition", "Only pending requests can be updated.");
    tx.update(ref, { screenshotPath: path, proofUpdatedAt: FieldValue.serverTimestamp() });
  });
  return { ok: true };
});

/** Admin review with explicit manual verification; approval is idempotent and credits once. */
export const reviewManualPayment = onCall({ region: REGION, enforceAppCheck: true }, async (request) => {
  requireUser(request.auth);
  const token = request.auth!.token as Record<string, unknown>;
  if (!isAdmin(token)) throw new HttpsError("permission-denied", "Admin permission required.");
  const requestId = stringField(request.data?.requestId, "request ID", 80);
  const decision = request.data?.decision;
  if (decision !== "Approved" && decision !== "Rejected") throw new HttpsError("invalid-argument", "Decision must be Approved or Rejected.");
  const verificationNote = stringField(request.data?.verificationNote, "verification note", 1000);
  if (decision === "Approved" && request.data?.manuallyVerified !== true) {
    throw new HttpsError("failed-precondition", "Confirm the transaction was checked in the official bKash account before approving.");
  }
  const rejectReason = decision === "Rejected" ? stringField(request.data?.rejectReason, "rejection reason", 1000) : null;
  const paymentRef = db.collection("paymentRequests").doc(requestId);
  await db.runTransaction(async (tx) => {
    const paymentSnap = await tx.get(paymentRef);
    if (!paymentSnap.exists) throw new HttpsError("not-found", "Payment request not found.");
    const payment = paymentSnap.data()!;
    if (payment.status !== "Pending") throw new HttpsError("failed-precondition", "This request has already been reviewed.");
    const userRef = db.collection("users").doc(payment.uid);
    const userSnap = await tx.get(userRef);
    if (!userSnap.exists) throw new HttpsError("failed-precondition", "Customer profile is missing.");
    const txnRef = db.collection("transactions").doc(payment.trxHash);
    const txnSnap = await tx.get(txnRef);
    if (!txnSnap.exists || txnSnap.data()?.requestId !== requestId || txnSnap.data()?.status !== "Pending") {
      throw new HttpsError("already-exists", "TrxID is not uniquely pending for this request.");
    }
    const auditRef = db.collection("adminAuditLogs").doc();
    tx.update(paymentRef, {
      status: decision,
      reviewedAt: FieldValue.serverTimestamp(),
      reviewedBy: request.auth!.uid,
      verificationNote,
      rejectReason,
    });
    tx.update(txnRef, { status: decision, reviewedAt: FieldValue.serverTimestamp(), reviewedBy: request.auth!.uid });
    if (decision === "Approved") {
      const currentBalance = Number.isSafeInteger(userSnap.data()?.walletBalancePaisa) ? userSnap.data()!.walletBalancePaisa : 0;
      tx.update(userRef, { walletBalancePaisa: currentBalance + payment.amountPaisa, walletUpdatedAt: FieldValue.serverTimestamp() });
    }
    tx.create(auditRef, {
      actorUid: request.auth!.uid,
      action: decision === "Approved" ? "APPROVE_MANUAL_BKASH_PAYMENT" : "REJECT_MANUAL_BKASH_PAYMENT",
      targetId: requestId,
      previousStatus: "Pending",
      newStatus: decision,
      amountPaisa: payment.amountPaisa,
      trxHash: payment.trxHash,
      verificationNote,
      rejectReason,
      createdAt: FieldValue.serverTimestamp(),
    });
  });
  return { ok: true, status: decision };
});
