Module.register("MMM-VolvoConnect", {
  defaults: {
    pollSeconds: 300
  },

  start() {
    this.status = "Loading…";
    this.sendSocketNotification("MYVOLVO_CONFIG", this.config);
  },

  getStyles() {
    return ["MMM-VolvoConnect.css"];
  },

  getDom() {
    const root = document.createElement("div");
    root.className = "volvo-connect";
    root.innerHTML = `<div class="title">MMM-VolvoConnect</div>
                      <div class="status">${this.status}</div>`;
    return root;
  },

  socketNotificationReceived(n, payload) {
    if (n === "MYVOLVO_STATUS") {
      this.status = payload?.message || "";
      this.updateDom(150);
    }
    if (n === "MYVOLVO_DATA") {
      this.status = "Connected";
      this.updateDom(150);
    }
  }
});