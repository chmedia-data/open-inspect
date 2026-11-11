"""Local Docker builds and restart launch semantics, without a Docker daemon."""

import os
import subprocess
from pathlib import Path
from unittest.mock import Mock

from sandbox_images import native
from sandbox_images.bundle import PackedBundle, plan_image

ROOT = Path(__file__).resolve().parents[3]


def test_docker_build_uses_packed_context_and_amd64_without_starting_containers(
    monkeypatch, tmp_path
):
    plan = plan_image(ROOT, "docker")
    assert plan["target"]["base"] == "python:3.12-slim-bookworm"
    monkeypatch.setattr(native, "update_locks", Mock())
    pack = Mock(return_value=PackedBundle(tmp_path, plan))
    monkeypatch.setattr(native, "pack_bundle", pack)
    run = Mock()
    monkeypatch.setattr(native.subprocess, "run", run)
    monkeypatch.setenv("DOCKER_SANDBOX_IMAGE", "custom:local")

    assert native.build_image(ROOT, "docker") == {"reference": "custom:local"}
    assert pack.call_args.args[:2] == (ROOT, "docker")
    run.assert_called_once_with(
        [
            "docker",
            "build",
            "--platform",
            "linux/amd64",
            "--target",
            "docker",
            "--build-arg",
            "BASE_IMAGE=python:3.12-slim-bookworm",
            "-f",
            str(tmp_path / "packages/sandbox-images/Dockerfile"),
            "-t",
            "custom:local",
            str(tmp_path),
        ],
        cwd=ROOT,
        check=True,
    )


def test_launcher_resumes_only_a_completed_boot_and_execs_runtime(tmp_path):
    # Substitute only installation paths; execute the actual launcher's control
    # flow with a stand-in interpreter which reports the environment it receives.
    interpreter = tmp_path / "interpreter"
    interpreter.write_text("#!/bin/sh\nprintf '%s\\n' \"$*\"\n/usr/bin/env\n")
    interpreter.chmod(0o755)
    state = tmp_path / "state"
    state.mkdir()
    source = (ROOT / "packages/sandbox-images/docker/launcher.sh").read_text()
    source = source.replace("/var/lib/openinspect", str(state))
    source = source.replace("/opt/openinspect/python/bin/python", str(interpreter))
    source = source.replace("cd /workspace", f"cd {tmp_path}")

    def launch():
        result = subprocess.run(
            ["bash", "-c", source],
            env=os.environ
            | {
                "RESTORED_FROM_SNAPSHOT": "true",
                "OI_DEFERRED_START": "true",
                "IMAGE_BUILD_MODE": "true",
            },
            check=True,
            capture_output=True,
            text=True,
        )
        lines = result.stdout.splitlines()
        assert lines[0] == "-m sandbox_runtime.entrypoint"
        return dict(line.split("=", 1) for line in lines[1:] if "=" in line)

    fresh = launch()
    assert fresh["RESTORED_FROM_SNAPSHOT"] == "false"
    assert fresh["OI_DEFERRED_START"] == "false"
    assert fresh["IMAGE_BUILD_MODE"] == "false"
    assert not (state / "boot-complete").exists()
    (state / "boot-complete").touch()
    resumed = launch()
    assert resumed["RESTORED_FROM_SNAPSHOT"] == "true"
    assert resumed["OPENINSPECT_STATE_DIR"] == str(state / "runtime")
