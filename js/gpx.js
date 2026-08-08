// ---------- gpx.js ----------
// GPX parsing, DOM helpers, color read/write across TrailTech / gpx_style /
// Garmin conventions, and the color-preset datalist injector.

function hexToGarminColor(hex) {
    const h = hex.replace('#','').toUpperCase();
    const rgb = parseInt(h, 16);
    if (!Number.isFinite(rgb)) return 'Blue';
    const r = (rgb >> 16) & 0xff, g = (rgb >> 8) & 0xff, b = rgb & 0xff;
    let best = 'Blue', bestDist = Infinity;
    for (const [name, val] of GARMIN_COLORS) {
        const gr = (val >> 16) & 0xff, gg = (val >> 8) & 0xff, gb = val & 0xff;
        const d = (r-gr)**2 + (g-gg)**2 + (b-gb)**2;
        if (d < bestDist) { bestDist = d; best = name; }
    }
    return best;
}
function garminColorToHex(name) {
    const clean = (name || '').trim().toLowerCase();
    const found = GARMIN_COLORS.find(([n]) => n.toLowerCase() === clean);
    return found ? '#' + found[1].toString(16).padStart(6, '0').toUpperCase() : null;
}
// Inject a shared datalist of preset colors so every <input type="color">
// referencing list="colorPresets" gets the same swatches. Native color pickers
// on Windows/macOS display these as clickable presets — matches the Garmin
// palette so device colors stay consistent.
(function injectColorPresets() {
    if (document.getElementById('colorPresets')) return;
    const dl = document.createElement('datalist');
    dl.id = 'colorPresets';
    for (const [name, val] of GARMIN_COLORS) {
        const opt = document.createElement('option');
        opt.value = '#' + val.toString(16).padStart(6, '0').toUpperCase();
        opt.textContent = name;
        dl.appendChild(opt);
    }
    document.body.appendChild(dl);
})();

function normalizeHex(s) {
    if (!s) return null;
    const t = s.trim();
    if (/^#[0-9a-f]{6}$/i.test(t)) return t.toUpperCase();
    if (/^[0-9a-f]{6}$/i.test(t)) return '#' + t.toUpperCase();
    return null;
}

// Read a track's color, honoring the three widely-used conventions:
//   1. TrailTech Voyager Pro     — <TT:Color>#RRGGBB</TT:Color>
//   2. gpx_style extension       — <gpx_style:line><gpx_style:color>RRGGBB</...
//   3. Garmin GPX Extensions v3  — <gpxx:TrackExtension><gpxx:DisplayColor>Name
function trkColor(trkEl) {
    if (!trkEl) return null;
    for (const child of trkEl.children) {
        if (child.localName !== 'extensions') continue;
        for (const ext of child.children) {
            if (ext.localName === 'Color') {
                const h = normalizeHex(ext.textContent);
                if (h) return h;
            }
            if (ext.localName === 'line') {
                for (const g of ext.children) {
                    if (g.localName === 'color') {
                        const h = normalizeHex(g.textContent);
                        if (h) return h;
                    }
                }
            }
            if (ext.localName === 'TrackExtension') {
                for (const g of ext.children) {
                    if (g.localName === 'DisplayColor') {
                        const h = garminColorToHex(g.textContent);
                        if (h) return h;
                    }
                }
            }
        }
    }
    return null;
}

// Ensure a namespace prefix is declared on the gpx root so serialization keeps
// prefixes like "gpxx:", "gpx_style:", "TT:".
function ensureNsDeclared(prefix, uri) {
    const root = state.baseXmlDoc.getElementsByTagName('gpx')[0];
    if (root && !root.hasAttribute(`xmlns:${prefix}`)) {
        root.setAttributeNS('http://www.w3.org/2000/xmlns/', `xmlns:${prefix}`, uri);
    }
}

// Write the track color in all three conventions so the file plays nicely with
// TrailTech Voyager Pro, Garmin-family viewers, and gpx_style-aware tools.
function setTrkColor(trkEl, hex) {
    hex = (hex || '').toUpperCase();
    if (!/^#[0-9A-F]{6}$/.test(hex)) return;
    const doc = state.baseXmlDoc;

    ensureNsDeclared('TT', TT_NS);
    ensureNsDeclared('gpxx', GPXX_NS);
    ensureNsDeclared('gpx_style', GPX_STYLE_NS);

    // Find or create <extensions> on the trk.
    let ext = [...trkEl.children].find(c => c.localName === 'extensions');
    if (!ext) {
        ext = doc.createElementNS(GPX_NS, 'extensions');
        const nameEl = [...trkEl.children].find(c => c.localName === 'name');
        if (nameEl && nameEl.nextSibling) trkEl.insertBefore(ext, nameEl.nextSibling);
        else if (nameEl) trkEl.appendChild(ext);
        else trkEl.insertBefore(ext, trkEl.firstChild);
    }
    const upsertChild = (parent, ns, qname, localName) => {
        let el = [...parent.children].find(c => c.localName === localName);
        if (!el) { el = doc.createElementNS(ns, qname); parent.appendChild(el); }
        return el;
    };

    // 1. <TT:Color>#RRGGBB</TT:Color>
    upsertChild(ext, TT_NS, 'TT:Color', 'Color').textContent = hex;

    // 2. <gpxx:TrackExtension><gpxx:DisplayColor>Name</...></...>
    const trkExt = upsertChild(ext, GPXX_NS, 'gpxx:TrackExtension', 'TrackExtension');
    upsertChild(trkExt, GPXX_NS, 'gpxx:DisplayColor', 'DisplayColor').textContent = hexToGarminColor(hex);

    // 3. <gpx_style:line><gpx_style:color>RRGGBB</...></...>
    const styleLine = upsertChild(ext, GPX_STYLE_NS, 'gpx_style:line', 'line');
    upsertChild(styleLine, GPX_STYLE_NS, 'gpx_style:color', 'color').textContent = hex.slice(1);
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

function directChildText(el, tag) {
    if (!el) return '';
    for (const child of el.children) {
        if (child.localName === tag) return (child.textContent || '').trim();
    }
    return '';
}

// Set the text content of a direct-child <name>/<desc>/etc, creating it if
// missing and removing it if the text is empty.
function setDirectChild(el, tag, text) {
    let child = null;
    for (const c of el.children) {
        if (c.localName === tag) { child = c; break; }
    }
    text = (text || '').trim();
    if (!text) {
        if (child) el.removeChild(child);
        return;
    }
    if (!child) {
        child = state.baseXmlDoc.createElementNS(GPX_NS, tag);
        // Keep name at the top of the element per common convention.
        if (tag === 'name' && el.firstChild) el.insertBefore(child, el.firstChild);
        else el.appendChild(child);
    }
    child.textContent = text;
}

// ---------- Merge two base tracks ----------
function collectAllTrkpts(trkEl) {
    const pts = [];
    for (const trkseg of trkEl.getElementsByTagName('trkseg')) {
        for (const pt of trkseg.getElementsByTagName('trkpt')) pts.push(pt);
    }
    return pts;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c =>
        ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
