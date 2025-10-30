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

// PAYSTACK FUNDING & WITHDRAWAL

// PAYSTACK PROXY ROUTES

// Initialize payment
app.post("/paystack/initialize", async (req, res) => {
  try {
    const { email, amount, userId } = req.body;

    if (!email || !amount || !userId) {
      return res.status(400).json({
        error: "Email, amount, and userId are required",
      });
    }

    const amountInKobo = Math.round(parseFloat(amount) * 100);

    const response = await fetch(
      "https://api.paystack.co/transaction/initialize",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          amount: amountInKobo,
          currency: "NGN",
          callback_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?payment=success`,
          metadata: {
            userId,
            custom_fields: [
              {
                display_name: "User ID",
                variable_name: "user_id",
                value: userId,
              },
            ],
          },
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data.message || "Failed to initialize transaction",
      });
    }

    res.json({
      authorization_url: data.data.authorization_url,
      access_code: data.data.access_code,
      reference: data.data.reference,
    });
  } catch (error) {
    console.error("Paystack initialization error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Verify payment
app.get("/paystack/verify", async (req, res) => {
  try {
    const { reference } = req.query;

    if (!reference) {
      return res.status(400).json({
        error: "Transaction reference is required",
      });
    }

    const response = await fetch(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        },
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data.message || "Failed to verify transaction",
      });
    }

    const transactionData = data.data;

    if (transactionData.status !== "success") {
      return res.json({
        success: false,
        message: "Transaction was not successful",
        status: transactionData.status,
      });
    }

    res.json({
      success: true,
      message: "Transaction verified successfully",
      userId: transactionData.metadata.userId,
      amount: transactionData.amount / 100,
      reference,
      email: transactionData.customer.email,
      channel: transactionData.channel,
      currency: transactionData.currency,
    });
  } catch (error) {
    console.error("Paystack verification error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get banks
app.get("/withdrawal/banks", async (req, res) => {
  try {
    const response = await fetch("https://api.paystack.co/bank?currency=NGN", {
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      },
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || "Failed to fetch banks");
    }

    const uniqueBanks = [
      ...new Map(data.data.map((bank) => [bank.code, bank])).values(),
    ];

    res.json({ banks: uniqueBanks });
  } catch (error) {
    console.error("Fetch banks error:", error);
    res.status(500).json({
      error: "Failed to fetch banks",
      details: error.message,
    });
  }
});

// Resolve account
app.post("/withdrawal/resolve-account", async (req, res) => {
  try {
    const { accountNumber, bankCode } = req.body;

    if (!accountNumber || !bankCode) {
      return res.status(400).json({
        error: "Account number and bank code are required",
      });
    }

    if (!/^\d{10}$/.test(accountNumber)) {
      return res.status(400).json({
        error: "Account number must be 10 digits",
      });
    }

    const response = await fetch(
      `https://api.paystack.co/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data.message || "Failed to resolve account",
      });
    }

    res.json({
      success: true,
      accountName: data.data.account_name,
      accountNumber: data.data.account_number,
    });
  } catch (error) {
    console.error("Resolve account error:", error);
    res.status(500).json({
      error: "Failed to resolve account",
      details: error.message,
    });
  }
});

// Create recipient
app.post("/withdrawal/create-recipient", async (req, res) => {
  try {
    const { accountName, accountNumber, bankCode } = req.body;

    if (!accountName || !accountNumber || !bankCode) {
      return res.status(400).json({ error: "All fields are required" });
    }

    const response = await fetch("https://api.paystack.co/transferrecipient", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "nuban",
        name: accountName,
        account_number: accountNumber,
        bank_code: bankCode,
        currency: "NGN",
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data.message || "Failed to create recipient",
      });
    }

    res.json({
      success: true,
      recipientCode: data.data.recipient_code,
    });
  } catch (error) {
    console.error("Create recipient error:", error);
    res.status(500).json({ error: "Failed to create recipient" });
  }
});

// Initiate transfer
app.post("/withdrawal/initiate-transfer", async (req, res) => {
  try {
    const { amount, recipientCode, reference } = req.body;

    if (!amount || !recipientCode || !reference) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const response = await fetch("https://api.paystack.co/transfer", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source: "balance",
        amount: amount * 100,
        recipient: recipientCode,
        reason: "Wallet Withdrawal",
        reference,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data.message || "Failed to initiate transfer",
      });
    }

    res.json({
      success: true,
      message: "Withdrawal initiated successfully",
      reference,
      transferCode: data.data.transfer_code,
    });
  } catch (error) {
    console.error("Initiate transfer error:", error);
    res.status(500).json({ error: "Failed to initiate withdrawal" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Proxy server running on port ${PORT}`);
});
