/* MMM-VolvoConnect.js — minimal UI + map */
Module.register("MMM-VolvoConnect", {
  defaults: {
    pollSeconds: 300
  },

  start() {
    this.status = "Waiting for data…";
    this.packet = null;
    this.sendSocketNotification("MYVOLVO_CONFIG", this.config);
  },

  getScripts() {
    return [
      "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
    ];
  },

  getStyles() {
    return [
      "MMM-VolvoConnect.css",
      "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
    ];
  },

  socketNotificationReceived(n, payload) {
    if (n === "MYVOLVO_STATUS") {
      this.status = payload?.message || "";
      this.updateDom(150);
    }
    if (n === "MYVOLVO_DATA") {
      this.packet = payload;
      this.status = `Updated ${new Date(payload.meta.at).toLocaleTimeString()}`;
      this.updateDom(150);
    }
  },

  getDom() {
    const root = document.createElement("div");
    root.className = "volvo-connect";

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = "Volvo Connect";
    root.appendChild(title);

    const status = document.createElement("div");
    status.className = "status";
    status.textContent = this.status || "";
    root.appendChild(status);

    // No data yet
    if (!this.packet || !this.packet.data) {
      const hint = document.createElement("div");
      hint.className = "muted";
      hint.textContent = "Waiting for vehicle data…";
      root.appendChild(hint);
      return root;
    }

    const d = this.packet.data;

    // helpers
    const pick = (...vals) => { for (const v of vals) if (v !== undefined && v !== null) return v; return null; };
    const num  = (n, d=0) => { const x = Number(n); return isNaN(x) ? "—" : x.toLocaleString(undefined, { maximumFractionDigits: d }); };
    const pct  = (n) => (n == null ? "—" : `${Math.round(Number(n))}%`);
    const km   = (n, d=0) => (n == null ? "—" : `${num(n, d)} km`);

    // extract fields
    const odoKm = pick(d.odometer?.data?.odometer?.value, d.odometer?.odometer?.value);
    const fuelPct = pick(d.fuel?.data?.fuelAmount?.value, d.fuel?.fuelAmount?.value, d.fuel?.fuelLevelPercent);
    const dteKm = pick(
      d.statistics?.data?.distanceToEmptyTank?.value,
      d.statistics?.distanceToEmptyTank?.value,
      d.statistics?.data?.distanceToEmpty?.value,
      d.statistics?.distanceToEmpty?.value
    );
    const engine = pick(d.engineStatus?.data?.engine?.value, d.engineStatus?.engine?.value);
    const locked = pick(
      d.doors?.data?.centralLock?.value,
      d.doors?.centralLock?.value,
      d.doors?.data?.lockState?.value
    );

    const loc = (() => {
      const L = d.location?.data || d.location;
      if (L?.geometry?.coordinates?.length >= 2) {
        const [lon, lat] = L.geometry.coordinates;
        return { lat, lon };
      }
      const c = [
        { lat: L?.position?.latitude, lon: L?.position?.longitude },
        { lat: L?.lastKnownPosition?.latitude, lon: L?.lastKnownPosition?.longitude }
      ].find(x => x?.lat != null && x?.lon != null);
      return c || null;
    })();

    // tiles
    const tiles = document.createElement("div");
    tiles.className = "tiles";
    tiles.appendChild(this._tile("Odometer", km(odoKm)));
    tiles.appendChild(this._tile("Fuel", pct(fuelPct)));
    tiles.appendChild(this._tile("Distance to empty", km(dteKm)));
    tiles.appendChild(this._tile("Engine", engine ?? "—"));
    tiles.appendChild(this._tile("Lock", 
      (locked===true||locked==="LOCKED") ? "Locked" :
      (locked===false||locked==="UNLOCKED") ? "Unlocked" : "—"
    ));
    if (loc) tiles.appendChild(this._tile("Location", `${num(loc.lat,4)}, ${num(loc.lon,4)}`));
    root.appendChild(tiles);

    // map
   // map (only if we have coordinates)
if (loc) {
  const mapWrap = document.createElement("div");
  mapWrap.className = "mapcard";

  const mapEl = document.createElement("div");
  const mapId = `${this.identifier}_map_${Date.now()}`; // unique per render
  mapEl.id = mapId;
  mapEl.className = "leaflet-holder";
  mapWrap.appendChild(mapEl);
  root.appendChild(mapWrap);

  // Initialize only when the element is confirmed in the DOM
  const tryInit = (tries = 0) => {
    const el = document.getElementById(mapId);
    if (el) {
      this._initOrQueueMap(mapId, loc);
    } else if (tries < 10) {
      setTimeout(() => tryInit(tries + 1), 100);
    }
  };
  requestAnimationFrame(() => tryInit());
}

    return root;
  },

  _tile(label, value) {
    const t = document.createElement("div");
    t.className = "tile";
    t.innerHTML = `<div class="label">${label}</div><div class="value">${value}</div>`;
    return t;
  },

  _initOrQueueMap(domId, pos) {
  // Leaflet not loaded yet → retry soon
  if (typeof L === "undefined") {
    setTimeout(() => this._initOrQueueMap(domId, pos), 400);
    return;
  }

  // Container must exist
  const container = document.getElementById(domId);
  if (!container) {
    // DOM not ready; a later retry from getDom() will handle it
    return;
  }

  // If we already had a map but the container changed (new render),
  // tear it down and rebuild on the new element.
  if (this._map) {
    const currentId = this._map.getContainer()?.id;
    if (currentId !== domId) {
      try { this._map.remove(); } catch {}
      this._map = null;
      this._marker = null;
      this._halo = null;
    }
  }

  // Create the map if needed
  if (!this._map) {
    this._map = L.map(domId, {
      zoomControl: false,
      attributionControl: false,
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false
    }).setView([pos.lat, pos.lon], 15);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19
    }).addTo(this._map);

    this._halo = L.circle([pos.lat, pos.lon], {
      radius: 55,
      color: "#f2a100",
      fillColor: "#f2a100",
      fillOpacity: 0.18,
      weight: 0
    }).addTo(this._map);

    this._marker = L.circleMarker([pos.lat, pos.lon], {
      radius: 5,
      color: "#f2a100",
      fillColor: "#f2a100",
      opacity: 1,
      weight: 2,
      fillOpacity: 1
    }).addTo(this._map);

    requestAnimationFrame(() => this._map && this._map.invalidateSize());
    setTimeout(() => this._map && this._map.invalidateSize(), 200);
  } else {
    // Map exists on the right element: just update
    this._map.setView([pos.lat, pos.lon]);
    if (this._marker) this._marker.setLatLng([pos.lat, pos.lon]);
    if (this._halo) this._halo.setLatLng([pos.lat, pos.lon]);
    requestAnimationFrame(() => this._map && this._map.invalidateSize());
  }
}
});