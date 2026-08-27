from pathlib import Path

from blue.cli import load_yaml

ROOT = Path(__file__).resolve().parents[2]


def fixture(overrides: dict | None = None) -> dict:
    text = (ROOT / "test" / "fixtures" / "colors.yml").read_text()
    return {**load_yaml(text), **(overrides or {})}
