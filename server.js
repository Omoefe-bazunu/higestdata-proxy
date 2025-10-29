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
app.get("/verify-customer", async (req, res) => {
  try {
    if (!token) await getAccessToken();

    const { service_id, customer_id, variation_id } = req.query;
    let url = `${EBILLS_API_URL}verify-customer?service_id=${service_id}&customer_id=${customer_id}`;
    if (variation_id) url += `&variation_id=${variation_id}`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Proxy server running on port ${PORT}`);
});
