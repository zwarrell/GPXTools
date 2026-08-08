// ---------- spatial.js ----------
// Distance math, spatial grids for fast nearest-neighbour lookups, pixel↔meter
// conversion, snapping, and ghost-point preview markers used by the map tools.

function haversineMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
              Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

function totalDistance(points) {
    let d = 0;
    for (let i = 1; i < points.length; i++) {
        d += haversineMeters(points[i-1].lat, points[i-1].lon, points[i].lat, points[i].lon);
    }
    return d;
}

// ---------- Spatial grid ----------
function buildGrid(points, cellDeg) {
    const grid = new Map();
    for (const p of points) {
        const i = Math.floor(p.lat / cellDeg);
        const j = Math.floor(p.lon / cellDeg);
        const k = i + ',' + j;
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(p);
    }
    return {grid, cellDeg};
}

function minDistanceToGrid(lat, lon, gridObj) {
    const {grid, cellDeg} = gridObj;
    const ci = Math.floor(lat / cellDeg);
    const cj = Math.floor(lon / cellDeg);
    let min = Infinity;
    for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
            const cell = grid.get((ci + di) + ',' + (cj + dj));
            if (!cell) continue;
            for (const p of cell) {
                const d = haversineMeters(lat, lon, p.lat, p.lon);
                if (d < min) min = d;
            }
        }
    }
    return min;
}

// Fast "is any base point within `threshold` of this location?" — early-exits
// on the first hit, so it's much faster than minDistanceToGrid when we only
// need a yes/no answer (classification, relevance).
function anyPointWithin(lat, lon, gridObj, threshold) {
    const {grid, cellDeg} = gridObj;
    const cellSpanM = cellDeg * 111000;
    const span = Math.max(1, Math.ceil(threshold / cellSpanM));
    const ci = Math.floor(lat / cellDeg);
    const cj = Math.floor(lon / cellDeg);
    const t2 = threshold; // convenience
    for (let di = -span; di <= span; di++) {
        for (let dj = -span; dj <= span; dj++) {
            const cell = grid.get((ci + di) + ',' + (cj + dj));
            if (!cell) continue;
            for (const p of cell) {
                if (haversineMeters(lat, lon, p.lat, p.lon) < t2) return true;
            }
        }
    }
    return false;
}

// Ghost marker shown in split mode over a hovered track to show where the
// split will land. Placed at the nearest vertex to the cursor.
function showGhostPoint(latlng) {
    if (!state.ghostPoint) {
        state.ghostPoint = L.circleMarker(latlng, {
            radius: 7,
            color: '#e63946',
            fillColor: '#ffdd00',
            fillOpacity: 0.85,
            weight: 2,
            interactive: false,
        }).addTo(map);
    } else {
        state.ghostPoint.setLatLng(latlng);
    }
}
function hideGhostPoint() {
    if (state.ghostPoint) {
        map.removeLayer(state.ghostPoint);
        state.ghostPoint = null;
    }
}
function nearestLatLngOn(line, latlng) {
    const latlngs = line.getLatLngs();
    let best = latlngs[0], bestDist = Infinity;
    for (const ll of latlngs) {
        const d = latlng.distanceTo(ll);
        if (d < bestDist) { bestDist = d; best = ll; }
    }
    return best;
}

// Convert screen pixels to meters at the current map center/zoom.
function pixelsToMeters(px) {
    const c = map.getCenter();
    const p1 = map.latLngToContainerPoint(c);
    const p2 = L.point(p1.x + px, p1.y);
    return c.distanceTo(map.containerPointToLatLng(p2));
}

// Find the closest track vertex (base or novel-ride) to latlng, within
// pxThreshold screen pixels. Returns {latlng, line, kind: 'base'|'ride'}
// or null.
function findSplitCandidate(latlng, pxThreshold = 40) {
    const thresholdM = pixelsToMeters(pxThreshold);
    let best = null;
    const check = (line, kind) => {
        if (!line || typeof line.getLatLngs !== 'function') return;
        for (const ll of line.getLatLngs()) {
            const d = latlng.distanceTo(ll);
            if (!best || d < best.dist) best = {latlng: ll, line, kind, dist: d};
        }
    };
    if (state.baseLayer) state.baseLayer.eachLayer(l => check(l, 'base'));
    for (const seg of state.segments) {
        if (seg.novel) check(seg.layer, 'ride');
    }
    if (best && best.dist <= thresholdM) return best;
    return null;
}

// Find the closest base-track point to latlng, within a pixel-derived
// threshold. Returns a LatLng if snapping should apply, else null.
function findSnap(latlng) {
    if (!state.baseGrid || !state.basePoints.length) return null;
    const thresholdM = pixelsToMeters(15);
    const {grid, cellDeg} = state.baseGrid;
    const cellSpanM = cellDeg * 111000;
    const span = Math.max(1, Math.ceil(thresholdM / cellSpanM));
    const ci = Math.floor(latlng.lat / cellDeg);
    const cj = Math.floor(latlng.lng / cellDeg);
    let best = null, bestDist = Infinity;
    for (let di = -span; di <= span; di++) {
        for (let dj = -span; dj <= span; dj++) {
            const cell = grid.get((ci + di) + ',' + (cj + dj));
            if (!cell) continue;
            for (const p of cell) {
                const d = haversineMeters(latlng.lat, latlng.lng, p.lat, p.lon);
                if (d < bestDist) { bestDist = d; best = p; }
            }
        }
    }
    if (best && bestDist <= thresholdM) return L.latLng(best.lat, best.lon);
    return null;
}

function ptLatLng(trkpt) {
    return {
        lat: parseFloat(trkpt.getAttribute('lat')),
        lon: parseFloat(trkpt.getAttribute('lon')),
    };
}
