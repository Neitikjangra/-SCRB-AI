import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { AUDIT_PATH, DATA_PATH, DEMO_USERS } from "./config.js";

const sessions = new Map();

export function loadRecords() {
  const payload = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  return payload.records || [];
}

export function publicUser(user) {
  return {
    badge_id: user.badge_id,
    name: user.name,
    role: user.role,
    district_scope: user.district_scope,
    permissions: user.permissions,
  };
}

export function createSession(profile) {
  const demoUser = DEMO_USERS[profile];
  if (!demoUser) return null;
  const token = randomBytes(32).toString("base64url");
  const user = structuredClone(demoUser);
  sessions.set(token, user);
  return { token, user: publicUser(user) };
}

export function getSession(token) {
  return sessions.get(token) || null;
}

export function appendAudit(entry) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
    fs.appendFileSync(AUDIT_PATH, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Local demo should keep responding even when the audit file is locked.
  }
}

export function recentAudit(limit = 25) {
  try {
    if (!fs.existsSync(AUDIT_PATH)) return [];
    return fs
      .readFileSync(AUDIT_PATH, "utf8")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-limit)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

export function userScopedRecords(records, user) {
  const scope = user?.district_scope || [];
  if (scope.includes("statewide")) return records;
  return records.filter((record) => scope.includes(record.district));
}
