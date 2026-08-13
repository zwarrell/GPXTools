// ---------- render.js ----------
// Map rendering: base tracks/routes, waypoints, ride segment overlays, bounds
// fitting, hover/flash helpers, transient status text, and the track-stats
// popup content.

// ---------- Rendering ----------
function drawBase() {
    if (state.baseLayer) {
        map.removeLayer(state.baseLayer);
        state.baseLayer = null;
    }
    if (!state.baseXmlDoc) return;

    const polylines = [];
    let counts = {trkseg: 0, rte: 0, skipped: 0, points: 0};

    const compareOn = state.activePanel === 'compare';
    const makeLine = (pts, name, ownerEl) => {
        if (pts.length < 2) { counts.skipped++; return; }
        // Skip the track currently being edited — the edit preview shows it in
        // its live-editable form, and drawing the original underneath would be
        // confusing.
        if (state.editTarget && ownerEl === state.editTarget.trkEl) return;
        counts.points += pts.length;
        const highlighted = ownerEl && isSelectedForMerge('baseTrack', ownerEl);
        // In compare mode, force blue so the legend matches. Outside compare
        // mode, honor the TrailTech <TT:Color> per-track when present.
        const ownColor = (!compareOn && ownerEl && ownerEl.localName === 'trk')
            ? trkColor(ownerEl) : null;
        const style = highlighted
            ? {color: '#e63946', weight: 6, opacity: 0.95, pane: 'basePane'}
            : {color: ownColor || '#0066cc', weight: 4, opacity: 0.75, pane: 'basePane'};
        const line = L.polyline(pts, style);
        line._trkEl = ownerEl;
        line._trkName = name;
        line.bindTooltip(name, {sticky: true, direction: 'top'});
        line.on('click', (e) => {
            L.DomEvent.stop(e); // don't bubble to map click
            const tool = state.activeTool;
            if (tool === 'merge') {
                handleMergeTrackClick(line, e.latlng);
            } else if (tool === 'split') {
                splitBaseTrackAt(line._trkEl, e.latlng);
            } else if (tool === 'extend') {
                handleExtendBaseClick(line, e.latlng);
            } else if (tool === 'edit') {
                handleEditBaseClick(line);
            } else if (!tool) {
                L.popup().setLatLng(e.latlng).setContent(trackStatsPopupHtml(line._trkEl, name)).openOn(map);
                scrollContentsToItem('trk', line._trkEl);
            }
        });
        // Double-click enters Edit mode on this track directly.
        line.on('dblclick', (e) => {
            L.DomEvent.stop(e);
            if (!line._trkEl || line._trkEl.localName !== 'trk') return;
            if (state.activeTool !== 'edit') setActiveTool('edit');
            handleEditBaseClick(line);
        });
        // Highlight on hover so the user knows which track is under the cursor.
        line.on('mouseover', () => {
            if (isSelectedForMerge('baseTrack', line._trkEl)) return; // keep merge red
            line.setStyle({weight: 7, opacity: 0.95});
        });
        line.on('mouseout', () => {
            if (isSelectedForMerge('baseTrack', line._trkEl)) return;
            line.setStyle({weight: 4, opacity: 0.6});
            if (state.activeTool === 'split') hideGhostPoint();
        });
        line.on('mousemove', (e) => {
            if (state.activeTool !== 'split') return;
            showGhostPoint(nearestLatLngOn(line, e.latlng));
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
    drawWaypoints();
    console.log(
        `drawBase: ${counts.trkseg} trkseg(s) + ${counts.rte} rte(s), ` +
        `${polylines.length} rendered, ${counts.skipped} skipped (fewer than 2 valid points), ` +
        `${counts.points} total points`
    );
}

function drawWaypoints() {
    if (state.waypointLayer) {
        map.removeLayer(state.waypointLayer);
        state.waypointLayer = null;
    }
    if (!state.baseXmlDoc) return;
    const wpts = [...state.baseXmlDoc.getElementsByTagName('wpt')];
    if (!wpts.length) return;
    const markers = [];
    for (const wpt of wpts) {
        const lat = parseFloat(wpt.getAttribute('lat'));
        const lon = parseFloat(wpt.getAttribute('lon'));
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const name = directChildText(wpt, 'name') || '(waypoint)';
        const desc = directChildText(wpt, 'desc');
        const cmt  = directChildText(wpt, 'cmt');
        const ele  = directChildText(wpt, 'ele');
        const sym  = directChildText(wpt, 'sym');
        const marker = L.circleMarker([lat, lon], {
            radius: 6,
            color: '#0066cc',
            fillColor: '#4a90d9',
            fillOpacity: 0.9,
            weight: 2,
            pane: 'basePane',
        });
        marker._wptEl = wpt;
        marker._wptName = name;
        marker.bindTooltip(name, {direction: 'top'});
        const parts = [`<b>${escapeHtml(name)}</b>`];
        if (sym) parts.push(`<i>${escapeHtml(sym)}</i>`);
        if (desc) parts.push(escapeHtml(desc));
        if (cmt && cmt !== desc) parts.push(escapeHtml(cmt));
        if (ele) parts.push(`Elev: ${ele} m`);
        parts.push('<div class="wpt-popup-actions"><button class="wpt-edit-btn">Edit</button> <button class="wpt-del-btn">Delete</button></div>');
        marker.bindPopup(parts.join('<br>'));
        marker.on('popupopen', (e) => {
            const el = e.popup.getElement();
            if (!el) return;
            const editBtn = el.querySelector('.wpt-edit-btn');
            const delBtn = el.querySelector('.wpt-del-btn');
            if (editBtn) editBtn.addEventListener('click', () => { marker.closePopup(); editWaypoint(wpt); });
            if (delBtn)  delBtn.addEventListener('click', () => { marker.closePopup(); deleteWaypointEl(wpt); });
        });
        markers.push(marker);
    }
    if (markers.length) {
        state.waypointLayer = L.layerGroup(markers).addTo(map);
    }
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
                L.DomEvent.stop(e);
                const tool = state.activeTool;
                if (tool === 'merge') handleMergeSegClick(seg);
                else if (tool === 'split') splitSegmentAt(seg.id, e.latlng);
                else if (!tool) toggleSegment(seg.id);
            });
            line.on('mouseover', () => highlightSegmentItem(seg.id, true));
            line.on('mouseout', () => {
                highlightSegmentItem(seg.id, false);
                if (state.activeTool === 'split') hideGhostPoint();
            });
            line.on('mousemove', (e) => {
                if (state.activeTool !== 'split') return;
                showGhostPoint(nearestLatLngOn(line, e.latlng));
            });
        }
        line.addTo(state.rideLayerGroup);
        seg.layer = line;
    }
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

function snapToSegment(id) {
    const seg = state.segments.find(s => s.id === id);
    if (!seg || !seg.layer) return;
    const b = seg.layer.getBounds();
    if (b.isValid()) map.fitBounds(b.pad(0.25));
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

// Distance + elevation summary shown in the track popup on click.
function trackStatsPopupHtml(trkEl, name) {
    const pts = collectAllTrkpts(trkEl);
    let dist = 0;
    let minEle = Infinity, maxEle = -Infinity;
    let gain = 0, loss = 0;
    let lastEle = null;
    let hasEle = false;
    for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const lat = parseFloat(p.getAttribute('lat'));
        const lon = parseFloat(p.getAttribute('lon'));
        if (i > 0) {
            const prev = pts[i - 1];
            dist += haversineMeters(
                parseFloat(prev.getAttribute('lat')),
                parseFloat(prev.getAttribute('lon')),
                lat, lon);
        }
        const eleStr = directChildText(p, 'ele');
        if (eleStr) {
            const e = parseFloat(eleStr);
            if (Number.isFinite(e)) {
                hasEle = true;
                if (e < minEle) minEle = e;
                if (e > maxEle) maxEle = e;
                if (lastEle !== null) {
                    const d = e - lastEle;
                    if (d > 0) gain += d; else loss -= d;
                }
                lastEle = e;
            }
        }
    }
    const fmtEle = m => state.units === 'imperial'
        ? `${Math.round(m * 3.28084).toLocaleString()} ft`
        : `${Math.round(m).toLocaleString()} m`;
    const rows = [
        `<b>${escapeHtml(name)}</b>`,
        `Distance: <b>${fmtLongDist(dist)}</b>`,
        `Points: ${pts.length.toLocaleString()}`,
    ];
    if (hasEle) {
        rows.push(`Max elev: <b>${fmtEle(maxEle)}</b>`);
        rows.push(`Min elev: ${fmtEle(minEle)}`);
        if (gain > 0 || loss > 0) rows.push(`↑ ${fmtEle(gain)} · ↓ ${fmtEle(loss)}`);
    }
    return rows.join('<br>');
}

function showStatus(msg) {
    const el = document.getElementById('mergeStatus');
    el.textContent = msg;
    clearTimeout(showStatus._t);
    showStatus._t = setTimeout(() => { el.textContent = ''; }, 6000);
}
