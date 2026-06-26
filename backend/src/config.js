import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const BACKEND_DIR = path.resolve(__dirname, "..");
export const PROJECT_ROOT = path.resolve(BACKEND_DIR, "..");
export const DATA_PATH = path.join(PROJECT_ROOT, "data", "crime_records.json");
export const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");
export const AUDIT_PATH = process.env.AUDIT_PATH
  ? path.resolve(BACKEND_DIR, process.env.AUDIT_PATH)
  : path.join(PROJECT_ROOT, "data", "audit_log_node.jsonl");

export const HOST = process.env.HOST || "127.0.0.1";
export const PORT = Number(process.env.PORT || 8000);

export const SEVERITY_POINTS = {
  Low: 1,
  Medium: 2,
  High: 4,
  Critical: 7,
};

export const DEMO_USERS = {
  investigator: {
    badge_id: "KSP-INV-0142",
    name: "Inspector Asha Rao",
    role: "investigator",
    district_scope: ["Bengaluru City", "Mysuru", "Mangaluru", "Tumakuru"],
    permissions: ["chat", "analytics", "network", "agent", "copilot", "linkage", "export"],
  },
  analyst: {
    badge_id: "SCRB-ANL-0021",
    name: "Crime Analyst R. Menon",
    role: "analyst",
    district_scope: ["statewide"],
    permissions: ["chat", "analytics", "agent", "copilot", "linkage", "export"],
  },
  supervisor: {
    badge_id: "SCRB-SUP-0007",
    name: "DySP Kavitha Shetty",
    role: "supervisor",
    district_scope: ["statewide"],
    permissions: ["chat", "analytics", "network", "agent", "copilot", "linkage", "audit", "export"],
  },
};

export const CRIME_ALIASES = {
  theft: "Theft",
  "vehicle theft": "Vehicle Theft",
  "bike theft": "Vehicle Theft",
  burglary: "Burglary",
  robbery: "Robbery",
  chain: "Chain Snatching",
  snatching: "Chain Snatching",
  cyber: "Cyber Fraud",
  fraud: "Cyber Fraud",
  upi: "Cyber Fraud",
  narcotic: "Narcotics",
  ndps: "Narcotics",
  assault: "Assault",
  murder: "Murder",
  homicide: "Murder",
  missing: "Missing Person",
  kidnap: "Kidnapping",
  kidnapping: "Kidnapping",
};
