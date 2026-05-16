/* ================================================================
   WiFi Finder – Global Expansion (Hybrid Lazy Loading)
   한국 정적 데이터(83k) + OSM Overpass API 글로벌 데이터
   ================================================================ */

(function () {
    'use strict';

    // ── State ──
    let koreaData = [];         // 한국 공공 와이파이 데이터 (정적)
    let osmData = [];           // 해외/글로벌 와이파이 데이터 (동적)
    let map = null;             // Leaflet 맵 인스턴스
    let clusterer = null;       // Leaflet 마커 클러스터 그룹
    let activeFilter = 'all';   // 현재 필터
    let debounceTimer = null;
    let myLocationMarker = null;// 내 위치 표시 마커
    
    let isFetching = false;
    const loadedTiles = new Set(); // 타일 캐시 추적용

    // ── 상수 ──
    const KOREA_BOUNDS = { south: 32.0, north: 39.0, west: 124.0, east: 132.0 };
    const MIN_OSM_ZOOM = 13; // 이 줌 레벨 이상일 때만 OSM API 호출

    // ── DOM 참조 ──
    const $loading = document.getElementById('loading-overlay');
    const $apiLoading = document.getElementById('api-loading');
    const $zoomPrompt = document.getElementById('zoom-prompt');
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

    const facilityIcons = {
        '교통시설': '🚌',
        '관공서': '🏛️',
        '서민·복지시설': '🏠',
        '관광': '🏖️',
        '지역문화시설': '🎭',
        '편의시설': '🏪',
        '교육시설': '🎓',
        '카페': '☕',
        '숙박': '🏨',
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
            
            // 초기 로딩 지연 (UI 부드럽게)
            setTimeout(() => {
                hideLoading();
                debouncedRender();
            }, 500);
        } catch (err) {
            console.error('Init failed:', err);
            $loading.style.display = 'flex';
            $loading.style.opacity = '1';
            $loading.classList.remove('fade-out');
            document.querySelector('.loading-spinner').style.display = 'none';
            document.getElementById('loading-progress').innerHTML = `
                <b style="color:#ef4444">[오류 발생] 지도를 불러올 수 없습니다.</b><br><br>
                ${err.message.replace(/\n/g, '<br>')}
            `;
        }
    }

    // ── 데이터 로드 (한국 정적 데이터) ──
    function loadData() {
        if (typeof WIFI_DATA !== 'undefined' && Array.isArray(WIFI_DATA)) {
            // Add isKorea flag for easy filtering later
            koreaData = WIFI_DATA.map(d => ({ ...d, isKorea: true }));
            console.log(`✅ 한국 WiFi 데이터 로드: ${koreaData.length.toLocaleString()}건`);
        } else {
            console.warn('⚠️ WIFI_DATA가 로드되지 않았습니다.');
        }
    }

    // ── 지도 초기화 (Leaflet) ──
    function initMap() {
        map = L.map('map', {
            center: [20.0, 0.0], // 전세계 뷰 초기화 (적도 부근)
            zoom: 3,
            minZoom: 2,
            zoomControl: false // 오른쪽 아래로 옮기기 위해 기본 컨트롤 비활성
        });

        L.control.zoom({ position: 'bottomright' }).addTo(map);

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        }).addTo(map);
    }

    // ── 클러스터러 초기화 ──
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
                if (count > 1000) c = ' cluster-huge';
                else if (count > 200) c = ' cluster-large';
                else if (count > 50) c = ' cluster-medium';

                return new L.DivIcon({
                    html: `<div><span>${count}</span></div>`,
                    className: 'custom-cluster-icon' + c,
                    iconSize: L.point(40, 40)
                });
            }
        });
        map.addLayer(clusterer);
    }

    // ================================================================
    //  HYBRID RENDER & FETCH LOGIC
    // ================================================================
    
    function isCenterInKorea(center) {
        return center.lat >= KOREA_BOUNDS.south && center.lat <= KOREA_BOUNDS.north &&
               center.lng >= KOREA_BOUNDS.west && center.lng <= KOREA_BOUNDS.east;
    }

    async function handleViewportChange() {
        const zoom = map.getZoom();
        const center = map.getCenter();
        const inKorea = isCenterInKorea(center);
        
        // 1. Zoom Prompt UI 제어
        if (zoom < MIN_OSM_ZOOM && !inKorea) {
            $zoomPrompt.classList.remove('zoom-prompt-hidden');
        } else {
            $zoomPrompt.classList.add('zoom-prompt-hidden');
        }

        // 2. OSM 데이터 페칭 (해외이거나, 줌이 높을 때)
        if (zoom >= MIN_OSM_ZOOM) {
            await fetchTilesInView();
        }

        // 3. 마커 렌더링
        renderMarkers();
    }

    // 현재 화면에 보이는 지도 타일들을 계산하고 안 불러온 타일 데이터를 OSM에서 가져옴
    async function fetchTilesInView() {
        if (isFetching) return;
        
        const bounds = map.getBounds();
        const zoom = MIN_OSM_ZOOM; // 타일 캐싱 기준 줌 레벨 (13)
        
        // 화면에 보이는 타일 좌표 계산
        const getTile = (lat, lng, z) => {
            const n = Math.pow(2, z);
            const x = Math.floor((lng + 180) / 360 * n);
            const y = Math.floor((1 - Math.log(Math.tan(lat * Math.PI/180) + 1/Math.cos(lat * Math.PI/180)) / Math.PI) / 2 * n);
            return {x, y, z};
        };

        const nw = getTile(bounds.getNorthWest().lat, bounds.getNorthWest().lng, zoom);
        const se = getTile(bounds.getSouthEast().lat, bounds.getSouthEast().lng, zoom);
        
        // 요청할 bounding box 구하기 (합쳐서 한 번에 쿼리)
        const fetchBounds = {
            north: -90, south: 90, west: 180, east: -180
        };
        let needsFetch = false;
        
        for (let x = nw.x; x <= se.x; x++) {
            for (let y = nw.y; y <= se.y; y++) {
                const tileKey = `${zoom}-${x}-${y}`;
                if (!loadedTiles.has(tileKey)) {
                    loadedTiles.add(tileKey);
                    needsFetch = true;
                    // 타일 범위를 LatLng로 변환
                    const n = Math.PI - 2 * Math.PI * y / Math.pow(2, zoom);
                    const s = Math.PI - 2 * Math.PI * (y+1) / Math.pow(2, zoom);
                    const tileNorth = 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
                    const tileSouth = 180 / Math.PI * Math.atan(0.5 * (Math.exp(s) - Math.exp(-s)));
                    const tileWest = x / Math.pow(2, zoom) * 360 - 180;
                    const tileEast = (x+1) / Math.pow(2, zoom) * 360 - 180;
                    
                    fetchBounds.north = Math.max(fetchBounds.north, tileNorth);
                    fetchBounds.south = Math.min(fetchBounds.south, tileSouth);
                    fetchBounds.west = Math.min(fetchBounds.west, tileWest);
                    fetchBounds.east = Math.max(fetchBounds.east, tileEast);
                }
            }
        }

        if (!needsFetch) return;

        isFetching = true;
        $apiLoading.classList.remove('api-loading-hidden');

        try {
            // Normalize longitude to -180 ~ 180 to prevent API 400 Bad Request
            let qSouth = Math.max(-90, fetchBounds.south).toFixed(5);
            let qNorth = Math.min(90, fetchBounds.north).toFixed(5);
            let qWest = (((fetchBounds.west + 180) % 360) + 360) % 360 - 180;
            let qEast = (((fetchBounds.east + 180) % 360) + 360) % 360 - 180;
            
            // Overpass doesn't like west > east (dateline crossing)
            if (qWest > qEast) {
                qWest = -180;
                qEast = 180;
            }

            const qBbox = `${qSouth},${qWest.toFixed(5)},${qNorth},${qEast.toFixed(5)}`;
            const query = `[out:json][timeout:25];nwr["internet_access"="wlan"]["internet_access:fee"="no"](${qBbox});out center;`;
            const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
            
            const res = await fetch(url);
            if (!res.ok) throw new Error("API Limit or Bad Request: " + res.status);
            const data = await res.json();
            
            if (data && data.elements) {
                const newData = data.elements.map(el => {
                    const tags = el.tags || {};
                    return {
                        id: el.id,
                        isKorea: false,
                        lt: el.center ? el.center.lat : el.lat,
                        ln: el.center ? el.center.lon : el.lon,
                        n: tags.name || tags.operator || '(이름 없음)',
                        s: tags.ssid || '',
                        a: `${tags['addr:street'] || ''} ${tags['addr:housenumber'] || ''}`.trim(),
                        f: mapOSMTagsToFacility(tags),
                        d: `오픈스트리트맵 정보 (Node ${el.id})`
                    };
                });
                
                // 기존 데이터와 병합 (ID 중복 제거)
                const existingIds = new Set(osmData.map(d => d.id));
                const uniqueNewData = newData.filter(d => !existingIds.has(d.id));
                osmData = [...osmData, ...uniqueNewData];
            }
        } catch (err) {
            console.error("OSM API Fetch Error:", err);
            // 에러 나면 캐시에서 지워서 다음번에 다시 시도하게 함
            // (실제 앱에서는 너무 잦은 시도를 막기 위해 로직이 더 필요할 수 있음)
        } finally {
            isFetching = false;
            $apiLoading.classList.add('api-loading-hidden');
            renderMarkers(); // 새로 받은 데이터 표시
        }
    }

    // OSM 태그를 앱의 시설 분류로 매핑
    function mapOSMTagsToFacility(tags) {
        const am = tags.amenity;
        const to = tags.tourism;
        if (am === 'cafe' || am === 'restaurant' || am === 'fast_food') return '카페';
        if (am === 'townhall' || am === 'public_building' || am === 'library') return '관공서';
        if (am === 'bus_station' || tags.public_transport === 'station') return '교통시설';
        if (to === 'hotel' || to === 'hostel' || to === 'guest_house') return '숙박';
        if (to === 'museum' || to === 'gallery') return '지역문화시설';
        if (am === 'university' || am === 'school') return '교육시설';
        return '기타';
    }

    // ── 마커 렌더링 ──
    function renderMarkers() {
        clusterer.clearLayers();

        const zoom = map.getZoom();
        const bounds = map.getBounds();
        
        let targetData = [];
        
        // 1. 한국 데이터 필터링
        // 한국 데이터는 많기 때문에, 줌이 너무 낮으면(zoom<7) 필터링 없이 클러스터러에 맡김
        // 줌이 7 이상이면 화면 안의 데이터만 필터링해서 성능 최적화
        let kData = koreaData;
        if (zoom >= 7) {
            kData = kData.filter(d => bounds.contains([d.lt, d.ln]));
        } else if (!isCenterInKorea(map.getCenter())) {
            // 전세계 뷰에서 멀리 떨어져있을때 한국 데이터를 전부 렌더링하면 무거움
            kData = []; 
        }

        // 2. OSM 데이터 필터링 (항상 화면 안의 데이터만)
        let oData = osmData.filter(d => bounds.contains([d.lt, d.ln]));

        targetData = [...kData, ...oData];

        // 3. 사용자 필터링 (카테고리)
        if (activeFilter !== 'all') {
            if (activeFilter === 'korea') {
                targetData = targetData.filter(d => d.isKorea);
            } else if (activeFilter === 'global') {
                targetData = targetData.filter(d => !d.isKorea);
            } else {
                targetData = targetData.filter(d => d.f === activeFilter);
            }
        }

        // 마커 아이콘 설정
        const koreaIcon = L.divIcon({
            className: 'custom-pin',
            html: '<div class="pin-inner"></div>',
            iconSize: [24, 24], iconAnchor: [12, 12]
        });
        const globalIcon = L.divIcon({
            className: 'global-pin',
            html: '<div class="pin-inner"></div>',
            iconSize: [24, 24], iconAnchor: [12, 12]
        });

        const markersArray = [];

        targetData.forEach(d => {
            if (!d.lt || !d.ln) return;
            const icon = d.isKorea ? koreaIcon : globalIcon;
            const marker = L.marker([d.lt, d.ln], { icon });

            const popupContent = `
                <div class="custom-overlay">
                    <div class="ov-name">${escapeHtml(d.n)}</div>
                    <div class="ov-ssid">📶 ${escapeHtml(d.s || '(SSID 없음)')}</div>
                    <div class="ov-addr">${escapeHtml(d.a || (d.c ? d.c + ' ' + (d.g||'') : ''))}</div>
                </div>
            `;
            marker.bindPopup(popupContent, {
                offset: [0, -10], closeButton: false, className: 'custom-popup-wrapper'
            });

            marker.on('click', () => showDetailPanel(d));
            markersArray.push(marker);
        });

        clusterer.addLayers(markersArray);
        $visibleCount.textContent = targetData.length.toLocaleString();
    }

    function debouncedRender() {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(handleViewportChange, 300);
    }

    // ── 상세 패널 ──
    function showDetailPanel(data) {
        $panelName.textContent = data.n || '(이름 없음)';
        $panelFacility.textContent = data.f || '기타';
        $panelSsid.textContent = data.s || '(SSID 정보 없음)';
        $panelAddress.textContent = data.a || '(주소 정보 없음)';
        $panelRegion.textContent = data.c ? `${data.c} ${data.g||''}` : (data.isKorea ? '대한민국' : 'Global (OSM)');
        $panelDetail.textContent = data.d || '-';
        $panelIcon.textContent = facilityIcons[data.f] || (data.isKorea ? '📡' : '🌍');
        $detailPanel.classList.remove('panel-hidden');

        document.getElementById('btn-navi').onclick = () => {
            const url = `https://www.google.com/maps/dir/?api=1&destination=${data.lt},${data.ln}`;
            window.open(url, '_blank');
        };

        document.getElementById('btn-share').onclick = () => {
            const text = `📡 ${data.n}\n📶 ${data.s || 'N/A'}\n📍 ${data.a || ''}`;
            if (navigator.share) {
                navigator.share({ title: 'WiFi Finder', text: text });
            } else {
                navigator.clipboard.writeText(text).then(() => alert('클립보드에 복사되었습니다!'));
            }
        };
    }

    function hideDetailPanel() {
        $detailPanel.classList.add('panel-hidden');
    }

    function hideLoading() {
        $loading.classList.add('fade-out');
        setTimeout(() => { $loading.style.display = 'none'; }, 600);
    }

    // ================================================================
    //  SEARCH (검색은 로드된 데이터 안에서만)
    // ================================================================
    function handleSearch(query) {
        if (!query || query.length < 2) {
            $searchResults.classList.add('results-hidden');
            return;
        }

        const q = query.toLowerCase();
        const results = [];
        const limit = 20;
        
        const combinedData = [...koreaData, ...osmData];

        for (let i = 0; i < combinedData.length && results.length < limit; i++) {
            const d = combinedData[i];
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
                    <div class="result-sub">${escapeHtml(d.a || (d.c ? d.c + ' ' + (d.g||'') : ''))}</div>
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
        const total = koreaData.length + osmData.length;
        
        document.getElementById('stats-body').innerHTML = `
            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-number">${koreaData.length.toLocaleString()}</div>
                    <div class="stat-label">한국 공공 WiFi</div>
                </div>
                <div class="stat-card">
                    <div class="stat-number" style="color: var(--accent-green);">${osmData.length.toLocaleString()}</div>
                    <div class="stat-label">글로벌 WiFi (현재 로드됨)</div>
                </div>
            </div>
            <p class="stats-section-title">⚠️ 글로벌 데이터 안내</p>
            <p style="font-size:13px; color:var(--text-secondary); line-height:1.5;">
                해외 데이터는 사용자가 지도를 확대(Zoom)할 때 OpenStreetMap 서버에서 실시간으로 불러옵니다.<br><br>
                따라서 전체 통계에는 현재 화면에 로드된 해외 데이터의 개수만 반영됩니다.
            </p>
        `;
        $statsModal.classList.remove('modal-hidden');
    }

    // ================================================================
    //  EVENT BINDING
    // ================================================================
    function bindEvents() {
        map.on('moveend', debouncedRender);

        document.querySelectorAll('.filter-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
                chip.classList.add('active');
                activeFilter = chip.dataset.filter;
                renderMarkers();
            });
        });

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

        $searchList.addEventListener('click', (e) => {
            const li = e.target.closest('li');
            if (!li) return;
            const lat = parseFloat(li.dataset.lat);
            const lng = parseFloat(li.dataset.lng);
            if (isNaN(lat) || isNaN(lng)) return;

            map.setView([lat, lng], 16);
            $searchResults.classList.add('results-hidden');
            $searchInput.blur();
            debouncedRender();
        });

        document.addEventListener('click', (e) => {
            if (!e.target.closest('#search-wrapper') && !e.target.closest('#search-results')) {
                $searchResults.classList.add('results-hidden');
            }
        });

        document.getElementById('panel-close').addEventListener('click', hideDetailPanel);
        document.getElementById('btn-my-location').addEventListener('click', goToMyLocation);
        
        document.getElementById('btn-stats').addEventListener('click', showStats);
        document.getElementById('stats-close').addEventListener('click', () => $statsModal.classList.add('modal-hidden'));
        document.querySelector('.modal-backdrop').addEventListener('click', () => $statsModal.classList.add('modal-hidden'));

        document.getElementById('logo-btn').addEventListener('click', () => {
            map.setView([20.0, 0.0], 3);
            hideDetailPanel();
        });

        map.on('click', hideDetailPanel);
    }

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

                const locationIcon = L.divIcon({
                    className: 'my-location-dot',
                    html: '',
                    iconSize: [16, 16], iconAnchor: [8, 8]
                });

                if (myLocationMarker) {
                    myLocationMarker.setLatLng([lat, lng]);
                } else {
                    myLocationMarker = L.marker([lat, lng], { icon: locationIcon, zIndexOffset: 1000 }).addTo(map);
                }
            },
            (err) => { alert('위치 정보를 가져올 수 없습니다.\\n에러: ' + err.message); },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
    }

    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    window.addEventListener('DOMContentLoaded', init);
})();
