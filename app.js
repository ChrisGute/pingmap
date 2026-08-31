/* PingMap: local GPS/HTTP measurements with a small chart and heatmap. */
const $ = (id) => document.getElementById(id);
const els = {
  name: $("deviceName"), url: $("pingUrl"), threshold: $("threshold"), state: $("runState"), start: $("startBtn"), stop: $("stopBtn"),
  export: $("exportBtn"), clear: $("clearBtn"), latency: $("latency"), latencyStatus: $("latencyStatus"),
  latitude: $("latitude"), longitude: $("longitude"), accuracy: $("accuracy"), gpsStatus: $("gpsStatus"),
  count: $("sampleCount"), failures: $("failureCount"), lastSample: $("lastSample"), log: $("log"), maps: $("mapsLink"),
  detectedDevice: $("detectedDevice"), network: $("networkInfo"), chart: $("chart"), thresholdLegend: $("thresholdLegend"),
  failureSummary: $("failureSummary"), heatToggle: $("heatToggle")
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

function thresholdValue() {
  const value = Number(els.threshold.value);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 60000) : 500;
}

function setState(text, type = "idle") {
  els.state.textContent = text;
  els.state.className = `state ${type}`;
}

function detectDeviceAndNetwork() {
  const ua = navigator.userAgent || "";
  let device = "Unknown device";
  if (/iPhone/i.test(ua)) device = "iPhone";
  else if (/iPad/i.test(ua)) device = "iPad";
  else if (/Android/i.test(ua)) device = "Android phone";
  else if (/Windows Phone/i.test(ua)) device = "Windows phone";
  els.detectedDevice.textContent = device;

  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!connection) {
    els.network.textContent = "Unavailable in this browser";
    return;
  }
  updateNetworkInfo(connection);
  connection.addEventListener?.("change", () => updateNetworkInfo(connection));
}

function updateNetworkInfo(connection) {
  const type = connection.type || "";
  const effective = connection.effectiveType || "";
  const parts = [];
  if (type) parts.push(type);
  if (effective && effective !== type) parts.push(effective);
  if (Number.isFinite(connection.downlink)) parts.push(`${connection.downlink} Mbps`);
  els.network.textContent = parts.length ? parts.join(" · ") : "Online (details unavailable)";
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const start = performance.now();
  try {
    const response = await fetch(url.href, { method: "GET", cache: "no-store", signal: controller.signal });
    await response.arrayBuffer();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return Math.round(performance.now() - start);
  } finally { clearTimeout(timeout); }
}

async function takeSample() {
  const timestamp = new Date().toISOString();
  const sampleThreshold = thresholdValue();
  let latency = null;
  let errorReason = "";
  try {
    latency = await measurePing();
  } catch (error) {
    errorReason = error.name === "AbortError" ? "Timeout over 5 seconds" : error.message;
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
    accuracy: coords?.accuracy ?? null, thresholdMs: sampleThreshold, deadZone,
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
  timer = setTimeout(async () => { await takeSample(); scheduleNextSample(); }, 1000);
}

function drawChart() {
  const canvas = els.chart;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return;
  const dpr = window.devicePixelRatio || 1;
  const width = Math.round(rect.width * dpr), height = Math.round(rect.height * dpr);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  ctx.save(); ctx.scale(dpr, dpr);
  const w = rect.width, h = rect.height;
  const pad = { left: 42, right: 10, top: 14, bottom: 25 };
  const plotW = Math.max(1, w - pad.left - pad.right), plotH = Math.max(1, h - pad.top - pad.bottom);
  const now = Date.now(), start = now - chartWindow * 1000;
  const visible = samples.filter((s) => Date.parse(s.timestamp) >= start);
  const threshold = thresholdValue();
  const latencies = visible.filter((s) => s.latency != null).map((s) => s.latency);
  const max = Math.max(threshold * 1.2, ...(latencies.length ? latencies : [0])) * 1.1;
  const x = (time) => pad.left + Math.max(0, Math.min(1, (time - start) / (chartWindow * 1000))) * plotW;
  const y = (value) => pad.top + plotH - Math.max(0, Math.min(1, value / max)) * plotH;
  ctx.font = "11px system-ui, sans-serif";
  ctx.strokeStyle = "#293a55"; ctx.lineWidth = 1; ctx.fillStyle = "#9eacc0";
  for (let i = 0; i <= 3; i++) {
    const value = Math.round((max * i) / 3), yy = y(value);
    ctx.beginPath(); ctx.moveTo(pad.left, yy); ctx.lineTo(w - pad.right, yy); ctx.stroke(); ctx.fillText(`${value} ms`, 2, yy + 4);
  }
  ctx.setLineDash([5, 4]); ctx.strokeStyle = "#ff7474aa";
  ctx.beginPath(); ctx.moveTo(pad.left, y(threshold)); ctx.lineTo(w - pad.right, y(threshold)); ctx.stroke(); ctx.setLineDash([]);
  if (!visible.length) {
    ctx.fillStyle = "#9eacc0"; ctx.fillText("Start the test to see latency", pad.left + 8, pad.top + plotH / 2);
    ctx.restore(); return;
  }
  ctx.strokeStyle = "#55a9ff"; ctx.lineWidth = 2; ctx.beginPath();
  visible.forEach((s, i) => { const xx = x(Date.parse(s.timestamp)), yy = y(s.latency == null ? threshold : s.latency); if (i === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy); });
  ctx.stroke();
  visible.forEach((s) => {
    if (!s.deadZone) return;
    ctx.fillStyle = "#ff7474"; ctx.beginPath(); ctx.arc(x(Date.parse(s.timestamp)), y(s.latency == null ? threshold : s.latency), 4, 0, Math.PI * 2); ctx.fill();
  });
  ctx.fillStyle = "#9eacc0"; ctx.fillText(`${chartWindow < 60 ? chartWindow + "s" : chartWindow / 60 + "m"} window`, pad.left, h - 6);
  ctx.restore();
}

function start() {
  if (running) return;
  running = true; els.start.disabled = true; els.stop.disabled = false;
  setState("Testing", "running");
  if (!navigator.geolocation) locationError({ code: 2 });
  else watchId = navigator.geolocation.watchPosition(updateLocation, locationError, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  takeSample(); scheduleNextSample();
}

function stop() {
  running = false; clearTimeout(timer); timer = null;
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null; els.start.disabled = false; els.stop.disabled = true; setState("Paused", "idle");
}

function exportCsv() {
  const header = "timestamp,device,latency_ms,dead_zone,threshold_ms,failure_reason,latitude,longitude,gps_accuracy_m\n";
  const rows = samples.map((s) => [s.timestamp, s.device, s.latency ?? "", s.deadZone, s.thresholdMs, s.failureReason, s.latitude ?? "", s.longitude ?? "", s.accuracy ?? ""]
    .map((v) => `"${String(v).replaceAll('"', '""')}"`).join(","));
  const blob = new Blob(["\ufeff", header, rows.join("\n")], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob);
  link.download = `pingmap-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}.csv`; link.click(); URL.revokeObjectURL(link.href);
}

els.start.addEventListener("click", start);
els.stop.addEventListener("click", stop);
els.export.addEventListener("click", exportCsv);
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
window.addEventListener("resize", drawChart);
window.addEventListener("online", () => { updateNetworkInfo(navigator.connection || {}); if (running) setState("Testing", "running"); });
window.addEventListener("offline", () => setState("Offline", "error"));

detectDeviceAndNetwork();
drawChart();
