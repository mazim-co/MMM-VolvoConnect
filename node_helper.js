
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
  try {
    const api = this._api("https://api.volvocars.com/connected-vehicle/v2");
    const r = await api.get("/vehicles");
    const list = Array.isArray(r.data?.data) ? r.data.data : [];
    if (!list.length) throw new Error("No vehicles found for this account.");

    const vin = list[0].vin;
    const model = list[0]?.vehicleModel || list[0]?.description || "Unknown";

    this.vin = vin;
    console.log(`[VolvoConnect] VIN detected: ${vin} (${model})`);
    return { vin, model };
  } catch (e) {
    console.error("[VolvoConnect] VIN fetch failed:", e.message);
    throw e;
  }
}
});