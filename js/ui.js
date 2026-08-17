// ---------- ui.js ----------
// Sidebar panels (Compare / Contents), color-preset menu, base/ride file lists,
// drop-zone wiring, unit toggles, the tools panel Leaflet control, and all
// remaining DOM event wiring plus the initial render calls.

// ---------- Sidebar panels (Compare / Base contents) ----------
function togglePanel(panel) {
    const newVal = state.activePanel === panel ? null : panel;
    state.activePanel = newVal;
    if (newVal) localStorage.setItem('gpxtools.activePanel', newVal);
    else localStorage.removeItem('gpxtools.activePanel');
    updatePanelVisibility();
    if (newVal === 'contents') renderContentsPanel();
}

function updatePanelVisibility() {
    document.getElementById('comparePanel').style.display  = state.activePanel === 'compare'  ? '' : 'none';
    document.getElementById('contentsPanel').style.display = state.activePanel === 'contents' ? '' : 'none';
    document.body.classList.toggle('compare-active', state.activePanel === 'compare');
    document.body.classList.toggle('contents-active', state.activePanel === 'contents');
    const panelEl = document.getElementById('toolsPanel');
    if (panelEl) {
        panelEl.querySelectorAll('button[data-panel]').forEach(b => {
            b.classList.toggle('active', b.dataset.panel === state.activePanel);
        });
    }
    // Colors flip between blue (compare) and TT:Color (normal); redraw base.
    drawBase();
}

function renderContentsPanel() {
    const el = document.getElementById('contentsList');
    if (!el) return;
    if (!state.baseXmlDoc) {
        el.innerHTML = '<div class="hint">Load a base map first.</div>';
        return;
    }
    const doc = state.baseXmlDoc;
    const html = [];

    // Sort each group alphabetically by name (case-insensitive), preserving
    // original doc index so item click still maps back.
    const buildRows = (tag, kind, meta) => {
        const els = [...doc.getElementsByTagName(tag)];
        if (!els.length) return;
        const indexed = els.map((el, i) => ({ el, i, name: directChildText(el, 'name') || `(${tag} ${i + 1})` }));
        indexed.sort((a, b) => a.name.localeCompare(b.name, undefined, {sensitivity: 'base'}));
        html.push(`<div class="contents-group">${meta.groupLabel} (${indexed.length})</div>`);
        for (const {el, i, name} of indexed) {
            const metaText = meta.metaText(el);
            const tooltip  = meta.tooltip ? meta.tooltip(el, name) : name;
            html.push(
                `<div class="contents-item" data-kind="${kind}" data-idx="${i}">
                    <span class="cn-name" title="${escapeHtml(tooltip)}">${escapeHtml(name)}</span>
                    <span class="cn-meta">${escapeHtml(metaText)}</span>
                    <button data-rename="${kind}:${i}" title="Rename">✎</button>
                    <button data-remove="${kind}:${i}" title="Delete">×</button>
                </div>`
            );
        }
    };

    // Custom row builder for tracks — includes a native color picker driven by
    // <TT:Color> (TrailTech Voyager Pro's coloring extension).
    const trks2 = [...doc.getElementsByTagName('trk')];
    if (trks2.length) {
        const indexed = trks2.map((el, i) => ({
            el, i, name: directChildText(el, 'name') || `(trk ${i + 1})`
        }));
        indexed.sort((a, b) => a.name.localeCompare(b.name, undefined, {sensitivity: 'base'}));
        html.push(`<div class="contents-group">Tracks (${indexed.length})</div>`);
        for (const {el, i, name} of indexed) {
            const pts = collectAllTrkpts(el);
            const coords = pts.map(p => ({
                lat: parseFloat(p.getAttribute('lat')),
                lon: parseFloat(p.getAttribute('lon')),
            }));
            const color = trkColor(el) || '#0066cc';
            html.push(
                `<div class="contents-item" data-kind="trk" data-idx="${i}">
                    <input type="color" class="cn-color" data-color-trk="${i}" value="${color}" list="colorPresets" title="Track color — pick a custom color">
                    <button class="cn-preset-btn" data-preset-trk="${i}" title="Choose from preset palette">▾</button>
                    <span class="cn-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
                    <span class="cn-meta">${pts.length} pts · ${fmtLongDist(totalDistance(coords))}</span>
                    <button data-rename="trk:${i}" title="Rename">✎</button>
                    <button data-remove="trk:${i}" title="Delete">×</button>
                </div>`
            );
        }
    }

    buildRows('rte', 'rte', {
        groupLabel: 'Routes',
        metaText: el => {
            const rtepts = [...el.getElementsByTagName('rtept')];
            const coords = rtepts.map(p => ({
                lat: parseFloat(p.getAttribute('lat')),
                lon: parseFloat(p.getAttribute('lon')),
            }));
            return `${rtepts.length} pts · ${fmtLongDist(totalDistance(coords))}`;
        },
    });

    // Waypoints — custom row builder so we can show a color dot alongside the sym.
    const wpts2 = [...doc.getElementsByTagName('wpt')];
    if (wpts2.length) {
        const indexed = wpts2.map((el, i) => ({
            el, i, name: directChildText(el, 'name') || `(wpt ${i + 1})`
        }));
        indexed.sort((a, b) => a.name.localeCompare(b.name, undefined, {sensitivity: 'base'}));
        html.push(`<div class="contents-group">Waypoints (${indexed.length})</div>`);
        for (const {el, i, name} of indexed) {
            const sym = directChildText(el, 'sym');
            const desc = directChildText(el, 'desc') || name;
            const color = wptColor(el) || '#0066cc';
            html.push(
                `<div class="contents-item" data-kind="wpt" data-idx="${i}">
                    <span class="cn-wpt-dot" style="background:${color}" title="Color"></span>
                    <span class="cn-name" title="${escapeHtml(desc)}">${escapeHtml(name)}</span>
                    <span class="cn-meta">${escapeHtml(sym)}</span>
                    <button data-rename="wpt:${i}" title="Edit waypoint">✎</button>
                    <button data-remove="wpt:${i}" title="Delete">×</button>
                </div>`
            );
        }
    }

    if (!html.length) html.push('<div class="hint">Empty base file.</div>');
    el.innerHTML = html.join('');

    el.querySelectorAll('.contents-item').forEach(row => {
        row.tabIndex = 0;
        row.addEventListener('click', (e) => {
            if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
            row.focus();
            zoomToContentsItem(row.dataset.kind, +row.dataset.idx);
        });
        row.addEventListener('keydown', (e) => rowNavKeydown(e, row, {
            onEnter: () => zoomToContentsItem(row.dataset.kind, +row.dataset.idx),
            onDelete: () => removeContentsItem(row.dataset.kind, +row.dataset.idx),
        }));
    });
    el.querySelectorAll('button[data-remove]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const [kind, idxStr] = btn.dataset.remove.split(':');
            removeContentsItem(kind, +idxStr);
        });
    });
    el.querySelectorAll('button[data-rename]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const [kind, idxStr] = btn.dataset.rename.split(':');
            renameFeature(kind, +idxStr);
        });
    });
    el.querySelectorAll('input.cn-color[data-color-trk]').forEach(input => {
        input.addEventListener('click', e => e.stopPropagation());
        input.addEventListener('change', () => {
            const idx = +input.dataset.colorTrk;
            const trk = doc.getElementsByTagName('trk')[idx];
            if (!trk) return;
            pushHistory();
            setTrkColor(trk, input.value);
            refreshBaseAfterEdit(`Set color for "${directChildText(trk, 'name') || 'track'}".`);
        });
    });
    el.querySelectorAll('button.cn-preset-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = +btn.dataset.presetTrk;
            showColorPresetMenu(btn, hex => {
                const trk = doc.getElementsByTagName('trk')[idx];
                if (!trk) return;
                pushHistory();
                setTrkColor(trk, hex);
                refreshBaseAfterEdit(`Set color for "${directChildText(trk, 'name') || 'track'}".`);
            });
        });
    });
}

// Floating palette of the 16 named preset colors. onPick receives a #RRGGBB.
function showColorPresetMenu(anchor, onPick) {
    document.querySelectorAll('.color-preset-menu').forEach(m => m.remove());
    const menu = document.createElement('div');
    menu.className = 'color-preset-menu';
    for (const [name, val] of GARMIN_COLORS) {
        const hex = '#' + val.toString(16).padStart(6, '0').toUpperCase();
        const sw = document.createElement('button');
        sw.className = 'color-preset-swatch';
        sw.style.background = hex;
        sw.title = `${name} — ${hex}`;
        sw.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.remove();
            onPick(hex);
        });
        menu.appendChild(sw);
    }
    const rect = anchor.getBoundingClientRect();
    menu.style.left = rect.left + 'px';
    menu.style.top  = (rect.bottom + 4) + 'px';
    document.body.appendChild(menu);
    // Dismiss on next outside click.
    setTimeout(() => {
        const close = (e) => {
            if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', close, true); }
        };
        document.addEventListener('mousedown', close, true);
    }, 0);
}

// Scroll the contents panel to the row that corresponds to the given base
// element (trk/rte/wpt) and briefly highlight it. If the panel isn't open,
// this is a no-op.
function scrollContentsToItem(kind, el) {
    if (state.activePanel !== 'contents' || !state.baseXmlDoc || !el) return;
    const idx = [...state.baseXmlDoc.getElementsByTagName(kind)].indexOf(el);
    if (idx === -1) return;
    const row = document.querySelector(`.contents-item[data-kind="${kind}"][data-idx="${idx}"]`);
    if (!row) return;
    row.scrollIntoView({behavior: 'smooth', block: 'center'});
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 1500);
}

function zoomToContentsItem(kind, idx) {
    const doc = state.baseXmlDoc;
    if (!doc) return;
    if (kind === 'trk') {
        const trk = doc.getElementsByTagName('trk')[idx];
        if (!trk) return;
        const pts = collectAllTrkpts(trk).map(p => [
            parseFloat(p.getAttribute('lat')), parseFloat(p.getAttribute('lon'))
        ]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
        if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.15));
    } else if (kind === 'rte') {
        const rte = doc.getElementsByTagName('rte')[idx];
        if (!rte) return;
        const pts = [...rte.getElementsByTagName('rtept')].map(p => [
            parseFloat(p.getAttribute('lat')), parseFloat(p.getAttribute('lon'))
        ]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
        if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.15));
    } else if (kind === 'wpt') {
        const wpt = doc.getElementsByTagName('wpt')[idx];
        if (!wpt) return;
        const lat = parseFloat(wpt.getAttribute('lat'));
        const lon = parseFloat(wpt.getAttribute('lon'));
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
            map.setView([lat, lon], Math.max(map.getZoom(), 15));
            if (state.waypointLayer) {
                state.waypointLayer.eachLayer(m => {
                    if (m._wptEl === wpt) m.openPopup();
                });
            }
        }
    }
}

function removeContentsItem(kind, idx) {
    const doc = state.baseXmlDoc;
    if (!doc) return;
    const el = doc.getElementsByTagName(kind)[idx];
    if (!el) return;
    const name = directChildText(el, 'name') || `(${kind})`;
    if (!confirm(`Remove ${kind} "${name}"?`)) return;
    pushHistory();
    el.parentNode.removeChild(el);
    refreshBaseAfterEdit(`Removed ${kind} "${name}".`);
}

function renameFeature(kind, idx) {
    const doc = state.baseXmlDoc;
    if (!doc) return;
    const el = doc.getElementsByTagName(kind)[idx];
    if (!el) return;
    // Waypoints get the full edit modal (name + sym + color + coords + desc/cmt)
    // instead of a name-only prompt, so users can fix everything from one place.
    if (kind === 'wpt') { editWaypoint(el); return; }
    const current = directChildText(el, 'name');
    const next = prompt(`Rename ${kind}:`, current);
    if (next === null) return;
    const trimmed = next.trim();
    if (trimmed === current) return;
    pushHistory();
    setDirectChild(el, 'name', trimmed);
    refreshBaseAfterEdit(`Renamed to "${trimmed || '(unnamed)'}".`);
}

// ---------- File ingestion & lists ----------
async function ingestFiles(fileList, cache) {
    const added = [];
    for (const file of fileList) {
        try {
            const text = await file.text();
            const xmlDoc = parseGpx(text);
            const trksegs = extractTrksegs(xmlDoc);
            const points = flatten(trksegs);
            cache.set(file.name, {xmlDoc, trksegs, points, size: file.size});
            added.push(file.name);
        } catch (e) {
            console.warn('GPX parse failed:', file.name, e);
            showToast(`Couldn't load "${file.name}": ${e.message}`, 'error', 8000);
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
        row.tabIndex = 0;
        row.dataset.baseName = name;
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
        const renameBtn = document.createElement('button');
        renameBtn.className = 'file-rename';
        renameBtn.textContent = '✎';
        renameBtn.title = 'Rename (changes the filename used on Export)';
        renameBtn.addEventListener('click', (e) => { e.stopPropagation(); renameBaseFile(name); });
        row.appendChild(renameBtn);
        const rm = document.createElement('button');
        rm.className = 'file-remove';
        rm.textContent = '×';
        rm.title = 'Remove from list';
        rm.addEventListener('click', (e) => { e.stopPropagation(); removeBase(name); });
        row.appendChild(rm);
        row.addEventListener('keydown', (e) => rowNavKeydown(e, row, {
            onEnter: () => { radio.checked = true; setActiveBase(name); },
            onDelete: () => removeBase(name),
        }));
        el.appendChild(row);
    }
}

// Rename a GPX in the base cache. Purely cosmetic — only affects the filename
// used when Export downloads the file. No GPX content is changed.
function renameBaseFile(oldName) {
    const suggested = oldName.replace(/\.gpx$/i, '');
    const input = prompt('New filename (used on Export):', suggested);
    if (input === null) return;
    let clean = input.trim();
    if (!clean) return;
    if (!/\.gpx$/i.test(clean)) clean += '.gpx';
    if (clean === oldName) return;
    if (state.baseCache.has(clean)) {
        alert(`A file named "${clean}" is already in the list.`);
        return;
    }
    // Maps have no rename — rebuild preserving order and replace.
    const rebuilt = new Map();
    for (const [k, v] of state.baseCache) {
        rebuilt.set(k === oldName ? clean : k, v);
    }
    state.baseCache = rebuilt;
    if (state.activeBaseName === oldName) {
        state.activeBaseName = clean;
        // Refresh the "Active GPX" line to show the new name.
        const entry = state.baseCache.get(clean);
        const c = baseFeatureCounts(entry.xmlDoc);
        document.getElementById('baseInfo').innerHTML =
            `Active GPX: <b>${clean}</b> — ${c.trksegs} trkseg(s)` +
            (c.rtes ? ` + ${c.rtes} route(s)` : '') +
            `, ${entry.points.length} points`;
    }
    renderBaseList();
    showStatus(`Renamed to "${clean}".`);
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
        row.tabIndex = 0;
        row.dataset.rideName = name;
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
        rm.addEventListener('click', (e) => { e.stopPropagation(); removeRide(name); });
        row.appendChild(rm);
        row.addEventListener('keydown', (e) => rowNavKeydown(e, row, {
            onEnter: () => { cb.checked = !cb.checked; toggleActiveRide(name, cb.checked); },
            onDelete: () => removeRide(name),
        }));
        el.appendChild(row);
    }
}

// Generic ↑/↓/Enter/Delete handler for list rows. Skips when focus is on
// an input/button inside the row.
function rowNavKeydown(e, row, {onEnter, onDelete}) {
    if (e.target !== row) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const rows = [...row.parentNode.children].filter(c => c.tabIndex === 0);
        const idx = rows.indexOf(row);
        const next = rows[idx + (e.key === 'ArrowDown' ? 1 : -1)];
        if (next) next.focus();
        e.preventDefault();
    } else if (e.key === 'Enter' || e.key === ' ') {
        if (onEnter) onEnter();
        e.preventDefault();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (onDelete) onDelete();
        e.preventDefault();
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
        `Active GPX: <b>${name}</b> — ${c.trksegs} trkseg(s)` +
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
    if (state.activePanel === 'contents') renderContentsPanel();
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
        state.baseHistory = [];
        drawBase();               // clears baseLayer + waypointLayer
        document.getElementById('baseInfo').textContent = '';
        renderRideList();
        recompute();
        if (typeof updateUndoButton === 'function') updateUndoButton();
        // Contents panel shows the active base — refresh so it says "Load a base map first."
        if (state.activePanel === 'contents' && typeof renderContentsPanel === 'function') {
            renderContentsPanel();
        }
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

// Simple mode: skip the tools panel and lock the compare panel open. This lets
// simple.html be a stable minimal build while index.html iterates.
const SIMPLE_MODE = document.body.classList.contains('simple-mode');

// Tools panel — floating Leaflet control on the right.
const toolsControl = L.control({position: 'topright'});
toolsControl.onAdd = () => {
    const div = L.DomUtil.create('div', 'tools-panel leaflet-bar');
    div.id = 'toolsPanel';
    div.innerHTML = `
        <button class="tools-collapse-btn" data-action="toggle-tools" title="Show/hide tools" aria-label="Show or hide tools">🛠</button>
        <div class="tools-body">
            <div class="tools-group">
                <button data-panel="contents" title="GPX Contents — list every trk, rte, and wpt in the active GPX (C)" aria-label="Toggle Contents panel (C)">📁 Contents</button>
                <button data-panel="compare"  title="Compare & merge — the ride-classification workflow (V)" aria-label="Toggle Compare panel (V)">🚴 Compare</button>
            </div>
            <div class="tools-separator"></div>
            <div class="tools-group">
                <button data-tool="split"  title="Split — click a track to split it at the click point (S)" aria-label="Split tool (S)">✂ Split</button>
                <button data-tool="merge"  title="Merge — click tracks in order to chain-join them (M)" aria-label="Merge tool (M)">⇆ Merge</button>
                <button data-tool="extend" title="Extend — click a track, then map points to extend it (X)" aria-label="Extend tool (X)">➤ Extend</button>
                <button data-tool="edit"   title="Edit — click a track to reshape it (drag points, drag midpoint ghosts, right-click to delete) (E)" aria-label="Edit tool (E)">✏ Edit</button>
                <button data-tool="draw"   title="Draw — click map points to draw a new track (D)" aria-label="Draw tool (D)">✎ Draw</button>
                <button data-tool="addwpt" title="Add waypoint — click a spot on the map to drop a waypoint (W)" aria-label="Add waypoint (W)">📍 Waypoint</button>
                <button data-action="wptcoords" title="Add waypoint by coordinates — enter a lat/lon pair" aria-label="Add waypoint by coordinates">🧭 Wpt by coords</button>
            </div>
            <div class="tools-separator"></div>
            <div class="tools-group">
                <button data-action="undo"       title="Undo the last change (Ctrl+Z)" aria-label="Undo (Ctrl+Z)" disabled>↶ Undo</button>
                <button data-action="redo"       title="Redo the last undone change (Ctrl+Shift+Z)" aria-label="Redo (Ctrl+Shift+Z)" disabled>↷ Redo</button>
                <button data-action="export"     title="Download the current base as GPX (Ctrl+S)" aria-label="Export current GPX (Ctrl+S)">💾 Export</button>
                <button data-action="fullscreen" title="Toggle fullscreen (F)" aria-label="Toggle fullscreen (F)">⛶ Fullscreen</button>
            </div>
            <div class="tools-separator"></div>
            <button data-tool="done"   title="Finish current tool (Enter)" aria-label="Finish current tool (Enter)" style="display:none">✓ Done</button>
            <button data-tool="cancel" title="Cancel current tool (Esc)" aria-label="Cancel current tool (Esc)" style="display:none">✕ Cancel</button>
        </div>
    `;
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div);
    div.querySelectorAll('button').forEach(b => {
        b.addEventListener('click', () => {
            if (b.dataset.action === 'toggle-tools') return div.classList.toggle('expanded');
            if (b.dataset.action === 'undo')       return undo();
            if (b.dataset.action === 'redo')       return redo();
            if (b.dataset.action === 'export')     return exportBase();
            if (b.dataset.action === 'fullscreen') return toggleFullscreen();
            if (b.dataset.action === 'wptcoords')  return addWaypointByCoords();
            if (b.dataset.panel) return togglePanel(b.dataset.panel);
            const t = b.dataset.tool;
            if (t === 'done')   return commitCurrentTool();
            if (t === 'cancel') return cancelCurrentTool();
            setActiveTool(state.activeTool === t ? null : t);
        });
    });
    return div;
};

if (SIMPLE_MODE) {
    // Force compare panel open and skip the tools panel entirely.
    state.activePanel = 'compare';
    document.body.classList.add('compare-active');
} else {
    toolsControl.addTo(map);
    updatePanelVisibility();
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

// Toggle browser fullscreen — same effect as pressing F11.
function toggleFullscreen() {
    const doc = document;
    const el = doc.documentElement;
    const isFs = doc.fullscreenElement || doc.webkitFullscreenElement || doc.msFullscreenElement;
    if (!isFs) {
        (el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen)?.call(el);
    } else {
        (doc.exitFullscreen || doc.webkitExitFullscreen || doc.msExitFullscreen)?.call(doc);
    }
}
// Keep the tools panel button label in sync with fullscreen state.
document.addEventListener('fullscreenchange', () => {
    const btn = document.querySelector('.tools-panel button[data-action="fullscreen"]');
    if (!btn) return;
    const isFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
    btn.textContent = isFs ? '⛶ Exit fullscreen' : '⛶ Fullscreen';
    btn.classList.toggle('active', isFs);
});

// Settings modal.
{
    const modal = document.getElementById('settingsModal');
    const openBtn = document.getElementById('settingsToggle');
    const closeBtn = modal?.querySelector('.modal-close');
    const backdrop = modal?.querySelector('.modal-backdrop');
    const openModal  = () => { if (modal) modal.removeAttribute('hidden'); if (openBtn) openBtn.classList.add('active'); };
    const closeModal = () => { if (modal) modal.setAttribute('hidden', ''); if (openBtn) openBtn.classList.remove('active'); };
    if (openBtn)  openBtn.addEventListener('click', openModal);
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    if (backdrop) backdrop.addEventListener('click', closeModal);
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal && !modal.hasAttribute('hidden')) {
            closeModal();
            e.stopImmediatePropagation(); // don't also cancel an active tool
        }
    });
}

// Mobile drawer toggle (hamburger button + backdrop).
{
    const btn = document.getElementById('mobileMenuToggle');
    const backdrop = document.getElementById('mobileBackdrop');
    const openDrawer = () => document.body.classList.add('sidebar-open');
    const closeDrawer = () => document.body.classList.remove('sidebar-open');
    if (btn) btn.addEventListener('click', () => {
        document.body.classList.toggle('sidebar-open');
    });
    if (backdrop) backdrop.addEventListener('click', closeDrawer);
    // Auto-close on desktop resize so the drawer state doesn't get stuck open.
    window.addEventListener('resize', () => {
        if (window.innerWidth > 768) closeDrawer();
    });
    // Convenience: hitting Escape closes the drawer.
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && document.body.classList.contains('sidebar-open')) {
            closeDrawer();
            e.stopImmediatePropagation(); // don't also cancel an active tool
        }
    });
    // Tap outside the sidebar (on the map) also closes it on mobile.
    document.getElementById('map').addEventListener('click', () => {
        if (window.innerWidth <= 768) closeDrawer();
    }, true);
}

// Global safety net — any uncaught JS error or rejected promise surfaces as a
// toast so users know something broke instead of the app going silently dead.
window.addEventListener('error', (e) => {
    console.error('Uncaught error:', e.error || e.message);
    if (typeof showToast === 'function') showToast(`Error: ${e.message}`, 'error');
});
window.addEventListener('unhandledrejection', (e) => {
    console.error('Unhandled rejection:', e.reason);
    if (typeof showToast === 'function') showToast(`Error: ${e.reason?.message || e.reason}`, 'error');
});

// Dedicated capture-phase Escape handler — runs before any bubble-phase
// listener (Leaflet markers, form controls, whatever) can swallow the event.
// The settings modal and mobile drawer bubble handlers still get first shot
// via their own stopImmediatePropagation, but if neither is open we cancel
// the active tool immediately.
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const modal = document.getElementById('settingsModal');
    if (modal && !modal.hasAttribute('hidden')) return;
    if (document.body.classList.contains('sidebar-open')) return;
    if (state.activeTool) {
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
            e.target.blur();
        }
        cancelCurrentTool();
        e.preventDefault();
        e.stopPropagation();
    }
}, true);

// ---------- Global hotkeys ----------
window.addEventListener('keydown', (e) => {
    // Escape always fires — even if focus is on a text input — so it can
    // always cancel an active tool. The settings modal and mobile drawer
    // handlers get first crack via stopImmediatePropagation() and short out
    // us via the hidden checks below.
    if (e.key === 'Escape') {
        const modal = document.getElementById('settingsModal');
        if (modal && !modal.hasAttribute('hidden')) return;
        if (document.body.classList.contains('sidebar-open')) return;
        // If a text input has focus, blur it so we don't leave the user typing.
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
            e.target.blur();
        }
        if (state.activeTool) { e.preventDefault(); cancelCurrentTool(); }
        return;
    }

    // Everything else: skip when focus is on an editable field so typing works.
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.altKey || e.metaKey) return;

    if (e.ctrlKey) {
        const k = e.key.toLowerCase();
        if (k === 'z') {
            e.preventDefault();
            if (e.shiftKey) { if (typeof redo === 'function') redo(); }
            else            { if (typeof undo === 'function') undo(); }
            return;
        }
        if (k === 'y') { e.preventDefault(); if (typeof redo === 'function') redo(); return; }
        if (k === 's') { e.preventDefault(); if (typeof exportBase === 'function') exportBase(); return; }
        return;
    }
    if (e.key === 'Enter') {
        if (state.activeTool && (state.activeTool === 'draw' || state.activeTool === 'extend' ||
            state.activeTool === 'edit' || state.activeTool === 'merge')) {
            e.preventDefault(); commitCurrentTool();
        }
        return;
    }

    // Bare single-letter shortcuts. Toggle the same tool off if pressed again.
    const key = e.key.toLowerCase();
    const toggleTool = t => setActiveTool(state.activeTool === t ? null : t);
    switch (key) {
        case 's': e.preventDefault(); toggleTool('split');  break;
        case 'm': e.preventDefault(); toggleTool('merge');  break;
        case 'x': e.preventDefault(); toggleTool('extend'); break;
        case 'e': e.preventDefault(); toggleTool('edit');   break;
        case 'd': e.preventDefault(); toggleTool('draw');   break;
        case 'w': e.preventDefault(); toggleTool('addwpt'); break;
        case 'c': e.preventDefault(); if (typeof togglePanel === 'function') togglePanel('contents'); break;
        case 'v': e.preventDefault(); if (typeof togglePanel === 'function') togglePanel('compare');  break;
        case 'f': e.preventDefault(); toggleFullscreen(); break;
        case '?': {
            e.preventDefault();
            const modal = document.getElementById('settingsModal');
            const settingsBtn = document.getElementById('settingsToggle');
            if (modal) {
                modal.removeAttribute('hidden');
                if (settingsBtn) settingsBtn.classList.add('active');
            }
            break;
        }
    }
});

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
document.getElementById('download').addEventListener('click', mergeIntoBase);

renderSegList();
renderMergedHistory();
