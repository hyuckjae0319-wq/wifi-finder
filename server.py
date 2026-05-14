"""
WiFi Finder 로컬 개발 서버
Python http.server 기반 — 포트 8080에서 web/ 폴더를 서빙합니다.

사용법:
    python server.py
"""

import http.server
import os
import functools

PORT = 8080
WEB_DIR = os.path.join(os.path.dirname(__file__), "web")

Handler = functools.partial(
    http.server.SimpleHTTPRequestHandler,
    directory=WEB_DIR
)

if __name__ == "__main__":
    print("WiFi Finder Dev Server")
    print(f"   http://localhost:{PORT}")
    print(f"   Serving: {WEB_DIR}")
    print(f"   Ctrl+C 로 종료")
    print()

    with http.server.HTTPServer(("", PORT), Handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n서버 종료")
