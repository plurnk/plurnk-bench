import subprocess
import unittest

from terminal_bench.network_probe import PROBE, failures


def evidence():
    rows = []
    for phase in ["baseline", "agent-allowed", "agent-denied", "baseline-restored"]:
        checks = []
        for index, host in enumerate(["provider.example", "unrelated.example"]):
            reachable = phase in ("baseline", "baseline-restored") or (phase == "agent-allowed" and index == 0)
            checks.append({
                "host": host, "dns": {"address": "192.0.2.1", "family": 4},
                "https": {"status": 401} if reachable else {"error": "ECONNRESET"},
                "pinned": {"status": 401} if reachable else {"error": "ECONNRESET"},
            })
        rows.append({"phase": phase, "return_code": 0, "checks": checks})
    return rows


class NetworkProbeTest(unittest.TestCase):
    """{§frontier-egress-probe}: a diagnostic must not call a failed allowlist green."""

    def test_reachable_provider_and_blocked_unrelated_hosts_pass(self):
        self.assertEqual(failures(evidence()), [])

    def test_missing_allowed_dns_and_https_are_named(self):
        rows = evidence()
        rows[1]["checks"][0].update(dns={"error": "EAI_AGAIN"}, https={"error": "EAI_AGAIN"})
        self.assertEqual(failures(rows), [
            "agent-allowed: provider.example: DNS unavailable",
            "agent-allowed: provider.example: HTTPS unavailable",
        ])

    def test_denied_hosts_cannot_pass_by_avoiding_dns(self):
        rows = evidence()
        rows[1]["checks"][1]["pinned"] = {"status": 200}
        rows[2]["checks"][0]["https"] = {"status": 401}
        self.assertEqual(failures(rows), [
            "agent-allowed: unrelated.example: HTTPS reachable despite denial",
            "agent-denied: provider.example: HTTPS reachable despite denial",
        ])

    def test_missing_baseline_recovery_is_not_success(self):
        self.assertEqual(failures(evidence()[:-1]), ["incomplete phase evidence"])
        rows = evidence()
        rows[-1]["return_code"] = 7
        self.assertEqual(failures(rows), ["baseline-restored: probe process exited 7"])

    def test_empty_destination_evidence_is_not_success(self):
        rows = evidence()
        rows[1]["checks"] = []
        self.assertEqual(failures(rows), ["agent-allowed: missing destination evidence"])

    def test_embedded_node_probe_is_valid_javascript(self):
        result = subprocess.run(["node", "--input-type=module", "--check"],
                                input=PROBE, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
