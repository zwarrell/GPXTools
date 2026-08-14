// ---------- state.js ----------
// Leaflet map init, base/overlay tile layer setup, and the shared `state`
// object plus small unit-formatting helpers that depend on state.units.

// ---------- Map ----------
const map = L.map('map').setView([40.76, -112.78], 12);


// Base polylines live in a pane above the default overlay pane so their
// hover/click events aren't stolen by ride polylines drawn on top of them.
map.createPane('basePane');
map.getPane('basePane').style.zIndex = 450;

const baseLayers = {
    "OpenStreetMap": L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap',
        className: 'invert-in-dark',
    }),
    "USGS Topo": L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', {
        maxZoom: 16,
        attribution: 'Tiles courtesy of the U.S. Geological Survey',
        className: 'invert-in-dark',
    }),
    "OpenTopoMap": L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
        maxZoom: 17,
        subdomains: 'abc',
        attribution: '© OpenStreetMap · SRTM · OpenTopoMap (CC-BY-SA)',
        className: 'invert-in-dark',
    }),
};

// MVUM via esri-leaflet's dynamicMapLayer. USFS's ArcGIS service is a
// server-side render — every viewport change costs a round trip and there's
// no CDN in front of it, so we throttle re-requests (updateInterval 500ms
// waits for the user to stop panning before firing another fetch) and show
// a loading indicator on the tools panel while a request is in flight.
const mvumLayer = L.esri.dynamicMapLayer({
    url: 'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_MVUM_01/MapServer',
    opacity: 0.85,
    updateInterval: 500,
    useCors: true,
    f: 'image',
    attribution: '© US Forest Service',
});
function setMvumLoading(on) {
    let el = document.getElementById('mvumLoadingBadge');
    if (on) {
        if (!el) {
            el = document.createElement('div');
            el.id = 'mvumLoadingBadge';
            el.textContent = 'Loading MVUM…';
            document.body.appendChild(el);
        }
        el.style.display = 'block';
    } else if (el) {
        el.style.display = 'none';
    }
}
mvumLayer.on('loading', () => setMvumLoading(true));
mvumLayer.on('load',    () => setMvumLoading(false));
mvumLayer.on('error',   (e) => {
    setMvumLoading(false);
    console.warn('MVUM load error:', e);
    if (typeof showToast === 'function') showToast('MVUM tile load failed. Try panning to retry.', 'warn', 4000);
});
const mvumForceRedraw = () => mvumLayer.redraw && mvumLayer.redraw();
mvumLayer.on('add',    () => { map.on('moveend zoomend', mvumForceRedraw); mvumForceRedraw(); });
mvumLayer.on('remove', () => { map.off('moveend zoomend', mvumForceRedraw); setMvumLoading(false); });

const overlayLayers = {
    "USFS MVUM (motor use)": mvumLayer,
};

// Default base
baseLayers["USGS Topo"].addTo(map);

L.control.layers(baseLayers, overlayLayers, {position: 'topright', collapsed: true}).addTo(map);

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

state.units = localStorage.getItem(UNITS_KEY) || 'imperial';
// Per-ride split points, keyed by ride name; each is a set of ride-point indices
// where the user forced a segment split. Preserved across recomputes.
state.userSplits = new Map();
// Persistent list of rides that have been consumed by past merges.
state.mergedHistory = (() => {
    try { return JSON.parse(localStorage.getItem(MERGED_KEY)) || []; }
    catch { return []; }
})();
// Active map tool: null, 'split', 'merge', 'extend', or 'draw'.
// Only one tool can be active at a time.
state.activeTool = null;
// Active sidebar panel: 'compare' or 'contents'. Independent of map tool;
// only one panel visible at a time. Persisted across reloads so users don't
// have to re-open Compare every session.
state.activePanel = localStorage.getItem('gpxtools.activePanel') || null;
state.waypointLayer = null;
state.baseHistory = []; // undo stack of serialized base XML strings
state.baseRedoStack = []; // redo stack, cleared on any new base mutation
state.ghostPoint = null; // preview marker shown in split mode
state.mergeSelection = []; // [{kind: 'baseTrack'|'rideSeg', ref, name}]
state.extendTarget = null; // {trkEl, appendAt: 'start'|'end'}
state.extendNewPoints = []; // [{lat, lon}]
state.drawPoints = []; // [{lat, lon}]
state.editTarget = null; // {trkEl, name} — the base track being edited
state.editPoints = []; // [{lat, lon, raw?}] — full editable copy of the track's points
state.previewLayer = null;
state.toolHistory = []; // snapshots of the current tool's point buffer for in-tool undo
state.toolRedoStack = []; // paired redo for the in-tool history

// Back-compat getters — existing code paths reference these.
Object.defineProperty(state, 'splitMode', { get() { return this.activeTool === 'split'; } });
Object.defineProperty(state, 'mergeMode', { get() { return this.activeTool === 'merge'; } });

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
