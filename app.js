// ============================================================
// CONFIG
// ============================================================
const CFG = {
  center: [18.0686, 59.3293],
  zoom: 14,
  pitch: 50,
  maxBounds: [[17.70, 59.20], [18.25, 59.45]],
  mapStyle: 'https://tiles.openfreemap.org/styles/bright',
  weatherUrl: 'https://api.open-meteo.com/v1/forecast?latitude=59.3293&longitude=18.0686&hourly=cloudcover,temperature_2m&current_weather=true&timezone=Europe%2FStockholm&forecast_days=1',
  shadowStepM: 4,
  shadowMaxM: 200,
  overcastThreshold: 75,
  stockholmFallback: [18.0686, 59.3293],
  weatherRefreshMs: 30 * 60 * 1000,
};

// WMO weather code descriptions
const WMO = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Foggy', 48: 'Icy fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  71: 'Light snow', 73: 'Snowing', 75: 'Heavy snow',
  80: 'Rain showers', 81: 'Showers', 82: 'Heavy showers',
  95: 'Thunderstorm',
};

// Threshold arrays replace if/else ladders
const CLOUD_THRESHOLDS = [
  { max: 20,       icon: '☀️',  label: 'Clear' },
  { max: 45,       icon: '🌤️', label: 'M.Clear' },
  { max: 70,       icon: '⛅',  label: 'P.Cloudy' },
  { max: 90,       icon: '🌥️', label: 'Cloudy' },
  { max: Infinity, icon: '☁️',  label: 'Overcast' },
];

const WMO_ICON_THRESHOLDS = [
  { min: 95, icon: '⛈️' },
  { min: 71, icon: '❄️' },
  { min: 61, icon: '🌧️' },
  { min: 51, icon: '🌦️' },
  { min: 45, icon: '🌫️' },
];

// Price color gradient stops — no white: green → orange → red
const PRICE_COLOR_STOPS = [
  [34,  197, 94],   // #22C55E cheap
  [251, 146, 60],   // #FB923C mid
  [220, 38,  38],   // #DC2626 expensive
];

// ============================================================
// STATE
// ============================================================
let map;
let barsData = [];
let userPos = null;
let simHour = new Date().getHours();
let isOvercast = false;
let shadowDebounceTimer = null;
let activePopup = null;
let shadowCache = {};
let currentSun = null;
let priceRange = { min: 55, max: 130 };

let buildingFeatures = [];
let buildingSourceName = null;

// ============================================================
// BOOTSTRAP
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  initUI();
  fetchWeather();
  setInterval(fetchWeather, CFG.weatherRefreshMs);
  requestGeolocation();
  registerServiceWorker();
});

function registerServiceWorker() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ============================================================
// ANALYTICS
// ============================================================
function track(event, props) {
  if (typeof umami !== 'undefined') {
    try { umami.track(event, props); } catch (_) {}
  }
}

// ============================================================
// MAP SETUP
// ============================================================
function initMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: CFG.mapStyle,
    center: CFG.center,
    zoom: CFG.zoom,
    pitch: CFG.pitch,
    bearing: -10,
    maxBounds: CFG.maxBounds,
    attributionControl: false,
  });

  map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'bottom-right');
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
  map.addControl(new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: false,
  }), 'bottom-right');

  map.on('load', onMapLoad);
  map.on('error', e => console.error('Map error:', e.error));

  // Throttle idle to avoid expensive building refresh on every tile event
  let idleThrottle = null;
  map.on('idle', () => {
    clearTimeout(idleThrottle);
    idleThrottle = setTimeout(() => {
      refreshBuildings();
      if (barsData.length) scheduleShadowUpdate();
    }, 500);
  });

  map.on('move', updateSunCompassRotation);
  map.on('moveend', scheduleShadowUpdate);
  map.on('click', 'bar-layer', onBarClick);
  map.on('mouseenter', 'bar-layer', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'bar-layer', () => { map.getCanvas().style.cursor = ''; });
}

function onMapLoad() {
  add3DBuildings();
  loadBars();
  if (window.innerWidth >= 640) map.setPadding({ left: 400, top: 20, right: 20, bottom: 20 });
}

// ============================================================
// 3D BUILDINGS
// ============================================================
function detectBuildingSource() {
  if (buildingSourceName) return buildingSourceName;
  const layers = map.getStyle().layers;
  for (const layer of layers) {
    if (layer['source-layer'] === 'building') {
      buildingSourceName = layer.source;
      return buildingSourceName;
    }
  }
  for (const name of ['openmaptiles', 'maptiler', 'protomaps', 'composite']) {
    if (map.getSource(name)) { buildingSourceName = name; return name; }
  }
  return null;
}

function add3DBuildings() {
  const src = detectBuildingSource();
  if (!src) return;
  const beforeId = map.getStyle().layers.find(l => l.type === 'symbol')?.id;
  map.addLayer({
    id: '3d-buildings',
    source: src,
    'source-layer': 'building',
    type: 'fill-extrusion',
    minzoom: 12,
    paint: {
      'fill-extrusion-color': [
        'interpolate', ['linear'],
        ['coalesce', ['get', 'render_height'], ['get', 'height'], 0],
        0,  '#E8E4DF',
        10, '#D6D1CB',
        30, '#BEB8B2',
        80, '#9E9890',
      ],
      'fill-extrusion-height':  ['coalesce', ['get', 'render_height'], ['get', 'height'], 0],
      'fill-extrusion-base':    ['coalesce', ['get', 'min_height'], 0],
      'fill-extrusion-opacity': 0.88,
    },
  }, beforeId);
}

// ============================================================
// BUILDING INDEX
// ============================================================
function refreshBuildings() {
  const src = detectBuildingSource();
  if (!src) return;
  try {
    const raw = map.querySourceFeatures(src, { sourceLayer: 'building' });
    const seen = new Set();
    const next = [];

    for (const f of raw) {
      const key = f.id != null ? String(f.id) : null;
      if (key) {
        if (seen.has(key)) continue;
        seen.add(key);
      }

      const h = +(f.properties?.render_height ?? f.properties?.height ?? f.properties?.extrude_height ?? 0);
      if (h <= 0) continue;

      const geo = f.geometry;
      let rings = [];
      if (geo.type === 'Polygon') rings = [geo.coordinates[0]];
      else if (geo.type === 'MultiPolygon') rings = geo.coordinates.map(p => p[0]);
      else continue;

      let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
      for (const ring of rings) {
        for (const [lng, lat] of ring) {
          if (lng < minLng) minLng = lng;
          if (lng > maxLng) maxLng = lng;
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
        }
      }
      next.push({ rings, h, minLng, maxLng, minLat, maxLat });
    }

    buildingFeatures = next;
    shadowCache = {};
  } catch (_) {}
}

// Point-in-polygon: use turf when available, else custom ray-casting
function pip(px, py, ring) {
  if (typeof turf !== 'undefined') {
    try {
      return turf.booleanPointInPolygon(turf.point([px, py]), turf.polygon([ring]));
    } catch (_) {}
  }
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// ============================================================
// DATA — async/await with Promise-wrapped PapaParse
// ============================================================
async function loadBars() {
  try {
    const data = await new Promise((resolve, reject) => {
      Papa.parse('bars.csv', {
        download: true,
        header: true,
        dynamicTyping: true,
        skipEmptyLines: true,
        complete: ({ data }) => resolve(data),
        error: reject,
      });
    });
    barsData = data.filter(b => b.Latitude && b.Longitude);
    barsData.forEach(b => { b._inShadow = null; });
    computePriceRange();
    updatePriceLegend();
    addMarkersLayer();
    renderBarsList();
  } catch (err) {
    console.error('CSV load error:', err);
    const countEl = document.getElementById('bars-count');
    if (countEl) countEl.textContent = 'Failed to load bar data';
    showLoadingOverlay(false);
  }
}

function computePriceRange() {
  const prices = barsData.map(b => Number(b.BeerPrice)).filter(p => p > 0 && !isNaN(p));
  if (prices.length) {
    priceRange.min = Math.min(...prices);
    priceRange.max = Math.max(...prices);
  }
}

// ============================================================
// PRICE COLOR SCALE
// ============================================================
function lerpColor(t) {
  const seg = t < 0.5 ? 0 : 1;
  const tt  = t < 0.5 ? t * 2 : (t - 0.5) * 2;
  const [r1, g1, b1] = PRICE_COLOR_STOPS[seg];
  const [r2, g2, b2] = PRICE_COLOR_STOPS[seg + 1];
  return `rgb(${Math.round(r1+(r2-r1)*tt)},${Math.round(g1+(g2-g1)*tt)},${Math.round(b1+(b2-b1)*tt)})`;
}

function priceToColor(beerPrice) {
  const p = Number(beerPrice);
  if (!p || isNaN(p)) return '#F59E0B';
  const t = Math.max(0, Math.min(1, (p - priceRange.min) / (priceRange.max - priceRange.min || 1)));
  return lerpColor(t);
}

function shadowColor(inShadow, beerPrice) {
  if (inShadow === null) return '#FCD34D';
  if (inShadow) return '#94A3B8';
  return priceToColor(beerPrice);
}

function updatePriceLegend() {
  const el = document.getElementById('price-legend');
  if (!el) return;
  const minEl = document.getElementById('legend-min');
  const maxEl = document.getElementById('legend-max');
  if (minEl) minEl.textContent = `${Math.round(priceRange.min)} kr`;
  if (maxEl) maxEl.textContent = `${Math.round(priceRange.max)} kr`;
  el.style.display = 'flex';
}

// ============================================================
// MARKERS — feature-state for color updates; no GeoJSON rebuild on each tick
// ============================================================
function addMarkersLayer() {
  // generateId assigns sequential integer IDs (0, 1, 2…) matching barsData index
  map.addSource('bars', { type: 'geojson', data: buildGeoJSON(), generateId: true });

  // Paint reads feature-state first, falls back to the initial GeoJSON property
  const colorExpr = ['coalesce', ['feature-state', 'markerColor'], ['get', 'markerColor']];

  map.addLayer({
    id: 'bar-halo',
    type: 'circle',
    source: 'bars',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 10, 16, 16],
      'circle-color': colorExpr,
      'circle-opacity': 0.15,
      'circle-blur': 0.8,
    },
  });

  map.addLayer({
    id: 'bar-layer',
    type: 'circle',
    source: 'bars',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 4, 14, 7, 17, 10],
      'circle-color': colorExpr,
      'circle-stroke-width': 2,
      'circle-stroke-color': 'rgba(255,255,255,0.9)',
    },
  });
}

function buildGeoJSON() {
  return {
    type: 'FeatureCollection',
    features: barsData.map(bar => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [bar.Longitude, bar.Latitude] },
      properties: {
        name: bar.Name,
        address: bar.Address,
        beerPrice: bar.BeerPrice,
        hasHappyHour: bar.HasHappyHour === 'Yes',
        happyHourTimes: bar.HappyHourTimes || '',
        openingHours: bar.OpeningHours || '',
        specialNotes: bar.SpecialNotes || '',
        // Initial color baked in; subsequent updates go through setFeatureState
        markerColor: shadowColor(bar._inShadow, bar.BeerPrice),
      },
    })),
  };
}

// Mutates feature state directly — no GeoJSON FeatureCollection rebuild
function updateMarkerColors() {
  if (!map.getSource('bars')) return;
  barsData.forEach((bar, idx) => {
    map.setFeatureState(
      { source: 'bars', id: idx },
      { markerColor: shadowColor(bar._inShadow, bar.BeerPrice) }
    );
  });
}

// ============================================================
// SHADOW CALCULATION
// ============================================================
function scheduleShadowUpdate() {
  clearTimeout(shadowDebounceTimer);
  shadowDebounceTimer = setTimeout(runShadowUpdate, 350);
}

function runShadowUpdate() {
  if (!barsData.length) return;

  const date = new Date();
  date.setHours(simHour, 0, 0, 0);
  const sun = SunCalc.getPosition(date, CFG.center[1], CFG.center[0]);

  updateMapLight(sun);
  updateSunCompass(sun);

  if (isOvercast || sun.altitude <= 0) {
    barsData.forEach(b => { b._inShadow = true; });
    updateMarkerColors();
    renderBarsList();
    return;
  }

  if (shadowCache[simHour]) {
    barsData.forEach((b, idx) => { b._inShadow = shadowCache[simHour][idx]; });
    updateMarkerColors();
    renderBarsList();
    return;
  }

  if (!buildingFeatures.length) {
    refreshBuildings();
    if (!buildingFeatures.length) return;
  }

  showLoadingOverlay(true);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    try {
      calcShadows(sun);
      shadowCache[simHour] = barsData.map(b => b._inShadow);
    } catch (err) {
      console.error('Shadow calc error:', err);
    } finally {
      updateMarkerColors();
      renderBarsList();
      showLoadingOverlay(false);
    }
  }));
}

function calcShadows(sun) {
  const dx = -Math.sin(sun.azimuth);
  const dy = -Math.cos(sun.azimuth);
  const steps = Math.floor(CFG.shadowMaxM / CFG.shadowStepM);
  const mPerLat = 111000;
  const mPerLon = 111000 * Math.cos(CFG.center[1] * Math.PI / 180);

  barsData.forEach(bar => {
    const lat = bar.Latitude;
    const lon = bar.Longitude;
    const endLat = lat + (dy * CFG.shadowMaxM) / mPerLat;
    const endLon = lon + (dx * CFG.shadowMaxM) / mPerLon;
    const rayMinLng = Math.min(lon, endLon) - 0.0001;
    const rayMaxLng = Math.max(lon, endLon) + 0.0001;
    const rayMinLat = Math.min(lat, endLat) - 0.0001;
    const rayMaxLat = Math.max(lat, endLat) + 0.0001;

    const filteredBldgs = buildingFeatures.filter(b =>
      b.maxLng >= rayMinLng && b.minLng <= rayMaxLng &&
      b.maxLat >= rayMinLat && b.minLat <= rayMaxLat
    );

    bar._inShadow = castRay(lat, lon, dx, dy, steps, mPerLat, mPerLon, sun.altitude, filteredBldgs);
  });
}

function castRay(lat, lon, dx, dy, steps, mPerLat, mPerLon, sunAlt, filteredBldgs) {
  if (!filteredBldgs.length) return false;
  const tanAlt = Math.tan(sunAlt);
  for (let i = 1; i <= steps; i++) {
    const d = i * CFG.shadowStepM;
    const sLat = lat + (dy * d) / mPerLat;
    const sLon = lon + (dx * d) / mPerLon;
    for (const bldg of filteredBldgs) {
      if (bldg.h > d * tanAlt) {
        if (sLon >= bldg.minLng && sLon <= bldg.maxLng &&
            sLat >= bldg.minLat && sLat <= bldg.maxLat) {
          for (const ring of bldg.rings) {
            if (pip(sLon, sLat, ring)) return true;
          }
        }
      }
    }
  }
  return false;
}

function updateMapLight(sun) {
  const altDeg = sun.altitude * 180 / Math.PI;
  const bearing = ((sun.azimuth + Math.PI) * 180 / Math.PI) % 360;
  try {
    map.setLight({
      anchor: 'map',
      color: altDeg > 20 ? '#fff4e0' : altDeg > 5 ? '#f5d9a0' : '#c8a87a',
      intensity: altDeg > 0 ? Math.min(0.95, 0.45 + 0.5 * (altDeg / 65)) : 0.08,
      position: [1.5, bearing, Math.max(5, 88 - altDeg)],
    });
  } catch (_) {}
}

function updateSunCompass(sun) {
  if (!sun) return;
  currentSun = sun;
  const el = document.getElementById('sun-compass');
  if (!el) return;
  const altDeg = sun.altitude * 180 / Math.PI;
  if (altDeg <= 0 || isOvercast) { el.style.display = 'none'; return; }
  el.style.display = 'flex';
  const sunBearing = ((sun.azimuth + Math.PI) * 180 / Math.PI) % 360;
  const screenAngle = (sunBearing - (map ? map.getBearing() : 0) + 360) % 360;
  el.style.setProperty('--sun-angle', `${screenAngle}deg`);
  const altText = document.getElementById('sun-alt-text');
  const dirText = document.getElementById('sun-dir-text');
  if (altText) altText.textContent = `${Math.round(altDeg)}°`;
  if (dirText) dirText.textContent = getCardinalDirection(sunBearing);
}

function updateSunCompassRotation() {
  if (currentSun) updateSunCompass(currentSun);
}

function getCardinalDirection(bearing) {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(((bearing % 360) / 45)) % 8];
}

// ============================================================
// UI: TIME SLIDER
// ============================================================
function initUI() {
  const slider = document.getElementById('time-slider');
  simHour = Math.min(22, Math.max(6, new Date().getHours()));
  slider.value = simHour;
  updateTimeDisplay();

  slider.addEventListener('input', () => {
    simHour = +slider.value;
    updateTimeDisplay();
    scheduleShadowUpdate();
    track('time-change', { hour: simHour });
  });

  document.getElementById('btn-now').addEventListener('click', () => {
    simHour = Math.min(22, Math.max(6, new Date().getHours()));
    slider.value = simHour;
    updateTimeDisplay();
    scheduleShadowUpdate();
    track('time-reset-now', { hour: simHour });
  });

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
      track('tab-switch', { tab: btn.dataset.tab });
    });
  });

  const handle = document.getElementById('panel-handle');
  const panel  = document.getElementById('panel');
  if (handle) {
    handle.addEventListener('click', () => panel.classList.toggle('expanded'));
    initDragHandle(panel, handle);
  }

  initSearch();
}

function updateTimeDisplay() {
  const label = `${String(simHour).padStart(2, '0')}:00`;
  document.getElementById('time-display').textContent = label;
  document.getElementById('sun-time-big').textContent = label;

  const pct = ((simHour - 6) / 16) * 100;
  document.getElementById('time-slider').style.setProperty('--pct', `${pct}%`);

  const date = new Date();
  date.setHours(simHour, 0, 0, 0);
  const times = SunCalc.getTimes(date, CFG.center[1], CFG.center[0]);
  const sub = (times.sunrise && times.sunset)
    ? `Sunrise ${fmtTime(times.sunrise)} · Sunset ${fmtTime(times.sunset)}`
    : 'Sun simulation time';
  document.getElementById('sun-label-text').textContent = sub;
}

function fmtTime(d) {
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

// ============================================================
// UI: MOBILE DRAG HANDLE
// ============================================================
function initDragHandle(panel, handle) {
  let startY = 0, startH = 0, dragging = false;

  const onStart = e => {
    dragging = true;
    startY = e.touches ? e.touches[0].clientY : e.clientY;
    startH = panel.offsetHeight;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('mouseup', onEnd);
    document.addEventListener('touchend', onEnd);
  };

  const onMove = e => {
    if (!dragging) return;
    if (e.cancelable) e.preventDefault();
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    const newH = Math.max(100, Math.min(window.innerHeight * 0.92, startH + (startY - y)));
    panel.style.height = `${newH}px`;
    panel.classList.toggle('expanded', newH > 160);
  };

  const onEnd = () => {
    dragging = false;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('mouseup', onEnd);
    document.removeEventListener('touchend', onEnd);
  };

  handle.addEventListener('mousedown', onStart);
  handle.addEventListener('touchstart', onStart, { passive: true });
}

// ============================================================
// UI: BARS LIST — data transform then pure DOM render
// ============================================================
function renderBarsList() {
  const container = document.getElementById('bars-list');
  const countEl   = document.getElementById('bars-count');
  const ref = userPos || CFG.stockholmFallback;

  // Data transformation
  const withDist = barsData.map(bar => ({
    ...bar,
    _dist: typeof turf !== 'undefined'
      ? turf.distance(turf.point(ref), turf.point([bar.Longitude, bar.Latitude]), { units: 'meters' })
      : haversine(ref[1], ref[0], bar.Latitude, bar.Longitude),
  })).sort((a, b) => a._dist - b._dist);

  const ordered = [
    ...withDist.filter(b => b._inShadow === false),
    ...withDist.filter(b => b._inShadow === null),
    ...withDist.filter(b => b._inShadow === true),
  ];

  const sunCnt = barsData.filter(b => b._inShadow === false).length;
  countEl.textContent = sunCnt
    ? `${sunCnt} in sun · ${barsData.length} total`
    : `${barsData.length} bars`;

  // Pure DOM rendering step using DocumentFragment — no innerHTML injection
  const frag = document.createDocumentFragment();

  ordered.forEach(bar => {
    const dotCls = bar._inShadow === null ? 'unknown' : bar._inShadow ? 'shadow' : 'sunny';
    const open = isOpenNow(bar.OpeningHours);
    const dist = bar._dist < 1000
      ? `${Math.round(bar._dist)}m`
      : `${(bar._dist / 1000).toFixed(1)}km`;

    const card = document.createElement('div');
    card.className = 'bar-card';
    card.dataset.lng = bar.Longitude;
    card.dataset.lat = bar.Latitude;

    const dot = document.createElement('div');
    dot.className = `bar-card-dot ${dotCls}`;
    if (bar._inShadow === false) dot.style.background = priceToColor(bar.BeerPrice);

    const body = document.createElement('div');
    body.className = 'bar-card-body';

    const nameEl = document.createElement('div');
    nameEl.className = 'bar-card-name';
    nameEl.textContent = bar.Name || '';

    const meta = document.createElement('div');
    meta.className = 'bar-card-meta';

    const addChip = (cls, text) => {
      const c = document.createElement('span');
      c.className = `meta-chip ${cls}`;
      c.textContent = text;
      meta.appendChild(c);
    };

    addChip('chip-price', `🍺 ${bar.BeerPrice != null ? bar.BeerPrice : '—'} kr`);
    if (open === true)  addChip('chip-open',   'Open');
    if (open === false) addChip('chip-closed', 'Closed');
    if (userPos)        addChip('chip-dist',   dist);
    if (bar.HasHappyHour === 'Yes') addChip('chip-hh', 'HH');

    body.appendChild(nameEl);
    body.appendChild(meta);

    if (bar.SpecialNotes) {
      const notesEl = document.createElement('div');
      notesEl.className = 'bar-card-notes';
      notesEl.textContent = bar.SpecialNotes;
      body.appendChild(notesEl);
    }

    card.appendChild(dot);
    card.appendChild(body);

    card.addEventListener('click', () => {
      const lng = +card.dataset.lng;
      const lat = +card.dataset.lat;
      map.flyTo({ center: [lng, lat], zoom: 16, pitch: 55, duration: 900 });
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      document.querySelector('[data-tab="search"]').classList.add('active');
      document.getElementById('tab-search').classList.add('active');
      const found = barsData.find(b => b.Longitude === lng && b.Latitude === lat);
      if (found) showPopup(lng, lat, found);
      track('bar-select', { name: bar.Name, inSun: bar._inShadow === false });
    });

    frag.appendChild(card);
  });

  container.replaceChildren(frag);
}

// ============================================================
// POPUP — DOM-based, no innerHTML injection
// ============================================================
function onBarClick(e) {
  const [lng, lat] = e.features[0].geometry.coordinates;
  const bar = barsData.find(b => b.Longitude === lng && b.Latitude === lat)
    || e.features[0].properties;
  showPopup(lng, lat, bar);
  track('bar-select', { name: bar.Name || bar.name, inSun: bar._inShadow === false });
}

function showPopup(lng, lat, bar) {
  if (activePopup) activePopup.remove();

  const name    = bar.Name    || bar.name    || '';
  const address = bar.Address || bar.address || '';
  const price   = bar.BeerPrice ?? bar.beerPrice ?? '—';
  const notes   = bar.SpecialNotes || bar.specialNotes || '';
  const open    = isOpenNow(bar.OpeningHours || bar.openingHours || '');
  const hasHH   = bar.HasHappyHour === 'Yes' || bar.hasHappyHour === true;
  const hhTimes = bar.HappyHourTimes || bar.happyHourTimes || '';
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${name} ${address} Stockholm`)}`;

  const inner = document.createElement('div');
  inner.className = 'popup-inner';

  const makeEl = (tag, cls, text) => {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  };

  inner.appendChild(makeEl('div', 'popup-name', name));
  inner.appendChild(makeEl('div', 'popup-address', address));

  const chips = makeEl('div', 'popup-chips');
  const addChip = (cls, text) => chips.appendChild(makeEl('span', `meta-chip ${cls}`, text));
  addChip('chip-price', `🍺 ${price} kr`);
  if (open === true)  addChip('chip-open',   'Open Now');
  if (open === false) addChip('chip-closed', 'Closed');
  if (hasHH) addChip('chip-hh', `Happy Hour${hhTimes ? ' ' + hhTimes : ''}`);
  inner.appendChild(chips);

  if (notes) inner.appendChild(makeEl('div', 'popup-notes', notes));

  const link = document.createElement('a');
  link.className = 'popup-maps-link';
  link.href = mapsUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="#1a73e8"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5S10.62 6.5 12 6.5s2.5 1.12 2.5 2.5S13.38 11.5 12 11.5z"/></svg>`;
  link.appendChild(document.createTextNode('View on Google Maps'));
  inner.appendChild(link);

  activePopup = new maplibregl.Popup({ closeButton: true, maxWidth: '290px', offset: 12 })
    .setLngLat([lng, lat])
    .setDOMContent(inner)
    .addTo(map);
}

// ============================================================
// SEARCH (Nominatim)
// ============================================================
function initSearch() {
  const input   = document.getElementById('search-input');
  const results = document.getElementById('search-results');
  let timer = null;

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) { results.style.display = 'none'; return; }
    timer = setTimeout(() => nominatimSearch(q, results), 380);
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#search-wrapper')) results.style.display = 'none';
  });
}

async function nominatimSearch(q, el) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q + ', Stockholm')}&format=json&limit=5&viewbox=17.70,59.45,18.25,59.20&bounded=1`;
    const data = await (await fetch(url, {
      headers: { 'Accept-Language': 'en' },
      signal: controller.signal,
    })).json();
    clearTimeout(timeout);

    if (!data.length) {
      const li = document.createElement('li');
      li.style.cssText = 'color:#A8A29E;cursor:default';
      li.textContent = 'No results';
      el.replaceChildren(li);
      el.style.display = 'block';
      return;
    }

    const frag = document.createDocumentFragment();
    data.forEach(r => {
      const lat = parseFloat(r.lat);
      const lon = parseFloat(r.lon);
      if (isNaN(lat) || isNaN(lon)) return;
      const li = document.createElement('li');
      li.dataset.lng = lon;
      li.dataset.lat = lat;
      li.textContent = r.display_name;
      li.addEventListener('click', () => {
        map.flyTo({ center: [lon, lat], zoom: 15, duration: 800 });
        document.getElementById('search-input').value = li.textContent;
        el.style.display = 'none';
        track('search', { query: q });
      });
      frag.appendChild(li);
    });
    el.replaceChildren(frag);
    el.style.display = 'block';
  } catch (_) {
    clearTimeout(timeout);
    el.style.display = 'none';
  }
}

// ============================================================
// WEATHER (Open-Meteo)
// ============================================================
async function fetchWeather() {
  const iconEl = document.getElementById('weather-icon');
  const textEl = document.getElementById('weather-text');
  const badge  = document.getElementById('weather-badge');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const data = await (await fetch(CFG.weatherUrl, { signal: controller.signal })).json();
    clearTimeout(timeout);

    const hourlyTimes  = data.hourly?.time || [];
    const hourlyClouds = data.hourly?.cloudcover || [];
    const hourlyTemps  = data.hourly?.temperature_2m || [];

    const now = new Date();
    const nowKey = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T${pad(now.getHours())}:00`;
    const idx = hourlyTimes.indexOf(nowKey);

    const cloud   = idx >= 0 ? hourlyClouds[idx] : 50;
    const temp    = idx >= 0 ? hourlyTemps[idx]  : data.current_weather?.temperature ?? null;
    const wmoCode = data.current_weather?.weathercode ?? (cloud > 75 ? 3 : cloud > 40 ? 2 : 0);
    const desc    = WMO[wmoCode] ?? `${cloud}% cloud`;

    isOvercast = cloud > CFG.overcastThreshold;
    shadowCache = {};

    iconEl.textContent = weatherIcon(wmoCode, cloud);
    textEl.textContent = temp !== null ? `${Math.round(temp)}°C · ${desc}` : desc;

    // Incremental class update — no attribute teardown
    badge.classList.remove('rain', 'overcast');
    if (wmoCode >= 61 && wmoCode <= 82) badge.classList.add('rain');
    else if (isOvercast) badge.classList.add('overcast');

    const trendHours = [8, 11, 14, 17, 20];
    const trend = trendHours.map(h => {
      const i = hourlyTimes.findIndex(t => t.endsWith(`T${pad(h)}:00`));
      const c = i >= 0 ? hourlyClouds[i] : 50;
      const t = i >= 0 ? hourlyTemps[i]  : null;
      return {
        hour: `${pad(h)}h`,
        ...cloudPeriodInfo(c),
        temp: t !== null ? Math.round(t) : null,
        isNow: h === simHour,
      };
    });
    renderWeatherTrend(trend);
    scheduleShadowUpdate();
  } catch (_) {
    clearTimeout(timeout);
    textEl.textContent = 'Weather unavailable';
  }
}

function weatherIcon(code, cloud) {
  const match = WMO_ICON_THRESHOLDS.find(e => code >= e.min);
  if (match) return match.icon;
  return (CLOUD_THRESHOLDS.find(p => cloud < p.max) ?? CLOUD_THRESHOLDS.at(-1)).icon;
}

function cloudPeriodInfo(cloud) {
  return CLOUD_THRESHOLDS.find(p => cloud < p.max) ?? CLOUD_THRESHOLDS.at(-1);
}

function renderWeatherTrend(periods) {
  const el = document.getElementById('weather-trend-row');
  if (!el) return;

  const frag = document.createDocumentFragment();

  const label = document.createElement('div');
  label.className = 'trend-label';
  label.textContent = "Today's forecast";
  frag.appendChild(label);

  const row = document.createElement('div');
  row.className = 'trend-periods';

  periods.forEach(p => {
    const period = document.createElement('div');
    period.className = `trend-period${p.isNow ? ' now' : ''}`;

    const icon = document.createElement('span');
    icon.className = 'trend-icon';
    icon.textContent = p.icon;

    const time = document.createElement('span');
    time.className = 'trend-time';
    time.textContent = p.hour;

    const desc = document.createElement('span');
    desc.className = 'trend-desc';
    desc.textContent = p.label;
    if (p.temp !== null) {
      desc.appendChild(document.createElement('br'));
      desc.appendChild(document.createTextNode(`${p.temp}°`));
    }

    period.append(icon, time, desc);
    row.appendChild(period);
  });

  frag.appendChild(row);
  el.replaceChildren(frag);
}

function pad(n) { return String(n).padStart(2, '0'); }

// ============================================================
// GEOLOCATION
// ============================================================
function requestGeolocation() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    pos => { userPos = [pos.coords.longitude, pos.coords.latitude]; renderBarsList(); },
    () => { userPos = null; }
  );
}

// ============================================================
// UTILITIES
// ============================================================
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

// isOpenNow uses simHour; day-to-schedule dictionary replaces string-split loop
function isOpenNow(str) {
  if (!str) return null;
  const DAY_NAMES = { 0: 'Sun', 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat' };
  const today = DAY_NAMES[new Date().getDay()];

  const schedule = {};
  str.split('|').forEach(s => {
    const trimmed = s.trim();
    const colon = trimmed.indexOf(':');
    if (colon > 0) schedule[trimmed.slice(0, colon)] = trimmed.slice(colon + 1).trim();
  });

  const range = schedule[today];
  if (!range) return null;
  const parts = range.split(/\s*[–\-]\s*/);
  if (parts.length < 2) return null;

  const toMin = t => { const [h, m] = t.trim().split(':').map(Number); return h * 60 + (m || 0); };
  const nowM = simHour * 60;
  let openM = toMin(parts[0]), closeM = toMin(parts[1]);
  if (closeM < openM) closeM += 1440;
  return nowM >= openM && nowM <= closeM;
}

function showLoadingOverlay(v) {
  document.getElementById('loading-overlay').classList.toggle('visible', v);
}
