import unittest

import app


class EngineTests(unittest.TestCase):
    def setUp(self):
        self.investigator = app.DEMO_USERS["investigator"].copy()
        self.analyst = app.DEMO_USERS["analyst"].copy()

    def test_hotspot_query_returns_audit_and_sources(self):
        result = app.process_chat("Show hotspots in Bengaluru City", self.investigator)
        self.assertEqual(result["intent"], "hotspot")
        self.assertEqual(result["filters"]["district"], "Bengaluru City")
        self.assertGreater(result["audit"]["records_returned"], 0)
        self.assertTrue(result["sources"])

    def test_analyst_network_response_masks_named_linkages(self):
        result = app.process_chat("Find network links around Arjun Nayak", self.analyst)
        self.assertEqual(result["intent"], "network")
        self.assertIn("not named suspect linkages", result["answer"])

    def test_kannada_query_uses_kannada_response(self):
        result = app.process_chat("ಈ ತಿಂಗಳ ಅಪರಾಧ ಎಚ್ಚರಿಕೆಗಳು", self.investigator, language="kn")
        self.assertEqual(result["intent"], "prediction")
        self.assertIn("ಮುನ್ನೆಚ್ಚರಿಕೆ", result["answer"])

    def test_behavioral_query_returns_profiles(self):
        result = app.process_chat("Show behavioral profiling for cyber fraud", self.investigator)
        self.assertEqual(result["intent"], "behavior")
        self.assertIn("Behavioral profiling", result["answer"])
        self.assertTrue(result["analytics_patch"]["behavior_profiles"])

    def test_agent_brief_builds_role_scoped_actions(self):
        brief = app.build_agent_brief(app.load_records(), self.investigator)
        self.assertEqual(brief["name"], "SCRB Field Intelligence Agent")
        self.assertTrue(brief["action_queue"])
        self.assertIn("human_verification_required", brief["guardrails"])

    def test_case_linkage_engine_builds_clusters_and_evidence(self):
        linkage = app.aggregate_case_linkages(app.user_scoped_records(app.load_records(), self.investigator), mask_people=False)
        self.assertTrue(linkage["clusters"])
        top_cluster = linkage["clusters"][0]
        self.assertGreaterEqual(top_cluster["confidence"], 50)
        self.assertTrue(top_cluster["supporting_links"])
        dimensions = set(top_cluster["supporting_links"][0]["dimensions"])
        self.assertTrue({"modus_operandi", "location_pattern", "time_pattern"} & dimensions)
        self.assertTrue(linkage["graph"]["nodes"])

    def test_linkage_chat_returns_case_linkage_payload(self):
        result = app.process_chat("Run case linkage engine for hidden relationships", self.investigator)
        self.assertEqual(result["intent"], "linkage")
        self.assertIn("Case Linkage Engine found", result["answer"])
        self.assertTrue(result["analytics_patch"]["case_linkage"]["clusters"])

    def test_analyst_linkage_masks_named_people(self):
        linkage = app.aggregate_case_linkages(app.load_records(), mask_people=True)
        serialized = str(linkage)
        self.assertIn("Person ", serialized)
        self.assertNotIn("Arjun Nayak", serialized)

    def test_analyst_agent_masks_repeat_people(self):
        brief = app.build_agent_brief(app.load_records(), self.analyst)
        names = [
            person["name"]
            for profile in brief["behavior_profiles"]
            for person in profile["repeat_people"]
        ]
        self.assertTrue(any(name.startswith("Person ") for name in names))
        self.assertNotIn("Arjun Nayak", names)

    def test_copilot_generates_proactive_investigation_brief(self):
        brief = app.build_investigation_copilot(app.load_records(), self.investigator)
        self.assertEqual(brief["name"], "AI Investigation Copilot")
        self.assertTrue(brief["suspect_leads"])
        self.assertTrue(brief["next_actions"])
        self.assertTrue(brief["hidden_relationships"])
        self.assertTrue(brief["anomalies"])
        self.assertTrue(brief["resource_deployments"])
        self.assertTrue(brief["reasoning"])

    def test_copilot_chat_intent_suggests_leads(self):
        result = app.process_chat("Copilot suggest suspects, anomalies, and resource deployment", self.investigator)
        self.assertEqual(result["intent"], "copilot")
        self.assertIn("AI Investigation Copilot", result["answer"])
        self.assertTrue(result["copilot"]["suspect_leads"])

    def test_analyst_copilot_masks_suspect_leads(self):
        brief = app.build_investigation_copilot(app.load_records(), self.analyst)
        names = [lead["name"] for lead in brief["suspect_leads"]]
        self.assertTrue(any(name.startswith("Person ") for name in names))
        self.assertNotIn("Arjun Nayak", names)

    def test_enhanced_report_contains_required_pages(self):
        report = app.render_intelligence_report_html(self.investigator)
        self.assertEqual(report.count('<section class="report-page'), 11)
        self.assertIn("Executive Intelligence Summary", report)
        self.assertIn("AI Case Linkage Findings", report)
        self.assertIn("Investigation Timeline Reconstruction", report)
        self.assertIn("Explainable AI Section", report)
        self.assertIn("Vehicle theft incidents increased by 24%", report)


if __name__ == "__main__":
    unittest.main()
