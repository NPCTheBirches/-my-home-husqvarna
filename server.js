
  import express from "express";
import cors from "cors";
import path from "path";

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

app.get("/", (req, res) => {
  res.sendFile(path.resolve("public/index.html"));
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

async function husqvarna(apiPath, options = {}) {
  const token = await getToken();

  const headers = {
    "Authorization-Provider": "husqvarna",
    "Authorization": `Bearer ${token}`,
    "X-Api-Key": API_KEY,
    ...(options.headers || {})
  };

  const response = await fetch(API_BASE + apiPath, {
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
      "START_MOWING",
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
                ? "Start"
                : req.body.action === "PAUSE"
                ? "Pause"
                : req.body.action === "PARK_UNTIL_NEXT_SCHEDULE"
                ? "ParkUntilNextSchedule"
                : req.body.action === "PARK_UNTIL_FURTHER_NOTICE"
                ? "ParkUntilFurtherNotice"
                : "ResumeSchedule",

            attributes:
              req.body.action === "START_MOWING"
                ? { duration: 60 }
                : undefined
          }
        })
      }
    );

    res.json(result);
  } catch (error) {
    res.status(502).json({
      error: error.message
    });
  }
});


// ---------------- IMOU CAMERA API ----------------

const IMOU_APP_ID = process.env.IMOU_APP_ID;
const IMOU_APP_SECRET = process.env.IMOU_APP_SECRET;

let imouToken = null;
let imouTokenExpiry = 0;
let imouHost = null;

async function getImouToken() {

  if (
    imouToken &&
    Date.now() < imouTokenExpiry - 60000
  ) {
    return imouToken;
  }

  if (!IMOU_APP_ID || !IMOU_APP_SECRET) {
    throw new Error(
      "Imou credentials are not configured."
    );
  }

  const {
    createHash,
    createHmac,
    randomUUID
  } = await import("node:crypto");

  const dataCenters = [
    "sg",
    "fk",
    "or"
  ];

  let lastError = null;

  for (const dataCenter of dataCenters) {

    try {

      const host =
        `https://openapi-${dataCenter}.easy4ip.com`;

      const time =
        Math.floor(Date.now() / 1000);

      const nonce =
        randomUUID();

      const signTemplate =
        `time:${time},nonce:${nonce},appSecret:${IMOU_APP_SECRET}`;

      const password =
        createHash("sha256")
          .update(IMOU_APP_SECRET)
          .digest("hex");

      const sign =
        createHmac(
          "sha256",
          password
        )
          .update(signTemplate)
          .digest("base64");

      const body = {
        system: {
          ver: "1.0",
          appId: IMOU_APP_ID,
          sign,
          time,
          nonce
        },

        id: randomUUID(),

        params: {}
      };

      const response =
        await fetch(
          `${host}/openapi/accessToken`,
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json;charset=UTF-8"
            },

            body:
              JSON.stringify(body)
          }
        );

      const json =
        await response.json();

      const result =
        json?.result;

      if (
        response.ok &&
        result?.code === "0" &&
        result?.data?.accessToken
      ) {

        imouToken =
          result.data.accessToken;

        imouTokenExpiry =
          Date.now() +
          Number(
            result.data.expireTime ||
            259200
          ) * 1000;

        imouHost =
          host;

        return imouToken;
      }

      lastError =
        new Error(
          `Imou ${dataCenter}: ${result?.code || response.status} ${result?.msg || ""}`
        );

    } catch (error) {

      lastError =
        error;

    }
  }

  throw (
    lastError ||
    new Error(
      "Unable to obtain Imou access token."
    )
  );
}


async function imouRequest(
  endpoint,
  params = {}
) {

  const token =
    await getImouToken();

  const {
    createHash,
    createHmac,
    randomUUID
  } = await import("node:crypto");

  const time =
    Math.floor(Date.now() / 1000);

  const nonce =
    randomUUID();

  const signTemplate =
    `time:${time},nonce:${nonce},appSecret:${IMOU_APP_SECRET}`;

  const password =
    createHash("sha256")
      .update(IMOU_APP_SECRET)
      .digest("hex");

  const sign =
    createHmac(
      "sha256",
      password
    )
      .update(signTemplate)
      .digest("base64");

  const body = {

    system: {
      ver: "1.0",
      appId: IMOU_APP_ID,
      sign,
      time,
      nonce
    },

    id:
      randomUUID(),

    params: {
      ...params,
      token
    }
  };

  const response =
    await fetch(
      `${imouHost}${endpoint}`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json;charset=UTF-8"
        },

        body:
          JSON.stringify(body)
      }
    );

  const json =
    await response.json();

  if (!response.ok) {

    throw new Error(
      `Imou API HTTP ${response.status}`
    );

  }

  if (
    json?.result?.code !== "0"
  ) {

    throw new Error(
      `Imou API ${json?.result?.code || "unknown"}: ${json?.result?.msg || "Unknown error"}`
    );

  }

  return json;
}


app.get(
  "/api/imou/devices",
  async (req, res) => {

    try {

      const result =
        await imouRequest(
          "/openapi/deviceBaseList",
          {
            bindId: -1,
            limit: 128,
            type: "bind",
            needApInfo: true
          }
        );

      res.json(result);

    } catch (error) {

      res.status(502).json({
        error: error.message
      });

    }

  }
);


// ---------------- IMOU LIVE STREAMS ----------------

app.get(
  "/api/imou/streams",
  async (req, res) => {

    try {

      const deviceResult =
        await imouRequest(
          "/openapi/deviceBaseList",
          {
            bindId: -1,
            limit: 128,
            type: "bind",
            needApInfo: true
          }
        );

      const devices =
        deviceResult?.result?.data?.deviceList || [];

      const cameras = [];

      for (const device of devices) {

        const deviceId =
          device?.deviceId;

        const channels =
          device?.channels || [];

        if (!deviceId) continue;

        for (const channel of channels) {

          const channelId =
            String(
              channel?.channelId ?? "0"
            );

          let streamInfo = null;

          // First try an existing live address.
          try {

            const existing =
              await imouRequest(
                "/openapi/getLiveStreamInfo",
                {
                  deviceId,
                  channelId
                }
              );

            streamInfo =
              existing?.result?.data || null;

          } catch (_) {

            // No existing live address.
          }


          // If none exists, create one.
          if (
            !streamInfo?.streams?.length
          ) {

            try {

              const created =
                await imouRequest(
                  "/openapi/bindDeviceLive",
                  {
                    deviceId,
                    channelId,
                    streamId: 1,
                    liveMode: "proxy"
                  }
                );

              streamInfo =
                created?.result?.data || null;

            } catch (createError) {

              cameras.push({
                deviceId,
                channelId,

                name:
                  channel?.channelName ||
                  `Camera ${cameras.length + 1}`,

                error:
                  createError.message
              });

              continue;
            }
          }


          const streams =
            streamInfo?.streams || [];


          // Prefer HD HTTPS.
          // Then SD HTTPS.
          // Then any HTTPS stream.
          const httpsStreams =
            streams.filter(
              stream =>
                typeof stream?.hls === "string" &&
                stream.hls.startsWith("https://")
            );


          const selected =
            httpsStreams.find(
              stream =>
                stream.streamId === 0
            ) ||

            httpsStreams.find(
              stream =>
                stream.streamId === 1
            ) ||

            httpsStreams[0] ||

            streams.find(
              stream =>
                typeof stream?.hls === "string"
            );


          cameras.push({

            deviceId,

            channelId,

            name:
              channel?.channelName ||
              `Camera ${cameras.length + 1}`,

            connected:
              true,

            streamId:
              selected?.streamId ?? null,

            hls:
              selected?.hls || null,

            coverUrl:
              selected?.coverUrl || null,

            streams:
              httpsStreams.map(
                stream => ({
                  streamId:
                    stream.streamId,

                  hls:
                    stream.hls,

                  status:
                    stream.status
                })
              )
          });

        }
      }

      res.json({
        cameras
      });

    } catch (error) {

      res.status(502).json({
        error: error.message
      });

    }

  }
);

// ---------------- IMOU STREAM TEST ----------------

app.get(
  "/api/imou/test-stream",
  async (req, res) => {

    try {

      const deviceResult =
        await imouRequest(
          "/openapi/deviceBaseList",
          {
            bindId: -1,
            limit: 128,
            type: "bind",
            needApInfo: true
          }
        );

      const devices =
        deviceResult?.result?.data?.deviceList || [];

      if (!devices.length) {
        throw new Error("No Imou cameras found.");
      }

      const device =
        devices[0];

      const deviceId =
        device.deviceId;

      const channel =
        device.channels?.[0];

      if (!channel) {
        throw new Error("No camera channel found.");
      }

      const channelId =
        String(channel.channelId);

      let streamInfo = null;

      try {

        const existing =
          await imouRequest(
            "/openapi/getLiveStreamInfo",
            {
              deviceId,
              channelId
            }
          );

        streamInfo =
          existing?.result?.data || null;

      } catch (_) {
        // Create the live address below.
      }

      if (!streamInfo?.streams?.length) {

        const created =
          await imouRequest(
            "/openapi/bindDeviceLive",
            {
              deviceId,
              channelId,
              streamId: 1,
              liveMode: "proxy"
            }
          );

        streamInfo =
          created?.result?.data || null;
      }

      const streams =
        streamInfo?.streams || [];

      const httpsStream =
        streams.find(
          stream =>
            typeof stream?.hls === "string" &&
            stream.hls.startsWith("https://")
        );

      if (!httpsStream?.hls) {
        throw new Error(
          "Imou did not return an HTTPS HLS stream."
        );
      }

      res.redirect(
        httpsStream.hls
      );

    } catch (error) {

      res.status(502).send(
        "Stream test failed: " +
        error.message
      );

    }
  }
);

// ---------------- END IMOU STREAM TEST ----------------
// ---------------- END IMOU CAMERA API ----------------


app.listen(
  PORT,
  () => {
    console.log(
      `My Home server running on port ${PORT}`
    );
  }
);
