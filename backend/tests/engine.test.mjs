import test from "node:test";
import assert from "node:assert/strict";
import { DEMO_USERS } from "../src/config.js";
import { loadRecords } from "../src/dataStore.js";
import { buildAnalytics } from "../src/analytics.js";
import { buildAgentBrief, buildInvestigationCopilot } from "../src/intelligence.js";
import { processChat } from "../src/chat.js";
import { renderExportHtml, renderIntelligenceReportHtml } from "../src/reports.js";

test("investigator analytics match frontend contract", () => {
  const records = loadRecords();
  const user = DEMO_USERS.investigator;
  const analytics = buildAnalytics(records, user);
  assert.equal(analytics.record_count, 16);
  assert.ok(analytics.hotspots.length > 0);
  assert.ok(analytics.trends.length > 0);
  assert.ok(analytics.case_linkage.graph.nodes.length > 0);
});

test("copilot and agent produce proactive investigation output", () => {
  const records = loadRecords();
  const user = DEMO_USERS.investigator;
  const copilot = buildInvestigationCopilot(records, user);
  const agent = buildAgentBrief(records, user);
  assert.equal(copilot.name, "AI Investigation Copilot");
  assert.ok(copilot.suspect_leads.length > 0);
  assert.ok(copilot.proactive_insights.length > 0);
  assert.equal(agent.name, "Investigator Agent");
  assert.ok(agent.action_queue.length > 0);
});

test("chat routes copilot and linkage intents", () => {
  const records = loadRecords();
  const user = DEMO_USERS.investigator;
  const copilot = processChat({ message: "Copilot suggest suspects and anomalies", user, records });
  const linkage = processChat({ message: "Run case linkage engine for hidden relationships", user, records });
  assert.equal(copilot.intent, "copilot");
  assert.equal(linkage.intent, "linkage");
  assert.ok(copilot.copilot);
  assert.ok(linkage.analytics_patch.case_linkage.clusters.length > 0);
});

test("reports render printable HTML", () => {
  const records = loadRecords();
  const user = DEMO_USERS.investigator;
  const exportHtml = renderExportHtml([{ role: "user", content: "Show hotspots" }], user);
  const reportHtml = renderIntelligenceReportHtml(records, user);
  assert.match(exportHtml, /Conversation Export/);
  assert.match(reportHtml, /AI Intelligence Report/);
});
