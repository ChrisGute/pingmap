/* PingMap: dependency-free measurement logic, with Leaflet used only for the map. */
const $ = (id) => document.getElementById(id);
const els = {
  name: $("deviceName"), url: $("pingUrl"), state: $("runState"), start: $("startBtn"), stop: $("stopBtn"),
  export: $("exportBtn"), clear: $("clearBtn"), latency: $("latency"), latencyStatus: $("latencyStatus"),
  latitude: $("latitude"), longitude: $("longitude"), accuracy: $("accuracy"), gpsStatus: $("gpsStatus"),
  count: $("sampleCount"), lastSample: $("lastSample"), log: $("log"), maps: $("mapsLink")
};

let running = false;
let timer = null;
let watchId = null;
let currentPosition = null;
let samples = [];
let map = null;
let marker = null;

function setState(text, type = "idle") {
  els.state.textContent = text;
  els.state.className = `state ${type}`;
}

function initMap() {
  if (!window.L || map) return;
  map = L.map("map", { zoomControl: false }).setView([39.8283, -98.5795], 4);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);
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
  setState(messages[error.code] || "Location error", "error");
}

function drawLog() {
  if (!samples.length) {
    els.log.innerHTML = '<p class="empty">Your readings will appear here.</p>';
    return;
  }
  els.log.innerHTML = samples.slice(-12).reverse().map((s) => {
    const time = new Date(s.timestamp).toLocaleTimeString();
    const place = s.latitude == null ? "No GPS fix" : `${s.latitude.toFixed(5)}, ${s.longitude.toFixed(5)}`;
    const result = s.latency == null ? "FAILED" : `${s.latency} ms`;
    return `<div class="reading"><span class="reading-time">${time}</span><span class="reading-main">${place}</span><span class="${s.latency == null ? "reading-fail" : "reading-ok"}">${result}</span></div>`;
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
  let latency = null;
  try {
    latency = await measurePing();
    els.latency.textContent = `${latency} ms`;
    els.latencyStatus.textContent = "HTTP round-trip";
  } catch (error) {
    els.latency.textContent = "Timeout";
    els.latencyStatus.textContent = error.name === "AbortError" ? "Over 5 seconds" : error.message;
  }
  const coords = currentPosition?.coords;
  samples.push({
    timestamp, device: els.name.value.trim() || "Unlabeled",
    latency, latitude: coords?.latitude ?? null, longitude: coords?.longitude ?? null,
    accuracy: coords?.accuracy ?? null
  });
  els.count.textContent = samples.length;
  els.lastSample.textContent = `Last: ${new Date(timestamp).toLocaleTimeString()}`;
  els.export.disabled = false;
  els.clear.disabled = false;
  drawLog();
}

function scheduleNextSample() {
  if (!running) return;
  timer = setTimeout(async () => { await takeSample(); scheduleNextSample(); }, 1000);
}

function start() {
  if (running) return;
  running = true;
  els.start.disabled = true; els.stop.disabled = false;
  setState("Testing", "running");
  if (!navigator.geolocation) { locationError({ code: 2 }); }
  else watchId = navigator.geolocation.watchPosition(updateLocation, locationError, {
    enableHighAccuracy: true, maximumAge: 0, timeout: 15000
  });
  takeSample();
  scheduleNextSample();
}

function stop() {
  running = false;
  clearTimeout(timer); timer = null;
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  els.start.disabled = false; els.stop.disabled = true;
  setState("Paused", "idle");
}

function exportCsv() {
  const header = "timestamp,device,latency_ms,latitude,longitude,gps_accuracy_m\n";
  const rows = samples.map((s) => [s.timestamp, s.device, s.latency ?? "", s.latitude ?? "", s.longitude ?? "", s.accuracy ?? ""]
    .map((v) => `"${String(v).replaceAll('"', '""')}"`).join(","));
  const blob = new Blob(["\ufeff", header, rows.join("\n")], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob); link.download = `pingmap-${new Date().toISOString().slice(0, 19).replaceAll(":", "-")}.csv`;
  link.click(); URL.revokeObjectURL(link.href);
}

els.start.addEventListener("click", start);
els.stop.addEventListener("click", stop);
els.export.addEventListener("click", exportCsv);
els.clear.addEventListener("click", () => { samples = []; els.count.textContent = "0"; els.lastSample.textContent = "Nothing recorded"; els.export.disabled = true; els.clear.disabled = true; drawLog(); });
window.addEventListener("online", () => { if (running) setState("Testing", "running"); });
window.addEventListener("offline", () => setState("Offline", "error"));
