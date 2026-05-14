/* ================================================================
   WiFi Finder – Main Application Logic (Leaflet.js Version)
   오픈소스 지도(Leaflet.js) + 마커 클러스터러 + Viewport 최적화
   ================================================================ */

(function () {
    'use strict';

    // ── State ──
    let allData = [];           // 전체 WiFi 데이터
    let map = null;             // Leaflet 맵 인스턴스
    let clusterer = null;       // Leaflet 마커 클러스터 그룹
    let activeFilter = 'all';   // 현재 필터
    let debounceTimer = null;
    let myLocationMarker = null;// 내 위치 표시 마커

    // ── DOM 참조 ──
    const $map = document.getElementById('map');
    const $loading = document.getElementById('loading-overlay');
    const $loadingProgress = document.getElementById('loading-progress');
    const $visibleCount = document.getElementById('visible-count');
    const $searchInput = document.getElementById('search-input');
    const $searchClear = document.getElementById('search-clear');
    const $searchResults = document.getElementById('search-results');
    const $searchList = document.getElementById('search-list');
    const $detailPanel = document.getElementById('detail-panel');
    const $statsModal = document.getElementById('stats-modal');

    // Panel fields
    const $panelName = document.getElementById('panel-name');
    const $panelFacility = document.getElementById('panel-facility');
    const $panelSsid = document.getElementById('panel-ssid');
    const $panelAddress = document.getElementById('panel-address');
    const $panelRegion = document.getElementById('panel-region');
    const $panelDetail = document.getElementById('panel-detail');
    const $panelIcon = document.getElementById('panel-icon');

    // ── Facility → Emoji map ──
    const facilityIcons = {
        '교통시설': '🚌',
        '관공서': '🏛️',
        '서민·복지시설': '🏠',
        '관광': '🏖️',
        '지역문화시설': '🎭',
        '편의시설': '🏪',
        '교육시설': '🎓',
        '기타': '📌'
    };

    // ================================================================
    //  INIT
    // ================================================================
    function init() {
        try {
            if (typeof L === 'undefined') {
                throw new Error('Leaflet.js 라이브러리를 불러올 수 없습니다. 인터넷 연결을 확인해주세요.');
            }

            loadData();
            initMap();
            initClusterer();
            bindEvents();
            renderMarkers();
            hideLoading();
        } catch (err) {
            console.error('Init failed:', err);
            $loading.style.display = 'flex';
            $loading.style.opacity = '1';
            $loading.classList.remove('fade-out');
            document.querySelector('.loading-spinner').style.display = 'none';
            $loadingProgress.style.color = '#ef4444';
            $loadingProgress.innerHTML = `
                <b>[오류 발생] 지도를 불러올 수 없습니다.</b><br><br>
                ${err.message.replace(/\n/g, '<br>')}
            `;
        }
    }

    // ── 데이터 로드 (전역 변수 WIFI_DATA에서 직접 참조 — 서버 불필요) ──
    function loadData() {
        if (typeof WIFI_DATA === 'undefined' || !Array.isArray(WIFI_DATA)) {
            throw new Error('WIFI_DATA가 로드되지 않았습니다. wifi-data.js 파일을 확인하세요.');
        }
        allData = WIFI_DATA;
        $loadingProgress.textContent = `${allData.length.toLocaleString()}개 스팟 로드 완료`;
        console.log(`✅ WiFi 데이터 로드: ${allData.length.toLocaleString()}건`);
    }

    // ── 지도 초기화 (Leaflet) ──
    function initMap() {
        // 한국 중심 좌표 (위도, 경도) 및 경계 설정
        const koreaBounds = [
            [32.0, 124.0], // 남서쪽 (South West)
            [39.0, 132.0]  // 북동쪽 (North East)
        ];

        map = L.map('map', {
            center: [36.5, 127.8],
            zoom: 7, // Leaflet 줌은 숫자가 클수록 확대됨
            minZoom: 6, // 대한민국 전체가 보이는 수준 이하로 축소 방지
            maxBounds: koreaBounds, // 지도 이동 범위를 한국으로 제한
            maxBoundsViscosity: 1.0, // 경계 밖으로 튕겨나가지 않도록 강력하게 고정
            zoomControl: false // 오른쪽 아래로 옮기기 위해 기본 컨트롤 비활성
        });

        // 우측 하단 줌 컨트롤
        L.control.zoom({ position: 'bottomright' }).addTo(map);

        // OpenStreetMap 타일 레이어 추가
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        }).addTo(map);
    }

    // ── 클러스터러 초기화 (Leaflet.markercluster) ──
    function initClusterer() {
        clusterer = L.markerClusterGroup({
            maxClusterRadius: 80,
            disableClusteringAtZoom: 16,
            spiderfyOnMaxZoom: true,
            showCoverageOnHover: false,
            zoomToBoundsOnClick: true,
            iconCreateFunction: function(cluster) {
                const count = cluster.getChildCount();
                let c = ' cluster-small';
                if (count > 1000) {
                    c = ' cluster-huge';
                } else if (count > 200) {
                    c = ' cluster-large';
                } else if (count > 50) {
                    c = ' cluster-medium';
                }

                return new L.DivIcon({
                    html: `<div><span>${count}</span></div>`,
                    className: 'custom-cluster-icon' + c,
                    iconSize: L.point(40, 40) // 사이즈는 CSS에서 덮어씀
                });
            }
        });
        map.addLayer(clusterer);
    }

    // ── 마커 렌더링 ──
    function renderMarkers() {
        // 기존 마커 & 오버레이 정리
        clusterer.clearLayers();

        // 필터링
        const filtered = activeFilter === 'all'
            ? allData
            : allData.filter(d => d.f === activeFilter);

        // 뷰포트 기반 렌더링 (줌 레벨에 따라)
        // Leaflet에서는 줌 레벨이 클수록 확대됨. 12 이상일 때 화면 내 데이터만
        const zoom = map.getZoom();
        let dataToRender;

        if (zoom >= 13) {
            // 확대 상태: 현재 화면 영역 내 데이터만 필터링
            const bounds = map.getBounds();
            dataToRender = filtered.filter(d => bounds.contains([d.lt, d.ln]));
        } else {
            // 축소 상태: 전체 (클러스터러가 처리)
            dataToRender = filtered;
        }

        // Leaflet 마커 생성 배열
        const markersArray = [];

        // 기본 아이콘 설정 (파란색 점)
        const customIcon = L.divIcon({
            className: 'custom-pin',
            html: '<div class="pin-inner"></div>',
            iconSize: [24, 24],
            iconAnchor: [12, 12]
        });

        dataToRender.forEach(d => {
            const marker = L.marker([d.lt, d.ln], { icon: customIcon });

            // 팝업 내용
            const popupContent = `
                <div class="custom-overlay">
                    <div class="ov-name">${escapeHtml(d.n)}</div>
                    <div class="ov-ssid">📶 ${escapeHtml(d.s || '(SSID 없음)')}</div>
                    <div class="ov-addr">${escapeHtml(d.a || d.c + ' ' + d.g)}</div>
                </div>
            `;
            marker.bindPopup(popupContent, {
                offset: [0, -10],
                closeButton: false,
                className: 'custom-popup-wrapper'
            });

            // 클릭 이벤트 (패널 표시)
            marker.on('click', () => {
                showDetailPanel(d);
            });

            markersArray.push(marker);
        });

        // 클러스터러에 일괄 추가 (성능 최적화)
        clusterer.addLayers(markersArray);

        // 표시 수 업데이트
        $visibleCount.textContent = dataToRender.length.toLocaleString();
    }

    // ── 디바운스 렌더 ──
    function debouncedRender() {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(renderMarkers, 300);
    }

    // ── 상세 패널 ──
    function showDetailPanel(data) {
        $panelName.textContent = data.n || '(이름 없음)';
        $panelFacility.textContent = data.f || '기타';
        $panelSsid.textContent = data.s || '(SSID 정보 없음)';
        $panelAddress.textContent = data.a || '(주소 정보 없음)';
        $panelRegion.textContent = `${data.c} ${data.g}`;
        $panelDetail.textContent = data.d || '-';
        $panelIcon.textContent = facilityIcons[data.f] || '📡';
        $detailPanel.classList.remove('panel-hidden');

        // 길찾기 버튼 – 구글맵 길찾기 연결 (카카오 대신)
        document.getElementById('btn-navi').onclick = () => {
            const url = `https://www.google.com/maps/dir/?api=1&destination=${data.lt},${data.ln}`;
            window.open(url, '_blank');
        };

        // 공유 버튼
        document.getElementById('btn-share').onclick = () => {
            const text = `📡 ${data.n}\n📶 ${data.s}\n📍 ${data.a || data.c + ' ' + data.g}`;
            if (navigator.share) {
                navigator.share({ title: 'WiFi Finder', text: text });
            } else {
                navigator.clipboard.writeText(text).then(() => {
                    alert('클립보드에 복사되었습니다!');
                });
            }
        };
    }

    function hideDetailPanel() {
        $detailPanel.classList.add('panel-hidden');
    }

    // ── 로딩 숨김 ──
    function hideLoading() {
        $loading.classList.add('fade-out');
        setTimeout(() => { $loading.style.display = 'none'; }, 600);
    }

    // ================================================================
    //  SEARCH
    // ================================================================
    function handleSearch(query) {
        if (!query || query.length < 2) {
            $searchResults.classList.add('results-hidden');
            return;
        }

        const q = query.toLowerCase();
        const results = [];
        const limit = 20;

        for (let i = 0; i < allData.length && results.length < limit; i++) {
            const d = allData[i];
            if (
                (d.n && d.n.toLowerCase().includes(q)) ||
                (d.a && d.a.toLowerCase().includes(q)) ||
                (d.s && d.s.toLowerCase().includes(q)) ||
                (d.g && d.g.toLowerCase().includes(q))
            ) {
                results.push(d);
            }
        }

        if (results.length === 0) {
            $searchList.innerHTML = '<li><div class="result-name" style="color:var(--text-muted)">검색 결과 없음</div></li>';
        } else {
            $searchList.innerHTML = results.map(d => `
                <li data-lat="${d.lt}" data-lng="${d.ln}">
                    <div class="result-name">${highlightMatch(d.n, q)}</div>
                    <div class="result-sub">${escapeHtml(d.a || d.c + ' ' + d.g)}</div>
                    ${d.s ? `<div class="result-ssid">📶 ${highlightMatch(d.s, q)}</div>` : ''}
                </li>
            `).join('');
        }

        $searchResults.classList.remove('results-hidden');
    }

    function highlightMatch(text, query) {
        if (!text) return '';
        const escaped = escapeHtml(text);
        const regex = new RegExp(`(${escapeRegex(query)})`, 'gi');
        return escaped.replace(regex, '<mark style="background:rgba(59,130,246,0.3);color:#fff;border-radius:2px;padding:0 2px;">$1</mark>');
    }

    // ================================================================
    //  STATS
    // ================================================================
    function showStats() {
        const cityMap = {};
        const facilityMap = {};

        allData.forEach(d => {
            cityMap[d.c] = (cityMap[d.c] || 0) + 1;
            facilityMap[d.f || '기타'] = (facilityMap[d.f || '기타'] || 0) + 1;
        });

        const citySorted = Object.entries(cityMap).sort((a, b) => b[1] - a[1]);
        const facilitySorted = Object.entries(facilityMap).sort((a, b) => b[1] - a[1]);
        const maxCity = citySorted[0][1];
        const maxFacility = facilitySorted[0][1];

        document.getElementById('stats-body').innerHTML = `
            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-number">${allData.length.toLocaleString()}</div>
                    <div class="stat-label">전체 WiFi 스팟</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number">${citySorted.length}</div>
                    <div class="stat-label">시·도 지역</div>
                </div>
            </div>

            <p class="stats-section-title">🏙️ 시·도별 분포</p>
            <div class="stats-bar-list">
                ${citySorted.map(([name, count]) => `
                    <div class="stats-bar-item">
                        <span class="stats-bar-name">${escapeHtml(name)}</span>
                        <div class="stats-bar-track">
                            <div class="stats-bar-fill" style="width:${(count / maxCity * 100).toFixed(1)}%"></div>
                        </div>
                        <span class="stats-bar-count">${count.toLocaleString()}</span>
                    </div>
                `).join('')}
            </div>

            <p class="stats-section-title">🏢 시설 유형별 분포</p>
            <div class="stats-bar-list">
                ${facilitySorted.map(([name, count]) => `
                    <div class="stats-bar-item">
                        <span class="stats-bar-name">${facilityIcons[name] || '📌'} ${escapeHtml(name)}</span>
                        <div class="stats-bar-track">
                            <div class="stats-bar-fill" style="width:${(count / maxFacility * 100).toFixed(1)}%"></div>
                        </div>
                        <span class="stats-bar-count">${count.toLocaleString()}</span>
                    </div>
                `).join('')}
            </div>
        `;

        $statsModal.classList.remove('modal-hidden');
    }

    // ================================================================
    //  EVENT BINDING
    // ================================================================
    function bindEvents() {
        // 지도 이벤트 (뷰포트 변경 시 마커 갱신)
        map.on('moveend', debouncedRender);

        // 필터 칩
        document.querySelectorAll('.filter-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                activeFilter = chip.dataset.filter;
                renderMarkers();
            });
        });

        // 검색
        $searchInput.addEventListener('input', () => {
            const val = $searchInput.value.trim();
            $searchClear.classList.toggle('visible', val.length > 0);
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => handleSearch(val), 200);
        });

        $searchClear.addEventListener('click', () => {
            $searchInput.value = '';
            $searchClear.classList.remove('visible');
            $searchResults.classList.add('results-hidden');
        });

        // 검색 결과 클릭
        $searchList.addEventListener('click', (e) => {
            const li = e.target.closest('li');
            if (!li) return;
            const lat = parseFloat(li.dataset.lat);
            const lng = parseFloat(li.dataset.lng);
            if (isNaN(lat) || isNaN(lng)) return;

            map.setView([lat, lng], 16);
            $searchResults.classList.add('results-hidden');
            $searchInput.blur();

            // 해당 데이터 찾아서 패널 표시
            const d = allData.find(item => item.lt === lat && item.ln === lng);
            if (d) {
                showDetailPanel(d);
                // 팝업 표시를 위해 강제 렌더링 호출
                debouncedRender();
            }
        });

        // 외부 클릭 시 검색결과 닫기
        document.addEventListener('click', (e) => {
            if (!e.target.closest('#search-wrapper') && !e.target.closest('#search-results')) {
                $searchResults.classList.add('results-hidden');
            }
        });

        // 패널 닫기
        document.getElementById('panel-close').addEventListener('click', hideDetailPanel);

        // 내 위치
        document.getElementById('btn-my-location').addEventListener('click', goToMyLocation);

        // 통계
        document.getElementById('btn-stats').addEventListener('click', showStats);
        document.getElementById('stats-close').addEventListener('click', () => {
            $statsModal.classList.add('modal-hidden');
        });
        document.querySelector('.modal-backdrop').addEventListener('click', () => {
            $statsModal.classList.add('modal-hidden');
        });

        // 로고 클릭 → 전국 보기
        document.getElementById('logo-btn').addEventListener('click', () => {
            map.setView([36.5, 127.8], 7);
            hideDetailPanel();
        });

        // 지도 클릭 시 패널 닫기
        map.on('click', hideDetailPanel);
    }

    // ── 내 위치 ──
    function goToMyLocation() {
        if (!navigator.geolocation) {
            alert('이 브라우저에서는 위치 서비스를 지원하지 않습니다.');
            return;
        }
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const lat = pos.coords.latitude;
                const lng = pos.coords.longitude;
                map.setView([lat, lng], 15);

                // 파란색 깜빡이는 내 위치 마커 추가/업데이트
                const locationIcon = L.divIcon({
                    className: 'my-location-dot',
                    html: '',
                    iconSize: [16, 16],
                    iconAnchor: [8, 8]
                });

                if (myLocationMarker) {
                    myLocationMarker.setLatLng([lat, lng]);
                } else {
                    myLocationMarker = L.marker([lat, lng], {
                        icon: locationIcon,
                        zIndexOffset: 1000 // 다른 마커들 위에 표시
                    }).addTo(map);
                }
            },
            (err) => {
                alert('위치 정보를 가져올 수 없습니다.\\n(브라우저의 위치 정보 제공 권한을 허용했는지 확인해주세요)\\n에러: ' + err.message);
            },
            {
                enableHighAccuracy: true,
                timeout: 10000,
                maximumAge: 0
            }
        );
    }

    // ── Utils ──
    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // ── Start ──
    window.addEventListener('DOMContentLoaded', init);
})();
