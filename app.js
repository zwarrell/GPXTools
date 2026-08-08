// ---------- Map ----------
const map = L.map('map').setView([40.76, -112.78], 12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap'
}).addTo(map);

// Base polylines live in a pane above the default overlay pane so their
// hover/click events aren't stolen by ride polylines drawn on top of them.
map.createPane('basePane');
map.getPane('basePane').style.zIndex = 450;

// ---------- State ----------
const state = {
    baseCache: new Map(),   // name -> {xmlDoc, trksegs, points, size}
    rideCache: new Map(),

    activeBaseName: null,
    activeRideNames: new Set(),

    baseXmlDoc: null,
    basePoints: [],
    baseGrid: null,          // fine grid for duplicate detection
    relevanceGrid: null,     // coarse grid for relevance detection
    rideRelevance: new Map(),// rideName -> {percent, relevant}
    baseLayer: null,

    segments: [],           // [{id, rideName, indices, novel, included, distance, trksegIdx, layer}]
    rideLayerGroup: L.layerGroup().addTo(map),
};

// Relevance: what counts as "this ride visited the base map's area?"
const RELEVANCE = {
    radiusM: 100,       // ride point within this many m of any base point = "near"
    minPct: 5,          // >= this % of near-points → relevant
    sampleCap: 800,     // cap points sampled per ride so big files stay fast
};

// ---------- Units ----------
const UNITS_KEY = 'gpxtools.units';
const MERGED_KEY = 'gpxtools.mergedHistory';

state.units = localStorage.getItem(UNITS_KEY) || 'imperial';
// Per-ride split points, keyed by ride name; each is a set of ride-point indices
// where the user forced a segment split. Preserved across recomputes.
state.userSplits = new Map();
// Persistent list of rides that have been consumed by past merges.
state.mergedHistory = (() => {
    try { return JSON.parse(localStorage.getItem(MERGED_KEY)) || []; }
    catch { return []; }
})();
// Split-mode: when on, clicking a segment on the map splits it instead of toggling.
state.splitMode = false;
// Merge-tracks mode: click any number of tracks (base or ride novel segments)
// in order; they get chain-joined at their closest endpoints on Finish.
state.mergeMode = false;
state.mergeSelection = []; // [{kind: 'baseTrack'|'rideSeg', ref, name}]

function isSelectedForMerge(kind, ref) {
    return state.mergeSelection.some(s => s.kind === kind && s.ref === ref);
}

function fmtDist(meters) {
    if (state.units === 'imperial') return `${Math.round(meters * 3.28084).toLocaleString()} ft`;
    return `${Math.round(meters).toLocaleString()} m`;
}
function fmtLongDist(meters) {
    if (state.units === 'imperial') return `${(meters / 1609.344).toFixed(2)} mi`;
    return `${(meters / 1000).toFixed(2)} km`;
}
function unitShort() { return state.units === 'imperial' ? 'ft' : 'm'; }
function unitLongShort() { return state.units === 'imperial' ? 'mi' : 'km'; }

// Read a number input whose displayed value is in the current unit and return
// meters for internal calc.
function readInputMeters(id) {
    const v = parseFloat(document.getElementById(id).value);
    if (!Number.isFinite(v)) return 0;
    return state.units === 'imperial' ? v / 3.28084 : v;
}

// ---------- Utils ----------
const GPX_NS = 'http://www.topografix.com/GPX/1/1';

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

function parseGpx(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const err = doc.querySelector('parsererror');
    if (err) throw new Error('Invalid GPX: ' + err.textContent);
    return doc;
}

function extractTrksegs(doc) {
    const trksegs = [...doc.getElementsByTagName('trkseg')];
    return trksegs.map(seg =>
        [...seg.getElementsByTagName('trkpt')].map(pt => ({
            lat: parseFloat(pt.getAttribute('lat')),
            lon: parseFloat(pt.getAttribute('lon')),
            ele: pt.getElementsByTagName('ele')[0]?.textContent,
            time: pt.getElementsByTagName('time')[0]?.textContent,
            raw: pt,
        }))
    );
}

// Base points include both trk trkpts and rte rtepts, because either can
// represent an existing trail we want to match rides against.
function extractBasePoints(doc) {
    const out = [];
    for (const trkseg of doc.getElementsByTagName('trkseg')) {
        for (const pt of trkseg.getElementsByTagName('trkpt')) {
            const lat = parseFloat(pt.getAttribute('lat'));
            const lon = parseFloat(pt.getAttribute('lon'));
            if (Number.isFinite(lat) && Number.isFinite(lon)) out.push({lat, lon});
        }
    }
    for (const rte of doc.getElementsByTagName('rte')) {
        for (const pt of rte.getElementsByTagName('rtept')) {
            const lat = parseFloat(pt.getAttribute('lat'));
            const lon = parseFloat(pt.getAttribute('lon'));
            if (Number.isFinite(lat) && Number.isFinite(lon)) out.push({lat, lon});
        }
    }
    return out;
}

function baseFeatureCounts(doc) {
    return {
        trksegs: doc.getElementsByTagName('trkseg').length,
        rtes: doc.getElementsByTagName('rte').length,
    };
}

function flatten(trksegs) {
    const flat = [];
    trksegs.forEach((seg, si) => seg.forEach((p, pi) => {
        flat.push({...p, trksegIdx: si, pointIdx: pi});
    }));
    return flat;
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

// ---------- Relevance detection ----------
function buildRelevanceGrid() {
    if (!state.basePoints.length) { state.relevanceGrid = null; return; }
    const cellDeg = (2 * RELEVANCE.radiusM) / 111000;
    state.relevanceGrid = buildGrid(state.basePoints, cellDeg);
}

function computeRideRelevance(rideName) {
    const ride = state.rideCache.get(rideName);
    if (!ride || !state.relevanceGrid) return {percent: 0, relevant: false};
    const pts = ride.points;
    const step = Math.max(1, Math.floor(pts.length / RELEVANCE.sampleCap));
    let checked = 0, near = 0;
    for (let i = 0; i < pts.length; i += step) {
        checked++;
        if (anyPointWithin(pts[i].lat, pts[i].lon, state.relevanceGrid, RELEVANCE.radiusM)) near++;
    }
    const percent = checked ? (near / checked) * 100 : 0;
    return {percent, relevant: percent >= RELEVANCE.minPct};
}

function computeAllRelevance() {
    state.rideRelevance.clear();
    if (!state.relevanceGrid) return;
    for (const name of state.rideCache.keys()) {
        state.rideRelevance.set(name, computeRideRelevance(name));
    }
}

// ---------- Segmentation ----------
function classifyOneRide(ridePoints, threshold, minLen) {
    const isNovel = ridePoints.map(p => {
        if (!state.baseGrid) return true;
        return !anyPointWithin(p.lat, p.lon, state.baseGrid, threshold);
    });

    const runs = [];
    let cur = null;
    for (let i = 0; i < ridePoints.length; i++) {
        const p = ridePoints[i];
        const startNewRun = !cur
            || cur.novel !== isNovel[i]
            || cur.trksegIdx !== p.trksegIdx;
        if (startNewRun) {
            if (cur) runs.push(cur);
            cur = {indices: [i], novel: isNovel[i], trksegIdx: p.trksegIdx};
        } else {
            cur.indices.push(i);
        }
    }
    if (cur) runs.push(cur);

    for (const r of runs) {
        r.distance = totalDistance(r.indices.map(i => ridePoints[i]));
    }

    const filtered = runs.map(r => ({
        ...r,
        novel: r.novel && r.distance >= minLen,
    }));

    const merged = [];
    for (const r of filtered) {
        const last = merged[merged.length - 1];
        if (last && last.novel === r.novel && last.trksegIdx === r.trksegIdx) {
            last.indices.push(...r.indices);
            last.distance += r.distance;
        } else {
            merged.push({...r});
        }
    }
    return merged;
}

function classifyAll() {
    const threshold = readInputMeters('threshold');
    const minLen = readInputMeters('minLen');
    // Cap cell size so large thresholds don't inflate per-cell point counts.
    // anyPointWithin() handles multi-cell sweeps automatically.
    const cellSpanM = Math.min(2 * threshold, 60);
    const cellDeg = Math.max(cellSpanM / 111000, 0.00005);
    state.baseGrid = state.basePoints.length
        ? buildGrid(state.basePoints, cellDeg)
        : null;

    // Preserve per-segment state across recomputes (keyed by first index in a ride).
    const prev = new Map();
    for (const s of state.segments) {
        prev.set(`${s.rideName}:${s.indices[0]}:${s.novel}`, {
            included: s.included,
            name: s.name,
        });
    }

    state.segments = [];
    let nextId = 0;
    for (const rideName of state.activeRideNames) {
        const ride = state.rideCache.get(rideName);
        if (!ride) continue;
        const runs = classifyOneRide(ride.points, threshold, minLen);
        for (const r of runs) {
            const key = `${rideName}:${r.indices[0]}:${r.novel}`;
            const p = prev.get(key);
            state.segments.push({
                id: nextId++,
                rideName,
                indices: r.indices,
                novel: r.novel,
                trksegIdx: r.trksegIdx,
                included: p ? p.included : r.novel,
                distance: r.distance,
                name: p?.name ?? null,
                layer: null,
            });
        }
    }
    applyUserSplits(prev);
}

// Re-apply user-forced splits after classification so they survive recomputes.
// prev is the segment-state map keyed by rideName:firstIdx:novel from classifyAll,
// used to restore include/name state on the split children.
function applyUserSplits(prev) {
    for (const [rideName, splitSet] of state.userSplits) {
        if (!splitSet.size) continue;
        const ridePoints = state.rideCache.get(rideName)?.points;
        if (!ridePoints) continue;
        const splits = [...splitSet].sort((a, b) => a - b);
        for (const splitAt of splits) {
            // Find the novel segment containing this point (as an interior point).
            const segIdx = state.segments.findIndex(s =>
                s.rideName === rideName && s.novel &&
                s.indices[0] < splitAt && s.indices[s.indices.length - 1] > splitAt
            );
            if (segIdx === -1) continue;
            const seg = state.segments[segIdx];
            const pos = seg.indices.indexOf(splitAt);
            if (pos < 2 || pos > seg.indices.length - 3) continue;
            const firstIndices = seg.indices.slice(0, pos + 1);
            const secondIndices = seg.indices.slice(pos);
            const first = {
                ...seg,
                indices: firstIndices,
                distance: totalDistance(firstIndices.map(i => ridePoints[i])),
                layer: null,
            };
            const second = {
                ...seg,
                indices: secondIndices,
                distance: totalDistance(secondIndices.map(i => ridePoints[i])),
                layer: null,
            };
            const maxId = state.segments.reduce((m, s) => Math.max(m, s.id), -1);
            first.id = maxId + 1;
            second.id = maxId + 2;
            state.segments.splice(segIdx, 1, first, second);
        }
    }
}

function splitSegmentAt(id, latlng) {
    const seg = state.segments.find(s => s.id === id);
    if (!seg || !seg.novel) return;
    const ridePoints = state.rideCache.get(seg.rideName)?.points;
    if (!ridePoints) return;
    // Find the point in this segment closest to the click.
    let bestPos = -1, bestDist = Infinity;
    for (let k = 0; k < seg.indices.length; k++) {
        const p = ridePoints[seg.indices[k]];
        const d = haversineMeters(latlng.lat, latlng.lng, p.lat, p.lon);
        if (d < bestDist) { bestDist = d; bestPos = k; }
    }
    if (bestPos < 2 || bestPos > seg.indices.length - 3) return; // too close to an endpoint
    const splitAt = seg.indices[bestPos];
    if (!state.userSplits.has(seg.rideName)) state.userSplits.set(seg.rideName, new Set());
    state.userSplits.get(seg.rideName).add(splitAt);
    recompute();
}

// ---------- Rendering ----------
function drawBase() {
    if (state.baseLayer) {
        map.removeLayer(state.baseLayer);
        state.baseLayer = null;
    }
    if (!state.baseXmlDoc) return;

    const polylines = [];
    let counts = {trkseg: 0, rte: 0, skipped: 0, points: 0};

    const makeLine = (pts, name, ownerEl) => {
        if (pts.length < 2) { counts.skipped++; return; }
        counts.points += pts.length;
        const highlighted = ownerEl && isSelectedForMerge('baseTrack', ownerEl);
        const style = highlighted
            ? {color: '#e63946', weight: 6, opacity: 0.95, pane: 'basePane'}
            : {color: '#0066cc', weight: 4, opacity: 0.6, pane: 'basePane'};
        const line = L.polyline(pts, style);
        line._trkEl = ownerEl;
        line._trkName = name;
        line.bindTooltip(name, {sticky: true, direction: 'top'});
        line.on('click', (e) => {
            if (state.mergeMode) {
                handleMergeTrackClick(line, e.latlng);
            } else {
                L.popup().setLatLng(e.latlng).setContent(name).openOn(map);
            }
        });
        polylines.push(line);
    };

    // Find the enclosing <trk> or <rte> for a given element, and pick up its
    // direct-child <name>.
    const nameOf = (el, fallback) => {
        if (!el) return fallback;
        for (const child of el.children) {
            if (child.localName === 'name') {
                const text = (child.textContent || '').trim();
                if (text) return text;
            }
        }
        return fallback;
    };
    const walkUpTo = (el, tag) => {
        while (el && el.nodeType === 1 && el.localName !== tag) el = el.parentNode;
        return el && el.localName === tag ? el : null;
    };

    // Tracks
    for (const trkseg of state.baseXmlDoc.getElementsByTagName('trkseg')) {
        counts.trkseg++;
        const trkEl = walkUpTo(trkseg.parentNode, 'trk');
        const pts = [];
        for (const pt of trkseg.getElementsByTagName('trkpt')) {
            const lat = parseFloat(pt.getAttribute('lat'));
            const lon = parseFloat(pt.getAttribute('lon'));
            if (Number.isFinite(lat) && Number.isFinite(lon)) pts.push([lat, lon]);
        }
        makeLine(pts, nameOf(trkEl, '(unnamed track)'), trkEl);
    }

    // Routes
    for (const rte of state.baseXmlDoc.getElementsByTagName('rte')) {
        counts.rte++;
        const pts = [];
        for (const pt of rte.getElementsByTagName('rtept')) {
            const lat = parseFloat(pt.getAttribute('lat'));
            const lon = parseFloat(pt.getAttribute('lon'));
            if (Number.isFinite(lat) && Number.isFinite(lon)) pts.push([lat, lon]);
        }
        makeLine(pts, nameOf(rte, '(unnamed route)'), rte);
    }

    state.baseLayer = L.layerGroup(polylines).addTo(map);
    console.log(
        `drawBase: ${counts.trkseg} trkseg(s) + ${counts.rte} rte(s), ` +
        `${polylines.length} rendered, ${counts.skipped} skipped (fewer than 2 valid points), ` +
        `${counts.points} total points`
    );
}

function fitBoundsBase() {
    if (!state.baseLayer) return;
    const bounds = L.latLngBounds([]);
    state.baseLayer.eachLayer(l => {
        if (typeof l.getBounds === 'function') bounds.extend(l.getBounds());
    });
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.05));
}

function drawRide() {
    state.rideLayerGroup.clearLayers();
    for (const seg of state.segments) {
        const ridePoints = state.rideCache.get(seg.rideName)?.points;
        if (!ridePoints) continue;
        const latlngs = seg.indices.map(i => [ridePoints[i].lat, ridePoints[i].lon]);
        const merging = seg.novel && isSelectedForMerge('rideSeg', seg.id);
        let style;
        if (merging) {
            style = {color: '#e63946', weight: 6, opacity: 0.95};
        } else if (seg.novel) {
            style = seg.included
                ? {color: '#16a34a', weight: 5, opacity: 0.95}
                : {color: '#16a34a', weight: 3, opacity: 0.4, dashArray: '6 6'};
        } else {
            style = {color: '#ff8800', weight: 4, opacity: 0.9};
        }
        const line = L.polyline(latlngs, style);
        if (seg.novel) {
            line.on('click', (e) => {
                if (state.mergeMode) handleMergeSegClick(seg);
                else if (state.splitMode) splitSegmentAt(seg.id, e.latlng);
                else toggleSegment(seg.id);
            });
            line.on('mouseover', () => highlightSegmentItem(seg.id, true));
            line.on('mouseout', () => highlightSegmentItem(seg.id, false));
        }
        line.addTo(state.rideLayerGroup);
        seg.layer = line;
    }
}

function renderSegList() {
    const el = document.getElementById('segList');
    el.innerHTML = '';
    const novel = state.segments.filter(s => s.novel);
    if (!novel.length) {
        el.innerHTML = '<div class="hint">No new segments to review. Pick a ride file to compare.</div>';
        return;
    }
    // Group by ride, preserving ride selection order.
    const byRide = new Map();
    for (const s of novel) {
        if (!byRide.has(s.rideName)) byRide.set(s.rideName, []);
        byRide.get(s.rideName).push(s);
    }
    let localIdx;
    for (const [rideName, segs] of byRide) {
        const header = document.createElement('div');
        header.className = 'seg-group-header';
        header.title = rideName;
        header.textContent = rideName.replace(/\.gpx$/i, '');
        el.appendChild(header);
        localIdx = 0;
        for (const seg of segs) {
            localIdx++;
            const row = document.createElement('div');
            row.className = 'seg-item';
            row.dataset.segId = seg.id;

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = seg.included;
            cb.addEventListener('change', () => toggleSegment(seg.id, cb.checked));
            row.appendChild(cb);

            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.className = 'seg-name';
            nameInput.placeholder = defaultSegmentName(seg, localIdx);
            nameInput.value = seg.name ?? '';
            nameInput.addEventListener('input', () => { seg.name = nameInput.value.trim() || null; });
            row.appendChild(nameInput);

            const snapBtn = document.createElement('button');
            snapBtn.className = 'seg-snap';
            snapBtn.textContent = '⤢';
            snapBtn.title = 'Zoom map to this segment';
            snapBtn.addEventListener('click', (e) => { e.stopPropagation(); snapToSegment(seg.id); });
            row.appendChild(snapBtn);

            const len = document.createElement('span');
            len.className = 'len';
            len.textContent = fmtLongDist(seg.distance);
            row.appendChild(len);

            row.addEventListener('mouseenter', () => flashSegment(seg.id, true));
            row.addEventListener('mouseleave', () => flashSegment(seg.id, false));
            row.addEventListener('click', (e) => {
                if (e.target.matches('input, button')) return;
                snapToSegment(seg.id);
            });
            el.appendChild(row);
        }
    }
}

function defaultSegmentName(seg /*, localIdx */) {
    // Prefer the actual timestamp on the first point; fall back to a date
    // embedded in the filename (RideData_YYYY-MM-DD_...); fall back to today.
    let date = null;
    const ride = state.rideCache.get(seg.rideName);
    const firstTime = ride?.points?.[seg.indices[0]]?.time;
    if (firstTime) {
        const parsed = new Date(firstTime);
        if (!isNaN(parsed.getTime())) date = parsed;
    }
    if (!date) {
        const m = seg.rideName.match(/(\d{4})-(\d{2})-(\d{2})/);
        if (m) date = new Date(+m[1], +m[2] - 1, +m[3]);
    }
    if (!date) date = new Date();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const yy = String(date.getFullYear()).slice(-2);
    return `track${mm}_${dd}_${yy}`;
}

function flashSegment(id, on) {
    const seg = state.segments.find(s => s.id === id);
    if (!seg || !seg.layer) return;
    seg.layer.setStyle({weight: on ? 8 : (seg.novel ? (seg.included ? 5 : 3) : 4)});
}

function highlightSegmentItem(id, on) {
    const row = document.querySelector(`.seg-item[data-seg-id="${id}"]`);
    if (row) row.classList.toggle('hovered', on);
}

function toggleSegment(id, forced) {
    const seg = state.segments.find(s => s.id === id);
    if (!seg) return;
    seg.included = typeof forced === 'boolean' ? forced : !seg.included;
    drawRide();
    renderSegList();
    updateStats();
}

function updateStats() {
    const el = document.getElementById('stats');
    const novel = state.segments.filter(s => s.novel);
    if (!novel.length) { el.textContent = ''; document.getElementById('download').disabled = true; return; }
    const novelTotal = novel.reduce((s, r) => s + r.distance, 0);
    const included = novel.filter(s => s.included);
    const includedTotal = included.reduce((s, r) => s + r.distance, 0);
    const rideCount = new Set(novel.map(s => s.rideName)).size;
    el.innerHTML =
        `Active rides: <b>${rideCount}</b><br>` +
        `Novel total: <b>${fmtLongDist(novelTotal)}</b><br>` +
        `Will be added: <b>${fmtLongDist(includedTotal)}</b> ` +
        `(${included.length} segments)`;
    document.getElementById('download').disabled =
        !state.baseXmlDoc || !included.length;
}

function snapToSegment(id) {
    const seg = state.segments.find(s => s.id === id);
    if (!seg || !seg.layer) return;
    const b = seg.layer.getBounds();
    if (b.isValid()) map.fitBounds(b.pad(0.25));
}

function saveMergedHistory() {
    localStorage.setItem(MERGED_KEY, JSON.stringify(state.mergedHistory));
}

function renderMergedHistory() {
    const el = document.getElementById('mergedHistory');
    el.innerHTML = '';
    if (!state.mergedHistory.length) {
        el.innerHTML = '<div class="hint" style="padding:6px 0;">Nothing merged yet.</div>';
        return;
    }
    // Newest first.
    for (let i = state.mergedHistory.length - 1; i >= 0; i--) {
        const entry = state.mergedHistory[i];
        const row = document.createElement('div');
        row.className = 'file-row';
        const label = document.createElement('span');
        label.className = 'file-name';
        label.textContent = entry.name;
        label.title = `Merged ${new Date(entry.mergedAt).toLocaleString()}`;
        row.appendChild(label);
        const when = document.createElement('span');
        when.className = 'file-size';
        when.textContent = new Date(entry.mergedAt).toLocaleDateString();
        row.appendChild(when);
        const rm = document.createElement('button');
        rm.className = 'file-remove';
        rm.textContent = '×';
        rm.title = 'Remove from history';
        rm.addEventListener('click', () => {
            state.mergedHistory.splice(i, 1);
            saveMergedHistory();
            renderMergedHistory();
        });
        row.appendChild(rm);
        el.appendChild(row);
    }
}

function fitBoundsAll() {
    const bounds = L.latLngBounds([]);
    const extendFromGroup = g => g && g.eachLayer(l => {
        if (typeof l.getBounds === 'function') bounds.extend(l.getBounds());
    });
    extendFromGroup(state.baseLayer);
    extendFromGroup(state.rideLayerGroup);
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.05));
}

// ---------- Merge & Download ----------
function buildMergedXml() {
    const outDoc = state.baseXmlDoc.cloneNode(true);
    const gpxRoot = outDoc.getElementsByTagName('gpx')[0];
    // One <trk> per included segment so each keeps its own <name>.
    // Group and localIdx numbering mirrors the sidebar list so default names match what the user saw.
    const byRide = new Map();
    for (const seg of state.segments) {
        if (!seg.novel) continue;
        if (!byRide.has(seg.rideName)) byRide.set(seg.rideName, []);
        byRide.get(seg.rideName).push(seg);
    }
    for (const [rideName, segs] of byRide) {
        const ridePoints = state.rideCache.get(rideName).points;
        let localIdx = 0;
        for (const seg of segs) {
            localIdx++;
            if (!seg.included) continue;
            const trk = outDoc.createElementNS(GPX_NS, 'trk');
            const nameEl = outDoc.createElementNS(GPX_NS, 'name');
            nameEl.textContent = seg.name || defaultSegmentName(seg, localIdx);
            trk.appendChild(nameEl);
            const trkseg = outDoc.createElementNS(GPX_NS, 'trkseg');
            for (const i of seg.indices) {
                trkseg.appendChild(outDoc.importNode(ridePoints[i].raw, true));
            }
            trk.appendChild(trkseg);
            gpxRoot.appendChild(trk);
        }
    }
    return new XMLSerializer().serializeToString(outDoc);
}

function showStatus(msg) {
    const el = document.getElementById('mergeStatus');
    el.textContent = msg;
    clearTimeout(showStatus._t);
    showStatus._t = setTimeout(() => { el.textContent = ''; }, 6000);
}

function mergeAndDownload() {
    const included = state.segments.filter(s => s.included);
    if (!included.length || !state.activeBaseName) return;
    const usedRides = new Set(included.map(s => s.rideName));
    const xml = buildMergedXml();

    // Trigger download using the exact base filename.
    const blob = new Blob([xml], {type: 'application/gpx+xml'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = state.activeBaseName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    // Update the in-memory active base with the merged content so subsequent merges
    // compare against the fresh state (no need to reload the downloaded file).
    const newDoc = parseGpx(xml);
    const newTrksegs = extractTrksegs(newDoc);
    const newPoints = extractBasePoints(newDoc);
    state.baseCache.set(state.activeBaseName, {
        xmlDoc: newDoc, trksegs: newTrksegs, points: newPoints, size: blob.size,
    });
    state.baseXmlDoc = newDoc;
    state.basePoints = newPoints;

    // Remove rides that contributed segments to this merge; log them.
    const mergedAt = new Date().toISOString();
    for (const name of usedRides) {
        state.rideCache.delete(name);
        state.activeRideNames.delete(name);
        state.rideRelevance.delete(name);
        state.userSplits.delete(name);
        // Deduplicate: if this ride was already in history, drop the old entry.
        state.mergedHistory = state.mergedHistory.filter(e => e.name !== name);
        state.mergedHistory.push({name, mergedAt});
    }
    saveMergedHistory();
    renderMergedHistory();

    // Rebuild the base grids and re-score any remaining rides against the updated base.
    drawBase();
    buildRelevanceGrid();
    computeAllRelevance();
    const cc = baseFeatureCounts(newDoc);
    document.getElementById('baseInfo').innerHTML =
        `Active base: <b>${state.activeBaseName}</b> — ${cc.trksegs} trkseg(s)` +
        (cc.rtes ? ` + ${cc.rtes} route(s)` : '') +
        `, ${newPoints.length} points`;
    renderBaseList();
    renderRideList();
    updateRideInfo();
    recompute();

    const total = fmtLongDist(included.reduce((s, r) => s + r.distance, 0));
    showStatus(`Merged ${total} from ${usedRides.size} ride${usedRides.size === 1 ? '' : 's'}. Base updated; used rides removed.`);
}

// ---------- File ingestion & lists ----------
async function ingestFiles(fileList, cache) {
    const added = [];
    for (const file of fileList) {
        const text = await file.text();
        try {
            const xmlDoc = parseGpx(text);
            const trksegs = extractTrksegs(xmlDoc);
            const points = flatten(trksegs);
            cache.set(file.name, {xmlDoc, trksegs, points, size: file.size});
            added.push(file.name);
        } catch (e) {
            alert(`Failed to parse ${file.name}: ${e.message}`);
        }
    }
    return added;
}

function renderBaseList() {
    const el = document.getElementById('baseList');
    el.innerHTML = '';
    const names = [...state.baseCache.keys()].sort((a, b) => b.localeCompare(a));
    for (const name of names) {
        const row = document.createElement('div');
        row.className = 'file-row';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'baseActive';
        radio.checked = state.activeBaseName === name;
        radio.addEventListener('change', () => { if (radio.checked) setActiveBase(name); });
        row.appendChild(radio);
        const label = document.createElement('span');
        label.className = 'file-name';
        label.textContent = name;
        label.title = name;
        label.addEventListener('click', () => { radio.checked = true; setActiveBase(name); });
        row.appendChild(label);
        const size = document.createElement('span');
        size.className = 'file-size';
        size.textContent = `${(state.baseCache.get(name).size / 1024).toFixed(0)} KB`;
        row.appendChild(size);
        const rm = document.createElement('button');
        rm.className = 'file-remove';
        rm.textContent = '×';
        rm.title = 'Remove from list';
        rm.addEventListener('click', () => removeBase(name));
        row.appendChild(rm);
        el.appendChild(row);
    }
}

function renderRideList() {
    const el = document.getElementById('rideList');
    el.innerHTML = '';
    const names = [...state.rideCache.keys()];
    names.sort((a, b) => {
        const ra = state.rideRelevance.get(a);
        const rb = state.rideRelevance.get(b);
        const relA = ra?.relevant ? 1 : 0;
        const relB = rb?.relevant ? 1 : 0;
        if (relA !== relB) return relB - relA;
        if (relA === 1) return rb.percent - ra.percent;
        return b.localeCompare(a);
    });
    for (const name of names) {
        const row = document.createElement('div');
        row.className = 'file-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = state.activeRideNames.has(name);
        cb.addEventListener('change', () => toggleActiveRide(name, cb.checked));
        row.appendChild(cb);
        const label = document.createElement('span');
        label.className = 'file-name';
        label.textContent = name;
        label.title = name;
        label.addEventListener('click', () => { cb.checked = !cb.checked; toggleActiveRide(name, cb.checked); });
        row.appendChild(label);
        const rel = state.rideRelevance.get(name);
        if (rel && state.relevanceGrid) {
            const badge = document.createElement('span');
            badge.className = 'relevance-badge' + (rel.relevant ? ' relevant' : '');
            badge.textContent = `${rel.percent.toFixed(0)}%`;
            badge.title = `${rel.percent.toFixed(1)}% of ride points within ${fmtDist(RELEVANCE.radiusM)} of base`;
            row.appendChild(badge);
        }
        const size = document.createElement('span');
        size.className = 'file-size';
        size.textContent = `${(state.rideCache.get(name).size / 1024).toFixed(0)} KB`;
        row.appendChild(size);
        const rm = document.createElement('button');
        rm.className = 'file-remove';
        rm.textContent = '×';
        rm.title = 'Remove from list';
        rm.addEventListener('click', () => removeRide(name));
        row.appendChild(rm);
        el.appendChild(row);
    }
}

function setActiveBase(name) {
    const entry = state.baseCache.get(name);
    if (!entry) return;
    state.activeBaseName = name;
    state.baseXmlDoc = entry.xmlDoc;
    // Recompute from the doc so routes are included even if the cache entry
    // was built with the older trkseg-only ingest.
    state.basePoints = extractBasePoints(entry.xmlDoc);
    const c = baseFeatureCounts(entry.xmlDoc);
    document.getElementById('baseInfo').innerHTML =
        `Active base: <b>${name}</b> — ${c.trksegs} trkseg(s)` +
        (c.rtes ? ` + ${c.rtes} route(s)` : '') +
        `, ${state.basePoints.length} points`;
    drawBase();
    fitBoundsBase();
    buildRelevanceGrid();
    computeAllRelevance();
    // Auto-select rides that visit this base's area
    state.activeRideNames = new Set(
        [...state.rideRelevance.entries()]
            .filter(([, r]) => r.relevant)
            .map(([n]) => n)
    );
    renderRideList();
    updateRideInfo();
    recompute();
}

function toggleActiveRide(name, on) {
    if (on) state.activeRideNames.add(name);
    else state.activeRideNames.delete(name);
    updateRideInfo();
    recompute();
    fitBoundsAll();
}

function updateRideInfo() {
    const el = document.getElementById('rideInfo');
    if (!state.activeRideNames.size) { el.textContent = ''; return; }
    const totalPts = [...state.activeRideNames]
        .map(n => state.rideCache.get(n)?.points.length || 0)
        .reduce((a, b) => a + b, 0);
    el.innerHTML = `Active rides: <b>${state.activeRideNames.size}</b>, ${totalPts} points`;
}

function removeBase(name) {
    state.baseCache.delete(name);
    if (state.activeBaseName === name) {
        state.activeBaseName = null;
        state.baseXmlDoc = null;
        state.basePoints = [];
        state.relevanceGrid = null;
        state.rideRelevance.clear();
        drawBase();
        document.getElementById('baseInfo').textContent = '';
        renderRideList();
        recompute();
    }
    renderBaseList();
}

function removeRide(name) {
    state.rideCache.delete(name);
    state.rideRelevance.delete(name);
    state.userSplits.delete(name);
    if (state.activeRideNames.has(name)) {
        state.activeRideNames.delete(name);
        updateRideInfo();
        recompute();
    }
    renderRideList();
}

function recompute() {
    classifyAll();
    drawRide();
    renderSegList();
    updateStats();
}

// ---------- Merge two base tracks ----------
function collectAllTrkpts(trkEl) {
    const pts = [];
    for (const trkseg of trkEl.getElementsByTagName('trkseg')) {
        for (const pt of trkseg.getElementsByTagName('trkpt')) pts.push(pt);
    }
    return pts;
}

function joinEndFor(trkEl, latlng) {
    const pts = collectAllTrkpts(trkEl);
    if (!pts.length) return null;
    const first = pts[0];
    const last = pts[pts.length - 1];
    const dStart = haversineMeters(
        latlng.lat, latlng.lng,
        parseFloat(first.getAttribute('lat')), parseFloat(first.getAttribute('lon')));
    const dEnd = haversineMeters(
        latlng.lat, latlng.lng,
        parseFloat(last.getAttribute('lat')), parseFloat(last.getAttribute('lon')));
    return dStart < dEnd ? 'start' : 'end';
}

function setMergeTracksMode(on) {
    state.mergeMode = on;
    state.mergeSelection = [];
    const btn = document.getElementById('mergeTracksMode');
    btn.textContent = `Merge tracks: ${on ? 'on' : 'off'}`;
    btn.classList.toggle('active', on);
    document.getElementById('map').classList.toggle('merge-mode', on);
    renderMergeQueue();
    drawBase();
    drawRide();
}

function handleMergeTrackClick(line) {
    if (isSelectedForMerge('baseTrack', line._trkEl)) return; // already queued
    state.mergeSelection.push({
        kind: 'baseTrack',
        ref: line._trkEl,
        name: line._trkName,
    });
    renderMergeQueue();
    drawBase();
    drawRide();
}

function handleMergeSegClick(seg) {
    if (!seg.novel) return;
    if (isSelectedForMerge('rideSeg', seg.id)) return;
    state.mergeSelection.push({
        kind: 'rideSeg',
        ref: seg.id,
        name: seg.name || defaultSegmentName(seg, 1),
    });
    renderMergeQueue();
    drawBase();
    drawRide();
}

function removeFromMergeQueue(index) {
    state.mergeSelection.splice(index, 1);
    renderMergeQueue();
    drawBase();
    drawRide();
}

function renderMergeQueue() {
    const el = document.getElementById('mergeTracksHint');
    if (!state.mergeMode) { el.innerHTML = ''; return; }
    if (!state.mergeSelection.length) {
        el.innerHTML = '<div class="hint">Click tracks or new segments in the order you want them joined.</div>';
        return;
    }
    const items = state.mergeSelection.map((s, i) => {
        const kindTag = s.kind === 'baseTrack' ? 'base' : 'new';
        return `<li><span class="merge-item-num">${i + 1}.</span>
                    <span class="merge-item-name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span>
                    <span class="merge-item-kind">(${kindTag})</span>
                    <button class="mini" data-remove="${i}" title="Remove">×</button></li>`;
    }).join('');
    el.innerHTML =
        `<div><b>Merge queue (${state.mergeSelection.length}):</b></div>` +
        `<ol class="merge-queue">${items}</ol>` +
        `<button id="mergeFinish" ${state.mergeSelection.length < 2 ? 'disabled' : ''}>Finish & name</button> ` +
        `<button id="mergeCancel" class="mini">Cancel</button>`;
    el.querySelectorAll('[data-remove]').forEach(btn =>
        btn.addEventListener('click', () => removeFromMergeQueue(+btn.dataset.remove)));
    const finish = document.getElementById('mergeFinish');
    if (finish) finish.addEventListener('click', finishMergeQueue);
    const cancel = document.getElementById('mergeCancel');
    if (cancel) cancel.addEventListener('click', () => setMergeTracksMode(false));
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
        ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function finishMergeQueue() {
    if (state.mergeSelection.length < 2) return;
    const suggested = state.mergeSelection[0].name;
    const newName = prompt(
        `Name for merged track (${state.mergeSelection.length} pieces):`,
        suggested);
    if (!newName || !newName.trim()) return;
    performMultiMerge(state.mergeSelection.slice(), newName.trim());
    setMergeTracksMode(false);
}

// Turn each selection into its underlying trkpt XML elements.
// Ride-segment points come straight from the ride's cached raw <trkpt> nodes.
function pointsForSelection(s) {
    if (s.kind === 'baseTrack') {
        return collectAllTrkpts(s.ref);
    }
    const seg = state.segments.find(sg => sg.id === s.ref);
    if (!seg) return [];
    const ridePoints = state.rideCache.get(seg.rideName)?.points;
    if (!ridePoints) return [];
    return seg.indices.map(i => ridePoints[i].raw).filter(Boolean);
}

function ptLatLng(trkpt) {
    return {
        lat: parseFloat(trkpt.getAttribute('lat')),
        lon: parseFloat(trkpt.getAttribute('lon')),
    };
}

// Chain-orient arrays so successive tracks join at their closest endpoints.
// First pair: try all four orientation combinations, pick the one with the
// smallest joint distance. Every subsequent track: reverse if its "end" is
// closer to the accumulated tail than its "start".
function chainOrient(arrays) {
    const result = arrays.map(a => a.slice());
    if (result.length < 2) return result;
    const first = a => a[0];
    const last  = a => a[a.length - 1];
    const dist = (p1, p2) => {
        const a = ptLatLng(p1), b = ptLatLng(p2);
        return haversineMeters(a.lat, a.lon, b.lat, b.lon);
    };
    // First pair — best-of-4 orientation.
    const t1 = result[0], t2 = result[1];
    const opts = [
        {d: dist(first(t1), first(t2)), r1: true,  r2: false},
        {d: dist(first(t1), last(t2)),  r1: true,  r2: true },
        {d: dist(last(t1),  first(t2)), r1: false, r2: false},
        {d: dist(last(t1),  last(t2)),  r1: false, r2: true },
    ];
    const best = opts.reduce((m, o) => o.d < m.d ? o : m);
    if (best.r1) result[0].reverse();
    if (best.r2) result[1].reverse();
    // Rest — greedy.
    for (let i = 2; i < result.length; i++) {
        const tail = last(result[i - 1]);
        if (dist(tail, last(result[i])) < dist(tail, first(result[i]))) {
            result[i].reverse();
        }
    }
    return result;
}

function performMultiMerge(selections, newName) {
    const doc = state.baseXmlDoc;
    const arrays = selections.map(pointsForSelection).filter(a => a.length > 0);
    if (arrays.length < 2) { alert('Not enough valid tracks to merge.'); return; }
    const oriented = chainOrient(arrays);

    const trk = doc.createElementNS(GPX_NS, 'trk');
    const nameEl = doc.createElementNS(GPX_NS, 'name');
    nameEl.textContent = newName;
    trk.appendChild(nameEl);
    const trkseg = doc.createElementNS(GPX_NS, 'trkseg');
    for (const arr of oriented) {
        for (const pt of arr) trkseg.appendChild(pt.cloneNode(true));
    }
    trk.appendChild(trkseg);

    // Insert new trk where the first base track was (or at the end of gpx root).
    const firstBase = selections.find(s => s.kind === 'baseTrack');
    if (firstBase && firstBase.ref.parentNode) {
        firstBase.ref.parentNode.insertBefore(trk, firstBase.ref);
    } else {
        doc.getElementsByTagName('gpx')[0].appendChild(trk);
    }

    // Remove any selected base tracks (they've been absorbed).
    for (const s of selections) {
        if (s.kind === 'baseTrack' && s.ref.parentNode) {
            s.ref.parentNode.removeChild(s.ref);
        }
    }

    // Refresh base state — ride segments will re-classify against the updated base
    // on the next recompute, so any absorbed ride segments become duplicates.
    const entry = state.baseCache.get(state.activeBaseName);
    if (entry) {
        entry.trksegs = extractTrksegs(doc);
        entry.points = extractBasePoints(doc);
        const serialized = new XMLSerializer().serializeToString(doc);
        entry.size = new Blob([serialized]).size;
    }
    state.basePoints = extractBasePoints(doc);
    const c = baseFeatureCounts(doc);
    document.getElementById('baseInfo').innerHTML =
        `Active base: <b>${state.activeBaseName}</b> — ${c.trksegs} trkseg(s)` +
        (c.rtes ? ` + ${c.rtes} route(s)` : '') +
        `, ${state.basePoints.length} points`;
    drawBase();
    buildRelevanceGrid();
    computeAllRelevance();
    renderBaseList();
    renderRideList();
    recompute();
    const pieces = selections.map(s => `"${s.name}"`).join(' + ');
    showStatus(`Merged ${pieces} into "${newName}".`);
}

// ---------- Wiring ----------
async function handleBaseFiles(fileList) {
    const gpx = [...fileList].filter(f => /\.gpx$/i.test(f.name));
    if (!gpx.length) return;
    const added = await ingestFiles(gpx, state.baseCache);
    renderBaseList();
    if (added.length && !state.activeBaseName) {
        setActiveBase(added[0]);
    }
}

async function handleRideFiles(fileList) {
    const gpx = [...fileList].filter(f => /\.gpx$/i.test(f.name));
    if (!gpx.length) return;
    const added = await ingestFiles(gpx, state.rideCache);
    if (state.relevanceGrid) {
        for (const name of added) {
            state.rideRelevance.set(name, computeRideRelevance(name));
        }
    }
    for (const name of added) {
        const rel = state.rideRelevance.get(name);
        if (!state.relevanceGrid || rel?.relevant) {
            state.activeRideNames.add(name);
        }
    }
    renderRideList();
    updateRideInfo();
    recompute();
    fitBoundsAll();
}

function wireDropzone(zoneId, inputId, handler) {
    const zone = document.getElementById(zoneId);
    const input = document.getElementById(inputId);
    input.addEventListener('change', async e => {
        await handler(e.target.files);
        e.target.value = '';
    });
    zone.addEventListener('dragover', e => {
        e.preventDefault();
        zone.classList.add('dragover');
    });
    zone.addEventListener('dragleave', e => {
        // Only clear when leaving the zone itself, not a child.
        if (e.target === zone) zone.classList.remove('dragover');
    });
    zone.addEventListener('drop', async e => {
        e.preventDefault();
        zone.classList.remove('dragover');
        if (e.dataTransfer?.files?.length) await handler(e.dataTransfer.files);
    });
}

wireDropzone('baseDropzone', 'baseFiles', handleBaseFiles);
wireDropzone('rideDropzone', 'rideFiles', handleRideFiles);

// Prevent the browser from navigating away if a file is dropped outside the zones.
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => e.preventDefault());

document.getElementById('rideCheckAll').addEventListener('click', () => {
    for (const name of state.rideCache.keys()) state.activeRideNames.add(name);
    renderRideList(); updateRideInfo(); recompute(); fitBoundsAll();
});
document.getElementById('rideCheckNone').addEventListener('click', () => {
    state.activeRideNames.clear();
    renderRideList(); updateRideInfo(); recompute();
});
document.getElementById('rideCheckRelevant').addEventListener('click', () => {
    if (!state.relevanceGrid) { alert('Load a base map first.'); return; }
    state.activeRideNames = new Set(
        [...state.rideRelevance.entries()].filter(([, r]) => r.relevant).map(([n]) => n)
    );
    renderRideList(); updateRideInfo(); recompute(); fitBoundsAll();
});

function updateInputUnits() {
    const tu = document.getElementById('thresholdUnit');
    const mu = document.getElementById('minLenUnit');
    if (tu) tu.textContent = unitShort();
    if (mu) mu.textContent = unitShort();
}

function applyUnits(newUnits, {convertInputs}) {
    if (newUnits === state.units && !convertInputs) { updateInputUnits(); return; }
    if (convertInputs && newUnits !== state.units) {
        const t = document.getElementById('threshold');
        const m = document.getElementById('minLen');
        const convert = v => newUnits === 'imperial'
            ? Math.round(v * 3.28084)   // m → ft
            : Math.round(v / 3.28084);  // ft → m
        if (t) t.value = convert(+t.value || 0);
        if (m) m.value = convert(+m.value || 0);
    }
    state.units = newUnits;
    localStorage.setItem(UNITS_KEY, state.units);
    updateInputUnits();
    renderSegList();
    renderRideList();
    updateStats();
}

// Initial seed: HTML defaults are meters; if imperial, convert.
if (state.units === 'imperial') {
    const t = document.getElementById('threshold');
    const m = document.getElementById('minLen');
    if (t) t.value = Math.round((+t.value || 15) * 3.28084);
    if (m) m.value = Math.round((+m.value || 30) * 3.28084);
}
updateInputUnits();

// Units radio wiring — listen to both change and click so we don't miss any path.
for (const r of document.querySelectorAll('input[name="units"]')) {
    r.checked = r.value === state.units;
    const handler = () => { if (r.checked) applyUnits(r.value, {convertInputs: true}); };
    r.addEventListener('change', handler);
    r.addEventListener('click', handler);
}

document.getElementById('splitMode').addEventListener('click', () => {
    state.splitMode = !state.splitMode;
    const btn = document.getElementById('splitMode');
    btn.textContent = `Split mode: ${state.splitMode ? 'on' : 'off'}`;
    btn.classList.toggle('active', state.splitMode);
    document.getElementById('map').classList.toggle('split-mode', state.splitMode);
});

document.getElementById('mergeTracksMode').addEventListener('click', () => {
    if (!state.baseXmlDoc) { alert('Load a base map first.'); return; }
    setMergeTracksMode(!state.mergeMode);
});

document.getElementById('clearMergedHistory').addEventListener('click', () => {
    if (!state.mergedHistory.length) return;
    if (!confirm('Clear merged history?')) return;
    state.mergedHistory = [];
    saveMergedHistory();
    renderMergedHistory();
});
document.getElementById('recompute').addEventListener('click', () => {
    const btn = document.getElementById('recompute');
    const orig = btn.textContent;
    btn.textContent = 'Recomputing…';
    btn.disabled = true;
    // Defer to next paint so the button state updates before the heavy work starts.
    setTimeout(() => {
        try { recompute(); }
        finally {
            btn.textContent = orig;
            btn.disabled = false;
        }
    }, 20);
});
document.getElementById('selectAll').addEventListener('click', () => {
    for (const s of state.segments) if (s.novel) s.included = true;
    drawRide(); renderSegList(); updateStats();
});
document.getElementById('deselectAll').addEventListener('click', () => {
    for (const s of state.segments) if (s.novel) s.included = false;
    drawRide(); renderSegList(); updateStats();
});
document.getElementById('download').addEventListener('click', mergeAndDownload);

renderSegList();
renderMergedHistory();
