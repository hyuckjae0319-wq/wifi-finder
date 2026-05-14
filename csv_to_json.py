"""
wifi-list-utf8.csv → wifi-data.json 변환 스크립트

83,000건 CSV에서 웹앱에 필요한 핵심 필드만 추출하여
경량 JSON 파일로 변환합니다.

출력 파일: web/data/wifi-data.json
"""

import csv
import json
import os

BASE_DIR = os.path.dirname(__file__)
INPUT_FILE = os.path.join(BASE_DIR, "wifi-list-utf8.csv")
OUTPUT_DIR = os.path.join(BASE_DIR, "web", "data")
OUTPUT_FILE = os.path.join(OUTPUT_DIR, "wifi-data.json")

# CSV 컬럼 인덱스 (data_analysis.txt 기준)
COL_NAME = 2        # 설치장소명
COL_DETAIL = 3      # 설치장소상세
COL_CITY = 4        # 설치시도명
COL_DISTRICT = 5    # 설치시군구명
COL_FACILITY = 6    # 설치시설구분명
COL_SSID = 8        # 와이파이SSID
COL_ADDRESS = 10    # 소재지도로명주소
COL_ADDRESS2 = 11   # 소재지지번주소
COL_LAT = 14        # WGS84위도
COL_LON = 15        # WGS84경도


def is_valid_coord(lat_str, lon_str):
    """한국 범위 내 유효한 좌표인지 검증"""
    try:
        lat = float(lat_str)
        lon = float(lon_str)
        # 한국 위도: 대략 33~39, 경도: 대략 124~132
        return 33.0 <= lat <= 39.0 and 124.0 <= lon <= 132.0
    except (ValueError, TypeError):
        return False


def convert():
    print(f"[1/4] Reading: {INPUT_FILE}")

    results = []
    skipped = 0

    with open(INPUT_FILE, "r", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        header = next(reader)  # 헤더 건너뛰기
        print(f"       Columns: {len(header)}")

        for i, row in enumerate(reader):
            if len(row) < 16:
                skipped += 1
                continue

            lat_str = row[COL_LAT].strip()
            lon_str = row[COL_LON].strip()

            if not is_valid_coord(lat_str, lon_str):
                skipped += 1
                continue

            address = row[COL_ADDRESS].strip() or row[COL_ADDRESS2].strip()

            results.append({
                "n": row[COL_NAME].strip(),       # name (장소명)
                "d": row[COL_DETAIL].strip(),      # detail (상세)
                "c": row[COL_CITY].strip(),        # city (시도)
                "g": row[COL_DISTRICT].strip(),    # gu (시군구)
                "f": row[COL_FACILITY].strip(),    # facility (시설구분)
                "s": row[COL_SSID].strip(),        # ssid
                "a": address,                       # address
                "lt": float(lat_str),               # latitude
                "ln": float(lon_str),               # longitude
            })

    print(f"[2/4] Valid records: {len(results):,}")
    print(f"       Skipped: {skipped:,}")

    # 시도별 통계
    city_counts = {}
    for r in results:
        city_counts[r["c"]] = city_counts.get(r["c"], 0) + 1
    print("[3/4] Per city:")
    for city, count in sorted(city_counts.items(), key=lambda x: -x[1]):
        print(f"       {city}: {count:,}")

    # JSON 저장
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, separators=(",", ":"))

    file_size = os.path.getsize(OUTPUT_FILE) / (1024 * 1024)
    print(f"[4/4] Saved: {OUTPUT_FILE}")
    print(f"       Size: {file_size:.1f} MB")
    print(f"       Records: {len(results):,}")


if __name__ == "__main__":
    convert()
