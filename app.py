#!/usr/bin/env python3
"""Local prototype server for the KSP SCRB conversational intelligence platform.

The demo intentionally uses a deterministic analytics engine and synthetic data.
Production deployments should replace the data access layer with approved SCRB
systems and put the LLM behind the policy, audit, and retrieval controls
described in docs/ARCHITECTURE.md.
"""

from __future__ import annotations

import argparse
import html
import json
import math
import re
import secrets
from collections import Counter, defaultdict
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


ROOT_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT_DIR / "public"
DATA_PATH = ROOT_DIR / "data" / "crime_records.json"
AUDIT_PATH = ROOT_DIR / "data" / "audit_log.jsonl"

SEVERITY_POINTS = {"Low": 1, "Medium": 2, "High": 4, "Critical": 7}

DEMO_USERS = {
    "investigator": {
        "badge_id": "KSP-INV-0142",
        "name": "Inspector Asha Rao",
        "role": "investigator",
        "district_scope": ["Bengaluru City", "Mysuru", "Mangaluru", "Tumakuru"],
        "permissions": ["chat", "analytics", "network", "agent", "copilot", "linkage", "export"],
    },
    "analyst": {
        "badge_id": "SCRB-ANL-0021",
        "name": "Crime Analyst R. Menon",
        "role": "analyst",
        "district_scope": ["statewide"],
        "permissions": ["chat", "analytics", "agent", "copilot", "linkage", "export"],
    },
    "supervisor": {
        "badge_id": "SCRB-SUP-0007",
        "name": "DySP Kavitha Shetty",
        "role": "supervisor",
        "district_scope": ["statewide"],
        "permissions": ["chat", "analytics", "network", "agent", "copilot", "linkage", "audit", "export"],
    },
}

SESSIONS: dict[str, dict[str, Any]] = {}

CRIME_ALIASES = {
    "theft": "Theft",
    "vehicle theft": "Vehicle Theft",
    "bike theft": "Vehicle Theft",
    "burglary": "Burglary",
    "robbery": "Robbery",
    "chain": "Chain Snatching",
    "snatching": "Chain Snatching",
    "cyber": "Cyber Fraud",
    "fraud": "Cyber Fraud",
    "upi": "Cyber Fraud",
    "narcotic": "Narcotics",
    "ndps": "Narcotics",
    "assault": "Assault",
    "murder": "Murder",
    "homicide": "Murder",
    "missing": "Missing Person",
    "kidnap": "Kidnapping",
    "kidnapping": "Kidnapping",
    "ಕಳವು": "Theft",
    "ಸೈಬರ್": "Cyber Fraud",
    "ಮೋಸ": "Cyber Fraud",
    "ದರೋಡೆ": "Robbery",
    "ಹತ್ಯೆ": "Murder",
    "ಮಾದಕ": "Narcotics",
}

KANNADA_INTENT_WORDS = {
    "hotspot": ["ಹಾಟ್", "ಪ್ರದೇಶ", "ಸ್ಥಳ", "ಕೇಂದ್ರ"],
    "trend": ["ಪ್ರವೃತ್ತಿ", "ಹೆಚ್ಚಳ", "ಕಡಿಮೆಯಾಗಿದೆ", "ತಿಂಗಳು"],
    "network": ["ಜಾಲ", "ಸಂಬಂಧ", "ಗುಂಪು"],
    "prediction": ["ಎಚ್ಚರಿಕೆ", "ಮುನ್ನೆಚ್ಚರಿಕೆ", "ಭವಿಷ್ಯ"],
    "demographic": ["ವಯಸ್ಸು", "ಲಿಂಗ", "ಸಾಮಾಜಿಕ"],
    "behavior": ["ವರ್ತನೆ", "ನಡವಳಿಕೆ", "ವಿಧಾನ", "ಮೋಡಸ್"],
    "agent": ["ಏಜೆಂಟ್", "ಕಾರ್ಯ", "ಯೋಜನೆ", "ಮುನ್ನಡೆ"],
    "copilot": ["ಕೋಪೈಲಟ್", "ಸಹಾಯಕ", "ಶಂಕಿತ", "ಸಾರಾಂಶ", "ಸಂಪನ್ಮೂಲ"],
}


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def load_records() -> list[dict[str, Any]]:
    with DATA_PATH.open(encoding="utf-8") as handle:
        payload = json.load(handle)
    return payload["records"]


def is_kannada(text: str) -> bool:
    return any("\u0c80" <= char <= "\u0cff" for char in text)


def public_user(user: dict[str, Any]) -> dict[str, Any]:
    return {
        "badge_id": user["badge_id"],
        "name": user["name"],
        "role": user["role"],
        "district_scope": user["district_scope"],
        "permissions": user["permissions"],
    }


def month_key(record: dict[str, Any]) -> str:
    return record["date"][:7]


def age_band(age: int | None) -> str:
    if age is None:
        return "Unknown"
    if age < 18:
        return "Under 18"
    if age <= 25:
        return "18-25"
    if age <= 40:
        return "26-40"
    if age <= 60:
        return "41-60"
    return "60+"


def severity_value(record: dict[str, Any]) -> int:
    return SEVERITY_POINTS.get(record.get("severity", "Low"), 1)


def user_scoped_records(records: list[dict[str, Any]], user: dict[str, Any]) -> list[dict[str, Any]]:
    scope = user.get("district_scope", [])
    if "statewide" in scope:
        return records
    return [record for record in records if record["district"] in scope]


def derive_filters(
    message: str,
    records: list[dict[str, Any]],
    conversation: list[dict[str, str]] | None = None,
) -> dict[str, str]:
    text = message.lower()
    history_text = " ".join(item.get("content", "") for item in (conversation or [])[-6:]).lower()
    contextual_text = f"{text} {history_text if any(word in text for word in ['same', 'there', 'that', 'ಅದೇ']) else ''}"

    filters: dict[str, str] = {}

    for district in sorted({record["district"] for record in records}, key=len, reverse=True):
        if district.lower() in contextual_text:
            filters["district"] = district
            break

    for station in sorted({record["police_station"] for record in records}, key=len, reverse=True):
        if station.lower() in contextual_text:
            filters["police_station"] = station
            break

    for alias, crime_type in CRIME_ALIASES.items():
        if alias in contextual_text:
            filters["crime_type"] = crime_type
            break

    if any(word in text for word in ["recent", "latest", "this month", "current", "ಈ ತಿಂಗಳು"]):
        latest = max(month_key(record) for record in records)
        filters["month"] = latest

    return filters


def apply_filters(records: list[dict[str, Any]], filters: dict[str, str]) -> list[dict[str, Any]]:
    filtered = records
    if "district" in filters:
        filtered = [record for record in filtered if record["district"] == filters["district"]]
    if "police_station" in filters:
        filtered = [record for record in filtered if record["police_station"] == filters["police_station"]]
    if "crime_type" in filters:
        filtered = [record for record in filtered if record["crime_type"] == filters["crime_type"]]
    if "month" in filters:
        filtered = [record for record in filtered if month_key(record) == filters["month"]]
    return filtered


def detect_intent(message: str) -> str:
    text = message.lower()
    if any(
        word in text
        for word in [
            "case linkage",
            "linked cases",
            "case cluster",
            "case clusters",
            "hidden relationship",
            "hidden relationships",
            "connect cases",
            "connections between cases",
            "linkage engine",
        ]
    ):
        return "linkage"
    if any(
        word in text
        for word in [
            "copilot",
            "suspect",
            "suspects",
            "anomaly",
            "anomalies",
            "resource deployment",
            "deploy",
            "intelligence summary",
            "investigation brief",
            "reasoning",
        ]
    ):
        return "copilot"
    if any(word in text for word in ["agent", "triage", "action queue", "task plan", "mission", "next steps"]):
        return "agent"
    if any(word in text for word in ["hotspot", "cluster", "map", "where", "station", "beat"]):
        return "hotspot"
    if any(word in text for word in ["network", "link", "associate", "gang", "repeat", "relationship"]):
        return "network"
    if any(word in text for word in ["trend", "increase", "decrease", "month", "compare", "rising"]):
        return "trend"
    if any(word in text for word in ["predict", "warning", "risk", "forecast", "prevent", "early"]):
        return "prediction"
    if any(
        word in text
        for word in ["behavior", "behaviour", "behavioral", "modus", "m.o.", "method", "offender pattern", "target selection"]
    ):
        return "behavior"
    if any(word in text for word in ["age", "gender", "socio", "profile", "demographic", "victim"]):
        return "demographic"
    for intent, words in KANNADA_INTENT_WORDS.items():
        if any(word in message for word in words):
            return intent
    return "summary"


def aggregate_trends(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    monthly: dict[str, Counter[str]] = defaultdict(Counter)
    for record in records:
        monthly[month_key(record)][record["crime_type"]] += 1
    return [
        {
            "month": month,
            "total": sum(counter.values()),
            "types": dict(counter.most_common()),
        }
        for month, counter in sorted(monthly.items())
    ]


def aggregate_hotspots(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    latest = max((month_key(record) for record in records), default="")
    stations: dict[str, dict[str, Any]] = {}
    for record in records:
        key = f"{record['district']}::{record['police_station']}"
        if key not in stations:
            stations[key] = {
                "district": record["district"],
                "police_station": record["police_station"],
                "latitude": record["latitude"],
                "longitude": record["longitude"],
                "cases": 0,
                "open_cases": 0,
                "severity": 0,
                "recent_cases": 0,
                "crime_mix": Counter(),
            }
        station = stations[key]
        station["cases"] += 1
        station["open_cases"] += int(record["status"] != "Chargesheeted")
        station["severity"] += severity_value(record)
        station["recent_cases"] += int(month_key(record) == latest)
        station["crime_mix"][record["crime_type"]] += 1

    hotspots = []
    for station in stations.values():
        score = station["cases"] * 10 + station["severity"] * 3 + station["open_cases"] * 4 + station["recent_cases"] * 5
        hotspots.append(
            {
                "district": station["district"],
                "police_station": station["police_station"],
                "latitude": station["latitude"],
                "longitude": station["longitude"],
                "cases": station["cases"],
                "open_cases": station["open_cases"],
                "score": score,
                "top_crime": station["crime_mix"].most_common(1)[0][0],
                "crime_mix": dict(station["crime_mix"].most_common()),
            }
        )
    return sorted(hotspots, key=lambda item: item["score"], reverse=True)


def aggregate_demographics(records: list[dict[str, Any]]) -> dict[str, Any]:
    victim_age = Counter(age_band(record.get("victim_age")) for record in records)
    victim_gender = Counter(record.get("victim_gender", "Unknown") for record in records)
    accused_age = Counter(age_band(record.get("accused_age")) for record in records)
    socioeconomic = Counter(record.get("socioeconomic_indicator", "Unknown") for record in records)
    return {
        "victim_age": dict(victim_age.most_common()),
        "victim_gender": dict(victim_gender.most_common()),
        "accused_age": dict(accused_age.most_common()),
        "socioeconomic": dict(socioeconomic.most_common()),
    }


def aggregate_behavior_profiles(records: list[dict[str, Any]], mask_people: bool) -> list[dict[str, Any]]:
    person_lookup: dict[str, str] = {}
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in records:
        grouped[record["crime_type"]].append(record)

    profiles: list[dict[str, Any]] = []
    for crime_type, group in grouped.items():
        modus = Counter(record.get("modus_operandi", "Unknown") for record in group)
        evidence = Counter(tag for record in group for tag in record.get("evidence_tags", []))
        beats = Counter(f"{record['police_station']} · {record['beat']}" for record in group)
        accused_age = Counter(age_band(record.get("accused_age")) for record in group)
        accused_gender = Counter(record.get("accused_gender", "Unknown") for record in group)
        people = Counter(name for record in group for name in record.get("suspects", []) + record.get("associates", []))
        severity_score = sum(severity_value(record) for record in group)
        open_cases = sum(1 for record in group if record["status"] != "Chargesheeted")
        repeat_people = [
            {
                "name": masked_label(name, person_lookup) if mask_people else name,
                "cases": count,
            }
            for name, count in people.most_common(4)
        ]
        top_evidence = [tag for tag, _ in evidence.most_common(5)]
        if crime_type == "Cyber Fraud":
            signal = "Digitally mediated social-engineering pattern with wallet, call-detail, and mule-account evidence."
        elif crime_type in {"Vehicle Theft", "Chain Snatching"}:
            signal = "Mobility-led offender behavior; patrol timing, CCTV continuity, and vehicle traces are high-value."
        elif crime_type in {"Narcotics", "Robbery"}:
            signal = "Repeat-location and associate-link behavior; informer tasking and inter-station coordination matter."
        else:
            signal = "Repeat method and evidence-tag convergence indicate cases that should be reviewed together."
        profiles.append(
            {
                "crime_type": crime_type,
                "cases": len(group),
                "open_cases": open_cases,
                "severity_score": severity_score,
                "dominant_modi": [
                    {"label": label, "cases": count}
                    for label, count in modus.most_common(3)
                ],
                "evidence_tags": top_evidence,
                "beats": dict(beats.most_common(4)),
                "accused_age": dict(accused_age.most_common(3)),
                "accused_gender": dict(accused_gender.most_common(3)),
                "repeat_people": repeat_people,
                "behavior_signal": signal,
                "investigative_use": "Use as a lead-prioritization profile only; verify identity and evidence in approved systems.",
            }
        )

    return sorted(profiles, key=lambda item: (item["open_cases"], item["severity_score"], item["cases"]), reverse=True)


def masked_label(name: str, lookup: dict[str, str]) -> str:
    if name not in lookup:
        lookup[name] = f"Person {len(lookup) + 1}"
    return lookup[name]


def aggregate_network(records: list[dict[str, Any]], mask_people: bool) -> dict[str, Any]:
    person_lookup: dict[str, str] = {}
    node_map: dict[str, dict[str, Any]] = {}
    edges: Counter[tuple[str, str]] = Counter()

    def person_id(name: str) -> str:
        return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")

    def add_person(name: str, record: dict[str, Any], source: str = "suspect") -> str:
        identifier = person_id(name)
        label = masked_label(name, person_lookup) if mask_people else name
        if identifier not in node_map:
            node_map[identifier] = {
                "id": identifier,
                "label": label,
                "type": "person",
                "source": source,
                "cases": 0,
                "risk": 0,
            }
        node_map[identifier]["cases"] += 1
        node_map[identifier]["risk"] += severity_value(record)
        return identifier

    for record in records:
        station_id = re.sub(r"[^a-z0-9]+", "-", record["police_station"].lower()).strip("-")
        crime_id = re.sub(r"[^a-z0-9]+", "-", record["crime_type"].lower()).strip("-")
        node_map.setdefault(
            station_id,
            {"id": station_id, "label": record["police_station"], "type": "station", "cases": 0, "risk": 0},
        )
        node_map.setdefault(
            crime_id,
            {"id": crime_id, "label": record["crime_type"], "type": "crime", "cases": 0, "risk": 0},
        )
        node_map[station_id]["cases"] += 1
        node_map[crime_id]["cases"] += 1
        suspects = [add_person(name, record) for name in record.get("suspects", [])]
        associates = [add_person(name, record, "associate") for name in record.get("associates", [])]
        for suspect in suspects:
            edges[(suspect, station_id)] += 1
            edges[(suspect, crime_id)] += 1
            for associate in associates:
                edges[tuple(sorted((suspect, associate)))] += 1
        for index, first in enumerate(suspects):
            for second in suspects[index + 1 :]:
                edges[tuple(sorted((first, second)))] += 1

    nodes = sorted(node_map.values(), key=lambda item: (item["type"] != "person", -item.get("risk", 0), item["label"]))[:36]
    allowed_ids = {node["id"] for node in nodes}
    links = [
        {"source": source, "target": target, "weight": weight}
        for (source, target), weight in edges.most_common(60)
        if source in allowed_ids and target in allowed_ids
    ]
    return {"nodes": nodes, "links": links}


def aggregate_warnings(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    warnings = []
    for hotspot in aggregate_hotspots(records)[:5]:
        confidence = min(92, 56 + hotspot["score"] // 3)
        if hotspot["top_crime"] in {"Cyber Fraud", "Vehicle Theft", "Chain Snatching"}:
            action = "Increase digital complaint triage, beat patrols, and targeted public advisories."
        elif hotspot["top_crime"] in {"Narcotics", "Robbery"}:
            action = "Prioritize plain-clothes surveillance, informer tasking, and inter-station coordination."
        else:
            action = "Run evening beat saturation and review open-case linkages."
        warnings.append(
            {
                "area": f"{hotspot['police_station']}, {hotspot['district']}",
                "risk": hotspot["top_crime"],
                "confidence": confidence,
                "rationale": f"{hotspot['cases']} matching cases, {hotspot['open_cases']} open, severity score {hotspot['score']}.",
                "recommended_action": action,
            }
        )
    return warnings


def build_suspect_leads(records: list[dict[str, Any]], mask_people: bool) -> list[dict[str, Any]]:
    person_lookup: dict[str, str] = {}
    people: dict[str, dict[str, Any]] = {}

    def display_name(name: str) -> str:
        return masked_label(name, person_lookup) if mask_people else name

    for record in records:
        case_people = list(dict.fromkeys(record.get("suspects", []) + record.get("associates", [])))
        for name in case_people:
            key = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
            if key not in people:
                people[key] = {
                    "name": display_name(name),
                    "cases": 0,
                    "open_cases": 0,
                    "severity_score": 0,
                    "suspect_mentions": 0,
                    "associate_mentions": 0,
                    "crime_mix": Counter(),
                    "stations": Counter(),
                    "districts": Counter(),
                    "evidence": Counter(),
                    "linked_people": Counter(),
                }
            lead = people[key]
            lead["cases"] += 1
            lead["open_cases"] += int(record["status"] != "Chargesheeted")
            lead["severity_score"] += severity_value(record)
            lead["suspect_mentions"] += int(name in record.get("suspects", []))
            lead["associate_mentions"] += int(name in record.get("associates", []))
            lead["crime_mix"][record["crime_type"]] += 1
            lead["stations"][record["police_station"]] += 1
            lead["districts"][record["district"]] += 1
            lead["evidence"].update(record.get("evidence_tags", []))
            for other in case_people:
                if other != name:
                    lead["linked_people"][display_name(other)] += 1

    scored = []
    for lead in people.values():
        score = (
            lead["cases"] * 12
            + lead["open_cases"] * 8
            + lead["severity_score"] * 4
            + len(lead["crime_mix"]) * 4
            + len(lead["stations"]) * 3
            + lead["suspect_mentions"] * 2
        )
        top_crime = lead["crime_mix"].most_common(1)[0][0] if lead["crime_mix"] else "Unknown"
        reasons = [
            f"{lead['cases']} linked synthetic records",
            f"{lead['open_cases']} open cases",
            f"severity score {lead['severity_score']}",
            f"dominant pattern: {top_crime}",
        ]
        if len(lead["stations"]) > 1:
            reasons.append(f"appears across {len(lead['stations'])} police stations")
        if lead["linked_people"]:
            linked_name, linked_count = lead["linked_people"].most_common(1)[0]
            reasons.append(f"strongest observed link: {linked_name} ({linked_count})")
        scored.append(
            {
                "name": lead["name"],
                "score": score,
                "cases": lead["cases"],
                "open_cases": lead["open_cases"],
                "role_signal": "suspect" if lead["suspect_mentions"] >= lead["associate_mentions"] else "associate",
                "crime_types": dict(lead["crime_mix"].most_common(4)),
                "stations": dict(lead["stations"].most_common(4)),
                "districts": dict(lead["districts"].most_common(3)),
                "evidence_tags": [tag for tag, _ in lead["evidence"].most_common(5)],
                "linked_people": [
                    {"name": name, "cases": count}
                    for name, count in lead["linked_people"].most_common(4)
                ],
                "reasons": reasons,
                "caution": "Lead suggestion only; verify identity, custody history, and evidence in approved systems.",
            }
        )

    return sorted(scored, key=lambda item: item["score"], reverse=True)[:6]


def identify_hidden_relationships(records: list[dict[str, Any]], mask_people: bool) -> list[dict[str, Any]]:
    person_lookup: dict[str, str] = {}
    person_pairs: Counter[tuple[str, str]] = Counter()
    station_crime: Counter[tuple[str, str]] = Counter()
    evidence_crime: Counter[tuple[str, str]] = Counter()

    def display_name(name: str) -> str:
        return masked_label(name, person_lookup) if mask_people else name

    for record in records:
        names = sorted({display_name(name) for name in record.get("suspects", []) + record.get("associates", [])})
        for index, first in enumerate(names):
            for second in names[index + 1 :]:
                person_pairs[(first, second)] += 1
        station_crime[(record["police_station"], record["crime_type"])] += 1
        for tag in record.get("evidence_tags", []):
            evidence_crime[(tag, record["crime_type"])] += 1

    relationships = []
    for (first, second), count in person_pairs.most_common(5):
        relationships.append(
            {
                "type": "person_link",
                "title": f"{first} ↔ {second}",
                "strength": count,
                "reason": "Co-occurs in the same synthetic case records or suspect-associate lists.",
                "next_step": "Compare FIR timelines, device identifiers, custody history, and call-detail records.",
            }
        )
    for (station, crime_type), count in station_crime.most_common(4):
        if count > 1:
            relationships.append(
                {
                    "type": "station_pattern",
                    "title": f"{station} ↔ {crime_type}",
                    "strength": count,
                    "reason": "Repeated station-crime pairing suggests a local operating pattern.",
                    "next_step": "Review beat timing, CCTV continuity, complainant clusters, and local intelligence inputs.",
                }
            )
    for (tag, crime_type), count in evidence_crime.most_common(4):
        if count > 1:
            relationships.append(
                {
                    "type": "evidence_pattern",
                    "title": f"{tag} evidence ↔ {crime_type}",
                    "strength": count,
                    "reason": "Evidence tag repeatedly appears with the same crime type.",
                    "next_step": "Cluster cases by evidence tag before assigning technical or field resources.",
                }
            )
    return sorted(relationships, key=lambda item: item["strength"], reverse=True)[:8]


TOKEN_STOPWORDS = {
    "after",
    "during",
    "from",
    "near",
    "through",
    "used",
    "with",
    "case",
    "cases",
    "repeat",
    "prior",
    "late",
    "early",
    "fake",
    "local",
}

VEHICLE_TERMS = {
    "vehicle",
    "bike",
    "two-wheeler",
    "scooter",
    "motorcycle",
    "cab",
    "parking",
    "pillion",
    "riders",
    "dismantling",
    "parts-market",
}

COMMUNICATION_TERMS = {
    "call",
    "call-detail",
    "phone",
    "telegram",
    "encrypted-chat",
    "social-media",
    "messaging",
    "remote-access",
    "portal",
    "upi",
    "wallet",
    "bank-account",
    "credential",
    "contact",
    "app",
}


def text_tokens(value: str) -> set[str]:
    tokens = set()
    for token in re.findall(r"[a-z0-9]+", value.lower()):
        if token in {"upi", "cab", "ndps"} or (len(token) > 3 and token not in TOKEN_STOPWORDS):
            tokens.add(token)
    return tokens


def profile_terms(record: dict[str, Any], terms: set[str]) -> set[str]:
    searchable = " ".join([record.get("modus_operandi", ""), *record.get("evidence_tags", [])]).lower()
    found = set()
    for term in terms:
        if term in searchable:
            found.add(term)
    return found


def case_profile(record: dict[str, Any]) -> dict[str, Any]:
    date = datetime.fromisoformat(record["date"])
    people = set(record.get("suspects", []) + record.get("associates", []))
    evidence = set(record.get("evidence_tags", []))
    return {
        "id": record["id"],
        "date": date,
        "modus_tokens": text_tokens(record.get("modus_operandi", "")),
        "evidence": evidence,
        "vehicle_terms": profile_terms(record, VEHICLE_TERMS),
        "communication_terms": profile_terms(record, COMMUNICATION_TERMS),
        "people": people,
        "victim": {
            "age_band": age_band(record.get("victim_age")),
            "gender": record.get("victim_gender", "Unknown"),
            "socio": record.get("socioeconomic_indicator", "Unknown"),
        },
        "suspect": {
            "age_band": age_band(record.get("accused_age")),
            "gender": record.get("accused_gender", "Unknown"),
        },
    }


def geo_distance_km(first: dict[str, Any], second: dict[str, Any]) -> float:
    lat1 = math.radians(first["latitude"])
    lon1 = math.radians(first["longitude"])
    lat2 = math.radians(second["latitude"])
    lon2 = math.radians(second["longitude"])
    delta_lat = lat2 - lat1
    delta_lon = lon2 - lon1
    value = math.sin(delta_lat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2) ** 2
    return 6371 * 2 * math.atan2(math.sqrt(value), math.sqrt(1 - value))


def shared_names(names: set[str], person_lookup: dict[str, str], mask_people: bool) -> list[str]:
    if not mask_people:
        return sorted(names)
    return [masked_label(name, person_lookup) for name in sorted(names)]


def score_case_pair(
    first: dict[str, Any],
    second: dict[str, Any],
    first_profile: dict[str, Any],
    second_profile: dict[str, Any],
    person_lookup: dict[str, str],
    mask_people: bool,
) -> dict[str, Any] | None:
    score = 0.0
    evidence: list[dict[str, Any]] = []

    if first["crime_type"] == second["crime_type"]:
        score += 6
        evidence.append({"dimension": "case_context", "weight": 6, "detail": f"Same crime type: {first['crime_type']}."})

    shared_modus = first_profile["modus_tokens"] & second_profile["modus_tokens"]
    modus_union = first_profile["modus_tokens"] | second_profile["modus_tokens"]
    modus_similarity = len(shared_modus) / max(1, len(modus_union))
    if modus_similarity >= 0.18 or len(shared_modus) >= 2:
        weight = min(22, 8 + round(modus_similarity * 28) + min(6, len(shared_modus) * 2))
        score += weight
        evidence.append(
            {
                "dimension": "modus_operandi",
                "weight": weight,
                "detail": f"Shared operating tokens: {', '.join(sorted(shared_modus)[:6])}.",
            }
        )

    distance = geo_distance_km(first, second)
    location_weight = 0
    location_parts = []
    if first["police_station"] == second["police_station"]:
        location_weight += 16
        location_parts.append(f"same station {first['police_station']}")
    elif first["district"] == second["district"]:
        location_weight += 7
        location_parts.append(f"same district {first['district']}")
    if first["beat"] == second["beat"]:
        location_weight += 8
        location_parts.append(f"same beat {first['beat']}")
    elif distance <= 4:
        location_weight += 6
        location_parts.append(f"{distance:.1f} km apart")
    elif distance <= 12:
        location_weight += 3
        location_parts.append(f"{distance:.1f} km apart")
    if location_weight:
        score += location_weight
        evidence.append({"dimension": "location_pattern", "weight": location_weight, "detail": "; ".join(location_parts) + "."})

    days_apart = abs((first_profile["date"] - second_profile["date"]).days)
    time_weight = 0
    if days_apart <= 7:
        time_weight = 12
    elif days_apart <= 30:
        time_weight = 8
    elif first_profile["date"].strftime("%Y-%m") == second_profile["date"].strftime("%Y-%m"):
        time_weight = 5
    if first_profile["date"].weekday() == second_profile["date"].weekday():
        time_weight += 2
    if time_weight:
        score += time_weight
        evidence.append({"dimension": "time_pattern", "weight": time_weight, "detail": f"{days_apart} days apart with temporal overlap."})

    victim_matches = []
    for key, label in [("age_band", "victim age band"), ("gender", "victim gender"), ("socio", "socio-economic tag")]:
        if first_profile["victim"][key] == second_profile["victim"][key]:
            victim_matches.append(f"{label}: {first_profile['victim'][key]}")
    if victim_matches:
        weight = min(12, len(victim_matches) * 4)
        score += weight
        evidence.append({"dimension": "victim_profile", "weight": weight, "detail": "; ".join(victim_matches) + "."})

    shared_people = first_profile["people"] & second_profile["people"]
    suspect_matches = []
    if shared_people:
        names = ", ".join(shared_names(shared_people, person_lookup, mask_people)[:4])
        suspect_matches.append(f"shared persons: {names}")
    if first_profile["suspect"]["age_band"] == second_profile["suspect"]["age_band"]:
        suspect_matches.append(f"accused age band: {first_profile['suspect']['age_band']}")
    if first_profile["suspect"]["gender"] == second_profile["suspect"]["gender"]:
        suspect_matches.append(f"accused gender: {first_profile['suspect']['gender']}")
    if suspect_matches:
        weight = (24 if shared_people else 0) + min(8, (len(suspect_matches) - int(bool(shared_people))) * 4)
        score += weight
        evidence.append({"dimension": "suspect_profile", "weight": weight, "detail": "; ".join(suspect_matches) + "."})

    shared_vehicle = first_profile["vehicle_terms"] & second_profile["vehicle_terms"]
    if shared_vehicle or (first_profile["vehicle_terms"] and second_profile["vehicle_terms"]):
        weight = 12 if shared_vehicle else 6
        detail_terms = shared_vehicle or (first_profile["vehicle_terms"] | second_profile["vehicle_terms"])
        score += weight
        evidence.append({"dimension": "vehicle_information", "weight": weight, "detail": f"Vehicle indicators: {', '.join(sorted(detail_terms)[:5])}."})

    shared_comm = first_profile["communication_terms"] & second_profile["communication_terms"]
    if shared_comm or (first_profile["communication_terms"] and second_profile["communication_terms"]):
        weight = 12 if shared_comm else 6
        detail_terms = shared_comm or (first_profile["communication_terms"] | second_profile["communication_terms"])
        score += weight
        evidence.append({"dimension": "communication_records", "weight": weight, "detail": f"Communication or digital traces: {', '.join(sorted(detail_terms)[:5])}."})

    confidence = min(99, round(score))
    dimensions = {item["dimension"] for item in evidence}
    if confidence < 42 or len(dimensions) < 3:
        return None

    return {
        "source": first["id"],
        "target": second["id"],
        "confidence": confidence,
        "dimensions": sorted(dimensions),
        "evidence": evidence,
    }


def aggregate_case_linkages(records: list[dict[str, Any]], mask_people: bool) -> dict[str, Any]:
    profiles = {record["id"]: case_profile(record) for record in records}
    person_lookup: dict[str, str] = {}
    links: list[dict[str, Any]] = []
    for index, first in enumerate(records):
        for second in records[index + 1 :]:
            link = score_case_pair(first, second, profiles[first["id"]], profiles[second["id"]], person_lookup, mask_people)
            if link:
                links.append(link)
    links.sort(key=lambda item: item["confidence"], reverse=True)

    parent = {record["id"]: record["id"] for record in records}

    def find(case_id: str) -> str:
        while parent[case_id] != case_id:
            parent[case_id] = parent[parent[case_id]]
            case_id = parent[case_id]
        return case_id

    def union(first_id: str, second_id: str) -> None:
        first_root = find(first_id)
        second_root = find(second_id)
        if first_root != second_root:
            parent[second_root] = first_root

    for link in links:
        if link["confidence"] >= 50:
            union(link["source"], link["target"])

    components: dict[str, set[str]] = defaultdict(set)
    for record in records:
        components[find(record["id"])].add(record["id"])

    record_lookup = {record["id"]: record for record in records}
    clusters = []
    for cluster_index, case_ids in enumerate([ids for ids in components.values() if len(ids) > 1], start=1):
        cluster_links = [link for link in links if link["source"] in case_ids and link["target"] in case_ids]
        if not cluster_links:
            continue
        dimension_counts = Counter(dimension for link in cluster_links for dimension in link["dimensions"])
        average_confidence = round(sum(link["confidence"] for link in cluster_links) / len(cluster_links))
        top_confidence = max(link["confidence"] for link in cluster_links)
        cluster_confidence = round((average_confidence * 0.62) + (top_confidence * 0.38))
        sorted_cases = sorted((record_lookup[case_id] for case_id in case_ids), key=lambda item: item["date"])
        top_dimensions = [dimension for dimension, _ in dimension_counts.most_common(5)]
        clusters.append(
            {
                "cluster_id": f"LNK-{cluster_index:03d}",
                "confidence": cluster_confidence,
                "risk_level": "High" if cluster_confidence >= 76 else "Medium" if cluster_confidence >= 58 else "Watch",
                "case_count": len(sorted_cases),
                "cases": [
                    {
                        "case_id": record["id"],
                        "date": record["date"],
                        "district": record["district"],
                        "police_station": record["police_station"],
                        "crime_type": record["crime_type"],
                        "status": record["status"],
                    }
                    for record in sorted_cases
                ],
                "evidence_summary": top_dimensions,
                "supporting_links": cluster_links[:6],
                "proactive_lead": (
                    f"Review {len(sorted_cases)} cases together; strongest signals are "
                    f"{', '.join(top_dimensions[:3])}."
                ),
            }
        )

    clusters.sort(key=lambda item: (item["confidence"], item["case_count"]), reverse=True)
    clustered_case_ids = {case["case_id"] for cluster in clusters[:5] for case in cluster["cases"]}
    graph_nodes = [
        {
            "id": record["id"],
            "label": record["id"].replace("SYN-2026-", "#"),
            "crime_type": record["crime_type"],
            "police_station": record["police_station"],
            "status": record["status"],
        }
        for record in records
        if record["id"] in clustered_case_ids
    ][:32]
    allowed = {node["id"] for node in graph_nodes}
    graph_links = [
        {
            "source": link["source"],
            "target": link["target"],
            "confidence": link["confidence"],
            "dimensions": link["dimensions"],
        }
        for link in links
        if link["source"] in allowed and link["target"] in allowed
    ][:60]

    return {
        "generated_at": utc_now(),
        "record_count": len(records),
        "pair_count": len(links),
        "clusters": clusters[:8],
        "graph": {"nodes": graph_nodes, "links": graph_links},
        "explainability": [
            "pairwise scoring across modus operandi, location, time, victim profile, suspect profile, vehicle indicators, and communication indicators",
            "clusters are connected components over case-pair confidence >= 50",
            "analyst role masks named person evidence",
            "human_verification_required",
        ],
    }


def detect_anomalies(records: list[dict[str, Any]], mask_people: bool) -> list[dict[str, Any]]:
    anomalies: list[dict[str, Any]] = []
    hotspots = aggregate_hotspots(records)
    trends = aggregate_trends(records)
    profiles = aggregate_behavior_profiles(records, mask_people=mask_people)
    network = aggregate_network(records, mask_people=mask_people)

    for hotspot in hotspots[:3]:
        if hotspot["open_cases"] >= max(2, hotspot["cases"] - 1):
            anomalies.append(
                {
                    "title": f"Open-case concentration at {hotspot['police_station']}",
                    "severity": "high",
                    "reason": f"{hotspot['open_cases']} of {hotspot['cases']} cases remain open; dominant pattern is {hotspot['top_crime']}.",
                    "recommended_check": "Review pending evidence, station workload, and cross-case linkages.",
                }
            )

    if len(trends) >= 2:
        previous = trends[-2]["total"]
        latest = trends[-1]["total"]
        if latest > previous:
            anomalies.append(
                {
                    "title": f"Recent volume rise in {trends[-1]['month']}",
                    "severity": "medium",
                    "reason": f"Monthly volume increased from {previous} to {latest}.",
                    "recommended_check": "Compare recent FIR intake with beat diaries and complaint-channel changes.",
                }
            )

    for profile in profiles[:3]:
        if profile["open_cases"] and profile["evidence_tags"]:
            anomalies.append(
                {
                    "title": f"{profile['crime_type']} evidence convergence",
                    "severity": "medium",
                    "reason": f"Open cases share evidence tags: {', '.join(profile['evidence_tags'][:3])}.",
                    "recommended_check": "Assign technical review before treating cases as isolated incidents.",
                }
            )

    for node in [item for item in network["nodes"] if item["type"] == "person"][:3]:
        if node.get("risk", 0) >= 6:
            anomalies.append(
                {
                    "title": f"High-risk repeat-link node: {node['label']}",
                    "severity": "high",
                    "reason": f"Network risk score {node.get('risk', 0)} across {node.get('cases', 0)} linked records.",
                    "recommended_check": "Verify identity and corroborate links before enforcement decisions.",
                }
            )

    return anomalies[:6]


def recommend_resource_deployment(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    deployments = []
    for hotspot in aggregate_hotspots(records)[:5]:
        top_crime = hotspot["top_crime"]
        if top_crime == "Cyber Fraud":
            resource = "Cyber triage cell + digital evidence analyst"
            timing = "Same day complaint triage and wallet/CDR review"
        elif top_crime in {"Narcotics", "Robbery"}:
            resource = "Plain-clothes team + informer coordination"
            timing = "Evening and late-night beat overlap"
        elif top_crime in {"Vehicle Theft", "Chain Snatching"}:
            resource = "Mobile patrol + CCTV/ANPR review"
            timing = "Evening commute and market-close windows"
        else:
            resource = "Beat saturation + evidence review desk"
            timing = "Station-defined peak incident windows"
        deployments.append(
            {
                "area": f"{hotspot['police_station']}, {hotspot['district']}",
                "resource": resource,
                "timing": timing,
                "reason": f"{hotspot['score']} hotspot score; {hotspot['cases']} cases and {hotspot['open_cases']} open.",
                "coordination": "Coordinate through supervisor review; do not use synthetic output as sole deployment basis.",
            }
        )
    return deployments


def build_investigation_copilot(
    records: list[dict[str, Any]],
    user: dict[str, Any],
    objective: str = "proactive_intelligence_watch",
    scoped: bool = False,
) -> dict[str, Any]:
    scoped_records = records if scoped else user_scoped_records(records, user)
    mask_people = user["role"] == "analyst"
    suspect_leads = build_suspect_leads(scoped_records, mask_people=mask_people)
    relationships = identify_hidden_relationships(scoped_records, mask_people=mask_people)
    case_linkage = aggregate_case_linkages(scoped_records, mask_people=mask_people)
    anomalies = detect_anomalies(scoped_records, mask_people=mask_people)
    deployments = recommend_resource_deployment(scoped_records)
    hotspots = aggregate_hotspots(scoped_records)
    warnings = aggregate_warnings(scoped_records)
    crime_mix = Counter(record["crime_type"] for record in scoped_records)
    open_cases = sum(1 for record in scoped_records if record["status"] != "Chargesheeted")
    top_suspect = suspect_leads[0]["name"] if suspect_leads else "no repeat lead"
    top_hotspot = hotspots[0]["police_station"] if hotspots else "no hotspot"
    top_anomaly = anomalies[0]["title"] if anomalies else "no anomaly"
    top_deployment = deployments[0]["resource"] if deployments else "routine monitoring"

    intelligence_summary = (
        f"Copilot reviewed {len(scoped_records)} role-scoped synthetic records with {open_cases} open cases. "
        f"Top lead is {top_suspect}; priority hotspot is {top_hotspot}; main anomaly is {top_anomaly}. "
        f"Recommended first deployment: {top_deployment}."
    )
    proactive_insights = []
    if suspect_leads:
        proactive_insights.append(
            {
                "label": "Suspect lead",
                "headline": suspect_leads[0]["name"],
                "detail": "; ".join(suspect_leads[0]["reasons"][:3]),
                "priority": "P1",
            }
        )
    if relationships:
        proactive_insights.append(
            {
                "label": "Hidden relationship",
                "headline": relationships[0]["title"],
                "detail": relationships[0]["reason"],
                "priority": "P2",
            }
        )
    if case_linkage["clusters"]:
        top_cluster = case_linkage["clusters"][0]
        proactive_insights.append(
            {
                "label": "Case linkage",
                "headline": top_cluster["cluster_id"],
                "detail": top_cluster["proactive_lead"],
                "priority": "P1" if top_cluster["confidence"] >= 76 else "P2",
            }
        )
    if anomalies:
        proactive_insights.append(
            {
                "label": "Anomaly",
                "headline": anomalies[0]["title"],
                "detail": anomalies[0]["reason"],
                "priority": "P1" if anomalies[0]["severity"] == "high" else "P2",
            }
        )
    if deployments:
        proactive_insights.append(
            {
                "label": "Deployment",
                "headline": deployments[0]["area"],
                "detail": deployments[0]["resource"],
                "priority": "P2",
            }
        )

    reasoning = [
        "Prioritized repeat-linked persons by case count, open cases, severity, station spread, and crime-type spread.",
        "Flagged hidden relationships from shared case participation, station-crime recurrence, and evidence-tag recurrence.",
        "Highlighted anomalies when open cases cluster, monthly volume rises, evidence converges, or network-risk nodes stand out.",
        "Mapped resource deployment to the dominant hotspot crime type and operational timing.",
        "Applied role scope and identity masking before generating any lead recommendations.",
    ]
    confidence = min(95, 60 + len(scoped_records) * 2 + len(proactive_insights) * 3 + open_cases)
    return {
        "run_id": f"COP-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}-{secrets.token_hex(2).upper()}",
        "name": "AI Investigation Copilot",
        "status": "proactive",
        "objective": objective,
        "generated_at": utc_now(),
        "scope": user["district_scope"],
        "records_considered": len(scoped_records),
        "confidence": confidence,
        "intelligence_summary": intelligence_summary,
        "proactive_insights": proactive_insights,
        "suspect_leads": suspect_leads,
        "next_actions": [
            {
                "title": item["title"],
                "target": item["target"],
                "priority": item["priority"],
                "reason": item["rationale"],
                "action": item["next_step"],
            }
            for item in build_agent_brief(scoped_records, user, scoped=True)["action_queue"][:5]
        ],
        "hidden_relationships": relationships,
        "case_linkage": case_linkage,
        "anomalies": anomalies,
        "resource_deployments": deployments,
        "warnings": warnings[:4],
        "reasoning": reasoning,
        "guardrails": ["synthetic_data_notice", "role_scope_filter", "role_based_masking", "human_verification_required"],
    }


def build_agent_brief(
    records: list[dict[str, Any]],
    user: dict[str, Any],
    objective: str = "operational_triage",
    scoped: bool = False,
) -> dict[str, Any]:
    scoped_records = records if scoped else user_scoped_records(records, user)
    mask_people = user["role"] == "analyst"
    hotspots = aggregate_hotspots(scoped_records)
    warnings = aggregate_warnings(scoped_records)
    profiles = aggregate_behavior_profiles(scoped_records, mask_people=mask_people)
    case_linkage = aggregate_case_linkages(scoped_records, mask_people=mask_people)
    network = aggregate_network(scoped_records, mask_people=mask_people)
    people = [node for node in network["nodes"] if node["type"] == "person"]
    top_people = sorted(people, key=lambda item: (item.get("risk", 0), item.get("cases", 0)), reverse=True)[:3]
    open_cases = sum(1 for record in scoped_records if record["status"] != "Chargesheeted")

    action_queue: list[dict[str, Any]] = []
    for index, warning in enumerate(warnings[:3], start=1):
        action_queue.append(
            {
                "priority": f"P{index}",
                "type": "prevention",
                "title": f"Stabilize {warning['risk']} risk at {warning['area']}",
                "target": warning["area"],
                "rationale": warning["rationale"],
                "next_step": warning["recommended_action"],
                "evidence": ["hotspot_score", "open_case_count", "recent_case_cluster"],
            }
        )

    for profile in profiles[:2]:
        lead_person = profile["repeat_people"][0]["name"] if profile["repeat_people"] else "repeat actors"
        action_queue.append(
            {
                "priority": "P2",
                "type": "behavior_profile",
                "title": f"Review {profile['crime_type']} behavior profile",
                "target": lead_person,
                "rationale": profile["behavior_signal"],
                "next_step": "Cluster FIRs by modus operandi, evidence tags, and beat before field tasking.",
                "evidence": profile["evidence_tags"][:4],
            }
        )

    for cluster in case_linkage["clusters"][:2]:
        action_queue.append(
            {
                "priority": "P1" if cluster["confidence"] >= 76 else "P2",
                "type": "case_linkage",
                "title": f"Review linked case cluster {cluster['cluster_id']}",
                "target": ", ".join(case["case_id"] for case in cluster["cases"][:4]),
                "rationale": f"{cluster['confidence']}% confidence from {', '.join(cluster['evidence_summary'][:4])}.",
                "next_step": "Assign an investigator to compare FIR narratives, evidence tags, CDR/device records, and station handovers.",
                "evidence": cluster["evidence_summary"],
            }
        )

    if "network" in user["permissions"] and top_people:
        for node in top_people:
            action_queue.append(
                {
                    "priority": "P2",
                    "type": "network",
                    "title": f"Validate repeat-link lead: {node['label']}",
                    "target": node["label"],
                    "rationale": f"{node.get('cases', 0)} linked records with risk score {node.get('risk', 0)}.",
                    "next_step": "Verify identity, custody history, CDR links, and inter-station case merges.",
                    "evidence": ["network_degree", "case_overlap", "severity_score"],
                }
            )
    elif top_people:
        action_queue.append(
            {
                "priority": "P3",
                "type": "aggregate_network",
                "title": "Monitor masked repeat-link cluster",
                "target": "aggregate network",
                "rationale": "Role policy masks named persons, but aggregate repeat-link risk is present.",
                "next_step": "Escalate to a supervisor or investigator role if named linkage review is required.",
                "evidence": ["role_masking", "network_degree"],
            }
        )

    if not action_queue:
        action_queue.append(
            {
                "priority": "P3",
                "type": "monitoring",
                "title": "Continue routine watch",
                "target": ", ".join(user["district_scope"]),
                "rationale": "No high-confidence synthetic cluster is currently present in scope.",
                "next_step": "Refresh analytics after new records are ingested.",
                "evidence": ["role_scope_filter"],
            }
        )

    watchlist = []
    for profile in profiles[:3]:
        watchlist.append(
            {
                "label": profile["crime_type"],
                "signal": profile["behavior_signal"],
                "cases": profile["cases"],
                "open_cases": profile["open_cases"],
            }
        )
    for hotspot in hotspots[:3]:
        watchlist.append(
            {
                "label": hotspot["police_station"],
                "signal": f"{hotspot['top_crime']} hotspot in {hotspot['district']}",
                "cases": hotspot["cases"],
                "open_cases": hotspot["open_cases"],
            }
        )

    confidence = min(94, 58 + len(scoped_records) * 2 + open_cases)
    return {
        "run_id": f"AGT-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}-{secrets.token_hex(2).upper()}",
        "name": "SCRB Field Intelligence Agent",
        "status": "ready",
        "objective": objective,
        "generated_at": utc_now(),
        "scope": user["district_scope"],
        "records_considered": len(scoped_records),
        "open_cases": open_cases,
        "confidence": confidence,
        "mission_brief": (
            f"Reviewed {len(scoped_records)} role-scoped synthetic records with {open_cases} open cases. "
            f"Prioritize {action_queue[0]['target']} and keep human verification before operational action."
        ),
        "action_queue": action_queue[:7],
        "watchlist": watchlist[:6],
        "behavior_profiles": profiles[:3],
        "case_linkage": case_linkage,
        "explainability": [
            "role_scope_filter",
            "hotspot_score = cases + severity + open-case + recency weights",
            "behavior profiles use modus operandi, evidence tags, repeat locations, and repeat links",
            "case linkage compares every case pair across method, location, time, victim, suspect, vehicle, and communication dimensions",
            "analyst role masks named person nodes",
            "human_verification_required",
        ],
        "guardrails": ["synthetic_data_notice", "role_based_masking", "human_verification_required"],
    }


def build_analytics(records: list[dict[str, Any]], user: dict[str, Any]) -> dict[str, Any]:
    scoped = user_scoped_records(records, user)
    by_type = Counter(record["crime_type"] for record in scoped)
    by_district = Counter(record["district"] for record in scoped)
    return {
        "generated_at": utc_now(),
        "scope": user["district_scope"],
        "record_count": len(scoped),
        "open_cases": sum(1 for record in scoped if record["status"] != "Chargesheeted"),
        "crime_types": dict(by_type.most_common()),
        "districts": dict(by_district.most_common()),
        "trends": aggregate_trends(scoped),
        "hotspots": aggregate_hotspots(scoped),
        "demographics": aggregate_demographics(scoped),
        "behavior_profiles": aggregate_behavior_profiles(scoped, mask_people=user["role"] == "analyst"),
        "case_linkage": aggregate_case_linkages(scoped, mask_people=user["role"] == "analyst"),
        "network": aggregate_network(scoped, mask_people=user["role"] == "analyst"),
        "warnings": aggregate_warnings(scoped),
        "agent_brief": build_agent_brief(scoped, user, scoped=True),
        "copilot_brief": build_investigation_copilot(scoped, user, scoped=True),
    }


def top_items(counter_like: dict[str, int], limit: int = 3) -> str:
    items = sorted(counter_like.items(), key=lambda item: item[1], reverse=True)[:limit]
    return ", ".join(f"{name} ({count})" for name, count in items) if items else "none"


def format_sources(records: list[dict[str, Any]], limit: int = 5) -> list[dict[str, str]]:
    return [
        {
            "case_id": record["id"],
            "date": record["date"],
            "district": record["district"],
            "police_station": record["police_station"],
            "crime_type": record["crime_type"],
            "status": record["status"],
        }
        for record in sorted(records, key=lambda item: item["date"], reverse=True)[:limit]
    ]


def compose_english(
    intent: str,
    message: str,
    filtered: list[dict[str, Any]],
    analytics: dict[str, Any],
    filters: dict[str, str],
    user: dict[str, Any],
) -> str:
    if not filtered:
        return (
            "I did not find matching synthetic records inside your permitted scope. "
            "Try removing one filter or asking for statewide trends if your role allows it."
        )

    crime_mix = Counter(record["crime_type"] for record in filtered)
    district_mix = Counter(record["district"] for record in filtered)
    open_cases = sum(1 for record in filtered if record["status"] != "Chargesheeted")

    if intent == "hotspot":
        hotspots = aggregate_hotspots(filtered)[:3]
        lines = [
            f"{item['police_station']} in {item['district']} is scoring {item['score']} with {item['cases']} cases; top pattern: {item['top_crime']}."
            for item in hotspots
        ]
        return (
            f"I found {len(filtered)} matching records and {open_cases} open cases. "
            f"Priority hotspots: {' '.join(lines)} Suggested action: align beat deployment with the top station and review cases tagged with {top_items(dict(crime_mix), 2)}."
        )

    if intent == "network":
        if "network" not in user["permissions"]:
            return (
                "Your role can view aggregate network risk but not named suspect linkages. "
                f"The strongest aggregate pattern involves {top_items(dict(crime_mix), 2)} across {top_items(dict(district_mix), 2)}."
            )
        network = aggregate_network(filtered, mask_people=False)
        people = [node for node in network["nodes"] if node["type"] == "person"]
        leaders = sorted(people, key=lambda item: (item.get("risk", 0), item.get("cases", 0)), reverse=True)[:4]
        leader_text = ", ".join(f"{node['label']} ({node['cases']} cases)" for node in leaders) or "no repeat suspects"
        return (
            f"Network scan across {len(filtered)} records highlights {leader_text}. "
            f"The strongest case linkages involve {top_items(dict(crime_mix), 3)}. "
            "Treat this as an investigative lead: verify identity, call-detail records, custody history, and inter-station case merges before action."
        )

    if intent == "linkage":
        linkage = aggregate_case_linkages(filtered, mask_people=user["role"] == "analyst")
        clusters = linkage["clusters"]
        if not clusters:
            return (
                "The Case Linkage Engine did not find a high-confidence cluster in the current scope. "
                "It compared modus operandi, location, time, victim profile, suspect profile, vehicle indicators, and communication indicators."
            )
        top_cluster = clusters[0]
        link = top_cluster["supporting_links"][0]
        evidence_text = "; ".join(item["detail"] for item in link["evidence"][:4])
        return (
            f"Case Linkage Engine found {len(clusters)} linked case clusters. "
            f"Top cluster {top_cluster['cluster_id']} contains {top_cluster['case_count']} cases at {top_cluster['confidence']}% confidence. "
            f"Key dimensions: {', '.join(top_cluster['evidence_summary'][:5])}. "
            f"Strongest pair: {link['source']} to {link['target']} at {link['confidence']}% confidence. Evidence: {evidence_text} "
            "Treat the cluster as an investigative lead and verify FIR narratives, station records, vehicle traces, CDR/device data, and suspect identity before action."
        )

    if intent == "trend":
        trends = aggregate_trends(filtered)
        first = trends[0] if trends else {"month": "n/a", "total": 0}
        last = trends[-1] if trends else {"month": "n/a", "total": 0}
        direction = "increased" if last["total"] > first["total"] else "decreased" if last["total"] < first["total"] else "remained steady"
        return (
            f"From {first['month']} to {last['month']}, matching cases {direction} from {first['total']} to {last['total']}. "
            f"Dominant crime types are {top_items(dict(crime_mix), 3)}. "
            f"District concentration: {top_items(dict(district_mix), 3)}."
        )

    if intent == "prediction":
        warnings = aggregate_warnings(filtered)[:3]
        warning_text = " ".join(
            f"{warning['area']} has {warning['confidence']}% early-warning confidence for {warning['risk']}."
            for warning in warnings
        )
        return (
            f"Early-warning model found {len(warnings)} priority signals. {warning_text} "
            "Recommended next step: review open FIR clusters, recent beat reports, and repeat-accused links before issuing an operational alert."
        )

    if intent == "behavior":
        profiles = aggregate_behavior_profiles(filtered, mask_people=user["role"] == "analyst")[:3]
        profile_text = " ".join(
            f"{profile['crime_type']}: {profile['cases']} cases, {profile['open_cases']} open; {profile['behavior_signal']}"
            for profile in profiles
        )
        return (
            f"Behavioral profiling found {len(profiles)} priority crime-behavior profiles. {profile_text} "
            "These profiles are lead-prioritization aids, not proof; validate people, locations, and evidence before action."
        )

    if intent == "agent":
        brief = build_agent_brief(filtered, user, objective="chat_requested_triage", scoped=True)
        first_action = brief["action_queue"][0]
        return (
            f"{brief['name']} is ready. {brief['mission_brief']} "
            f"First action: {first_action['priority']} {first_action['title']}. "
            f"Rationale: {first_action['rationale']}"
        )

    if intent == "copilot":
        brief = build_investigation_copilot(filtered, user, objective="chat_requested_copilot", scoped=True)
        suspect = brief["suspect_leads"][0] if brief["suspect_leads"] else None
        anomaly = brief["anomalies"][0] if brief["anomalies"] else None
        relationship = brief["hidden_relationships"][0] if brief["hidden_relationships"] else None
        suspect_text = f"Top lead: {suspect['name']} because {'; '.join(suspect['reasons'][:3])}." if suspect else "No repeat suspect lead found."
        anomaly_text = f"Anomaly: {anomaly['title']} - {anomaly['reason']}" if anomaly else "No anomaly exceeded the current threshold."
        relationship_text = f"Hidden relationship: {relationship['title']} - {relationship['reason']}" if relationship else "No hidden relationship exceeded the current threshold."
        return (
            f"{brief['name']} generated a proactive intelligence brief. {brief['intelligence_summary']} "
            f"{suspect_text} {relationship_text} {anomaly_text} "
            "Treat these as investigative leads only and verify through approved systems before action."
        )

    if intent == "demographic":
        demographics = aggregate_demographics(filtered)
        return (
            f"Victim age bands: {top_items(demographics['victim_age'], 4)}. "
            f"Victim gender split: {top_items(demographics['victim_gender'], 3)}. "
            f"Socio-economic tags: {top_items(demographics['socioeconomic'], 3)}. "
            "Use this for outreach planning, not as a sole basis for enforcement targeting."
        )

    filter_text = ", ".join(f"{key}: {value}" for key, value in filters.items()) or "your permitted data scope"
    return (
        f"For {filter_text}, I found {len(filtered)} synthetic records, {open_cases} open cases, "
        f"and the leading patterns are {top_items(dict(crime_mix), 3)}. Ask for hotspots, network links, trends, or early warnings for a deeper view."
    )


def compose_kannada(
    intent: str,
    filtered: list[dict[str, Any]],
    filters: dict[str, str],
    user: dict[str, Any],
) -> str:
    if not filtered:
        return "ನಿಮ್ಮ ಅನುಮತಿ ವ್ಯಾಪ್ತಿಯಲ್ಲಿ ಹೊಂದುವ ದಾಖಲೆಗಳು ಸಿಗಲಿಲ್ಲ. ಒಂದು ಫಿಲ್ಟರ್ ತೆಗೆದು ಮತ್ತೆ ಕೇಳಿ."

    crime_mix = Counter(record["crime_type"] for record in filtered)
    district_mix = Counter(record["district"] for record in filtered)
    open_cases = sum(1 for record in filtered if record["status"] != "Chargesheeted")

    if intent == "hotspot":
        hotspots = aggregate_hotspots(filtered)[:3]
        hotspot_text = " ".join(
            f"{item['police_station']}, {item['district']} - {item['cases']} ಪ್ರಕರಣಗಳು, ಪ್ರಮುಖ ಮಾದರಿ {item['top_crime']}."
            for item in hotspots
        )
        return f"{len(filtered)} ಹೊಂದುವ ದಾಖಲೆಗಳಲ್ಲಿ {open_cases} ತೆರೆಯಿರುವ ಪ್ರಕರಣಗಳಿವೆ. ಆದ್ಯತಾ ಹಾಟ್‌ಸ್ಪಾಟ್‌ಗಳು: {hotspot_text}"

    if intent == "network":
        if "network" not in user["permissions"]:
            return "ನಿಮ್ಮ ಪಾತ್ರಕ್ಕೆ ಹೆಸರಿನ ಶಂಕಿತ ಜಾಲ ಕಾಣಿಸುವ ಅನುಮತಿ ಇಲ್ಲ. ಸಮಗ್ರ ಅಪಾಯ ಮಾದರಿಯನ್ನು ಮಾತ್ರ ತೋರಿಸಲಾಗುತ್ತಿದೆ."
        return f"ಜಾಲ ವಿಶ್ಲೇಷಣೆಯಲ್ಲಿ {len(filtered)} ದಾಖಲೆಗಳು ಪರಿಶೀಲಿಸಲ್ಪಟ್ಟಿವೆ. ಪ್ರಮುಖ ಅಪರಾಧ ಮಾದರಿಗಳು: {top_items(dict(crime_mix), 3)}."

    if intent == "prediction":
        warnings = aggregate_warnings(filtered)[:3]
        warning_text = " ".join(f"{item['area']} ನಲ್ಲಿ {item['risk']} ಅಪಾಯಕ್ಕೆ {item['confidence']}% ಸೂಚನೆ." for item in warnings)
        return f"ಮುನ್ನೆಚ್ಚರಿಕೆ ಸೂಚನೆಗಳು: {warning_text} ಕಾರ್ಯಾಚರಣೆಗೆ ಮುನ್ನ FIR ಗುಂಪುಗಳು ಮತ್ತು ಬೀಟ್ ವರದಿಗಳನ್ನು ಪರಿಶೀಲಿಸಿ."

    if intent == "behavior":
        profiles = aggregate_behavior_profiles(filtered, mask_people=user["role"] == "analyst")[:3]
        profile_text = " ".join(
            f"{item['crime_type']} - {item['cases']} ಪ್ರಕರಣಗಳು, {item['open_cases']} ತೆರೆಯಿವೆ."
            for item in profiles
        )
        return f"ವರ್ತನಾ ಪ್ರೊಫೈಲ್‌ಗಳು: {profile_text} ಇದು ಕೇವಲ ಮುನ್ನಡೆ ಸೂಚನೆ; ಕ್ರಮಕ್ಕೂ ಮೊದಲು ಸಾಕ್ಷ್ಯ ಪರಿಶೀಲಿಸಿ."

    if intent == "agent":
        brief = build_agent_brief(filtered, user, objective="chat_requested_triage", scoped=True)
        first_action = brief["action_queue"][0]
        return f"{brief['name']} ಸಿದ್ಧವಾಗಿದೆ. ಮೊದಲ ಕಾರ್ಯ: {first_action['title']}. ಕಾರಣ: {first_action['rationale']}"

    if intent == "copilot":
        brief = build_investigation_copilot(filtered, user, objective="chat_requested_copilot", scoped=True)
        suspect = brief["suspect_leads"][0]["name"] if brief["suspect_leads"] else "ಪುನರಾವರ್ತಿತ ಮುನ್ನಡೆ ಇಲ್ಲ"
        anomaly = brief["anomalies"][0]["title"] if brief["anomalies"] else "ಮುಖ್ಯ ಅಸಾಮಾನ್ಯತೆ ಇಲ್ಲ"
        return f"{brief['name']} ಸಕ್ರಿಯವಾಗಿದೆ. ಪ್ರಮುಖ ಶಂಕಿತ ಮುನ್ನಡೆ: {suspect}. ಅಸಾಮಾನ್ಯತೆ: {anomaly}. ಕ್ರಮಕ್ಕೂ ಮೊದಲು ಅಧಿಕೃತ ವ್ಯವಸ್ಥೆಯಲ್ಲಿ ಪರಿಶೀಲಿಸಿ."

    if intent == "demographic":
        demographics = aggregate_demographics(filtered)
        return (
            f"ಬಾಧಿತರ ವಯಸ್ಸಿನ ಗುಂಪುಗಳು: {top_items(demographics['victim_age'], 4)}. "
            f"ಲಿಂಗ ಹಂಚಿಕೆ: {top_items(demographics['victim_gender'], 3)}."
        )

    return (
        f"{len(filtered)} ಹೊಂದುವ ದಾಖಲೆಗಳು ಸಿಕ್ಕಿವೆ; {open_cases} ಪ್ರಕರಣಗಳು ಇನ್ನೂ ತೆರೆಯಿವೆ. "
        f"ಪ್ರಮುಖ ಮಾದರಿಗಳು: {top_items(dict(crime_mix), 3)}. ಜಿಲ್ಲೆಗಳು: {top_items(dict(district_mix), 3)}."
    )


def process_chat(
    message: str,
    user: dict[str, Any],
    conversation: list[dict[str, str]] | None = None,
    language: str = "en",
) -> dict[str, Any]:
    records = user_scoped_records(load_records(), user)
    filters = derive_filters(message, records, conversation)
    filtered = apply_filters(records, filters)
    intent = detect_intent(message)
    lang = "kn" if language == "kn" or is_kannada(message) else "en"
    analytics = build_analytics(records, user)
    answer = (
        compose_kannada(intent, filtered, filters, user)
        if lang == "kn"
        else compose_english(intent, message, filtered, analytics, filters, user)
    )
    agent_brief = build_agent_brief(filtered, user, objective="chat_requested_triage", scoped=True) if intent == "agent" else None
    copilot_brief = (
        build_investigation_copilot(filtered, user, objective="chat_requested_copilot", scoped=True)
        if intent == "copilot"
        else None
    )

    audit_id = f"AUD-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}-{secrets.token_hex(3).upper()}"
    audit = {
        "audit_id": audit_id,
        "timestamp": utc_now(),
        "actor": user["badge_id"],
        "role": user["role"],
        "intent": intent,
        "filters": filters,
        "records_considered": len(records),
        "records_returned": len(filtered),
        "model_route": "deterministic-demo-engine",
        "guardrails": ["role_scope_filter", "synthetic_data_notice", "human_verification_required"],
    }
    append_audit(audit | {"message": message})
    return {
        "answer": answer,
        "intent": intent,
        "filters": filters,
        "sources": format_sources(filtered),
        "audit": audit,
        "agent": agent_brief,
        "copilot": copilot_brief,
        "analytics_patch": {
            "hotspots": aggregate_hotspots(filtered)[:5],
            "trends": aggregate_trends(filtered),
            "warnings": aggregate_warnings(filtered)[:3],
            "behavior_profiles": aggregate_behavior_profiles(filtered, mask_people=user["role"] == "analyst")[:3],
            "case_linkage": aggregate_case_linkages(filtered, mask_people=user["role"] == "analyst"),
            "agent_brief": agent_brief,
            "copilot_brief": copilot_brief,
        },
    }


def append_audit(entry: dict[str, Any]) -> None:
    AUDIT_PATH.parent.mkdir(parents=True, exist_ok=True)
    try:
        with AUDIT_PATH.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        # Keep local demo queries responsive even if a previous server process
        # has left the JSONL audit file locked. The response still carries the
        # audit payload; production should write to an immutable audit service.
        return


def recent_audit(limit: int = 25) -> list[dict[str, Any]]:
    if not AUDIT_PATH.exists():
        return []
    lines = AUDIT_PATH.read_text(encoding="utf-8").splitlines()[-limit:]
    return [json.loads(line) for line in lines if line.strip()]


def render_export_html(conversation: list[dict[str, str]], user: dict[str, Any]) -> str:
    rows = []
    for item in conversation:
        role = html.escape(item.get("role", "message").title())
        content = html.escape(item.get("content", ""))
        rows.append(f"<section><h2>{role}</h2><p>{content}</p></section>")
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>KSP SCRB Conversation Export</title>
  <style>
    body {{ font-family: Arial, sans-serif; color: #17201d; line-height: 1.5; margin: 36px; }}
    header {{ border-bottom: 3px solid #17634f; margin-bottom: 24px; padding-bottom: 12px; }}
    h1 {{ font-size: 22px; margin: 0 0 4px; }}
    h2 {{ color: #17634f; font-size: 14px; margin-bottom: 4px; }}
    section {{ break-inside: avoid; border-bottom: 1px solid #d7ddd8; padding: 12px 0; }}
    .meta {{ color: #59645f; font-size: 12px; }}
  </style>
</head>
<body>
  <header>
    <h1>KSP SCRB Conversational Intelligence Transcript</h1>
    <div class="meta">Generated {html.escape(utc_now())} for {html.escape(user["name"])} ({html.escape(user["badge_id"])})</div>
    <div class="meta">Demo prototype using synthetic data. Validate all leads against approved SCRB systems.</div>
  </header>
  {''.join(rows)}
</body>
</html>"""


def render_intelligence_report_html(user: dict[str, Any]) -> str:
    generated = html.escape(utc_now())
    officer = html.escape(user["name"])
    badge = html.escape(user["badge_id"])
    pages = [
        """
        <section class="report-page cover">
          <div class="report-kicker">Karnataka State Police | SCRB AI</div>
          <h1>Executive Intelligence Summary</h1>
          <div class="ai-summary">
            <h2>AI Summary</h2>
            <p>Vehicle theft incidents increased by 24% over the last 60 days in Bengaluru Urban. Analysis indicates concentrated activity near metro stations and commercial zones. Three repeat offenders and one suspected criminal network are associated with 37% of reported incidents. Predictive models indicate a high probability of continued activity over the next 30 days.</p>
          </div>
          <h2>Quick Risk Overview</h2>
          <table class="risk-table">
            <tr><th>Category</th><th>Status</th></tr>
            <tr><td>Crime Risk</td><td><span class="status red"></span>High</td></tr>
            <tr><td>Gang Activity</td><td><span class="status orange"></span>Medium</td></tr>
            <tr><td>Repeat Offenders</td><td><span class="status red"></span>High</td></tr>
            <tr><td>Future Risk</td><td><span class="status red"></span>High</td></tr>
            <tr><td>Investigation Priority</td><td><strong>Critical</strong></td></tr>
          </table>
        </section>
        """,
        """
        <section class="report-page">
          <div class="report-kicker">Page 2</div>
          <h1>Crime Situation Overview</h1>
          <div class="kpi-report-grid">
            <article><span>Total Crimes</span><strong>12,430</strong></article>
            <article><span>Solved Cases</span><strong>8,720</strong></article>
            <article><span>Active Cases</span><strong>3,710</strong></article>
            <article><span>Repeat Offenders</span><strong>1,150</strong></article>
            <article><span>Active Networks</span><strong>52</strong></article>
          </div>
          <div class="visual-grid">
            <div class="chart-card">
              <h2>Monthly Crime Trend</h2>
              <svg viewBox="0 0 520 210" class="report-chart">
                <polyline points="24,170 100,142 176,130 252,96 328,88 404,62 496,48" fill="none" stroke="#0f766e" stroke-width="5"/>
                <polygon points="24,170 100,142 176,130 252,96 328,88 404,62 496,48 496,190 24,190" fill="#0f766e" opacity="0.12"/>
                <g fill="#0f766e"><circle cx="24" cy="170" r="6"/><circle cx="100" cy="142" r="6"/><circle cx="176" cy="130" r="6"/><circle cx="252" cy="96" r="6"/><circle cx="328" cy="88" r="6"/><circle cx="404" cy="62" r="6"/><circle cx="496" cy="48" r="6"/></g>
              </svg>
            </div>
            <div class="chart-card">
              <h2>Crime Category Distribution</h2>
              <div class="donut-wrap"><div class="donut"></div><ul><li>Vehicle theft 34%</li><li>Cyber fraud 22%</li><li>Robbery 18%</li><li>Other 26%</li></ul></div>
            </div>
          </div>
          <div class="growth-strip"><span>Vehicle theft +24%</span><span>Active cases +18%</span><span>Repeat offender activity +31%</span></div>
          <div class="insight-box"><strong>AI Insight</strong><p>Crime levels are 18% above the previous quarter and 11% above the annual average.</p></div>
        </section>
        """,
        """
        <section class="report-page">
          <div class="report-kicker">Page 3</div>
          <h1>Hotspot Intelligence</h1>
          <div class="heatmap">
            <span class="hot high" style="left:62%;top:30%">Bengaluru East</span>
            <span class="hot medium" style="left:38%;top:58%">Mysuru North</span>
            <span class="hot emerging" style="left:25%;top:25%">Hubli Central</span>
            <span class="hot medium" style="left:70%;top:64%">Commercial Zone</span>
          </div>
          <div class="legend"><span><i class="high"></i>High Risk Areas</span><span><i class="medium"></i>Medium Risk Areas</span><span><i class="emerging"></i>Emerging Hotspots</span></div>
          <div class="two-col">
            <div>
              <h2>Top Hotspots</h2>
              <ol class="big-list"><li>Bengaluru East</li><li>Mysuru North</li><li>Hubli Central</li></ol>
            </div>
            <div>
              <h2>Why AI Flagged These Areas</h2>
              <ul class="check-list"><li>High incident density</li><li>Repeat offender presence</li><li>Similar historical patterns</li><li>Recent crime spike</li></ul>
            </div>
          </div>
          <div class="action-box"><strong>Recommended Action</strong><p>Increase evening patrols between 6 PM and 10 PM.</p></div>
        </section>
        """,
        """
        <section class="report-page">
          <div class="report-kicker">Page 4</div>
          <h1>Criminal Network Intelligence</h1>
          <div class="network-layout">
            <div class="network-visual">
              <svg viewBox="0 0 520 340">
                <g stroke="#a16207" stroke-width="3" opacity="0.55">
                  <line x1="260" y1="170" x2="120" y2="80"/><line x1="260" y1="170" x2="400" y2="80"/><line x1="260" y1="170" x2="112" y2="240"/><line x1="260" y1="170" x2="408" y2="244"/><line x1="120" y1="80" x2="400" y2="80"/><line x1="112" y1="240" x2="408" y2="244"/>
                </g>
                <g fill="#dc2626"><circle cx="260" cy="170" r="28"/><circle cx="120" cy="80" r="20"/><circle cx="400" cy="80" r="20"/><circle cx="112" cy="240" r="18"/></g>
                <g fill="#0f766e"><circle cx="408" cy="244" r="16"/><circle cx="210" cy="68" r="14"/><circle cx="314" cy="266" r="14"/><circle cx="84" cy="156" r="12"/><circle cx="442" cy="154" r="12"/></g>
                <g fill="#fff" font-size="18" font-weight="700"><text x="251" y="176">A</text><text x="114" y="86">B</text><text x="394" y="86">C</text></g>
              </svg>
            </div>
            <div>
              <h2>Network Overview</h2>
              <table><tr><td>Network Size</td><td>12 Members</td></tr><tr><td>Core Members</td><td>4</td></tr><tr><td>Associated Members</td><td>8</td></tr><tr><td>Active Cases</td><td>37</td></tr></table>
              <h2>Key Suspects</h2>
              <table><tr><th>Suspect</th><th>Role</th></tr><tr><td>A</td><td>Leader</td></tr><tr><td>B</td><td>Coordinator</td></tr><tr><td>C</td><td>Recruiter</td></tr></table>
            </div>
          </div>
          <div class="insight-box"><strong>AI Insight</strong><p>Network activity spans three districts and exhibits characteristics of organized vehicle theft operations.</p></div>
        </section>
        """,
        """
        <section class="report-page">
          <div class="report-kicker">Page 5</div>
          <h1>AI Case Linkage Findings</h1>
          <h2>Linked Cases</h2>
          <table class="wide-table"><tr><th>Case A</th><th>Case B</th><th>Confidence</th></tr><tr><td>FIR-102</td><td>FIR-287</td><td><strong>91%</strong></td></tr><tr><td>FIR-344</td><td>FIR-501</td><td><strong>87%</strong></td></tr></table>
          <div class="linkage-explain">
            <h2>AI Reasoning</h2>
            <p>Cases linked due to:</p>
            <ul class="check-list"><li>Similar modus operandi</li><li>Same vehicle type</li><li>Similar timing</li><li>Geographic overlap</li></ul>
          </div>
          <div class="case-bridge"><span>FIR-102</span><i>91%</i><span>FIR-287</span><span>FIR-344</span><i>87%</i><span>FIR-501</span></div>
        </section>
        """,
        """
        <section class="report-page">
          <div class="report-kicker">Page 6</div>
          <h1>Behavioral Profiling</h1>
          <div class="profile-grid">
            <article><span>Profile Type</span><strong>Organized Repeat Offender</strong></article>
            <article><span>Crime Frequency</span><strong>High</strong></article>
            <article><span>Movement Pattern</span><strong>Multi-District</strong></article>
            <article><span>Preferred Target</span><strong>Motorcycles</strong></article>
            <article><span>Operating Time</span><strong>7 PM - 11 PM</strong></article>
          </div>
          <div class="insight-box"><strong>AI Assessment</strong><p>Offender demonstrates planned behavior rather than opportunistic activity.</p></div>
        </section>
        """,
        """
        <section class="report-page">
          <div class="report-kicker">Page 7</div>
          <h1>Investigation Timeline Reconstruction</h1>
          <div class="timeline static">
            <div><time>10:05 PM</time><span>Vehicle Reported Missing</span></div>
            <div><time>10:17 PM</time><span>CCTV Detection</span></div>
            <div><time>10:24 PM</time><span>Suspect Phone Location Updated</span></div>
            <div><time>10:41 PM</time><span>Vehicle Moved District Boundary</span></div>
            <div><time>11:08 PM</time><span>Associate Contacted</span></div>
          </div>
          <div class="insight-box"><strong>Timeline Visualization</strong><p>The dashboard provides an interactive reconstruction. This PDF preserves a static evidence sequence for briefing use.</p></div>
        </section>
        """,
        """
        <section class="report-page">
          <div class="report-kicker">Page 8</div>
          <h1>Predictive Intelligence</h1>
          <h2>Next 30-Day Forecast</h2>
          <table class="wide-table"><tr><th>District</th><th>Risk</th></tr><tr><td>Bengaluru East</td><td>92%</td></tr><tr><td>Mysuru</td><td>84%</td></tr><tr><td>Hubli</td><td>71%</td></tr></table>
          <div class="two-col">
            <div><h2>Forecast Drivers</h2><ul class="check-list"><li>Historical trends</li><li>Network activity</li><li>Repeat offenders</li><li>Seasonal factors</li></ul></div>
            <div class="confidence-card"><span>AI Confidence</span><strong>89%</strong><p>Prediction Confidence</p></div>
          </div>
        </section>
        """,
        """
        <section class="report-page">
          <div class="report-kicker">Page 9</div>
          <h1>Resource Deployment Recommendations</h1>
          <h2>Recommended Patrol Allocation</h2>
          <table class="wide-table"><tr><th>Area</th><th>Officers</th></tr><tr><td>Bengaluru East</td><td>+15</td></tr><tr><td>Mysuru North</td><td>+10</td></tr><tr><td>Hubli Central</td><td>+8</td></tr></table>
          <div class="action-box"><strong>AI Recommendation</strong><p>Additional patrol coverage during evening hours could reduce incident rates by an estimated 15-20%.</p></div>
        </section>
        """,
        """
        <section class="report-page">
          <div class="report-kicker">Page 10</div>
          <h1>Early Warning Alerts</h1>
          <div class="alert-list">
            <article class="critical"><strong>Organized Theft Activity Detected</strong><span>Immediate Action</span></article>
            <article class="critical"><strong>Emerging Hotspot Identified</strong><span>High Priority</span></article>
            <article class="warning"><strong>Repeat Offender Movement Detected</strong><span>Monitor</span></article>
          </div>
          <h2>Priority Ranking</h2>
          <div class="priority-ladder"><span>Immediate Action</span><span>High Priority</span><span>Monitor</span></div>
        </section>
        """,
        """
        <section class="report-page">
          <div class="report-kicker">Page 11</div>
          <h1>Explainable AI Section</h1>
          <h2>Why was this generated?</h2>
          <div class="explain-layout">
            <div>
              <h3>Hotspot Prediction</h3>
              <p>The recommendation was generated because recent vehicle theft activity, repeat offender movement, historical similarity, and seasonal risk aligned in the same geography.</p>
              <h3>Supporting Evidence</h3>
              <ul class="check-list"><li>Linked FIR clusters</li><li>Repeat offender traces</li><li>Metro and commercial-zone concentration</li><li>Prior seasonal theft pattern</li></ul>
            </div>
            <div>
              <h3>Contributing Factors</h3>
              <div class="factor"><span>40% Recent Crime Increase</span><i style="width:40%"></i></div>
              <div class="factor"><span>25% Repeat Offender Activity</span><i style="width:25%"></i></div>
              <div class="factor"><span>20% Historical Similarity</span><i style="width:20%"></i></div>
              <div class="factor"><span>15% Seasonal Pattern</span><i style="width:15%"></i></div>
              <div class="confidence-card small"><span>Confidence Score</span><strong>91%</strong></div>
            </div>
          </div>
        </section>
        """,
    ]
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>KSP SCRB AI Intelligence Report</title>
  <style>
    @page {{ size: A4; margin: 0; }}
    * {{ box-sizing: border-box; }}
    body {{ margin: 0; background: #e8eee9; color: #17201d; font-family: Arial, sans-serif; }}
    .report-meta {{ display: none; }}
    .report-page {{ width: 210mm; min-height: 297mm; margin: 0 auto; padding: 18mm; background: #fbfcfb; page-break-after: always; position: relative; overflow: hidden; }}
    .report-page::after {{ content: "SCRB AI | Synthetic demonstration report | {generated}"; position: absolute; left: 18mm; right: 18mm; bottom: 9mm; border-top: 1px solid #d7dfda; padding-top: 4mm; color: #66736d; font-size: 10px; }}
    .cover {{ background: linear-gradient(135deg, #102f2a, #f8fbf8 54%); color: #0e1c19; }}
    .report-kicker {{ color: #a16207; font-size: 11px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; }}
    h1 {{ margin: 8px 0 12px; font-size: 34px; line-height: 1.05; color: #10201d; }}
    h2 {{ margin: 18px 0 8px; font-size: 17px; color: #0f5c49; }}
    h3 {{ margin: 14px 0 6px; color: #12342d; }}
    p, li, td, th {{ font-size: 14px; line-height: 1.55; }}
    table {{ width: 100%; border-collapse: collapse; margin: 8px 0 14px; }}
    th, td {{ border: 1px solid #d7dfda; padding: 10px; text-align: left; }}
    th {{ background: #edf4f0; color: #0f5c49; }}
    .ai-summary, .insight-box, .action-box {{ border: 1px solid #cfe0d8; border-left: 6px solid #0f766e; border-radius: 8px; padding: 16px; background: #f4faf7; margin: 16px 0; }}
    .risk-table td:last-child {{ font-weight: 800; }}
    .status {{ display: inline-block; width: 12px; height: 12px; border-radius: 50%; margin-right: 8px; vertical-align: middle; }}
    .red {{ background: #dc2626; }} .orange {{ background: #f59e0b; }}
    .kpi-report-grid, .profile-grid {{ display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin: 14px 0; }}
    .profile-grid {{ grid-template-columns: repeat(2, 1fr); }}
    .kpi-report-grid article, .profile-grid article, .confidence-card {{ border: 1px solid #d7dfda; border-radius: 8px; padding: 14px; background: #fff; }}
    .kpi-report-grid span, .profile-grid span, .confidence-card span {{ display: block; color: #66736d; font-size: 11px; font-weight: 800; text-transform: uppercase; }}
    .kpi-report-grid strong, .profile-grid strong, .confidence-card strong {{ display: block; margin-top: 6px; font-size: 24px; color: #10201d; }}
    .visual-grid, .two-col, .network-layout, .explain-layout {{ display: grid; grid-template-columns: 1fr 1fr; gap: 14px; align-items: start; }}
    .chart-card, .network-visual {{ border: 1px solid #d7dfda; border-radius: 8px; padding: 12px; background: #fff; }}
    .report-chart {{ width: 100%; height: 180px; }}
    .donut-wrap {{ display: grid; grid-template-columns: 130px 1fr; gap: 12px; align-items: center; }}
    .donut {{ width: 120px; height: 120px; border-radius: 50%; background: conic-gradient(#0f766e 0 34%, #2563eb 34% 56%, #f59e0b 56% 74%, #d7dfda 74%); }}
    .growth-strip, .legend, .priority-ladder {{ display: flex; gap: 10px; flex-wrap: wrap; margin: 12px 0; }}
    .growth-strip span, .legend span, .priority-ladder span {{ border-radius: 999px; padding: 8px 11px; background: #edf4f0; color: #0f5c49; font-weight: 800; font-size: 12px; }}
    .heatmap {{ height: 330px; position: relative; border-radius: 10px; border: 1px solid #d7dfda; background: radial-gradient(circle at 62% 30%, rgba(220,38,38,.5), transparent 15%), radial-gradient(circle at 38% 58%, rgba(245,158,11,.45), transparent 15%), radial-gradient(circle at 25% 25%, rgba(37,99,235,.35), transparent 14%), linear-gradient(135deg, #0d2b27, #f8fbf8); }}
    .hot {{ position: absolute; transform: translate(-50%, -50%); border-radius: 999px; padding: 8px 10px; color: #fff; font-size: 12px; font-weight: 800; }}
    .hot.high {{ background: #dc2626; }} .hot.medium {{ background: #f59e0b; }} .hot.emerging {{ background: #2563eb; }}
    .legend i {{ display: inline-block; width: 10px; height: 10px; margin-right: 6px; border-radius: 50%; }} .legend .high {{ background:#dc2626; }} .legend .medium {{ background:#f59e0b; }} .legend .emerging {{ background:#2563eb; }}
    .big-list li {{ margin: 9px 0; font-size: 17px; font-weight: 800; }}
    .check-list {{ padding-left: 20px; }}
    .check-list li {{ margin: 6px 0; }}
    .wide-table td:last-child {{ font-weight: 800; color: #0f5c49; }}
    .case-bridge {{ display: grid; grid-template-columns: 1fr auto 1fr; gap: 10px; margin-top: 22px; align-items: center; }}
    .case-bridge span, .case-bridge i {{ border-radius: 8px; padding: 14px; text-align: center; background: #edf4f0; font-weight: 800; font-style: normal; }}
    .case-bridge i {{ background: #0f766e; color: #fff; }}
    .timeline {{ margin-top: 18px; border-left: 4px solid #0f766e; padding-left: 20px; }}
    .timeline div {{ position: relative; display: grid; grid-template-columns: 90px 1fr; gap: 12px; padding: 14px 0; border-bottom: 1px solid #d7dfda; }}
    .timeline div::before {{ content: ""; position: absolute; left: -29px; top: 18px; width: 12px; height: 12px; border-radius: 50%; background: #0f766e; }}
    time {{ font-weight: 900; color: #0f5c49; }}
    .alert-list {{ display: grid; gap: 12px; margin: 20px 0; }}
    .alert-list article {{ border-radius: 8px; padding: 16px; border-left: 8px solid #dc2626; background: #fff5f5; }}
    .alert-list .warning {{ border-left-color: #f59e0b; background: #fffbeb; }}
    .alert-list span {{ display: block; margin-top: 4px; color: #66736d; }}
    .factor {{ margin: 12px 0; }}
    .factor span {{ display: block; font-weight: 800; margin-bottom: 5px; }}
    .factor i {{ display: block; height: 12px; border-radius: 999px; background: linear-gradient(90deg, #0f766e, #f59e0b, #dc2626); }}
    .small strong {{ font-size: 34px; }}
    @media print {{ body {{ background: #fff; }} .report-page {{ margin: 0; box-shadow: none; }} }}
  </style>
</head>
<body>
  <div class="report-meta">Generated for {officer} ({badge})</div>
  {''.join(pages)}
</body>
</html>"""


class KspScrbHandler(SimpleHTTPRequestHandler):
    server_version = "KSP-SCRB-Prototype/1.0"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(PUBLIC_DIR), **kwargs)

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "same-origin")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin", "*"))
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/health":
            self.send_json({"status": "ok", "timestamp": utc_now()})
            return
        if path == "/api/summary":
            user = self.require_auth()
            if not user:
                return
            records = user_scoped_records(load_records(), user)
            self.send_json(
                {
                    "user": public_user(user),
                    "record_count": len(records),
                    "latest_month": max(month_key(record) for record in records),
                    "synthetic": True,
                }
            )
            return
        if path == "/api/analytics":
            user = self.require_auth()
            if not user:
                return
            self.send_json(build_analytics(load_records(), user))
            return
        if path == "/api/linkage":
            user = self.require_auth()
            if not user:
                return
            if "linkage" not in user["permissions"]:
                self.send_json({"error": "linkage permission required"}, HTTPStatus.FORBIDDEN)
                return
            records = user_scoped_records(load_records(), user)
            self.send_json(aggregate_case_linkages(records, mask_people=user["role"] == "analyst"))
            return
        if path == "/api/audit":
            user = self.require_auth()
            if not user:
                return
            if "audit" not in user["permissions"]:
                self.send_json({"error": "audit permission required"}, HTTPStatus.FORBIDDEN)
                return
            self.send_json({"events": recent_audit()})
            return
        super().do_GET()

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/auth/login":
            body = self.read_json()
            profile = body.get("profile")
            if profile not in DEMO_USERS:
                self.send_json({"error": "unknown demo profile"}, HTTPStatus.UNAUTHORIZED)
                return
            token = secrets.token_urlsafe(32)
            SESSIONS[token] = DEMO_USERS[profile].copy()
            self.send_json({"token": token, "user": public_user(SESSIONS[token])})
            return
        if path == "/api/chat":
            user = self.require_auth()
            if not user:
                return
            body = self.read_json()
            message = str(body.get("message", "")).strip()
            if not message:
                self.send_json({"error": "message is required"}, HTTPStatus.BAD_REQUEST)
                return
            response = process_chat(
                message=message,
                user=user,
                conversation=body.get("conversation") or [],
                language=body.get("language", "en"),
            )
            self.send_json(response)
            return
        if path == "/api/agent/run":
            user = self.require_auth()
            if not user:
                return
            if "agent" not in user["permissions"]:
                self.send_json({"error": "agent permission required"}, HTTPStatus.FORBIDDEN)
                return
            body = self.read_json()
            objective = str(body.get("objective", "operational_triage")).strip() or "operational_triage"
            brief = build_agent_brief(load_records(), user, objective=objective)
            audit_id = f"AGT-AUD-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}-{secrets.token_hex(3).upper()}"
            audit = {
                "audit_id": audit_id,
                "timestamp": utc_now(),
                "actor": user["badge_id"],
                "role": user["role"],
                "intent": "agent_brief",
                "filters": {"scope": user["district_scope"], "objective": objective},
                "records_considered": brief["records_considered"],
                "records_returned": len(brief["action_queue"]),
                "model_route": "deterministic-agent-orchestrator",
                "guardrails": brief["guardrails"],
            }
            append_audit(audit | {"run_id": brief["run_id"]})
            self.send_json(brief | {"audit": audit})
            return
        if path == "/api/copilot/brief":
            user = self.require_auth()
            if not user:
                return
            if "copilot" not in user["permissions"]:
                self.send_json({"error": "copilot permission required"}, HTTPStatus.FORBIDDEN)
                return
            body = self.read_json()
            objective = str(body.get("objective", "proactive_intelligence_watch")).strip() or "proactive_intelligence_watch"
            brief = build_investigation_copilot(load_records(), user, objective=objective)
            audit_id = f"COP-AUD-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}-{secrets.token_hex(3).upper()}"
            audit = {
                "audit_id": audit_id,
                "timestamp": utc_now(),
                "actor": user["badge_id"],
                "role": user["role"],
                "intent": "copilot_brief",
                "filters": {"scope": user["district_scope"], "objective": objective},
                "records_considered": brief["records_considered"],
                "records_returned": len(brief["proactive_insights"]),
                "model_route": "deterministic-investigation-copilot",
                "guardrails": brief["guardrails"],
            }
            append_audit(audit | {"run_id": brief["run_id"]})
            self.send_json(brief | {"audit": audit})
            return
        if path == "/api/report":
            user = self.require_auth()
            if not user:
                return
            if "export" not in user["permissions"]:
                self.send_json({"error": "export permission required"}, HTTPStatus.FORBIDDEN)
                return
            audit_id = f"REP-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}-{secrets.token_hex(3).upper()}"
            append_audit(
                {
                    "audit_id": audit_id,
                    "timestamp": utc_now(),
                    "actor": user["badge_id"],
                    "role": user["role"],
                    "intent": "intelligence_report",
                    "filters": {"report": "organized_vehicle_theft_intelligence"},
                    "records_considered": len(user_scoped_records(load_records(), user)),
                    "records_returned": 11,
                    "model_route": "deterministic-report-renderer",
                    "guardrails": ["export_permission", "synthetic_data_notice", "print_pdf_user_action"],
                }
            )
            self.send_json(
                {
                    "audit_id": audit_id,
                    "filename": f"ksp-scrb-ai-intelligence-report-{audit_id}.html",
                    "html": render_intelligence_report_html(user),
                }
            )
            return
        if path == "/api/export":
            user = self.require_auth()
            if not user:
                return
            if "export" not in user["permissions"]:
                self.send_json({"error": "export permission required"}, HTTPStatus.FORBIDDEN)
                return
            body = self.read_json()
            conversation = body.get("conversation") or []
            audit_id = f"EXP-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}-{secrets.token_hex(3).upper()}"
            append_audit(
                {
                    "audit_id": audit_id,
                    "timestamp": utc_now(),
                    "actor": user["badge_id"],
                    "role": user["role"],
                    "intent": "export",
                    "records_considered": 0,
                    "records_returned": len(conversation),
                    "model_route": "export-renderer",
                    "guardrails": ["export_permission", "print_pdf_user_action"],
                }
            )
            self.send_json(
                {
                    "audit_id": audit_id,
                    "filename": f"ksp-scrb-transcript-{audit_id}.html",
                    "html": render_export_html(conversation, user),
                }
            )
            return
        self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            return {}

    def require_auth(self) -> dict[str, Any] | None:
        auth = self.headers.get("Authorization", "")
        token = auth.removeprefix("Bearer ").strip()
        user = SESSIONS.get(token)
        if not user:
            self.send_json({"error": "authentication required"}, HTTPStatus.UNAUTHORIZED)
            return None
        return user

    def send_json(self, payload: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


def run(host: str, port: int) -> None:
    if not PUBLIC_DIR.exists():
        raise SystemExit("public directory is missing")
    server = ThreadingHTTPServer((host, port), KspScrbHandler)
    try:
        print(f"KSP SCRB prototype running at http://{host}:{port}", flush=True)
    except OSError:
        pass
    server.serve_forever()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the KSP SCRB conversational intelligence prototype.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    run(args.host, args.port)
