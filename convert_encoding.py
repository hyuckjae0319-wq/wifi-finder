"""
wifi-list.csv 인코딩 변환 스크립트
EUC-KR(CP949) -> UTF-8 (BOM 포함)

BOM(Byte Order Mark)을 포함하면 Excel에서도 한글이 정상 표시됩니다.
"""

import os

INPUT_FILE = os.path.join(os.path.dirname(__file__), "wifi-list.csv")
OUTPUT_FILE = os.path.join(os.path.dirname(__file__), "wifi-list-utf8.csv")

def convert():
    print("[1/3] Reading:", INPUT_FILE)

    # CP949(EUC-KR 확장)로 읽기
    with open(INPUT_FILE, "r", encoding="cp949", errors="replace") as f_in:
        content = f_in.read()

    print("[2/3] Converting to UTF-8...")

    # UTF-8 BOM으로 저장
    with open(OUTPUT_FILE, "w", encoding="utf-8-sig", newline="") as f_out:
        f_out.write(content)

    # 결과 확인
    in_size = os.path.getsize(INPUT_FILE)
    out_size = os.path.getsize(OUTPUT_FILE)
    line_count = content.count("\n")

    print("[3/3] Done!")
    print(f"  Source : {in_size:,} bytes (CP949)")
    print(f"  Output : {out_size:,} bytes (UTF-8 BOM)")
    print(f"  Lines  : {line_count:,}")
    print(f"  File   : {OUTPUT_FILE}")

if __name__ == "__main__":
    convert()
