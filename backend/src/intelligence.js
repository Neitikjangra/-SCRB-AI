import {
  aggregateBehaviorProfiles,
  aggregateCaseLinkages,
  aggregateHotspots,
  aggregateNetwork,
  aggregateTrends,
  aggregateWarnings,
} from "./analytics.js";
import { userScopedRecords } from "./dataStore.js";
import { counterObject, increment, maskedLabel, randomId, severityValue, slugify, sortedEntries, topItems, utcNow } from "./utils.js";

export function buildSuspectLeads(records, maskPeople = false) {
  const lookup = new Map();
  const people = new Map();
  const displayName = (name) => (maskPeople ? maskedLabel(name, lookup) : name);
  for (const record of records) {
    const casePeople = [...new Set([...(record.suspects || []), ...(record.associates || [])])];
    for (const name of casePeople) {
      const key = slugify(name);
      if (!people.has(key)) {
        people.set(key, {
          name: displayName(name),
          cases: 0,
          open_cases: 0,
          severity_score: 0,
          suspect_mentions: 0,
          associate_mentions: 0,
          crime_mix: new Map(),
          stations: new Map(),
          districts: new Map(),
          evidence: new Map(),
          linked_people: new Map(),
        });
      }
      const lead = people.get(key);
      lead.cases += 1;
      lead.open_cases += record.status === "Chargesheeted" ? 0 : 1;
      lead.severity_score += severityValue(record);
      lead.suspect_mentions += (record.suspects || []).includes(name) ? 1 : 0;
      lead.associate_mentions += (record.associates || []).includes(name) ? 1 : 0;
      increment(lead.crime_mix, record.crime_type);
      increment(lead.stations, record.police_station);
      increment(lead.districts, record.district);
      for (const tag of record.evidence_tags || []) increment(lead.evidence, tag);
      for (const other of casePeople) if (other !== name) increment(lead.linked_people, displayName(other));
    }
  }
  return [...people.values()]
    .map((lead) => {
      const score =
        lead.cases * 12 +
        lead.open_cases * 8 +
        lead.severity_score * 4 +
        lead.crime_mix.size * 4 +
        lead.stations.size * 3 +
        lead.suspect_mentions * 2;
      const topCrime = sortedEntries(lead.crime_mix)[0]?.[0] || "Unknown";
      const reasons = [
        `${lead.cases} linked synthetic records`,
        `${lead.open_cases} open cases`,
        `severity score ${lead.severity_score}`,
        `dominant pattern: ${topCrime}`,
      ];
      if (lead.stations.size > 1) reasons.push(`appears across ${lead.stations.size} police stations`);
      const linked = sortedEntries(lead.linked_people)[0];
      if (linked) reasons.push(`strongest observed link: ${linked[0]} (${linked[1]})`);
      return {
        name: lead.name,
        score,
        cases: lead.cases,
        open_cases: lead.open_cases,
        role_signal: lead.suspect_mentions >= lead.associate_mentions ? "suspect" : "associate",
        crime_types: counterObject(lead.crime_mix, 4),
        stations: counterObject(lead.stations, 4),
        districts: counterObject(lead.districts, 3),
        evidence_tags: sortedEntries(lead.evidence).slice(0, 5).map(([tag]) => tag),
        linked_people: sortedEntries(lead.linked_people).slice(0, 4).map(([name, cases]) => ({ name, cases })),
        reasons,
        caution: "Lead suggestion only; verify identity, custody history, and evidence in approved systems.",
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
}

export function identifyHiddenRelationships(records, maskPeople = false) {
  const lookup = new Map();
  const personPairs = new Map();
  const stationCrime = new Map();
  const evidenceCrime = new Map();
  const displayName = (name) => (maskPeople ? maskedLabel(name, lookup) : name);
  const pairKey = (a, b) => [a, b].sort().join("::");
  for (const record of records) {
    const names = [...new Set([...(record.suspects || []), ...(record.associates || [])].map(displayName))].sort();
    for (let index = 0; index < names.length; index += 1) {
      for (const second of names.slice(index + 1)) increment(personPairs, pairKey(names[index], second));
    }
    increment(stationCrime, `${record.police_station}::${record.crime_type}`);
    for (const tag of record.evidence_tags || []) increment(evidenceCrime, `${tag}::${record.crime_type}`);
  }
  const relationships = [];
  for (const [key, count] of sortedEntries(personPairs).slice(0, 5)) {
    const [first, second] = key.split("::");
    relationships.push({
      type: "person_link",
      title: `${first} <-> ${second}`,
      strength: count,
      reason: "Co-occurs in the same synthetic case records or suspect-associate lists.",
      next_step: "Compare FIR timelines, device identifiers, custody history, and call-detail records.",
    });
  }
  for (const [key, count] of sortedEntries(stationCrime).slice(0, 4)) {
    if (count <= 1) continue;
    const [station, crimeType] = key.split("::");
    relationships.push({
      type: "station_pattern",
      title: `${station} <-> ${crimeType}`,
      strength: count,
      reason: "Repeated station-crime pairing suggests a local operating pattern.",
      next_step: "Review beat timing, CCTV continuity, complainant clusters, and local intelligence inputs.",
    });
  }
  for (const [key, count] of sortedEntries(evidenceCrime).slice(0, 4)) {
    if (count <= 1) continue;
    const [tag, crimeType] = key.split("::");
    relationships.push({
      type: "evidence_pattern",
      title: `${tag} evidence <-> ${crimeType}`,
      strength: count,
      reason: "Evidence tag repeatedly appears with the same crime type.",
      next_step: "Cluster cases by evidence tag before assigning technical or field resources.",
    });
  }
  return relationships.sort((a, b) => b.strength - a.strength).slice(0, 8);
}

export function detectAnomalies(records, maskPeople = false) {
  const anomalies = [];
  const hotspots = aggregateHotspots(records);
  const trends = aggregateTrends(records);
  const profiles = aggregateBehaviorProfiles(records, maskPeople);
  const network = aggregateNetwork(records, maskPeople);
  for (const hotspot of hotspots.slice(0, 3)) {
    if (hotspot.open_cases >= Math.max(2, hotspot.cases - 1)) {
      anomalies.push({
        title: `Open-case concentration at ${hotspot.police_station}`,
        severity: "high",
        reason: `${hotspot.open_cases} of ${hotspot.cases} cases remain open; dominant pattern is ${hotspot.top_crime}.`,
        recommended_check: "Review pending evidence, station workload, and cross-case linkages.",
      });
    }
  }
  if (trends.length >= 2) {
    const previous = trends.at(-2).total;
    const latest = trends.at(-1).total;
    if (latest > previous) {
      anomalies.push({
        title: `Recent volume rise in ${trends.at(-1).month}`,
        severity: "medium",
        reason: `Monthly volume increased from ${previous} to ${latest}.`,
        recommended_check: "Compare recent FIR intake with beat diaries and complaint-channel changes.",
      });
    }
  }
  for (const profile of profiles.slice(0, 3)) {
    if (profile.open_cases && profile.evidence_tags.length) {
      anomalies.push({
        title: `${profile.crime_type} evidence convergence`,
        severity: "medium",
        reason: `Open cases share evidence tags: ${profile.evidence_tags.slice(0, 3).join(", ")}.`,
        recommended_check: "Assign technical review before treating cases as isolated incidents.",
      });
    }
  }
  for (const node of network.nodes.filter((item) => item.type === "person").slice(0, 3)) {
    if ((node.risk || 0) >= 6) {
      anomalies.push({
        title: `High-risk repeat-link node: ${node.label}`,
        severity: "high",
        reason: `Network risk score ${node.risk || 0} across ${node.cases || 0} linked records.`,
        recommended_check: "Verify identity and corroborate links before enforcement decisions.",
      });
    }
  }
  return anomalies.slice(0, 6);
}

export function recommendResourceDeployment(records) {
  return aggregateHotspots(records).slice(0, 5).map((hotspot) => {
    let resource = "Beat saturation + evidence review desk";
    let timing = "Station-defined peak incident windows";
    if (hotspot.top_crime === "Cyber Fraud") {
      resource = "Cyber triage cell + digital evidence analyst";
      timing = "Same day complaint triage and wallet/CDR review";
    } else if (["Narcotics", "Robbery"].includes(hotspot.top_crime)) {
      resource = "Plain-clothes team + informer coordination";
      timing = "Evening and late-night beat overlap";
    } else if (["Vehicle Theft", "Chain Snatching"].includes(hotspot.top_crime)) {
      resource = "Mobile patrol + CCTV/ANPR review";
      timing = "Evening commute and market-close windows";
    }
    return {
      area: `${hotspot.police_station}, ${hotspot.district}`,
      resource,
      timing,
      reason: `${hotspot.score} hotspot score; ${hotspot.cases} cases and ${hotspot.open_cases} open.`,
      coordination: "Coordinate through supervisor review; do not use synthetic output as sole deployment basis.",
    };
  });
}

export function buildInvestigationCopilot(records, user, objective = "proactive_intelligence_watch", scoped = false) {
  const scopedRecords = scoped ? records : userScopedRecords(records, user);
  const maskPeople = user.role === "analyst";
  const suspectLeads = buildSuspectLeads(scopedRecords, maskPeople);
  const relationships = identifyHiddenRelationships(scopedRecords, maskPeople);
  const caseLinkage = aggregateCaseLinkages(scopedRecords, maskPeople);
  const anomalies = detectAnomalies(scopedRecords, maskPeople);
  const deployments = recommendResourceDeployment(scopedRecords);
  const hotspots = aggregateHotspots(scopedRecords);
  const warnings = aggregateWarnings(scopedRecords);
  const openCases = scopedRecords.filter((record) => record.status !== "Chargesheeted").length;
  const crimeMix = new Map();
  for (const record of scopedRecords) increment(crimeMix, record.crime_type);
  const topSuspect = suspectLeads[0]?.name || "no repeat lead";
  const topHotspot = hotspots[0]?.police_station || "no hotspot";
  const topAnomaly = anomalies[0]?.title || "no anomaly";
  const topDeployment = deployments[0]?.resource || "routine monitoring";
  const proactiveInsights = [];
  if (suspectLeads[0]) proactiveInsights.push({ label: "Suspect lead", headline: suspectLeads[0].name, detail: suspectLeads[0].reasons.slice(0, 3).join("; "), priority: "P1" });
  if (relationships[0]) proactiveInsights.push({ label: "Hidden relationship", headline: relationships[0].title, detail: relationships[0].reason, priority: "P1" });
  if (caseLinkage.clusters[0]) proactiveInsights.push({ label: "Case linkage", headline: `${caseLinkage.clusters[0].cluster_id} - ${caseLinkage.clusters[0].confidence}%`, detail: caseLinkage.clusters[0].proactive_lead, priority: "P1" });
  if (anomalies[0]) proactiveInsights.push({ label: "Anomaly", headline: anomalies[0].title, detail: anomalies[0].reason, priority: anomalies[0].severity === "high" ? "P1" : "P2" });
  if (deployments[0]) proactiveInsights.push({ label: "Deployment", headline: deployments[0].resource, detail: `${deployments[0].area}; ${deployments[0].timing}`, priority: "P2" });
  const nextActions = [
    {
      priority: "P1",
      title: "Validate top suspect lead",
      reason: suspectLeads[0] ? suspectLeads[0].reasons.join("; ") : "No repeat lead exceeded the threshold.",
      action: "Cross-check FIR narrative, custody history, CDR/device records, and physical evidence before action.",
    },
    {
      priority: "P1",
      title: "Review linked case cluster",
      reason: caseLinkage.clusters[0]?.proactive_lead || "No linked cluster exceeded the threshold.",
      action: "Assign an investigator to compare FIR narratives, station handovers, device records, and evidence tags.",
    },
    {
      priority: "P2",
      title: "Deploy prevention resources",
      reason: deployments[0]?.reason || "No hotspot exceeded the threshold.",
      action: deployments[0] ? `${deployments[0].resource} at ${deployments[0].area}; ${deployments[0].timing}.` : "Maintain routine monitoring.",
    },
  ];
  const confidence = Math.min(94, 58 + suspectLeads.length * 4 + relationships.length * 2 + caseLinkage.clusters.length * 3 + anomalies.length * 2);
  return {
    name: "AI Investigation Copilot",
    run_id: randomId("COP"),
    status: "proactive",
    generated_at: utcNow(),
    objective,
    scope: user.district_scope,
    records_considered: scopedRecords.length,
    open_cases: openCases,
    confidence,
    intelligence_summary: `Copilot reviewed ${scopedRecords.length} role-scoped synthetic records with ${openCases} open cases. Top lead is ${topSuspect}; priority hotspot is ${topHotspot}; main anomaly is ${topAnomaly}. Recommended first deployment: ${topDeployment}.`,
    proactive_insights: proactiveInsights,
    suspect_leads: suspectLeads,
    next_actions: nextActions,
    hidden_relationships: relationships,
    anomalies,
    resource_deployments: deployments,
    crime_mix: counterObject(crimeMix),
    warnings,
    case_linkage: caseLinkage,
    reasoning: [
      "Role scope was applied before analysis.",
      "Suspect leads combine repeat mentions, open cases, severity, station spread, and evidence convergence.",
      "Hidden relationships use person co-occurrence, station-crime repetition, and evidence-crime repetition.",
      "Anomalies prioritize open-case concentration, recent volume rise, evidence convergence, and high-risk network nodes.",
      "Recommendations are investigative leads only; human verification is required.",
    ],
    guardrails: ["synthetic_data_notice", "role_based_masking", "lead_not_probable_cause", "human_verification_required"],
  };
}

export function buildAgentBrief(records, user, objective = "operational_triage", scoped = false) {
  const scopedRecords = scoped ? records : userScopedRecords(records, user);
  const maskPeople = user.role === "analyst";
  const hotspots = aggregateHotspots(scopedRecords);
  const warnings = aggregateWarnings(scopedRecords);
  const profiles = aggregateBehaviorProfiles(scopedRecords, maskPeople);
  const caseLinkage = aggregateCaseLinkages(scopedRecords, maskPeople);
  const suspectLeads = buildSuspectLeads(scopedRecords, maskPeople);
  const deployments = recommendResourceDeployment(scopedRecords);
  const openCases = scopedRecords.filter((record) => record.status !== "Chargesheeted").length;
  const actionQueue = [];
  if (caseLinkage.clusters[0]) {
    actionQueue.push({
      priority: "P1",
      title: `Review ${caseLinkage.clusters[0].cluster_id}`,
      target: caseLinkage.clusters[0].cluster_id,
      rationale: caseLinkage.clusters[0].proactive_lead,
      next_step: "Assign a case-linkage review across FIR narratives, evidence tags, CDR/device records, and station handovers.",
    });
  }
  if (suspectLeads[0]) {
    actionQueue.push({
      priority: "P1",
      title: `Validate lead: ${suspectLeads[0].name}`,
      target: suspectLeads[0].name,
      rationale: suspectLeads[0].reasons.join("; "),
      next_step: "Confirm identity and evidence through approved systems before operational action.",
    });
  }
  for (const warning of warnings.slice(0, 3)) {
    actionQueue.push({
      priority: warning.confidence >= 80 ? "P1" : "P2",
      title: `Preventive action at ${warning.area}`,
      target: warning.area,
      rationale: warning.rationale,
      next_step: warning.recommended_action,
    });
  }
  for (const deployment of deployments.slice(0, 2)) {
    actionQueue.push({
      priority: "P2",
      title: `Resource deployment: ${deployment.resource}`,
      target: deployment.area,
      rationale: deployment.reason,
      next_step: deployment.timing,
    });
  }
  const watchlist = [
    ...hotspots.slice(0, 3).map((item) => ({ label: `${item.police_station}, ${item.district}`, signal: `${item.top_crime} hotspot`, cases: item.cases, open_cases: item.open_cases })),
    ...profiles.slice(0, 3).map((item) => ({ label: item.crime_type, signal: item.behavior_signal, cases: item.cases, open_cases: item.open_cases })),
  ];
  const confidence = Math.min(93, 60 + actionQueue.length * 3 + caseLinkage.clusters.length * 2);
  return {
    name: "Investigator Agent",
    run_id: randomId("AGT"),
    status: "ready",
    objective,
    generated_at: utcNow(),
    scope: user.district_scope,
    records_considered: scopedRecords.length,
    open_cases: openCases,
    confidence,
    mission_brief: `Reviewed ${scopedRecords.length} role-scoped synthetic records with ${openCases} open cases. Prioritize ${actionQueue[0]?.target || "routine monitoring"} and keep human verification before operational action.`,
    action_queue: actionQueue.slice(0, 7),
    watchlist: watchlist.slice(0, 6),
    behavior_profiles: profiles.slice(0, 3),
    case_linkage: caseLinkage,
    explainability: [
      "role_scope_filter",
      "hotspot_score = cases + severity + open-case + recency weights",
      "behavior profiles use modus operandi, evidence tags, repeat locations, and repeat links",
      "case linkage compares case pairs across method, location, time, victim, suspect, vehicle, and communication dimensions",
      "human_verification_required",
    ],
    guardrails: ["synthetic_data_notice", "role_based_masking", "human_verification_required"],
  };
}
