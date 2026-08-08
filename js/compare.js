// ---------- compare.js ----------
// Ride-vs-base comparison workflow: relevance detection, segment classification
// (novel vs duplicate), user splits, segment list UI, stats, merge output,
// merged-history persistence, and export.

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
            // Make the row keyboard-focusable so arrow keys / Delete / typing work.
            row.tabIndex = 0;

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
                row.focus();
                snapToSegment(seg.id);
            });
            row.addEventListener('focus', () => {
                snapToSegment(seg.id);
            });

            row.addEventListener('keydown', (e) => {
                // Don't intercept typing inside the name input — let it work normally.
                if (e.target === nameInput) {
                    // But Escape / arrow keys still move focus.
                    if (e.key === 'Escape') { nameInput.blur(); row.focus(); e.preventDefault(); return; }
                    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                        nameInput.blur(); row.focus();
                        moveSegmentFocus(row, e.key === 'ArrowDown' ? 1 : -1);
                        e.preventDefault();
                    }
                    return;
                }
                if (e.key === 'ArrowDown') { moveSegmentFocus(row, 1); e.preventDefault(); }
                else if (e.key === 'ArrowUp')   { moveSegmentFocus(row, -1); e.preventDefault(); }
                else if (e.key === 'Delete' || e.key === 'Backspace') {
                    // Toggle include off. toggleSegment re-renders the list,
                    // which destroys this row — refocus the replacement.
                    const segId = seg.id;
                    toggleSegment(segId, false);
                    refocusSegmentRow(segId);
                    e.preventDefault();
                }
                else if (e.key === ' ' || e.key === 'Enter') {
                    const segId = seg.id;
                    toggleSegment(segId, !seg.included);
                    refocusSegmentRow(segId);
                    e.preventDefault();
                }
                else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                    // Any printable key: focus the name input so typing renames.
                    nameInput.focus();
                    nameInput.value += e.key;
                    seg.name = nameInput.value.trim() || null;
                    e.preventDefault();
                }
            });
            el.appendChild(row);
        }
    }
}

function moveSegmentFocus(currentRow, dir) {
    const rows = [...document.querySelectorAll('#segList .seg-item')];
    const idx = rows.indexOf(currentRow);
    if (idx === -1) return;
    const next = rows[idx + dir];
    if (next) next.focus();
}

// After a re-render (renderSegList destroys and rebuilds every row), find the
// row matching segId and put focus back on it. Keeps keyboard-nav continuous
// through toggles.
function refocusSegmentRow(segId) {
    const row = document.querySelector(`#segList .seg-item[data-seg-id="${segId}"]`);
    if (row) row.focus({preventScroll: true});
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

// Merge selected ride segments into the active base in-memory. No download —
// use exportBase() when you're ready to save to disk. Removes the source rides
// and logs them to history.
function mergeIntoBase() {
    const included = state.segments.filter(s => s.included);
    if (!included.length || !state.activeBaseName) return;
    pushHistory();
    const usedRides = new Set(included.map(s => s.rideName));
    const xml = buildMergedXml();

    const newDoc = parseGpx(xml);
    const newTrksegs = extractTrksegs(newDoc);
    const newPoints = extractBasePoints(newDoc);
    const blob = new Blob([xml], {type: 'application/gpx+xml'});
    state.baseCache.set(state.activeBaseName, {
        xmlDoc: newDoc, trksegs: newTrksegs, points: newPoints, size: blob.size,
    });
    state.baseXmlDoc = newDoc;
    state.basePoints = newPoints;

    // Log and remove the rides that contributed segments.
    const mergedAt = new Date().toISOString();
    for (const name of usedRides) {
        state.rideCache.delete(name);
        state.activeRideNames.delete(name);
        state.rideRelevance.delete(name);
        state.userSplits.delete(name);
        state.mergedHistory = state.mergedHistory.filter(e => e.name !== name);
        state.mergedHistory.push({name, mergedAt});
    }
    saveMergedHistory();
    renderMergedHistory();

    drawBase();
    buildRelevanceGrid();
    computeAllRelevance();
    const cc = baseFeatureCounts(newDoc);
    document.getElementById('baseInfo').innerHTML =
        `Active GPX: <b>${state.activeBaseName}</b> — ${cc.trksegs} trkseg(s)` +
        (cc.rtes ? ` + ${cc.rtes} route(s)` : '') +
        `, ${newPoints.length} points`;
    renderBaseList();
    renderRideList();
    updateRideInfo();
    recompute();
    if (state.activePanel === 'contents') renderContentsPanel();

    const total = fmtLongDist(included.reduce((s, r) => s + r.distance, 0));
    if (SIMPLE_MODE) {
        // Simple mode has no separate Export tool — auto-download after merge.
        exportBase();
        showStatus(`Merged ${total} from ${usedRides.size} ride${usedRides.size === 1 ? '' : 's'} and downloaded.`);
    } else {
        showStatus(`Merged ${total} from ${usedRides.size} ride${usedRides.size === 1 ? '' : 's'} into base. Use Export to save.`);
    }
}

// Download the current active base as GPX using its filename.
function exportBase() {
    if (!state.baseXmlDoc || !state.activeBaseName) {
        alert('No active base loaded.');
        return;
    }
    const xml = new XMLSerializer().serializeToString(state.baseXmlDoc);
    const blob = new Blob([xml], {type: 'application/gpx+xml'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = state.activeBaseName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showStatus(`Exported "${state.activeBaseName}".`);
}

function recompute() {
    classifyAll();
    drawRide();
    renderSegList();
    updateStats();
}
