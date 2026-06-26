import {
  ageBand,
  counterObject,
  haversineKm,
  increment,
  maskedLabel,
  monthKey,
  severityValue,
  slugify,
  sortedEntries,
  sum,
  unique,
  utcNow,
} from "./utils.js";
import { userScopedRecords } from "./dataStore.js";

const TOKEN_STOPWORDS = new Set([
  "after",
  "case",
  "cases",
  "during",
  "from",
  "near",
  "through",
  "used",
  "with",
  "repeat",
  "prior",
  "late",
  "early",
  "fake",
  "local",
]);

const VEHICLE_TERMS = new Set(["vehicle", "bike", "two-wheeler", "scooter", "motorcycle", "cab", "parking", "pillion", "riders", "dismantling", "parts-market"]);
const COMMUNICATION_TERMS = new Set(["call", "call-detail", "phone", "telegram", "encrypted-chat", "social-media", "messaging", "remote-access", "portal", "upi", "wallet", "bank-account", "credential", "contact", "app"]);

export function aggregateTrends(records) {
  const monthly = new Map();
  for (const record of records) {
    const month = monthKey(record);
    if (!monthly.has(month)) monthly.set(month, new Map());
    increment(monthly.get(month), record.crime_type);
  }
  return [...monthly.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, counter]) => ({
      month,
      total: sum([...counter.values()]),
      types: counterObject(counter),
    }));
}

export function aggregateHotspots(records) {
  const latest = records.map(monthKey).sort().at(-1) || "";
  const stations = new Map();
  for (const record of records) {
    const key = `${record.district}::${record.police_station}`;
    if (!stations.has(key)) {
      stations.set(key, {
        district: record.district,
        police_station: record.police_station,
        latitude: record.latitude,
        longitude: record.longitude,
        cases: 0,
        open_cases: 0,
        severity: 0,
        recent_cases: 0,
        crime_mix: new Map(),
      });
    }
    const station = stations.get(key);
    station.cases += 1;
    station.open_cases += record.status === "Chargesheeted" ? 0 : 1;
    station.severity += severityValue(record);
    station.recent_cases += monthKey(record) === latest ? 1 : 0;
    increment(station.crime_mix, record.crime_type);
  }
  return [...stations.values()]
    .map((station) => {
      const score = station.cases * 10 + station.severity * 3 + station.open_cases * 4 + station.recent_cases * 5;
      return {
        district: station.district,
        police_station: station.police_station,
        latitude: station.latitude,
        longitude: station.longitude,
        cases: station.cases,
        open_cases: station.open_cases,
        score,
        top_crime: sortedEntries(station.crime_mix)[0]?.[0] || "Unknown",
        crime_mix: counterObject(station.crime_mix),
      };
    })
    .sort((a, b) => b.score - a.score);
}

export function aggregateDemographics(records) {
  const victimAge = new Map();
  const victimGender = new Map();
  const accusedAge = new Map();
  const socioeconomic = new Map();
  for (const record of records) {
    increment(victimAge, ageBand(record.victim_age));
    increment(victimGender, record.victim_gender || "Unknown");
    increment(accusedAge, ageBand(record.accused_age));
    increment(socioeconomic, record.socioeconomic_indicator || "Unknown");
  }
  return {
    victim_age: counterObject(victimAge),
    victim_gender: counterObject(victimGender),
    accused_age: counterObject(accusedAge),
    socioeconomic: counterObject(socioeconomic),
  };
}

export function aggregateBehaviorProfiles(records, maskPeople = false) {
  const lookup = new Map();
  const grouped = new Map();
  for (const record of records) {
    if (!grouped.has(record.crime_type)) grouped.set(record.crime_type, []);
    grouped.get(record.crime_type).push(record);
  }
  const profiles = [];
  for (const [crimeType, group] of grouped.entries()) {
    const modus = new Map();
    const evidence = new Map();
    const beats = new Map();
    const accusedAge = new Map();
    const accusedGender = new Map();
    const people = new Map();
    for (const record of group) {
      increment(modus, record.modus_operandi || "Unknown");
      increment(beats, `${record.police_station} - ${record.beat}`);
      increment(accusedAge, ageBand(record.accused_age));
      increment(accusedGender, record.accused_gender || "Unknown");
      for (const tag of record.evidence_tags || []) increment(evidence, tag);
      for (const name of [...(record.suspects || []), ...(record.associates || [])]) increment(people, name);
    }
    const severityScore = sum(group.map(severityValue));
    const openCases = group.filter((record) => record.status !== "Chargesheeted").length;
    const repeatPeople = sortedEntries(people).slice(0, 4).map(([name, cases]) => ({
      name: maskPeople ? maskedLabel(name, lookup) : name,
      cases,
    }));
    let signal = "Repeat method and evidence-tag convergence indicate cases that should be reviewed together.";
    if (crimeType === "Cyber Fraud") signal = "Digitally mediated social-engineering pattern with wallet, call-detail, and mule-account evidence.";
    if (["Vehicle Theft", "Chain Snatching"].includes(crimeType)) signal = "Mobility-led offender behavior; patrol timing, CCTV continuity, and vehicle traces are high-value.";
    if (["Narcotics", "Robbery"].includes(crimeType)) signal = "Repeat-location and associate-link behavior; informer tasking and inter-station coordination matter.";
    profiles.push({
      crime_type: crimeType,
      cases: group.length,
      open_cases: openCases,
      severity_score: severityScore,
      dominant_modi: sortedEntries(modus).slice(0, 3).map(([label, cases]) => ({ label, cases })),
      evidence_tags: sortedEntries(evidence).slice(0, 5).map(([tag]) => tag),
      beats: counterObject(beats, 4),
      accused_age: counterObject(accusedAge, 3),
      accused_gender: counterObject(accusedGender, 3),
      repeat_people: repeatPeople,
      behavior_signal: signal,
      investigative_use: "Use as a lead-prioritization profile only; verify identity and evidence in approved systems.",
    });
  }
  return profiles.sort((a, b) => b.open_cases - a.open_cases || b.severity_score - a.severity_score || b.cases - a.cases);
}

export function aggregateNetwork(records, maskPeople = false) {
  const lookup = new Map();
  const nodes = new Map();
  const edges = new Map();
  const edgeKey = (a, b) => [a, b].sort().join("::");
  const addEdge = (source, target) => increment(edges, edgeKey(source, target));
  const addPerson = (name, record, source = "suspect") => {
    const id = slugify(name);
    if (!nodes.has(id)) {
      nodes.set(id, { id, label: maskPeople ? maskedLabel(name, lookup) : name, type: "person", source, cases: 0, risk: 0 });
    }
    const node = nodes.get(id);
    node.cases += 1;
    node.risk += severityValue(record);
    return id;
  };
  for (const record of records) {
    const stationId = slugify(record.police_station);
    const crimeId = slugify(record.crime_type);
    if (!nodes.has(stationId)) nodes.set(stationId, { id: stationId, label: record.police_station, type: "station", cases: 0, risk: 0 });
    if (!nodes.has(crimeId)) nodes.set(crimeId, { id: crimeId, label: record.crime_type, type: "crime", cases: 0, risk: 0 });
    nodes.get(stationId).cases += 1;
    nodes.get(crimeId).cases += 1;
    const suspects = (record.suspects || []).map((name) => addPerson(name, record));
    const associates = (record.associates || []).map((name) => addPerson(name, record, "associate"));
    for (const suspect of suspects) {
      addEdge(suspect, stationId);
      addEdge(suspect, crimeId);
      for (const associate of associates) addEdge(suspect, associate);
    }
    for (let index = 0; index < suspects.length; index += 1) {
      for (const other of suspects.slice(index + 1)) addEdge(suspects[index], other);
    }
  }
  const nodeList = [...nodes.values()].sort((a, b) => (a.type !== "person") - (b.type !== "person") || (b.risk || 0) - (a.risk || 0) || a.label.localeCompare(b.label)).slice(0, 36);
  const allowed = new Set(nodeList.map((node) => node.id));
  const links = sortedEntries(edges)
    .map(([key, weight]) => {
      const [source, target] = key.split("::");
      return { source, target, weight };
    })
    .filter((link) => allowed.has(link.source) && allowed.has(link.target))
    .slice(0, 60);
  return { nodes: nodeList, links };
}

export function aggregateWarnings(records) {
  return aggregateHotspots(records).slice(0, 5).map((hotspot) => {
    let action = "Run evening beat saturation and review open-case linkages.";
    if (["Cyber Fraud", "Vehicle Theft", "Chain Snatching"].includes(hotspot.top_crime)) action = "Increase digital complaint triage, beat patrols, and targeted public advisories.";
    if (["Narcotics", "Robbery"].includes(hotspot.top_crime)) action = "Prioritize plain-clothes surveillance, informer tasking, and inter-station coordination.";
    return {
      area: `${hotspot.police_station}, ${hotspot.district}`,
      risk: hotspot.top_crime,
      confidence: Math.min(92, 56 + Math.floor(hotspot.score / 3)),
      rationale: `${hotspot.cases} matching cases, ${hotspot.open_cases} open, severity score ${hotspot.score}.`,
      recommended_action: action,
    };
  });
}

function textTokens(value) {
  return new Set(
    String(value || "")
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.filter((token) => token === "upi" || token === "cab" || token === "ndps" || (token.length > 3 && !TOKEN_STOPWORDS.has(token))) || []
  );
}

function profileTerms(record, terms) {
  const searchable = `${record.modus_operandi || ""} ${(record.evidence_tags || []).join(" ")}`.toLowerCase();
  return new Set([...terms].filter((term) => searchable.includes(term)));
}

function caseProfile(record) {
  return {
    id: record.id,
    date: new Date(`${record.date}T00:00:00Z`),
    modus_tokens: textTokens(record.modus_operandi),
    evidence: new Set(record.evidence_tags || []),
    vehicle_terms: profileTerms(record, VEHICLE_TERMS),
    communication_terms: profileTerms(record, COMMUNICATION_TERMS),
    people: new Set([...(record.suspects || []), ...(record.associates || [])]),
    victim: {
      age_band: ageBand(record.victim_age),
      gender: record.victim_gender || "Unknown",
      socio: record.socioeconomic_indicator || "Unknown",
    },
    suspect: {
      age_band: ageBand(record.accused_age),
      gender: record.accused_gender || "Unknown",
    },
  };
}

function intersection(first, second) {
  return new Set([...first].filter((value) => second.has(value)));
}

function unionSize(first, second) {
  return new Set([...first, ...second]).size;
}

function scoreCasePair(first, second, firstProfile, secondProfile, personLookup, maskPeople) {
  let score = 0;
  const evidence = [];
  if (first.crime_type === second.crime_type) {
    score += 6;
    evidence.push({ dimension: "case_context", weight: 6, detail: `Same crime type: ${first.crime_type}.` });
  }
  const sharedModus = intersection(firstProfile.modus_tokens, secondProfile.modus_tokens);
  const modusSimilarity = sharedModus.size / Math.max(1, unionSize(firstProfile.modus_tokens, secondProfile.modus_tokens));
  if (modusSimilarity >= 0.18 || sharedModus.size >= 2) {
    const weight = Math.min(22, 8 + Math.round(modusSimilarity * 28) + Math.min(6, sharedModus.size * 2));
    score += weight;
    evidence.push({ dimension: "modus_operandi", weight, detail: `Shared operating tokens: ${[...sharedModus].sort().slice(0, 6).join(", ")}.` });
  }
  const distance = haversineKm(first, second);
  let locationWeight = 0;
  const locationParts = [];
  if (first.police_station === second.police_station) {
    locationWeight += 16;
    locationParts.push(`same station ${first.police_station}`);
  } else if (first.district === second.district) {
    locationWeight += 7;
    locationParts.push(`same district ${first.district}`);
  }
  if (first.beat === second.beat) {
    locationWeight += 8;
    locationParts.push(`same beat ${first.beat}`);
  } else if (distance <= 4) {
    locationWeight += 6;
    locationParts.push(`${distance.toFixed(1)} km apart`);
  } else if (distance <= 12) {
    locationWeight += 3;
    locationParts.push(`${distance.toFixed(1)} km apart`);
  }
  if (locationWeight) {
    score += locationWeight;
    evidence.push({ dimension: "location_pattern", weight: locationWeight, detail: `${locationParts.join("; ")}.` });
  }
  const daysApart = Math.abs((firstProfile.date - secondProfile.date) / 86400000);
  let timeWeight = daysApart <= 7 ? 12 : daysApart <= 30 ? 8 : monthKey(first) === monthKey(second) ? 5 : 0;
  if (firstProfile.date.getUTCDay() === secondProfile.date.getUTCDay()) timeWeight += 2;
  if (timeWeight) {
    score += timeWeight;
    evidence.push({ dimension: "time_pattern", weight: timeWeight, detail: `${Math.round(daysApart)} days apart with temporal overlap.` });
  }
  const victimMatches = [];
  for (const [key, label] of [["age_band", "victim age band"], ["gender", "victim gender"], ["socio", "socio-economic tag"]]) {
    if (firstProfile.victim[key] === secondProfile.victim[key]) victimMatches.push(`${label}: ${firstProfile.victim[key]}`);
  }
  if (victimMatches.length) {
    const weight = Math.min(12, victimMatches.length * 4);
    score += weight;
    evidence.push({ dimension: "victim_profile", weight, detail: `${victimMatches.join("; ")}.` });
  }
  const sharedPeople = intersection(firstProfile.people, secondProfile.people);
  const suspectMatches = [];
  if (sharedPeople.size) {
    const names = [...sharedPeople].sort().slice(0, 4).map((name) => (maskPeople ? maskedLabel(name, personLookup) : name));
    suspectMatches.push(`shared persons: ${names.join(", ")}`);
  }
  if (firstProfile.suspect.age_band === secondProfile.suspect.age_band) suspectMatches.push(`accused age band: ${firstProfile.suspect.age_band}`);
  if (firstProfile.suspect.gender === secondProfile.suspect.gender) suspectMatches.push(`accused gender: ${firstProfile.suspect.gender}`);
  if (suspectMatches.length) {
    const weight = (sharedPeople.size ? 24 : 0) + Math.min(8, (suspectMatches.length - (sharedPeople.size ? 1 : 0)) * 4);
    score += weight;
    evidence.push({ dimension: "suspect_profile", weight, detail: `${suspectMatches.join("; ")}.` });
  }
  const sharedVehicle = intersection(firstProfile.vehicle_terms, secondProfile.vehicle_terms);
  if (sharedVehicle.size || (firstProfile.vehicle_terms.size && secondProfile.vehicle_terms.size)) {
    const terms = sharedVehicle.size ? sharedVehicle : new Set([...firstProfile.vehicle_terms, ...secondProfile.vehicle_terms]);
    const weight = sharedVehicle.size ? 12 : 6;
    score += weight;
    evidence.push({ dimension: "vehicle_information", weight, detail: `Vehicle indicators: ${[...terms].sort().slice(0, 5).join(", ")}.` });
  }
  const sharedCommunication = intersection(firstProfile.communication_terms, secondProfile.communication_terms);
  if (sharedCommunication.size || (firstProfile.communication_terms.size && secondProfile.communication_terms.size)) {
    const terms = sharedCommunication.size ? sharedCommunication : new Set([...firstProfile.communication_terms, ...secondProfile.communication_terms]);
    const weight = sharedCommunication.size ? 12 : 6;
    score += weight;
    evidence.push({ dimension: "communication_records", weight, detail: `Communication or digital traces: ${[...terms].sort().slice(0, 5).join(", ")}.` });
  }
  const confidence = Math.min(99, Math.round(score));
  const dimensions = unique(evidence.map((item) => item.dimension));
  if (confidence < 42 || dimensions.length < 3) return null;
  return { source: first.id, target: second.id, confidence, dimensions, evidence };
}

export function aggregateCaseLinkages(records, maskPeople = false) {
  const profiles = new Map(records.map((record) => [record.id, caseProfile(record)]));
  const personLookup = new Map();
  const links = [];
  for (let index = 0; index < records.length; index += 1) {
    for (const second of records.slice(index + 1)) {
      const first = records[index];
      const link = scoreCasePair(first, second, profiles.get(first.id), profiles.get(second.id), personLookup, maskPeople);
      if (link) links.push(link);
    }
  }
  links.sort((a, b) => b.confidence - a.confidence);
  const parent = new Map(records.map((record) => [record.id, record.id]));
  const find = (caseId) => {
    while (parent.get(caseId) !== caseId) {
      parent.set(caseId, parent.get(parent.get(caseId)));
      caseId = parent.get(caseId);
    }
    return caseId;
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };
  for (const link of links) if (link.confidence >= 50) union(link.source, link.target);
  const components = new Map();
  for (const record of records) {
    const root = find(record.id);
    if (!components.has(root)) components.set(root, new Set());
    components.get(root).add(record.id);
  }
  const byId = new Map(records.map((record) => [record.id, record]));
  const clusters = [];
  let clusterIndex = 1;
  for (const caseIds of [...components.values()].filter((ids) => ids.size > 1)) {
    const clusterLinks = links.filter((link) => caseIds.has(link.source) && caseIds.has(link.target));
    if (!clusterLinks.length) continue;
    const dimensionCounts = new Map();
    for (const link of clusterLinks) for (const dimension of link.dimensions) increment(dimensionCounts, dimension);
    const average = Math.round(sum(clusterLinks.map((link) => link.confidence)) / clusterLinks.length);
    const top = Math.max(...clusterLinks.map((link) => link.confidence));
    const confidence = Math.round(average * 0.62 + top * 0.38);
    const sortedCases = [...caseIds].map((id) => byId.get(id)).sort((a, b) => a.date.localeCompare(b.date));
    const topDimensions = sortedEntries(dimensionCounts).slice(0, 5).map(([dimension]) => dimension);
    clusters.push({
      cluster_id: `LNK-${String(clusterIndex).padStart(3, "0")}`,
      confidence,
      risk_level: confidence >= 76 ? "High" : confidence >= 58 ? "Medium" : "Watch",
      case_count: sortedCases.length,
      cases: sortedCases.map((record) => ({
        case_id: record.id,
        date: record.date,
        district: record.district,
        police_station: record.police_station,
        crime_type: record.crime_type,
        status: record.status,
      })),
      evidence_summary: topDimensions,
      supporting_links: clusterLinks.slice(0, 6),
      proactive_lead: `Review ${sortedCases.length} cases together; strongest signals are ${topDimensions.slice(0, 3).join(", ")}.`,
    });
    clusterIndex += 1;
  }
  clusters.sort((a, b) => b.confidence - a.confidence || b.case_count - a.case_count);
  const clusteredIds = new Set(clusters.slice(0, 5).flatMap((cluster) => cluster.cases.map((item) => item.case_id)));
  const graphNodes = records
    .filter((record) => clusteredIds.has(record.id))
    .slice(0, 32)
    .map((record) => ({
      id: record.id,
      label: record.id.replace("SYN-2026-", "#"),
      crime_type: record.crime_type,
      police_station: record.police_station,
      status: record.status,
    }));
  const allowed = new Set(graphNodes.map((node) => node.id));
  const graphLinks = links
    .filter((link) => allowed.has(link.source) && allowed.has(link.target))
    .slice(0, 60)
    .map((link) => ({ source: link.source, target: link.target, confidence: link.confidence, dimensions: link.dimensions }));
  return {
    generated_at: utcNow(),
    record_count: records.length,
    pair_count: links.length,
    clusters: clusters.slice(0, 8),
    graph: { nodes: graphNodes, links: graphLinks },
    explainability: [
      "pairwise scoring across method, location, time, victim, suspect, vehicle, and communication dimensions",
      "clusters are connected components over case-pair confidence >= 50",
      "human_verification_required",
    ],
  };
}

export function buildAnalytics(records, user) {
  const scoped = userScopedRecords(records, user);
  const byType = new Map();
  const byDistrict = new Map();
  for (const record of scoped) {
    increment(byType, record.crime_type);
    increment(byDistrict, record.district);
  }
  const maskPeople = user.role === "analyst";
  return {
    generated_at: utcNow(),
    scope: user.district_scope,
    record_count: scoped.length,
    open_cases: scoped.filter((record) => record.status !== "Chargesheeted").length,
    crime_types: counterObject(byType),
    districts: counterObject(byDistrict),
    trends: aggregateTrends(scoped),
    hotspots: aggregateHotspots(scoped),
    demographics: aggregateDemographics(scoped),
    behavior_profiles: aggregateBehaviorProfiles(scoped, maskPeople),
    case_linkage: aggregateCaseLinkages(scoped, maskPeople),
    network: aggregateNetwork(scoped, maskPeople),
    warnings: aggregateWarnings(scoped),
  };
}
