import json
import os
import plistlib
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "verify-ios-archive.py"
COMMIT = "a" * 40


class VerifyIOSArchiveTests(unittest.TestCase):
    def make_archive(
        self,
        device_family=None,
        include_privacy=True,
        include_executable=True,
        build_commit=COMMIT,
    ):
        temporary = tempfile.TemporaryDirectory()
        root = Path(temporary.name)
        archive = root / "afterimage.xcarchive"
        app = archive / "Products" / "Applications" / "afterimage.app"
        extension = app / "PlugIns" / "AfterimageUploadWidget.appex"
        extension.mkdir(parents=True)
        tool_bin = root / "bin"
        tool_bin.mkdir()
        codesign = tool_bin / "codesign"
        codesign.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        codesign.chmod(0o755)
        family = [1] if device_family is None else device_family
        with (app / "Info.plist").open("wb") as handle:
            plistlib.dump({
                "CFBundleIdentifier": "com.2-38.afterimage",
                "CFBundleShortVersionString": "0.1.0",
                "CFBundleVersion": "42",
                "CFBundleExecutable": "afterimage",
                "AfterimageBuildCommit": build_commit,
                "UIDeviceFamily": family,
            }, handle)
        with (extension / "Info.plist").open("wb") as handle:
            plistlib.dump({
                "CFBundleIdentifier": "com.2-38.afterimage.upload-widget",
                "CFBundleShortVersionString": "0.1.0",
                "CFBundleVersion": "42",
                "CFBundleExecutable": "AfterimageUploadWidget",
                "AfterimageBuildCommit": build_commit,
                "UIDeviceFamily": [1],
            }, handle)
        if include_privacy:
            expected_privacy = ROOT / "ios" / "Resources" / "PrivacyInfo.xcprivacy"
            with expected_privacy.open("rb") as handle:
                privacy = plistlib.load(handle)
            with (app / "PrivacyInfo.xcprivacy").open("wb") as handle:
                plistlib.dump(privacy, handle)
        if include_executable:
            for executable in [
                app / "afterimage",
                extension / "AfterimageUploadWidget",
            ]:
                executable.write_bytes(b"\xcf\xfa\xed\xfe" + b"\0" * 4_096)
                executable.chmod(0o755)
        return temporary, archive, root / "evidence.json"

    def run_verifier(self, archive, report):
        environment = os.environ.copy()
        environment["PATH"] = f"{archive.parent / 'bin'}:{environment['PATH']}"
        return subprocess.run([
            "python3",
            str(SCRIPT),
            "--archive",
            str(archive),
            "--expected-commit",
            COMMIT,
            "--expected-build",
            "42",
            "--expected-privacy-manifest",
            str(ROOT / "ios" / "Resources" / "PrivacyInfo.xcprivacy"),
            "--report",
            str(report),
        ], capture_output=True, text=True, check=False, env=environment)

    def test_valid_archive_writes_commit_bound_evidence(self):
        temporary, archive, report = self.make_archive()
        self.addCleanup(temporary.cleanup)

        result = self.run_verifier(archive, report)

        self.assertEqual(result.returncode, 0, result.stderr)
        evidence = json.loads(report.read_text(encoding="utf-8"))
        self.assertEqual(evidence["commit"], COMMIT)
        self.assertEqual(evidence["app"]["deviceFamily"], [1])
        self.assertEqual(evidence["app"]["bundleVersion"], "42")
        self.assertEqual(len(evidence["extensions"]), 1)
        self.assertEqual(len(evidence["privacyManifest"]["sha256"]), 64)

    def test_different_embedded_commit_is_rejected(self):
        temporary, archive, report = self.make_archive(build_commit="b" * 40)
        self.addCleanup(temporary.cleanup)

        result = self.run_verifier(archive, report)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("AfterimageBuildCommit", result.stderr)
        self.assertFalse(report.exists())

    def test_ipad_family_is_rejected(self):
        temporary, archive, report = self.make_archive(device_family=[1, 2])
        self.addCleanup(temporary.cleanup)

        result = self.run_verifier(archive, report)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("UIDeviceFamily", result.stderr)
        self.assertFalse(report.exists())

    def test_missing_privacy_manifest_is_rejected(self):
        temporary, archive, report = self.make_archive(include_privacy=False)
        self.addCleanup(temporary.cleanup)

        result = self.run_verifier(archive, report)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("PrivacyInfo.xcprivacy", result.stderr)
        self.assertFalse(report.exists())

    def test_missing_bundle_executable_is_rejected(self):
        temporary, archive, report = self.make_archive(include_executable=False)
        self.addCleanup(temporary.cleanup)

        result = self.run_verifier(archive, report)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("CFBundleExecutable", result.stderr)
        self.assertFalse(report.exists())

    def test_invalid_code_signature_is_rejected_on_macos(self):
        if os.uname().sysname != "Darwin":
            self.skipTest("codesign verification is macOS-only")
        temporary, archive, report = self.make_archive()
        self.addCleanup(temporary.cleanup)
        codesign = archive.parent / "bin" / "codesign"
        codesign.write_text(
            "#!/bin/sh\necho invalid-signature >&2\nexit 1\n",
            encoding="utf-8",
        )

        result = self.run_verifier(archive, report)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("codesign", result.stderr)
        self.assertIn("invalid-signature", result.stderr)
        self.assertFalse(report.exists())


if __name__ == "__main__":
    unittest.main()
