/* MMM-VolvoConnect.js
   Stable cluster layout + geofence “Zuhause” + reverse-geocode fallback
*/

Module.register("MMM-VolvoConnect", {
  defaults: {
    pollSeconds: 300,
    carImage: null,
    tankCapacityLiters: 55,
    layout: "cluster",
    homeLocation: null,          // { lat: 52.52, lon: 13.40 }
    homeRadiusMeters: 200
  },

  start() {
    this.status = "Waiting for data…";
    this.packet = null;
    this._lastUpdated = null;
    this._geoCache = {};
    this.sendSocketNotification("MYVOLVO_CONFIG", this.config);
  },

  getScripts() {
    return ["https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"];
  },
  getStyles() {
    return [
      "MMM-VolvoConnect.css",
      "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
    ];
  },

  socketNotificationReceived(notification, payload) {
    if (notification === "MYVOLVO_STATUS") {
      this.status = payload?.message || "";
      this.updateDom(150);
      return;
    }
    if (notification === "MYVOLVO_DATA") {
      this.packet = payload;
      const ts = payload?.meta?.at || Date.now();
      this._lastUpdated = new Date(ts);
      this.updateDom(150);
    }
  },

  /* ----------------- DOM ----------------- */
  getDom() {
    const root = document.createElement("div");
    root.className = "volvo-connect";

    const header = document.createElement("header");
    header.className = "module-header";
    header.textContent = "Volvo Connect – My Volvo V90";
    root.appendChild(header);

    if (!this.packet || !this.packet.data) {
      const hint = document.createElement("div");
      hint.className = "muted";
      hint.textContent = "Waiting for vehicle data…";
      root.appendChild(hint);
      return root;
    }

    const d = this.packet.data;
    const cluster = this._renderClusterLayout(d);
    root.appendChild(cluster);

    const upd = document.createElement("div");
    upd.className = "vc-updated";
    upd.textContent = `Updated: ${this._formatTime(this._lastUpdated)}`;
    root.appendChild(upd);
    return root;
  },

  /* ----------------- CLUSTER ----------------- */
  _renderClusterLayout(d) {
    const cap = Number(this.config.tankCapacityLiters) || 55;
    const fuelLiters = Number(d.fuel?.data?.fuelAmount?.value ?? d.fuel?.fuelAmount?.value ?? NaN);
    const fuelPctVal =
      Number(d.fuel?.data?.fuelLevelPercent ?? d.fuel?.fuelLevelPercent ?? (fuelLiters / cap) * 100);

    const odo = d.odometer?.data?.odometer?.value ?? d.odometer?.odometer?.value;
    const dteKm =
      d.statistics?.data?.distanceToEmptyTank?.value ??
      d.statistics?.distanceToEmptyTank?.value ??
      null;
    const avgCons = d.statistics?.data?.averageFuelConsumption?.value;
    const avgSpd = d.statistics?.data?.averageSpeed?.value;

    const root = document.createElement("div");
    root.className = "main-card vc-cluster";

    const top = document.createElement("div");
    top.className = "vc-toprow";

    const left = document.createElement("div");
    left.className = "vc-leftstack";

    /* ---- fuel bar ---- */
    const fb = document.createElement("div");
    fb.className = "fuelbar slim";
    const fill = document.createElement("div");
    fill.className = "fuelbar-fill";
    if (fuelPctVal) fill.style.width = `${Math.round(fuelPctVal)}%`;
    const flabel = document.createElement("div");
    flabel.className = "fuelbar-label";
    if (fuelLiters)
      flabel.textContent = `${Math.round(fuelPctVal)}% · ${Math.round(fuelLiters)} L`;
    else flabel.textContent = "—";
    fb.append(fill, flabel);
    left.appendChild(fb);

    /* ---- metrics ---- */
    const metrics = document.createElement("div");
    metrics.className = "vc-metrics";
    metrics.append(
      this._mrow("range", dteKm ? `${Math.round(dteKm)} km` : "—"),
      this._mrow("odo", odo ? `${odo.toLocaleString()} km` : "—"),
      this._mrow("consumption", avgCons ? `${avgCons.toFixed(1)} L/100 km` : "—"),
      this._mrow("speed", avgSpd ? `${Math.round(avgSpd)} km/h` : "—")
    );
    left.appendChild(metrics);

    /* ---- car image ---- */
    const right = document.createElement("div");
    right.className = "vc-carbox";
    const img = document.createElement("img");
    img.className = "car-image";
    img.src = this.config.carImage || this.file("car.png");
    right.appendChild(img);

    top.append(left, right);
    root.appendChild(top);

    /* ---- divider ---- */
    const divline = document.createElement("div");
    divline.className = "vc-divider";
    root.appendChild(divline);

    /* ---- last trip ---- */
    const tripKm = d.statistics?.data?.tripMeterAutomatic?.value;
    const last = document.createElement("div");
    last.className = "vc-lasttrip";
    last.append(
      this._ltItem("clock", tripKm ? `${Math.round(tripKm / avgSpd * 60)} min` : "—"),
      this._ltItem("range", tripKm ? `${tripKm.toFixed(1)} km` : "—"),
      this._ltItem("consumption", avgCons ? `${avgCons.toFixed(1)} L/100 km` : "—")
    );

    /* ---- location ---- */
    const locBox = document.createElement("div");
    locBox.className = "vc-location-info vc-lt-item";
    locBox.appendChild(this._icon("location"));
    const locSpan = document.createElement("span");
    locSpan.textContent = this._labelFromPacket(d) || "—";
    locBox.appendChild(locSpan);
    last.appendChild(locBox);
    root.appendChild(last);

    /* reverse-geocode if none */
    if (locSpan.textContent === "—") {
      const L = d.location?.data || d.location;
      const lat =
        Number(L?.geometry?.coordinates?.[1] ??
          L?.position?.latitude ??
          L?.lastKnownPosition?.latitude);
      const lon =
        Number(L?.geometry?.coordinates?.[0] ??
          L?.position?.longitude ??
          L?.lastKnownPosition?.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        this._revGeocode(lat, lon)
          .then((label) => {
            if (locSpan.isConnected) locSpan.textContent = label;
          })
          .catch(() => {
            if (locSpan.isConnected) locSpan.textContent = `${lat.toFixed(4)},${lon.toFixed(4)}`;
          });
      }
    }
    return root;
  },

  _mrow(name, val) {
    const row = document.createElement("div");
    row.className = "vc-mrow";
    row.append(this._icon(name), Object.assign(document.createElement("span"), { textContent: val }));
    return row;
  },
  _ltItem(name, val) {
    const div = document.createElement("div");
    div.className = "vc-lt-item";
    div.append(this._icon(name), Object.assign(document.createElement("span"), { textContent: val }));
    return div;
  },

  /* ----------------- ICONS ----------------- */
  _icon(name) {
    const ns = "http://www.w3.org/2000/svg";
    const s = document.createElementNS(ns, "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.classList.add("vc-icn", `vc-icn-${name}`);
    const p = document.createElementNS(ns, "path");
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", "1.6");
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
    switch (name) {
      case "odo":
        p.setAttribute("d", "M4 19l4 -14 M16 5l4 14 M12 8v-2 M12 13v-2 M12 18v-2");
        break;
      case "range":
        p.setAttribute("d", "M4 12h16 M4 12a8 8 0 1 1 16 0");
        break;
      case "consumption":
        p.setAttribute("d", "M4 14l4-4 4 3 4-6 4 6");
        break;
      case "speed":
        p.setAttribute("d", "M12 6a8 8 0 1 1-6.93 4 M12 12l4-2");
        break;
      case "clock":
        p.setAttribute("d", "M12 6a6 6 0 1 1 0 12 6 6 0 0 1 0-12zm0 3v3l2 2");
        break;
      case "location":
        p.setAttribute(
          "d",
          "M12 21c-2.8-2.1-6-5.5-6-9a6 6 0 1 1 12 0c0 3.5-3.2 6.9-6 9zm0-11.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5"
        );
        break;
    }
    s.appendChild(p);
    return s;
  },

  _formatTime(dt) {
    const d = dt instanceof Date ? dt : new Date(dt);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  },

  /* ----------------- LABEL + GEO ----------------- */
  _labelFromPacket(data) {
    const L = data?.location?.data || data?.location || {};
    const props = L.properties || {};

    try {
      let lat =
        Number(L?.geometry?.coordinates?.[1] ??
          L?.position?.latitude ??
          L?.lastKnownPosition?.latitude);
      let lon =
        Number(L?.geometry?.coordinates?.[0] ??
          L?.position?.longitude ??
          L?.lastKnownPosition?.longitude);
      if (
        this.config?.homeLocation &&
        Number.isFinite(lat) &&
        Number.isFinite(lon)
      ) {
        const R = 6371000;
        const toRad = (x) => (x * Math.PI) / 180;
        const dLat = toRad(lat - this.config.homeLocation.lat);
        const dLon = toRad(lon - this.config.homeLocation.lon);
        const a =
          Math.sin(dLat / 2) ** 2 +
          Math.cos(toRad(this.config.homeLocation.lat)) *
            Math.cos(toRad(lat)) *
            Math.sin(dLon / 2) ** 2;
        const dist = 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        if (dist <= (this.config.homeRadiusMeters || 200)) return "Zuhause";
      }
    } catch (e) {
      console.warn("[VolvoConnect] geofence failed:", e.message);
    }

    const city =
      props.city || props.town || props.village || props.municipality;
    const area =
      props.suburb ||
      props.neighbourhood ||
      props.district ||
      props.quarter ||
      props.hamlet;
    const road = props.road || props.street || props.name;
    const house = props.house_number || props.housenumber;

    if (area && road && house) return `${area} — ${road} ${house}`;
    if (area && road) return `${area} — ${road}`;
    if (city && road) return `${city} — ${road}`;
    if (road) return road;
    if (area) return area;
    if (city) return city;
    return null;
  },

  _revGeocode(lat, lon) {
    const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    if (this._geoCache[key]) return Promise.resolve(this._geoCache[key]);
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=17`;
    return fetch(url, { headers: { "User-Agent": "MMM-VolvoConnect/1.0" } })
      .then((r) => r.json())
      .then((j) => {
        const a = j.address || {};
        const lbl =
          a.suburb || a.neighbourhood || a.city || j.name || j.display_name;
        this._geoCache[key] = lbl;
        return lbl;
      })
      .catch(() => `${lat.toFixed(4)},${lon.toFixed(4)}`);
  }
});
