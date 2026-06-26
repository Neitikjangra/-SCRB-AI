const state = {
  token: null,
  user: null,
  analytics: null,
  conversation: [],
  latestAudit: null,
  recognition: null,
  agent: null,
  copilot: null,
};

const els = {
  loginView: document.querySelector("#loginView"),
  appView: document.querySelector("#appView"),
  messages: document.querySelector("#messages"),
  chatForm: document.querySelector("#chatForm"),
  chatInput: document.querySelector("#chatInput"),
  promptStrip: document.querySelector("#promptStrip"),
  sessionRole: document.querySelector("#sessionRole"),
  scopeLabel: document.querySelector("#scopeLabel"),
  healthStatus: document.querySelector("#healthStatus"),
  generatedAt: document.querySelector("#generatedAt"),
  recordCount: document.querySelector("#recordCount"),
  openCases: document.querySelector("#openCases"),
  topCrime: document.querySelector("#topCrime"),
  topHotspot: document.querySelector("#topHotspot"),
  hotspotMap: document.querySelector("#hotspotMap"),
  hotspotList: document.querySelector("#hotspotList"),
  trendChart: document.querySelector("#trendChart"),
  networkGraph: document.querySelector("#networkGraph"),
  warningList: document.querySelector("#warningList"),
  demographicBars: document.querySelector("#demographicBars"),
  behaviorProfiles: document.querySelector("#behaviorProfiles"),
  caseLinkageGraph: document.querySelector("#caseLinkageGraph"),
  caseLinkageClusters: document.querySelector("#caseLinkageClusters"),
  timelinePanel: document.querySelector("#timelinePanel"),
  auditPanel: document.querySelector("#auditPanel"),
  agentPanel: document.querySelector("#agentPanel"),
  copilotPanel: document.querySelector("#copilotPanel"),
  voiceButton: document.querySelector("#voiceButton"),
  exportButton: document.querySelector("#exportButton"),
  agentButton: document.querySelector("#agentButton"),
  copilotButton: document.querySelector("#copilotButton"),
  refreshButton: document.querySelector("#refreshButton"),
  logoutButton: document.querySelector("#logoutButton"),
  loginPulseLayer: document.querySelector("#loginPulseLayer"),
};

const prompts = [
  "Show emerging hotspots in Bengaluru City",
  "Find repeat network links around Arjun Nayak",
  "Compare cyber fraud trend this month",
  "Explain early warnings for Whitefield PS",
  "Ask copilot to suggest suspects and anomalies",
  "Run case linkage engine for hidden relationships",
  "Run the investigator agent triage plan",
  "Show behavioral profile for cyber fraud",
  "ಈ ತಿಂಗಳ ಅಪರಾಧ ಎಚ್ಚರಿಕೆಗಳು",
];

const investigationTimeline = [
  {
    time: "10:05 PM",
    title: "Vehicle Reported Missing",
    detail: "Complaint intake marks the first confirmed incident timestamp.",
    source: "FIR intake",
  },
  {
    time: "10:17 PM",
    title: "CCTV Detection",
    detail: "Camera trace places the vehicle near a metro approach road.",
    source: "CCTV",
  },
  {
    time: "10:24 PM",
    title: "Suspect Phone Location Updated",
    detail: "Device signal moves in the same direction as the vehicle trace.",
    source: "Phone location",
  },
  {
    time: "10:41 PM",
    title: "Vehicle Moved District Boundary",
    detail: "Movement pattern indicates planned transit rather than local joyriding.",
    source: "ANPR / boundary alert",
  },
  {
    time: "11:08 PM",
    title: "Associate Contacted",
    detail: "Communication event suggests handoff coordination with an associate.",
    source: "Communication record",
  },
];

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }
  let response;
  try {
    response = await fetch(path, { ...options, headers });
  } catch {
    throw new Error("API server is not reachable. Start the local server, then refresh this page.");
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

function formatRole(role) {
  return role
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function setHealth(ok, text) {
  els.healthStatus.textContent = text;
  els.healthStatus.classList.toggle("alert", !ok);
}

function currentLanguage() {
  return document.querySelector('input[name="language"]:checked')?.value || "en";
}

function addMessage(role, content, meta = "") {
  state.conversation.push({ role, content });
  const message = document.createElement("article");
  message.className = `message ${role}`;
  message.innerHTML = `<div>${escapeHtml(content)}</div>${meta ? `<small>${escapeHtml(meta)}</small>` : ""}`;
  els.messages.append(message);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function renderPrompts() {
  els.promptStrip.innerHTML = "";
  for (const prompt of prompts) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = prompt;
    button.addEventListener("click", () => {
      els.chatInput.value = prompt;
      els.chatInput.focus();
    });
    els.promptStrip.append(button);
  }
}

function renderLoginPulse() {
  const points = [
    [288, 165, 14],
    [238, 238, 10],
    [330, 276, 16],
    [242, 357, 11],
    [352, 430, 13],
    [195, 445, 9],
  ];
  els.loginPulseLayer.innerHTML = points
    .map(([x, y, r], index) => {
      const color = index % 2 === 0 ? "#f0b45f" : "#85d6c0";
      return `<g>
        <circle cx="${x}" cy="${y}" r="${r + 26}" fill="${color}" opacity="0.08"></circle>
        <circle cx="${x}" cy="${y}" r="${r + 14}" fill="none" stroke="${color}" stroke-width="2" opacity="0.28"></circle>
        <circle cx="${x}" cy="${y}" r="${r}" fill="${color}" opacity="0.9"></circle>
        <path d="M${x - r - 18} ${y}h${r + 9}M${x + 9} ${y}h${r + 18}M${x} ${y - r - 18}v${r + 9}M${x} ${y + 9}v${r + 18}" stroke="${color}" stroke-width="1.6" opacity="0.56"></path>
      </g>`;
    })
    .join("");
}

function topEntry(object) {
  const entries = Object.entries(object || {});
  if (!entries.length) return ["-", 0];
  return entries.sort((a, b) => b[1] - a[1])[0];
}

function renderKpis(data) {
  const [crime] = topEntry(data.crime_types);
  const hotspot = data.hotspots?.[0];
  els.recordCount.textContent = data.record_count.toLocaleString("en-IN");
  els.openCases.textContent = data.open_cases.toLocaleString("en-IN");
  els.topCrime.textContent = crime;
  els.topHotspot.textContent = hotspot ? `${hotspot.police_station}` : "-";
  els.generatedAt.textContent = `Generated ${new Date(data.generated_at).toLocaleString()}`;
}

function mapPoint(latitude, longitude) {
  const minLat = 11.5;
  const maxLat = 18.5;
  const minLon = 74.0;
  const maxLon = 78.8;
  const x = 80 + ((longitude - minLon) / (maxLon - minLon)) * 460;
  const y = 560 - ((latitude - minLat) / (maxLat - minLat)) * 500;
  return [Math.max(50, Math.min(570, x)), Math.max(42, Math.min(580, y))];
}

function renderHotspots(hotspots) {
  const maxScore = Math.max(...hotspots.map((item) => item.score), 1);
  const defs = `<defs>
    <radialGradient id="mapGlow" cx="50%" cy="45%" r="62%">
      <stop offset="0%" stop-color="#2ac48f" stop-opacity="0.24"></stop>
      <stop offset="65%" stop-color="#39c4d9" stop-opacity="0.08"></stop>
      <stop offset="100%" stop-color="#071112" stop-opacity="0"></stop>
    </radialGradient>
    <linearGradient id="mapEdge" x1="90" y1="30" x2="500" y2="590">
      <stop offset="0%" stop-color="#eff8f4" stop-opacity="0.72"></stop>
      <stop offset="48%" stop-color="#39c4d9" stop-opacity="0.42"></stop>
      <stop offset="100%" stop-color="#f0b456" stop-opacity="0.58"></stop>
    </linearGradient>
  </defs>`;
  const region = `<circle cx="310" cy="312" r="250" fill="url(#mapGlow)"></circle>
    <path class="map-outline" d="M318 34 424 82 468 148 448 219 496 296 458 371 472 455 403 520 342 592 268 572 218 510 151 461 130 379 91 306 121 224 109 139 181 70Z" stroke="url(#mapEdge)"></path>`;
  const districts = `<path class="map-district" d="M180 70 226 160 205 250 250 332 218 510"></path>
    <path class="map-district" d="M318 34 306 158 354 248 330 362 342 592"></path>
    <path class="map-district" d="M424 82 384 178 436 292 390 402 403 520"></path>
    <path class="map-district" d="M91 306 205 292 322 312 496 296"></path>
    <path class="map-district" d="M151 461 244 426 334 452 472 455"></path>`;
  const roads = `<path class="map-road" d="M168 112 246 202 232 316 316 392 292 528"></path>
    <path class="map-road" d="M402 104 342 190 394 282 356 404 420 496"></path>`;
  const points = hotspots.slice(0, 12).map((item) => {
    const [x, y] = mapPoint(item.latitude, item.longitude);
    const radius = 8 + (item.score / maxScore) * 19;
    return `<g transform="translate(${x} ${y})">
      <circle class="map-pulse" r="${(radius + 16).toFixed(1)}"></circle>
      <circle class="map-point" r="${radius.toFixed(1)}"></circle>
      <path d="M${(-radius - 12).toFixed(1)} 0h${(radius + 6).toFixed(1)}M${(radius + 6).toFixed(1)} 0h${(radius + 12).toFixed(1)}M0 ${(-radius - 12).toFixed(1)}v${(radius + 6).toFixed(1)}M0 ${(radius + 6).toFixed(1)}v${(radius + 12).toFixed(1)}" stroke="#fff" stroke-width="1.4" opacity="0.52"></path>
      <text class="map-label" x="${(radius + 9).toFixed(1)}" y="4">${escapeHtml(item.police_station)}</text>
    </g>`;
  });
  els.hotspotMap.innerHTML = `${defs}<rect x="1" y="1" width="618" height="618" rx="8" fill="#0d1718"></rect>${region}${districts}${roads}${points.join("")}`;

  els.hotspotList.innerHTML = hotspots.slice(0, 5).map((item, index) => {
    const width = Math.max(8, (item.score / maxScore) * 100);
    return `<article class="rank-item">
      <strong>${index + 1}. ${escapeHtml(item.police_station)}</strong>
      <span>${escapeHtml(item.district)} · ${item.cases} cases · ${item.open_cases} open · ${escapeHtml(item.top_crime)}</span>
      <div class="risk-meter" aria-hidden="true"><i style="width:${width}%"></i></div>
    </article>`;
  }).join("");
}

function renderTrend(trends) {
  if (!trends.length) {
    els.trendChart.innerHTML = `<text class="chart-label" x="360" y="168" text-anchor="middle">No trend data available</text>`;
    return;
  }
  const width = 720;
  const height = 320;
  const margin = { top: 28, right: 28, bottom: 52, left: 48 };
  const max = Math.max(...trends.map((item) => item.total), 1);
  const step = (width - margin.left - margin.right) / Math.max(trends.length, 1);
  const baseY = height - margin.bottom;
  const centers = [];
  const bars = trends.map((item, index) => {
    const barWidth = Math.max(28, step * 0.54);
    const barHeight = ((height - margin.top - margin.bottom) * item.total) / max;
    const x = margin.left + index * step + (step - barWidth) / 2;
    const y = baseY - barHeight;
    centers.push([x + barWidth / 2, y]);
    const label = item.month.slice(5);
    const dominant = topEntry(item.types)[0];
    return `<rect class="chart-bar" x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" rx="5"></rect>
      <text class="chart-label" x="${x + barWidth / 2}" y="${height - 28}" text-anchor="middle">${label}</text>
      <text class="chart-label" x="${x + barWidth / 2}" y="${Math.max(18, y - 8)}" text-anchor="middle">${item.total}</text>
      <text class="chart-label" x="${x + barWidth / 2}" y="${height - 10}" text-anchor="middle">${escapeHtml(dominant).slice(0, 12)}</text>`;
  });
  const grid = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const y = margin.top + (baseY - margin.top) * ratio;
    return `<line class="chart-grid" x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}"></line>`;
  });
  const linePath = centers.map(([x, y], index) => `${index ? "L" : "M"}${x} ${y}`).join(" ");
  const areaPath = `${linePath} L${centers.at(-1)[0]} ${baseY} L${centers[0][0]} ${baseY} Z`;
  const points = centers.map(([x, y]) => `<circle class="trend-point" cx="${x}" cy="${y}" r="5"></circle>`);
  els.trendChart.innerHTML = `<defs>
      <linearGradient id="barGradient" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#39c4d9"></stop>
        <stop offset="52%" stop-color="#2ac48f"></stop>
        <stop offset="100%" stop-color="#107a5a"></stop>
      </linearGradient>
      <linearGradient id="trendAreaGradient" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#f0b456" stop-opacity="0.2"></stop>
        <stop offset="100%" stop-color="#f0b456" stop-opacity="0"></stop>
      </linearGradient>
    </defs>
    <rect x="1" y="1" width="718" height="318" rx="8" fill="#0d1718"></rect>
    ${grid.join("")}
    <line class="chart-axis" x1="${margin.left}" y1="${baseY}" x2="${width - margin.right}" y2="${baseY}"></line>
    <line class="chart-axis" x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${baseY}"></line>
    <path class="trend-area" d="${areaPath}"></path>
    <path class="trend-line" d="${linePath}"></path>
    ${points.join("")}
    ${bars.join("")}`;
}

function nodePosition(index, count, type) {
  const lane = type === "person" ? 110 : type === "station" ? 350 : 560;
  const top = 58;
  const bottom = 360;
  const y = count <= 1 ? 210 : top + ((bottom - top) / (count - 1)) * index;
  const stagger = count > 4 ? (index % 2) * 22 : 0;
  if (type === "crime") return [lane - stagger, y];
  return [lane + stagger, y];
}

function renderNetwork(network) {
  const nodes = network.nodes || [];
  const nodeGroups = {
    person: nodes.filter((node) => node.type === "person"),
    station: nodes.filter((node) => node.type === "station"),
    crime: nodes.filter((node) => node.type === "crime"),
  };
  const positions = new Map();
  for (const [type, group] of Object.entries(nodeGroups)) {
    group.forEach((node, index) => {
      positions.set(node.id, nodePosition(index, group.length, type));
    });
  }
  const links = (network.links || []).map((link) => {
    const source = positions.get(link.source);
    const target = positions.get(link.target);
    if (!source || !target) return "";
    return `<line class="edge" x1="${source[0]}" y1="${source[1]}" x2="${target[0]}" y2="${target[1]}" stroke-width="${Math.min(7, 1 + link.weight)}"></line>`;
  });
  const nodeSvg = nodes.map((node) => {
    const [x, y] = positions.get(node.id) || [360, 210];
    const radius = node.type === "person" ? 8 + Math.min(7, (node.risk || node.cases || 1) / 2) : 10;
    const labelX = node.type === "crime" ? x + radius + 6 : x + radius + 5;
    return `<g>
      <circle class="node-halo" cx="${x}" cy="${y}" r="${radius + 8}"></circle>
      <circle class="node-${node.type}" cx="${x}" cy="${y}" r="${radius}" opacity="0.9"></circle>
      <text class="node-label" x="${labelX}" y="${y + 4}">${escapeHtml(node.label).slice(0, 22)}</text>
    </g>`;
  });
  const lanes = [120, 360, 570].map((x) => `<line class="chart-grid" x1="${x}" y1="38" x2="${x}" y2="382"></line>`);
  const bands = [92, 164, 236, 308].map((y) => `<line class="chart-grid" x1="44" y1="${y}" x2="676" y2="${y}"></line>`);
  els.networkGraph.innerHTML = `<rect x="1" y="1" width="718" height="418" rx="8" fill="#0d1718"></rect>
    ${lanes.join("")}${bands.join("")}
    <text class="chart-label" x="64" y="28">PERSONS</text>
    <text class="chart-label" x="304" y="28">STATIONS</text>
    <text class="chart-label" x="518" y="28">CRIME TYPES</text>
    ${links.join("")}${nodeSvg.join("")}`;
}

function renderWarnings(warnings) {
  els.warningList.innerHTML = (warnings || []).map((item) => `
    <article class="warning-item">
      <strong>${escapeHtml(item.area)}</strong>
      <span>${escapeHtml(item.risk)} · ${item.confidence}% confidence</span>
      <span>${escapeHtml(item.rationale)}</span>
      <span>${escapeHtml(item.recommended_action)}</span>
    </article>`).join("");
}

function renderDemographics(demographics) {
  const groups = [
    ["Victim age", demographics.victim_age],
    ["Victim gender", demographics.victim_gender],
    ["Accused age", demographics.accused_age],
    ["Socio-economic", demographics.socioeconomic],
  ];
  const rows = [];
  for (const [title, values] of groups) {
    const max = Math.max(...Object.values(values || {}), 1);
    for (const [label, value] of Object.entries(values || {}).slice(0, 5)) {
      rows.push(`<div class="bar-row">
        <div class="bar-label"><span>${escapeHtml(title)} · ${escapeHtml(label)}</span><strong>${value}</strong></div>
        <div class="bar-track"><span class="bar-fill" style="width:${Math.max(7, (value / max) * 100)}%"></span></div>
      </div>`);
    }
  }
  els.demographicBars.innerHTML = rows.join("");
}

function renderBehaviorProfiles(profiles) {
  if (!profiles?.length) {
    els.behaviorProfiles.innerHTML = `<article class="behavior-item">No behavioral profiles available for the current scope.</article>`;
    return;
  }
  els.behaviorProfiles.innerHTML = profiles.slice(0, 4).map((profile) => {
    const modi = (profile.dominant_modi || [])
      .map((item) => `${escapeHtml(item.label)} (${item.cases})`)
      .join("<br>");
    const tags = (profile.evidence_tags || [])
      .map((tag) => `<span>${escapeHtml(tag)}</span>`)
      .join("");
    const people = (profile.repeat_people || [])
      .map((item) => `${escapeHtml(item.name)} (${item.cases})`)
      .join(", ") || "No repeat links";
    return `<article class="behavior-item">
      <div class="behavior-topline">
        <strong>${escapeHtml(profile.crime_type)}</strong>
        <span>${profile.cases} cases · ${profile.open_cases} open · score ${profile.severity_score}</span>
      </div>
      <p>${escapeHtml(profile.behavior_signal)}</p>
      <div class="mini-grid">
        <div><b>Modus</b><span>${modi}</span></div>
        <div><b>Repeat links</b><span>${people}</span></div>
      </div>
      <div class="chip-row">${tags}</div>
      <small>${escapeHtml(profile.investigative_use)}</small>
    </article>`;
  }).join("");
}

function linkageNodePosition(index, count) {
  const centerX = 380;
  const centerY = 210;
  const radius = count <= 8 ? 140 : 166;
  const angle = ((Math.PI * 2) / Math.max(count, 1)) * index - Math.PI / 2;
  return [centerX + Math.cos(angle) * radius, centerY + Math.sin(angle) * radius];
}

function renderCaseLinkageGraph(graph) {
  const sourceNodes = graph?.nodes || [];
  const sourceLinks = graph?.links || [];
  const strongestLinks = sourceLinks.slice(0, 18);
  const visibleIds = new Set(strongestLinks.flatMap((link) => [link.source, link.target]));
  let nodes = sourceNodes.filter((node) => visibleIds.has(node.id)).slice(0, 16);
  if (!nodes.length) {
    nodes = sourceNodes.slice(0, 12);
  }
  const allowedIds = new Set(nodes.map((node) => node.id));
  const links = strongestLinks.filter((link) => allowedIds.has(link.source) && allowedIds.has(link.target));
  if (!nodes.length) {
    els.caseLinkageGraph.innerHTML = `<rect x="1" y="1" width="758" height="418" rx="8" fill="#0d1718"></rect>
      <text class="chart-label" x="380" y="216" text-anchor="middle">No linked case graph available</text>`;
    return;
  }
  const positions = new Map();
  nodes.forEach((node, index) => positions.set(node.id, linkageNodePosition(index, nodes.length)));
  const edgeSvg = links.map((link) => {
    const source = positions.get(link.source);
    const target = positions.get(link.target);
    if (!source || !target) return "";
    const strength = Math.max(1.2, Math.min(8, link.confidence / 12));
    return `<line class="linkage-edge" x1="${source[0]}" y1="${source[1]}" x2="${target[0]}" y2="${target[1]}" stroke-width="${strength.toFixed(1)}"></line>
      <text class="linkage-confidence" x="${(source[0] + target[0]) / 2}" y="${(source[1] + target[1]) / 2}">${link.confidence}%</text>`;
  });
  const nodeSvg = nodes.map((node) => {
    const [x, y] = positions.get(node.id);
    const statusClass = node.status === "Chargesheeted" ? "closed" : "open";
    const labelX = x < 380 ? x - 20 : x + 20;
    const anchor = x < 380 ? "end" : "start";
    return `<g>
      <circle class="linkage-halo" cx="${x}" cy="${y}" r="24"></circle>
      <circle class="linkage-node ${statusClass}" cx="${x}" cy="${y}" r="14"></circle>
      <text class="node-label" x="${labelX}" y="${y + 4}" text-anchor="${anchor}">${escapeHtml(node.label)}</text>
    </g>`;
  });
  els.caseLinkageGraph.innerHTML = `<rect x="1" y="1" width="758" height="418" rx="8" fill="#0d1718"></rect>
    <circle class="linkage-ring" cx="380" cy="210" r="178"></circle>
    <circle class="linkage-ring inner" cx="380" cy="210" r="94"></circle>
    ${edgeSvg.join("")}${nodeSvg.join("")}`;
}

function renderCaseLinkage(linkage) {
  renderCaseLinkageGraph(linkage?.graph || { nodes: [], links: [] });
  const clusters = linkage?.clusters || [];
  if (!clusters.length) {
    els.caseLinkageClusters.innerHTML = `<article class="linkage-item">No high-confidence linked case clusters found in the current scope.</article>`;
    return;
  }
  els.caseLinkageClusters.innerHTML = clusters.slice(0, 4).map((cluster) => {
    const cases = (cluster.cases || [])
      .slice(0, 5)
      .map((item) => `<span>${escapeHtml(item.case_id)} &middot; ${escapeHtml(item.police_station)} &middot; ${escapeHtml(item.crime_type)}</span>`)
      .join("");
    const evidence = (cluster.evidence_summary || [])
      .map((item) => `<span>${escapeHtml(item.replaceAll("_", " "))}</span>`)
      .join("");
    const strongest = cluster.supporting_links?.[0];
    const strongestText = strongest
      ? `${strongest.source} to ${strongest.target} - ${strongest.confidence}%`
      : "No pair details";
    return `<article class="linkage-item">
      <div class="linkage-topline">
        <strong>${escapeHtml(cluster.cluster_id)}</strong>
        <span>${cluster.confidence}% &middot; ${escapeHtml(cluster.risk_level)} &middot; ${cluster.case_count} cases</span>
      </div>
      <p>${escapeHtml(cluster.proactive_lead)}</p>
      <div class="case-stack">${cases}</div>
      <div class="chip-row">${evidence}</div>
      <small>Strongest pair: ${escapeHtml(strongestText)}</small>
    </article>`;
  }).join("");
}

function renderInvestigationTimeline(activeIndex = 0) {
  const active = investigationTimeline[activeIndex] || investigationTimeline[0];
  const events = investigationTimeline.map((event, index) => `
    <button type="button" class="timeline-event ${index === activeIndex ? "active" : ""}" data-index="${index}">
      <time>${escapeHtml(event.time)}</time>
      <span>${escapeHtml(event.title)}</span>
    </button>`).join("");
  els.timelinePanel.innerHTML = `
    <div class="timeline-rail">${events}</div>
    <article class="timeline-detail">
      <span>${escapeHtml(active.source)}</span>
      <strong>${escapeHtml(active.time)} - ${escapeHtml(active.title)}</strong>
      <p>${escapeHtml(active.detail)}</p>
    </article>`;
  els.timelinePanel.querySelectorAll(".timeline-event").forEach((button) => {
    button.addEventListener("click", () => renderInvestigationTimeline(Number(button.dataset.index || 0)));
  });
}

function renderCopilotBrief(copilot) {
  if (!copilot) {
    els.copilotPanel.innerHTML = `<article class="copilot-empty">Copilot insights will appear automatically after login.</article>`;
    return;
  }
  state.copilot = copilot;
  const insights = (copilot.proactive_insights || []).map((item) => `
    <article class="copilot-insight">
      <span class="priority">${escapeHtml(item.priority)}</span>
      <div>
        <small>${escapeHtml(item.label)}</small>
        <strong>${escapeHtml(item.headline)}</strong>
        <span>${escapeHtml(item.detail)}</span>
      </div>
    </article>`).join("");
  const suspects = (copilot.suspect_leads || []).slice(0, 4).map((lead) => `
    <article class="lead-item">
      <div>
        <strong>${escapeHtml(lead.name)}</strong>
        <span>${escapeHtml(lead.role_signal)} · score ${lead.score} · ${lead.cases} cases · ${lead.open_cases} open</span>
      </div>
      <p>${escapeHtml((lead.reasons || []).slice(0, 3).join("; "))}</p>
      <div class="chip-row">${(lead.evidence_tags || []).slice(0, 4).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>
    </article>`).join("");
  const actions = (copilot.next_actions || []).slice(0, 4).map((action) => `
    <article class="copilot-row">
      <strong>${escapeHtml(action.priority)} · ${escapeHtml(action.title)}</strong>
      <span>${escapeHtml(action.reason)}</span>
      <small>${escapeHtml(action.action)}</small>
    </article>`).join("");
  const relationships = (copilot.hidden_relationships || []).slice(0, 4).map((item) => `
    <article class="copilot-row">
      <strong>${escapeHtml(item.title)}</strong>
      <span>${escapeHtml(item.reason)}</span>
      <small>${escapeHtml(item.next_step)}</small>
    </article>`).join("");
  const anomalies = (copilot.anomalies || []).slice(0, 4).map((item) => `
    <article class="copilot-row ${item.severity === "high" ? "hot" : ""}">
      <strong>${escapeHtml(item.title)}</strong>
      <span>${escapeHtml(item.reason)}</span>
      <small>${escapeHtml(item.recommended_check)}</small>
    </article>`).join("");
  const deployments = (copilot.resource_deployments || []).slice(0, 4).map((item) => `
    <article class="copilot-row">
      <strong>${escapeHtml(item.area)}</strong>
      <span>${escapeHtml(item.resource)} · ${escapeHtml(item.timing)}</span>
      <small>${escapeHtml(item.reason)}</small>
    </article>`).join("");
  const reasoning = (copilot.reasoning || [])
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
  els.copilotPanel.innerHTML = `
    <div class="copilot-brief">
      <div>
        <span class="agent-status">${escapeHtml(copilot.status)} · ${copilot.confidence}% confidence</span>
        <strong>${escapeHtml(copilot.name)}</strong>
        <p>${escapeHtml(copilot.intelligence_summary)}</p>
      </div>
      <div class="agent-meta">
        <span>${escapeHtml(copilot.run_id)}</span>
        <span>${copilot.records_considered} records</span>
        <span>${escapeHtml(copilot.objective)}</span>
      </div>
    </div>
    <div class="copilot-insight-grid">${insights}</div>
    <div class="copilot-section-grid">
      <section><h3>Suggested Suspects</h3>${suspects}</section>
      <section><h3>Next Actions</h3>${actions}</section>
      <section><h3>Hidden Relationships</h3>${relationships}</section>
      <section><h3>Anomalies</h3>${anomalies}</section>
      <section><h3>Resource Deployment</h3>${deployments}</section>
      <section><h3>Reasoning</h3><ol class="reasoning-list">${reasoning}</ol></section>
    </div>`;
}

function renderAgentBrief(agent) {
  if (!agent) {
    els.agentPanel.innerHTML = `<article class="agent-empty">Run the agent to generate a prioritized action queue.</article>`;
    return;
  }
  state.agent = agent;
  const actions = (agent.action_queue || []).map((action) => `
    <article class="agent-action">
      <span class="priority">${escapeHtml(action.priority)}</span>
      <div>
        <strong>${escapeHtml(action.title)}</strong>
        <span>${escapeHtml(action.rationale)}</span>
        <small>${escapeHtml(action.next_step)}</small>
      </div>
    </article>`).join("");
  const watchlist = (agent.watchlist || []).map((item) => `
    <article class="watch-item">
      <strong>${escapeHtml(item.label)}</strong>
      <span>${escapeHtml(item.signal)}</span>
      <small>${item.cases} cases · ${item.open_cases} open</small>
    </article>`).join("");
  const trace = (agent.explainability || [])
    .map((item) => `<span>${escapeHtml(item)}</span>`)
    .join("");
  els.agentPanel.innerHTML = `
    <div class="agent-brief">
      <div>
        <span class="agent-status">${escapeHtml(agent.status)} · ${agent.confidence}% confidence</span>
        <strong>${escapeHtml(agent.name)}</strong>
        <p>${escapeHtml(agent.mission_brief)}</p>
      </div>
      <div class="agent-meta">
        <span>${escapeHtml(agent.run_id)}</span>
        <span>${agent.records_considered} records</span>
        <span>${agent.open_cases} open</span>
      </div>
    </div>
    <div class="agent-grid">
      <div class="agent-column">
        <h3>Action Queue</h3>
        ${actions}
      </div>
      <div class="agent-column">
        <h3>Watchlist</h3>
        ${watchlist}
      </div>
    </div>
    <div class="agent-trace">${trace}</div>`;
}

function renderAudit(audit, sources = []) {
  if (!audit) {
    els.auditPanel.innerHTML = `<article class="audit-item">Ask a question to see filters, source cases, and guardrails.</article>`;
    return;
  }
  const sourceText = sources.length
    ? sources.map((item) => `${item.case_id} · ${item.police_station} · ${item.crime_type}`).join("\n")
    : "No source cases returned";
  els.auditPanel.innerHTML = `<article class="audit-item">
    <code>audit_id: ${escapeHtml(audit.audit_id)}
intent: ${escapeHtml(audit.intent)}
filters: ${escapeHtml(JSON.stringify(audit.filters))}
records: ${audit.records_returned}/${audit.records_considered}
guardrails: ${escapeHtml(audit.guardrails.join(", "))}</code>
  </article>
  <article class="audit-item"><code>${escapeHtml(sourceText)}</code></article>`;
}

function renderAnalytics(data) {
  state.analytics = data;
  renderKpis(data);
  renderHotspots(data.hotspots || []);
  renderTrend(data.trends || []);
  renderNetwork(data.network || { nodes: [], links: [] });
  renderWarnings(data.warnings || []);
  renderDemographics(data.demographics || {});
  renderBehaviorProfiles(data.behavior_profiles || []);
  renderCaseLinkage(data.case_linkage || { clusters: [], graph: { nodes: [], links: [] } });
  renderInvestigationTimeline();
  renderCopilotBrief(data.copilot_brief);
  renderAgentBrief(data.agent_brief);
  renderAudit(state.latestAudit);
}

async function refreshAnalytics() {
  const data = await api("/api/analytics");
  renderAnalytics(data);
}

async function runAgent() {
  els.agentButton.disabled = true;
  els.agentButton.textContent = "Running";
  try {
    const agent = await api("/api/agent/run", {
      method: "POST",
      body: JSON.stringify({ objective: "operational_triage" }),
    });
    renderAgentBrief(agent);
    if (agent.audit) {
      state.latestAudit = agent.audit;
      renderAudit(agent.audit);
    }
  } finally {
    els.agentButton.disabled = false;
    els.agentButton.textContent = "Run Agent";
  }
}

async function runCopilot() {
  els.copilotButton.disabled = true;
  els.copilotButton.textContent = "Refreshing";
  try {
    const copilot = await api("/api/copilot/brief", {
      method: "POST",
      body: JSON.stringify({ objective: "proactive_intelligence_watch" }),
    });
    renderCopilotBrief(copilot);
    if (copilot.audit) {
      state.latestAudit = copilot.audit;
      renderAudit(copilot.audit);
    }
  } finally {
    els.copilotButton.disabled = false;
    els.copilotButton.textContent = "Refresh Copilot";
  }
}

async function login(profile) {
  const payload = await api("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ profile }),
  });
  state.token = payload.token;
  state.user = payload.user;
  state.conversation = [];
  state.latestAudit = null;

  els.sessionRole.textContent = `${formatRole(state.user.role)} · ${state.user.badge_id}`;
  els.scopeLabel.textContent = `Scope: ${state.user.district_scope.join(", ")}`;
  els.messages.innerHTML = "";
  addMessage(
    "assistant",
    `Logged in as ${state.user.name}. The copilot is already watching for leads, anomalies, hidden relationships, deployment needs, and reasoning. You can also ask for case linkage, hotspots, trends, networks, behavioral profiles, demographics, early warnings, or the investigator agent.`,
    "Synthetic records only. Validate operational leads in approved systems."
  );
  await refreshAnalytics();
  els.loginView.hidden = true;
  els.appView.hidden = false;
}

async function sendChat(message) {
  addMessage("user", message);
  els.chatInput.value = "";
  const response = await api("/api/chat", {
    method: "POST",
    body: JSON.stringify({
      message,
      language: currentLanguage(),
      conversation: state.conversation.slice(-12),
    }),
  });
  state.latestAudit = response.audit;
  addMessage("assistant", response.answer, `Audit ${response.audit.audit_id} · Intent ${response.intent}`);
  renderAudit(response.audit, response.sources);
  if (response.analytics_patch?.hotspots?.length) {
    renderHotspots(response.analytics_patch.hotspots);
  }
  if (response.analytics_patch?.trends?.length) {
    renderTrend(response.analytics_patch.trends);
  }
  if (response.analytics_patch?.warnings?.length) {
    renderWarnings(response.analytics_patch.warnings);
  }
  if (response.analytics_patch?.behavior_profiles?.length) {
    renderBehaviorProfiles(response.analytics_patch.behavior_profiles);
  }
  if (response.analytics_patch?.case_linkage) {
    renderCaseLinkage(response.analytics_patch.case_linkage);
  }
  if (response.agent || response.analytics_patch?.agent_brief) {
    renderAgentBrief(response.agent || response.analytics_patch.agent_brief);
  }
  if (response.copilot || response.analytics_patch?.copilot_brief) {
    renderCopilotBrief(response.copilot || response.analytics_patch.copilot_brief);
  }
}

function setupVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    els.voiceButton.disabled = true;
    els.voiceButton.title = "Voice input is not available in this browser";
    return;
  }
  state.recognition = new SpeechRecognition();
  state.recognition.continuous = false;
  state.recognition.interimResults = false;
  state.recognition.onresult = (event) => {
    const transcript = event.results?.[0]?.[0]?.transcript || "";
    els.chatInput.value = transcript;
    els.chatInput.focus();
  };
  state.recognition.onend = () => {
    els.voiceButton.classList.remove("recording");
  };
}

async function exportIntelligenceReport() {
  const payload = await api("/api/report", {
    method: "POST",
    body: JSON.stringify({ report: "organized_vehicle_theft_intelligence" }),
  });
  const win = window.open("", "_blank");
  if (!win) {
    throw new Error("Popup blocked. Allow popups to print the intelligence report.");
  }
  win.document.write(payload.html);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 300);
  state.latestAudit = {
    audit_id: payload.audit_id,
    intent: "intelligence_report",
    filters: { report: "organized_vehicle_theft_intelligence" },
    records_returned: 11,
    records_considered: state.analytics?.record_count || 0,
    guardrails: ["export_permission", "synthetic_data_notice", "print_pdf_user_action"],
  };
  renderAudit(state.latestAudit);
}

function logout() {
  state.token = null;
  state.user = null;
  state.analytics = null;
  state.agent = null;
  state.copilot = null;
  state.conversation = [];
  els.appView.hidden = true;
  els.loginView.hidden = false;
}

function wireEvents() {
  document.querySelectorAll(".profile-button").forEach((button) => {
    button.addEventListener("click", async () => {
      const buttons = [...document.querySelectorAll(".profile-button")];
      buttons.forEach((item) => {
        item.disabled = true;
      });
      try {
        await login(button.dataset.profile);
        setHealth(true, "API online");
      } catch (error) {
        state.token = null;
        state.user = null;
        setHealth(false, "Login failed");
        alert(`Login failed: ${error.message}`);
      } finally {
        buttons.forEach((item) => {
          item.disabled = false;
        });
      }
    });
  });

  els.chatForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = els.chatInput.value.trim();
    if (!message) return;
    try {
      await sendChat(message);
    } catch (error) {
      addMessage("assistant", `Request failed: ${error.message}`);
    }
  });

  els.voiceButton.addEventListener("click", () => {
    if (!state.recognition) return;
    state.recognition.lang = currentLanguage() === "kn" ? "kn-IN" : "en-IN";
    els.voiceButton.classList.add("recording");
    state.recognition.start();
  });

  els.exportButton.addEventListener("click", async () => {
    try {
      await exportIntelligenceReport();
    } catch (error) {
      addMessage("assistant", `Report generation failed: ${error.message}`);
    }
  });

  els.refreshButton.addEventListener("click", async () => {
    try {
      await refreshAnalytics();
    } catch (error) {
      setHealth(false, error.message);
    }
  });

  els.agentButton.addEventListener("click", async () => {
    try {
      await runAgent();
    } catch (error) {
      addMessage("assistant", `Agent failed: ${error.message}`);
    }
  });

  els.copilotButton.addEventListener("click", async () => {
    try {
      await runCopilot();
    } catch (error) {
      addMessage("assistant", `Copilot failed: ${error.message}`);
    }
  });

  els.logoutButton.addEventListener("click", logout);
}

async function checkHealth() {
  try {
    await api("/api/health");
    setHealth(true, "API online");
  } catch {
    setHealth(false, "API offline");
  }
}

renderLoginPulse();
renderPrompts();
setupVoice();
wireEvents();
checkHealth();
