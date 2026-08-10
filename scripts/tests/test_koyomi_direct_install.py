import importlib.util
import json
import plistlib
import unittest
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "koyomi_direct_install.py"
SPEC = importlib.util.spec_from_file_location("koyomi_direct_install", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load {SCRIPT}")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class KoyomiDirectInstallTests(unittest.TestCase):
    def test_concrete_entitlements_use_the_same_shared_keychain_group(self):
        profile_entitlements = {
            "application-identifier": "UGNVGWZMAU.*",
            "com.apple.developer.team-identifier": "UGNVGWZMAU",
            "get-task-allow": True,
            "keychain-access-groups": ["UGNVGWZMAU.*", "com.apple.token"],
        }

        app = MODULE.concrete_entitlements(profile_entitlements, "run.kan.koyomi")
        widget = MODULE.concrete_entitlements(profile_entitlements, "run.kan.koyomi.widget")

        self.assertEqual(app["application-identifier"], "UGNVGWZMAU.run.kan.koyomi")
        self.assertEqual(widget["application-identifier"], "UGNVGWZMAU.run.kan.koyomi.widget")
        self.assertEqual(app["keychain-access-groups"], [MODULE.SHARED_KEYCHAIN_ACCESS_GROUP])
        self.assertEqual(widget["keychain-access-groups"], [MODULE.SHARED_KEYCHAIN_ACCESS_GROUP])

    def test_concrete_entitlements_fail_without_wildcard_keychain_permission(self):
        profile_entitlements = {
            "application-identifier": "UGNVGWZMAU.*",
            "com.apple.developer.team-identifier": "UGNVGWZMAU",
            "get-task-allow": True,
            "keychain-access-groups": ["UGNVGWZMAU.unrelated"],
        }

        with self.assertRaisesRegex(ValueError, "wildcard Keychain access group"):
            MODULE.concrete_entitlements(profile_entitlements, "run.kan.koyomi")

    def test_device_details_require_a_booted_physical_ios_device_in_developer_mode(self):
        details = {
            "result": {
                "identifier": "core-device-id",
                "deviceProperties": {
                    "name": "Kans iPhone",
                    "developerModeStatus": "enabled",
                    "bootState": "booted",
                    "osVersionNumber": "27.0",
                },
                "hardwareProperties": {
                    "reality": "physical",
                    "platform": "iOS",
                    "udid": "target-udid",
                },
            }
        }

        result = MODULE.validate_device_details(details)

        self.assertEqual(result["udid"], "target-udid")
        self.assertEqual(result["identifier"], "core-device-id")

    def test_installed_app_and_running_process_are_read_back_from_coredevice(self):
        apps = {
            "result": {
                "apps": [
                    {
                        "bundleIdentifier": "run.kan.koyomi",
                        "bundleVersion": "1",
                        "version": "1.0.0",
                        "name": "こよみ",
                        "containerAccessible": True,
                    }
                ]
            }
        }
        processes = {
            "result": {
                "runningProcesses": [
                    {
                        "executable": "/private/var/containers/Bundle/Application/id/Koyomi.app/Koyomi",
                        "processIdentifier": 1234,
                    }
                ]
            }
        }

        installed = MODULE.validate_installed_app(apps)
        running = MODULE.validate_running_process(processes)

        self.assertEqual(installed["bundleIdentifier"], "run.kan.koyomi")
        self.assertEqual(running["processIdentifier"], 1234)

    def test_profile_selection_requires_target_device_and_matching_key(self):
        now = datetime(2026, 8, 10, tzinfo=timezone.utc)
        candidates = [
            {
                "path": Path("wrong-device.mobileprovision"),
                "name": "wrong device",
                "uuid": "wrong-device",
                "team": "UGNVGWZMAU",
                "app_identifier": "UGNVGWZMAU.*",
                "get_task_allow": True,
                "devices": ["other-udid"],
                "expires": datetime(2027, 1, 1, tzinfo=timezone.utc),
                "certificate_hashes": {"MATCH"},
                "entitlements": {},
            },
            {
                "path": Path("no-keychain.mobileprovision"),
                "name": "no keychain permission",
                "uuid": "no-keychain",
                "team": "UGNVGWZMAU",
                "app_identifier": "UGNVGWZMAU.*",
                "get_task_allow": True,
                "devices": ["target-udid"],
                "expires": datetime(2028, 1, 1, tzinfo=timezone.utc),
                "certificate_hashes": {"MATCH"},
                "entitlements": {},
            },
            {
                "path": Path("valid.mobileprovision"),
                "name": "valid",
                "uuid": "valid-profile",
                "team": "UGNVGWZMAU",
                "app_identifier": "UGNVGWZMAU.*",
                "get_task_allow": True,
                "devices": ["target-udid"],
                "expires": datetime(2027, 7, 1, tzinfo=timezone.utc),
                "certificate_hashes": {"MATCH"},
                "entitlements": {"keychain-access-groups": ["UGNVGWZMAU.*"]},
            },
        ]

        profile, identity = MODULE.select_profile(
            candidates,
            {"MATCH"},
            "target-udid",
            now,
        )

        self.assertEqual(profile["uuid"], "valid-profile")
        self.assertEqual(identity, "MATCH")

    def test_repository_workflow_contract_is_complete(self):
        self.assertEqual(MODULE.verify_repository_contract(ROOT), [])
        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        self.assertIn(
            "scripts/tests/test_koyomi_direct_install.py",
            package["scripts"]["test:app-store"],
        )
        workflow = (ROOT / ".github" / "workflows" / "koyomi-direct-install.yml").read_text(
            encoding="utf-8"
        )
        for nested_code in (
            "$APP_PATH/__preview.dylib",
            "$APP_PATH/Koyomi.debug.dylib",
            "$WIDGET_PATH/__preview.dylib",
            "$WIDGET_PATH/KoyomiWidget.debug.dylib",
        ):
            self.assertIn(nested_code, workflow)
        self.assertIn('codesign --verify --strict "$NESTED_CODE"', workflow)
        self.assertNotIn("patch-source", workflow)
        self.assertIn(MODULE.SHARED_KEYCHAIN_ACCESS_GROUP, workflow)
        self.assertIn("Direct-install widget Keychain sharing: PASS", workflow)


if __name__ == "__main__":
    unittest.main()
