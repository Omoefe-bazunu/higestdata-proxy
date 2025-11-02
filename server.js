const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// Load from environment variables
const EBILLS_API_URL =
  process.env.EBILLS_API_URL || "https://ebills.africa/wp-json/api/v2/";
const EBILLS_AUTH_URL =
  process.env.EBILLS_AUTH_URL ||
  "https://ebills.africa/wp-json/jwt-auth/v1/token";

let token = null;

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Get eBills token
async function getAccessToken() {
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

// Auth endpoint
app.post("/auth", async (req, res) => {
  try {
    const token = await getAccessToken();
    res.json({ success: true, token });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Balance endpoint
app.get("/balance", async (req, res) => {
  try {
    if (!token) await getAccessToken();

    const response = await fetch(`${EBILLS_API_URL}balance`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Data variations
app.get("/variations/data", async (req, res) => {
  try {
    if (!token) await getAccessToken();

    const serviceId = req.query.service_id;
    let url = `${EBILLS_API_URL}variations/data`;
    if (serviceId) url += `?service_id=${serviceId}`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// TV variations
app.get("/variations/tv", async (req, res) => {
  try {
    if (!token) await getAccessToken();

    const serviceId = req.query.service_id;
    let url = `${EBILLS_API_URL}variations/tv`;
    if (serviceId) url += `?service_id=${serviceId}`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Verify customer
app.post("/verify-customer", async (req, res) => {
  try {
    if (!token) await getAccessToken();

    const response = await fetch(`${EBILLS_API_URL}verify-customer`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Airtime purchase
app.post("/airtime", async (req, res) => {
  try {
    if (!token) await getAccessToken();

    const response = await fetch(`${EBILLS_API_URL}airtime`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Data purchase
app.post("/data", async (req, res) => {
  try {
    if (!token) await getAccessToken();

    const response = await fetch(`${EBILLS_API_URL}data`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// TV purchase
app.post("/tv", async (req, res) => {
  try {
    if (!token) await getAccessToken();

    const response = await fetch(`${EBILLS_API_URL}tv`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Electricity purchase
app.post("/electricity", async (req, res) => {
  try {
    if (!token) await getAccessToken();

    const response = await fetch(`${EBILLS_API_URL}electricity`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Betting funding
app.post("/betting", async (req, res) => {
  try {
    if (!token) await getAccessToken();

    const response = await fetch(`${EBILLS_API_URL}betting`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// KORA PAYMENT GATEWAY ROUTES
// ============================================

// Get Kora banks
app.get("/kora/banks", async (req, res) => {
  try {
    const response = await fetch(
      "https://api.korapay.com/merchant/api/v1/misc/banks?countryCode=NG",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${process.env.KORA_PUBLIC_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const data = await response.json();

    if (!response.ok || !data.status) {
      return res.status(response.status).json({
        error: data.message || "Failed to fetch banks",
      });
    }

    res.json({ banks: data.data });
  } catch (error) {
    console.error("Kora banks error:", error);
    res.status(500).json({
      error: "Failed to fetch banks",
      details: error.message,
    });
  }
});

// Resolve Kora account
app.post("/kora/resolve-account", async (req, res) => {
  try {
    const { account, bank } = req.body;

    if (!account || !bank) {
      return res.status(400).json({
        error: "Account number and bank code are required",
      });
    }

    const response = await fetch(
      "https://api.korapay.com/merchant/api/v1/misc/banks/resolve",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.KORA_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ bank, account }),
      }
    );

    const data = await response.json();

    if (!response.ok || !data.status) {
      return res.status(response.status).json({
        error: data.message || "Failed to resolve account",
      });
    }

    res.json({
      account_name: data.data.account_name,
      account_number: data.data.account_number,
      bank_name: data.data.bank_name,
      bank_code: data.data.bank_code,
    });
  } catch (error) {
    console.error("Kora resolve error:", error);
    res.status(500).json({
      error: "Failed to resolve account",
      details: error.message,
    });
  }
});

// Kora disburse
app.post("/kora/disburse", async (req, res) => {
  try {
    const { reference, amount, currency, destination } = req.body;

    if (!reference || !amount || !currency || !destination) {
      return res.status(400).json({
        error: "Missing required fields",
      });
    }

    console.log("Kora disburse request:", {
      reference,
      amount,
      currency,
      destination: destination.type,
    });

    const payload = {
      reference: reference,
      destination: {
        type: destination.type,
        amount: amount,
        currency: currency,
        narration: destination.narration || "Wallet withdrawal",
        bank_account: {
          bank: destination.bank_account.bank,
          account: destination.bank_account.account,
        },
        customer: {
          name: destination.customer.name,
          email: destination.customer.email,
        },
      },
    };

    console.log("Kora payload:", JSON.stringify(payload, null, 2));

    const response = await fetch(
      "https://api.korapay.com/merchant/api/v1/transactions/disburse",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.KORA_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      }
    );

    const data = await response.json();
    console.log("Kora response:", JSON.stringify(data, null, 2));

    if (!response.ok || !data.status) {
      return res.status(response.status || 500).json({
        success: false,
        error: data.message || "Failed to process payout",
        message: data.message,
      });
    }

    res.json({
      success: true,
      message: data.message,
      data: data.data,
    });
  } catch (error) {
    console.error("Kora disburse error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to process payout",
      details: error.message,
    });
  }
});

// Kora balance check
app.get("/kora/balance", async (req, res) => {
  try {
    const response = await fetch(
      "https://api.korapay.com/merchant/api/v1/balances",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${process.env.KORA_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const data = await response.json();

    if (!response.ok || !data.status) {
      return res.status(response.status).json({
        error: data.message || "Failed to fetch balance",
      });
    }

    res.json(data);
  } catch (error) {
    console.error("Kora balance error:", error);
    res.status(500).json({
      error: "Failed to fetch balance",
      details: error.message,
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Proxy server running on port ${PORT}`);
});
