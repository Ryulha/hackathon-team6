"""Preserve Mission02A output while executing its unchanged write-bearing test."""
from pathlib import Path
import pytest


@pytest.fixture(autouse=True)
def isolate_legacy_preservation_output(request,monkeypatch,tmp_path):
    if request.node.name == "test_protected_mission01_and_sources_unchanged":
        import mission02a.reproduce as reproduce
        old = reproduce.LOCAL/"evidence/preserved_manifest.json"
        evidence = tmp_path/"legacy_check/evidence"
        evidence.mkdir(parents=True)
        (evidence/"preserved_manifest.json").write_bytes(old.read_bytes())
        monkeypatch.setattr(reproduce,"LOCAL",evidence.parent)
