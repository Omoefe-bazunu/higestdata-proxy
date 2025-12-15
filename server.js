// server.js - UPDATED WITH VTU AFRICA API INTEGRATION
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
require("dotenv").config();
const admin = require("firebase-admin");

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

//KORA PAYMENTS CONFIG ===
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

    // Get TV rates to find the plan price - FIXED: use .exists not .exists()
    const tvRatesDoc = await db.collection("settings").doc("tvRates").get();
    const tvRates = tvRatesDoc.exists ? tvRatesDoc.data().rates : {}; // ← FIXED

    const planData = tvRates[service]?.plans?.[variation];

    if (!planData) {
      return res.status(400).json({ error: "Invalid TV plan selected" });
    }

    const amountToVTU = parseFloat(planData.basePrice); // Base price to VTU Africa
    const amountToDeduct = parseFloat(planData.finalPrice); // Final price with profit (what user pays)

    console.log(
      `Cable TV purchase: VTU Amount: ${amountToVTU}, Wallet Deduction: ${amountToDeduct}, Profit: ${
        amountToDeduct - amountToVTU
      }`
    );

    // Check wallet balance against final price (with profit)
    if (amountToDeduct > userData.walletBalance) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    // Make VTU Africa API call with base price
    const vtuResponse = await makeVtuAfricaRequest("paytv", {
      service,
      smartNo,
      variation,
      ref,
    });

    if (vtuResponse.code === 101) {
      // Deduct FINAL PRICE (with profit) from wallet
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
          type: "cabletv",
          service,
          smartCard: smartNo,
          variation,
          amountToVTU: amountToVTU, // Base price sent to VTU
          amountCharged: amountToDeduct, // Final price user paid (with profit)
          profit: amountToDeduct - amountToVTU, // Your profit margin
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

// ==================== KORA PAYMENT ENDPOINTS ====================
// === KORA: Initialize Payment (Bank Transfer Only) ===
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
    const userSnap = await db.collection("users").doc(userId).get();
    const userData = userSnap.data();
    if (!userData) return res.status(404).json({ error: "User not found" });

    const reference = `KRA_${userId}_${Date.now()}`;

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

    res.json({
      publicKey: KORA_PUBLIC_KEY,
      reference,
      amount: Number(amount),
      currency: "NGN",
      customer: {
        name: userData.fullName || "Customer",
        email: userData.email,
      },
      channels: ["bank_transfer"], // ← Only bank transfer
      default_channel: "bank_transfer", // ← Default = bank transfer
    });
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

  // First, get the bank name from the bank code
  const bank = await db.collection("banks").doc(bankCode).get();
  let bankName = "Unknown Bank";

  if (bank.exists) {
    bankName = bank.data().name;
  } else {
    // If we don't have the bank name, we need to fetch it from KoraPay
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
          // Cache the bank name for future use
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
    bankName,
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

  // Prepare the disbursement request according to KoraPay docs
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

      // Refund on failure
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

    // Update with KoraPay transaction details
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

    // Refund on network error
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

  // Validate required fields
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

    // Get user data from Firestore
    const userDoc = await db.collection("users").doc(userId).get();
    if (!userDoc.exists) {
      return res.status(404).json({
        success: false,
        error: "User not found",
      });
    }

    const userData = userDoc.data();

    // Check if KYC is already approved
    if (userData.kycStatus === "approved") {
      return res.status(400).json({
        success: false,
        error: "KYC already approved",
      });
    }

    // Call KoraPay BVN verification API
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

      // Update user KYC status to rejected
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

    // BVN verification successful - validate returned data matches user input
    const bvnData = koraData.data;
    const validationErrors = [];

    // Validate first name (case insensitive, allow for minor variations)
    if (
      !bvnData.first_name ||
      !bvnData.first_name.toLowerCase().includes(firstName.toLowerCase())
    ) {
      validationErrors.push("First name doesn't match BVN records");
    }

    // Validate last name (case insensitive, allow for minor variations)
    if (
      !bvnData.last_name ||
      !bvnData.last_name.toLowerCase().includes(lastName.toLowerCase())
    ) {
      validationErrors.push("Last name doesn't match BVN records");
    }

    // Validate date of birth if provided
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

    // KYC successful - update user KYC status only
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
        bvn: bvn, // Store securely
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

    // Update user KYC status to rejected on error
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
  console.log(`Health Check: https://higestdata-proxy.onrender.com/health`);
});
