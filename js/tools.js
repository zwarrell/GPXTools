// ---------- tools.js ----------
// Map tools (split/merge/extend/draw/waypoint), the undo stack, and the shared
// refreshBaseAfterEdit pipeline. Also owns the merge queue, base-track split,
// blank-GPX bootstrap, and the map-level click/mousemove handlers that drive
// the active tool.

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
    setActiveTool(on ? 'merge' : null);
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

// Attach an incoming track to an existing track WITHOUT trimming the existing
// one. Finds which of existing's two endpoints is closer to any point on
// incoming, then attaches incoming there — keeping the portion of incoming
// that extends away from existing. This preserves the first track's endpoints
// so the user's "primary" line isn't mutated by the merge.
function attachTrack(existing, incoming) {
    if (!existing.length) return incoming.slice();
    if (!incoming.length) return existing.slice();
    const startLL = ptLatLng(existing[0]);
    const endLL   = ptLatLng(existing[existing.length - 1]);
    let iEndJ = 0, iEndDist = Infinity;
    let iStartJ = 0, iStartDist = Infinity;
    for (let j = 0; j < incoming.length; j++) {
        const p = ptLatLng(incoming[j]);
        const de = haversineMeters(endLL.lat,   endLL.lon,   p.lat, p.lon);
        const ds = haversineMeters(startLL.lat, startLL.lon, p.lat, p.lon);
        if (de < iEndDist)   { iEndDist   = de; iEndJ   = j; }
        if (ds < iStartDist) { iStartDist = ds; iStartJ = j; }
    }
    const attachAtEnd = iEndDist <= iStartDist;
    const attachIdx   = attachAtEnd ? iEndJ : iStartJ;
    // Keep the longer of incoming's two halves split by the attach point.
    // If the longer half is on the "before" side, reverse it so attachIdx
    // ends up as its first point.
    const before = incoming.slice(0, attachIdx + 1);
    const after  = incoming.slice(attachIdx);
    const incomingKept = after.length >= before.length ? after : before.slice().reverse();
    // Concat with existing intact. Drop the join copy only if it's within a
    // meter of existing's endpoint (same physical spot).
    const [joinLat, joinLon] = [
        parseFloat(incomingKept[0].getAttribute('lat')),
        parseFloat(incomingKept[0].getAttribute('lon')),
    ];
    const anchorLL = attachAtEnd ? endLL : startLL;
    const overlap = haversineMeters(anchorLL.lat, anchorLL.lon, joinLat, joinLon) < 1;
    const tail = overlap ? incomingKept.slice(1) : incomingKept;
    if (attachAtEnd) return existing.concat(tail);
    return tail.slice().reverse().concat(existing);
}

// Chain merge: keep the first selected track fully intact, then extend it
// with each subsequent track via attachTrack.
function chainClosestMerge(arrays) {
    if (!arrays.length) return [];
    let result = arrays[0].slice();
    for (let i = 1; i < arrays.length; i++) {
        result = attachTrack(result, arrays[i]);
    }
    return result;
}

function performMultiMerge(selections, newName) {
    const doc = state.baseXmlDoc;
    const arrays = selections.map(pointsForSelection).filter(a => a.length > 0);
    if (arrays.length < 2) { alert('Not enough valid tracks to merge.'); return; }
    pushHistory();
    const merged = chainClosestMerge(arrays);

    const trk = doc.createElementNS(GPX_NS, 'trk');
    const nameEl = doc.createElementNS(GPX_NS, 'name');
    nameEl.textContent = newName;
    trk.appendChild(nameEl);
    const trkseg = doc.createElementNS(GPX_NS, 'trkseg');
    for (const pt of merged) trkseg.appendChild(pt.cloneNode(true));
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

    const pieces = selections.map(s => `"${s.name}"`).join(' + ');
    refreshBaseAfterEdit(`Merged ${pieces} into "${newName}".`);
}

// Find the smallest N such that "{base} (part N)" is not already the name of
// an existing base track. Base tracks named exactly {base} count as N=1.
function nextPartNumber(base) {
    if (!state.baseXmlDoc) return 1;
    const trks = [...state.baseXmlDoc.getElementsByTagName('trk')];
    const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${escapedBase}\\s*\\(part (\\d+)\\)\\s*$`);
    let max = 0;
    let sawBareBase = false;
    for (const trk of trks) {
        const name = directChildText(trk, 'name');
        const m = name.match(re);
        if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; }
        if (name === base) sawBareBase = true;
    }
    if (sawBareBase && max < 1) max = 1;
    return max + 1;
}

// Split a base track (identified by its <trk> element) at the point closest to
// the click. Names respect any existing "(part N)" suffix — the second half
// gets the next unused part number for that base name.
function splitBaseTrackAt(trkEl, latlng) {
    const doc = state.baseXmlDoc;
    const allPts = collectAllTrkpts(trkEl);
    if (allPts.length < 4) { alert('Track too short to split.'); return; }
    let bestIdx = -1, bestDist = Infinity;
    for (let i = 0; i < allPts.length; i++) {
        const p = allPts[i];
        const lat = parseFloat(p.getAttribute('lat'));
        const lon = parseFloat(p.getAttribute('lon'));
        const d = haversineMeters(latlng.lat, latlng.lng, lat, lon);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    if (bestIdx < 2 || bestIdx > allPts.length - 3) {
        alert('Too close to an endpoint to split.');
        return;
    }
    pushHistory();
    let origName = 'Track';
    for (const child of trkEl.children) {
        if (child.localName === 'name') {
            const t = (child.textContent || '').trim();
            if (t) origName = t;
            break;
        }
    }
    const buildTrk = (pts, name) => {
        const trk = doc.createElementNS(GPX_NS, 'trk');
        const nameEl = doc.createElementNS(GPX_NS, 'name');
        nameEl.textContent = name;
        trk.appendChild(nameEl);
        const trkseg = doc.createElementNS(GPX_NS, 'trkseg');
        for (const pt of pts) trkseg.appendChild(pt.cloneNode(true));
        trk.appendChild(trkseg);
        return trk;
    };
    // If the original name already ends with "(part N)", keep the first half's
    // name intact and give the second half the next unused part number for
    // that base name. Otherwise start with "(part 1)" and "(part 2)".
    const partMatch = origName.match(/^(.*?)\s*\(part (\d+)\)\s*$/);
    let name1, name2;
    if (partMatch) {
        const base = partMatch[1];
        name1 = origName;
        name2 = `${base} (part ${nextPartNumber(base)})`;
    } else {
        name1 = `${origName} (part 1)`;
        name2 = `${origName} (part 2)`;
    }
    // Share the split point in both halves so they visually connect.
    const trk1 = buildTrk(allPts.slice(0, bestIdx + 1), name1);
    const trk2 = buildTrk(allPts.slice(bestIdx), name2);
    trkEl.parentNode.insertBefore(trk1, trkEl);
    trkEl.parentNode.insertBefore(trk2, trkEl);
    trkEl.parentNode.removeChild(trkEl);
    refreshBaseAfterEdit(`Split "${origName}" into 2 tracks.`);
}

// Create a brand-new empty GPX doc in-memory and activate it. Used when the
// user starts drawing/waypointing without loading a file first.
function createBlankGpx() {
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<gpx version="1.1" creator="GPXTools" xmlns="http://www.topografix.com/GPX/1/1"></gpx>\n';
    const doc = parseGpx(xml);
    const name = 'Untitled.gpx';
    state.baseCache.set(name, {
        xmlDoc: doc,
        trksegs: [],
        points: [],
        size: xml.length,
    });
    setActiveBase(name);
    return doc;
}

// Snapshot the current base XML so it can be restored later by Undo. Called
// by every base-modifying operation. New mutations invalidate any pending
// redo history — that's why we clear the redo stack here.
function pushHistory() {
    if (!state.baseXmlDoc) return;
    state.baseHistory.push(new XMLSerializer().serializeToString(state.baseXmlDoc));
    if (state.baseHistory.length > UNDO_MAX) state.baseHistory.shift();
    state.baseRedoStack = [];
    updateUndoButton();
}

// Restore a snapshot popped by undo() or redo() into the live app state.
function applyBaseSnapshot(xml) {
    const newDoc = parseGpx(xml);
    state.baseXmlDoc = newDoc;
    const entry = state.baseCache.get(state.activeBaseName);
    if (entry) {
        entry.xmlDoc = newDoc;
        entry.trksegs = extractTrksegs(newDoc);
        entry.points = extractBasePoints(newDoc);
        entry.size = new Blob([xml]).size;
    }
    state.basePoints = extractBasePoints(newDoc);
    const c = baseFeatureCounts(newDoc);
    document.getElementById('baseInfo').innerHTML =
        `Active GPX: <b>${state.activeBaseName}</b> — ${c.trksegs} trkseg(s)` +
        (c.rtes ? ` + ${c.rtes} route(s)` : '') +
        `, ${state.basePoints.length} points`;
    drawBase();
    buildRelevanceGrid();
    computeAllRelevance();
    renderBaseList();
    renderRideList();
    recompute();
    if (state.activePanel === 'contents') renderContentsPanel();
}

function undo() {
    // If we're in the middle of a tool that snapshots its buffer, unwind that
    // first. Only pops entries belonging to the current tool.
    const top = state.toolHistory[state.toolHistory.length - 1];
    if (top && top.tool === state.activeTool) {
        // Save current buffer for redo before restoring.
        const currentSnap =
            top.tool === 'draw'   ? state.drawPoints.map(p => ({...p})) :
            top.tool === 'extend' ? state.extendNewPoints.map(p => ({...p})) :
            top.tool === 'edit'   ? state.editPoints.slice() : null;
        state.toolRedoStack.push({tool: top.tool, snap: currentSnap});
        state.toolHistory.pop();
        if (top.tool === 'draw')   { state.drawPoints = top.snap;      updateDrawPreview(); }
        if (top.tool === 'extend') { state.extendNewPoints = top.snap; updateExtendPreview(); }
        if (top.tool === 'edit')   { state.editPoints = top.snap;      updateEditPreview(); }
        updateUndoButton();
        return;
    }

    if (!state.baseHistory.length) return;
    // Save current XML for redo, then pop and restore.
    state.baseRedoStack.push(new XMLSerializer().serializeToString(state.baseXmlDoc));
    const xml = state.baseHistory.pop();
    applyBaseSnapshot(xml);
    updateUndoButton();
    showStatus('Undid last change.');
}

function redo() {
    // Prefer in-tool redo if it belongs to the current tool.
    const topR = state.toolRedoStack[state.toolRedoStack.length - 1];
    if (topR && topR.tool === state.activeTool) {
        const currentSnap =
            topR.tool === 'draw'   ? state.drawPoints.map(p => ({...p})) :
            topR.tool === 'extend' ? state.extendNewPoints.map(p => ({...p})) :
            topR.tool === 'edit'   ? state.editPoints.slice() : null;
        state.toolHistory.push({tool: topR.tool, snap: currentSnap});
        state.toolRedoStack.pop();
        if (topR.tool === 'draw')   { state.drawPoints = topR.snap;      updateDrawPreview(); }
        if (topR.tool === 'extend') { state.extendNewPoints = topR.snap; updateExtendPreview(); }
        if (topR.tool === 'edit')   { state.editPoints = topR.snap;      updateEditPreview(); }
        updateUndoButton();
        return;
    }
    if (!state.baseRedoStack.length) return;
    state.baseHistory.push(new XMLSerializer().serializeToString(state.baseXmlDoc));
    const xml = state.baseRedoStack.pop();
    applyBaseSnapshot(xml);
    updateUndoButton();
    showStatus('Redid last change.');
}

function updateUndoButton() {
    const undoBtn = document.querySelector('.tools-panel button[data-action="undo"]');
    const redoBtn = document.querySelector('.tools-panel button[data-action="redo"]');
    const top = state.toolHistory[state.toolHistory.length - 1];
    const inTool = top && top.tool === state.activeTool;
    const topR = state.toolRedoStack[state.toolRedoStack.length - 1];
    const inToolRedo = topR && topR.tool === state.activeTool;

    if (undoBtn) {
        const canUndo = inTool || state.baseHistory.length > 0;
        undoBtn.disabled = !canUndo;
        if (inTool) {
            let n = 0;
            for (let i = state.toolHistory.length - 1; i >= 0; i--) {
                if (state.toolHistory[i].tool === state.activeTool) n++;
                else break;
            }
            undoBtn.textContent = `↶ Undo (${n})`;
        } else if (state.baseHistory.length) {
            undoBtn.textContent = `↶ Undo (${state.baseHistory.length})`;
        } else {
            undoBtn.textContent = '↶ Undo';
        }
    }
    if (redoBtn) {
        const canRedo = inToolRedo || state.baseRedoStack.length > 0;
        redoBtn.disabled = !canRedo;
        if (inToolRedo) {
            let n = 0;
            for (let i = state.toolRedoStack.length - 1; i >= 0; i--) {
                if (state.toolRedoStack[i].tool === state.activeTool) n++;
                else break;
            }
            redoBtn.textContent = `↷ Redo (${n})`;
        } else if (state.baseRedoStack.length) {
            redoBtn.textContent = `↷ Redo (${state.baseRedoStack.length})`;
        } else {
            redoBtn.textContent = '↷ Redo';
        }
    }
}

// Shared cleanup after any structural change to the active base XML.
function refreshBaseAfterEdit(statusMsg) {
    const doc = state.baseXmlDoc;
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
        `Active GPX: <b>${state.activeBaseName}</b> — ${c.trksegs} trkseg(s)` +
        (c.rtes ? ` + ${c.rtes} route(s)` : '') +
        `, ${state.basePoints.length} points`;
    drawBase();
    buildRelevanceGrid();
    computeAllRelevance();
    renderBaseList();
    renderRideList();
    recompute();
    if (state.activePanel === 'contents') renderContentsPanel();
    if (statusMsg) showStatus(statusMsg);
}

// ---------- Tools panel + Extend/Draw ----------
function setActiveTool(tool) {
    // Exit whatever tool is active.
    if (state.activeTool === 'merge')  { state.mergeSelection = []; }
    if (state.activeTool === 'extend') { state.extendTarget = null; state.extendNewPoints = []; }
    if (state.activeTool === 'draw')   { state.drawPoints = []; }
    if (state.activeTool === 'edit')   { state.editTarget = null; state.editPoints = []; }
    // Any in-tool history is discarded when the tool changes.
    state.toolHistory = [];
    state.toolRedoStack = [];
    clearPreview();
    hideGhostPoint();

    state.activeTool = tool;

    // Button + cursor state.
    const panel = document.getElementById('toolsPanel');
    if (panel) {
        panel.querySelectorAll('button[data-tool]').forEach(b => {
            b.classList.toggle('active', b.dataset.tool === tool);
        });
        const doneBtn = panel.querySelector('button[data-tool="done"]');
        const cancelBtn = panel.querySelector('button[data-tool="cancel"]');
        const show = tool === 'extend' || tool === 'draw' || tool === 'merge' || tool === 'edit';
        if (doneBtn) doneBtn.style.display = show ? '' : 'none';
        if (cancelBtn) cancelBtn.style.display = show ? '' : 'none';
    }
    const m = document.getElementById('map');
    m.classList.remove('split-mode', 'merge-mode', 'extend-mode', 'draw-mode', 'edit-mode');
    if (tool) m.classList.add(`${tool}-mode`);

    // Show/hide the merge queue.
    renderMergeQueue();
    drawBase();
    drawRide();
    updateUndoButton();

    // Hint text.
    const hint = document.getElementById('mergeTracksHint');
    if (hint && tool !== 'merge') {
        if (tool === 'extend') {
            hint.innerHTML = state.extendTarget
                ? '<div class="hint">Click on the map to add points. Click Done in the tools panel when finished.</div>'
                : '<div class="hint">Click a base track to select which end to extend.</div>';
        } else if (tool === 'draw') {
            hint.innerHTML = '<div class="hint">Click on the map to add points. Click Done in the tools panel when finished.</div>';
        } else if (tool === 'split') {
            hint.innerHTML = '<div class="hint">Click on a base track or new segment to split it there.</div>';
        } else if (tool === 'edit') {
            hint.innerHTML = state.editTarget
                ? `<div class="hint">Editing <b>${state.editTarget.name}</b>. Drag points, drag midpoint ghosts to insert, right-click a point to delete.</div>`
                : '<div class="hint">Click a base track to edit it.</div>';
        } else {
            hint.innerHTML = '';
        }
    }
}

function commitCurrentTool() {
    if (state.activeTool === 'merge') return finishMergeQueue();
    if (state.activeTool === 'extend') return finishExtend();
    if (state.activeTool === 'draw') return finishDraw();
    if (state.activeTool === 'edit') return finishEdit();
}

function cancelCurrentTool() { setActiveTool(null); }

// Preview overlay used by Extend / Draw.
function clearPreview() {
    if (state.previewLayer) {
        map.removeLayer(state.previewLayer);
        state.previewLayer = null;
    }
}

function draggablePointMarker(latlng, onDrag, onStart, onEnd) {
    const m = L.marker(latlng, {
        icon: L.divIcon({className: 'draw-point-marker', iconSize: [14, 14]}),
        draggable: true,
        keyboard: false,
    });
    if (onStart) m.on('dragstart', onStart);
    m.on('drag', onDrag);
    if (onEnd)   m.on('dragend',   onEnd);
    return m;
}

// Snapshot the point buffer for the current tool so undo can restore it.
// Called immediately BEFORE any modification (add/drag/insert/delete).
function snapshotToolState() {
    const t = state.activeTool;
    if (t === 'draw')   state.toolHistory.push({tool: 'draw',   snap: state.drawPoints.map(p => ({...p}))});
    else if (t === 'extend') state.toolHistory.push({tool: 'extend', snap: state.extendNewPoints.map(p => ({...p}))});
    else if (t === 'edit')   state.toolHistory.push({tool: 'edit',   snap: state.editPoints.slice()});
    // A fresh in-tool action invalidates any pending in-tool redo.
    state.toolRedoStack = state.toolRedoStack.filter(x => x.tool !== t);
    updateUndoButton();
}

// Half-opacity "ghost" handle at the midpoint of each segment. On dragstart
// we insert a real point at that slot (via onStart), then let Leaflet's drag
// keep control of the marker for the rest of the gesture — onDrag(latlng)
// gets the live position (used to update the polyline) and onEnd(latlng) is
// called once when the user releases (used to snap + re-render fresh ghosts).
function midpointGhostMarker(latlng, {onStart, onDrag, onEnd}) {
    const m = L.marker(latlng, {
        icon: L.divIcon({className: 'draw-point-marker draw-point-ghost', iconSize: [12, 12]}),
        draggable: true,
        keyboard: false,
    });
    m.on('dragstart', () => {
        // Promote visually — swap ghost class off so it looks like a real point.
        const el = m.getElement();
        if (el) el.classList.remove('draw-point-ghost');
        if (onStart) onStart();
    });
    m.on('drag', (e) => { if (onDrag) onDrag(e.latlng); });
    m.on('dragend', (e) => { if (onEnd) onEnd(e.target.getLatLng()); });
    return m;
}

function updateExtendPreview() {
    clearPreview();
    if (!state.extendTarget) return;
    const {trkEl, appendAt} = state.extendTarget;
    const existing = collectAllTrkpts(trkEl).map(p => [
        parseFloat(p.getAttribute('lat')),
        parseFloat(p.getAttribute('lon')),
    ]);
    const newPts = state.extendNewPoints.map(p => [p.lat, p.lon]);
    const line = L.polyline(newPts, {color: '#22c55e', weight: 4, opacity: 0.95, interactive: false});
    const bridge = appendAt === 'end'
        ? (newPts.length ? [existing[existing.length - 1], newPts[0]] : null)
        : (newPts.length ? [existing[0], newPts[0]] : null);
    const layers = [
        L.polyline(existing, {color: '#e63946', weight: 5, opacity: 0.7, dashArray: '4 4', interactive: false}),
        line,
    ];
    if (bridge) {
        layers.push(L.polyline(bridge, {color: '#22c55e', weight: 2, opacity: 0.5, dashArray: '2 4', interactive: false}));
    }
    state.extendNewPoints.forEach((p, i) => {
        const m = draggablePointMarker([p.lat, p.lon],
            (e) => {
                const snap = findSnap(e.latlng);
                if (snap) { m.setLatLng(snap); state.extendNewPoints[i] = {lat: snap.lat, lon: snap.lng}; }
                else state.extendNewPoints[i] = {lat: e.latlng.lat, lon: e.latlng.lng};
                line.setLatLngs(state.extendNewPoints.map(pp => [pp.lat, pp.lon]));
            },
            () => snapshotToolState(),
            () => { updateExtendPreview(); updateUndoButton(); }
        );
        layers.push(m);
    });
    // Midpoint ghost handles between each pair of adjacent new points.
    for (let i = 0; i < state.extendNewPoints.length - 1; i++) {
        const a = state.extendNewPoints[i], b = state.extendNewPoints[i + 1];
        const mid = [(a.lat + b.lat) / 2, (a.lon + b.lon) / 2];
        let insertedAt = null;
        layers.push(midpointGhostMarker(mid, {
            onStart: () => {
                snapshotToolState();
                insertedAt = i + 1;
                state.extendNewPoints.splice(insertedAt, 0, {lat: mid[0], lon: mid[1]});
            },
            onDrag: (latlng) => {
                state.extendNewPoints[insertedAt] = {lat: latlng.lat, lon: latlng.lng};
                line.setLatLngs(state.extendNewPoints.map(pp => [pp.lat, pp.lon]));
            },
            onEnd: (latlng) => {
                const snap = findSnap(latlng);
                const p = snap ? {lat: snap.lat, lon: snap.lng} : {lat: latlng.lat, lon: latlng.lng};
                state.extendNewPoints[insertedAt] = p;
                updateExtendPreview();
                updateUndoButton();
            },
        }));
    }
    state.previewLayer = L.layerGroup(layers).addTo(map);
}

function updateDrawPreview() {
    clearPreview();
    if (!state.drawPoints.length) return;
    const line = L.polyline(
        state.drawPoints.map(p => [p.lat, p.lon]),
        {color: '#22c55e', weight: 4, opacity: 0.95, interactive: false}
    );
    const layers = [line];
    state.drawPoints.forEach((p, i) => {
        const m = draggablePointMarker([p.lat, p.lon],
            (e) => {
                const snap = findSnap(e.latlng);
                if (snap) { m.setLatLng(snap); state.drawPoints[i] = {lat: snap.lat, lon: snap.lng}; }
                else state.drawPoints[i] = {lat: e.latlng.lat, lon: e.latlng.lng};
                line.setLatLngs(state.drawPoints.map(pp => [pp.lat, pp.lon]));
            },
            () => snapshotToolState(),
            () => { updateDrawPreview(); updateUndoButton(); }
        );
        layers.push(m);
    });
    // Midpoint ghost handles between each pair of adjacent points. Dragging
    // one inserts a real point at that slot.
    for (let i = 0; i < state.drawPoints.length - 1; i++) {
        const a = state.drawPoints[i], b = state.drawPoints[i + 1];
        const mid = [(a.lat + b.lat) / 2, (a.lon + b.lon) / 2];
        let insertedAt = null;
        layers.push(midpointGhostMarker(mid, {
            onStart: () => {
                snapshotToolState();
                insertedAt = i + 1;
                state.drawPoints.splice(insertedAt, 0, {lat: mid[0], lon: mid[1]});
            },
            onDrag: (latlng) => {
                state.drawPoints[insertedAt] = {lat: latlng.lat, lon: latlng.lng};
                line.setLatLngs(state.drawPoints.map(pp => [pp.lat, pp.lon]));
            },
            onEnd: (latlng) => {
                const snap = findSnap(latlng);
                const p = snap ? {lat: snap.lat, lon: snap.lng} : {lat: latlng.lat, lon: latlng.lng};
                state.drawPoints[insertedAt] = p;
                updateDrawPreview();
                updateUndoButton();
            },
        }));
    }
    state.previewLayer = L.layerGroup(layers).addTo(map);
}

// ---------- Edit-existing-track tool ----------
function handleEditBaseClick(line) {
    if (state.editTarget) return;
    const pts = collectAllTrkpts(line._trkEl).map(p => ({
        lat: parseFloat(p.getAttribute('lat')),
        lon: parseFloat(p.getAttribute('lon')),
        raw: p.cloneNode(true),
    })).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));
    if (pts.length < 2) return;
    state.editTarget = {trkEl: line._trkEl, name: line._trkName};
    state.editPoints = pts;
    drawBase(); // hide the original polyline for this trk
    updateEditPreview();
    const hint = document.getElementById('mergeTracksHint');
    if (hint) hint.innerHTML =
        `<div class="hint">Editing <b>${line._trkName}</b>. Drag points, drag midpoint ghosts to insert, right-click a point to delete. Click Done when finished.</div>`;
}

function updateEditPreview() {
    clearPreview();
    if (!state.editTarget) return;
    const line = L.polyline(
        state.editPoints.map(p => [p.lat, p.lon]),
        {color: '#e63946', weight: 5, opacity: 0.9, interactive: false}
    );
    const layers = [line];
    state.editPoints.forEach((p, i) => {
        const m = draggablePointMarker([p.lat, p.lon],
            (e) => {
                const snap = findSnap(e.latlng);
                const target = snap ? {lat: snap.lat, lng: snap.lng} : e.latlng;
                if (snap) m.setLatLng(snap);
                state.editPoints[i] = {...state.editPoints[i], lat: target.lat, lon: target.lng};
                line.setLatLngs(state.editPoints.map(pp => [pp.lat, pp.lon]));
            },
            () => snapshotToolState(),
            () => { updateEditPreview(); updateUndoButton(); }
        );
        // Right-click / long-press: delete this point.
        m.on('contextmenu', (e) => {
            L.DomEvent.stop(e);
            if (state.editPoints.length <= 2) return;
            snapshotToolState();
            state.editPoints.splice(i, 1);
            updateEditPreview();
        });
        layers.push(m);
    });
    for (let i = 0; i < state.editPoints.length - 1; i++) {
        const a = state.editPoints[i], b = state.editPoints[i + 1];
        const mid = [(a.lat + b.lat) / 2, (a.lon + b.lon) / 2];
        let insertedAt = null;
        layers.push(midpointGhostMarker(mid, {
            onStart: () => {
                snapshotToolState();
                insertedAt = i + 1;
                state.editPoints.splice(insertedAt, 0, {lat: mid[0], lon: mid[1]});
            },
            onDrag: (latlng) => {
                state.editPoints[insertedAt] = {...state.editPoints[insertedAt], lat: latlng.lat, lon: latlng.lng};
                line.setLatLngs(state.editPoints.map(pp => [pp.lat, pp.lon]));
            },
            onEnd: (latlng) => {
                const snap = findSnap(latlng);
                const p = snap ? {lat: snap.lat, lon: snap.lng} : {lat: latlng.lat, lon: latlng.lng};
                state.editPoints[insertedAt] = {...state.editPoints[insertedAt], lat: p.lat, lon: p.lon};
                updateEditPreview();
                updateUndoButton();
            },
        }));
    }
    state.previewLayer = L.layerGroup(layers).addTo(map);
}

function finishEdit() {
    if (!state.editTarget || state.editPoints.length < 2) { setActiveTool(null); return; }
    pushHistory();
    const doc = state.baseXmlDoc;
    const {trkEl, name} = state.editTarget;
    // Wipe the trk's existing trksegs and replace with one containing the edited points.
    for (const seg of [...trkEl.getElementsByTagName('trkseg')]) {
        seg.parentNode.removeChild(seg);
    }
    const trkseg = doc.createElementNS(GPX_NS, 'trkseg');
    for (const p of state.editPoints) {
        const pt = doc.createElementNS(GPX_NS, 'trkpt');
        pt.setAttribute('lat', p.lat.toFixed(7));
        pt.setAttribute('lon', p.lon.toFixed(7));
        // Preserve any children (ele, time, extensions) from the original point when available.
        if (p.raw) {
            for (const child of p.raw.children) pt.appendChild(child.cloneNode(true));
        }
        trkseg.appendChild(pt);
    }
    trkEl.appendChild(trkseg);
    refreshBaseAfterEdit(`Edited "${name}".`);
    setActiveTool(null);
}

function handleExtendBaseClick(line, latlng) {
    if (state.extendTarget) return; // already have a target
    const allPts = collectAllTrkpts(line._trkEl);
    if (!allPts.length) return;
    // Find the point in the track physically closest to the click. Extend
    // from whichever endpoint that closest point is nearer to (in the track's
    // point sequence, not by time).
    let bestIdx = 0, bestDist = Infinity;
    for (let i = 0; i < allPts.length; i++) {
        const d = haversineMeters(
            latlng.lat, latlng.lng,
            parseFloat(allPts[i].getAttribute('lat')),
            parseFloat(allPts[i].getAttribute('lon')));
        if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    const appendAt = bestIdx < allPts.length / 2 ? 'start' : 'end';
    state.extendTarget = {trkEl: line._trkEl, appendAt};
    updateExtendPreview();
    const hint = document.getElementById('mergeTracksHint');
    if (hint) hint.innerHTML =
        `<div class="hint">Extending <b>${line._trkName}</b> from its ${appendAt}. Click the map to add points.</div>`;
}

function finishExtend() {
    if (!state.extendTarget) { setActiveTool(null); return; }
    if (!state.extendNewPoints.length) { setActiveTool(null); return; }
    pushHistory();
    const doc = state.baseXmlDoc;
    const {trkEl, appendAt} = state.extendTarget;
    const trksegs = trkEl.getElementsByTagName('trkseg');
    if (!trksegs.length) { setActiveTool(null); return; }
    const targetSeg = appendAt === 'end' ? trksegs[trksegs.length - 1] : trksegs[0];
    const newPtEls = state.extendNewPoints.map(p => {
        const pt = doc.createElementNS(GPX_NS, 'trkpt');
        pt.setAttribute('lat', p.lat.toFixed(7));
        pt.setAttribute('lon', p.lon.toFixed(7));
        return pt;
    });
    if (appendAt === 'end') {
        for (const pt of newPtEls) targetSeg.appendChild(pt);
    } else {
        // Insert at the top of targetSeg, reversed so first-clicked ends nearest the existing start.
        const firstExisting = targetSeg.getElementsByTagName('trkpt')[0];
        for (const pt of newPtEls.slice().reverse()) {
            targetSeg.insertBefore(pt, firstExisting);
        }
    }
    const count = newPtEls.length;
    refreshBaseAfterEdit(`Extended track with ${count} point${count === 1 ? '' : 's'}.`);
    setActiveTool(null);
}

function finishDraw() {
    if (state.drawPoints.length < 2) { alert('Draw at least 2 points.'); return; }
    if (!state.baseXmlDoc) createBlankGpx();
    const name = prompt('Name for new track:', 'New track');
    if (!name || !name.trim()) return;
    pushHistory();
    const doc = state.baseXmlDoc;
    const trk = doc.createElementNS(GPX_NS, 'trk');
    const nameEl = doc.createElementNS(GPX_NS, 'name');
    nameEl.textContent = name.trim();
    trk.appendChild(nameEl);
    const trkseg = doc.createElementNS(GPX_NS, 'trkseg');
    for (const p of state.drawPoints) {
        const pt = doc.createElementNS(GPX_NS, 'trkpt');
        pt.setAttribute('lat', p.lat.toFixed(7));
        pt.setAttribute('lon', p.lon.toFixed(7));
        trkseg.appendChild(pt);
    }
    trk.appendChild(trkseg);
    doc.getElementsByTagName('gpx')[0].appendChild(trk);
    const count = state.drawPoints.length;
    refreshBaseAfterEdit(`Drew "${name.trim()}" with ${count} points.`);
    setActiveTool(null);
}

function addWaypoint(lat, lon, name, desc) {
    if (!state.baseXmlDoc) createBlankGpx();
    pushHistory();
    const doc = state.baseXmlDoc;
    const wpt = doc.createElementNS(GPX_NS, 'wpt');
    wpt.setAttribute('lat', lat.toFixed(7));
    wpt.setAttribute('lon', lon.toFixed(7));
    setDirectChild(wpt, 'name', name || 'Waypoint');
    if (desc) setDirectChild(wpt, 'desc', desc);
    // GPX schema puts wpts before rte/trk. Insert before the first one if any.
    const gpxRoot = doc.getElementsByTagName('gpx')[0];
    const firstAnchor = doc.querySelector('rte, trk');
    if (firstAnchor) gpxRoot.insertBefore(wpt, firstAnchor);
    else gpxRoot.appendChild(wpt);
    refreshBaseAfterEdit(`Added waypoint "${name || 'Waypoint'}".`);
}

function editWaypoint(wptEl) {
    const currentName = directChildText(wptEl, 'name');
    const currentDesc = directChildText(wptEl, 'desc');
    const newName = prompt('Waypoint name:', currentName);
    if (newName === null) return;
    const newDesc = prompt('Description (leave blank to remove):', currentDesc);
    if (newDesc === null) return;
    pushHistory();
    setDirectChild(wptEl, 'name', newName.trim() || 'Waypoint');
    setDirectChild(wptEl, 'desc', newDesc);
    refreshBaseAfterEdit(`Edited waypoint.`);
}

function deleteWaypointEl(wptEl) {
    const name = directChildText(wptEl, 'name') || '(waypoint)';
    if (!confirm(`Delete waypoint "${name}"?`)) return;
    pushHistory();
    wptEl.parentNode.removeChild(wptEl);
    refreshBaseAfterEdit(`Deleted waypoint "${name}".`);
}

// Map-level click for Extend / Draw / Add Waypoint (adds points when clicking blank map).
// Polyline click handlers use L.DomEvent.stop to prevent propagation here.
map.on('click', (e) => {
    if (state.activeTool === 'extend' && state.extendTarget) {
        snapshotToolState();
        const snap = findSnap(e.latlng);
        const p = snap || e.latlng;
        state.extendNewPoints.push({lat: p.lat, lon: p.lng});
        updateExtendPreview();
        updateUndoButton();
    } else if (state.activeTool === 'draw') {
        snapshotToolState();
        const snap = findSnap(e.latlng);
        const p = snap || e.latlng;
        state.drawPoints.push({lat: p.lat, lon: p.lng});
        updateDrawPreview();
        updateUndoButton();
    } else if (state.activeTool === 'addwpt') {
        const name = prompt('Waypoint name:', '');
        if (name === null) { setActiveTool(null); return; }
        const desc = prompt('Description (optional):', '');
        if (desc === null) { setActiveTool(null); return; }
        addWaypoint(e.latlng.lat, e.latlng.lng, name.trim() || 'Waypoint', desc.trim());
        setActiveTool(null);
    } else if (state.activeTool === 'split') {
        // Click missed the polyline itself — fall back to nearest candidate.
        const cand = findSplitCandidate(e.latlng);
        if (!cand) return;
        if (cand.kind === 'base') {
            splitBaseTrackAt(cand.line._trkEl, cand.latlng);
        } else {
            const seg = state.segments.find(s => s.layer === cand.line);
            if (seg) splitSegmentAt(seg.id, cand.latlng);
        }
    }
});

// Snap-preview ghost while drawing/extending so users see when their next
// click will lock to a base track; also a split-candidate ghost so they can
// hover near (not on) a track and see where the split will land.
map.on('mousemove', (e) => {
    const t = state.activeTool;
    if (t === 'draw' || (t === 'extend' && state.extendTarget)) {
        const snap = findSnap(e.latlng);
        if (snap) showGhostPoint(snap);
        else hideGhostPoint();
    } else if (t === 'split') {
        const cand = findSplitCandidate(e.latlng);
        if (cand) showGhostPoint(cand.latlng);
        else hideGhostPoint();
    }
});
