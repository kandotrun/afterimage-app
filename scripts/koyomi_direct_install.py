#!/usr/bin/env python3
import argparse
import copy
import hashlib
import json
import plistlib
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path


TEAM_ID = "UGNVGWZMAU"
APP_BUNDLE_ID = "run.kan.koyomi"
WIDGET_BUNDLE_ID = "run.kan.koyomi.widget"
SHARED_KEYCHAIN_ACCESS_GROUP = f"{TEAM_ID}.run.kan.koyomi.shared"
SOURCE_SHA = "210e99e4b59f08c490f462e644f9fabb3be5e237"


def concrete_entitlements(profile_entitlements: dict, bundle_id: str) -> dict:
    wildcard_group = f"{TEAM_ID}.*"
    if wildcard_group not in profile_entitlements.get("keychain-access-groups", []):
        raise ValueError("profile does not permit the wildcard Keychain access group")
    entitlements = copy.deepcopy(profile_entitlements)
    entitlements.pop("com.apple.security.application-groups", None)
    entitlements["application-identifier"] = f"{TEAM_ID}.{bundle_id}"
    entitlements["keychain-access-groups"] = [SHARED_KEYCHAIN_ACCESS_GROUP]
    return entitlements


def validate_device_details(details: dict) -> dict:
    result = details.get("result") or {}
    device = result.get("deviceProperties") or {}
    hardware = result.get("hardwareProperties") or {}
    checks = {
        "physical device": hardware.get("reality") == "physical",
        "iOS platform": hardware.get("platform") == "iOS",
        "booted device": device.get("bootState") == "booted",
        "Developer Mode": device.get("developerModeStatus") == "enabled",
    }
    failed = [name for name, passed in checks.items() if not passed]
    if failed:
        raise ValueError(f"device preflight failed: {', '.join(failed)}")
    version = str(device.get("osVersionNumber") or "")
    try:
        major = int(version.split(".", 1)[0])
    except ValueError as error:
        raise ValueError("device OS version is invalid") from error
    if major < 26:
        raise ValueError("Koyomi requires iOS 26 or newer")
    udid = str(hardware.get("udid") or "")
    identifier = str(result.get("identifier") or "")
    if not udid or not identifier:
        raise ValueError("device identifiers are missing")
    return {
        "udid": udid,
        "identifier": identifier,
        "name": str(device.get("name") or ""),
        "os_version": version,
    }


def validate_installed_app(details: dict) -> dict:
    apps = (details.get("result") or {}).get("apps") or []
    matches = [app for app in apps if app.get("bundleIdentifier") == APP_BUNDLE_ID]
    if len(matches) != 1:
        raise ValueError("installed Koyomi app was not read back exactly once")
    app = matches[0]
    if app.get("containerAccessible") is not True:
        raise ValueError("installed Koyomi container is not accessible")
    return app


def validate_running_process(details: dict) -> dict:
    processes = (details.get("result") or {}).get("runningProcesses") or []
    matches = [
        process
        for process in processes
        if str(process.get("executable") or "").endswith("/Koyomi.app/Koyomi")
        and isinstance(process.get("processIdentifier"), int)
        and process["processIdentifier"] > 0
    ]
    if len(matches) != 1:
        raise ValueError("running Koyomi process was not read back exactly once")
    return matches[0]


def verify_install(apps_json: Path, processes_json: Path) -> None:
    app = validate_installed_app(json.loads(apps_json.read_text(encoding="utf-8")))
    process = validate_running_process(json.loads(processes_json.read_text(encoding="utf-8")))
    print(json.dumps({
        "bundle_id": app["bundleIdentifier"],
        "version": app.get("version"),
        "build": app.get("bundleVersion"),
        "process_id": process["processIdentifier"],
        "verification": "PASS",
    }))


def normalized_datetime(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def decode_profile(path: Path) -> dict:
    result = subprocess.run(
        ["security", "cms", "-D", "-i", str(path)],
        capture_output=True,
        check=True,
    )
    profile = plistlib.loads(result.stdout)
    entitlements = profile.get("Entitlements") or {}
    certificates = {
        hashlib.sha1(bytes(certificate)).hexdigest().upper()
        for certificate in profile.get("DeveloperCertificates", [])
    }
    expires = profile.get("ExpirationDate")
    if not isinstance(expires, datetime):
        raise ValueError("profile expiration is missing")
    return {
        "path": path,
        "name": str(profile.get("Name") or ""),
        "uuid": str(profile.get("UUID") or ""),
        "team": (profile.get("TeamIdentifier") or [None])[0],
        "app_identifier": entitlements.get("application-identifier"),
        "get_task_allow": entitlements.get("get-task-allow") is True,
        "devices": list(profile.get("ProvisionedDevices") or []),
        "expires": normalized_datetime(expires),
        "certificate_hashes": certificates,
        "entitlements": entitlements,
    }


def installed_identity_hashes(keychain: Path) -> set[str]:
    result = subprocess.run(
        ["security", "find-identity", "-v", "-p", "codesigning", str(keychain)],
        capture_output=True,
        text=True,
        check=True,
    )
    return set(re.findall(r"\b([0-9A-F]{40})\b", result.stdout + result.stderr))


def select_profile(
    candidates: list[dict],
    identities: set[str],
    udid: str,
    now: datetime,
) -> tuple[dict, str]:
    valid = []
    for profile in candidates:
        matching = sorted(profile["certificate_hashes"] & identities)
        if (
            profile["team"] == TEAM_ID
            and profile["app_identifier"] == f"{TEAM_ID}.*"
            and profile["get_task_allow"]
            and udid in profile["devices"]
            and normalized_datetime(profile["expires"]) > normalized_datetime(now)
            and not profile["entitlements"].get("com.apple.security.application-groups")
            and f"{TEAM_ID}.*" in profile["entitlements"].get("keychain-access-groups", [])
            and matching
        ):
            valid.append((normalized_datetime(profile["expires"]), profile, matching[0]))
    if not valid:
        raise ValueError("no valid wildcard development profile matches the device and keychain")
    valid.sort(key=lambda item: (item[0], item[1]["uuid"]), reverse=True)
    _, profile, identity = valid[0]
    return profile, identity


def append_outputs(path: Path, values: dict[str, str]) -> None:
    for key, value in values.items():
        if "\n" in value or "\r" in value:
            raise ValueError(f"multiline GitHub output is not allowed: {key}")
    with path.open("a", encoding="utf-8") as handle:
        for key, value in values.items():
            handle.write(f"{key}={value}\n")


def inspect_device(details_json: Path, github_output: Path) -> None:
    details = json.loads(details_json.read_text(encoding="utf-8"))
    device = validate_device_details(details)
    append_outputs(
        github_output,
        {
            "udid": device["udid"],
            "core_device_identifier": device["identifier"],
            "device_name": device["name"],
            "os_version": device["os_version"],
        },
    )
    print(json.dumps({"device": device["name"], "os_version": device["os_version"], "preflight": "PASS"}))


def prepare_signing(
    profile_directories: list[Path],
    keychain: Path,
    udid: str,
    output_dir: Path,
    github_output: Path,
) -> None:
    identities = installed_identity_hashes(keychain)
    paths = sorted({path for directory in profile_directories for path in directory.glob("*.mobileprovision")})
    candidates = []
    for path in paths:
        try:
            candidates.append(decode_profile(path))
        except (subprocess.CalledProcessError, ValueError, plistlib.InvalidFileException):
            continue
    profile, identity = select_profile(candidates, identities, udid, datetime.now(timezone.utc))
    output_dir.mkdir(parents=True, exist_ok=False, mode=0o700)
    app_entitlements = output_dir / "app-entitlements.plist"
    widget_entitlements = output_dir / "widget-entitlements.plist"
    with app_entitlements.open("wb") as handle:
        plistlib.dump(concrete_entitlements(profile["entitlements"], APP_BUNDLE_ID), handle, sort_keys=True)
    with widget_entitlements.open("wb") as handle:
        plistlib.dump(concrete_entitlements(profile["entitlements"], WIDGET_BUNDLE_ID), handle, sort_keys=True)
    app_entitlements.chmod(0o600)
    widget_entitlements.chmod(0o600)
    append_outputs(
        github_output,
        {
            "profile_path": str(profile["path"]),
            "identity": identity,
            "app_entitlements": str(app_entitlements),
            "widget_entitlements": str(widget_entitlements),
            "signing_dir": str(output_dir),
        },
    )
    print(json.dumps({"profile_name": profile["name"], "profile_uuid": profile["uuid"], "signing": "PASS"}))


def verify_repository_contract(root: Path) -> list[str]:
    workflow = root / ".github" / "workflows" / "koyomi-direct-install.yml"
    helper = root / "scripts" / "koyomi_direct_install.py"
    errors = []
    if not workflow.is_file():
        return ["Koyomi direct-install workflow is missing"]
    if not helper.is_file():
        errors.append("Koyomi direct-install helper is missing")
    text = workflow.read_text(encoding="utf-8")
    required = [
        "name: Koyomi Direct Install",
        "workflow_dispatch:",
        "permissions:\n  contents: read",
        "runs-on: [self-hosted, macOS, ARM64, afterimage-ci]",
        f"ref: {SOURCE_SHA}",
        "persist-credentials: false",
        "AFTERIMAGE_CI_KEYCHAIN_PASSWORD",
        "SOURCE_KEYCHAIN_PATH: /Users/kan/actions-runner-afterimage/.ci/afterimage-ci.keychain-db",
        "ORIGINAL_DEFAULT_KEYCHAIN",
        "ORIGINAL_KEYCHAIN_LIST_PATH",
        "cp -p \"$SOURCE_KEYCHAIN_PATH\" \"$CI_KEYCHAIN_PATH\"",
        "security unlock-keychain -p \"$CI_KEYCHAIN_PASSWORD_VALUE\" \"$CI_KEYCHAIN_PATH\"",
        "koyomi_direct_install.py inspect-device",
        "koyomi_direct_install.py prepare-signing",
        SHARED_KEYCHAIN_ACCESS_GROUP,
        "Print :keychain-access-groups:0",
        "Direct-install widget Keychain sharing: PASS",
        "Verify Widget displays a migrated pin on iPhone",
        "koyomi_physical_widget_ui_test.swift",
        "testPhysicalWidgetShowsMigratedPin",
        "Physical Widget content readback: PASS",
        "git -C koyomi-source diff --exit-code",
        "CODE_SIGNING_ALLOWED=NO",
        "codesign --force",
        "$APP_PATH/__preview.dylib",
        "$APP_PATH/Koyomi.debug.dylib",
        "$WIDGET_PATH/__preview.dylib",
        "$WIDGET_PATH/KoyomiWidget.debug.dylib",
        "codesign --verify --strict \"$NESTED_CODE\"",
        "xcrun devicectl device install app",
        "xcrun devicectl device info apps",
        "--bundle-id run.kan.koyomi",
        "xcrun devicectl device process launch",
        "xcrun devicectl device info processes",
        "koyomi_direct_install.py verify-install",
        "TARGET_UDID: ${{ steps.device.outputs.udid }}",
        "PROFILE_PATH: ${{ steps.provisioning.outputs.profile_path }}",
        "SIGNING_IDENTITY: ${{ steps.provisioning.outputs.identity }}",
        "TARGET_DEVICE_IDENTIFIER: ${{ steps.device.outputs.core_device_identifier }}",
        "TARGET_DEVICE_NAME: ${{ steps.device.outputs.device_name }}",
        "TARGET_OS_VERSION: ${{ steps.device.outputs.os_version }}",
        "if: always()",
    ]
    for token in required:
        if token not in text:
            errors.append(f"workflow is missing required token: {token}")
    forbidden = [
        "pull_request:",
        "push:",
        "ASC_PRIVATE_KEY",
        "ASC_ISSUER_ID",
        "rm -rf",
        "unlock-keychain -p \"$CI_KEYCHAIN_PASSWORD_VALUE\" \"$HOME/Library/Keychains/login.keychain-db\"",
        "--udid \"${{ steps.device.outputs.udid }}\"",
        "--device \"${{ steps.device.outputs.core_device_identifier }}\"",
        "cp -p \"${{ steps.provisioning.outputs.profile_path }}\"",
        "--sign \"${{ steps.provisioning.outputs.identity }}\"",
        "echo \"- Device: \\`${{ steps.device.outputs.device_name }}\\`\"",
        "patch-source",
        "Temporary limitation: Widget App Group sharing disabled",
    ]
    for token in forbidden:
        if token in text:
            errors.append(f"workflow contains forbidden token: {token}")
    return errors


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    device_parser = subparsers.add_parser("inspect-device")
    device_parser.add_argument("--details-json", required=True, type=Path)
    device_parser.add_argument("--github-output", required=True, type=Path)

    signing_parser = subparsers.add_parser("prepare-signing")
    signing_parser.add_argument("--profiles-dir", action="append", required=True, type=Path)
    signing_parser.add_argument("--keychain", required=True, type=Path)
    signing_parser.add_argument("--udid", required=True)
    signing_parser.add_argument("--output-dir", required=True, type=Path)
    signing_parser.add_argument("--github-output", required=True, type=Path)

    install_parser = subparsers.add_parser("verify-install")
    install_parser.add_argument("--apps-json", required=True, type=Path)
    install_parser.add_argument("--processes-json", required=True, type=Path)

    verify_parser = subparsers.add_parser("verify-repository")
    verify_parser.add_argument("--root", default=Path.cwd(), type=Path)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    if args.command == "inspect-device":
        inspect_device(args.details_json, args.github_output)
    elif args.command == "prepare-signing":
        prepare_signing(args.profiles_dir, args.keychain, args.udid, args.output_dir, args.github_output)
    elif args.command == "verify-install":
        verify_install(args.apps_json, args.processes_json)
    elif args.command == "verify-repository":
        errors = verify_repository_contract(args.root)
        if errors:
            raise SystemExit("\n".join(errors))
        print("Koyomi direct-install contract: PASS")


if __name__ == "__main__":
    main()
