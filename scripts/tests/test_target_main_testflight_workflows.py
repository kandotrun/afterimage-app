import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class TargetMainTestFlightWorkflowTests(unittest.TestCase):
    def test_target_main_workflows_deploy_only_new_successful_commits(self):
        cases = {
            "koyomi-main-testflight.yml": "kandotrun/koyomi-ios",
            "tree-main-testflight.yml": "kandotrun/tree",
        }

        for filename, repository in cases.items():
            with self.subTest(filename=filename):
                workflow = (ROOT / ".github" / "workflows" / filename).read_text(
                    encoding="utf-8"
                )
                self.assertIn('cron: "*/5 * * * *"', workflow)
                self.assertIn("workflow_dispatch:", workflow)
                self.assertIn(f"TARGET_REPOSITORY: {repository}", workflow)
                self.assertIn(
                    'source_ref: ${{ needs.prepare.outputs.source_sha }}', workflow
                )
                self.assertIn("deployments: write", workflow)
                self.assertIn(
                    "uses: ./.github/workflows/verify-testflight-build.yml", workflow
                )
                self.assertIn("needs.verify.result == 'success'", workflow)
                self.assertIn("payload.source_sha", workflow)
                self.assertNotIn("pull_request:", workflow)
                self.assertNotIn("pull_request_target:", workflow)
                implementation = re.search(
                    rf"uses: {re.escape(repository)}/\.github/workflows/testflight\.yml@([0-9a-f]{{40}})",
                    workflow,
                )
                self.assertIsNotNone(
                    implementation,
                    f"{filename} must pin its reusable workflow to a full commit SHA",
                )

    def test_koyomi_verification_uses_version_from_the_archived_source_commit(self):
        workflow = (
            ROOT / ".github" / "workflows" / "koyomi-main-testflight.yml"
        ).read_text(encoding="utf-8")

        self.assertIn("version: ${{ steps.state.outputs.version }}", workflow)
        self.assertIn("contents/project.yml?ref=$SOURCE_SHA", workflow)
        self.assertIn('echo "version=$MARKETING_VERSION"', workflow)
        self.assertIn("version: ${{ needs.prepare.outputs.version }}", workflow)
        self.assertNotRegex(workflow, r"(?m)^\s+version:\s+\d+\.\d+\.\d+\s*$")

    def test_provisioning_registers_all_bundle_ids_before_apps(self):
        script = (ROOT / "scripts" / "provision_testflight_apps.rb").read_text(
            encoding="utf-8"
        )

        bundle_pass = script.index("bundle_ids = TARGETS.to_h")
        app_pass = script.index("ensure_app(target, bundle_ids.fetch(target))")
        self.assertLess(bundle_pass, app_pass)

    def test_provisioning_uses_clean_app_store_names(self):
        script = (ROOT / "scripts" / "provision_testflight_apps.rb").read_text(
            encoding="utf-8"
        )

        self.assertIn('app_name: "こよみ"', script)
        self.assertIn('app_name: "木のみず"', script)
        self.assertNotIn(" by kandotrun", script)

    def test_provisioning_synchronizes_existing_app_names(self):
        script = (ROOT / "scripts" / "provision_testflight_apps.rb").read_text(
            encoding="utf-8"
        )

        self.assertIn("def sync_app_name(app, target)", script)
        self.assertIn("fetch_edit_app_info || app.fetch_latest_app_info", script)
        self.assertIn("fetch_latest_app_info", script)
        self.assertIn("get_app_info_localizations", script)
        self.assertIn("localization.update(attributes: { name: target.app_name })", script)
        self.assertIn("update verification failed", script)
        self.assertIn("sync_app_name(app, target)", script)

    def test_ios_ci_covers_testflight_provisioning_contract(self):
        workflow = (ROOT / ".github" / "workflows" / "ios.yml").read_text(
            encoding="utf-8"
        )

        self.assertIn('      - "scripts/provision_testflight_apps.rb"', workflow)
        self.assertIn(
            '      - "scripts/tests/test_target_main_testflight_workflows.py"',
            workflow,
        )

    def test_testflight_build_verification_requires_valid_processing(self):
        script = (ROOT / "scripts" / "verify_testflight_build.rb").read_text(
            encoding="utf-8"
        )
        workflow = (
            ROOT / ".github" / "workflows" / "verify-testflight-build.yml"
        ).read_text(encoding="utf-8")

        self.assertIn("ProcessingState::VALID", script)
        self.assertIn("ProcessingState::FAILED", script)
        self.assertIn("ProcessingState::INVALID", script)
        self.assertIn("workflow_call:", workflow)
        self.assertIn("scripts/verify_testflight_build.rb", workflow)


if __name__ == "__main__":
    unittest.main()
