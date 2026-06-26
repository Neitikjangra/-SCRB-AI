import { SEVERITY_POINTS } from "./config.js";

export function utcNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

export function monthKey(record) {
  return String(record.date || "").slice(0, 7);
}

export function ageBand(age) {
  if (age == null) return "Unknown";
  if (age < 18) return "Under 18";
  if (age <= 25) return "18-25";
  if (age <= 40) return "26-40";
  if (age <= 60) return "41-60";
  return "60+";
}

export function severityValue(record) {
  return SEVERITY_POINTS[record.severity] || 1;
}

export function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function increment(map, key, by = 1) {
  map.set(key, (map.get(key) || 0) + by);
}

export function sortedEntries(mapOrObject) {
  const entries = mapOrObject instanceof Map ? [...mapOrObject.entries()] : Object.entries(mapOrObject || {});
  return entries.sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

export function counterObject(mapOrObject, limit = Infinity) {
  return Object.fromEntries(sortedEntries(mapOrObject).slice(0, limit));
}

export function topItems(mapOrObject, limit = 3) {
  const items = sortedEntries(mapOrObject).slice(0, limit);
  return items.length ? items.map(([name, count]) => `${name} (${count})`).join(", ") : "none";
}

export function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

export function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function maskedLabel(name, lookup) {
  if (!lookup.has(name)) {
    lookup.set(name, `Person ${lookup.size + 1}`);
  }
  return lookup.get(name);
}

export function isKannada(text) {
  return /[\u0c80-\u0cff]/.test(String(text || ""));
}

export function randomId(prefix) {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const suffix = Math.random().toString(16).slice(2, 8).toUpperCase();
  return `${prefix}-${stamp}-${suffix}`;
}

export function haversineKm(first, second) {
  const toRad = (value) => (Number(value) * Math.PI) / 180;
  const lat1 = toRad(first.latitude);
  const lon1 = toRad(first.longitude);
  const lat2 = toRad(second.latitude);
  const lon2 = toRad(second.longitude);
  const dLat = lat2 - lat1;
  const dLon = lon2 - lon1;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
