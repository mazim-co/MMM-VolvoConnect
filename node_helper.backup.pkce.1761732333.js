/* node_helper.js — backend for MMM-VolvoConnect */

const NodeHelper = require("node_helper");
const axios = require("axios");
const express = require("express");
const fs = require("fs");
const path = require("path");

module.exports = NodeHelper.create({
  start() {
    console.log("[VolvoConnect] helper started; route: /MMM-VolvoConnect/ping");
    this.tokens = null;
    this.vin = null;
    this.config = null;
    this.pollTimer = null;

    this.expressApp.get("/MMM-VolvoConnect/ping", (req, res) => res.send("pong"));
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "MYVOLVO_CONFIG") {
      this.config = payload;
      this._setupAuthRoutes();
      this._initVolvo();
    }
  },

  /* ---------------------- AUTH HANDLING ---------------------- */
  _setupAuthRoutes() {
    const base = "/MMM-VolvoConnect";
    const app = this.expressApp;

    app.get(`${base}/login`, (req, res) => {
      const authUrl = `https://volvoid.eu.volvocars.com/as/authorization.oauth2?response_type=code&client_id=${this.config.clientId}&redirect_uri=${encodeURIComponent(
        this.config.redirectUri
      )}&scope=${encodeURIComponent(this.config.scopes)}&state=12345`;
      res.redirect(authUrl);
    });

    app.get(`${base}/callback`, async (req, res) => {
      const code = req.query.code;
      try {
        const tokenResp = await axios.post(
          "https://volvoid.eu.volvocars.com/as/token.oauth2",
          new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: this.config.redirectUri,
            client_id: this.config.clientId,
            client_secret: this.config.clientSecret
          }),
          { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
        );
        this.tokens = tokenResp.data;
        fs.writeFileSync(path.join(__dirname, "tokens.json"), JSON.stringify(this.tokens, null, 2));
        res.send("<h2>VolvoConnect authorized. You can close this tab.</h2>");
        console.log("[VolvoConnect] tokens stored and ready");
      } catch (e) {
        console.error("[VolvoConnect] callback error:", e.response?.status, e.message);
        res.status(500).send("Auth failed");
      }
    });

    console.log("[VolvoConnect] auth endpoints mounted:");
    console.log(`  GET ${base}/login`);
    console.log(`  GET ${base}/callback`);
  },

  async _initVolvo() {
    // Load tokens if stored
    const tfile = path.join(__dirname, "tokens.json");
    if (fs.existsSync(tfile)) {
      this.tokens = JSON.parse(fs.readFileSync(tfile, "utf8"));
    }

    if (!this.tokens) {
      console.warn("[VolvoConnect] no tokens found — please visit /MMM-VolvoConnect/login");
      return;
    }

    console.log(`[VolvoConnect] pre-fetch token → iss=${this.tokens.iss || "?"} exp=${this.tokens.exp}`);

    try {
      await this._fetchVIN();
      console.log("[VolvoConnect] VIN detected:", this.vin);
    } catch (e) {
      console.error("[VolvoConnect] VIN fetch failed:", e.message);
    }

    const interval = (this.config.pollSeconds || 300) * 1000;
    console.log(`[VolvoConnect] polling every ${this.config.pollSeconds}s`);
    this._pollOnce();
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this._pollOnce(), interval);
  },

  /* ---------------------- TOKEN REFRESH ---------------------- */
  async _refreshTokens() {
    if (!this.tokens?.refresh_token) {
      console.error("[VolvoConnect] no refresh_token available!");
      return;
    }
    try {
      const resp = await axios.post(
        "https://volvoid.eu.volvocars.com/as/token.oauth2",
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: this.tokens.refresh_token,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret
        }),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
      );
      this.tokens = resp.data;
      fs.writeFileSync(path.join(__dirname, "tokens.json"), JSON.stringify(this.tokens, null, 2));
      console.log("[VolvoConnect] tokens refreshed");
    } catch (e) {
      console.error("[VolvoConnect] token refresh failed:", e.response?.status, e.message);
    }
  },

  /* ---------------------- API HELPERS ---------------------- */
  _api(base) {
    const client = axios.create({
      baseURL: base,
      headers: { Authorization: `Bearer ${this.tokens?.access_token}` }
    });
    return client;
  },

  async _fetchVIN() {
    const api = this._api("https://api.volvocars.com/connected-vehicle/v2");
    const res = await api.get("/vehicles");
    if (!res.data?.data?.length) throw new Error("No vehicles linked");
    this.vin = res.data.data[0].vin;
  },

  /* ---------------------- POLLING ---------------------- */
  async _pollOnce() {
    if (!this.vin) await this._fetchVIN();

    // Pre-expiry token check
    try {
      const raw = this.tokens?.access_token || "";
      const parts = raw.split(".");
      if (parts.length === 3) {
        const payload = JSON.parse(
          Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
        );
        const now = Math.floor(Date.now() / 1000);
        const exp = Number(payload?.exp || 0);
        if (exp && now >= exp - 60) {
          console.log("[VolvoConnect] Access token nearly expired — refreshing...");
          await this._refreshTokens();
        }
      }
    } catch (e) {
      console.warn("[VolvoConnect] token precheck skipped:", e.message);
    }

    const apiCV = this._api("https://api.volvocars.com/connected-vehicle/v2");
    const apiLOC = this._api("https://api.volvocars.com/location/v1");

    const safe = async (label, fn) => {
      try {
        return await fn();
      } catch (e) {
        const st = e?.response?.status;
        const body = e?.response?.data;
        console.error(`[VolvoConnect] ${label} failed: ${st} → ${JSON.stringify(body || {})}`);
        return { __error: { status: st, data: body } };
      }
    };

    const fetchAll = async () => {
      const [details, odometer, statistics, doors, fuel, engineStatus, windows, tyres, warnings, location, diagnostics] =
        await Promise.all([
          safe("details", () => apiCV.get(`/vehicles/${this.vin}`).then(r => r.data)),
          safe("odometer", () => apiCV.get(`/vehicles/${this.vin}/odometer`).then(r => r.data)),
          safe("statistics", () => apiCV.get(`/vehicles/${this.vin}/statistics`).then(r => r.data)),
          safe("doors", () => apiCV.get(`/vehicles/${this.vin}/doors`).then(r => r.data)),
          safe("fuel", () => apiCV.get(`/vehicles/${this.vin}/fuel`).then(r => r.data)),
          safe("engine-status", () => apiCV.get(`/vehicles/${this.vin}/engine-status`).then(r => r.data)),
          safe("windows", () => apiCV.get(`/vehicles/${this.vin}/windows`).then(r => r.data)),
          safe("tyres", () => apiCV.get(`/vehicles/${this.vin}/tyres`).then(r => r.data)),
          safe("warnings", () => apiCV.get(`/vehicles/${this.vin}/warnings`).then(r => r.data)),
          safe("location", () => apiLOC.get(`/vehicles/${this.vin}/location`).then(r => r.data)),
          safe("diagnostics", () => apiCV.get(`/vehicles/${this.vin}/diagnostics`).then(r => r.data))
        ]);
      return { details, odometer, statistics, doors, fuel, engineStatus, windows, tyres, warnings, location, diagnostics };
    };

    let pack = await fetchAll();

    // Retry once if any 401
    const any401 = Object.values(pack).some(v => v && v.__error && v.__error.status === 401);
    if (any401) {
      console.warn("[VolvoConnect] One or more endpoints returned 401 — refreshing token and retrying once…");
      await this._refreshTokens();
      pack = await fetchAll();
    }

    console.log("[VolvoConnect] emitting MYVOLVO_DATA");
    this.sendSocketNotification("MYVOLVO_DATA", {
      meta: { at: new Date().toISOString(), vin: this.vin },
      data: pack
    });
  }
});
