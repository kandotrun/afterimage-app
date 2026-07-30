#!/usr/bin/env python3

import argparse
import hashlib
import json
import os
import plistlib
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path


class VerificationError(Exception):
    pass


def read_plist(path):
    try:
        with path.open("rb") as handle:
            value = plistlib.load(handle)
    except (OSError, plistlib.InvalidFileException) as error:
        raise VerificationError(f"plistを読めません: {path}: {error}") from error
    if not isinstance(value, dict):
        raise VerificationError(f"plist rootがdictionaryではありません: {path}")
    return value


def sha256_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_executable(bundle, executable_name):
    if (
        not isinstance(executable_name, str)
        or not executable_name
        or Path(executable_name).name != executable_name
    ):
        raise VerificationError(
            f"CFBundleExecutableが不正です: {bundle.name}: {executable_name}"
        )
    executable = bundle / executable_name
    if executable.is_symlink() or not executable.is_file():
        raise VerificationError(
            f"CFBundleExecutableの実体がありません: {bundle.name}: {executable_name}"
        )
    if not os.access(executable, os.X_OK):
        raise VerificationError(
            f"CFBundleExecutableに実行権限がありません: {bundle.name}: {executable_name}"
        )
    with executable.open("rb") as handle:
        magic = handle.read(4)
    macho_magics = {
        b"\xcf\xfa\xed\xfe",
        b"\xfe\xed\xfa\xcf",
        b"\xca\xfe\xba\xbe",
        b"\xbe\xba\xfe\xca",
        b"\xca\xfe\xba\xbf",
        b"\xbf\xba\xfe\xca",
    }
    if magic not in macho_magics:
        raise VerificationError(
            f"CFBundleExecutableがMach-Oではありません: {bundle.name}: {executable_name}"
        )
    return {
        "path": str(executable.relative_to(bundle)),
        "sha256": sha256_file(executable),
    }


def verify_code_signature(bundle):
    if sys.platform != "darwin":
        return "not_checked_non_macos"
    result = subprocess.run(
        ["codesign", "--verify", "--deep", "--strict", "--verbose=2", str(bundle)],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        details = (result.stderr or result.stdout).strip()
        raise VerificationError(f"codesign検証に失敗しました: {bundle.name}: {details}")
    return "verified"


def verify_bundle(
    bundle,
    archive,
    expected_identifier,
    expected_build,
    expected_commit,
):
    info_path = bundle / "Info.plist"
    info = read_plist(info_path)
    identifier = info.get("CFBundleIdentifier")
    version = info.get("CFBundleShortVersionString")
    build = str(info.get("CFBundleVersion", ""))
    embedded_commit = info.get("AfterimageBuildCommit")
    family = info.get("UIDeviceFamily")
    if identifier != expected_identifier:
        raise VerificationError(
            f"CFBundleIdentifierが不正です: {bundle.name}: {identifier}"
        )
    if not isinstance(version, str) or not version.strip():
        raise VerificationError(f"CFBundleShortVersionStringがありません: {bundle.name}")
    if build != expected_build:
        raise VerificationError(
            f"CFBundleVersionが期待値と一致しません: {bundle.name}: {build}"
        )
    if embedded_commit != expected_commit:
        raise VerificationError(
            f"AfterimageBuildCommitが期待値と一致しません: {bundle.name}: {embedded_commit}"
        )
    if family != [1]:
        raise VerificationError(
            f"UIDeviceFamilyは[1]である必要があります: {bundle.name}: {family}"
        )
    executable = verify_executable(bundle, info.get("CFBundleExecutable"))
    signature = verify_code_signature(bundle)
    return {
        "path": str(bundle.relative_to(archive)),
        "bundleIdentifier": identifier,
        "shortVersion": version,
        "bundleVersion": build,
        "embeddedCommit": embedded_commit,
        "deviceFamily": family,
        "executable": executable,
        "codeSignature": signature,
        "infoPlistSha256": sha256_file(info_path),
    }


def parse_arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", required=True)
    parser.add_argument("--expected-commit", required=True)
    parser.add_argument("--expected-build", required=True)
    parser.add_argument("--expected-privacy-manifest", required=True)
    parser.add_argument("--report", required=True)
    return parser.parse_args()


def run():
    arguments = parse_arguments()
    if not re.fullmatch(r"[0-9a-fA-F]{40}", arguments.expected_commit):
        raise VerificationError("expected commitは40桁のSHAである必要があります")
    if not re.fullmatch(r"[1-9][0-9]*", arguments.expected_build):
        raise VerificationError("expected buildは正の整数である必要があります")

    archive = Path(arguments.archive).resolve(strict=True)
    if not archive.is_dir() or archive.suffix != ".xcarchive":
        raise VerificationError("archiveは存在する.xcarchive directoryである必要があります")
    applications = sorted((archive / "Products" / "Applications").glob("*.app"))
    if len(applications) != 1:
        raise VerificationError(f"app bundleは1つ必要です: {len(applications)}")
    app = applications[0]
    app_evidence = verify_bundle(
        app,
        archive,
        "com.2-38.afterimage",
        arguments.expected_build,
        arguments.expected_commit.lower(),
    )

    extensions = sorted((app / "PlugIns").glob("*.appex"))
    if len(extensions) != 1:
        raise VerificationError(f"app extensionは1つ必要です: {len(extensions)}")
    extension_evidence = verify_bundle(
        extensions[0],
        archive,
        "com.2-38.afterimage.upload-widget",
        arguments.expected_build,
        arguments.expected_commit.lower(),
    )
    if extension_evidence["shortVersion"] != app_evidence["shortVersion"]:
        raise VerificationError("appとextensionのshort versionが一致しません")

    manifests = sorted(app.rglob("PrivacyInfo.xcprivacy"))
    expected_manifest = Path(arguments.expected_privacy_manifest).resolve(strict=True)
    if len(manifests) != 1 or manifests[0].parent != app:
        raise VerificationError(
            f"PrivacyInfo.xcprivacyはapp rootに1つだけ必要です: {len(manifests)}"
        )
    archived_privacy = read_plist(manifests[0])
    expected_privacy = read_plist(expected_manifest)
    if archived_privacy != expected_privacy:
        raise VerificationError("archive内PrivacyInfo.xcprivacyがsource of truthと一致しません")

    report = Path(arguments.report).resolve()
    report.parent.mkdir(parents=True, exist_ok=True)
    evidence = {
        "version": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "commit": arguments.expected_commit.lower(),
        "app": app_evidence,
        "extensions": [extension_evidence],
        "privacyManifest": {
            "path": str(manifests[0].relative_to(archive)),
            "sha256": sha256_file(manifests[0]),
            "sourceSha256": sha256_file(expected_manifest),
            "tracking": archived_privacy.get("NSPrivacyTracking"),
            "accessedAPITypes": archived_privacy.get("NSPrivacyAccessedAPITypes", []),
        },
    }
    with tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=report.parent,
        prefix=f".{report.name}.",
        delete=False,
    ) as handle:
        json.dump(evidence, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")
        temporary = Path(handle.name)
    os.replace(temporary, report)
    print("iOS archive verification: PASS")


def main():
    try:
        run()
    except (FileNotFoundError, VerificationError) as error:
        print(f"iOS archive verification failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
