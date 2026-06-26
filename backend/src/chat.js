import { CRIME_ALIASES } from "./config.js";
import { aggregateBehaviorProfiles, aggregateCaseLinkages, aggregateDemographics, aggregateHotspots, aggregateTrends, aggregateWarnings, buildAnalytics } from "./analytics.js";
import { appendAudit, userScopedRecords } from "./dataStore.js";
import { buildAgentBrief, buildInvestigationCopilot } from "./intelligence.js";
import { isKannada, randomId, topItems, utcNow } from "./utils.js";

export function detectIntent(message) {
  const text = String(message || "").toLowerCase();
  if (/(copilot|suspect|anomal|deployment|resource|intelligence summary|reasoning)/.test(text)) return "copilot";
  if (/(agent|triage|next action|action queue|investigative action)/.test(text)) return "agent";
  if (/(linkage|linked case|case cluster|hidden relationship|relationship|same offender)/.test(text)) return "linkage";
  if (/(hotspot|where|area|station|place|location)/.test(text)) return "hotspot";
  if (/(network|associate|gang|repeat person|connections?)/.test(text)) return "network";
  if (/(trend|month|increase|decrease|pattern over time)/.test(text)) return "trend";
  if (/(predict|warning|early warning|prevent|risk)/.test(text)) return "prediction";
  if (/(demographic|age|gender|socio)/.test(text)) return "demographic";
  if (/(behavior|behaviour|profile|modus|operandi)/.test(text)) return "behavior";
  return "summary";
}

export function deriveFilters(message, records, conversation = []) {
  const text = String(message || "").toLowerCase();
  const history = conversation
    .slice(-6)
    .map((item) => item.content || "")
    .join(" ")
    .toLowerCase();
  const contextualText = /(same|there|that)/.test(text) ? `${text} ${history}` : text;
  const filters = {};
  for (const record of records) {
    if (contextualText.includes(String(record.district).toLowerCase())) filters.district = record.district;
    if (contextualText.includes(String(record.police_station).toLowerCase())) filters.police_station = record.police_station;
    if (contextualText.includes(String(record.beat).toLowerCase())) filters.beat = record.beat;
  }
  for (const [alias, crimeType] of Object.entries(CRIME_ALIASES)) {
    if (contextualText.includes(alias)) filters.crime_type = crimeType;
  }
  const monthMatch = contextualText.match(/\b(2026-\d{2})\b/);
  if (monthMatch) filters.month = monthMatch[1];
  if (/(open|pending|under investigation)/.test(contextualText)) filters.status = "open";
  if (/(closed|chargesheeted|charge sheeted)/.test(contextualText)) filters.status = "Chargesheeted";
  return filters;
}

export function applyFilters(records, filters) {
  return records.filter((record) => {
    if (filters.district && record.district !== filters.district) return false;
    if (filters.police_station && record.police_station !== filters.police_station) return false;
    if (filters.beat && record.beat !== filters.beat) return false;
    if (filters.crime_type && record.crime_type !== filters.crime_type) return false;
    if (filters.month && !record.date.startsWith(filters.month)) return false;
    if (filters.status === "open" && record.status === "Chargesheeted") return false;
    if (filters.status === "Chargesheeted" && record.status !== "Chargesheeted") return false;
    return true;
  });
}

export function formatSources(records, limit = 5) {
  return [...records]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit)
    .map((record) => ({
      case_id: record.id,
      date: record.date,
      district: record.district,
      police_station: record.police_station,
      crime_type: record.crime_type,
      status: record.status,
    }));
}

function composeEnglish(intent, filtered, filters, user) {
  if (!filtered.length) {
    return "I did not find matching synthetic records inside your permitted scope. Try removing one filter or asking for statewide trends if your role allows it.";
  }
  const crimeMix = {};
  const districtMix = {};
  for (const record of filtered) {
    crimeMix[record.crime_type] = (crimeMix[record.crime_type] || 0) + 1;
    districtMix[record.district] = (districtMix[record.district] || 0) + 1;
  }
  const openCases = filtered.filter((record) => record.status !== "Chargesheeted").length;
  if (intent === "hotspot") {
    const lines = aggregateHotspots(filtered)
      .slice(0, 3)
      .map((item) => `${item.police_station} in ${item.district} scores ${item.score} with ${item.cases} cases; top pattern: ${item.top_crime}.`);
    return `I found ${filtered.length} matching records and ${openCases} open cases. Priority hotspots: ${lines.join(" ")} Suggested action: align beat deployment with the top station and review cases tagged with ${topItems(crimeMix, 2)}.`;
  }
  if (intent === "network") {
    if (!user.permissions.includes("network")) {
      return `Your role can view aggregate network risk but not named suspect linkages. Strong aggregate patterns involve ${topItems(crimeMix, 2)} across ${topItems(districtMix, 2)}.`;
    }
    return `Network scan across ${filtered.length} records highlights repeat links around ${topItems(crimeMix, 3)}. Treat this as an investigative lead and verify identity, call-detail records, custody history, and case merges before action.`;
  }
  if (intent === "linkage") {
    const linkage = aggregateCaseLinkages(filtered, user.role === "analyst");
    const topCluster = linkage.clusters[0];
    if (!topCluster) return "The Case Linkage Engine did not find a high-confidence cluster in the current scope.";
    const link = topCluster.supporting_links[0];
    const evidence = link.evidence.slice(0, 4).map((item) => item.detail).join(" ");
    return `Case Linkage Engine found ${linkage.clusters.length} linked case clusters. Top cluster ${topCluster.cluster_id} contains ${topCluster.case_count} cases at ${topCluster.confidence}% confidence. Strongest pair: ${link.source} to ${link.target} at ${link.confidence}%. Evidence: ${evidence}`;
  }
  if (intent === "trend") {
    const trends = aggregateTrends(filtered);
    const first = trends[0] || { month: "n/a", total: 0 };
    const last = trends.at(-1) || { month: "n/a", total: 0 };
    const direction = last.total > first.total ? "increased" : last.total < first.total ? "decreased" : "remained steady";
    return `From ${first.month} to ${last.month}, matching cases ${direction} from ${first.total} to ${last.total}. Dominant crime types are ${topItems(crimeMix, 3)}.`;
  }
  if (intent === "prediction") {
    const warningText = aggregateWarnings(filtered)
      .slice(0, 3)
      .map((warning) => `${warning.area} has ${warning.confidence}% early-warning confidence for ${warning.risk}.`)
      .join(" ");
    return `Early-warning model found priority signals. ${warningText} Review open FIR clusters, recent beat reports, and repeat-accused links before issuing an operational alert.`;
  }
  if (intent === "behavior") {
    const profileText = aggregateBehaviorProfiles(filtered, user.role === "analyst")
      .slice(0, 3)
      .map((profile) => `${profile.crime_type}: ${profile.cases} cases, ${profile.open_cases} open; ${profile.behavior_signal}`)
      .join(" ");
    return `Behavioral profiling found priority crime-behavior profiles. ${profileText}`;
  }
  if (intent === "agent") {
    const brief = buildAgentBrief(filtered, user, "chat_requested_triage", true);
    const firstAction = brief.action_queue[0];
    return `${brief.name} is ready. ${brief.mission_brief} First action: ${firstAction.priority} ${firstAction.title}. Rationale: ${firstAction.rationale}`;
  }
  if (intent === "copilot") {
    const brief = buildInvestigationCopilot(filtered, user, "chat_requested_copilot", true);
    const suspect = brief.suspect_leads[0];
    const anomaly = brief.anomalies[0];
    const relationship = brief.hidden_relationships[0];
    return `${brief.name} generated a proactive intelligence brief. ${brief.intelligence_summary} Top lead: ${suspect?.name || "none"}. Hidden relationship: ${relationship?.title || "none"}. Anomaly: ${anomaly?.title || "none"}. Treat these as investigative leads only.`;
  }
  if (intent === "demographic") {
    const demographics = aggregateDemographics(filtered);
    return `Victim age bands: ${topItems(demographics.victim_age, 4)}. Victim gender split: ${topItems(demographics.victim_gender, 3)}. Socio-economic tags: ${topItems(demographics.socioeconomic, 3)}.`;
  }
  const filterText = Object.keys(filters).length ? Object.entries(filters).map(([key, value]) => `${key}: ${value}`).join(", ") : "your permitted data scope";
  return `For ${filterText}, I found ${filtered.length} synthetic records, ${openCases} open cases, and the leading patterns are ${topItems(crimeMix, 3)}. Ask for hotspots, network links, trends, or early warnings for a deeper view.`;
}

function composeKannada(intent, filtered, filters, user) {
  const english = composeEnglish(intent, filtered, filters, user);
  return `Kannada mode summary: ${english}`;
}

export function processChat({ message, user, records, conversation = [], language = "en" }) {
  const scopedRecords = userScopedRecords(records, user);
  const filters = deriveFilters(message, scopedRecords, conversation);
  const filtered = applyFilters(scopedRecords, filters);
  const intent = detectIntent(message);
  const lang = language === "kn" || isKannada(message) ? "kn" : "en";
  const answer = lang === "kn" ? composeKannada(intent, filtered, filters, user) : composeEnglish(intent, filtered, filters, user);
  const agent = intent === "agent" ? buildAgentBrief(filtered, user, "chat_requested_triage", true) : null;
  const copilot = intent === "copilot" ? buildInvestigationCopilot(filtered, user, "chat_requested_copilot", true) : null;
  const audit = {
    audit_id: randomId("AUD"),
    timestamp: utcNow(),
    actor: user.badge_id,
    role: user.role,
    intent,
    filters,
    records_considered: scopedRecords.length,
    records_returned: filtered.length,
    model_route: "node-deterministic-investigation-engine",
    guardrails: ["role_scope_filter", "synthetic_data_notice", "human_verification_required"],
  };
  appendAudit({ ...audit, message });
  return {
    answer,
    intent,
    filters,
    sources: formatSources(filtered),
    audit,
    agent,
    copilot,
    analytics_patch: {
      hotspots: aggregateHotspots(filtered).slice(0, 5),
      trends: aggregateTrends(filtered),
      warnings: aggregateWarnings(filtered).slice(0, 3),
      behavior_profiles: aggregateBehaviorProfiles(filtered, user.role === "analyst").slice(0, 3),
      case_linkage: aggregateCaseLinkages(filtered, user.role === "analyst"),
      agent_brief: agent,
      copilot_brief: copilot,
    },
  };
}
