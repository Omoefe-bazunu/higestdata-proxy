// server.js - UPDATED WITH VTU AFRICA API INTEGRATION
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
const VTU_AFRICA_API_URL = "https://vtuafrica.com.ng/portal/api";
const VTU_AFRICA_SANDBOX_URL = "https://vtuafrica.com.ng/portal/api-test";
const VTU_AFRICA_API_KEY = process.env.VTU_AFRICA_API_KEY;
const KORA_SECRET_KEY = process.env.KORA_SECRET_KEY;
const KORA_PUBLIC_KEY = process.env.KORA_PUBLIC_KEY;

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

// === VTU AFRICA HELPER FUNCTION ===
async function makeVtuAfricaRequest(endpoint, params) {
  try {
    const baseParams = {
      apikey: VTU_AFRICA_API_KEY,
      ...params,
    };

    const queryString = new URLSearchParams(baseParams).toString();
    const url = `${VTU_AFRICA_API_URL}/${endpoint}/?${queryString}`;

    console.log(`VTU Africa Request: ${url}`);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });

    const data = await response.json();
    console.log(`VTU Africa Response:`, data);

    return data;
  } catch (error) {
    console.error("VTU Africa API Error:", error);
    throw new Error(`VTU Africa API request failed: ${error.message}`);
  }
}

// === AIRTIME PURCHASE ===
app.post("/api/airtime/purchase", async (req, res) => {
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

  const { network, phone, amount, ref } = req.body;

  if (!network || !phone || !amount || !ref) {
    return res.status(400).json({ error: "Missing required parameters" });
  }

  try {
    const userDoc = await db.collection("users").doc(userId).get();
    const userData = userDoc.data();

    if (amount > userData.walletBalance) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    // Make VTU Africa API call
    const vtuResponse = await makeVtuAfricaRequest("airtime", {
      network,
      phone,
      amount,
      ref,
    });

    if (vtuResponse.code === 101) {
      // Deduct from wallet
      await db
        .collection("users")
        .doc(userId)
        .update({
          walletBalance: admin.firestore.FieldValue.increment(-amount),
        });

      // Record transaction
      await db
        .collection("users")
        .doc(userId)
        .collection("transactions")
        .add({
          userId,
          type: "airtime",
          network,
          phone,
          amount,
          reference: ref,
          status: "success",
          description: `${network} Airtime to ${phone}`,
          vtuResponse: vtuResponse,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

      res.json({
        success: true,
        message: "Airtime purchase successful",
        data: vtuResponse,
      });
    } else {
      res.status(400).json({
        error: vtuResponse.description?.message || "Airtime purchase failed",
        data: vtuResponse,
      });
    }
  } catch (error) {
    console.error("Airtime purchase error:", error);
    res.status(500).json({ error: error.message });
  }
});

// === DATA PURCHASE ===
app.post("/api/data/purchase", async (req, res) => {
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

  const { service, MobileNumber, DataPlan, ref } = req.body;

  if (!service || !MobileNumber || !DataPlan || !ref) {
    return res.status(400).json({ error: "Missing required parameters" });
  }

  try {
    const userDoc = await db.collection("users").doc(userId).get();
    const userData = userDoc.data();

    // Make VTU Africa API call
    const vtuResponse = await makeVtuAfricaRequest("data", {
      service,
      MobileNumber,
      DataPlan,
      ref,
    });

    if (vtuResponse.code === 101) {
      const amountCharged = parseFloat(vtuResponse.description.Amount_Charged);

      // Deduct from wallet
      await db
        .collection("users")
        .doc(userId)
        .update({
          walletBalance: admin.firestore.FieldValue.increment(-amountCharged),
        });

      // Record transaction
      await db
        .collection("users")
        .doc(userId)
        .collection("transactions")
        .add({
          userId,
          type: "data",
          service,
          phone: MobileNumber,
          dataPlan: DataPlan,
          amount: amountCharged,
          reference: ref,
          status: "success",
          description: `${service} Data to ${MobileNumber}`,
          vtuResponse: vtuResponse,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

      res.json({
        success: true,
        message: "Data purchase successful",
        data: vtuResponse,
      });
    } else {
      res.status(400).json({
        error: vtuResponse.description?.message || "Data purchase failed",
        data: vtuResponse,
      });
    }
  } catch (error) {
    console.error("Data purchase error:", error);
    res.status(500).json({ error: error.message });
  }
});

// === CABLE TV SUBSCRIPTION ===
app.post("/api/cabletv/purchase", async (req, res) => {
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

  const { service, smartNo, variation, ref } = req.body;

  if (!service || !smartNo || !variation || !ref) {
    return res.status(400).json({ error: "Missing required parameters" });
  }

  try {
    const userDoc = await db.collection("users").doc(userId).get();
    const userData = userDoc.data();

    // Make VTU Africa API call
    const vtuResponse = await makeVtuAfricaRequest("paytv", {
      service,
      smartNo,
      variation,
      ref,
    });

    if (vtuResponse.code === 101) {
      const amountCharged = parseFloat(vtuResponse.description.Amount_Charged);

      // Deduct from wallet
      await db
        .collection("users")
        .doc(userId)
        .update({
          walletBalance: admin.firestore.FieldValue.increment(-amountCharged),
        });

      // Record transaction
      await db
        .collection("users")
        .doc(userId)
        .collection("transactions")
        .add({
          userId,
          type: "cabletv",
          service,
          smartCard: smartNo,
          variation,
          amount: amountCharged,
          reference: ref,
          status: "success",
          description: `${service} Subscription for ${smartNo}`,
          vtuResponse: vtuResponse,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

      res.json({
        success: true,
        message: "Cable TV subscription successful",
        data: vtuResponse,
      });
    } else {
      res.status(400).json({
        error:
          vtuResponse.description?.message || "Cable TV subscription failed",
        data: vtuResponse,
      });
    }
  } catch (error) {
    console.error("Cable TV purchase error:", error);
    res.status(500).json({ error: error.message });
  }
});

// === ELECTRICITY BILL PAYMENT ===
app.post("/api/electricity/purchase", async (req, res) => {
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

  const { service, meterNo, metertype, amount, ref } = req.body;

  if (!service || !meterNo || !metertype || !amount || !ref) {
    return res.status(400).json({ error: "Missing required parameters" });
  }

  try {
    const userDoc = await db.collection("users").doc(userId).get();
    const userData = userDoc.data();

    if (amount > userData.walletBalance) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    // Make VTU Africa API call
    const vtuResponse = await makeVtuAfricaRequest("electric", {
      service,
      meterNo,
      metertype,
      amount,
      ref,
    });

    if (vtuResponse.code === 101) {
      const amountCharged = parseFloat(vtuResponse.description.Amount_Charged);

      // Deduct from wallet
      await db
        .collection("users")
        .doc(userId)
        .update({
          walletBalance: admin.firestore.FieldValue.increment(-amountCharged),
        });

      // Record transaction
      await db
        .collection("users")
        .doc(userId)
        .collection("transactions")
        .add({
          userId,
          type: "electricity",
          service,
          meterNumber: meterNo,
          meterType: metertype,
          amount: amountCharged,
          reference: ref,
          status: "success",
          description: `${service} Bill payment for ${meterNo}`,
          vtuResponse: vtuResponse,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

      res.json({
        success: true,
        message: "Electricity bill payment successful",
        data: vtuResponse,
      });
    } else {
      res.status(400).json({
        error:
          vtuResponse.description?.message || "Electricity bill payment failed",
        data: vtuResponse,
      });
    }
  } catch (error) {
    console.error("Electricity purchase error:", error);
    res.status(500).json({ error: error.message });
  }
});

// === EXAM SCRATCH CARDS ===
app.post("/api/exam/purchase", async (req, res) => {
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

  const { service, product_code, quantity, ref, profilecode, sender, phone } =
    req.body;

  if (!service || !product_code || !quantity || !ref) {
    return res.status(400).json({ error: "Missing required parameters" });
  }

  try {
    const userDoc = await db.collection("users").doc(userId).get();
    const userData = userDoc.data();

    // Build parameters
    const params = {
      service,
      product_code,
      quantity,
      ref,
      webhookURL: "https://higestdata-proxy.onrender.com/webhook/vtu",
    };

    // Add optional parameters if provided
    if (profilecode) params.profilecode = profilecode;
    if (sender) params.sender = sender;
    if (phone) params.phone = phone;

    // Make VTU Africa API call
    const vtuResponse = await makeVtuAfricaRequest("exam-pin", params);

    if (vtuResponse.code === 101) {
      const amountCharged = parseFloat(vtuResponse.description.Amount_Charged);

      // Deduct from wallet
      await db
        .collection("users")
        .doc(userId)
        .update({
          walletBalance: admin.firestore.FieldValue.increment(-amountCharged),
        });

      // Record transaction
      await db
        .collection("users")
        .doc(userId)
        .collection("transactions")
        .add({
          userId,
          type: "exam",
          service,
          productCode: product_code,
          quantity,
          amount: amountCharged,
          reference: ref,
          status: "success",
          description: `${service} Exam PIN Purchase`,
          vtuResponse: vtuResponse,
          pins: vtuResponse.description.pins,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

      res.json({
        success: true,
        message: "Exam PIN purchase successful",
        data: vtuResponse,
      });
    } else {
      res.status(400).json({
        error: vtuResponse.description?.message || "Exam PIN purchase failed",
        data: vtuResponse,
      });
    }
  } catch (error) {
    console.error("Exam PIN purchase error:", error);
    res.status(500).json({ error: error.message });
  }
});

// === AIRTIME TO CASH CONVERSION ===
app.post("/api/airtime-cash/verify", async (req, res) => {
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

  const { network } = req.body;

  if (!network) {
    return res.status(400).json({ error: "Network parameter required" });
  }

  try {
    // Make VTU Africa verification call
    const vtuResponse = await makeVtuAfricaRequest("merchant-verify", {
      serviceName: "Airtime2Cash",
      network,
    });

    if (vtuResponse.code === 101) {
      res.json({
        success: true,
        message: "Airtime to cash service available",
        data: vtuResponse,
      });
    } else {
      res.status(400).json({
        error:
          vtuResponse.description?.message ||
          "Airtime to cash service not available",
        data: vtuResponse,
      });
    }
  } catch (error) {
    console.error("Airtime cash verification error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/airtime-cash/convert", async (req, res) => {
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

  const { network, sender, sendernumber, amount, ref, sitephone } = req.body;

  if (!network || !sender || !sendernumber || !amount || !ref) {
    return res.status(400).json({ error: "Missing required parameters" });
  }

  try {
    const userDoc = await db.collection("users").doc(userId).get();
    const userData = userDoc.data();

    // Build parameters
    const params = {
      network,
      sender,
      sendernumber,
      amount,
      ref,
      webhookURL: "https://higestdata-proxy.onrender.com/webhook/vtu",
    };

    if (sitephone) params.sitephone = sitephone;

    // Make VTU Africa API call
    const vtuResponse = await makeVtuAfricaRequest("airtime-cash", params);

    if (vtuResponse.code === 101) {
      // Record transaction (no wallet deduction as user sends airtime directly)
      await db
        .collection("users")
        .doc(userId)
        .collection("transactions")
        .add({
          userId,
          type: "airtime_cash",
          network,
          sender,
          sendernumber,
          amount,
          reference: ref,
          status: "processing",
          description: `Airtime to Cash conversion for ${sendernumber}`,
          vtuResponse: vtuResponse,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

      res.json({
        success: true,
        message: "Airtime conversion request received",
        data: vtuResponse,
      });
    } else {
      res.status(400).json({
        error: vtuResponse.description?.message || "Airtime conversion failed",
        data: vtuResponse,
      });
    }
  } catch (error) {
    console.error("Airtime cash conversion error:", error);
    res.status(500).json({ error: error.message });
  }
});

// === BETTING VERIFICATION ===
app.post("/api/betting/verify", async (req, res) => {
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

  const { service, userid } = req.body;

  if (!service || !userid) {
    return res.status(400).json({ error: "Service and user ID required" });
  }

  try {
    // Make VTU Africa verification call
    const vtuResponse = await makeVtuAfricaRequest("merchant-verify", {
      serviceName: "Betting",
      service,
      userid,
    });

    if (vtuResponse.code === 101) {
      res.json({
        success: true,
        message: "Betting account verified",
        data: vtuResponse,
      });
    } else {
      res.status(400).json({
        error:
          vtuResponse.description?.message ||
          "Betting account verification failed",
        data: vtuResponse,
      });
    }
  } catch (error) {
    console.error("Betting verification error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/betting/fund", async (req, res) => {
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

  const { service, userid, amount, ref, phone } = req.body;

  if (!service || !userid || !amount || !ref) {
    return res.status(400).json({ error: "Missing required parameters" });
  }

  try {
    const userDoc = await db.collection("users").doc(userId).get();
    const userData = userDoc.data();

    // Make VTU Africa API call
    const vtuResponse = await makeVtuAfricaRequest("betpay", {
      service,
      userid,
      amount,
      ref,
      phone,
      webhookURL: "https://higestdata-proxy.onrender.com/webhook/vtu",
    });

    if (vtuResponse.code === 101) {
      const amountCharged = parseFloat(vtuResponse.description.Amount_Charged);

      // Deduct from wallet
      await db
        .collection("users")
        .doc(userId)
        .update({
          walletBalance: admin.firestore.FieldValue.increment(-amountCharged),
        });

      // Record transaction
      await db
        .collection("users")
        .doc(userId)
        .collection("transactions")
        .add({
          userId,
          type: "betting",
          service,
          userid,
          amount: amountCharged,
          reference: ref,
          status: "success",
          description: `${service} Account Funding for ${userid}`,
          vtuResponse: vtuResponse,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

      res.json({
        success: true,
        message: "Betting account funded successfully",
        data: vtuResponse,
      });
    } else {
      res.status(400).json({
        error: vtuResponse.description?.message || "Betting funding failed",
        data: vtuResponse,
      });
    }
  } catch (error) {
    console.error("Betting funding error:", error);
    res.status(500).json({ error: error.message });
  }
});

// === VTU AFRICA WEBHOOK HANDLER ===
app.post("/webhook/vtu", async (req, res) => {
  try {
    const payload = req.body;
    console.log("VTU Africa Webhook Received:", payload);

    // Immediately respond to prevent retries
    res
      .status(200)
      .json({
        code: 101,
        status: "Completed",
        message: "Webhook received successfully",
      });

    // Process webhook based on service type
    if (payload.service === "Airtime2Cash" && payload.status === "Completed") {
      // Handle airtime to cash completion
      const { ref, amount, credit, sender } = payload;

      // Find and update the transaction
      const transactionsSnapshot = await db
        .collectionGroup("transactions")
        .where("reference", "==", ref)
        .where("type", "==", "airtime_cash")
        .get();

      if (!transactionsSnapshot.empty) {
        const batch = db.batch();
        transactionsSnapshot.forEach((doc) => {
          batch.update(doc.ref, {
            status: "completed",
            creditAmount: credit,
            webhookProcessed: true,
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        });
        await batch.commit();
        console.log(`Airtime to cash completed for ref: ${ref}`);
      }
    }
  } catch (error) {
    console.error("VTU Africa webhook processing error:", error);
  }
});

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
          Authorization: `Bearer ${KORA_PUBLIC_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("KoraPay banks response status:", koraRes.status);

    const data = await koraRes.json();
    console.log("KoraPay banks response data received");

    if (koraRes.ok && data.status) {
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
          Authorization: `Bearer ${KORA_SECRET_KEY}`,
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

  const bank = await db.collection("banks").doc(bankCode).get();
  let bankName = "Unknown Bank";

  if (bank.exists) {
    bankName = bank.data().name;
  } else {
    try {
      const banksRes = await fetch(
        "https://api.korapay.com/merchant/api/v1/misc/banks?countryCode=NG",
        {
          headers: {
            Authorization: `Bearer ${KORA_PUBLIC_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );

      const banksData = await banksRes.json();
      if (banksData.status) {
        const bankInfo = banksData.data.find((b) => b.code === bankCode);
        if (bankInfo) {
          bankName = bankInfo.name;
          await db.collection("banks").doc(bankCode).set({
            name: bankInfo.name,
            code: bankCode,
          });
        }
      }
    } catch (error) {
      console.error("Failed to fetch bank name:", error);
    }
  }

  const batch = db.batch();

  batch.update(db.collection("users").doc(userId), {
    walletBalance: admin.firestore.FieldValue.increment(-totalAmount),
  });

  batch.set(db.collection("withdrawalRequests").doc(reference), {
    userId,
    reference,
    amount: withdrawalAmount,
    totalAmount,
    fee: FEE,
    bankCode,
    bankName,
    accountNumber,
    accountName,
    status: "processing",
    userEmail: userData.email,
    userName: userData.fullName || userData.email,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

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

  const disbursementData = {
    reference,
    destination: {
      type: "bank_account",
      amount: withdrawalAmount,
      currency: "NGN",
      narration: "Withdrawal from Highest Data",
      bank_account: {
        bank_name: bankName,
        account: accountNumber,
        account_name: accountName,
        beneficiary_type: "individual",
        first_name: accountName.split(" ")[0] || accountName,
        last_name: accountName.split(" ").slice(1).join(" ") || accountName,
        account_number_type: "account_number",
      },
      customer: {
        name: userData.fullName || userData.email,
        email: userData.email,
      },
    },
  };

  console.log(
    "Sending disbursement request:",
    JSON.stringify(disbursementData, null, 2)
  );

  try {
    const koraRes = await fetch(
      "https://api.korapay.com/merchant/api/v1/transactions/disburse",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${KORA_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(disbursementData),
      }
    );

    const koraData = await koraRes.json();
    console.log(
      "KoraPay disbursement response:",
      JSON.stringify(koraData, null, 2)
    );

    if (!koraRes.ok || !koraData.status) {
      console.error("KoraPay disbursement failed:", koraData);

      const refundBatch = db.batch();
      refundBatch.update(db.collection("users").doc(userId), {
        walletBalance: admin.firestore.FieldValue.increment(totalAmount),
      });
      refundBatch.update(db.collection("withdrawalRequests").doc(reference), {
        status: "failed",
        failureReason: koraData.message || "Payout initiation failed",
        failedAt: admin.firestore.FieldValue.serverTimestamp(),
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
        koraError: koraData,
      });
    }

    await db
      .collection("withdrawalRequests")
      .doc(reference)
      .update({
        koraReference: koraData.data?.reference,
        koraFee: koraData.data?.fee,
        status: koraData.data?.status || "processing",
      });

    res.json({
      success: true,
      reference,
      message: "Withdrawal processing started",
      koraResponse: koraData,
    });
  } catch (error) {
    console.error("KoraPay network error:", error);

    const refundBatch = db.batch();
    refundBatch.update(db.collection("users").doc(userId), {
      walletBalance: admin.firestore.FieldValue.increment(totalAmount),
    });
    refundBatch.update(db.collection("withdrawalRequests").doc(reference), {
      status: "failed",
      failureReason: "Network error during payout initiation",
      failedAt: admin.firestore.FieldValue.serverTimestamp(),
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

    res.status(500).json({
      error: "Failed to initiate payout due to network error",
      details: error.message,
    });
  }
});

// === KYC: BVN VERIFICATION WITH KORAPAY ===
app.post("/api/kyc/verify-bvn", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer "))
    return res.status(401).json({ error: "Unauthorized" });
  const idToken = authHeader.split("Bearer ")[1];

  let userId;
  try {
    userId = await verifyFirebaseToken(idToken);
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }

  const { bvn, firstName, lastName, middleName, phone, dob, gender } = req.body;

  if (!bvn || !firstName || !lastName) {
    return res.status(400).json({
      success: false,
      error: "BVN, first name, and last name are required",
    });
  }

  if (bvn.length !== 11 || !/^\d+$/.test(bvn)) {
    return res.status(400).json({
      success: false,
      error: "BVN must be exactly 11 digits",
    });
  }

  try {
    console.log("Starting BVN verification for user:", userId);

    const userDoc = await db.collection("users").doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({
        success: false,
        error: "User not found",
      });
    }

    const userData = userDoc.data();

    if (userData.kycStatus === "approved") {
      return res.status(400).json({
        success: false,
        error: "KYC already approved",
      });
    }

    console.log("Calling KoraPay BVN verification...");
    const koraRes = await fetch(
      "https://api.korapay.com/merchant/api/v1/identities/ng/bvn",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${KORA_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: bvn,
          verification_consent: true,
        }),
      }
    );

    const koraData = await koraRes.json();
    console.log("KoraPay BVN response:", JSON.stringify(koraData, null, 2));

    if (!koraRes.ok || !koraData.status) {
      console.error("KoraPay BVN verification failed:", koraData);

      await db
        .collection("users")
        .doc(userId)
        .update({
          kycStatus: "rejected",
          rejectionReason: koraData.message || "BVN verification failed",
          lastKycAttempt: admin.firestore.FieldValue.serverTimestamp(),
        });

      return res.status(400).json({
        success: false,
        error: koraData.message || "BVN verification failed",
        koraError: koraData,
      });
    }

    const bvnData = koraData.data;
    const validationErrors = [];

    if (
      !bvnData.first_name ||
      !bvnData.first_name.toLowerCase().includes(firstName.toLowerCase())
    ) {
      validationErrors.push("First name doesn't match BVN records");
    }

    if (
      !bvnData.last_name ||
      !bvnData.last_name.toLowerCase().includes(lastName.toLowerCase())
    ) {
      validationErrors.push("Last name doesn't match BVN records");
    }

    if (dob && bvnData.date_of_birth && dob !== bvnData.date_of_birth) {
      validationErrors.push("Date of birth doesn't match BVN records");
    }

    if (validationErrors.length > 0) {
      console.error("BVN data validation failed:", validationErrors);

      await db
        .collection("users")
        .doc(userId)
        .update({
          kycStatus: "rejected",
          rejectionReason: validationErrors.join(", "),
          lastKycAttempt: admin.firestore.FieldValue.serverTimestamp(),
        });

      return res.status(400).json({
        success: false,
        error: "Information doesn't match BVN records",
        errors: validationErrors,
        bvnData: {
          firstName: bvnData.first_name,
          lastName: bvnData.last_name,
          dob: bvnData.date_of_birth,
        },
      });
    }

    const fullName = middleName
      ? `${firstName} ${middleName} ${lastName}`
      : `${firstName} ${lastName}`;

    const updateData = {
      kycStatus: "approved",
      displayName: fullName,
      kycData: {
        firstName,
        lastName,
        middleName: middleName || null,
        phone: phone || null,
        dob: dob || null,
        gender: gender || null,
        bvn: bvn,
        verifiedAt: new Date().toISOString(),
      },
      bvnVerificationData: {
        reference: bvnData.reference,
        koraVerifiedAt: new Date().toISOString(),
        bvnFirstname: bvnData.first_name,
        bvnLastname: bvnData.last_name,
        bvnDob: bvnData.date_of_birth,
        bvnPhone: bvnData.phone_number,
        bvnGender: bvnData.gender,
      },
      lastKycAttempt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await db.collection("users").doc(userId).update(updateData);

    console.log("KYC approved for user:", userId);

    res.json({
      success: true,
      message: "KYC verification successful",
      data: {
        reference: bvnData.reference,
        firstName: bvnData.first_name,
        lastName: bvnData.last_name,
        dob: bvnData.date_of_birth,
        phone: bvnData.phone_number,
      },
    });
  } catch (error) {
    console.error("KYC verification error:", error);

    try {
      await db.collection("users").doc(userId).update({
        kycStatus: "rejected",
        rejectionReason: "Internal server error during verification",
        lastKycAttempt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (dbError) {
      console.error("Failed to update user KYC status:", dbError);
    }

    res.status(500).json({
      success: false,
      error: "Internal server error during KYC verification",
      details: error.message,
    });
  }
});

// === KYC: GET USER KYC STATUS ===
app.get("/api/kyc/status", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer "))
    return res.status(401).json({ error: "Unauthorized" });
  const idToken = authHeader.split("Bearer ")[1];

  let userId;
  try {
    userId = await verifyFirebaseToken(idToken);
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }

  try {
    const userDoc = await db.collection("users").doc(userId).get();

    if (!userDoc.exists) {
      return res.status(404).json({
        success: false,
        error: "User not found",
      });
    }

    const userData = userDoc.data();

    res.json({
      success: true,
      data: {
        kycStatus: userData.kycStatus || "pending",
        displayName: userData.displayName,
        email: userData.email,
        kycData: userData.kycData || null,
        rejectionReason: userData.rejectionReason || null,
        lastKycAttempt: userData.lastKycAttempt || null,
      },
    });
  } catch (error) {
    console.error("Get KYC status error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to get KYC status",
    });
  }
});

// === HEALTH CHECK ===
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "Highest Data Backend",
    vtuProvider: "VTU Africa",
  });
});

// === WEBHOOK TEST ENDPOINT ===
app.get("/webhook/test", (req, res) => {
  res.json({
    message: "Webhook endpoint is accessible",
    urls: ["/webhook/kora", "/webhook/vtu"],
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
  console.log(`VTU Webhook: https://higestdata-proxy.onrender.com/webhook/vtu`);
  console.log(`Health Check: https://higestdata-proxy.onrender.com/health`);
  console.log(`VTU Africa API: Integrated and Ready`);
});
