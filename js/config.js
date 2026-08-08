// ---------- config.js ----------
// Shared constants: XML namespaces, Garmin color palette, relevance thresholds,
// undo stack size, and localStorage keys.

// Relevance: what counts as "this ride visited the base map's area?"
const RELEVANCE = {
    radiusM: 100,       // ride point within this many m of any base point = "near"
    minPct: 5,          // >= this % of near-points → relevant
    sampleCap: 800,     // cap points sampled per ride so big files stay fast
};

// ---------- Units ----------
const UNITS_KEY = 'gpxtools.units';
const MERGED_KEY = 'gpxtools.mergedHistory';

const UNDO_MAX = 30;

// ---------- Utils ----------
const GPX_NS       = 'http://www.topografix.com/GPX/1/1';
const TT_NS        = 'http://www.trailtech.net/xml';
const GPXX_NS      = 'http://www.garmin.com/xmlschemas/GpxExtensions/v3';
const GPX_STYLE_NS = 'http://www.topografix.com/GPX/gpx_style/0/2';

// Garmin's GPX Extensions v3 restricts DisplayColor to a small named palette.
// We snap the picked hex to the nearest entry when writing so Garmin-family
// apps (BaseCamp, Connect, Gaia, CalTopo, etc.) display the closest match.
const GARMIN_COLORS = [
    ['Black',       0x000000], ['DarkRed',     0x800000], ['DarkGreen',   0x008000],
    ['DarkYellow',  0x808000], ['DarkBlue',    0x000080], ['DarkMagenta', 0x800080],
    ['DarkCyan',    0x008080], ['LightGray',   0xC0C0C0], ['DarkGray',    0x808080],
    ['Red',         0xFF0000], ['Green',       0x00FF00], ['Yellow',      0xFFFF00],
    ['Blue',        0x0000FF], ['Magenta',     0xFF00FF], ['Cyan',        0x00FFFF],
    ['White',       0xFFFFFF],
];
