# ☀️ SunnySips STHLM

> Find Stockholm bars in direct sunlight — right now, or at any time of day.

SunnySips is a Progressive Web App that combines real-time sun position, 3D building shadow raycasting, and live weather data to show you exactly which Stockholm bars are bathed in sunlight at any given hour.

---

## Features

- [x] **Live shadow raycasting** — traces rays from each bar toward the sun, sampling building geometry every 4 m up to 200 m
- [x] **Beer price color scale** — sunny markers are color-coded green → orange → red by price; shadow markers are grey
- [x] **Price legend** — persistent map overlay showing the full price gradient and range
- [x] **Time slider** — simulate sun position from 06:00 to 22:00; "Now" snaps back to real time
- [x] **Live weather** — Open-Meteo API with WMO code descriptions, daily forecast trend, auto-refresh every 30 min
- [x] **Overcast mode** — when cloud cover > 75%, all markers switch to grey
- [x] **Sun compass** — floating overlay showing sun bearing and altitude, rotates with the map
- [x] **Bars Nearby list** — sorted by sun status then distance; shows open/closed status relative to simulated hour
- [x] **Search** — Nominatim geocoding bounded to Stockholm
- [x] **Google Maps links** — one-tap directions from any bar popup
- [x] **Happy Hour chips** — flagged in both list and popup views
- [x] **PWA** — installable, service worker caching, offline-capable for static assets
- [x] **Mobile bottom sheet** — draggable panel with snap states
- [x] **Accessible** — ARIA roles, live regions, labelled controls throughout

---

## Tech Stack

| Layer | Library / Service |
|---|---|
| Map | MapLibre GL JS 4.5.0 + OpenFreeMap tiles |
| 3D buildings | MapLibre `fill-extrusion` + `querySourceFeatures` |
| Sun position | SunCalc 1.9.0 |
| Spatial ops | Turf.js 6.5.0 (distance, point-in-polygon) |
| CSV parsing | PapaParse 5.4.1 |
| Weather | Open-Meteo (free, no key) |
| Geocoding | Nominatim / OpenStreetMap |
| Analytics | Umami (privacy-first, cookie-free) |
| Fonts | Plus Jakarta Sans via Google Fonts |

---

## Running Locally

```bash
cd /path/to/*localFolder
python3 -m http.server 8743
# open http://localhost:8743
```

---

## Disclaimer

> Parts of this application's codebase were refactored and optimized with the assistance of artificial intelligence.

---

*Created by **Param Valiathan***
