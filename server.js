import express from "express";
import cors from "cors";
import path from "path";
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public"));
app.get("/", (req, res) => {
  res.sendFile(path.resolve("index.html"));
});
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.HUSQVARNA_APPLICATION_KEY;
const API_SECRET = process.env.HUSQVARNA_APPLICATION_SECRET;

const AUTH_URL =
  "https://api.authentication.husqvarnagroup.dev/v1/oauth2/token";

const API_BASE =
  "https://api.amc.husqvarna.dev/v1";

let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60000) {
    return cachedToken;
  }

  if (!API_KEY || !API_SECRET) {
    throw new Error("Husqvarna credentials are not configured.");
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: API_KEY,
    client_secret: API_SECRET
  });

  const response = await fetch(AUTH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!response.ok) {
    throw new Error(
      `Husqvarna authentication failed: ${response.status}`
    );
  }

  const data = await response.json();

  cachedToken = data.access_token;
  tokenExpiry =
    Date.now() + Number(data.expires_in || 3600) * 1000;

  return cachedToken;
}

async function husqvarna(path, options = {}) {
  const token = await getToken();

  const headers = {
    "Authorization-Provider": "husqvarna",
    "Authorization": `Bearer ${token}`,
    "X-Api-Key": API_KEY,
    ...(options.headers || {})
  };

  const response = await fetch(API_BASE + path, {
    ...options,
    headers
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Husqvarna API ${response.status}: ${text}`
    );
  }

  return text ? JSON.parse(text) : {};
}

app.get("/api/mowers", async (req, res) => {
  try {
    res.json(await husqvarna("/mowers"));
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.get("/api/mowers/:id", async (req, res) => {
  try {
    res.json(
      await husqvarna(
        `/mowers/${encodeURIComponent(req.params.id)}`
      )
    );
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.post("/api/mowers/:id/actions", async (req, res) => {
  try {
    const allowedActions = [
  "START",
  "PAUSE",
  "PARK_UNTIL_NEXT_SCHEDULE",
  "PARK_UNTIL_FURTHER_NOTICE",
  "RESUME_SCHEDULE"
];
    

    if (!allowedActions.includes(req.body.action)) {
      return res.status(400).json({
        error: "Unsupported mower action"
      });
    }

    const result = await husqvarna(
  `/mowers/${encodeURIComponent(req.params.id)}/actions`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/vnd.api+json"
    },
    body: JSON.stringify({
      data: {
        type:
          req.body.action === "START_MOWING"
            ? "StartMowing"
            : req.body.action === "PAUSE"
            ? "Pause"
            : req.body.action === "PARK_UNTIL_NEXT_SCHEDULE"
            ? "ParkUntilNextSchedule"
            : req.body.action === "PARK_UNTIL_FURTHER_NOTICE"
            ? "ParkUntilFurtherNotice"
            : "ResumeSchedule"
      }
    })
  }
);
  

    res.json(result);
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`My Home server running on port ${PORT}`);
});
