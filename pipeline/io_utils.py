from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

from schema import RAW_DIR, SCHEMA

# Windows 콘솔에서 한글 출력 깨짐 방지
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def raw_dir_from_argv() -> Path:
    """`--raw <dir>` 로 입력 폴더 지정 (기본 data/raw, 테스트 시 pipeline/fixtures)."""
    if "--raw" in sys.argv:
        return Path(sys.argv[sys.argv.index("--raw") + 1]).resolve()
    return RAW_DIR


def available_files(raw_dir: Path) -> list[str]:
    return [f for f in SCHEMA if (raw_dir / f).exists()]


def ensure_data(raw_dir: Path) -> None:
    files = available_files(raw_dir)
    if not files:
        print(f"[!] {raw_dir} 에 CSV가 없습니다. 10/31 공개되는 01~17 CSV를 이 폴더에 넣어 주세요.")
        sys.exit(1)
    missing = [f for f in SCHEMA if f not in files]
    if missing:
        print(f"[!] 누락 파일 {len(missing)}개: {', '.join(missing)}")


def load(raw_dir: Path, file_name: str) -> pd.DataFrame:
    """명세서 kind 에 맞춰 타입 변환. 알 수 없는 컬럼은 그대로 둔다."""
    _, cols, _ = SCHEMA[file_name]
    df = pd.read_csv(raw_dir / file_name, encoding="utf-8-sig", dtype=str, keep_default_na=False)
    df.columns = [c.strip() for c in df.columns]
    for col, kind in cols.items():
        if col not in df.columns:
            continue
        s = df[col].str.strip()
        if kind in ("int", "float", "flag01"):
            df[col] = pd.to_numeric(s.replace("", None), errors="coerce")
        elif kind == "date":
            df[col] = pd.to_datetime(s.replace("", None), format="%Y-%m-%d", errors="coerce")
        else:
            df[col] = s
    return df


def load_all(raw_dir: Path) -> dict[str, pd.DataFrame]:
    return {SCHEMA[f][0]: load(raw_dir, f) for f in available_files(raw_dir)}
