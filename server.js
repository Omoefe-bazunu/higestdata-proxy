// server.js - FIXED VERSION
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
const USER_PIN = process.env.EBILLS_USER_PIN;

let token = null;

// === MIDDLEWARE ===
app.use(
  cors({
    origin: ["https://www.highestdata.com.ng", "http://localhost:3000"],
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

// === eBILLS AUTH ===
async function getAccessToken() {
  if (token) return token;
  const response = await fetch(EBILLS_AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: process.env.EBILLS_USERNAME,
      password: process.env.EBILLS_PASSWORD,
    }),
  });
  if (!response.ok) throw new Error(`Auth failed: ${response.status}`);
  const data = await response.json();
  token = data.token;
  return token;
}

// === VERIFY FIREBASE TOKEN ===
async function verifyFirebaseToken(idToken) {
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    return decoded.uid;
  } catch (err) {
    throw new Error("Invalid Firebase token");
  }
}

// === HELPER: Remove undefined values from object ===
function cleanObject(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([_, v]) => v !== undefined)
  );
}

// === HELPER: Map eBills status/message to internal status ===
function mapEBillsStatus(apiResponse) {
  const status = apiResponse.data?.status;
  const message = apiResponse.message;

  // Completed states
  if (status === "completed-api" || message === "ORDER COMPLETED") {
    return { status: "success", shouldDeductWallet: true };
  }

  // Processing states (valid, not errors)
  if (
    message === "ORDER PROCESSING" ||
    message === "ORDER QUEUED" ||
    message === "ORDER INITIATED" ||
    message === "ORDER PENDING" ||
    status === "processing-api" ||
    status === "queued-api" ||
    status === "initiated-api" ||
    status === "pending"
  ) {
    return { status: "pending", shouldDeductWallet: false };
  }

  // Failed states
  if (
    message === "ORDER FAILED" ||
    message === "ORDER REFUNDED" ||
    message === "ORDER CANCELLED" ||
    status === "failed" ||
    status === "refunded" ||
    status === "cancelled"
  ) {
    return { status: "failed", shouldDeductWallet: false };
  }

  // Default to pending for unknown states
  return { status: "pending", shouldDeductWallet: false };
}

// === FETCH RATES ===
app.post("/api/vtu/fetch-rates", async (req, res) => {
  try {
    const { type, provider } = req.body;
    if (!type || !["data", "tv"].includes(type)) {
      return res.status(400).json({ error: "Invalid type" });
    }

    await getAccessToken();

    let url = `${EBILLS_API_URL}variations/${type}`;
    if (type === "tv" && provider) {
      url += `?service_id=${provider.toLowerCase()}`;
    }

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const apiResponse = await response.json();
    if (
      !apiResponse ||
      apiResponse.code !== "success" ||
      !Array.isArray(apiResponse.data)
    ) {
      return res.status(500).json({ error: "Invalid response from eBills" });
    }

    const rates = {};
    const validProviders =
      type === "data"
        ? ["mtn", "airtel", "glo", "9mobile", "smile"]
        : [provider.toLowerCase()];

    apiResponse.data.forEach((plan) => {
      if (
        validProviders.includes(plan.service_id.toLowerCase()) &&
        plan.availability === "Available" &&
        !(type === "data" && plan.data_plan.toLowerCase().includes("(sme)"))
      ) {
        const sid = plan.service_id.toLowerCase();
        rates[sid] = rates[sid] || {};
        rates[sid][plan.variation_id] = {
          price: parseFloat(plan.price) || 0,
          name: plan.data_plan || plan.name || `Plan ${plan.variation_id}`,
        };
      }
    });

    res.json({ success: true, rates });
  } catch (error) {
    console.error("Fetch rates error:", error);
    res.status(500).json({ error: error.message });
  }
});

// === TV VERIFY ===
app.get("/api/tv/verify", async (req, res) => {
  try {
    const { provider, customerId } = req.query;
    if (!provider || !customerId)
      return res
        .status(400)
        .json({ success: false, message: "Missing provider or customerId" });

    const data = await verifyCustomer(provider, customerId);
    res.json(
      data
        ? { success: true, data }
        : { success: false, message: "Customer verification failed" }
    );
  } catch (error) {
    console.error("TV verify error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to verify customer" });
  }
});

// === ELECTRICITY VERIFY ===
app.get("/api/electricity/verify", async (req, res) => {
  try {
    const { service_id, customer_id, variation_id } = req.query;
    if (!service_id || !customer_id || !variation_id) {
      return res.status(400).json({
        success: false,
        message: "Missing service_id, customer_id, or variation_id",
      });
    }
    const data = await verifyCustomer(service_id, customer_id, variation_id);
    res.json(
      data
        ? { success: true, data }
        : { success: false, message: "Customer verification failed" }
    );
  } catch (error) {
    console.error("Electricity verify error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to verify customer" });
  }
});

// === BETTING VERIFY ===
app.get("/api/betting/verify", async (req, res) => {
  try {
    const { provider, customerId } = req.query;
    if (!provider || !customerId)
      return res
        .status(400)
        .json({ success: false, message: "Missing provider or customerId" });

    const data = await verifyCustomer(provider, customerId);
    res.json(
      data
        ? { success: true, data }
        : { success: false, message: "Customer verification failed" }
    );
  } catch (error) {
    console.error("Betting verify error:", error);
    res
      .status(500)
      .json({ success: false, message: "Failed to verify customer" });
  }
});

// === TRANSACTION (Airtime, Data, Cable) - FIXED ===
app.post("/api/vtu/transaction", async (req, res) => {
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

  const {
    serviceType,
    amount,
    phone,
    network,
    variationId,
    customerId,
    finalPrice,
  } = req.body;

  const transactionId = `txn_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2)}`;
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  try {
    await getAccessToken();
    const balance = await (
      await fetch(`${EBILLS_API_URL}balance`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json();

    if (balance.data?.balance < amount) {
      return res.status(402).json({ error: "Insufficient eBills balance" });
    }

    let apiResponse;
    if (serviceType === "airtime") {
      apiResponse = await buyAirtime({
        phone,
        serviceId: network,
        amount,
        requestId,
      });
    } else if (serviceType === "data") {
      apiResponse = await buyData({
        phone,
        serviceId: network,
        variationId,
        requestId,
      });
    } else if (serviceType === "cable") {
      apiResponse = await buyTv({
        customerId,
        provider: network,
        variationId,
        requestId,
      });
    } else {
      return res.status(400).json({ error: "Invalid service type" });
    }

    console.log("eBills API Response:", JSON.stringify(apiResponse, null, 2));

    // FIXED: Check if API call itself failed
    if (apiResponse.code !== "success") {
      return res.status(400).json({
        error: apiResponse.message || "Transaction failed at eBills",
      });
    }

    // Map the status correctly
    const { status: txnStatus, shouldDeductWallet } =
      mapEBillsStatus(apiResponse);

    // FIXED: Build transaction data without undefined values
    const txnData = {
      userId,
      transactionId,
      requestId,
      description: `${serviceType} - ${network || customerId}`,
      amount: finalPrice,
      type: "debit",
      status: txnStatus,
      serviceType,
      ebillsAmount: amount,
      eBillsResponse: apiResponse,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      pending: !shouldDeductWallet,
    };

    // Add optional fields only if they exist
    if (phone) txnData.phone = phone;
    if (network) txnData.network = network;
    if (variationId) txnData.variationId = variationId;
    if (customerId) txnData.customerId = customerId;

    const userTxnRef = db
      .collection("users")
      .doc(userId)
      .collection("transactions")
      .doc(transactionId);

    // Clean object to remove undefined values before saving
    await userTxnRef.set(cleanObject(txnData));

    // FIXED: Only deduct wallet if transaction is immediately completed
    if (shouldDeductWallet) {
      await db
        .collection("users")
        .doc(userId)
        .update({
          walletBalance: admin.firestore.FieldValue.increment(-finalPrice),
        });
    }

    res.json({
      success: true,
      transactionId,
      message: shouldDeductWallet
        ? "Transaction completed"
        : "Transaction is being processed",
      status: txnStatus,
      transactionData: txnData,
    });
  } catch (error) {
    console.error("Transaction error:", error);
    res.status(500).json({ error: error.message });
  }
});

// === ELECTRICITY PURCHASE ===
const VALID_PROVIDERS = [
  "ikeja-electric",
  "eko-electric",
  "kano-electric",
  "portharcourt-electric",
  "jos-electric",
  "ibadan-electric",
  "kaduna-electric",
  "abuja-electric",
  "enugu-electric",
  "benin-electric",
  "aba-electric",
  "yola-electric",
];
const VALID_VARIATIONS = ["prepaid", "postpaid"];

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

  const {
    amount,
    provider,
    customerId,
    variationId,
    serviceCharge,
    totalAmount,
  } = req.body;

  const transactionId = `txn_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2)}`;
  const requestId = `req_${Date.now()}_electricity_${userId.slice(
    -6
  )}_${Math.floor(Math.random() * 1000)}`;

  try {
    if (
      !VALID_PROVIDERS.includes(provider) ||
      !VALID_VARIATIONS.includes(variationId)
    ) {
      return res.status(400).json({ error: "Invalid provider or meter type" });
    }

    const electricityAmount = parseFloat(amount);
    const total = parseFloat(totalAmount);
    if (electricityAmount < 1000 || electricityAmount > 100000) {
      return res.status(400).json({ error: "Amount out of range" });
    }

    await getAccessToken();
    const balance = await getBalance();
    if (balance < electricityAmount)
      return res.status(503).json({ error: "Platform funds low" });

    const customerData = await verifyCustomer(
      provider,
      customerId,
      variationId
    );
    if (!customerData) return res.status(400).json({ error: "Invalid meter" });
    if (customerData.min_purchase_amount > electricityAmount)
      return res.status(400).json({ error: "Below minimum" });
    if (
      customerData.customer_arrears > 0 &&
      electricityAmount < customerData.customer_arrears
    ) {
      return res.status(400).json({ error: "Below arrears" });
    }

    const ebillsResponse = await purchaseElectricity(
      requestId,
      customerId,
      provider,
      variationId,
      electricityAmount
    );

    if (ebillsResponse.code !== "success") {
      return res
        .status(400)
        .json({ error: ebillsResponse?.message || "eBills failed" });
    }

    const { status: txnStatus, shouldDeductWallet } =
      mapEBillsStatus(ebillsResponse);

    const txnData = {
      userId,
      transactionId,
      requestId,
      description: `Electricity - ${provider}`,
      amount: total,
      type: "debit",
      status: txnStatus,
      serviceType: "electricity",
      provider,
      customerId,
      variationId,
      electricityAmount,
      serviceCharge: parseFloat(serviceCharge),
      ebillsResponse,
      customerName: customerData.customer_name,
      customerAddress: customerData.customer_address,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      pending: !shouldDeductWallet,
    };

    await db
      .collection("users")
      .doc(userId)
      .collection("transactions")
      .doc(transactionId)
      .set(cleanObject(txnData));

    if (shouldDeductWallet) {
      await db
        .collection("users")
        .doc(userId)
        .update({
          walletBalance: admin.firestore.FieldValue.increment(-total),
        });
    }

    res.json({ success: true, transactionId, transactionData: txnData });
  } catch (error) {
    console.error("Electricity error:", error);
    res.status(500).json({ error: error.message });
  }
});

// === BETTING FUND ===
const VALID_BETTING_PROVIDERS = [
  "1xBet",
  "BangBet",
  "Bet9ja",
  "BetKing",
  "BetLand",
  "BetLion",
  "BetWay",
  "CloudBet",
  "LiveScoreBet",
  "MerryBet",
  "NaijaBet",
  "NairaBet",
  "SupaBet",
];

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

  const { amount, provider, customerId, serviceCharge, totalAmount } = req.body;

  const transactionId = `txn_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2)}`;
  const requestId = `req_${Date.now()}_betting_${userId.slice(-6)}_${Math.floor(
    Math.random() * 1000
  )}`;

  try {
    if (!VALID_BETTING_PROVIDERS.includes(provider)) {
      return res.status(400).json({ error: "Invalid provider" });
    }

    const bettingAmount = parseFloat(amount);
    const total = parseFloat(totalAmount);
    if (bettingAmount < 100 || bettingAmount > 100000) {
      return res.status(400).json({ error: "Amount out of range" });
    }

    await getAccessToken();
    const balance = await getBalance();
    if (balance < bettingAmount)
      return res.status(503).json({ error: "Platform funds low" });

    const customerData = await verifyCustomer(provider, customerId);
    if (!customerData)
      return res.status(400).json({ error: "Invalid customer ID" });

    const ebillsResponse = await fundBettingAccount(
      requestId,
      customerId,
      provider,
      bettingAmount
    );

    if (ebillsResponse.code !== "success") {
      return res
        .status(400)
        .json({ error: ebillsResponse?.message || "eBills failed" });
    }

    const { status: txnStatus, shouldDeductWallet } =
      mapEBillsStatus(ebillsResponse);

    const txnData = {
      userId,
      transactionId,
      requestId,
      description: `Betting - ${provider}`,
      amount: total,
      type: "debit",
      status: txnStatus,
      serviceType: "betting",
      provider,
      customerId,
      bettingAmount,
      serviceCharge: parseFloat(serviceCharge),
      ebillsResponse,
      customerName: customerData.customer_name || customerId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      pending: !shouldDeductWallet,
    };

    await db
      .collection("users")
      .doc(userId)
      .collection("transactions")
      .doc(transactionId)
      .set(txnData);

    if (shouldDeductWallet) {
      await db
        .collection("users")
        .doc(userId)
        .update({
          walletBalance: admin.firestore.FieldValue.increment(-total),
        });
    }

    res.json({ success: true, transactionId, transactionData: txnData });
  } catch (error) {
    console.error("Betting error:", error);
    res.status(500).json({ error: error.message });
  }
});

// === WEBHOOK (FIXED) - Handles ALL services ===
app.post("/webhook", async (req, res) => {
  const signature = req.headers["x-signature"];
  const payload = req.rawBody.toString();
  const hash = crypto
    .createHmac("sha256", USER_PIN)
    .update(payload)
    .digest("hex");

  if (hash !== signature) {
    console.log("Invalid webhook signature");
    return res.status(403).json({ error: "Invalid signature" });
  }

  const { request_id, status, order_id } = req.body;

  if (!request_id) {
    console.log("Webhook missing request_id:", req.body);
    return res.status(400).json({ error: "Missing request_id" });
  }

  console.log("WEBHOOK RECEIVED:", {
    request_id,
    status,
    order_id,
    fullBody: req.body,
  });

  try {
    const snapshot = await db
      .collectionGroup("transactions")
      .where("requestId", "==", request_id)
      .where("pending", "==", true)
      .get();

    if (snapshot.empty) {
      console.log("No pending transaction found for request_id:", request_id);
      return res.json({ status: "ignored - no pending transaction" });
    }

    const batch = db.batch();

    snapshot.forEach((doc) => {
      const data = doc.data();
      const txnRef = doc.ref;
      const userRef = db.collection("users").doc(data.userId);

      // FIXED: Comprehensive status mapping
      const isSuccess =
        status === "completed-api" ||
        status === "ORDER COMPLETED" ||
        status === "completed" ||
        status === "success";

      const isFailed =
        status === "failed" ||
        status === "refunded" ||
        status === "ORDER FAILED" ||
        status === "ORDER REFUNDED" ||
        status === "ORDER CANCELLED" ||
        status === "cancelled" ||
        status === "error";

      const isPending =
        status === "ORDER PROCESSING" ||
        status === "ORDER QUEUED" ||
        status === "ORDER INITIATED" ||
        status === "ORDER PENDING" ||
        status === "ORDER ON-HOLD" ||
        status === "processing-api" ||
        status === "queued-api" ||
        status === "initiated-api" ||
        status === "pending" ||
        status === "on-hold";

      if (isSuccess) {
        batch.update(txnRef, {
          status: "success",
          pending: false,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        // Deduct wallet on success
        batch.update(userRef, {
          walletBalance: admin.firestore.FieldValue.increment(-data.amount),
        });
        console.log(
          `✅ SUCCESS: Wallet deducted ₦${data.amount} for ${data.userId}`
        );
      } else if (isFailed) {
        batch.update(txnRef, {
          status: "failed",
          pending: false,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`❌ FAILED: Transaction ${request_id} marked as failed`);
        // No wallet deduction for failed transactions
      } else if (isPending) {
        // Keep as pending, don't deduct wallet yet
        batch.update(txnRef, {
          status: "pending",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`⏳ PENDING: Transaction ${request_id} still processing`);
      } else {
        // Unknown status - log and keep pending
        console.log(`⚠️ UNKNOWN STATUS: ${status} for ${request_id}`);
        batch.update(txnRef, {
          status: status || "pending",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    });

    await batch.commit();
    console.log("✅ Webhook processed successfully");
    res.json({ status: "success" });
  } catch (error) {
    console.error("❌ Webhook error:", error);
    res.status(500).json({ error: "Failed" });
  }
});

// === eBILLS HELPERS ===
async function verifyCustomer(serviceId, customerId, variationId = null) {
  const body = { service_id: serviceId, customer_id: customerId };
  if (variationId) body.variation_id = variationId;

  const res = await fetch(`${EBILLS_API_URL}verify-customer`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return data.code === "success" ? data.data : null;
}

async function purchaseElectricity(
  requestId,
  customerId,
  serviceId,
  variationId,
  amount
) {
  const res = await fetch(`${EBILLS_API_URL}electricity`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      request_id: requestId,
      customer_id: customerId,
      service_id: serviceId,
      variation_id: variationId,
      amount,
    }),
  });
  return res.json();
}

async function fundBettingAccount(requestId, customerId, serviceId, amount) {
  const res = await fetch(`${EBILLS_API_URL}betting`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      request_id: requestId,
      customer_id: customerId,
      service_id: serviceId,
      amount,
    }),
  });
  return res.json();
}

async function buyAirtime({ phone, serviceId, amount, requestId }) {
  const res = await fetch(`${EBILLS_API_URL}airtime`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      phone,
      service_id: serviceId.toLowerCase(),
      amount: Number(amount),
      request_id: requestId,
    }),
  });
  return res.json();
}

async function buyData({ phone, serviceId, variationId, requestId }) {
  const res = await fetch(`${EBILLS_API_URL}data`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      phone,
      service_id: serviceId.toLowerCase(),
      variation_id: variationId,
      request_id: requestId,
    }),
  });
  return res.json();
}

async function buyTv({ customerId, provider, variationId, requestId }) {
  const res = await fetch(`${EBILLS_API_URL}tv`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      customer_id: customerId,
      service_id: provider.toLowerCase(),
      variation_id: variationId,
      request_id: requestId,
    }),
  });
  return res.json();
}

// === eBILLS BALANCE CHECK ===
async function getBalance() {
  try {
    const res = await fetch(`${EBILLS_API_URL}balance`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    return data.data?.balance || 0;
  } catch (error) {
    console.error("Balance check failed:", error);
    return 0;
  }
}

// Add this new endpoint to your server.js

// === PROCESS WITHDRAWAL (Admin Action) ===
app.post("/api/withdrawal/process", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer "))
    return res.status(401).json({ error: "Unauthorized" });
  const idToken = authHeader.split("Bearer ")[1];
  let adminUserId;

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    adminUserId = decodedToken.uid;
    if (decodedToken.email !== "highestdatafintechsolutions@gmail.com") {
      return res
        .status(403)
        .json({ error: "Forbidden: Admin access required" });
    }
  } catch (err) {
    return res.status(401).json({ error: err.message });
  }

  const { requestId, action } = req.body;
  if (!requestId || !["complete", "reject"].includes(action)) {
    return res.status(400).json({ error: "Invalid request parameters" });
  }

  try {
    const withdrawalRef = db.collection("withdrawalRequests").doc(requestId);
    const withdrawalSnap = await withdrawalRef.get();
    if (!withdrawalSnap.exists)
      return res.status(404).json({ error: "Withdrawal request not found" });

    const withdrawalData = withdrawalSnap.data();
    if (withdrawalData.status !== "pending")
      return res.status(400).json({ error: "Withdrawal already processed" });

    const newStatus = action === "complete" ? "completed" : "failed";
    const userRef = db.collection("users").doc(withdrawalData.userId);

    await db.runTransaction(async (transaction) => {
      const userSnap = await transaction.get(userRef);
      if (!userSnap.exists) throw new Error("User not found");
      const currentBalance = userSnap.data().walletBalance || 0;
      let newBalance = currentBalance;

      if (action === "complete") {
        if (currentBalance < withdrawalData.totalAmount) {
          throw new Error("Insufficient balance");
        }
        newBalance = currentBalance - withdrawalData.totalAmount;
      }
      // REJECT: No wallet change

      transaction.update(withdrawalRef, {
        status: newStatus,
        processedAt: admin.firestore.FieldValue.serverTimestamp(),
        processedBy: adminUserId,
      });

      transaction.update(userRef, { walletBalance: newBalance });

      const txQuery = await db
        .collection("users")
        .doc(withdrawalData.userId)
        .collection("transactions")
        .where("reference", "==", withdrawalData.reference)
        .get();

      txQuery.docs.forEach((txDoc) => {
        transaction.update(txDoc.ref, {
          status: newStatus,
          processedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });
    });
    //

    try {
      await fetch(
        `${
          process.env.BASE_URL || "http://localhost:3000"
        }/api/withdrawal/notify-user`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: withdrawalData.userEmail,
            userName: withdrawalData.userName,
            amount: withdrawalData.amount,
            status: newStatus,
            reference: withdrawalData.reference,
            bankName: withdrawalData.bankName,
            accountNumber: withdrawalData.accountNumber,
          }),
        }
      );
    } catch (emailError) {
      console.error("Email failed:", emailError);
    }

    res.json({
      success: true,
      message: `Withdrawal ${newStatus}`,
      withdrawalId: requestId,
      status: newStatus,
    });
  } catch (error) {
    console.error("Error:", error);
    res
      .status(500)
      .json({ error: error.message || "Failed to process withdrawal" });
  }
});

// === START ===
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Backend running on port ${PORT}`);
});
