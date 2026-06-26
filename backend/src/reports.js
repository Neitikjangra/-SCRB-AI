import { buildAnalytics } from "./analytics.js";
import { buildAgentBrief, buildInvestigationCopilot } from "./intelligence.js";
import { userScopedRecords } from "./dataStore.js";
import { escapeHtml, utcNow } from "./utils.js";

export function renderExportHtml(conversation, user) {
  const rows = (conversation || [])
    .map((item) => {
      const role = escapeHtml(String(item.role || "message").replace(/^\w/, (char) => char.toUpperCase()));
      const content = escapeHtml(item.content || "");
      return `<section><h2>${role}</h2><p>${content}</p></section>`;
    })
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>KSP SCRB Conversation Export</title>
  <style>
    body { font-family: Arial, sans-serif; color: #17201d; line-height: 1.5; margin: 36px; }
    header { border-bottom: 3px solid #17634f; margin-bottom: 24px; padding-bottom: 12px; }
    h1 { font-size: 22px; margin: 0 0 4px; }
    h2 { color: #17634f; font-size: 14px; margin-bottom: 4px; }
    section { break-inside: avoid; border-bottom: 1px solid #d7ddd8; padding: 12px 0; }
    .meta { color: #59645f; font-size: 12px; }
  </style>
</head>
<body>
  <header>
    <h1>KSP SCRB Conversational Intelligence Transcript</h1>
    <div class="meta">Generated ${escapeHtml(utcNow())} for ${escapeHtml(user.name)} (${escapeHtml(user.badge_id)})</div>
    <div class="meta">Demo prototype using synthetic data. Validate all leads against approved SCRB systems.</div>
  </header>
  ${rows || "<section><h2>No conversation</h2><p>No messages were provided for export.</p></section>"}
</body>
</html>`;
}

export function renderIntelligenceReportHtml(records, user) {
  const scoped = userScopedRecords(records, user);
  const analytics = buildAnalytics(records, user);
  const copilot = buildInvestigationCopilot(scoped, user, "report_generation", true);
  const agent = buildAgentBrief(scoped, user, "report_generation", true);
  const cluster = analytics.case_linkage.clusters[0];
  const hotspotRows = analytics.hotspots
    .slice(0, 5)
    .map((item) => `<tr><td>${escapeHtml(item.police_station)}</td><td>${escapeHtml(item.district)}</td><td>${item.cases}</td><td>${item.open_cases}</td><td>${item.score}</td><td>${escapeHtml(item.top_crime)}</td></tr>`)
    .join("");
  const actionRows = agent.action_queue
    .slice(0, 6)
    .map((item) => `<li><strong>${escapeHtml(item.priority)} ${escapeHtml(item.title)}</strong><br>${escapeHtml(item.rationale)}<br><em>${escapeHtml(item.next_step)}</em></li>`)
    .join("");
  const suspectRows = copilot.suspect_leads
    .slice(0, 5)
    .map((item) => `<li><strong>${escapeHtml(item.name)}</strong> - score ${item.score}; ${escapeHtml(item.reasons.slice(0, 3).join("; "))}</li>`)
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>KSP SCRB AI Intelligence Report</title>
  <style>
    body { font-family: Arial, sans-serif; color: #14211e; margin: 36px; line-height: 1.5; }
    header { border-bottom: 4px solid #155c48; padding-bottom: 16px; margin-bottom: 22px; }
    h1 { margin: 0 0 6px; font-size: 26px; }
    h2 { color: #155c48; margin-top: 28px; }
    table { border-collapse: collapse; width: 100%; margin: 12px 0; }
    th, td { border: 1px solid #cfd9d5; padding: 8px; text-align: left; font-size: 12px; }
    th { background: #eef6f2; }
    .meta, em { color: #5d6b66; }
    .notice { background: #fff8e6; border: 1px solid #f0cd74; padding: 12px; }
    li { margin-bottom: 10px; }
  </style>
</head>
<body>
  <header>
    <h1>KSP SCRB AI Intelligence Report</h1>
    <div class="meta">Generated ${escapeHtml(utcNow())} for ${escapeHtml(user.name)} (${escapeHtml(user.badge_id)})</div>
    <div class="meta">Scope: ${escapeHtml(user.district_scope.join(", "))}; Records reviewed: ${scoped.length}</div>
  </header>
  <p class="notice">Synthetic demonstration data only. This report is an investigative aid, not probable cause or an enforcement decision.</p>
  <h2>Executive Intelligence Summary</h2>
  <p>${escapeHtml(copilot.intelligence_summary)}</p>
  <h2>Priority Hotspots</h2>
  <table>
    <thead><tr><th>Station</th><th>District</th><th>Cases</th><th>Open</th><th>Score</th><th>Top Crime</th></tr></thead>
    <tbody>${hotspotRows}</tbody>
  </table>
  <h2>Suggested Suspect Leads</h2>
  <ul>${suspectRows || "<li>No suspect lead exceeded threshold.</li>"}</ul>
  <h2>Investigator Agent Actions</h2>
  <ol>${actionRows || "<li>No action exceeded threshold.</li>"}</ol>
  <h2>Case Linkage</h2>
  <p>${cluster ? `${escapeHtml(cluster.cluster_id)} contains ${cluster.case_count} cases at ${cluster.confidence}% confidence. ${escapeHtml(cluster.proactive_lead)}` : "No high-confidence linked cluster found."}</p>
  <h2>Explainability</h2>
  <ul>
    <li>Role scope filter was applied before analysis.</li>
    <li>Hotspots use case count, severity, open status, and recency.</li>
    <li>Case linkage compares method, location, time, victim, suspect, vehicle, and communication dimensions.</li>
    <li>Human verification is required before operational action.</li>
  </ul>
</body>
</html>`;
}
