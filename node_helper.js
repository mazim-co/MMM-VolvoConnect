const NodeHelper = require("node_helper");
const express = require("express");

module.exports = NodeHelper.create({
  start() {
    this.cfg = null;
    this.app.get("/MMM-VolvoConnect/ping", (req, res) => res.send("pong"));
    console.log("[VolvoConnect] helper started; route /MMM-VolvoConnect/ping");
  },

  socketNotificationReceived(n, payload) {
    if (n === "MYVOLVO_CONFIG") {
      this.cfg = payload || {};
      this.sendSocketNotification("MYVOLVO_STATUS", { message: "Skeleton running" });
    }
  }
});