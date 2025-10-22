
const NodeHelper = require("node_helper");
const express = require("express");
const axios = require("axios");
// ESM-only 'open' helper for CommonJS environment
const openBrowser = async (url) => {
  try {
    const { default: open } = await import("open");
    await open(url);
  } catch (e) {
    console.log("[VolvoConnect] Please open this URL manually:", url);
  }
};

const { newPkce, readTokens, writeTokens, cryptoHex } = require("./lib/utils");

// Volvo OAuth endpoints
const VOLVO_AUTH = {
  authorize: "https://volvoid.eu.volvocars.com/as/authorization.oauth2",
  token:     "https://volvoid.eu.volvocars.com/as/token.oauth2"
};

// API bases (used later in Step 9+)
const CV_BASE  = "https://api.volvocars.com/connected-vehicle/v2";
const LOC_BASE = "https://api.volvocars.com/location/v1";

module.exports = NodeHelper.create({
  /* -------------------------------------------------------
   * Lifecycle
   * ----------------------------------------------------- */
  start() {
    this.cfg = null;
    this.tokens = readTokens(); // { access_token, refresh_token, ... } or null
    this.state = null;          // OAuth state
    this.pkce  = null;          // { verifier, challenge }
    this.timer = null;

    // Prove helper is alive
    this.expressApp.get("/MMM-VolvoConnect/ping", (req, res) => res.send("pong"));
    console.log("[VolvoConnect] helper started; route: /MMM-VolvoConnect/ping");
  },

  /* -------------------------------------------------------
   * Socket from front-end
   * ----------------------------------------------------- */
  socketNotificationReceived(n, payload) {
    if (n === "MYVOLVO_CONFIG") {
      this.cfg = payload || {};
      this._ensureAuthServer();

      if (this.tokens?.access_token) {
  this.sendSocketNotification("MYVOLVO_STATUS", { message: "Authenticated" });
  this._fetchVIN()
    .then(() => this._schedulePoll(true))
    .catch(() => this.sendSocketNotification("MYVOLVO_STATUS", { message: "VIN fetch failed" }));
} else {
  this._beginLogin();
}
    }
  },

  /* -------------------------------------------------------
   * Auth server (mounted on MagicMirror's Express)
   * ----------------------------------------------------- */
  _ensureAuthServer() {
  if (this._authServerReady) return;

  // /login → redirect user to Volvo OAuth
  this.expressApp.get("/MMM-VolvoConnect/login", (req, res) => {
    if (!this.cfg?.clientId || !this.cfg?.redirectUri || !this.cfg?.scopes) {
      return res.status(500).send("Config missing: clientId / redirectUri / scopes.");
    }
    this.state = cryptoHex(16);
    this.pkce  = newPkce();

    const url = new URL(VOLVO_AUTH.authorize);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.cfg.clientId);
    url.searchParams.set("redirect_uri", this.cfg.redirectUri);
    url.searchParams.set("scope", this.cfg.scopes);
    url.searchParams.set("state", this.state);
    url.searchParams.set("code_challenge", this.pkce.challenge);
    url.searchParams.set("code_challenge_method", "S256");

    res.redirect(url.toString());
  });

  // /callback → exchange code for tokens, save tokens.json
  this.expressApp.get("/MMM-VolvoConnect/callback", async (req, res) => {
    try {
      const { code, state, error, error_description } = req.query;
      if (error) throw new Error(`${error}: ${error_description || ""}`);
      if (!code || state !== this.state) throw new Error("Invalid OAuth response/state.");

      await this._exchangeCodeForTokens(code);
      res.send("VolvoConnect: Login successful. You can close this tab.");
      this.sendSocketNotification("MYVOLVO_STATUS", { message: "Authenticated" });
    } catch (e) {
      console.error("[VolvoConnect] OAuth callback error:", e.message);
      res.status(500).send("Auth failed. Check MagicMirror logs.");
      this.sendSocketNotification("MYVOLVO_STATUS", { message: "Auth failed" });
    }
  });

  this._authServerReady = true;
  console.log("[VolvoConnect] auth endpoints mounted:");
  console.log("  GET /MMM-VolvoConnect/login");
  console.log("  GET /MMM-VolvoConnect/callback");
},

  /* -------------------------------------------------------
   * Auth helpers
   * ----------------------------------------------------- */
  _beginLogin() {
  const loginUrl = `http://localhost:${this._portFromRedirect(this.cfg.redirectUri)}/MMM-VolvoConnect/login`;
  openBrowser(loginUrl);  // <-- use helper
  this.sendSocketNotification("MYVOLVO_STATUS", { message: "Open browser to login…" });
},

  _portFromRedirect(uri) {
    try {
      const p = Number(new URL(uri).port);
      return p || 80;
    } catch {
      return 8765;
    }
  },

  async _exchangeCodeForTokens(code) {
    if (!this.cfg?.clientId || !this.cfg?.clientSecret || !this.cfg?.redirectUri) {
      throw new Error("Missing config: clientId/clientSecret/redirectUri");
    }
    if (!this.pkce?.verifier) {
      throw new Error("Missing PKCE verifier (start auth again).");
    }
    
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64");
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      redirect_uri: this.cfg.redirectUri,
      code_verifier: this.pkce.verifier,
      code
    });

    const r = await axios.post(VOLVO_AUTH.token, body, {
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "authorization": `Basic ${basic}`
      },
      timeout: 20000
    });

    this.tokens = r.data; // { access_token, refresh_token, expires_in, token_type, ... }
    writeTokens(this.tokens);
    console.log("[VolvoConnect] tokens saved to tokens.json");
  },
 async _refreshTokens() {
    if (!this.tokens?.refresh_token) throw new Error("No refresh_token available");
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64");
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.tokens.refresh_token
    });
    const r = await axios.post(VOLVO_AUTH.token, body, {
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "authorization": `Basic ${basic}`
      },
      timeout: 20000
    });
    this.tokens = r.data;      // may rotate refresh_token
    writeTokens(this.tokens);
    console.log("[VolvoConnect] tokens refreshed");
  },
  _debugToken(prefix = "access") {
  try {
    const raw = this.tokens?.access_token || "";
    const [, payloadB64] = raw.split(".");
    const json = JSON.parse(Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    const scope = json.scope || json.scp || "(no scope)";
    const aud   = json.aud;
    const iss   = json.iss;
    const exp   = json.exp ? new Date(json.exp * 1000).toISOString() : "(no exp)";
    console.log(`[VolvoConnect] ${prefix} token → iss=${iss} aud=${aud} exp=${exp} scope=${scope}`);
  } catch (e) {
    console.log("[VolvoConnect] _debugToken failed to decode JWT payload");
  }
},
  

  _api(baseURL) {
    if (!this.tokens?.access_token) throw new Error("Not authenticated");
    return axios.create({
      baseURL,
      timeout: 20000,
      headers: {
        "accept": "application/json",
        "authorization": `Bearer ${this.tokens.access_token}`,
        "vcc-api-key": this.cfg.vccApiKey
      }
    });
  },

    async _fetchVIN() {
  const doFetch = async () => {
    const api = this._api("https://api.volvocars.com/connected-vehicle/v2");
    const r = await api.get("/vehicles");
    const list = Array.isArray(r.data?.data) ? r.data.data : [];
    if (!list.length) throw new Error("No vehicles found for this account.");
    const vin = list[0].vin;
    const model = list[0]?.vehicleModel || list[0]?.description || "Unknown";
    this.vin = vin;
    console.log(`[VolvoConnect] VIN detected: ${vin} (${model})`);
    return { vin, model };
  };

  // quick config sanity
  if (!this.cfg?.vccApiKey) {
    console.error("[VolvoConnect] Missing vccApiKey in config.js");
  }
  if (!String(this.cfg?.scopes || "").includes("conve:vehicle_relation")) {
    console.error("[VolvoConnect] scopes should include conve:vehicle_relation");
  }

  // print token claims once before call
  this._debugToken("pre-fetch");

  try {
    return await doFetch();
  } catch (e) {
    const status = e?.response?.status;
    const body   = e?.response?.data;
    if (status === 401) {
      console.warn("[VolvoConnect] 401 from /vehicles — refreshing token and retrying once…");
      await this._refreshTokens();
      this._debugToken("post-refresh");
      try {
        return await doFetch();
      } catch (e2) {
        const s2 = e2?.response?.status;
        console.error("[VolvoConnect] /vehicles still failing after refresh:", s2, JSON.stringify(e2?.response?.data||{}, null, 2));
        throw e2;
      }
    }
    console.error("[VolvoConnect] /vehicles failed:", status, JSON.stringify(body||{}, null, 2));
    throw e;
  }
},
async _pollOnce() {
  if (!this.vin) await this._fetchVIN();

  const apiCV  = this._api("https://api.volvocars.com/connected-vehicle/v2");
  const apiLOC = this._api("https://api.volvocars.com/location/v1");

  const safe = async (fn) => {
    try { return await fn(); }
    catch (e) { return { __error: { status: e?.response?.status, data: e?.response?.data } }; }
  };

  const [details, odometer, statistics, doors, fuel, engineStatus, windows, tyres, warnings, location] =
    await Promise.all([
      safe(() => apiCV.get(`/vehicles/${this.vin}`).then(r=>r.data)),
      safe(() => apiCV.get(`/vehicles/${this.vin}/odometer`).then(r=>r.data)),
      safe(() => apiCV.get(`/vehicles/${this.vin}/statistics`).then(r=>r.data)),
      safe(() => apiCV.get(`/vehicles/${this.vin}/doors`).then(r=>r.data)),
      safe(() => apiCV.get(`/vehicles/${this.vin}/fuel`).then(r=>r.data)),
      safe(() => apiCV.get(`/vehicles/${this.vin}/engine-status`).then(r=>r.data)),
      safe(() => apiCV.get(`/vehicles/${this.vin}/windows`).then(r=>r.data)),
      safe(() => apiCV.get(`/vehicles/${this.vin}/tyres`).then(r=>r.data)),
      safe(() => apiCV.get(`/vehicles/${this.vin}/warnings`).then(r=>r.data)),
      safe(() => apiLOC.get(`/vehicles/${this.vin}/location`).then(r=>r.data))
    ]);

  this.sendSocketNotification("MYVOLVO_DATA", {
    meta: { at: new Date().toISOString(), vin: this.vin },
    data: { details, odometer, statistics, doors, fuel, engineStatus, windows, tyres, warnings, location }
  });
},
_schedulePoll(immediate = false) {
  if (this.timer) clearInterval(this.timer);

  const run = async () => {
    try {
      await this._pollOnce();
    } catch (e) {
      const status = e?.response?.status;
      console.warn("[VolvoConnect] poll error:", status || e.message);
      if (status === 401) {
        try {
          await this._refreshTokens();
          await this._pollOnce();
        } catch (e2) {
          console.error("[VolvoConnect] refresh+retry failed:", e2?.response?.status || e2.message);
        }
      }
    }
  };

  if (immediate) run();
  const seconds = Number(this.cfg?.pollSeconds || 300);
  this.timer = setInterval(run, seconds * 1000);
  console.log(`[VolvoConnect] polling every ${seconds}s`);
},
});