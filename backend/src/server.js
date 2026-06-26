import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOST, PORT, PUBLIC_DIR } from "./config.js";
import { aggregateCaseLinkages, buildAnalytics } from "./analytics.js";
import { appendAudit, createSession, getSession, loadRecords, publicUser, recentAudit, userScopedRecords } from "./dataStore.js";
import { buildAgentBrief, buildInvestigationCopilot } from "./intelligence.js";
import { processChat } from "./chat.js";
import { renderExportHtml, renderIntelligenceReportHtml } from "./reports.js";
import { randomId, utcNow } from "./utils.js";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

function sendJson(res, payload, status = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(body);
}

function sendError(res, message, status = 500) {
  sendJson(res, { error: message }, status);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function authenticatedUser(req) {
  const header = req.headers.authorization || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  return token ? getSession(token) : null;
}

function analyticsWithBriefs(records, user) {
  const scoped = userScopedRecords(records, user);
  const analytics = buildAnalytics(records, user);
  return {
    ...analytics,
    agent_brief: buildAgentBrief(scoped, user, "analytics_snapshot", true),
    copilot_brief: buildInvestigationCopilot(scoped, user, "analytics_snapshot", true),
  };
}

async function handleApi(req, res, url) {
  if (req.method === "OPTIONS") {
    sendJson(res, {});
    return;
  }

  const records = loadRecords();
  const pathName = url.pathname;

  if (req.method === "GET" && pathName === "/api/health") {
    sendJson(res, { status: "ok", timestamp: utcNow(), runtime: "node" });
    return;
  }

  if (req.method === "GET" && pathName === "/api/summary") {
    const openCases = records.filter((record) => record.status !== "Chargesheeted").length;
    sendJson(res, {
      generated_at: utcNow(),
      runtime: "node",
      record_count: records.length,
      open_cases: openCases,
      synthetic: true,
    });
    return;
  }

  if (req.method === "POST" && pathName === "/api/auth/login") {
    const body = await readJson(req);
    const session = createSession(body.profile);
    if (!session) {
      sendError(res, "unknown demo profile", 401);
      return;
    }
    sendJson(res, session);
    return;
  }

  const user = authenticatedUser(req);
  if (!user) {
    sendError(res, "authorization required", 401);
    return;
  }

  if (req.method === "GET" && pathName === "/api/analytics") {
    if (!user.permissions.includes("analytics")) {
      sendError(res, "analytics permission required", 403);
      return;
    }
    sendJson(res, analyticsWithBriefs(records, user));
    return;
  }

  if (req.method === "GET" && pathName === "/api/linkage") {
    if (!user.permissions.includes("linkage")) {
      sendError(res, "linkage permission required", 403);
      return;
    }
    sendJson(res, aggregateCaseLinkages(userScopedRecords(records, user), user.role === "analyst"));
    return;
  }

  if (req.method === "GET" && pathName === "/api/audit") {
    if (!user.permissions.includes("audit")) {
      sendError(res, "audit permission required", 403);
      return;
    }
    sendJson(res, { events: recentAudit() });
    return;
  }

  if (req.method === "POST" && pathName === "/api/chat") {
    if (!user.permissions.includes("chat")) {
      sendError(res, "chat permission required", 403);
      return;
    }
    const body = await readJson(req);
    const message = String(body.message || "").trim();
    if (!message) {
      sendError(res, "message is required", 400);
      return;
    }
    sendJson(
      res,
      processChat({
        message,
        user,
        records,
        conversation: body.conversation || [],
        language: body.language || "en",
      })
    );
    return;
  }

  if (req.method === "POST" && pathName === "/api/agent/run") {
    if (!user.permissions.includes("agent")) {
      sendError(res, "agent permission required", 403);
      return;
    }
    const body = await readJson(req);
    const objective = String(body.objective || "operational_triage").trim() || "operational_triage";
    const brief = buildAgentBrief(records, user, objective);
    const audit = {
      audit_id: randomId("AGT-AUD"),
      timestamp: utcNow(),
      actor: user.badge_id,
      role: user.role,
      intent: "agent_brief",
      filters: { scope: user.district_scope, objective },
      records_considered: brief.records_considered,
      records_returned: brief.action_queue.length,
      model_route: "node-deterministic-agent-orchestrator",
      guardrails: brief.guardrails,
    };
    appendAudit({ ...audit, run_id: brief.run_id });
    sendJson(res, { ...brief, audit });
    return;
  }

  if (req.method === "POST" && pathName === "/api/copilot/brief") {
    if (!user.permissions.includes("copilot")) {
      sendError(res, "copilot permission required", 403);
      return;
    }
    const body = await readJson(req);
    const objective = String(body.objective || "proactive_intelligence_watch").trim() || "proactive_intelligence_watch";
    const brief = buildInvestigationCopilot(records, user, objective);
    const audit = {
      audit_id: randomId("COP-AUD"),
      timestamp: utcNow(),
      actor: user.badge_id,
      role: user.role,
      intent: "copilot_brief",
      filters: { scope: user.district_scope, objective },
      records_considered: brief.records_considered,
      records_returned: brief.proactive_insights.length,
      model_route: "node-deterministic-investigation-copilot",
      guardrails: brief.guardrails,
    };
    appendAudit({ ...audit, run_id: brief.run_id });
    sendJson(res, { ...brief, audit });
    return;
  }

  if (req.method === "POST" && pathName === "/api/report") {
    if (!user.permissions.includes("export")) {
      sendError(res, "export permission required", 403);
      return;
    }
    const auditId = randomId("REP");
    appendAudit({
      audit_id: auditId,
      timestamp: utcNow(),
      actor: user.badge_id,
      role: user.role,
      intent: "intelligence_report",
      filters: { report: "node_investigation_intelligence_report" },
      records_considered: userScopedRecords(records, user).length,
      records_returned: 1,
      model_route: "node-report-renderer",
      guardrails: ["export_permission", "synthetic_data_notice", "print_pdf_user_action"],
    });
    sendJson(res, {
      audit_id: auditId,
      filename: `ksp-scrb-ai-intelligence-report-${auditId}.html`,
      html: renderIntelligenceReportHtml(records, user),
    });
    return;
  }

  if (req.method === "POST" && pathName === "/api/export") {
    if (!user.permissions.includes("export")) {
      sendError(res, "export permission required", 403);
      return;
    }
    const body = await readJson(req);
    const conversation = body.conversation || [];
    const auditId = randomId("EXP");
    appendAudit({
      audit_id: auditId,
      timestamp: utcNow(),
      actor: user.badge_id,
      role: user.role,
      intent: "export",
      records_considered: 0,
      records_returned: conversation.length,
      model_route: "node-export-renderer",
      guardrails: ["export_permission", "print_pdf_user_action"],
    });
    sendJson(res, {
      audit_id: auditId,
      filename: `ksp-scrb-transcript-${auditId}.html`,
      html: renderExportHtml(conversation, user),
    });
    return;
  }

  sendError(res, "not found", 404);
}

function serveStatic(req, res, url) {
  let relativePath = decodeURIComponent(url.pathname);
  if (relativePath === "/") relativePath = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, relativePath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendError(res, "forbidden", 403);
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendError(res, "not found", 404);
      return;
    }
    const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": data.length,
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
}

export function createAppServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url);
        return;
      }
      if (req.method !== "GET") {
        sendError(res, "method not allowed", 405);
        return;
      }
      serveStatic(req, res, url);
    } catch (error) {
      sendError(res, error.message || "server error", /JSON|large/.test(error.message || "") ? 400 : 500);
    }
  });
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const server = createAppServer();
  server.listen(PORT, HOST, () => {
    console.log(`SCRB Node backend running at http://${HOST}:${PORT}`);
  });
}
