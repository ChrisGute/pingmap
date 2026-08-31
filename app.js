/* PingMap: local GPS/HTTP measurements with a small chart and heatmap. */
const $ = (id) => document.getElementById(id);
const els = {
  name: $("deviceName"), url: $("pingUrl"), timeout: $("requestTimeout"), threshold: $("threshold"), state: $("runState"), start: $("startBtn"), stop: $("stopBtn"),
  export: $("exportBtn"), clear: $("clearBtn"), latency: $("latency"), latencyStatus: $("latencyStatus"),
  latitude: $("latitude"), longitude: $("longitude"), accuracy: $("accuracy"), gpsStatus: $("gpsStatus"),
  count: $("sampleCount"), failures: $("failureCount"), lastSample: $("lastSample"), log: $("log"), maps: $("mapsLink"),
  detectedDevice: $("detectedDevice"), network: $("networkInfo"), chart: $("chart"), thresholdLegend: $("thresholdLegend"),
  failureSummary: $("failureSummary"), heatToggle: $("heatToggle"), keepAwake: $("keepAwake"), wakeStatus: $("wakeStatus"), pollStatus: $("pollStatus")
};

let running = false;
let timer = null;
let watchId = null;
let currentPosition = null;
let samples = [];
let map = null;
let marker = null;
let heatLayer = null;
let heatEnabled = true;
let chartWindow = 30;
let wakeLock = null;
let lastGpsPoint = null;
let gpsIsStationary = false;
let lastProbeStartedAt = 0;
let detectedDeviceName = "Mobile device";
let deviceNameOverridden = false;
let hasReliableGpsFix = false;
let stationarySince = null;

function thresholdValue() {
  const value = Number(els.threshold.value);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 60000) : 500;
}

function requestTimeoutValue() {
  const value = Number(els.timeout.value);
  return Number.isFinite(value) && value >= 100 ? Math.min(value, 10000) : 600;
}

function distanceMeters(a, b) {
  const radians = Math.PI / 180;
  const lat1 = a.latitude * radians, lat2 = b.latitude * radians;
  const dLat = (b.latitude - a.latitude) * radians;
  const dLon = (b.longitude - a.longitude) * radians;
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function probeIntervalMs() {
  return gpsIsStationary ? 30000 : 1000;
}

function updatePollStatus() {
  if (!hasReliableGpsFix) {
    els.pollStatus.textContent = "GPS fix is not reliable yet — probes are running every second.";
  } else {
    els.pollStatus.textContent = gpsIsStationary
      ? "GPS has been stationary — probes are running every 30 seconds."
      : "GPS is moving — probes are running every second.";
  }
}

function updateMovementState(coords) {
  const point = { latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy || 0 };
  if (!Number.isFinite(point.accuracy) || point.accuracy > 50) {
    hasReliableGpsFix = false;
    gpsIsStationary = false;
    stationarySince = null;
    lastGpsPoint = null;
    updatePollStatus();
    return;
  }
  hasReliableGpsFix = true;
  if (!lastGpsPoint) {
    lastGpsPoint = point;
    gpsIsStationary = false;
    stationarySince = null;
  } else {
    const tolerance = Math.max(12, point.accuracy, lastGpsPoint.accuracy);
    if (distanceMeters(lastGpsPoint, point) <= tolerance) {
      stationarySince ??= Date.now();
      gpsIsStationary = Date.now() - stationarySince >= 15000;
    } else {
      gpsIsStationary = false;
      stationarySince = null;
    }
    lastGpsPoint = point;
  }
  updatePollStatus();
}

function setState(text, type = "idle") {
  els.state.textContent = text;
  els.state.className = `state ${type}`;
}

function setWakeStatus(text) {
  els.wakeStatus.textContent = text;
}

async function requestWakeLock() {
  if (!running || !els.keepAwake.checked) return;
  if (!("wakeLock" in navigator)) {
    setWakeStatus("This browser does not support screen stay-awake.");
    return;
  }
  if (wakeLock && !wakeLock.released) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    setWakeStatus("Screen stay-awake is active while testing.");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
      if (running && els.keepAwake.checked && document.visibilityState === "visible") requestWakeLock();
    });
  } catch {
    setWakeStatus("Screen stay-awake was unavailable; keep this page visible.");
  }
}

async function releaseWakeLock() {
  if (!wakeLock) return;
  const lock = wakeLock;
  wakeLock = null;
  try { await lock.release(); } catch { /* Already released by the device. */ }
  setWakeStatus("Screen stay-awake is off.");
}

function detectDeviceAndNetwork() {
  const ua = navigator.userAgent || "";
  if (/iPhone/i.test(ua)) detectedDeviceName = "iPhone";
  else if (/iPad/i.test(ua)) detectedDeviceName = "iPad";
  else if (/Android/i.test(ua)) detectedDeviceName = "Android phone";
  else if (/Windows Phone/i.test(ua)) detectedDeviceName = "Windows phone";
  els.detectedDevice.textContent = detectedDeviceName;

  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!connection) {
    els.network.textContent = "Unavailable in this browser";
    updateAutomaticDeviceName();
    return;
  }
  updateNetworkInfo(connection);
  connection.addEventListener?.("change", () => updateNetworkInfo(connection));
}

function networkName(connection) {
  return connection?.effectiveType || connection?.type || "network";
}

function updateAutomaticDeviceName(connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection) {
  if (deviceNameOverridden) return;
  els.name.value = `${detectedDeviceName} - ${networkName(connection)}`;
}

function updateNetworkInfo(connection) {
  const type = connection.type || "";
  const effective = connection.effectiveType || "";
  const parts = [];
  if (type) parts.push(type);
  if (effective && effective !== type) parts.push(effective);
  if (Number.isFinite(connection.downlink)) parts.push(`${connection.downlink} Mbps`);
  els.network.textContent = parts.length ? parts.join(" · ") : "Online (details unavailable)";
  updateAutomaticDeviceName(connection);
}

function initMap() {
  if (!window.L || map) return;
  map = L.map("map", { zoomControl: false }).setView([39.8283, -98.5795], 4);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);
  updateHeatmap();
}

function heatPoints() {
  return samples.filter((s) => s.latitude != null && s.longitude != null).map((s) => {
    const limit = Number(s.thresholdMs) || thresholdValue();
    const intensity = s.deadZone ? 1 : Math.max(0.08, Math.min(0.8, (s.latency || 0) / limit));
    return [s.latitude, s.longitude, intensity];
  });
}

function updateHeatmap() {
  if (!map || !window.L.heatLayer) return;
  if (!heatEnabled) {
    if (heatLayer) map.removeLayer(heatLayer);
    return;
  }
  const points = heatPoints();
  if (!heatLayer) {
    heatLayer = L.heatLayer(points, {
      radius: 25, blur: 20, maxZoom: 17, max: 1.0,
      gradient: { 0.15: "#55a9ff", 0.45: "#51d88a", 0.7: "#ffd166", 1: "#ff4d5e" }
    }).addTo(map);
  } else {
    heatLayer.setLatLngs(points);
    if (!map.hasLayer(heatLayer)) heatLayer.addTo(map);
  }
}

function updateLocation(position) {
  currentPosition = position;
  const { latitude, longitude, accuracy } = position.coords;
  els.latitude.textContent = latitude.toFixed(6);
  els.longitude.textContent = `Longitude ${longitude.toFixed(6)}`;
  els.accuracy.textContent = `${Math.round(accuracy)} m`;
  els.gpsStatus.textContent = `Updated ${new Date(position.timestamp).toLocaleTimeString()}`;
  updateMovementState(position.coords);
  els.maps.href = `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
  els.maps.hidden = false;
  initMap();
  if (map) {
    const point = [latitude, longitude];
    map.setView(point, Math.max(map.getZoom(), 16));
    if (!marker) marker = L.marker(point).addTo(map);
    else marker.setLatLng(point);
    marker.bindPopup(`You are here<br>${latitude.toFixed(6)}, ${longitude.toFixed(6)}`);
  }
}

function locationError(error) {
  const messages = { 1: "Location permission denied", 2: "Location unavailable", 3: "Location request timed out" };
  els.gpsStatus.textContent = messages[error.code] || "Location error";
  hasReliableGpsFix = false;
  gpsIsStationary = false;
  stationarySince = null;
  lastGpsPoint = null;
  updatePollStatus();
  if (running) setState(messages[error.code] || "Location error", "error");
}

function drawLog() {
  if (!samples.length) {
    els.log.innerHTML = '<p class="empty">Your readings will appear here.</p>';
    els.failureSummary.textContent = "";
    return;
  }
  const failures = samples.filter((s) => s.deadZone).length;
  els.failureSummary.textContent = `${failures} failure${failures === 1 ? "" : "s"}`;
  els.log.innerHTML = samples.slice(-12).reverse().map((s) => {
    const time = new Date(s.timestamp).toLocaleTimeString();
    const place = s.latitude == null ? "No GPS fix" : `${s.latitude.toFixed(5)}, ${s.longitude.toFixed(5)}`;
    const result = s.deadZone ? (s.latency == null ? "DEAD ZONE" : `${s.latency} ms · DEAD ZONE`) : `${s.latency} ms`;
    return `<div class="reading"><span class="reading-time">${time}</span><span class="reading-main">${place}</span><span class="${s.deadZone ? "reading-fail" : "reading-ok"}">${result}</span></div>`;
  }).join("");
}

async function measurePing() {
  const base = els.url.value.trim() || "ping.txt";
  let url;
  try { url = new URL(base, window.location.href); }
  catch { throw new Error("Invalid endpoint URL"); }
  url.searchParams.set("t", `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const requestTimeout = requestTimeoutValue();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeout);
  const start = performance.now();
  try {
    const response = await fetch(url.href, { method: "GET", cache: "no-store", signal: controller.signal });
    await response.arrayBuffer();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const elapsed = Math.round(performance.now() - start);
    if (elapsed >= requestTimeout) {
      const error = new Error(`Timeout after ${requestTimeout} ms`);
      error.name = "TimeoutError";
      throw error;
    }
    return elapsed;
  } finally { clearTimeout(timeout); }
}

async function takeSample() {
  const timestamp = new Date().toISOString();
  const sampleThreshold = thresholdValue();
  const requestTimeout = requestTimeoutValue();
  let latency = null;
  let errorReason = "";
  try {
    latency = await measurePing();
  } catch (error) {
    errorReason = error.name === "AbortError" || error.name === "TimeoutError" ? `Timeout after ${requestTimeout} ms` : error.message;
  }
  const deadZone = latency == null || latency >= sampleThreshold;
  if (latency == null) {
    els.latency.textContent = "Timeout";
    els.latencyStatus.textContent = errorReason || "Request failed";
  } else {
    els.latency.textContent = `${latency} ms`;
    els.latencyStatus.textContent = deadZone ? `Dead zone ≥ ${sampleThreshold} ms` : "HTTP round-trip";
  }
  const coords = currentPosition?.coords;
  samples.push({
    timestamp, device: els.name.value.trim() || "Unlabeled", latency,
    latitude: coords?.latitude ?? null, longitude: coords?.longitude ?? null,
    accuracy: coords?.accuracy ?? null, thresholdMs: sampleThreshold, requestTimeoutMs: requestTimeout, deadZone,
    failureReason: deadZone ? (errorReason || (latency >= sampleThreshold ? `Latency ≥ ${sampleThreshold} ms` : "")) : ""
  });
  els.count.textContent = samples.length;
  els.failures.textContent = samples.filter((s) => s.deadZone).length;
  els.lastSample.textContent = `Last: ${new Date(timestamp).toLocaleTimeString()}`;
  els.thresholdLegend.textContent = `Threshold: ${sampleThreshold} ms`;
  els.export.disabled = false;
  els.clear.disabled = false;
  drawLog();
  updateHeatmap();
  drawChart();
}

function scheduleNextSample() {
  if (!running) return;
  timer = setInterval(() => {
    const now = Date.now();
    if (now - lastProbeStartedAt < probeIntervalMs()) return;
    lastProbeStartedAt = now;
    takeSample();
  }, 250);
}

function drawChart() {
  const chart = els.chart;
  const w = 700, h = 230;
  const pad = { left: 48, right: 12, top: 14, bottom: 28 };
  const plotW = w - pad.left - pad.right, plotH = h - pad.top - pad.bottom;
  const now = Date.now(), start = now - chartWindow * 1000;
  const visible = samples.filter((s) => Date.parse(s.timestamp) >= start);
  const threshold = thresholdValue();
  const latencies = visible.filter((s) => s.latency != null).map((s) => s.latency);
  const max = Math.max(threshold * 1.2, ...(latencies.length ? latencies : [0])) * 1.1;
  const x = (time) => pad.left + Math.max(0, Math.min(1, (time - start) / (chartWindow * 1000))) * plotW;
  const y = (value) => pad.top + plotH - Math.max(0, Math.min(1, value / max)) * plotH;
  const grid = Array.from({ length: 4 }, (_, i) => {
    const value = Math.round((max * i) / 3), yy = y(value);
    return `<line x1="${pad.left}" y1="${yy}" x2="${w - pad.right}" y2="${yy}" stroke="#293a55"/><text x="2" y="${yy + 4}" fill="#9eacc0" font-size="11">${value} ms</text>`;
  }).join("");
  const thresholdLine = `<line x1="${pad.left}" y1="${y(threshold)}" x2="${w - pad.right}" y2="${y(threshold)}" stroke="#ff7474" stroke-opacity=".7" stroke-dasharray="5 4"/>`;
  if (!visible.length) {
    chart.innerHTML = `${grid}${thresholdLine}<text x="${pad.left + 12}" y="${pad.top + plotH / 2}" fill="#9eacc0" font-size="13">Start the test to see latency</text>`;
    return;
  }
  const points = visible.map((s) => `${x(Date.parse(s.timestamp))},${y(s.latency == null ? threshold : s.latency)}`).join(" ");
  const dots = visible.map((s) => {
    const color = s.deadZone ? "#ff7474" : "#55a9ff";
    const radius = s.deadZone ? 4.5 : 2.5;
    return `<circle cx="${x(Date.parse(s.timestamp))}" cy="${y(s.latency == null ? threshold : s.latency)}" r="${radius}" fill="${color}"/>`;
  }).join("");
  const label = `${chartWindow < 60 ? `${chartWindow}s` : `${chartWindow / 60}m`} window`;
  chart.innerHTML = `${grid}${thresholdLine}<polyline points="${points}" fill="none" stroke="#55a9ff" stroke-width="2.5" vector-effect="non-scaling-stroke"/>${dots}<text x="${pad.left}" y="${h - 7}" fill="#9eacc0" font-size="11">${label}</text>`;
}

function start() {
  if (running) return;
  running = true; els.start.disabled = true; els.stop.disabled = false;
  setState("Testing", "running");
  lastGpsPoint = null;
  gpsIsStationary = false;
  hasReliableGpsFix = false;
  stationarySince = null;
  lastProbeStartedAt = Date.now();
  updatePollStatus();
  requestWakeLock();
  if (!navigator.geolocation) locationError({ code: 2 });
  else watchId = navigator.geolocation.watchPosition(updateLocation, locationError, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  takeSample(); scheduleNextSample();
}

function stop() {
  running = false; clearInterval(timer); timer = null;
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null; els.start.disabled = false; els.stop.disabled = true; setState("Paused", "idle");
  releaseWakeLock();
}

function exportCsv() {
  const header = "timestamp,device,latency_ms,dead_zone,threshold_ms,request_timeout_ms,failure_reason,latitude,longitude,gps_accuracy_m\n";
  const rows = samples.map((s) => [s.timestamp, s.device, s.latency ?? "", s.deadZone, s.thresholdMs, s.requestTimeoutMs, s.failureReason, s.latitude ?? "", s.longitude ?? "", s.accuracy ?? ""]
    .map((v) => `"${String(v).replaceAll('"', '""')}"`).join(","));
  const blob = new Blob(["\ufeff", header, rows.join("\n")], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob);
  link.download = `pingmap-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}.csv`; link.click(); URL.revokeObjectURL(link.href);
}

els.start.addEventListener("click", start);
els.stop.addEventListener("click", stop);
els.export.addEventListener("click", exportCsv);
els.name.addEventListener("input", () => { deviceNameOverridden = true; });
els.clear.addEventListener("click", () => {
  samples = []; els.count.textContent = "0"; els.failures.textContent = "0"; els.lastSample.textContent = "Nothing recorded";
  els.export.disabled = true; els.clear.disabled = true; drawLog(); updateHeatmap(); drawChart();
});
els.threshold.addEventListener("input", () => { els.thresholdLegend.textContent = `Threshold: ${thresholdValue()} ms`; drawChart(); updateHeatmap(); });
document.querySelectorAll(".range-button").forEach((button) => button.addEventListener("click", () => {
  chartWindow = Number(button.dataset.window); document.querySelectorAll(".range-button").forEach((b) => b.classList.toggle("active", b === button)); drawChart();
}));
els.heatToggle.addEventListener("click", () => {
  heatEnabled = !heatEnabled; els.heatToggle.textContent = `Heatmap: ${heatEnabled ? "On" : "Off"}`; updateHeatmap();
});
els.keepAwake.addEventListener("change", () => {
  if (!running) return;
  if (els.keepAwake.checked) requestWakeLock();
  else releaseWakeLock();
});
window.addEventListener("resize", drawChart);
window.addEventListener("online", () => { updateNetworkInfo(navigator.connection || {}); if (running) setState("Testing", "running"); });
window.addEventListener("offline", () => setState("Offline", "error"));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && running && els.keepAwake.checked) requestWakeLock();
});

detectDeviceAndNetwork();
drawChart();
