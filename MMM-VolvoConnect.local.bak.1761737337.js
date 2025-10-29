/* MMM-VolvoConnect.js — unified dark layout: single main card (car + data + fuel bar + embedded map) */

Module.register("MMM-VolvoConnect", {
  defaults: {
    pollSeconds: 300,
    carImage: null,              // e.g. "modules/MMM-VolvoConnect/images/v90_frontview.avif"
    tankCapacityLiters: 55,      // known capacity for your V90 (L)
    layout: "cluster"
  },

  start() {
    this.status = "Waiting for data…";
    this.packet = null;
    this._lastUpdated = null;
    this._map = null;
    this._marker = null;
    this._halo = null;
    this._geoCache = {}; // reverse geocode cache
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
    console.log("[MMM-VolvoConnect] received MYVOLVO_DATA", payload && payload.meta);
    this.packet = payload;
    const ts = payload?.meta?.at || Date.now();
    this._lastUpdated = new Date(ts);
    this.updateDom(150);
    return;
  }
},
  /* ========================= DOM ========================= */
  getDom() {
    const root = document.createElement("div");
    root.className = "volvo-connect";
    if (this.config.compact !== false) root.classList.add("compact"); // default ON unless explicitly false

    // Header
    const header = document.createElement("header");
    header.className = "module-header";
    header.textContent = "Volvo Connect – My Volvo V90";
    root.appendChild(header);

    if (!this.packet) {
      const hint = document.createElement("div");
      hint.className = "muted";
      hint.textContent = "Waiting for vehicle data…";
      root.appendChild(hint);
      return root;
    }

    const d = this.packet.data;

    // ---------- Helper for location label ----------
    const formatLocationLabel = (data) => {
      const L = data.location?.data || data.location || {};
      const props = L.properties || {};
      const city = props.city || props.town || props.village || props.municipality;
      const road = props.road || props.street || props.name;
      if (city && road) return `${city} — ${road}`;
      if (road) return road;
      if (city) return city;
      let lat, lon;
      if (L.geometry?.coordinates?.length >= 2) {
        [lon, lat] = L.geometry.coordinates;
      } else {
        lat = L?.position?.latitude ?? L?.lastKnownPosition?.latitude;
        lon = L?.position?.longitude ?? L?.lastKnownPosition?.longitude;
      }
      if (lat != null && lon != null) {
        const fmt = (x) => Number(x).toFixed(4);
        return `${fmt(lat)}, ${fmt(lon)}`;
      }
      return "Location";
    };

    // ---------- Small helpers ----------
    const pick = (...v) => v.find((x) => x != null);
    const num = (n, dd = 0) => (isNaN(n) ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: dd }));
    const km = (n, dd = 0) => (n == null ? "—" : `${num(n, dd)} km`);

    const odoKm = pick(d.odometer?.data?.odometer?.value, d.odometer?.odometer?.value);
    // Correct fuel level parsing: prefer percent if provided; else compute from liters & capacity
    const fuelLevelPctRaw = pick(
      d.fuel?.data?.fuelLevelPercent,
      d.fuel?.fuelLevelPercent
    );
    const dteKm = pick(
      d.statistics?.data?.distanceToEmptyTank?.value,
      d.statistics?.distanceToEmptyTank?.value,
      d.statistics?.data?.distanceToEmpty?.value,
      d.statistics?.distanceToEmpty?.value
    );
    const engine = pick(
      d.engineStatus?.data?.engineStatus?.value,
      d.engineStatus?.engineStatus?.value
    );
    const locked = pick(
      d.doors?.data?.centralLock?.value,
      d.doors?.centralLock?.value,
      d.doors?.data?.lockState?.value
    );

    // Fuel from API (liters) and percent derivation
    const fuelLitersRaw = pick(d.fuel?.data?.fuelAmount?.value, d.fuel?.fuelAmount?.value);
    let liters = (fuelLitersRaw != null) ? Number(fuelLitersRaw) : null;

    // Determine percent: API percent if present, else compute from liters and capacity
    let fuelPctVal = null;
    if (fuelLevelPctRaw != null) {
      fuelPctVal = Number(fuelLevelPctRaw);
    } else if (liters != null && this.config.tankCapacityLiters) {
      fuelPctVal = (liters / Number(this.config.tankCapacityLiters)) * 100;
    }

    // Optional debug: log liters and percent
    console.log("[MMM-VolvoConnect] fuelLiters=", liters, "fuelPct=", fuelPctVal);

    // location
    const loc = (() => {
      const L = d.location?.data || d.location;
      if (L?.geometry?.coordinates?.length >= 2) {
        const [lon, lat] = L.geometry.coordinates;
        return { lat, lon };
      }
      const c = [
        { lat: L?.position?.latitude, lon: L?.position?.longitude },
        { lat: L?.lastKnownPosition?.latitude, lon: L?.lastKnownPosition?.longitude }
      ].find((x) => x?.lat != null && x?.lon != null);
      return c || null;
    })();

    // ===== Cluster layout (no tiles; fuel bar + left stats + car + last trip) =====
    if (this.config.layout === "cluster") {
      const cluster = this._renderClusterLayout(d, {
        liters,
        fuelPctVal,
        dteKm,
        odoKm,
        avgCons: d?.statistics?.data?.averageFuelConsumption?.value,
        avgSpeed: d?.statistics?.data?.averageSpeed?.value
      });
      root.appendChild(cluster);

      const upd = document.createElement("div");
      upd.className = "vc-updated";
      upd.textContent = `Updated: ${this._formatTime(this._lastUpdated || Date.now())}`;
      root.appendChild(upd);
      return root;
    }

    // ---------- MAIN CARD ----------
    const mainCard = document.createElement("div");
    mainCard.className = "main-card card";

    // top grid: car left, data right
    const topSection = document.createElement("div");
    topSection.className = "main-top";
    mainCard.appendChild(topSection);

    // car image
    const imgWrap = document.createElement("div");
    imgWrap.className = "car-wrap";
    const img = document.createElement("img");
    img.className = "car-image";
    img.src = this.config.carImage || this.file("car.png");
    img.alt = "vehicle";
    imgWrap.appendChild(img);
    topSection.appendChild(imgWrap);

    // data tiles
    const tileGrid = document.createElement("div");
    tileGrid.className = "data-tiles";
    topSection.appendChild(tileGrid);

    const addTile = (label, value) => {
      const t = document.createElement("div");
      t.className = "data-tile";
      t.innerHTML = `<div class="label">${label}</div><div class="value">${value}</div>`;
      tileGrid.appendChild(t);
    };

    addTile("Odometer", km(odoKm));
    if (dteKm != null) {
  addTile("Range", `${num(dteKm)} km`);
}

    addTile("Engine", engine ?? "—");
    
// Access (Doors + Windows combined)
(() => {
  // Doors (lock state) — hide silently if forbidden
  let doorLabel = "";
  if (d?.doors?.__error?.status !== 403) {
    const v = locked; // computed above
    if (typeof v === "string") {
      const up = v.toUpperCase();
      if (up === "LOCKED") doorLabel = "Locked";
      if (up === "UNLOCKED") doorLabel = "Unlocked";
    } else if (typeof v === "boolean") {
      doorLabel = v ? "Locked" : "Unlocked";
    }
  }

  // Windows — count only explicit open-ish states
  const win = d?.windows?.data || d?.windowsStatus?.data;
  let openCount = 0;
  if (win) {
    const OPEN_WORDS = new Set(["OPEN", "VENT", "AJAR", "PARTIALLY_OPEN", "PARTLY_OPEN"]);
    Object.values(win).forEach(val => {
      const raw = val?.value ?? val;
      if (typeof raw === "string" && OPEN_WORDS.has(raw.toUpperCase())) openCount++;
      else if (typeof raw === "boolean" && raw === true) openCount++;
      else if (typeof raw === "number" && raw > 0) openCount++;
    });
  }

  const parts = [];
  if (doorLabel) parts.push(doorLabel);
  parts.push(openCount > 0 ? `Win: ${openCount} open` : "Win: OK");

  addTile("Access", parts.join(" · "));
})();
// ---- TIER-1 additions ----

// Battery (for PHEV/EV; shown if present)
const soc = d?.hvBattery?.data?.stateOfCharge?.value
  ?? d?.battery?.data?.stateOfCharge?.value;
if (soc != null) {
  addTile("Battery", `${Math.round(Number(soc))}%`);
}

// Tyres summary (matches your payload structure: d.tyres.data.{frontLeft,..} = NO_WARNING)
const tyres = d?.tyres?.data;
if (tyres) {
  const anyWarn = Object.values(tyres).some(v => v?.value && v.value !== "NO_WARNING");
  addTile("Tyres", anyWarn ? "Check" : "OK");
}

// (Windows summary removed; now handled in Access tile)

// Connectivity (if present)
const conn = d?.connectivityStatus?.data || d?.connectivity?.data;
if (conn) {
  const online = conn?.online ?? conn?.connected;
  const sig = conn?.signalStrength ?? conn?.rssi;
  addTile("Connectivity", online ? (sig != null ? `Online (${num(sig)})` : "Online") : "Offline");
}

// Efficiency (Avg Consumption + Avg Speed) + compact Last Trip
const ts = d?.tripStatistics?.data || d?.statistics?.data || {};
const avgCons = ts?.averageFuelConsumption?.value; // L/100km
const avgSpd  = ts?.averageSpeed?.value;           // km/h
const tripAuto = ts?.tripMeterAutomatic?.value;    // km

const effParts = [];
if (avgCons != null) effParts.push(`${num(avgCons, 1)} L/100km`);
if (avgSpd  != null) effParts.push(`${num(avgSpd, 0)} km/h`);
if (effParts.length) addTile("Efficiency", effParts.join(" · "));

if (tripAuto != null) addTile("Last Trip", `${num(tripAuto, 1)} km`);

// Diagnostics / Next Service from /diagnostics
// Diagnostics / Next Service from /diagnostics
const diag = d?.diagnostics?.data;
console.log("[MMM-VolvoConnect] Diagnostics object:", diag);

if (!diag) {
  console.warn("[MMM-VolvoConnect] No diagnostics data found.");
} else {
  const timeMo = diag?.timeToService?.value;
  const distKm = diag?.distanceToService?.value;
  const engH   = diag?.engineHoursToService?.value;
  const warn   = diag?.serviceWarning?.value;
  const washer = diag?.washerFluidLevelWarning?.value;

  console.log("[MMM-VolvoConnect] timeToService:", timeMo);
  console.log("[MMM-VolvoConnect] distanceToService:", distKm);
  console.log("[MMM-VolvoConnect] engineHoursToService:", engH);
  console.log("[MMM-VolvoConnect] serviceWarning:", warn);
  console.log("[MMM-VolvoConnect] washerFluidLevelWarning:", washer);

  const parts = [];
  if (timeMo != null) parts.push(`${num(timeMo)} mo`);
  if (distKm != null) parts.push(`${num(distKm)} km`);
  // intentionally omit engine hours from the Next Service tile

  const warnClass = warn && String(warn).toUpperCase() !== "NO_WARNING" ? "warning" : "";
  addTile("Next Service", parts.length ? parts.join(" · ") : "—", warnClass);

  const extra = [];
  if (washer && washer !== "NO_WARNING") extra.push("Check washer fluid");
  if (engH != null && engH <= 100) extra.push("Service soon (engine hours)");
  if (extra.length) addTile("Service Details", extra.join(" · "));
}

// Vehicle details (model/year) if you want a quick ID tile
// REMOVED as per instruction (Vehicle identification tile before Odometer)


 // ---------- Fuel bar ----------
const barWrap = document.createElement("div");
barWrap.className = "fuelbar";

const barFill = document.createElement("div");
barFill.className = "fuelbar-fill";

// integers only (no decimals)
const litersInt = Number.isFinite(liters) ? Math.round(liters) : null;
const pctInt    = Number.isFinite(fuelPctVal) ? Math.round(fuelPctVal) : null;

// set width from %
if (pctInt != null) {
  barFill.style.width = `${pctInt}%`;
}

const barLabel = document.createElement("div");
barLabel.className = "fuelbar-label";

// label: show only liters and %, no capacity, no decimals
if (litersInt != null && pctInt != null) {
  barLabel.textContent = `${litersInt}L (${pctInt}%)`;
} else if (litersInt != null) {
  barLabel.textContent = `${litersInt}L`;
} else if (pctInt != null) {
  barLabel.textContent = `${pctInt}%`;
} else {
  barLabel.textContent = "—";
}

barWrap.appendChild(barFill);
barWrap.appendChild(barLabel);
mainCard.appendChild(barWrap);

    // ---------- Embedded map ----------
    if (loc) {
      const mapWrap = document.createElement("div");
      mapWrap.className = "map-wrap";
      mainCard.appendChild(mapWrap);

      const mapEl = document.createElement("div");
      const mapId = `${this.identifier}_map_${Date.now()}`;
      mapEl.id = mapId;
      mapEl.className = "leaflet-holder";
      mapWrap.appendChild(mapEl);

      // translucent location label
      const mapLabel = document.createElement("div");
      mapLabel.className = "map-location";
      mapLabel.textContent = "Locating…";
      mapWrap.appendChild(mapLabel);
      this._updateMapLabel(mapLabel, loc, d);

      const tryInit = (t = 0) => {
        const el = document.getElementById(mapId);
        if (el) this._initOrQueueMap(mapId, loc);
        else if (t < 10) setTimeout(() => tryInit(t + 1), 100);
      };
      requestAnimationFrame(() => tryInit());
    }

    const upd = document.createElement("div");
    upd.className = "vc-updated";
    upd.textContent = `Updated: ${this._formatTime(this._lastUpdated || Date.now())}`;
    root.appendChild(upd);
    return root;
  },

  // ===== Cluster layout renderer and helpers =====
  _renderClusterLayout(data, vals) {
    const cap = Number(this.config.tankCapacityLiters) || 55;
    const liters = Number.isFinite(vals.liters) ? Number(vals.liters) : null;
    const pct    = Number.isFinite(vals.fuelPctVal)
      ? Math.max(0, Math.min(100, Number(vals.fuelPctVal)))
      : (Number.isFinite(liters) ? (liters / cap) * 100 : null);

    const avgCons = Number.isFinite(vals.avgCons)  ? Number(vals.avgCons)  : null;
    const avgSpd  = Number.isFinite(vals.avgSpeed) ? Number(vals.avgSpeed) : null;
    const dteKm   = Number.isFinite(vals.dteKm)    ? Number(vals.dteKm)    : null;
    const odoKm   = Number.isFinite(vals.odoKm)    ? Number(vals.odoKm)    : null;

    const root = document.createElement('div');
    root.className = 'main-card vc-cluster';

    // top row: left stack + car image
    const top = document.createElement('div');
    top.className = 'vc-toprow';

    const left = document.createElement('div');
    left.className = 'vc-leftstack';

    // fuel bar
    const fb = document.createElement('div');
    fb.className = 'fuelbar slim';
    const fill = document.createElement('div');
    fill.className = 'fuelbar-fill';
    if (pct != null && isFinite(pct)) fill.style.width = `${Math.round(pct)}%`;

    const flabel = document.createElement('div');
    flabel.className = 'fuelbar-label';
    const litersInt = Number.isFinite(liters) ? Math.round(liters) : null;
    const pctInt    = pct != null && isFinite(pct) ? Math.round(pct) : null;
    if (litersInt != null && pctInt != null) flabel.textContent = `${pctInt}%  ·  ${litersInt} L`;
    else if (pctInt != null) flabel.textContent = `${pctInt}%`;
    else if (litersInt != null) flabel.textContent = `${litersInt} L`;
    else flabel.textContent = '—';

    fb.appendChild(fill);
    fb.appendChild(flabel);
    left.appendChild(fb);

    // metrics grid
    const metrics = document.createElement('div');
    metrics.className = 'vc-metrics';
    metrics.append(
      this._mrow('range', dteKm != null ? `${Math.round(dteKm)} km` : '—'),
      this._mrow('odo',   odoKm != null ? `${odoKm.toLocaleString()} km` : '—'),
      this._mrow('consumption', avgCons != null ? `${avgCons.toFixed(1)} L/100 km` : '—'),
      this._mrow('speed', avgSpd != null ? `${Math.round(avgSpd)} km/h` : '—')
    );
    left.appendChild(metrics);

    const right = document.createElement('div');
    right.className = 'vc-carbox';
    const img = document.createElement('img');
    img.className = 'car-image';
    img.src = this.config.carImage || this.file('car.png');
    img.alt = 'vehicle';
    right.appendChild(img);

    top.append(left, right);
    root.appendChild(top);

    // divider
    const divline = document.createElement('div');
    divline.className = 'vc-divider';
    root.appendChild(divline);

    // last trip row (time · distance · speed · cons)
    const ts = data?.statistics?.data || {};
    const tripKm = Number(ts?.tripMeterAutomatic?.value);
    const tMin = (Number.isFinite(tripKm) && Number.isFinite(avgSpd) && avgSpd > 0)
      ? Math.round((tripKm / avgSpd) * 60) : null;

    const lastWrap = document.createElement('div');
    lastWrap.className = 'vc-lasttrip';

    // Left-side items (time, distance, consumption)
    lastWrap.append(
      this._ltItem('clock',  tMin != null ? this._mmss(tMin) : '—'),
      this._ltItem('range',  Number.isFinite(tripKm) ? `${tripKm.toFixed(2)} km` : '—'),
      // speed item is omitted here (also hidden via CSS if present)
      this._ltItem('consumption', avgCons != null ? `${avgCons.toFixed(1)} L / 100 km` : '—')
    );

    // Compute a location object from the packet
    const loc = (() => {
      const L = data?.location?.data || data?.location;
      if (L?.geometry?.coordinates?.length >= 2) {
        const [lon, lat] = L.geometry.coordinates;
        return { lat, lon };
      }
      const v = [
        { lat: L?.position?.latitude, lon: L?.position?.longitude },
        { lat: L?.lastKnownPosition?.latitude, lon: L?.lastKnownPosition?.longitude }
      ].find(x => x?.lat != null && x?.lon != null);
      return v || null;
    })();

    // Right-side: current location label with icon
    const locBox = document.createElement('div');
    locBox.className = 'vc-location-info vc-lt-item'; // reuse lt-item flex/gap styles

    const pinIcn = this._icon('location');
    locBox.appendChild(pinIcn);

    const locSpan = document.createElement('span');

    // Try to use packet label first, fallback to coords, then async reverse geocode
    let label = this._labelFromPacket(data);
    if (!label && loc) label = `${Number(loc.lat).toFixed(4)}, ${Number(loc.lon).toFixed(4)}`;
    locSpan.textContent = label || '—';
    locBox.appendChild(locSpan);

    if (!this._labelFromPacket(data) && loc) {
      // Improve label asynchronously
      this._revGeocode(loc.lat, lon = loc.lon).then(nice => {
        locSpan.textContent = nice || locSpan.textContent;
      }).catch(() => {});
    }

    lastWrap.appendChild(locBox);
    root.appendChild(lastWrap);

    return root;
  },

  _mrow(iconName, text) {
    const row = document.createElement('div');
    row.className = 'vc-mrow';
    row.appendChild(this._icon(iconName));
    const t = document.createElement('span');
    t.className = 'vc-metric';
    t.textContent = text;
    row.appendChild(t);
    return row;
  },

  _ltItem(iconName, text) {
    const box = document.createElement('div');
    box.className = 'vc-lt-item';
    box.appendChild(this._icon(iconName));
    const s = document.createElement('span');
    s.textContent = text;
    box.appendChild(s);
    return box;
  },

  _mmss(totalMin) {
    const m = Math.max(0, Number(totalMin) | 0);
    return `${String(m).padStart(2,'0')}:00`;
  },

  _icon(name) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2'); // Tabler default
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.classList.add('vc-icn', 'icon', 'icon-tabler');

    // Helper to append a path
    const add = (d, extra = {}) => {
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('d', d);
      Object.entries(extra).forEach(([k, v]) => p.setAttribute(k, v));
      svg.appendChild(p);
    };

    // Choose Tabler-style paths by logical name
    let paths = [];
    switch (name) {
      case 'odo':
        // Tabler: icon-tabler-road (user-provided)
        paths = [
          'M0 0h24v24H0z', // ignored fill-none in original; harmless outline reset
          'M4 19l4 -14',
          'M16 5l4 14',
          'M12 8v-2',
          'M12 13v-2',
          'M12 18v-2'
        ];
        break;

      case 'fuel':
      case 'consumption':
        // Tabler-like gas station outline (simple variant)
        paths = [
          'M4 7h8a2 2 0 0 1 2 2v10H4z',              // pump body
          'M6 7v-1a3 3 0 0 1 3 -3h2',                 // top neck
          'M14 10h2a2 2 0 0 1 2 2v6',                 // hose right
          'M18 12l2 1v5',                             // nozzle line
          'M6 12h6'                                   // display line
        ];
        break;

      case 'range':
        // Tabler-like "route"/distance motif
        paths = [
          'M4 12h8',                                  // baseline
          'M12 12a4 4 0 1 0 4 -4',                    // arc hint
          'M16 8l4 -2'                                // direction cue
        ];
        break;

      case 'speed':
        // Tabler: gauge/speedometer style
        paths = [
          'M5 17a9 9 0 1 1 14 0',                    // semi-circle
          'M12 12l4 -2'                               // needle
        ];
        break;

      case 'clock':
        // Tabler clock outline
        paths = [
          'M12 7a5 5 0 1 1 0 10a5 5 0 0 1 0 -10',    // circle
          'M12 10v3l2 1'                              // hands
        ];
        break;

      case 'location':
      case 'pin':
        // Tabler map-pin
        paths = [
          'M12 21c-2.8-2.1-6-5.5-6-9a6 6 0 1 1 12 0c0 3.5-3.2 6.9-6 9',
          'M12 9.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 0 0 0 -5'
        ];
        break;

      default:
        // fallback minimal dot
        paths = ['M12 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0'];
    }

    // Append all paths (skip the clear rect path)
    paths.forEach(d => { if (!/^M0 0h24v24H0z$/.test(d)) add(d); });
    return svg;
  },

  _formatTime(dt) {
    try {
      const d = (dt instanceof Date) ? dt : new Date(dt);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return '';
    }
  },

  /* ========================= MAP ========================= */
  _initOrQueueMap(domId, pos) {
    if (typeof L === "undefined") {
      setTimeout(() => this._initOrQueueMap(domId, pos), 400);
      return;
    }

    const container = document.getElementById(domId);
    if (!container) return;

    if (this._map) {
      const currentId = this._map.getContainer()?.id;
      if (currentId !== domId) {
        try {
          this._map.remove();
        } catch {}
        this._map = null;
        this._marker = null;
        this._halo = null;
      }
    }

    if (!this._map) {
      this._map = L.map(domId, {
        zoomControl: false,
        attributionControl: false,
        dragging: false,
        scrollWheelZoom: false,
        doubleClickZoom: false
      }).setView([pos.lat, pos.lon], 17);

      // modern dark map
      L.tileLayer(
        "https://tile.jawg.io/jawg-dark/{z}/{x}/{y}.png?access-token=kwuHBunBfj6ZH37ePc13gZHpm9ZVAnSFQGBxXjVUJ1PjHRyBiMSrfj3Px0p2lxyp",
        {
          attribution: "&copy; JawgMaps",
          maxZoom: 22
        }
      ).addTo(this._map);

      // Dynamic halo scaling
      const computeHalo = (z) => Math.max(10, 400 / Math.pow(z, 1.5));
      this._halo = L.circle([pos.lat, pos.lon], {
        radius: computeHalo(this._map.getZoom()),
        color: "#f2a100",
        fillColor: "#f2a100",
        fillOpacity: 0.25,
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

      // update halo size on zoom
      this._map.on("zoomend", () => {
        if (this._halo) this._halo.setRadius(computeHalo(this._map.getZoom()));
      });

      requestAnimationFrame(() => this._map && this._map.invalidateSize());
      setTimeout(() => this._map && this._map.invalidateSize(), 200);
    } else {
      this._map.setView([pos.lat, pos.lon]);
      if (this._marker) this._marker.setLatLng([pos.lat, pos.lon]);
      if (this._halo) this._halo.setLatLng([pos.lat, pos.lon]);
      requestAnimationFrame(() => this._map && this._map.invalidateSize());
    }
  },

  // Try to build a human label from the packet itself (no network); returns string or null
  _labelFromPacket(data) {
    const L = data?.location?.data || data?.location || {};
    const props = L.properties || {};
    const city = props.city || props.town || props.village || props.municipality;
    const area = props.suburb || props.neighbourhood || props.city_district || props.district || props.quarter || props.hamlet;
    const road = props.road || props.street || props.name;
    const house = props.house_number || props.housenumber || props.houseNumber;

    if (area && road && house) return `${area} — ${road} ${house}`;
    if (area && road) return `${area} — ${road}`;
    if (city && road && house) return `${city} — ${road} ${house}`;
    if (city && road) return `${city} — ${road}`;
    if (road && house) return `${road} ${house}`;
    if (road) return road;
    if (area) return area;
    if (city) return city;
    return null;
  },

  // Reverse‑geocode via Nominatim with tiny in‑memory cache to avoid rate limits
  _revGeocode(lat, lon) {
    const key = `${Number(lat).toFixed(5)},${Number(lon).toFixed(5)}`;
    if (this._geoCache[key]) return Promise.resolve(this._geoCache[key]);
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&zoom=18&addressdetails=1`;
    return fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'MMM-VolvoConnect/1.0 (MagicMirror)'
      }
    })
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(j => {
      const addr = j.address || {};
      const city = addr.city || addr.town || addr.village || addr.municipality || addr.county;
      const area = addr.suburb || addr.neighbourhood || addr.city_district || addr.district || addr.quarter || addr.hamlet;
      const road = addr.road || addr.pedestrian || addr.cycleway || addr.path || addr.footway || addr.residential || addr.neighbourhood || addr.road_reference || addr.road_reference_intl;
      const house = addr.house_number || addr.housenumber;

      let label = null;
      if (area && road && house) label = `${area} — ${road} ${house}`;
      else if (area && road) label = `${area} — ${road}`;
      else if (city && road && house) label = `${city} — ${road} ${house}`;
      else if (city && road) label = `${city} — ${road}`;
      else if (road && house) label = `${road} ${house}`;
      else if (road) label = road;
      else if (area) label = area;
      else if (city) label = city;

      if (!label && j.name) label = j.name;
      if (!label && typeof j.display_name === 'string') label = j.display_name.split(',')[0];
      if (!label) label = `${Number(lat).toFixed(4)}, ${Number(lon).toFixed(4)}`;
      this._geoCache[key] = label;
      return label;
      })
      .catch(() => `${Number(lat).toFixed(4)}, ${Number(lon).toFixed(4)}`);
  },

  // Decide the best label and update the provided element
  _updateMapLabel(el, loc, data) {
    const fromPacket = this._labelFromPacket(data);
    if (fromPacket) { el.textContent = fromPacket; return; }
    if (loc && loc.lat != null && loc.lon != null) {
      this._revGeocode(loc.lat, loc.lon).then(label => { el.textContent = label; });
    } else {
      el.textContent = 'Location';
    }
  }
});
