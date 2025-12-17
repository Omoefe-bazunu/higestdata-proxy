// server.js - UPDATED WITH VTU AFRICA API INTEGRATION
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
require("dotenv").config();
const admin = require("firebase-admin");
// NOTE: If you get an error saying "require() of ES Module", change this to a dynamic import inside the route (shown in comments below)
const MailerLite = require("@mailerlite/mailerlite-nodejs").default;

// // Inside the route handler...
// const MailerLite = (await import('@mailerlite/mailerlite-nodejs')).default;
// const mailerlite = new MailerLite({ ... });

// Add these Firestore imports
const {
  getFirestore,
  doc,
  getDoc,
  collection,
  setDoc,
  updateDoc,
  increment,
  serverTimestamp,
} = require("firebase-admin/firestore");

const app = express();
const PORT = process.env.PORT || 3000;
const MAILERLITE_API_KEY = process.env.MAILERLITE_API_KEY;
const OGAVIRAL_API_URL = "https://ogaviral.com/api/v2";
const OGAVIRAL_API_KEY = process.env.OGAVIRAL_API_KEY;
const jwt = require("jsonwebtoken"); // Add this to your top-level imports

// === SAFE HAVEN CONFIG (PRODUCTION) ===
const SH_AUTH_URL = "https://api.safehavenmfb.com/oauth2/token";
const SH_API_URL = "https://api.safehavenmfb.com";
const SH_AUDIENCE = "https://api.safehavenmfb.com"; // "aud" per docs
const SH_ISSUER = "https://www.highestdata.com.ng"; // "iss" (Your Company URL)

const SH_CLIENT_ID = process.env.SAFE_HAVEN_CLIENT_ID;

// Handle Private Key Newlines (Fix for Render Environment Variables)
const SH_PRIVATE_KEY = process.env.SAFE_HAVEN_PRIVATE_KEY
  ? process.env.SAFE_HAVEN_PRIVATE_KEY.replace(/\\n/g, "\n")
  : null;

let shAccessToken = null;
let shTokenExpiry = 0;

// === GENERATE DYNAMIC ASSERTION ===
function generateClientAssertion() {
  if (!SH_PRIVATE_KEY)
    throw new Error("SAFE_HAVEN_PRIVATE_KEY is missing in env");

  const now = Math.floor(Date.now() / 1000);

  // Payload strictly following Safe Haven Docs
  const payload = {
    iss: SH_ISSUER, // Your Company URL
    sub: SH_CLIENT_ID, // OAuth Client ID
    aud: SH_AUDIENCE, // Safe Haven Environment URL
    iat: now, // Issued At (Current Time)
    exp: now + 3600, // Expiry (Current Time + 1 Hour)
  };

  // Sign with RS256 and include "typ": "JWT" in header
  return jwt.sign(payload, SH_PRIVATE_KEY, {
    algorithm: "RS256",
    header: { typ: "JWT" },
  });
}

// === SAFE HAVEN TOKEN MANAGER ===
async function getSafeHavenToken() {
  const now = Date.now();
  // Reuse token if it exists and has more than 1 minute left
  if (shAccessToken && now < shTokenExpiry - 60000) {
    return shAccessToken;
  }

  console.log("Generating new Safe Haven Assertion...");

  try {
    // 1. Generate fresh assertion automatically
    const assertion = generateClientAssertion();

    [cite_start]; // 2. Exchange for Access Token [cite: 1, 3]
    const response = await fetch(SH_AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_assertion_type:
          "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_id: SH_CLIENT_ID,
        client_assertion: assertion,
      }),
    });

    const data = await response.json();

    if (!response.ok || !data.access_token) {
      console.error("SH Auth Failed:", JSON.stringify(data, null, 2));
      // Reset token if auth failed so we retry next time
      shAccessToken = null;
      throw new Error(
        `Failed to authenticate with Safe Haven: ${
          data.error_description || data.error
        }`
      );
    }

    shAccessToken = data.access_token;
    [cite_start]; // Store expiry (expires_in is in seconds, usually ~2399s) [cite: 4]
    shTokenExpiry = now + data.expires_in * 1000;

    console.log(
      "Safe Haven Token Refreshed. Expires in:",
      data.expires_in,
      "seconds"
    );
    return shAccessToken;
  } catch (error) {
    console.error("Safe Haven Auth Error:", error.message);
    throw error;
  }
}
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

//EBILLS CONFIG (FOR AIRTIME & DATA) ===
const EBILLS_AUTH_URL = "https://ebills.africa/wp-json/jwt-auth/v1/token";
const EBILLS_API_URL = "https://ebills.africa/wp-json/api/v2";
const EBILLS_USERNAME = process.env.EBILLS_USERNAME;
const EBILLS_PASSWORD = process.env.EBILLS_PASSWORD;
const EBILLS_PIN = process.env.EBILLS_USER_PIN;

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

// === HELPER: SAFE HAVEN REQUEST ===
async function makeSafeHavenRequest(endpoint, method = "GET", body = null) {
  try {
    const token = await getSafeHavenToken();
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ClientID: SH_CLIENT_ID,
    };

    const config = { method, headers };
    if (body) config.body = JSON.stringify(body);

    console.log(`SH Request: ${method} ${SH_API_URL}${endpoint}`);

    const res = await fetch(`${SH_API_URL}${endpoint}`, config);
    const data = await res.json();

    // Log errors for debugging
    if (!res.ok) {
      console.error(
        `SH API Error (${res.status}):`,
        JSON.stringify(data, null, 2)
      );
    }

    return { status: res.status, data };
  } catch (error) {
    console.error("makeSafeHavenRequest Error:", error);
    // Return a structured error so the route handler doesn't crash
    return { status: 500, data: { message: error.message } };
  }
}

// --- Helper: Make OgaViral Request ---
async function makeOgaviralRequest(action, params = {}) {
  try {
    const payload = {
      key: OGAVIRAL_API_KEY,
      action: action,
      ...params,
    };

    // OgaViral expects POST form-data or JSON. We'll use JSON.
    // Note: Some SMM panels strictly require form-urlencoded.
    // If JSON fails, switch to URLSearchParams.
    const response = await fetch(OGAVIRAL_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error);
    return data;
  } catch (error) {
    console.error("OgaViral API Error:", error.message);
    throw new Error(`SMM Provider Error: ${error.message}`);
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

// === ADD EBILLS AUTH HELPER ===
let ebillsToken = null;
let tokenExpiry = 0;

async function getEbillsToken() {
  const now = Date.now();
  if (ebillsToken && now < tokenExpiry - 300000) return ebillsToken;

  console.log("Acquiring new Ebills Token...");
  try {
    const response = await fetch(EBILLS_AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: EBILLS_USERNAME,
        password: EBILLS_PASSWORD,
      }),
    });

    if (!response.ok) throw new Error(`Ebills Auth Failed: ${response.status}`);

    const data = await response.json();
    if (data.token) {
      ebillsToken = data.token;
      tokenExpiry = now + 24 * 60 * 60 * 1000;
      return ebillsToken;
    }
    throw new Error("No token in auth response");
  } catch (error) {
    console.error("Ebills Token Error:", error);
    throw error;
  }
}

// === ADD EBILLS REQUEST HELPER ===
async function makeEbillsRequest(endpoint, method = "GET", body = null) {
  try {
    const token = await getEbillsToken();
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    const config = { method, headers };
    if (body) config.body = JSON.stringify(body);

    const response = await fetch(`${EBILLS_API_URL}${endpoint}`, config);
    return await response.json();
  } catch (error) {
    console.error("Ebills API Error:", error);
    throw new Error(`Ebills request failed: ${error.message}`);
  }
}

// === AIRTIME PURCHASE (EBILLS) ===
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

    // Get rates
    const airtimeRatesDoc = await db
      .collection("settings")
      .doc("airtimeRates")
      .get();
    const airtimeRates = airtimeRatesDoc.exists
      ? airtimeRatesDoc.data().rates
      : {};

    const discountPercentage = airtimeRates[network]?.discountPercentage || 0;
    const amountToPurchase = parseFloat(amount);
    const amountToDeduct = amountToPurchase * (1 - discountPercentage / 100);

    console.log(`Airtime: Buy ${amountToPurchase}, Charge ${amountToDeduct}`);

    if (amountToDeduct > userData.walletBalance) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    // Call Ebills
    const ebillsResponse = await makeEbillsRequest("/airtime", "POST", {
      request_id: ref,
      phone: phone,
      service_id: network.toLowerCase(), // Ebills uses 'mtn', 'airtel' etc.
      amount: amountToPurchase,
    });

    // Check for success code 'success' or HTTP 200/201 logic
    if (ebillsResponse.code === "success") {
      const batch = db.batch();

      // Deduct wallet
      batch.update(db.collection("users").doc(userId), {
        walletBalance: admin.firestore.FieldValue.increment(-amountToDeduct),
      });

      // Record transaction
      batch.set(
        db.collection("users").doc(userId).collection("transactions").doc(ref), // Use Ref as ID
        {
          userId,
          type: "airtime",
          network,
          phone,
          amountToProvider: amountToPurchase,
          amountCharged: amountToDeduct,
          discountPercentage,
          reference: ref,
          status: "success", // Ebills returns immediate status usually
          description: `${network} Airtime to ${phone}`,
          providerResponse: ebillsResponse,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        }
      );

      await batch.commit();

      res.json({
        success: true,
        message: "Airtime purchase successful",
        data: ebillsResponse,
      });
    } else {
      res.status(400).json({
        error: ebillsResponse.message || "Airtime purchase failed",
        data: ebillsResponse,
      });
    }
  } catch (error) {
    console.error("Airtime purchase error:", error);
    res.status(500).json({ error: error.message });
  }
});

// === DATA PURCHASE (EBILLS) ===
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

  // Frontend sends: service, MobileNumber, DataPlan (variation_id)
  const { service, MobileNumber, DataPlan, ref } = req.body;

  if (!service || !MobileNumber || !DataPlan || !ref) {
    return res.status(400).json({ error: "Missing required parameters" });
  }

  try {
    const userDoc = await db.collection("users").doc(userId).get();
    const userData = userDoc.data();

    // Get pricing from Firestore (Source of truth for User Price)
    const dataRatesDoc = await db.collection("settings").doc("dataRates").get();
    const dataRates = dataRatesDoc.exists ? dataRatesDoc.data().rates : {};

    // Find the plan in Firestore using the variation ID
    const planData = dataRates[service]?.plans?.[DataPlan];

    if (!planData) {
      return res.status(400).json({ error: "Invalid data plan selected" });
    }

    const amountToDeduct = parseFloat(planData.finalPrice);
    const basePrice = parseFloat(planData.basePrice); // For profit calc

    if (amountToDeduct > userData.walletBalance) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    // Call Ebills
    const ebillsResponse = await makeEbillsRequest("/data", "POST", {
      request_id: ref,
      phone: MobileNumber,
      service_id: service.toLowerCase(),
      variation_id: DataPlan, // Ebills expects variation_id
    });

    if (ebillsResponse.code === "success") {
      const batch = db.batch();

      // Deduct wallet
      batch.update(db.collection("users").doc(userId), {
        walletBalance: admin.firestore.FieldValue.increment(-amountToDeduct),
      });

      // Record transaction
      batch.set(
        db.collection("users").doc(userId).collection("transactions").doc(ref),
        {
          userId,
          type: "data",
          service,
          phone: MobileNumber,
          dataPlan: DataPlan,
          planName: planData.name || "Data Plan",
          amountCharged: amountToDeduct,
          profit: amountToDeduct - basePrice,
          reference: ref,
          status: "success",
          description: `${service} Data to ${MobileNumber}`,
          providerResponse: ebillsResponse,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        }
      );

      await batch.commit();

      res.json({
        success: true,
        message: "Data purchase successful",
        data: ebillsResponse,
      });
    } else {
      res.status(400).json({
        error: ebillsResponse.message || "Data purchase failed",
        data: ebillsResponse,
      });
    }
  } catch (error) {
    console.error("Data purchase error:", error);
    res.status(500).json({ error: error.message });
  }
});

// === NEW ENDPOINT: GET EBILLS VARIATIONS (For Admin Dashboard) ===
app.get("/api/ebills/variations", async (req, res) => {
  const { service_id } = req.query; // e.g., mtn, airtel
  try {
    const endpoint = service_id
      ? `/variations/data?service_id=${service_id}`
      : `/variations/data`;

    const data = await makeEbillsRequest(endpoint, "GET");
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === GET EBILLS TV VARIATIONS (For Admin Dashboard) ===
app.get("/api/ebills/tv-variations", async (req, res) => {
  const { service_id } = req.query; // e.g., dstv, gotv
  try {
    const endpoint = service_id
      ? `/variations/tv?service_id=${service_id}`
      : `/variations/tv`;

    const data = await makeEbillsRequest(endpoint, "GET");
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === NEW: VERIFY SMARTCARD (Ebills) ===
app.post("/api/cabletv/verify", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer "))
    return res.status(401).json({ error: "Unauthorized" });

  try {
    const { service, smartNo } = req.body;
    if (!service || !smartNo)
      return res.status(400).json({ error: "Missing parameters" });

    // Call Ebills Verify
    // Note: Ebills expects 'customer_id' and 'service_id'
    const ebillsResponse = await makeEbillsRequest("/verify-customer", "POST", {
      service_id: service,
      customer_id: smartNo,
    });

    if (ebillsResponse.code === "success") {
      res.json({
        success: true,
        customerName: ebillsResponse.data?.customer_name || "Valid Customer",
        data: ebillsResponse.data,
      });
    } else {
      res.status(400).json({ error: "Invalid Smartcard Number" });
    }
  } catch (error) {
    console.error("Verify TV error:", error);
    res.status(500).json({ error: error.message });
  }
});

// === UPDATED: CABLE TV PURCHASE (Switched to Ebills) ===
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

    // Get TV rates from Firestore
    const tvRatesDoc = await db.collection("settings").doc("tvRates").get();
    const tvRates = tvRatesDoc.exists ? tvRatesDoc.data().rates : {};

    const planData = tvRates[service]?.plans?.[variation];

    if (!planData) {
      return res.status(400).json({ error: "Invalid TV plan selected" });
    }

    const amountToPurchase = parseFloat(planData.basePrice); // Cost from Ebills (stored in DB)
    const amountToDeduct = parseFloat(planData.finalPrice); // User pays this

    if (amountToDeduct > userData.walletBalance) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    // Call Ebills Purchase Endpoint
    const ebillsResponse = await makeEbillsRequest("/tv", "POST", {
      request_id: ref,
      service_id: service, // 'dstv', 'gotv', etc.
      customer_id: smartNo,
      variation_id: variation, // The plan ID (e.g., 'dstv-padi')
    });

    if (ebillsResponse.code === "success") {
      const batch = db.batch();

      // Deduct Wallet
      batch.update(db.collection("users").doc(userId), {
        walletBalance: admin.firestore.FieldValue.increment(-amountToDeduct),
      });

      // Record Transaction
      batch.set(
        db.collection("users").doc(userId).collection("transactions").doc(ref),
        {
          userId,
          type: "cabletv",
          service,
          smartCard: smartNo,
          variation,
          amountToProvider: amountToPurchase,
          amountCharged: amountToDeduct,
          profit: amountToDeduct - amountToPurchase,
          reference: ref,
          status: "success",
          description: `${service.toUpperCase()} Subscription for ${smartNo}`,
          providerResponse: ebillsResponse,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        }
      );

      await batch.commit();

      res.json({
        success: true,
        message: "Cable TV subscription successful",
        data: ebillsResponse,
      });
    } else {
      res.status(400).json({
        error: ebillsResponse.message || "Subscription failed",
        data: ebillsResponse,
      });
    }
  } catch (error) {
    console.error("Cable TV purchase error:", error);
    res.status(500).json({ error: error.message });
  }
});

// === ELECTRICITY BILL PAYMENT ===

app.post("/api/electricity/verify", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer "))
    return res.status(401).json({ error: "Unauthorized" });
  const idToken = authHeader.split("Bearer ")[1];
  try {
    await verifyFirebaseToken(idToken); // just verify token
    const { service, meterNo, metertype } = req.body;
    if (!service || !meterNo || !metertype)
      return res.status(400).json({ error: "Missing params" });

    // VTU Africa has no meter verify endpoint → fake success for frontend flow
    res.json({
      success: true,
      data: {
        customerName: "Verified Customer",
        address: "Sample Address",
        meterNumber: meterNo,
      },
    });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

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

    // For electricity, we might have a small service charge - FIXED: use .exists not .exists()
    const electricityRatesDoc = await db
      .collection("settings")
      .doc("electricityRates")
      .get();
    const electricityRates = electricityRatesDoc.exists
      ? electricityRatesDoc.data()
      : {}; // ← FIXED

    const serviceChargePercentage = electricityRates.serviceCharge || 0; // Default 0% if not set

    const amountToVTU = parseFloat(amount); // Amount sent to electricity company
    const amountToDeduct = amountToVTU * (1 + serviceChargePercentage / 100); // Amount with service charge

    console.log(
      `Electricity purchase: VTU Amount: ${amountToVTU}, Wallet Deduction: ${amountToDeduct}, Service Charge: ${
        amountToDeduct - amountToVTU
      }`
    );

    // Check wallet balance against total amount (electricity + service charge)
    if (amountToDeduct > userData.walletBalance) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    // Make VTU Africa API call with electricity amount
    const vtuResponse = await makeVtuAfricaRequest("electric", {
      service,
      meterNo,
      metertype,
      amount: amountToVTU,
      ref,
    });

    if (vtuResponse.code === 101) {
      // Deduct TOTAL AMOUNT (electricity + service charge) from wallet
      await db
        .collection("users")
        .doc(userId)
        .update({
          walletBalance: admin.firestore.FieldValue.increment(-amountToDeduct),
        });

      // Record transaction with both amounts
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
          amountToVTU: amountToVTU, // Amount sent to electricity company
          amountCharged: amountToDeduct, // Total amount user paid (with service charge)
          serviceCharge: amountToDeduct - amountToVTU, // Your service charge
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

    // Get exam rates
    const examRatesDoc = await db.collection("settings").doc("examRates").get();
    const examRates = examRatesDoc.exists ? examRatesDoc.data() : {};
    const profitPercentage = examRates.profitMargin || 0;

    // Build parameters according to VTU Africa docs
    const params = {
      service: service.toLowerCase(),
      product_code: product_code.toString(),
      quantity: quantity.toString(),
      ref: ref,
      webhookURL: "https://higestdata-proxy.onrender.com/webhook/vtu",
    };

    // Add optional parameters only if provided
    if (profilecode) params.profilecode = profilecode;
    if (sender) params.sender = sender;
    if (phone) params.phone = phone;

    console.log("Exam PIN Purchase Params:", params);

    // Use the correct endpoint structure
    const vtuResponse = await makeVtuAfricaRequest("exam-pin", params);

    console.log("VTU Africa Exam PIN Response:", vtuResponse);

    if (vtuResponse.code === 101) {
      // Extract amount from response
      const amountChargedByVTU = parseFloat(
        vtuResponse.description.Amount_Charged ||
          vtuResponse.description.UnitPrice ||
          vtuResponse.description.amount
      );

      // Calculate admin fee and total amount
      const adminFee = (amountChargedByVTU * profitPercentage) / 100;
      const totalAmountToDeduct = amountChargedByVTU + adminFee;

      console.log(
        `Exam card purchase: 
        VTU Amount: ${amountChargedByVTU}, 
        Admin Fee (${profitPercentage}%): ${adminFee}, 
        Total Deduction: ${totalAmountToDeduct}`
      );

      // Check wallet balance against the total amount (main amount + admin fee)
      if (totalAmountToDeduct > userData.walletBalance) {
        return res.status(400).json({ error: "Insufficient balance" });
      }

      // Deduct total amount (main amount + admin fee) from wallet
      await db
        .collection("users")
        .doc(userId)
        .update({
          walletBalance: admin.firestore.FieldValue.increment(
            -totalAmountToDeduct
          ),
        });

      // Record transaction
      await db
        .collection("users")
        .doc(userId)
        .collection("transactions")
        .add({
          userId,
          type: "exam",
          service: service.toLowerCase(),
          productCode: product_code,
          quantity: parseInt(quantity),
          amountToVTU: amountChargedByVTU, // Main amount sent to VTU
          adminFee: adminFee, // Admin fee/rate
          totalAmountCharged: totalAmountToDeduct, // Total deducted from wallet
          profit: adminFee,
          reference: ref,
          status: "success",
          description: `${service.toUpperCase()} Exam PIN Purchase`,
          vtuResponse: vtuResponse,
          pins: vtuResponse.description.pins,
          productName: vtuResponse.description.ProductName,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

      res.json({
        success: true,
        message: "Exam PIN purchase successful",
        data: vtuResponse,
        pins: vtuResponse.description.pins,
        amountBreakdown: {
          mainAmount: amountChargedByVTU,
          adminFee: adminFee,
          totalAmount: totalAmountToDeduct,
        },
      });
    } else {
      res.status(400).json({
        error:
          vtuResponse.description?.message ||
          vtuResponse.description ||
          "Exam PIN purchase failed",
        data: vtuResponse,
      });
    }
  } catch (error) {
    console.error("Exam PIN purchase error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Add this new endpoint for price estimation
app.post("/api/exam/estimate-price", async (req, res) => {
  const { service, product_code, quantity } = req.body;

  if (!service || !product_code || !quantity) {
    return res.status(400).json({ error: "Missing required parameters" });
  }

  try {
    // Get exam rates
    const examRatesDoc = await db.collection("settings").doc("examRates").get();
    const examRates = examRatesDoc.exists ? examRatesDoc.data() : {};
    const profitPercentage = examRates.profitMargin || 0;

    // Make a dry-run request to VTU Africa to get actual pricing
    const params = {
      service: service.toLowerCase(),
      product_code: product_code.toString(),
      quantity: quantity.toString(),
      dry_run: "true", // Add dry-run parameter if supported by VTU Africa
    };

    let estimatedMainAmount;

    try {
      // Try to get actual price from VTU Africa
      const vtuResponse = await makeVtuAfricaRequest("exam-pin", params);
      if (vtuResponse.code === 101) {
        estimatedMainAmount = parseFloat(
          vtuResponse.description.Amount_Charged ||
            vtuResponse.description.UnitPrice ||
            vtuResponse.description.amount
        );
      } else {
        // Fallback to default prices if dry-run fails
        throw new Error("Dry-run failed, using fallback prices");
      }
    } catch (error) {
      // Fallback prices based on service type
      const fallbackPrices = {
        waec: { 1: 3500, 2: 3800, 3: 3200 },
        neco: { 1: 2500, 2: 2800 },
        nabteb: { 1: 2500, 2: 2800 },
        jamb: { 1: 5000, 2: 5500 },
      };

      estimatedMainAmount = fallbackPrices[service]?.[product_code] || 3000;
      estimatedMainAmount *= parseInt(quantity);
    }

    const adminFee = (estimatedMainAmount * profitPercentage) / 100;
    const totalAmount = estimatedMainAmount + adminFee;

    res.json({
      success: true,
      data: {
        mainAmount: estimatedMainAmount,
        adminFee: adminFee,
        totalAmount: totalAmount,
        profitPercentage: profitPercentage,
      },
    });
  } catch (error) {
    console.error("Price estimation error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/exam/verify-jamb", async (req, res) => {
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

  const { profilecode, product_code } = req.body;

  if (!profilecode || !product_code) {
    return res
      .status(400)
      .json({ error: "Profile code and product code are required" });
  }

  try {
    // Make VTU Africa verification call
    const vtuResponse = await makeVtuAfricaRequest("merchant-verify", {
      serviceName: "jamb",
      profilecode: profilecode,
      product_code: product_code.toString(), // 1 for UTME, 2 for Direct Entry
    });

    console.log("JAMB Verification Response:", vtuResponse);

    if (vtuResponse.code === 101) {
      res.json({
        success: true,
        message: "JAMB candidate verification successful",
        data: {
          candidateName: vtuResponse.description.Customer,
          profileCode: vtuResponse.description.ProfileCode,
          service: vtuResponse.description.Service,
          status: vtuResponse.description.Status,
        },
      });
    } else {
      res.status(400).json({
        error:
          vtuResponse.description?.message ||
          "JAMB candidate verification failed",
        data: vtuResponse,
      });
    }
  } catch (error) {
    console.error("JAMB verification error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/exam/services", async (req, res) => {
  try {
    const services = {
      waec: [
        {
          code: "1",
          name: "WAEC Result Checking PIN",
          description: "For checking WAEC results",
        },
        {
          code: "2",
          name: "WAEC GCE Registration PIN",
          description: "For WAEC GCE registration",
        },
        {
          code: "3",
          name: "WAEC Verification PIN",
          description: "For WAEC result verification",
        },
      ],
      neco: [
        {
          code: "1",
          name: "NECO Result Checking Token",
          description: "For checking NECO results",
        },
        {
          code: "2",
          name: "NECO GCE Registration PIN",
          description: "For NECO GCE registration",
        },
      ],
      nabteb: [
        {
          code: "1",
          name: "NABTEB Result Checking PIN",
          description: "For checking NABTEB results",
        },
        {
          code: "2",
          name: "NABTEB GCE Registration PIN",
          description: "For NABTEB GCE registration",
        },
      ],
      jamb: [
        {
          code: "1",
          name: "JAMB UTME Registration PIN",
          description: "For JAMB UTME registration",
        },
        {
          code: "2",
          name: "JAMB Direct Entry Registration PIN",
          description: "For JAMB Direct Entry",
        },
      ],
    };

    res.json({
      success: true,
      data: services,
    });
  } catch (error) {
    console.error("Get exam services error:", error);
    res.status(500).json({ error: error.message });
  }
});

// === BETTING VERIFICATION (EBILLS) ===
app.post("/api/betting/verify", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer "))
    return res.status(401).json({ error: "Unauthorized" });
  const idToken = authHeader.split("Bearer ")[1];

  try {
    await verifyFirebaseToken(idToken); // Verify auth
    const { service, userid } = req.body; // Frontend sends 'userid'

    if (!service || !userid) {
      return res.status(400).json({ error: "Service and user ID required" });
    }

    // Call Ebills Verify
    // Ebills expects: { customer_id, service_id }
    const ebillsResponse = await makeEbillsRequest("/verify-customer", "POST", {
      service_id: service,
      customer_id: userid,
    });

    // Check Ebills response structure
    if (ebillsResponse.code === "success") {
      res.json({
        success: true,
        message: "Account verified",
        data: {
          description: {
            Customer: ebillsResponse.data?.customer_name || "Verified Customer",
          },
        },
      });
    } else {
      res.status(400).json({
        success: false, // Explicitly set false for frontend logic
        error: ebillsResponse.message || "Verification failed",
        data: ebillsResponse,
      });
    }
  } catch (error) {
    console.error("Betting verification error:", error);
    res.status(500).json({ error: error.message });
  }
});

// === BETTING ACCOUNT FUNDING (EBILLS) ===
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

  const { service, userid, amount, ref } = req.body;

  if (!service || !userid || !amount || !ref) {
    return res.status(400).json({ error: "Missing required parameters" });
  }

  try {
    const userDoc = await db.collection("users").doc(userId).get();
    const userData = userDoc.data();

    // Get Service Charge from Firestore
    const bettingRatesDoc = await db
      .collection("settings")
      .doc("bettingRates")
      .get();
    const bettingRates = bettingRatesDoc.exists ? bettingRatesDoc.data() : {};

    const serviceChargeVal = parseFloat(bettingRates.serviceCharge) || 0;
    const chargeType = bettingRates.chargeType || "fixed";
    const amountToFund = parseFloat(amount);

    // Calculate Deduction
    let amountToDeduct = amountToFund;
    if (chargeType === "percentage") {
      amountToDeduct = amountToFund + (amountToFund * serviceChargeVal) / 100;
    } else {
      amountToDeduct = amountToFund + serviceChargeVal;
    }

    if (amountToDeduct > userData.walletBalance) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    // Call Ebills
    const ebillsResponse = await makeEbillsRequest("/betting", "POST", {
      request_id: ref,
      service_id: service, // e.g., 'bet9ja'
      customer_id: userid, // The betting account ID
      amount: amountToFund,
    });

    if (ebillsResponse.code === "success") {
      const batch = db.batch();

      // Deduct Wallet (Total = Amount + Service Charge)
      batch.update(db.collection("users").doc(userId), {
        walletBalance: admin.firestore.FieldValue.increment(-amountToDeduct),
      });

      // Record Transaction
      batch.set(
        db.collection("users").doc(userId).collection("transactions").doc(ref),
        {
          userId,
          type: "betting",
          service,
          userid,
          amountToProvider: amountToFund,
          amountCharged: amountToDeduct,
          serviceCharge: amountToDeduct - amountToFund,
          reference: ref,
          status: "success",
          description: `${service} Funding for ${userid}`,
          providerResponse: ebillsResponse,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        }
      );

      await batch.commit();

      res.json({
        success: true,
        message: "Betting account funded successfully",
        data: ebillsResponse,
      });
    } else {
      // Handle Failure
      res.status(400).json({
        error: ebillsResponse.message || "Betting funding failed",
        data: ebillsResponse,
      });
    }
  } catch (error) {
    console.error("Betting funding error:", error);
    res.status(500).json({ error: error.message });
  }
});

// === BULK SMS PURCHASE ===
app.post("/api/sms/purchase", async (req, res) => {
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

  const { message, sendto, sender, ref } = req.body;
  if (!message || !sendto || !sender || !ref) {
    return res.status(400).json({ error: "Missing required parameters" });
  }

  try {
    const userDoc = await db.collection("users").doc(userId).get();
    const userData = userDoc.data();

    // Get SMS rate from Firestore
    const smsRatesDoc = await db.collection("settings").doc("smsRates").get();
    const smsRate = smsRatesDoc.exists
      ? smsRatesDoc.data().pricePerSms || 2
      : 2; // default ₦2

    const numbers = sendto.split(",").filter((n) => n.trim());
    const totalCost = numbers.length * smsRate;

    if (totalCost > userData.walletBalance) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    const vtuResponse = await makeVtuAfricaRequest("sms", {
      message,
      sendto,
      sender,
      ref,
    });

    if (vtuResponse.code === 101) {
      await db
        .collection("users")
        .doc(userId)
        .update({
          walletBalance: admin.firestore.FieldValue.increment(-totalCost),
        });

      await db
        .collection("users")
        .doc(userId)
        .collection("transactions")
        .add({
          userId,
          type: "sms",
          message,
          recipients: numbers.length,
          amountCharged: totalCost,
          reference: ref,
          status: "success",
          description: `Bulk SMS to ${numbers.length} contacts`,
          vtuResponse,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

      res.json({ success: true, data: vtuResponse, charged: totalCost });
    } else {
      res
        .status(400)
        .json({ error: vtuResponse.description?.message || "SMS failed" });
    }
  } catch (error) {
    console.error("SMS error:", error);
    res.status(500).json({ error: error.message });
  }
});

// === AIRTIME TO CASH CONVERSION - CORRECTED ===

// === VERIFY SERVICE AVAILABILITY ===
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
      network: network.toLowerCase(),
    });

    console.log("VTU Africa Verify Response:", vtuResponse);

    if (
      vtuResponse.code === 101 &&
      vtuResponse.description?.Status === "Completed"
    ) {
      // Extract the phone number from VTU response
      const vtuPhoneNumber = vtuResponse.description?.Phone_Number;
      const vtuNetwork = vtuResponse.description?.Network;
      const message = vtuResponse.description?.message;

      res.json({
        success: true,
        message: "Airtime to cash service available",
        data: {
          status: vtuResponse.description.Status,
          phoneNumber: vtuPhoneNumber,
          network: vtuNetwork,
          message: message,
          instructions: message || `Transfer airtime to ${vtuPhoneNumber}`,
        },
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

// === CONVERT AIRTIME TO CASH ===
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

  // Validate amount
  const amountValue = parseFloat(amount);
  if (amountValue < 100) {
    return res.status(400).json({ error: "Minimum amount is ₦100" });
  }

  // Glo has maximum of ₦1000 per transfer
  if (network.toLowerCase() === "glo" && amountValue > 1000) {
    return res.status(400).json({ error: "Maximum amount for Glo is ₦1000" });
  }

  try {
    // Get user data
    const userDoc = await db.collection("users").doc(userId).get();
    const userData = userDoc.data();

    // Get conversion rates from settings
    const ratesDoc = await db
      .collection("settings")
      .doc("airtimeToCashRates")
      .get();
    const rates = ratesDoc.exists ? ratesDoc.data() : {};

    const networkRate = rates[network.toLowerCase()] || {
      rate: 0.7,
      charge: 30,
      enabled: true,
    };

    // Check if service is enabled for this network
    if (!networkRate.enabled) {
      return res.status(400).json({
        error: `Airtime to cash service is currently disabled for ${network.toUpperCase()}`,
      });
    }

    const conversionRate = networkRate.rate;
    const expectedCredit = amountValue * conversionRate;
    const serviceFee = amountValue * (1 - conversionRate);

    // Build parameters
    const params = {
      network: network.toLowerCase(),
      sender: sender || userData.email,
      sendernumber,
      amount: amountValue,
      ref,
      webhookURL: "https://higestdata-proxy.onrender.com/webhook/vtu",
    };

    if (sitephone) params.sitephone = sitephone;

    console.log("Airtime to Cash Request:", params);

    // Make VTU Africa API call
    const vtuResponse = await makeVtuAfricaRequest("airtime-cash", params);

    console.log("VTU Africa Convert Response:", vtuResponse);

    if (vtuResponse.code === 101) {
      // Create transaction record (status: processing)
      const transactionData = {
        userId,
        type: "airtime_cash",
        network: network.toLowerCase(),
        sender,
        sendernumber,
        amount: amountValue,
        expectedCredit: expectedCredit,
        serviceFee: serviceFee,
        conversionRate: conversionRate,
        reference: ref,
        status: "processing",
        description: `Airtime to Cash - ${network.toUpperCase()} ₦${amountValue}`,
        vtuResponse: vtuResponse.description,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 minutes from now
      };

      await db
        .collection("users")
        .doc(userId)
        .collection("transactions")
        .doc(ref)
        .set(transactionData);

      res.json({
        success: true,
        message: "Airtime conversion request received",
        data: {
          reference: ref,
          status: "processing",
          amount: amountValue,
          expectedCredit: expectedCredit,
          serviceFee: serviceFee,
          network: network.toLowerCase(),
          message: vtuResponse.description?.message,
          instructions: `Please transfer ₦${amountValue} airtime within 30 minutes`,
        },
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

// === VTU AFRICA WEBHOOK HANDLER - CORRECTED ===
app.post("/webhook/vtu", async (req, res) => {
  try {
    const payload = req.body;
    console.log(
      "VTU Africa Webhook Received:",
      JSON.stringify(payload, null, 2)
    );

    // Immediate response as required by VTU Africa
    res.json({
      code: 101,
      status: "Completed",
      message: "Webhook received successfully",
    });

    // Process Airtime2Cash webhook
    if (payload.service === "Airtime2Cash" && payload.status === "Completed") {
      const {
        ref,
        credit, // Amount customer receives
        amount, // Original airtime amount
        Charge, // Service charge
        sender, // Customer email/identifier
        network,
      } = payload;

      console.log(
        `Processing A2C webhook: ref=${ref}, credit=${credit}, amount=${amount}`
      );

      // Find the transaction
      const snap = await db
        .collectionGroup("transactions")
        .where("reference", "==", ref)
        .where("type", "==", "airtime_cash")
        .limit(1)
        .get();

      if (!snap.empty) {
        const txnDoc = snap.docs[0];
        const txnData = txnDoc.data();
        const userId = txnData.userId;

        // Check if already processed
        if (txnData.status === "completed") {
          console.log(`A2C transaction ${ref} already completed`);
          return;
        }

        const creditAmount = parseFloat(credit) || 0;

        const batch = db.batch();

        // Credit user wallet
        const userRef = db.collection("users").doc(userId);
        batch.update(userRef, {
          walletBalance: admin.firestore.FieldValue.increment(creditAmount),
        });

        // Update transaction status
        batch.update(txnDoc.ref, {
          status: "completed",
          creditAmount: creditAmount,
          actualCharge: parseFloat(Charge) || 0,
          webhookPayload: payload,
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        await batch.commit();

        console.log(
          `A2C Success: Credited ₦${creditAmount} to user ${userId} for ref ${ref}`
        );

        // Get user data for email
        const userDoc = await db.collection("users").doc(userId).get();
        const userData = userDoc.data();

        // Send success email
        await sendEmail(
          userData.email,
          "Airtime to Cash Conversion Successful",
          `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 30px; border: 1px solid #eee; border-radius: 10px;">
            <h2 style="color: #10b981;">Conversion Completed!</h2>
            <p>Hello <strong>${
              userData.fullName || userData.email
            }</strong>,</p>
            <p>Your airtime to cash conversion has been completed successfully.</p>
            <div style="background-color: #f3f4f6; padding: 15px; border-radius: 8px; margin: 20px 0;">
              <p><strong>Network:</strong> ${network?.toUpperCase()}</p>
              <p><strong>Airtime Sent:</strong> ₦${amount?.toLocaleString()}</p>
              <p><strong>Amount Credited:</strong> ₦${creditAmount.toLocaleString()}</p>
              <p><strong>Service Charge:</strong> ₦${parseFloat(
                Charge || 0
              ).toLocaleString()}</p>
              <p><strong>Reference:</strong> ${ref}</p>
            </div>
            <p>Your wallet has been credited with <strong>₦${creditAmount.toLocaleString()}</strong>.</p>
            <p>Thank you for using Highest Data!</p>
          </div>`
        );
      } else {
        console.log(`A2C transaction not found for ref: ${ref}`);
      }
    }

    // Handle failed status
    else if (
      payload.service === "Airtime2Cash" &&
      payload.status === "Failed"
    ) {
      const { ref, message } = payload;

      console.log(`Processing A2C failed webhook: ref=${ref}`);

      const snap = await db
        .collectionGroup("transactions")
        .where("reference", "==", ref)
        .where("type", "==", "airtime_cash")
        .limit(1)
        .get();

      if (!snap.empty) {
        const txnDoc = snap.docs[0];

        await txnDoc.ref.update({
          status: "failed",
          failureReason: message || "Airtime transfer not received",
          failedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        console.log(`A2C Failed: ref ${ref} marked as failed`);
      }
    }
  } catch (err) {
    console.error("VTU Webhook processing error:", err);
  }
});

// === GET AIRTIME TO CASH RATES (for frontend) ===
app.get("/api/airtime-cash/rates", async (req, res) => {
  try {
    const ratesDoc = await db
      .collection("settings")
      .doc("airtimeToCashRates")
      .get();

    if (ratesDoc.exists) {
      const rates = ratesDoc.data();
      res.json({
        success: true,
        data: rates,
      });
    } else {
      // Return default rates
      res.json({
        success: true,
        data: {
          mtn: { rate: 0.7, charge: 30, enabled: true },
          airtel: { rate: 0.65, charge: 35, enabled: true },
          glo: { rate: 0.55, charge: 45, enabled: true },
          "9mobile": { rate: 0.55, charge: 45, enabled: true },
        },
      });
    }
  } catch (error) {
    console.error("Error fetching A2C rates:", error);
    res.status(500).json({ error: "Failed to fetch rates" });
  }
});

// ... BULK EMAIL / NEWSLETTER ENDPOINTS ...

// === NEW: GET CAMPAIGN HISTORY (FIXED) ===
app.get("/api/newsletter/history", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer "))
    return res.status(401).json({ error: "Unauthorized" });
  const idToken = authHeader.split("Bearer ")[1];

  try {
    await verifyFirebaseToken(idToken);

    // Dynamic import for MailerLite
    const MailerLite = (await import("@mailerlite/mailerlite-nodejs")).default;
    const mailerlite = new MailerLite({
      api_key: process.env.MAILERLITE_API_KEY,
    });

    // FIX: Use limit 25 (valid) and remove 'sort' (unsupported)
    // MailerLite returns the newest campaigns first by default.
    const response = await mailerlite.campaigns.get({
      limit: 25,
      page: 1,
    });

    const history = response.data.data.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      stats: c.stats,
      created_at: c.created_at,
      scheduled_for: c.scheduled_for,
    }));

    res.json({ success: true, history });
  } catch (error) {
    // Improved error logging to see the real issue in Render logs
    console.error(
      "Fetch history error:",
      error.response ? error.response.data : error.message
    );
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

// === NEW: GET USERS FOR REVIEW ===
app.get("/api/admin/users", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer "))
    return res.status(401).json({ error: "Unauthorized" });
  const idToken = authHeader.split("Bearer ")[1];

  try {
    await verifyFirebaseToken(idToken); // Verify admin

    const usersSnapshot = await db.collection("users").get();
    const users = [];

    usersSnapshot.forEach((doc) => {
      const data = doc.data();
      if (data.email) {
        users.push({
          email: data.email,
          name: data.fullName || data.displayName || "Valued Customer",
        });
      }
    });

    res.json({ success: true, users });
  } catch (error) {
    console.error("Fetch users error:", error);
    res.status(500).json({ error: error.message });
  }
});

// === UPDATED: SEND NEWSLETTER (With Safety Delay) ===
app.post("/api/newsletter/send", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer "))
    return res.status(401).json({ error: "Unauthorized" });
  const idToken = authHeader.split("Bearer ")[1];

  try {
    await verifyFirebaseToken(idToken);
    const { subject, content, recipients } = req.body;

    if (!subject || !content || !recipients || recipients.length === 0) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const MailerLite = (await import("@mailerlite/mailerlite-nodejs")).default;
    const mailerlite = new MailerLite({
      api_key: process.env.MAILERLITE_API_KEY,
    });

    // 1. PREPARE GROUP
    let groupId;
    const groupsResponse = await mailerlite.groups.get({
      filter: { name: "Website Users" },
    });
    if (groupsResponse.data.data && groupsResponse.data.data.length > 0) {
      groupId = groupsResponse.data.data[0].id;
    } else {
      const newGroup = await mailerlite.groups.create({
        name: "Website Users",
      });
      groupId = newGroup.data.data.id;
    }

    // 2. BATCH SYNC
    const BATCH_SIZE = 50;
    const chunks = [];
    for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
      chunks.push(recipients.slice(i, i + BATCH_SIZE));
    }

    console.log(`Syncing ${recipients.length} users to MailerLite...`);
    for (const chunk of chunks) {
      const batchRequests = chunk.map((user) => ({
        method: "POST",
        path: "/api/subscribers",
        body: {
          email: user.email,
          fields: { name: user.name },
          groups: [groupId],
          status: "active",
        },
      }));
      await mailerlite.batches.send({ requests: batchRequests });
    }

    // === CRITICAL FIX: SAFETY DELAY ===
    // Wait 3 seconds to let MailerLite process the batch import
    // before we try to send to this group.
    console.log("Waiting for MailerLite indexing...");
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // 3. CREATE CAMPAIGN
    const campaignParams = {
      name: subject, // Simplified name for cleaner history
      type: "regular",
      emails: [
        {
          subject: subject,
          from_name: "Highest Data",
          from: "info@highestdata.com.ng",
          content: `<!DOCTYPE html><html><body>${content}<br/><br/><small><a href="{$unsubscribe}">Unsubscribe</a></small></body></html>`,
        },
      ],
      groups: [groupId],
    };

    const campaignResponse = await mailerlite.campaigns.create(campaignParams);
    const campaignId = campaignResponse.data.data.id;

    // 4. SCHEDULE
    await mailerlite.campaigns.schedule(campaignId, { delivery: "instant" });

    res.json({ success: true, message: "Campaign queued successfully!" });
  } catch (error) {
    console.error("Newsletter Error:", error?.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// === OGAVIRAL (SMM) INTEGRATION START ===
// ==========================================

// --- Endpoint: Get Services (With Admin Profit Margin) ---
app.get("/api/smm/services", async (req, res) => {
  try {
    // 1. Fetch raw services from OgaViral
    const providerServices = await makeOgaviralRequest("services");

    // 2. Fetch Admin Settings (Profit Margin)
    const settingsDoc = await db.collection("settings").doc("smmRates").get();
    const settings = settingsDoc.exists
      ? settingsDoc.data()
      : { profitPercentage: 20 }; // Default 20% profit
    const profitMultiplier = 1 + settings.profitPercentage / 100;

    // 3. Process services: Filter valid ones & apply markup
    // OgaViral returns an array of objects. We map to add user_rate.
    const processedServices = providerServices.map((service) => ({
      service: service.service,
      name: service.name,
      type: service.type,
      category: service.category,
      min: service.min,
      max: service.max,
      rate: service.rate, // Provider rate (for reference/admin)
      user_rate: (parseFloat(service.rate) * profitMultiplier).toFixed(2), // Rate shown to user per 1000
      dripfeed: service.dripfeed,
      refill: service.refill,
      cancel: service.cancel,
    }));

    res.json({
      success: true,
      data: processedServices,
      profitPercentage: settings.profitPercentage,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Endpoint: Place SMM Order ---
app.post("/api/smm/order", async (req, res) => {
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

  const { serviceId, link, quantity, serviceName, categoryName } = req.body;

  if (!serviceId || !link || !quantity) {
    return res.status(400).json({ error: "Missing parameters" });
  }

  try {
    const userDoc = await db.collection("users").doc(userId).get();
    const userData = userDoc.data();

    // 1. Get Service Details to Calculate Price
    // (In production, cache services or fetch specific one to avoid fetching all 2000+ every time)
    const services = await makeOgaviralRequest("services");
    const selectedService = services.find((s) => s.service == serviceId);

    if (!selectedService)
      return res.status(400).json({ error: "Service not found or disabled" });

    // Validate Quantity
    if (
      quantity < parseInt(selectedService.min) ||
      quantity > parseInt(selectedService.max)
    ) {
      return res.status(400).json({
        error: `Quantity must be between ${selectedService.min} and ${selectedService.max}`,
      });
    }

    // 2. Calculate Cost
    const settingsDoc = await db.collection("settings").doc("smmRates").get();
    const profitPercentage = settingsDoc.exists
      ? settingsDoc.data().profitPercentage
      : 20;

    // Rate is per 1000. Formula: (Rate * Quantity) / 1000
    const providerCost = (parseFloat(selectedService.rate) * quantity) / 1000;
    const userCost = providerCost * (1 + profitPercentage / 100);

    if (userCost > userData.walletBalance) {
      return res.status(400).json({ error: "Insufficient wallet balance" });
    }

    // 3. Place Order with OgaViral
    const orderResponse = await makeOgaviralRequest("add", {
      service: serviceId,
      link: link,
      quantity: quantity,
    });

    if (!orderResponse.order) {
      throw new Error("Provider did not return an order ID");
    }

    const orderId = orderResponse.order;

    // 4. Deduct Balance & Save Transaction
    const batch = db.batch();

    // Deduct
    batch.update(db.collection("users").doc(userId), {
      walletBalance: admin.firestore.FieldValue.increment(-userCost),
    });

    // Record Transaction
    const ref = `SMM_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    batch.set(
      db.collection("users").doc(userId).collection("transactions").doc(ref),
      {
        userId,
        type: "smm",
        serviceId,
        serviceName: serviceName || selectedService.name,
        category: categoryName || selectedService.category,
        link,
        quantity,
        providerOrderId: orderId,
        amountCharged: userCost,
        amountToProvider: providerCost,
        profit: userCost - providerCost,
        reference: ref,
        status: "success", // SMM orders are usually "pending" delivery but "success" submission
        deliveryStatus: "Pending", // You can track actual delivery status separately
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }
    );

    await batch.commit();

    res.json({
      success: true,
      message: "Social Boost Order Placed Successfully!",
      data: { orderId, cost: userCost },
    });
  } catch (error) {
    console.error("SMM Order Failed:", error);
    res.status(500).json({ error: error.message });
  }
});

// --- Endpoint: Admin Set Rates ---
app.post("/api/admin/smm-rates", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer "))
    return res.status(401).json({ error: "Unauthorized" });

  // Add Admin Check logic here if needed (e.g. check if userData.role === 'admin')

  const { profitPercentage } = req.body;
  await db
    .collection("settings")
    .doc("smmRates")
    .set({ profitPercentage }, { merge: true });
  res.json({ success: true, message: "SMM Rates updated" });
});

// --- Endpoint: Get User's SMM Orders & Sync Status ---
app.get("/api/smm/orders", async (req, res) => {
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

  try {
    // 1. Fetch last 50 SMM transactions from Firestore
    const snapshot = await db
      .collection("users")
      .doc(userId)
      .collection("transactions")
      .where("type", "==", "smm")
      .orderBy("createdAt", "desc")
      .limit(50)
      .get();

    if (snapshot.empty) {
      return res.json({ success: true, data: [] });
    }

    const orders = [];
    const orderIdsToCheck = [];

    snapshot.forEach((doc) => {
      const data = doc.data();
      orders.push({ id: doc.id, ...data });
      // Only check status for orders that haven't reached a final state
      // Common final states: Completed, Canceled, Refunded, Partial
      if (
        data.providerOrderId &&
        !["Completed", "Canceled", "Refunded"].includes(data.deliveryStatus)
      ) {
        orderIdsToCheck.push(data.providerOrderId);
      }
    });

    // 2. Batch Check Status with OgaViral (if needed)
    if (orderIdsToCheck.length > 0) {
      try {
        // OgaViral supports up to 100 IDs comma-separated
        const statusResponse = await makeOgaviralRequest("status", {
          orders: orderIdsToCheck.join(","),
        });

        const batch = db.batch();
        let updatesMade = false;

        orders.forEach((order) => {
          if (order.providerOrderId && statusResponse[order.providerOrderId]) {
            const newStatus = statusResponse[order.providerOrderId].status;
            const remains = statusResponse[order.providerOrderId].remains;

            // If status changed, update local DB
            if (newStatus && newStatus !== order.deliveryStatus) {
              const docRef = db
                .collection("users")
                .doc(userId)
                .collection("transactions")
                .doc(order.id);
              batch.update(docRef, {
                deliveryStatus: newStatus,
                remains: remains || 0,
                lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
              });

              // Update the order object in memory to return fresh data immediately
              order.deliveryStatus = newStatus;
              order.remains = remains;
              updatesMade = true;
            }
          }
        });

        if (updatesMade) await batch.commit();
      } catch (err) {
        console.error("Failed to sync status with provider:", err.message);
        // Continue to return the cached data even if sync fails
      }
    }

    res.json({ success: true, data: orders });
  } catch (error) {
    console.error("Get SMM Orders Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// === OGAVIRAL INTEGRATION END ===
// ==========================================

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

//SAFEHAVEN

app.get("/api/safehaven/virtual-account", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer "))
    return res.status(401).json({ error: "Unauthorized" });
  const idToken = authHeader.split("Bearer ")[1];

  try {
    const userId = await verifyFirebaseToken(idToken);
    const userRef = db.collection("users").doc(userId);
    const userDoc = await userRef.get();
    const userData = userDoc.data();

    // 1. Return existing account if available
    if (userData.safeHavenAccount) {
      return res.json({ success: true, account: userData.safeHavenAccount });
    }

    // 2. Create new Sub-Account if none exists
    // We need a unique external reference.
    const extRef = `SUB_${userId}_${Date.now()}`;

    // Using default/placeholder phone if user doesn't have one set, as it's required
    const payload = {
      phoneNumber: userData.phoneNumber || "+2348000000000",
      emailAddress: userData.email,
      externalReference: extRef,
      identityType: "BVN",
      identityNumber: userData.kycData?.bvn || "12345678901", // Make sure to handle unverified users appropriately
      otp: "123456", // Usually required if not using a whitelisted verification flow. Check your specific SH integration mode.
      autoSweep: false,
      autoSweepDetails: { schedule: "Instant", accountNumber: "" },
    };

    // Note: Creating a sub-account strictly usually requires Identity Verification first
    // per the docs. If you are using the "Aggregator" model, you might use a different endpoint
    // or pass verified identity ID. Assuming 'createSubAccountNew' logic here based on docs:

    const { status, data: shData } = await makeSafeHavenRequest(
      "/accounts/v2/subaccount",
      "POST",
      payload
    );

    if (status === 200 && shData.data) {
      const accountDetails = {
        accountNumber: shData.data.accountNumber,
        accountName: shData.data.accountName,
        bankName: "Safe Haven MFB",
        bankCode: "090286",
        subAccountId: shData.data._id,
      };

      // Save to user profile
      await userRef.update({ safeHavenAccount: accountDetails });

      return res.json({ success: true, account: accountDetails });
    } else {
      console.error("Failed to create SH Account:", shData);
      return res
        .status(400)
        .json({ error: shData.message || "Failed to generate account" });
    }
  } catch (error) {
    console.error("Virtual Account Error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/banks", async (req, res) => {
  try {
    const { data } = await makeSafeHavenRequest("/transfers/banks");

    if (data.data) {
      // Map to frontend format
      const formatted = data.data.map((b) => ({
        code: b.bankCode,
        name: b.name,
      }));
      res.json({ success: true, data: formatted });
    } else {
      res.status(400).json({ success: false, error: "Could not fetch banks" });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/resolve-account", async (req, res) => {
  const { bankCode, accountNumber } = req.body;
  try {
    const { data } = await makeSafeHavenRequest(
      "/transfers/name-enquiry",
      "POST",
      {
        bankCode,
        accountNumber,
      }
    );

    if (data.data && data.data.accountName) {
      res.json({
        success: true,
        data: {
          account_name: data.data.accountName,
          // Important: We need the sessionId for the transfer later
          sessionId: data.data.sessionId,
        },
      });
    } else {
      res.status(400).json({ success: false, error: "Account not found" });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/withdrawal/process", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer "))
    return res.status(401).json({ error: "Unauthorized" });
  const idToken = authHeader.split("Bearer ")[1];

  try {
    const userId = await verifyFirebaseToken(idToken);
    const { amount, bankCode, accountNumber, accountName } = req.body;

    // 1. Validate Balance
    const withdrawalAmount = parseFloat(amount);
    const FEE = 50;
    const totalDeduct = withdrawalAmount + FEE;

    const userRef = db.collection("users").doc(userId);
    const userDoc = await userRef.get();
    if (userDoc.data().walletBalance < totalDeduct) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    // 2. Perform Name Enquiry to get SessionID (Required by Safe Haven for Transfer)
    // Even if frontend did it, we do it again to get a fresh SessionID for security
    const enquiryRes = await makeSafeHavenRequest(
      "/transfers/name-enquiry",
      "POST",
      {
        bankCode,
        accountNumber,
      }
    );

    if (!enquiryRes.data.data || !enquiryRes.data.data.sessionId) {
      return res
        .status(400)
        .json({ error: "Failed to verify account session" });
    }
    const sessionId = enquiryRes.data.data.sessionId;
    const reference = `WDR_${userId}_${Date.now()}`;

    // 3. Deduct Wallet & Create Records (Optimistic Update)
    const batch = db.batch();

    batch.update(userRef, {
      walletBalance: admin.firestore.FieldValue.increment(-totalDeduct),
    });

    const txnRef = userRef.collection("transactions").doc(reference);
    batch.set(txnRef, {
      userId,
      reference,
      type: "debit",
      description: `Withdrawal to ${accountName}`,
      amount: -totalDeduct,
      status: "processing",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const reqRef = db.collection("withdrawalRequests").doc(reference);
    batch.set(reqRef, {
      userId,
      reference,
      amount: withdrawalAmount,
      totalDeduct,
      fee: FEE,
      bankCode,
      accountNumber,
      accountName,
      status: "processing",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();

    // 4. Initiate Transfer with Safe Haven
    const transferPayload = {
      nameEnquiryReference: sessionId,
      debitAccountNumber: process.env.SAFE_HAVEN_MAIN_ACCOUNT, // Your main Safe Haven account number
      beneficiaryBankCode: bankCode,
      beneficiaryAccountNumber: accountNumber,
      amount: withdrawalAmount,
      saveBeneficiary: false,
      narration: `Withdrawal Ref ${reference}`,
      paymentReference: reference,
    };

    const { status, data: transferData } = await makeSafeHavenRequest(
      "/transfers",
      "POST",
      transferPayload
    );

    if (status === 200 && transferData.data) {
      // Update records with provider reference
      await reqRef.update({
        providerRef: transferData.data.sessionId, // Safe Haven uses SessionId as ref often
        status: "processing",
      });

      res.json({ success: true, message: "Transfer initiated successfully" });
    } else {
      // 5. Rollback on Failure
      const rollbackBatch = db.batch();
      rollbackBatch.update(userRef, {
        walletBalance: admin.firestore.FieldValue.increment(totalDeduct),
      });
      rollbackBatch.update(txnRef, { status: "failed" });
      rollbackBatch.update(reqRef, {
        status: "failed",
        reason: transferData.message,
      });
      await rollbackBatch.commit();

      res
        .status(400)
        .json({ error: "Transfer initiation failed", details: transferData });
    }
  } catch (error) {
    console.error("Withdrawal Error:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/webhooks", async (req, res) => {
  const payload = req.body;
  console.log("Safe Haven Webhook:", JSON.stringify(payload, null, 2));

  try {
    // === 1. FUNDING (Inwards Transfer) ===
    // Safe Haven event type for incoming money to Virtual Account
    if (
      payload.type === "virtualAccount.transfer" ||
      (payload.data && payload.data.type === "Inwards")
    ) {
      const data = payload.data;
      const amount = data.amount;
      const ref = data.paymentReference;
      const accountNum = data.creditAccountNumber; // The Virtual Account Number

      // Find user who owns this Virtual Account
      // You might want to create a 'virtualAccounts' collection to map Number -> UserId for faster lookups
      // Or query users collection where safeHavenAccount.accountNumber == accountNum
      const userQuery = await db
        .collection("users")
        .where("safeHavenAccount.accountNumber", "==", accountNum)
        .limit(1)
        .get();

      if (!userQuery.empty) {
        const userDoc = userQuery.docs[0];
        const userId = userDoc.id;

        // Check if transaction already processed
        const txnCheck = await userDoc.ref
          .collection("transactions")
          .doc(ref)
          .get();
        if (txnCheck.exists) {
          return res.status(200).send("Duplicate");
        }

        const batch = db.batch();
        batch.update(userDoc.ref, {
          walletBalance: admin.firestore.FieldValue.increment(amount),
        });

        batch.set(userDoc.ref.collection("transactions").doc(ref), {
          userId,
          reference: ref,
          type: "credit",
          amount: amount,
          description: `Wallet Funding via Transfer from ${
            data.debitAccountName || "Bank"
          }`,
          status: "success",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          webhookData: data,
        });

        await batch.commit();
        console.log(`Credited N${amount} to user ${userId}`);
      }
    }

    // === 2. WITHDRAWAL STATUS (Outwards Transfer) ===
    if (payload.type === "transfer" && payload.data.type === "Outwards") {
      const data = payload.data;
      const ref = data.paymentReference; // We sent our Ref here
      const status = data.status; // "Completed" or "Failed"

      const reqDoc = await db.collection("withdrawalRequests").doc(ref).get();

      if (reqDoc.exists && reqDoc.data().status === "processing") {
        const userId = reqDoc.data().userId;
        const totalDeduct = reqDoc.data().totalDeduct;

        if (status === "Completed") {
          await reqDoc.ref.update({
            status: "success",
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          await db
            .collection("users")
            .doc(userId)
            .collection("transactions")
            .doc(ref)
            .update({ status: "success" });
          // Trigger Email here...
        } else if (status === "Failed" || status === "Reversed") {
          // Refund User
          const batch = db.batch();
          batch.update(db.collection("users").doc(userId), {
            walletBalance: admin.firestore.FieldValue.increment(totalDeduct),
          });
          batch.update(reqDoc.ref, {
            status: "failed",
            failedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          batch.update(
            db
              .collection("users")
              .doc(userId)
              .collection("transactions")
              .doc(ref),
            { status: "failed" }
          );
          await batch.commit();
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook Error:", err);
    res.sendStatus(500);
  }
});

// === HEALTH CHECK. ===
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
    urls: ["/webhook/vtu"],
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
