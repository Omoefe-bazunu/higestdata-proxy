// server.js - UPDATED WITH COMPLETE WEBHOOK SYSTEM
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
require("dotenv").config();
const admin = require("firebase-admin");

const app = express();
const PORT = process.env.PORT || 3000;

// === FIREBASE ADMIN INIT ===
let db;
try {
  const serviceAccount = require("./serviceAccountKey.json");
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  db = admin.firestore();
  console.log("Firebase Admin initialized");
} catch (err) {
  console.error("Firebase Admin init failed:", err.message);
  process.exit(1);
}

// === CONFIG ===
const EBILLS_API_URL =
  process.env.EBILLS_API_URL || "https://ebills.africa/wp-json/api/v2/";
const EBILLS_AUTH_URL =
  process.env.EBILLS_AUTH_URL ||
  "https://ebills.africa/wp-json/jwt-auth/v1/token";
const KORA_SECRET_KEY = process.env.KORA_SECRET_KEY;
const KORA_PUBLIC_KEY = process.env.KORA_PUBLIC_KEY;
const USER_PIN = process.env.EBILLS_USER_PIN;

let token = null;

// === RESEND EMAIL FUNCTION ===
async function sendEmail(to, subject, html) {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Highest Data <no-reply@highestdata.com.ng>",
        to,
        subject,
        html,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      console.error("Resend error:", err);
    } else {
      console.log(`Email sent → ${to}: ${subject}`);
    }
  } catch (error) {
    console.error("Resend failed:", error.message);
  }
}

// === MIDDLEWARE ===
app.use(
  cors({
    origin: (origin, callback) => {
      const allowed = [
        "http://localhost:3000",
        "https://www.highestdata.com.ng",
        "https://highestdata.com.ng",
        "https://higestdata-proxy.onrender.com",
      ];
      if (
        !origin ||
        allowed.includes(origin) ||
        origin?.includes("localhost")
      ) {
        callback(null, true);
      } else {
        console.log("CORS blocked:", origin);
        callback(new Error("Not allowed"));
      }
    },
    credentials: true,
  })
);

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// === AUTH HELPER ===
async function verifyFirebaseToken(idToken) {
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    return decoded.uid;
  } catch (err) {
    throw new Error("Invalid Firebase token");
  }
}

// === eBILLS AUTH ===
async function getAccessToken() {
  if (token) return token;
  const res = await fetch(EBILLS_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: process.env.EBILLS_USERNAME,
      password: process.env.EBILLS_PASSWORD,
    }),
  });
  if (!res.ok) throw new Error("eBills auth failed");
  const data = await res.json();
  token = data.token;
  return token;
}

// === KORA: Initialize Payment ===
// === KORA: Initialize Payment ===
app.post("/api/kora/initialize", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer "))
    return res.status(401).json({ error: "Unauthorized" });
  const idToken = authHeader.split("Bearer ")[1];

  let userId;
  try {
    userId = await verifyFirebaseToken(idToken);
  } catch (err) {
    return res.status(401).json({ error: err.message });
  }

  const { amount } = req.body;
  if (!amount || amount < 100)
    return res.status(400).json({ error: "Minimum ₦100" });

  try {
    console.log("Initializing payment for user:", userId, "amount:", amount);

    const userSnap = await db.collection("users").doc(userId).get();
    const userData = userSnap.data();

    if (!userData) {
      return res.status(404).json({ error: "User not found" });
    }

    const reference = `KRA_${userId}_${Date.now()}`;
    console.log("Creating transaction with reference:", reference);

    await db
      .collection("koraTransactions")
      .doc(reference)
      .set({
        userId,
        reference,
        amount: Number(amount),
        status: "pending",
        email: userData.email,
        name: userData.fullName || userData.email.split("@")[0],
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    const responseData = {
      publicKey: KORA_PUBLIC_KEY,
      reference,
      amount: Number(amount),
      currency: "NGN",
      customer: {
        name: userData.fullName || "Customer",
        email: userData.email,
      },
    };

    console.log("Sending initialization response:", responseData);

    res.json(responseData);
  } catch (error) {
    console.error("Kora init error:", error);
    res.status(500).json({ error: "Failed to initialize payment" });
  }
});

// === KORA: Verify & Credit Wallet + EMAIL ===
app.post("/api/kora/verify-and-credit", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer "))
    return res.status(401).json({ error: "Unauthorized" });
  const idToken = authHeader.split("Bearer ")[1];

  let userId;
  try {
    userId = await verifyFirebaseToken(idToken);
  } catch (err) {
    return res.status(401).json({ error: err.message });
  }

  const { reference } = req.body;
  if (!reference) return res.status(400).json({ error: "Reference required" });

  try {
    const txnDoc = await db.collection("koraTransactions").doc(reference).get();
    if (!txnDoc.exists)
      return res.status(404).json({ error: "Transaction not found" });
    if (txnDoc.data().status === "success")
      return res.json({ success: true, message: "Already credited" });

    const koraRes = await fetch(
      `https://api.korapay.com/merchant/api/v1/charges/${reference}`,
      {
        headers: { Authorization: `Bearer ${KORA_SECRET_KEY}` },
      }
    );
    const koraData = await koraRes.json();

    if (!koraData.status || koraData.data?.status !== "success") {
      return res.status(400).json({ error: "Payment failed" });
    }

    const amount = parseFloat(koraData.data.amount);
    const userSnap = await db.collection("users").doc(userId).get();
    const userData = userSnap.data();

    const batch = db.batch();

    batch.update(db.collection("users").doc(userId), {
      walletBalance: admin.firestore.FieldValue.increment(amount),
    });

    batch.update(txnDoc.ref, {
      status: "success",
      processedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    batch.set(
      db.collection("users").doc(userId).collection("transactions").doc(),
      {
        userId,
        reference,
        description: "Wallet funding via KoraPay",
        amount,
        type: "credit",
        status: "success",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }
    );

    await batch.commit();

    // SEND SUCCESS EMAIL
    await sendEmail(
      userData.email,
      "Wallet Funded Successfully!",
      `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 30px; border: 1px solid #eee; border-radius: 10px;">
        <h2 style="color: #10b981;">Payment Successful</h2>
        <p>Hello <strong>${userData.fullName || userData.email}</strong>,</p>
        <p>Your wallet has been credited with <strong>₦${amount.toLocaleString()}</strong>.</p>
        <p><strong>Reference:</strong> ${reference}</p>
        <p>Thank you for choosing Highest Data!</p>
      </div>`
    );

    res.json({ success: true, amount, message: "Wallet credited!" });
  } catch (error) {
    console.error("Verify error:", error);
    res.status(500).json({ error: "Verification failed" });
  }
});

// === COMPLETE KORA WEBHOOK - PAYIN & PAYOUT ===
app.post(
  "/webhook/kora",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const signature = req.headers["x-korapay-signature"];
      if (!signature) {
        console.log("No signature in webhook");
        return res.status(400).send("No signature");
      }

      // Verify webhook signature
      const hash = crypto
        .createHmac("sha256", KORA_SECRET_KEY)
        .update(JSON.stringify(req.body.data))
        .digest("hex");

      if (hash !== signature) {
        console.log("Invalid webhook signature");
        return res.status(403).send("Invalid signature");
      }

      const { event, data } = req.body;
      console.log(`Webhook received: ${event}`, data);

      // Immediately respond to prevent retries
      res.status(200).send("Webhook received");

      // Process based on event type
      if (event === "charge.success") {
        await handlePayinSuccess(data);
      } else if (event === "charge.failed") {
        await handlePayinFailed(data);
      } else if (event === "transfer.success") {
        await handlePayoutSuccess(data);
      } else if (event === "transfer.failed") {
        await handlePayoutFailed(data);
      } else {
        console.log(`Unhandled event type: ${event}`);
      }
    } catch (error) {
      console.error("Webhook processing error:", error);
      res.status(500).send("Webhook processing error");
    }
  }
);

// === PAYIN SUCCESS HANDLER ===
async function handlePayinSuccess(data) {
  const { reference, amount, fee, currency } = data;

  try {
    // Find transaction in koraTransactions collection
    const txnDoc = await db.collection("koraTransactions").doc(reference).get();

    if (!txnDoc.exists) {
      console.log(`Payin transaction not found: ${reference}`);
      return;
    }

    const txnData = txnDoc.data();

    // Skip if already processed
    if (txnData.status === "success") {
      console.log(`Payin already processed: ${reference}`);
      return;
    }

    const userId = txnData.userId;
    const userSnap = await db.collection("users").doc(userId).get();
    const userData = userSnap.data();

    const batch = db.batch();

    // Credit user wallet
    batch.update(db.collection("users").doc(userId), {
      walletBalance: admin.firestore.FieldValue.increment(amount),
    });

    // Update transaction status
    batch.update(txnDoc.ref, {
      status: "success",
      processedAt: admin.firestore.FieldValue.serverTimestamp(),
      webhookProcessed: true,
    });

    // Add to user transactions
    batch.set(
      db
        .collection("users")
        .doc(userId)
        .collection("transactions")
        .doc(reference),
      {
        userId,
        reference,
        description: "Wallet funding via KoraPay",
        amount,
        fee,
        currency,
        type: "credit",
        status: "success",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        webhookProcessed: true,
      }
    );

    await batch.commit();

    // Send success email
    await sendEmail(
      userData.email,
      "Wallet Funded Successfully!",
      `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 30px; border: 1px solid #eee; border-radius: 10px;">
        <h2 style="color: #10b981;">Payment Successful</h2>
        <p>Hello <strong>${userData.fullName || userData.email}</strong>,</p>
        <p>Your wallet has been credited with <strong>₦${amount.toLocaleString()}</strong>.</p>
        <p><strong>Reference:</strong> ${reference}</p>
        <p><strong>Fee:</strong> ₦${fee?.toLocaleString() || "0"}</p>
        <p>Thank you for choosing Highest Data!</p>
      </div>`
    );

    console.log(`Payin processed successfully: ${reference}`);
  } catch (error) {
    console.error(`Error processing payin success: ${reference}`, error);
  }
}

// === PAYIN FAILED HANDLER ===
async function handlePayinFailed(data) {
  const { reference } = data;

  try {
    const txnDoc = await db.collection("koraTransactions").doc(reference).get();

    if (!txnDoc.exists) {
      console.log(`Failed payin transaction not found: ${reference}`);
      return;
    }

    const txnData = txnDoc.data();

    // Update transaction status to failed
    await txnDoc.ref.update({
      status: "failed",
      failedAt: admin.firestore.FieldValue.serverTimestamp(),
      webhookProcessed: true,
    });

    console.log(`Payin marked as failed: ${reference}`);
  } catch (error) {
    console.error(`Error processing payin failed: ${reference}`, error);
  }
}

// === PAYOUT SUCCESS HANDLER ===
async function handlePayoutSuccess(data) {
  const { reference, amount, fee } = data;

  try {
    const withdrawalDoc = await db
      .collection("withdrawalRequests")
      .doc(reference)
      .get();

    if (!withdrawalDoc.exists) {
      console.log(`Payout transaction not found: ${reference}`);
      return;
    }

    const w = withdrawalDoc.data();

    // Skip if already processed
    if (w.status === "completed") {
      console.log(`Payout already processed: ${reference}`);
      return;
    }

    const userSnap = await db.collection("users").doc(w.userId).get();
    const user = userSnap.data();

    const batch = db.batch();

    // Update withdrawal request
    batch.update(withdrawalDoc.ref, {
      status: "completed",
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      webhookProcessed: true,
    });

    // Update user transaction
    const userTxnRef = db
      .collection("users")
      .doc(w.userId)
      .collection("transactions")
      .doc(reference);
    batch.update(userTxnRef, {
      status: "success",
      webhookProcessed: true,
    });

    await batch.commit();

    // Send success email
    await sendEmail(
      user.email,
      `Withdrawal Successful - ₦${w.amount.toLocaleString()}`,
      `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 30px; border: 1px solid #eee; border-radius: 10px;">
        <h2 style="color: #10b981;">Withdrawal Completed</h2>
        <p>Hello <strong>${user.fullName || user.email}</strong>,</p>
        <p><strong>₦${w.amount.toLocaleString()}</strong> has been successfully sent to your bank account.</p>
        <p><strong>Account:</strong> ${w.accountName} - ${w.accountNumber}</p>
        <p><strong>Reference:</strong> ${reference}</p>
        <p><strong>Fee:</strong> ₦${w.fee?.toLocaleString() || "50"}</p>
        <p>Thank you for using Highest Data!</p>
      </div>`
    );

    console.log(`Payout processed successfully: ${reference}`);
  } catch (error) {
    console.error(`Error processing payout success: ${reference}`, error);
  }
}

// === PAYOUT FAILED HANDLER ===
async function handlePayoutFailed(data) {
  const { reference } = data;

  try {
    const withdrawalDoc = await db
      .collection("withdrawalRequests")
      .doc(reference)
      .get();

    if (!withdrawalDoc.exists) {
      console.log(`Failed payout transaction not found: ${reference}`);
      return;
    }

    const w = withdrawalDoc.data();

    // Skip if already processed
    if (w.status === "failed") {
      console.log(`Payout already marked as failed: ${reference}`);
      return;
    }

    const userSnap = await db.collection("users").doc(w.userId).get();
    const user = userSnap.data();

    const batch = db.batch();

    // Refund wallet balance
    batch.update(db.collection("users").doc(w.userId), {
      walletBalance: admin.firestore.FieldValue.increment(w.totalAmount),
    });

    // Update withdrawal request
    batch.update(withdrawalDoc.ref, {
      status: "failed",
      failedAt: admin.firestore.FieldValue.serverTimestamp(),
      webhookProcessed: true,
    });

    // Update user transaction
    const userTxnRef = db
      .collection("users")
      .doc(w.userId)
      .collection("transactions")
      .doc(reference);
    batch.update(userTxnRef, {
      status: "failed",
      webhookProcessed: true,
    });

    await batch.commit();

    // Send failure email
    await sendEmail(
      user.email,
      "Withdrawal Failed - Refunded",
      `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 30px; border: 1px solid #eee; border-radius: 10px;">
        <h2 style="color: #ef4444;">Withdrawal Failed</h2>
        <p>Hello <strong>${user.fullName || user.email}</strong>,</p>
        <p>Your withdrawal of <strong>₦${w.amount.toLocaleString()}</strong> has failed.</p>
        <p><strong>₦${w.totalAmount.toLocaleString()}</strong> has been refunded to your wallet balance.</p>
        <p><strong>Reference:</strong> ${reference}</p>
        <p>Please try again or contact support if the issue persists.</p>
      </div>`
    );

    console.log(`Payout failed and refunded: ${reference}`);
  } catch (error) {
    console.error(`Error processing payout failed: ${reference}`, error);
  }
}

// === WEBHOOK FOR eBILLS (async transactions) ===
app.post("/webhook", async (req, res) => {
  const signature = req.headers["x-signature"];
  const payload = req.rawBody.toString();
  const hash = crypto
    .createHmac("sha256", USER_PIN)
    .update(payload)
    .digest("hex");
  if (hash !== signature) return res.status(403).json({ error: "Invalid sig" });

  const { request_id, status } = req.body;
  const snapshot = await db
    .collectionGroup("transactions")
    .where("requestId", "==", request_id)
    .where("pending", "==", true)
    .get();

  if (snapshot.empty) return res.json({ status: "no pending txn" });

  const batch = db.batch();
  snapshot.forEach((doc) => {
    const data = doc.data();
    const isSuccess = ["completed-api", "ORDER COMPLETED", "success"].includes(
      status
    );
    if (isSuccess) {
      batch.update(doc.ref, { status: "success", pending: false });
      batch.update(db.collection("users").doc(data.userId), {
        walletBalance: admin.firestore.FieldValue.increment(-data.amount),
      });
    } else {
      batch.update(doc.ref, { status: "failed", pending: false });
    }
  });

  await batch.commit();
  res.json({ status: "success" });
});

// === WITHDRAWAL: Send OTP ===
app.post("/api/withdrawal/send-otp", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer "))
    return res.status(401).json({ error: "Unauthorized" });
  const idToken = authHeader.split("Bearer ")[1];

  let userId;
  try {
    userId = await verifyFirebaseToken(idToken);
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }

  const userDoc = await db.collection("users").doc(userId).get();
  const userData = userDoc.data();
  const otp = Math.floor(100000 + Math.random() * 900000).toString();

  await db
    .collection("users")
    .doc(userId)
    .update({
      verificationToken: otp,
      verificationTokenExpiry: new Date(
        Date.now() + 10 * 60 * 1000
      ).toISOString(),
    });

  await sendEmail(
    userData.email,
    "Your Withdrawal OTP",
    `<h2 style="color:#4f46e5;">Highest Data</h2>
     <h3>Your OTP: <span style="font-size:32px;color:#10b981;letter-spacing:8px;">${otp}</span></h3>
     <p>Valid for 10 minutes</p>`
  );

  res.json({ success: true });
});

// === WITHDRAWAL: Verify OTP ===
app.post("/api/withdrawal/verify-otp", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer "))
    return res.status(401).json({ error: "Unauthorized" });
  const idToken = authHeader.split("Bearer ")[1];

  let userId;
  try {
    userId = await verifyFirebaseToken(idToken);
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }

  const { otp } = req.body;
  if (!otp) return res.status(400).json({ error: "OTP required" });

  try {
    const userDoc = await db.collection("users").doc(userId).get();
    const userData = userDoc.data();

    if (!userData.verificationToken || !userData.verificationTokenExpiry) {
      return res.status(400).json({ error: "OTP not requested" });
    }

    if (userData.verificationToken !== otp) {
      return res.status(400).json({ error: "Invalid OTP" });
    }

    if (new Date() > new Date(userData.verificationTokenExpiry)) {
      return res.status(400).json({ error: "OTP expired" });
    }

    // Clear OTP after successful verification
    await db.collection("users").doc(userId).update({
      verificationToken: null,
      verificationTokenExpiry: null,
    });

    res.json({ success: true, message: "OTP verified successfully" });
  } catch (error) {
    console.error("OTP verification error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// === GET BANKS LIST ===
app.get("/api/banks", async (req, res) => {
  try {
    console.log("Fetching banks from KoraPay...");

    const koraRes = await fetch(
      "https://api.korapay.com/merchant/api/v1/misc/banks?countryCode=NG",
      {
        headers: {
          Authorization: `Bearer ${KORA_PUBLIC_KEY}`, // Use PUBLIC key for this endpoint
          "Content-Type": "application/json",
        },
      }
    );

    console.log("KoraPay banks response status:", koraRes.status);

    const data = await koraRes.json();
    console.log("KoraPay banks response data received");

    if (koraRes.ok && data.status) {
      // Format the banks data to match what the frontend expects
      const formattedBanks = data.data.map((bank) => ({
        code: bank.code,
        name: bank.name,
        nibss_bank_code: bank.nibss_bank_code,
      }));

      res.json({
        success: true,
        data: formattedBanks,
        message: "Banks fetched successfully",
      });
    } else {
      console.error("KoraPay banks API error:", data);
      res.status(koraRes.status).json({
        success: false,
        error: data.message || "Failed to fetch banks from payment provider",
        koraError: data,
      });
    }
  } catch (error) {
    console.error("Banks fetch error:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error while fetching banks",
      details: error.message,
    });
  }
});

// === RESOLVE ACCOUNT NUMBER ===
app.post("/api/resolve-account", async (req, res) => {
  const { bankCode, accountNumber } = req.body;

  if (!bankCode || !accountNumber) {
    return res.status(400).json({
      success: false,
      error: "Bank code and account number are required",
    });
  }

  try {
    console.log("Resolving account:", { bankCode, accountNumber });

    const koraRes = await fetch(
      "https://api.korapay.com/merchant/api/v1/misc/banks/resolve",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${KORA_SECRET_KEY}`, // Use SECRET key for this endpoint
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          bank: bankCode,
          account: accountNumber,
        }),
      }
    );

    console.log("KoraPay resolve response status:", koraRes.status);

    const data = await koraRes.json();
    console.log("KoraPay resolve response:", data);

    if (koraRes.ok && data.status) {
      res.json({
        success: true,
        data: data.data,
        message: "Account resolved successfully",
      });
    } else {
      console.error("KoraPay resolve API error:", data);
      res.status(koraRes.status).json({
        success: false,
        error: data.message || "Failed to resolve account number",
        koraError: data,
      });
    }
  } catch (error) {
    console.error("Account resolution error:", error);
    res.status(500).json({
      success: false,
      error: "Internal server error while resolving account",
      details: error.message,
    });
  }
});

// === WITHDRAWAL: Process (User submits) ===
app.post("/api/withdrawal/process", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer "))
    return res.status(401).json({ error: "Unauthorized" });
  const idToken = authHeader.split("Bearer ")[1];

  let userId;
  try {
    userId = await verifyFirebaseToken(idToken);
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }

  const { amount, bankCode, accountNumber, accountName } = req.body;
  const withdrawalAmount = parseFloat(amount);
  const FEE = 50;
  const totalAmount = withdrawalAmount + FEE;

  const userDoc = await db.collection("users").doc(userId).get();
  const userData = userDoc.data();

  if (totalAmount > userData.walletBalance)
    return res.status(400).json({ error: "Insufficient balance" });

  const reference = `WDR_${userId}_${Date.now()}`;

  const batch = db.batch();

  // Deduct from wallet
  batch.update(db.collection("users").doc(userId), {
    walletBalance: admin.firestore.FieldValue.increment(-totalAmount),
  });

  // Create withdrawal request
  batch.set(db.collection("withdrawalRequests").doc(reference), {
    userId,
    reference,
    amount: withdrawalAmount,
    totalAmount,
    fee: FEE,
    bankCode,
    accountNumber,
    accountName,
    status: "processing",
    userEmail: userData.email,
    userName: userData.fullName || userData.email,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Create user transaction record
  batch.set(
    db
      .collection("users")
      .doc(userId)
      .collection("transactions")
      .doc(reference),
    {
      userId,
      reference,
      description: `Withdrawal to ${accountName}`,
      amount: -totalAmount,
      type: "debit",
      status: "processing",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }
  );

  await batch.commit();

  // Initiate payout via Kora
  try {
    const koraRes = await fetch(
      "https://api.korapay.com/merchant/api/v1/transactions/disburse",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${KORA_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          reference,
          destination: {
            type: "bank_account",
            amount: withdrawalAmount,
            currency: "NGN",
            narration: "Withdrawal from Highest Data",
            bank_account: {
              bank: bankCode,
              account: accountNumber,
              account_name: accountName,
            },
          },
          customer: {
            name: userData.fullName || userData.email,
            email: userData.email,
          },
        }),
      }
    );

    const koraData = await koraRes.json();

    if (!koraData.status) {
      // Refund on immediate failure
      const refundBatch = db.batch();
      refundBatch.update(db.collection("users").doc(userId), {
        walletBalance: admin.firestore.FieldValue.increment(totalAmount),
      });
      refundBatch.update(db.collection("withdrawalRequests").doc(reference), {
        status: "failed",
        failureReason: koraData.message || "Payout initiation failed",
      });
      refundBatch.update(
        db
          .collection("users")
          .doc(userId)
          .collection("transactions")
          .doc(reference),
        { status: "failed" }
      );
      await refundBatch.commit();

      return res.status(400).json({
        error: koraData.message || "Payout failed to initiate",
      });
    }

    res.json({
      success: true,
      reference,
      message: "Withdrawal processing started",
    });
  } catch (error) {
    console.error("Kora payout initiation error:", error);

    // Refund on network error
    const refundBatch = db.batch();
    refundBatch.update(db.collection("users").doc(userId), {
      walletBalance: admin.firestore.FieldValue.increment(totalAmount),
    });
    refundBatch.update(db.collection("withdrawalRequests").doc(reference), {
      status: "failed",
      failureReason: "Network error during payout initiation",
    });
    refundBatch.update(
      db
        .collection("users")
        .doc(userId)
        .collection("transactions")
        .doc(reference),
      { status: "failed" }
    );
    await refundBatch.commit();

    res.status(500).json({ error: "Failed to initiate payout" });
  }
});

// === HEALTH CHECK ===
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "Highest Data Backend",
  });
});

// === WEBHOOK TEST ENDPOINT ===
app.get("/webhook/test", (req, res) => {
  res.json({
    message: "Webhook endpoint is accessible",
    url: "/webhook/kora",
    method: "POST",
  });
});

// === START SERVER ===
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Backend running on port ${PORT}`);
  console.log(`Live at: https://higestdata-proxy.onrender.com`);
  console.log(
    `Kora Webhook: https://higestdata-proxy.onrender.com/webhook/kora`
  );
  console.log(`Health Check: https://higestdata-proxy.onrender.com/health`);
});
