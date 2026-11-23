/* Hero globe: live satellites + rain, and a queryable INSAT-3DR cube (Cyclone Biparjoy). */
(() => {
  const $ = id => document.getElementById(id);
  const el = $("globe");
  const webgl = (() => { try { const c = document.createElement("canvas"); return !!(c.getContext("webgl2") || c.getContext("webgl")); } catch (e) { return false; } })();
  if (!window.Globe || !webgl) {
    el.innerHTML = '<div class="globe-fallback">The globe needs WebGL, which this browser doesn\'t have turned on.</div>';
  }

  const HOME = { lat: 14, lng: 84, altitude: 2.7 };
  const CUBE_VIEW = { lat: 20.5, lng: 75, altitude: 1.15 };
  const RAMP = ["#8FD3F4", "#2C9C5A", "#F2D13A", "#EE8A2B", "#D7302A"];
  const fmtLL = (lat, lng, d = 1) => `${Math.abs(lat).toFixed(d)}°${lat >= 0 ? "N" : "S"} ${Math.abs(lng).toFixed(d)}°${lng >= 0 ? "E" : "W"}`;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const RAMP_RGB = RAMP.map(hex);
  function rampAt(stops, f) {
    f = clamp(f, 0, 1) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(f)), t = f - i, a = stops[i], b = stops[i + 1];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }

  let mode = "live";
  let globe = null;

  // globe.gl bundles three.js; we borrow its classes from objects it has already created
  function three() {
    const gm = globe && globe.globeMaterial();
    if (!gm || !gm.map) return null;
    let mesh = null;
    globe.scene().traverse(o => { if (!mesh && o.isMesh && o.geometry && o.geometry.isBufferGeometry) mesh = o; });
    if (!mesh) return null;
    const G = mesh.geometry.constructor;
    const BufferGeometry = mesh.geometry.type === "BufferGeometry" ? G : Object.getPrototypeOf(G);
    return { Material: gm.constructor, Texture: gm.map.constructor, colorSpace: gm.map.colorSpace, Mesh: mesh.constructor, BufferGeometry,
             Attr: mesh.geometry.getAttribute("position").constructor };
  }
  let T3 = null;
  async function ready3() {
    for (let i = 0; i < 150 && globe && !(T3 = T3 || three()); i++) await new Promise(r => setTimeout(r, 100));
    return T3;
  }
  function canvasMat(canvas, extra = {}) {
    const tex = new T3.Texture(canvas);
    if (T3.colorSpace) tex.colorSpace = T3.colorSpace;
    tex.needsUpdate = true;
    return { tex, mat: new T3.Material(Object.assign({ map: tex, transparent: true, depthWrite: false, shininess: 0 }, extra)) };
  }

  /* =====================================================================
     LIVE: satellites from CelesTrak, rain from Open-Meteo
     ===================================================================== */
  const MAIN = {
    39574: { name: "GPM", color: "#F2D13A" },
    41752: { name: "INSAT-3DR", color: "#8FD3F4" },
    41836: { name: "Himawari-9", color: "#C7B8FF" }
  };
  const sats = [];          // {id, name, color, main, rec, lat, lng, alt, km, speed}
  let selected = null, following = false;
  const show = { swarm: true, path: true, rain: true, clouds: true, hsaf: true, tc: true };
  const liveTiles = {};   // clouds, hsaf -> tile datum
  const cyclones = [];    // {name, lat, lng, alt, el, tracks: [[lat,lng]...], text, url}

  async function cachedText(key, url) {
    try {
      const c = JSON.parse(localStorage.getItem(key) || "null");
      if (c && Date.now() - c.t < 6 * 3600e3) return c.txt;
    } catch (e) {}
    const r = await fetch(url);
    if (!r.ok) throw new Error(r.status);
    const txt = await r.text();
    try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), txt })); } catch (e) {}
    return txt;
  }
  function parseTLE(txt) {
    const L = txt.trim().split(/\r?\n/).map(s => s.trim()), out = [];
    for (let i = 0; i + 2 < L.length; i += 3) {
      if (L[i + 1].startsWith("1 ") && L[i + 2].startsWith("2 ")) out.push({ name: L[i], l1: L[i + 1], l2: L[i + 2], id: +L[i + 1].slice(2, 7) });
    }
    return out;
  }
  function where(rec, date) {
    const pv = satellite.propagate(rec, date);
    if (!pv || !pv.position) return null;
    const g = satellite.eciToGeodetic(pv.position, satellite.gstime(date)), v = pv.velocity;
    return { lat: satellite.degreesLat(g.latitude), lng: satellite.degreesLong(g.longitude), km: g.height, speed: Math.hypot(v.x, v.y, v.z) };
  }
  const drawAlt = km => km < 2000 ? km / 6371 : 0.12 + 0.16 * clamp((km - 2000) / 33786, 0, 1.3);
  const overIndia = p => p.lat > 8 && p.lat < 35.5 && p.lng > 68 && p.lng < 97.5;
  function orbitText(s, km) {
    const inc = s.rec.inclo * 180 / Math.PI, period = 2 * Math.PI / s.rec.no;
    if (km > 35000 && km < 36600 && inc < 20) return "Geostationary";
    const per = period >= 120 ? `${(period / 60).toFixed(1)} h orbit` : `${Math.round(period)} min orbit`;
    if (km < 2000 && inc > 95 && inc < 101) return `Sun-synchronous, ${per}`;
    return `${inc.toFixed(0)}° tilt, ${per}`;
  }
  const prettyName = n => n.replace(/\s*\(.*?\)\s*/g, " ").replace(/\s+/g, " ").trim();

  async function loadSats() {
    const base = "https://celestrak.org/NORAD/elements/gp.php?";
    const groups = await Promise.allSettled([
      cachedText("tleg-weather", base + "GROUP=weather&FORMAT=TLE"),
      ...Object.keys(MAIN).map(id => cachedText("tle-" + id, base + `CATNR=${id}&FORMAT=TLE`))
    ]);
    const seen = new Set();
    groups.forEach(g => {
      if (g.status !== "fulfilled") return;
      parseTLE(g.value).forEach(t => {
        if (seen.has(t.id)) return;
        seen.add(t.id);
        let rec; try { rec = satellite.twoline2satrec(t.l1, t.l2); } catch (e) { return; }
        const m = MAIN[t.id];
        sats.push({ id: t.id, name: m ? m.name : prettyName(t.name), color: m ? m.color : "#E6ECF5", main: !!m, rec, lat: 0, lng: 0, alt: 0, km: 0, speed: 0 });
      });
    });
    sats.sort((a, b) => a.main - b.main); // main sats drawn last (on top)
  }

  const CITIES = [
    ["Hyderabad", 17.39, 78.49], ["Mumbai", 19.08, 72.88], ["Delhi", 28.61, 77.21], ["Kolkata", 22.57, 88.36],
    ["Chennai", 13.08, 80.27], ["Bengaluru", 12.97, 77.59], ["Guwahati", 26.14, 91.74], ["Kochi", 9.93, 76.27],
    ["Ahmedabad", 23.02, 72.57], ["Bhubaneswar", 20.30, 85.82]
  ].map(([name, lat, lng]) => ({ name, lat, lng, mm: null }));
  const rainColor = mm => mm == null ? "rgba(200,210,225,.6)" : mm <= 0 ? "rgba(200,210,225,.85)" : RAMP[Math.min(4, Math.floor(Math.log2(mm * 4 + 1)))];
  async function loadRain() {
    const q = `latitude=${CITIES.map(c => c.lat).join(",")}&longitude=${CITIES.map(c => c.lng).join(",")}&current=precipitation`;
    const data = await (await fetch("https://api.open-meteo.com/v1/forecast?" + q)).json();
    (Array.isArray(data) ? data : [data]).forEach((d, i) => { CITIES[i].mm = d.current ? d.current.precipitation : null; });
    const wet = CITIES.filter(c => c.mm > 0);
    $("r-rain").textContent = wet.length ? `${wet.length} of ${CITIES.length}: ${wet.slice(0, 2).map(c => c.name).join(", ")}${wet.length > 2 ? "…" : ""}` : `None of ${CITIES.length}, all dry`;
    refreshPoints();
  }

  function makeSatEl(s) {
    const e = document.createElement("button");
    e.type = "button";
    e.className = s.main ? "sat sat-main" : "sat sat-dot";
    e.style.setProperty("--c", s.color);
    e.dataset.name = s.name;
    e.setAttribute("aria-label", `${s.name}: show details`);
    if (s.main) e.textContent = s.name;
    e.addEventListener("click", ev => { ev.stopPropagation(); selectSat(s); });
    e.addEventListener("pointerdown", ev => ev.stopPropagation());
    s.el = e;
    return e;
  }
  function refreshSats() {
    if (!globe) return;
    let data = [];
    if (mode === "live") data = (show.swarm ? sats : sats.filter(s => s.main)).concat(show.tc ? cyclones : []);
    else if (mode === "cube") data = sats.filter(s => s.id === 41752);
    globe.htmlElementsData(data);
  }
  function refreshTiles() {
    if (!globe) return;
    let t = [];
    if (mode === "live") t = ["clouds", "hsaf"].filter(k => show[k] && liveTiles[k]).map(k => liveTiles[k]);
    else if (mode === "cube" && cube.tile) t = cube.tile;
    else if (mode === "gpm" && gpm.tile) t = gpm.tile;
    globe.tilesData(t);
  }
  function refreshPaths() {
    if (!globe) return;
    const paths = [];
    if (mode === "live") {
      const now = Date.now();
      const trail = (s, color) => {
        const pts = [];
        for (let m = 0; m <= 95; m++) { const p = where(s.rec, new Date(now + m * 60e3)); if (p) pts.push([p.lat, p.lng, drawAlt(p.km)]); }
        paths.push({ pts, color });
      };
      const gpm = sats.find(s => s.id === 39574);
      if (show.path && gpm) trail(gpm, ["rgba(242,209,58,0.95)", "rgba(242,209,58,0.05)"]);
      if (selected && selected.id !== 39574 && selected.km < 2000) trail(selected, ["rgba(143,211,244,0.95)", "rgba(143,211,244,0.05)"]);
      if (show.tc) cyclones.forEach(c => c.tracks.forEach(tr => paths.push({ pts: tr.map(([la, lo]) => [la, lo, 0.004]), color: ["rgba(238,138,43,0.95)", "rgba(238,138,43,0.95)"] })));
    } else if (mode === "gpm" && gpm.cutPts) {
      paths.push({ pts: gpm.cutPts.map(([la, lo]) => [la, lo, 0.003]), color: ["#F2D13A", "#F2D13A"] });
    }
    globe.pathsData(paths);
  }
  function refreshPoints() {
    if (!globe) return;
    if (mode === "live") globe.pointsData(show.rain ? CITIES : []);
    else if (mode === "cube") globe.pointsData(cube.probe ? [cube.probe] : []);
    else globe.pointsData([]);
  }

  function selectSat(s) {
    if (selected && selected.el) selected.el.classList.remove("on");
    selected = s;
    following = false;
    $("sc-follow").setAttribute("aria-pressed", "false");
    $("sc-follow").textContent = "Follow it";
    if (!s) { $("satcard").hidden = true; $("live-hint").hidden = false; refreshPaths(); return; }
    if (mode !== "live") setMode("live");
    s.el && s.el.classList.add("on");
    $("sc-name").textContent = s.name;
    $("satcard").hidden = false;
    $("live-hint").hidden = true;
    updateCard();
    refreshPaths();
    if (globe) globe.pointOfView({ lat: s.lat, lng: s.lng, altitude: globe.pointOfView().altitude }, 1000);
  }
  function updateCard() {
    if (!selected) return;
    const s = selected;
    $("sc-pos").textContent = fmtLL(s.lat, s.lng) + (overIndia(s) ? ", over India" : "");
    $("sc-alt").textContent = `${Math.round(s.km).toLocaleString("en-US")} km`;
    $("sc-spd").textContent = `${s.speed.toFixed(2)} km/s`;
    $("sc-orb").textContent = orbitText(s, s.km);
  }

  function tick() {
    const now = new Date();
    sats.forEach(s => {
      const p = where(s.rec, now);
      if (!p) return;
      s.lat = p.lat; s.lng = p.lng; s.km = p.km; s.speed = p.speed; s.alt = drawAlt(p.km);
    });
    const gpm = sats.find(s => s.id === 39574);
    if (gpm) {
      $("r-pos").textContent = overIndia(gpm) ? `${fmtLL(gpm.lat, gpm.lng)}, over India` : fmtLL(gpm.lat, gpm.lng);
      $("r-alt").textContent = `${Math.round(gpm.km)} km, ${gpm.speed.toFixed(1)} km/s`;
    }
    updateCard();
    if (globe) {
      globe.htmlElementsData(globe.htmlElementsData()); // re-read positions
      if (following && selected && mode === "live") globe.pointOfView({ lat: selected.lat, lng: selected.lng, altitude: globe.pointOfView().altitude }, 950);
    }
  }
  function nextPass() {
    const gpm = sats.find(s => s.id === 39574);
    if (!gpm) return;
    const now = Date.now();
    let next = null;
    for (let m = 0; m <= 24 * 60; m++) { const p = where(gpm.rec, new Date(now + m * 60e3)); if (p && overIndia(p)) { next = m; break; } }
    $("r-next").textContent = next === 0 ? "Overhead now" : next == null ? "Not in the next 24 h" : next < 60 ? `In ${next} min` : `In ${Math.floor(next / 60)} h ${next % 60} min`;
  }

  /* =====================================================================
     CUBE: INSAT-3DR Cyclone Biparjoy, queried in the browser
     ===================================================================== */
  const cube = { meta: null, raw: {}, pending: {}, lut: {}, varKey: "TIR1", t: 0, box: null, probe: null, playing: null, overlay: null, ready: false };
  const VARS = [
    { key: "TIR1", label: "TIR1", sub: "10.8 µm", need: ["TIR1"] },
    { key: "TIR2", label: "TIR2", sub: "12.0 µm", need: ["TIR2"] },
    { key: "WV", label: "WV", sub: "6.9 µm", need: ["WV"] },
    { key: "MIR", label: "MIR", sub: "3.9 µm", need: ["MIR"] },
    { key: "VIS", label: "VIS", sub: "0.65 µm", need: ["VIS"] },
    { key: "SPLIT", label: "TIR1 − TIR2", sub: "split window", need: ["TIR1", "TIR2"] },
    { key: "GPI", label: "Rain estimate", sub: "GPI, mm/h", need: ["TIR1"] }
  ];
  const PRESETS = [
    { name: "Biparjoy core", lat0: 19.5, lat1: 25, lon0: 63, lon1: 70 },
    { name: "Kutch coast", lat0: 21.5, lat1: 24.5, lon0: 68, lon1: 71.5 },
    { name: "Mumbai", lat0: 18.25, lat1: 20.5, lon0: 72, lon1: 74 },
    { name: "Bay of Bengal", lat0: 14, lat1: 22, lon0: 84, lon1: 92 },
    { name: "Whole cube", lat0: 11.5, lat1: 30, lon0: 55, lon1: 95 }
  ];
  const INFO = {
    TIR1: { lo: 190, hi: 300, note: "Cloud-top temperature. Colours mark cold, tall storm clouds; warm clear ground is see-through." },
    TIR2: { lo: 190, hi: 300, note: "The second thermal channel. Comparing it with TIR1 reveals thin ice cloud." },
    WV:   { lo: 210, hi: 262, note: "Upper-air moisture. White is moist air, brown is dry air." },
    MIR:  { lo: 190, hi: 300, note: "Mid-infrared: sees low cloud and fog at night, and is brightened by sunlight in the day." },
    VIS:  { lo: 0, hi: 70, note: "Reflected sunlight, so it goes dark at night. The day/night cycle is visible as you scrub." },
    SPLIT:{ lo: 0, hi: 7, note: "TIR1 minus TIR2. High values flag thin, high ice cloud such as the cyclone's cirrus shield." },
    GPI:  { lo: 0, hi: 3, note: "A classic simple rain rule (GOES Precipitation Index): 3 mm/h wherever cloud tops are colder than 235 K." }
  };

  // ----- colour maps (value -> rgba 0..255) -----
  function cmap(key, v) {
    if (v !== v) return [0, 0, 0, 0];
    switch (key) {
      case "TIR1": case "TIR2": case "MIR": {
        if (v >= 295) return [0, 0, 0, 0];
        if (v > 240) { const f = (295 - v) / 55, g = 95 + f * 150; return [g, g, Math.min(255, g + 12), f * 215]; }
        return [...rampAt(RAMP_RGB, (240 - v) / 48), 245];
      }
      case "WV": { const f = clamp((262 - v) / 52, 0, 1); return [...rampAt([[70, 48, 24], [44, 92, 150], [225, 242, 255]], f), 25 + f * f * 215]; }
      case "VIS": { const f = clamp(v / 70, 0, 1), g = 40 + Math.sqrt(f) * 215; return [g, g, g, f < 0.06 ? 0 : Math.min(1, f * 1.5) * 235]; }
      case "SPLIT": { if (v < 0.8) return [0, 0, 0, 0]; return [...rampAt(RAMP_RGB, (v - 0.8) / 6), 210]; }
      case "GPI": return v > 0 ? [44, 156, 90, 225] : [0, 0, 0, 0];
    }
    return [0, 0, 0, 0];
  }

  async function loadRaw(k) {
    if (cube.raw[k]) return cube.raw[k];
    if (cube.pending[k]) return cube.pending[k];
    cube.pending[k] = (async () => {
      const blob = await (await fetch(`data/biparjoy/${k}.png`)).blob();
      let src;
      try { src = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" }); }
      catch (e) { src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(blob); }); }
      const c = document.createElement("canvas");
      c.width = src.width; c.height = src.height;
      const x = c.getContext("2d", { willReadFrequently: true });
      x.drawImage(src, 0, 0);
      const px = x.getImageData(0, 0, c.width, c.height).data;
      const out = new Uint8Array(c.width * c.height);
      for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = px[j];
      const v = cube.meta.vars[k], lut = new Float32Array(256);
      for (let q = 0; q < 256; q++) lut[q] = q === 255 ? NaN : v.min + q / 254 * (v.max - v.min);
      cube.lut[k] = lut;
      cube.raw[k] = out;
      return out;
    })();
    return cube.pending[k];
  }

  // value getter for the selected variable: (t, i) -> number|NaN
  function getter(key) {
    const N = cube.meta.nx * cube.meta.ny, R = cube.raw, L = cube.lut;
    if (key === "SPLIT") { const a = R.TIR1, b = R.TIR2, la = L.TIR1, lb = L.TIR2; return (t, i) => la[a[t * N + i]] - lb[b[t * N + i]]; }
    if (key === "GPI") { const a = R.TIR1, la = L.TIR1; return (t, i) => { const v = la[a[t * N + i]]; return v !== v ? NaN : v < 235 ? 3 : 0; }; }
    const a = R[key], la = L[key];
    return (t, i) => la[a[t * N + i]];
  }

  function ensureOverlay() {
    if (cube.overlay || !T3) return !!cube.overlay;
    const { nx, ny, lat0, lat1, lon0, lon1 } = cube.meta;
    const canvas = document.createElement("canvas");
    canvas.width = nx; canvas.height = ny;
    const { tex, mat } = canvasMat(canvas);
    cube.overlay = { canvas, ctx: canvas.getContext("2d"), tex, mat, img: new ImageData(nx, ny) };
    // box fill that never hides the data under it
    const capMat = new T3.Material({ color: 0xF2D13A, transparent: true, opacity: 0.07, depthWrite: false, shininess: 0 });
    const sideMat = new T3.Material({ color: 0xF2D13A, transparent: true, opacity: 0, depthWrite: false });
    globe.polygonCapMaterial(() => capMat).polygonSideMaterial(() => sideMat);
    cube.tile = [{ lat: (lat0 + lat1) / 2, lng: (lon0 + lon1) / 2, w: lon1 - lon0, h: lat1 - lat0, alt: 0.006, mat, onClick: queryPoint }];
    return true;
  }

  function drawFrame() {
    if (!cube.overlay) return;
    const { nx, ny } = cube.meta, N = nx * ny, get = getter(cube.varKey), d = cube.overlay.img.data, t = cube.t;
    for (let i = 0; i < N; i++) {
      const c = cmap(cube.varKey, get(t, i)), j = i * 4;
      d[j] = c[0]; d[j + 1] = c[1]; d[j + 2] = c[2]; d[j + 3] = c[3];
    }
    cube.overlay.ctx.putImageData(cube.overlay.img, 0, 0);
    cube.overlay.tex.needsUpdate = true;
  }

  const ix = lon => Math.floor((lon - cube.meta.lon0) / cube.meta.res);
  const iy = lat => Math.floor((cube.meta.lat1 - lat) / cube.meta.res);
  const inCube = (lat, lng) => cube.meta && lat >= cube.meta.lat0 && lat <= cube.meta.lat1 && lng >= cube.meta.lon0 && lng <= cube.meta.lon1;
  const unit = () => ({ TIR1: "K", TIR2: "K", WV: "K", MIR: "K", VIS: "%", SPLIT: "K", GPI: "mm/h" })[cube.varKey];
  const fmtV = v => v !== v ? "no data" : `${cube.varKey === "GPI" ? v.toFixed(2) : v.toFixed(1)} ${unit()}`;
  const fmtT = s => { const d = new Date(s.replace("Z", ":00Z")); return `${d.getUTCDate()} Jun ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`; };

  function runQuery() {
    if (!cube.ready) return;
    const m = cube.meta, nx = m.nx, T = m.times.length, get = getter(cube.varKey), k = cube.varKey;
    const t0 = performance.now();
    let cells = [];
    if (cube.probe) {
      cells = [iy(cube.probe.lat) * nx + ix(cube.probe.lng)];
    } else {
      const b = cube.box;
      const j0 = clamp(iy(b.lat1), 0, m.ny - 1), j1 = clamp(iy(b.lat0 - 1e-9), 0, m.ny - 1);
      const i0 = clamp(ix(b.lon0), 0, nx - 1), i1 = clamp(ix(b.lon1 - 1e-9), 0, nx - 1);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) cells.push(j * nx + i);
    }
    // per-time mean (the chart) and current-time stats
    const series = new Float32Array(T);
    for (let t = 0; t < T; t++) {
      let s = 0, n = 0;
      for (const c of cells) { const v = get(t, c); if (v === v) { s += v; n++; } }
      series[t] = n ? s / n : NaN;
    }
    let n = 0, sum = 0, mn = Infinity, mx = -Infinity, hit = 0, rainVol = 0;
    const cellKm = (111.32 * m.res) ** 2;
    for (const c of cells) {
      const v = get(cube.t, c);
      if (v !== v) continue;
      n++; sum += v; mn = Math.min(mn, v); mx = Math.max(mx, v);
      if ((k === "TIR1" || k === "TIR2" || k === "MIR" || k === "WV") && v < 235) hit++;
      else if (k === "VIS" && v > 40) hit++;
      else if (k === "SPLIT" && v > 2) hit++;
      else if (k === "GPI" && v > 0) { hit++; rainVol += v * 1e-6 * cellKm * Math.cos((m.lat1 - (Math.floor(c / nx) + 0.5) * m.res) * Math.PI / 180); }
    }
    const ms = performance.now() - t0;
    const mean = n ? sum / n : NaN, pct = n ? Math.round(hit / n * 100) + "%" : "–";
    const single = !!cube.probe;
    const L = {
      TIR1: [single ? "Pixel value" : "Box mean", "Coldest", "Cloud tops below 235 K"],
      TIR2: [single ? "Pixel value" : "Box mean", "Coldest", "Below 235 K"],
      MIR:  [single ? "Pixel value" : "Box mean", "Coldest", "Below 235 K"],
      WV:   [single ? "Pixel value" : "Box mean", "Moistest (coldest)", "Moist upper air, below 235 K"],
      VIS:  [single ? "Pixel value" : "Mean reflectance", "Brightest", "Bright cloud, over 40%"],
      SPLIT:[single ? "Pixel value" : "Box mean", "Highest", "Thin ice cloud, over 2 K"],
      GPI:  [single ? "Pixel rain rate" : "Mean rain rate", "Raining area", "Rain falling in 1 h"]
    }[k];
    $("cq-l1").textContent = L[0]; $("cq-l2").textContent = L[1]; $("cq-l3").textContent = L[2];
    $("cq-s1").textContent = fmtV(mean);
    if (k === "GPI") {
      $("cq-s2").textContent = pct;
      $("cq-s3").textContent = rainVol >= 0.01 ? `${rainVol.toFixed(2)} km³` : rainVol > 0 ? `${Math.round(rainVol * 1e3)} million m³` : "none";
    } else {
      $("cq-s2").textContent = n ? fmtV(k === "VIS" || k === "SPLIT" ? mx : mn) : "–";
      $("cq-s3").textContent = pct;
    }
    const nv = cells.length * T;
    $("cq-s4").textContent = `${nv.toLocaleString("en-US")} values, ${ms < 1 ? "<1" : Math.round(ms)} ms`;
    cube.series = series;
    drawSpark();
    writeCode();
  }

  function drawSpark() {
    const s = cube.series, svg = $("cq-spark");
    if (!s) return;
    const T = s.length, W = 400, H = 96, P = 8;
    let lo = Infinity, hi = -Infinity;
    s.forEach(v => { if (v === v) { lo = Math.min(lo, v); hi = Math.max(hi, v); } });
    if (lo === Infinity) { svg.innerHTML = ""; return; }
    if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
    const X = t => (t / (T - 1)) * W, Y = v => P + (1 - (v - lo) / (hi - lo)) * (H - 2 * P);
    let d = "", pen = false;
    s.forEach((v, t) => { if (v !== v) { pen = false; return; } d += `${pen ? "L" : "M"}${X(t).toFixed(1)},${Y(v).toFixed(1)}`; pen = true; });
    const lf = cube.meta.times.indexOf("2023-06-15T14:15Z");
    const cur = s[cube.t];
    svg.innerHTML =
      (lf >= 0 ? `<line x1="${X(lf)}" x2="${X(lf)}" y1="0" y2="${H}" stroke="#EE8A2B" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>` : "") +
      `<path d="${d}" fill="none" stroke="#8FD3F4" stroke-width="2" vector-effect="non-scaling-stroke"/>` +
      `<line x1="${X(cube.t)}" x2="${X(cube.t)}" y1="0" y2="${H}" stroke="#F2D13A" stroke-width="2" vector-effect="non-scaling-stroke"/>` +
      (cur === cur ? `<circle cx="${X(cube.t)}" cy="${Y(cur)}" r="4" fill="#F2D13A"/>` : "");
    $("cq-spark-cap").innerHTML = `${cube.probe ? "Pixel value" : "Box mean"} through time, ${fmtV(lo).replace(/ .*/, "")}–${fmtV(hi)}. <span style="color:#EE8A2B">Dashed: landfall, 15 June.</span> Click to jump.`;
  }

  function writeCode() {
    const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const k = cube.varKey;
    const expr = k === "SPLIT" ? "(cube.TIR1 - cube.TIR2)" : k === "GPI" ? "(3 * (cube.TIR1 < 235))" : `cube.${k}`;
    const time = cube.meta.times[cube.t].replace("Z", "");
    let sel;
    if (cube.probe) sel = `.sel(lat=${cube.probe.lat.toFixed(2)}, lon=${cube.probe.lng.toFixed(2)}, method=<span class="s">"nearest"</span>)`;
    else { const b = cube.box; sel = `.sel(lat=slice(${b.lat0}, ${b.lat1}), lon=slice(${b.lon0}, ${b.lon1}))`; }
    $("cq-code").innerHTML =
      `<span class="k">sub</span> = ${esc(expr)}${sel}\n` +
      `<span class="k">sub</span>${cube.probe ? "" : `.mean([<span class="s">"lat"</span>, <span class="s">"lon"</span>])`}        # the chart\n` +
      `<span class="k">sub</span>.sel(time=<span class="s">"${time}"</span>)   # the numbers`;
  }

  function boxRing(b) {
    const ring = [], step = 0.5;
    for (let x = b.lon0; x < b.lon1; x += step) ring.push([x, b.lat0]);
    for (let y = b.lat0; y < b.lat1; y += step) ring.push([b.lon1, y]);
    for (let x = b.lon1; x > b.lon0; x -= step) ring.push([x, b.lat1]);
    for (let y = b.lat1; y > b.lat0; y -= step) ring.push([b.lon0, y]);
    ring.push([b.lon0, b.lat0]);
    return ring.reverse(); // clockwise, so the cap fills the box and not the rest of the globe
  }
  function refreshBox() {
    if (!globe) return;
    if (mode !== "cube" || !cube.box || cube.probe) { globe.polygonsData([]); return; }
    globe.polygonsData([{ geometry: { type: "Polygon", coordinates: [boxRing(cube.box)] } }]);
  }

  function setBox(b, presetName) {
    const m = cube.meta, r = v => Math.round(v * 4) / 4;
    b = { lat0: clamp(r(Math.min(b.lat0, b.lat1)), m.lat0, m.lat1), lat1: clamp(r(Math.max(b.lat0, b.lat1)), m.lat0, m.lat1),
          lon0: clamp(r(Math.min(b.lon0, b.lon1)), m.lon0, m.lon1), lon1: clamp(r(Math.max(b.lon0, b.lon1)), m.lon0, m.lon1) };
    if (b.lat1 - b.lat0 < 0.5) b.lat1 = Math.min(m.lat1, b.lat0 + 0.5);
    if (b.lon1 - b.lon0 < 0.5) b.lon1 = Math.min(m.lon1, b.lon0 + 0.5);
    cube.box = b;
    cube.probe = null;
    document.querySelectorAll("#cq-boxes [data-preset]").forEach(x => x.setAttribute("aria-pressed", String(x.dataset.preset === presetName)));
    refreshBox(); refreshPoints(); runQuery();
  }
  function queryPoint(lat, lng) {
    if (mode !== "cube" || !cube.ready || drawing || !inCube(lat, lng)) return;
    cube.probe = { lat, lng, probe: true };
    document.querySelectorAll("#cq-boxes [data-preset]").forEach(x => x.setAttribute("aria-pressed", "false"));
    refreshBox(); refreshPoints(); runQuery();
  }

  function setTime(t) {
    cube.t = clamp(t, 0, cube.meta.times.length - 1);
    $("cq-t").value = cube.t;
    $("cq-tout").textContent = fmtT(cube.meta.times[cube.t]);
    drawFrame(); runQuery();
  }

  function legend() {
    const k = cube.varKey, inf = INFO[k], stops = [];
    for (let i = 0; i <= 12; i++) {
      const v = inf.lo + (inf.hi - inf.lo) * i / 12, c = cmap(k, v), a = Math.max(0.12, c[3] / 255);
      stops.push(`rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a.toFixed(2)}) ${(i / 12 * 100).toFixed(0)}%`);
    }
    const coldFirst = ["TIR1", "TIR2", "MIR", "WV"].includes(k);
    if (coldFirst) stops.reverse().forEach((s, i, arr) => { arr[i] = s.replace(/ \d+%$/, ` ${(i / 12 * 100).toFixed(0)}%`); });
    $("kc-bar").style.background = `linear-gradient(90deg, ${stops.join(",")})`;
    const u = unit();
    $("kc-min").textContent = coldFirst ? `${inf.hi} ${u}` : `${inf.lo} ${u}`;
    $("kc-max").textContent = coldFirst ? `${inf.lo} ${u}` : `${inf.hi} ${u}`;
    $("kc-note").textContent = inf.note;
  }

  async function setVar(k) {
    cube.varKey = k;
    document.querySelectorAll("#cq-vars button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.var === k)));
    const v = VARS.find(x => x.key === k);
    const missing = v.need.filter(n => !cube.raw[n]);
    if (missing.length) {
      $("kc-note").textContent = `Loading ${v.label} from the cube…`;
      try { await Promise.all(v.need.map(loadRaw)); }
      catch (e) { $("kc-note").textContent = "Couldn't load that variable. Please try again."; return; }
      if (cube.varKey !== k) return;
    }
    legend(); drawFrame(); runQuery();
  }

  async function initCube() {
    if (cube.ready || cube.starting) return;
    cube.starting = true;
    $("kc-note").textContent = "Loading the cube…";
    try {
      cube.meta = await (await fetch("data/biparjoy/meta.json")).json();
      await loadRaw("TIR1");
    } catch (e) { $("kc-note").textContent = "Couldn't load the INSAT cube right now."; cube.starting = false; return; }
    const m = cube.meta;
    $("cq-n").textContent = m.times.length;
    $("cq-t").max = m.times.length - 1;
    // variable buttons
    const fv = $("cq-vars");
    VARS.forEach(v => {
      const b = document.createElement("button");
      b.type = "button"; b.dataset.var = v.key; b.setAttribute("aria-pressed", String(v.key === cube.varKey));
      b.innerHTML = `${v.label}<small>${v.sub}</small>`;
      b.addEventListener("click", () => setVar(v.key));
      fv.appendChild(b);
    });
    // region presets
    const fb = $("cq-boxes"), drawBtn = $("cq-draw");
    PRESETS.forEach(p => {
      const b = document.createElement("button");
      b.type = "button"; b.dataset.preset = p.name; b.textContent = p.name; b.setAttribute("aria-pressed", "false");
      b.addEventListener("click", () => setBox(p, p.name));
      fb.insertBefore(b, drawBtn);
    });
    // wait for globe texture so the overlay can share its renderer classes
    if (globe && await ready3()) ensureOverlay();
    cube.ready = true;
    const start = m.times.indexOf("2023-06-15T12:15Z");
    cube.t = start >= 0 ? start : 0;
    cube.box = PRESETS[0];
    legend();
    refreshTiles();
    setBox(PRESETS[0], PRESETS[0].name);
    setTime(cube.t);
  }

  function play() {
    const btn = $("cq-play"), ico = $("cq-play-ico");
    if (cube.playing) {
      clearInterval(cube.playing); cube.playing = null;
      ico.setAttribute("d", "M4 2.5v11l9-5.5z"); btn.setAttribute("aria-label", "Play");
      return;
    }
    ico.setAttribute("d", "M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z"); btn.setAttribute("aria-label", "Pause");
    cube.playing = setInterval(() => setTime((cube.t + 1) % cube.meta.times.length), 280);
  }

  /* =====================================================================
     LIVE LAYERS: Meteosat-9 (IODC) clouds and H SAF rain rate from EUMETView,
     active tropical cyclones from GDACS
     ===================================================================== */
  const EUM = "https://view.eumetsat.int/geoserver/";
  const MSG_BOX = { lat0: -40, lat1: 50, lon0: 30, lon1: 120 };
  async function latestTime(layer) {
    const [ws, name] = layer.split(":");
    const xml = await (await fetch(`${EUM}${ws}/${name}/ows?service=WMS&version=1.3.0&request=GetCapabilities`)).text();
    const m = xml.match(/<Dimension[^>]*name="time"[^>]*default="([^"]+)"/);
    return m ? m[1] : null;
  }
  function loadImg(url) {
    return new Promise((res, rej) => { const i = new Image(); i.crossOrigin = "anonymous"; i.onload = () => res(i); i.onerror = rej; i.src = url; });
  }
  async function loadMeteosat(key, layer, alt, recolor) {
    const time = await latestTime(layer);
    const b = MSG_BOX, W = 1024, H = 1024;
    const url = `${EUM}ows?service=WMS&version=1.3.0&request=GetMap&layers=${layer}&styles=&crs=EPSG:4326&bbox=${b.lat0},${b.lon0},${b.lat1},${b.lon1}&width=${W}&height=${H}&format=image/png&transparent=true${time ? "&time=" + encodeURIComponent(time) : ""}`;
    const img = await loadImg(url);
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.drawImage(img, 0, 0);
    const id = x.getImageData(0, 0, W, H), d = id.data;
    for (let i = 0; i < d.length; i += 4) recolor(d, i);
    x.putImageData(id, 0, 0);
    if (!(await ready3())) return time;
    const prev = liveTiles[key];
    const { mat } = canvasMat(c);
    liveTiles[key] = { lat: (b.lat0 + b.lat1) / 2, lng: (b.lon0 + b.lon1) / 2, w: b.lon1 - b.lon0, h: b.lat1 - b.lat0, alt, mat };
    if (prev) { prev.mat.map.dispose(); prev.mat.dispose(); }
    refreshTiles();
    return time;
  }
  const cloudColor = (d, i) => { // IR brightness: bright = cold cloud top. Clear ground becomes see-through.
    const g = d[i]; const a = clamp((g - 70) / 140, 0, 1);
    d[i] = d[i + 1] = d[i + 2] = 160 + a * 95; d[i + 3] = d[i + 3] ? a * a * 235 : 0;
  };
  const rainRateColor = (d, i) => { // H SAF palette is pale yellow (light) to deep blue (heavy); map to the site ramp
    if (!d[i + 3] || (d[i] > 245 && d[i + 1] > 245 && d[i + 2] > 245)) { d[i + 3] = 0; return; }
    const heavy = clamp(1 - (d[i] + d[i + 1]) / 2 / 255 + (d[i + 2] - d[i]) / 400, 0, 1);
    const c = rampAt(RAMP_RGB, 0.15 + heavy * 0.85);
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 235;
  };
  async function loadLiveLayers() {
    const res = await Promise.allSettled([
      loadMeteosat("clouds", "msg_iodc:ir108", 0.007, cloudColor),
      loadMeteosat("hsaf", "msg_iodc:h63", 0.009, rainRateColor)
    ]);
    const t = res[0].status === "fulfilled" && res[0].value;
    if (t) {
      const d = new Date(t), mins = Math.round((Date.now() - d) / 60000);
      $("r-msg").textContent = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC, ${mins < 90 ? mins + " min" : Math.round(mins / 60) + " h"} ago`;
    } else $("r-msg").textContent = "Unavailable";
  }

  async function loadCyclones() {
    const list = await (await fetch("https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP")).json();
    const tcs = list.features.filter(f => f.properties.eventtype === "TC" && String(f.properties.iscurrent) === "true");
    cyclones.length = 0;
    for (const f of tcs.slice(0, 6)) {
      const p = f.properties, [lng, lat] = f.geometry.coordinates;
      const raw = (p.eventname || p.name || "Cyclone").replace(/^Tropical Cyclone\s*/i, "").replace(/-\d+$/, "");
      const c = { name: raw.charAt(0) + raw.slice(1).toLowerCase(), lat, lng, alt: 0.012, tracks: [],
                  text: (p.severitydata && p.severitydata.severitytext) || "", url: (p.url && p.url.report) || "https://www.gdacs.org/" };
      try {
        const geo = await (await fetch(`https://www.gdacs.org/gdacsapi/api/polygons/getgeometry?eventtype=TC&eventid=${p.eventid}&episodeid=${p.episodeid}`)).json();
        geo.features.forEach(g => {
          if (g.geometry.type === "LineString") c.tracks.push(g.geometry.coordinates.map(([x, y]) => [y, x]));
          if (g.geometry.type === "MultiLineString") g.geometry.coordinates.forEach(l => c.tracks.push(l.map(([x, y]) => [y, x])));
        });
      } catch (e) {}
      const a = document.createElement("a");
      a.className = "tc-wrap"; a.href = c.url; a.target = "_blank"; a.rel = "noopener";
      a.title = `${c.name}${c.text ? ": " + c.text : ""} (GDACS report)`;
      a.innerHTML = `<i class="tc-mark"></i><span class="lbl"></span>`;
      a.querySelector(".lbl").textContent = c.name;
      a.addEventListener("pointerdown", ev => ev.stopPropagation());
      c.el = a;
      cyclones.push(c);
    }
    const out = $("r-tc");
    out.textContent = "";
    if (!cyclones.length) { out.textContent = "None right now"; }
    cyclones.forEach((c, i) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "linkish"; b.textContent = c.name;
      b.title = c.text || "Show on the globe";
      b.addEventListener("click", () => { if (mode !== "live") setMode("live"); globe && globe.pointOfView({ lat: c.lat, lng: c.lng, altitude: 1.6 }, 1400); });
      if (i) out.append(", ");
      out.append(b);
    });
    refreshSats(); refreshPaths();
  }

  /* =====================================================================
     GPM: one DPR overpass of Cyclone Gulab, sliced in the browser
     ===================================================================== */
  const gpm = { meta: null, vol: null, dir: "along", pos: 24, cutPts: null, tile: null, curtain: null, starting: false, ready: false };
  const EXAG = 40;
  const GPM_VIEW = { lat: 11, lng: 91, altitude: 0.55 }; // from the south-east, so the curtain is seen side-on
  const dbzRGB = dbz => dbz < 12 ? null : rampAt([...RAMP_RGB, [178, 58, 184]], (dbz - 12) / 48);
  const rainRGB = mm => rampAt(RAMP_RGB, Math.log10(Math.max(mm, 0.5) / 0.5) / 2);

  async function initGpm() {
    if (gpm.ready || gpm.starting) return;
    gpm.starting = true;
    try {
      gpm.meta = await (await fetch("data/gulab/meta.json")).json();
      const blob = await (await fetch("data/gulab/dbz.png")).blob();
      let src;
      try { src = await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" }); }
      catch (e) { src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(blob); }); }
      const c = document.createElement("canvas"); c.width = src.width; c.height = src.height;
      const x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(src, 0, 0);
      const px = x.getImageData(0, 0, c.width, c.height).data;
      gpm.vol = new Uint8Array(c.width * c.height);
      for (let i = 0, j = 0; i < gpm.vol.length; i++, j += 4) gpm.vol[i] = px[j];
    } catch (e) { $("gq-read").textContent = "Couldn't load the GPM slice right now."; gpm.starting = false; return; }
    const m = gpm.meta;
    const st = new Date(m.start);
    $("gq-when").textContent = `${String(st.getUTCHours()).padStart(2, "0")}:${String(st.getUTCMinutes()).padStart(2, "0")} UTC`;
    $("gq-dims").textContent = `${m.nscan} scans × ${m.nray} beams × ${m.nlev} heights`;
    // dBZ legend
    const stops = []; for (let i = 0; i <= 8; i++) { const c = dbzRGB(12 + 48 * i / 8); stops.push(`rgb(${c.map(v => v | 0)}) ${i * 12.5}%`); }
    $("gq-bar").style.background = `linear-gradient(90deg, ${stops.join(",")})`;
    const rs = []; for (let i = 0; i <= 8; i++) { const c = rainRGB(0.5 * Math.pow(100, i / 8)); rs.push(`rgb(${c.map(v => v | 0)}) ${i * 12.5}%`); }
    $("kg-bar").style.background = `linear-gradient(90deg, ${rs.join(",")})`;
    // swath rain on an equirectangular canvas
    let la0 = 90, la1 = -90, lo0 = 180, lo1 = -180;
    m.lat.forEach(v => { la0 = Math.min(la0, v); la1 = Math.max(la1, v); });
    m.lon.forEach(v => { lo0 = Math.min(lo0, v); lo1 = Math.max(lo1, v); });
    la0 -= 0.1; la1 += 0.1; lo0 -= 0.1; lo1 += 0.1;
    const RES = 0.02, W = Math.ceil((lo1 - lo0) / RES), H = Math.ceil((la1 - la0) / RES);
    const sw = document.createElement("canvas"); sw.width = W; sw.height = H;
    const sx = sw.getContext("2d");
    for (let i = 0; i < m.lat.length; i++) {
      const r = m.rain[i], X = (m.lon[i] - lo0) / RES, Y = (la1 - m.lat[i]) / RES;
      if (r >= 0.5) { const c = rainRGB(r); sx.fillStyle = `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},0.92)`; }
      else sx.fillStyle = "rgba(225,235,250,0.16)";
      sx.fillRect(X - 1.6, Y - 1.6, 3.2, 3.2);
    }
    gpm.box = { la0, la1, lo0, lo1 };
    if (globe && await ready3()) {
      const { mat } = canvasMat(sw);
      gpm.tile = [{ lat: (la0 + la1) / 2, lng: (lo0 + lo1) / 2, w: lo1 - lo0, h: la1 - la0, alt: 0.0025, mat, onClick: pickFootprint }];
    }
    gpm.ready = true;
    // start on the beam with the most heavy rain
    let best = 24, bestN = -1;
    for (let r = 0; r < m.nray; r++) { let n = 0; for (let s = 0; s < m.nscan; s++) if (m.rain[s * m.nray + r] > 10) n++; if (n > bestN) { bestN = n; best = r; } }
    setCut("along", best);
    refreshTiles();
  }

  function cutCells() {
    const m = gpm.meta, out = [];
    if (gpm.dir === "along") for (let s = 0; s < m.nscan; s++) out.push([s, gpm.pos]);
    else for (let r = 0; r < m.nray; r++) out.push([gpm.pos, r]);
    return out;
  }
  const dbzAt = (s, r, l) => { const q = gpm.vol[(r * gpm.meta.nlev + l) * gpm.meta.nscan + s]; return q ? q / gpm.meta.dbz_scale : NaN; };
  function kmBetween(a, b) {
    const R = 6371, p = Math.PI / 180, dLa = (b[0] - a[0]) * p, dLo = (b[1] - a[1]) * p;
    const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * p) * Math.cos(b[0] * p) * Math.sin(dLo / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function setCut(dir, pos) {
    if (!gpm.ready) return;
    const m = gpm.meta;
    gpm.dir = dir;
    gpm.pos = clamp(pos, 0, (dir === "along" ? m.nray : m.nscan) - 1);
    document.querySelectorAll("#gq-dir button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.dir === dir)));
    const slider = $("gq-pos");
    slider.max = (dir === "along" ? m.nray : m.nscan) - 1;
    slider.value = gpm.pos;
    $("gq-out").textContent = dir === "along" ? `Beam ${gpm.pos + 1} of ${m.nray}` : `Scan ${gpm.pos + 1} of ${m.nscan}`;
    const cells = cutCells(), N = cells.length, L = m.nlev;
    gpm.cutPts = cells.map(([s, r]) => [m.lat[s * m.nray + r], m.lon[s * m.nray + r]]);
    // distance axis
    gpm.dist = [0]; for (let i = 1; i < N; i++) gpm.dist.push(gpm.dist[i - 1] + kmBetween(gpm.cutPts[i - 1], gpm.cutPts[i]));
    // render the slice (cols = cells, rows = heights, top row = 18 km)
    const xc = document.createElement("canvas");
    xc.width = N; xc.height = L;
    const xx = xc.getContext("2d"), img = xx.createImageData(N, L), d = img.data;
    let peakZ = -1, peakRain = 0, topKm = 0, bbs = [];
    cells.forEach(([s, r], k) => {
      const i = s * m.nray + r;
      peakRain = Math.max(peakRain, m.rain[i]);
      if (m.top_km[i] != null) topKm = Math.max(topKm, m.top_km[i]);
      if (m.bb_km[i] != null) bbs.push(m.bb_km[i]);
      for (let l = 0; l < L; l++) {
        const z = dbzAt(s, r, l), j = (l * N + k) * 4, c = z === z ? dbzRGB(z) : null;
        if (c) { d[j] = c[0]; d[j + 1] = c[1]; d[j + 2] = c[2]; d[j + 3] = 255; peakZ = Math.max(peakZ, z); }
        else { d[j] = 230; d[j + 1] = 238; d[j + 2] = 250; d[j + 3] = 18; }
      }
    });
    xx.putImageData(img, 0, 0);
    gpm.slice = xc;
    drawXsec();
    bbs.sort((a, b) => a - b);
    $("gq-s1").textContent = `${peakRain.toFixed(0)} mm/h`;
    $("gq-s2").textContent = peakZ > 0 ? `${peakZ.toFixed(1)} dBZ` : "–";
    $("gq-s3").textContent = topKm ? `${topKm.toFixed(1)} km` : "–";
    $("gq-s4").textContent = bbs.length ? `${bbs[bbs.length >> 1].toFixed(1)} km` : "none";
    const sl = dir === "along" ? `nray=${gpm.pos}` : `nscan=${m.scan0 + gpm.pos}`;
    $("gq-code").innerHTML =
      `<span class="k">cut</span> = gpm.zFactorFinal.isel(${sl}).sel(height=slice(0, 18000))\n` +
      `<span class="k">cut</span>.plot(x=<span class="s">"${dir === "along" ? "along_track_km" : "across_track_km"}"</span>)   # the slice\n` +
      `gpm.precipRateNearSurface.isel(${sl}).max()   # peak rain`;
    buildCurtain();
    refreshPaths();
  }

  function drawXsec(hover) {
    const cv = $("gq-xsec"), ctx = cv.getContext("2d"), W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    if (!gpm.slice) return;
    ctx.imageSmoothingEnabled = gpm.dir === "across";
    ctx.drawImage(gpm.slice, 0, 0, W, H);
    // grid lines every 6 km
    ctx.strokeStyle = "rgba(175,192,218,.22)"; ctx.lineWidth = 1;
    [6, 12].forEach(km => { const y = H * (1 - km / 18); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); });
    // distance ticks
    const total = gpm.dist[gpm.dist.length - 1];
    ctx.fillStyle = "rgba(175,192,218,.85)"; ctx.font = "600 12px Archivo, sans-serif";
    const step = total > 600 ? 200 : total > 150 ? 50 : 25;
    for (let km = 0; km <= total; km += step) { const x = km / total * W; ctx.fillRect(x, H - 6, 1, 6); ctx.fillText(km === 0 ? "0 km" : String(km), Math.min(x + 3, W - 30), H - 9); }
    if (hover) { ctx.strokeStyle = "#F2D13A"; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(hover.x, 0); ctx.lineTo(hover.x, H); ctx.stroke(); }
  }

  function buildCurtain() {
    if (!globe || !T3) return;
    const scene = globe.scene();
    if (gpm.curtain) { scene.remove(gpm.curtain); gpm.curtain.geometry.dispose(); gpm.curtain = null; }
    if (mode !== "gpm" || !gpm.cutPts) return;
    // one coloured quad per radar echo, coloured per vertex (no texture or blending to sort)
    const m = gpm.meta, cells = cutCells(), pts = gpm.cutPts, N = pts.length, L = m.nlev, base = 0.0035;
    const edge = [];  // N+1 column boundaries, halfway between footprints (extended half a step at each end)
    const mid = (u, v, f) => [u[0] + (v[0] - u[0]) * f, u[1] + (v[1] - u[1]) * f];
    for (let k = 0; k <= N; k++) {
      if (N === 1) edge.push(pts[0]);
      else if (k === 0) edge.push(mid(pts[0], pts[1], -0.5));
      else if (k === N) edge.push(mid(pts[N - 2], pts[N - 1], 1.5));
      else edge.push(mid(pts[k - 1], pts[k], 0.5));
    }
    const hk = m.height_km, alt = km => base + Math.max(0, km) / 6371 * EXAG;
    const lin = v => Math.pow(v / 255, 2.2);
    const P = [], C = [], cache = new Map();
    const at = (k, km) => { const key = k + ":" + km; let c = cache.get(key); if (!c) { c = globe.getCoords(edge[k][0], edge[k][1], alt(km)); cache.set(key, c); } return c; };
    cells.forEach(([s, r], k) => {
      for (let l = 0; l < L; l++) {
        const z = dbzAt(s, r, l);
        if (z !== z) continue;
        const col = dbzRGB(z).map(lin);
        const top = hk[l] + 0.0625, bot = hk[l] - 0.0625;
        const a = at(k, bot), b = at(k + 1, bot), c = at(k + 1, top), d = at(k, top);
        for (const v of [a, b, c, a, c, d]) { P.push(v.x, v.y, v.z); C.push(col[0], col[1], col[2]); }
      }
    });
    if (!P.length) return;
    const geo = new T3.BufferGeometry();
    geo.setAttribute("position", new T3.Attr(new Float32Array(P), 3));
    geo.setAttribute("color", new T3.Attr(new Float32Array(C), 3));
    geo.computeVertexNormals();
    if (!gpm.curtainMat) gpm.curtainMat = new T3.Material({ vertexColors: true, side: 2, shininess: 0, emissive: 0x333333 });
    gpm.curtain = new T3.Mesh(geo, gpm.curtainMat);
    scene.add(gpm.curtain);
  }

  function pickFootprint(lat, lng) {
    if (mode !== "gpm" || !gpm.ready) return;
    const m = gpm.meta;
    let best = -1, bd = Infinity;
    for (let i = 0; i < m.lat.length; i++) { const d = (m.lat[i] - lat) ** 2 + (m.lon[i] - lng) ** 2; if (d < bd) { bd = d; best = i; } }
    if (best < 0 || bd > 0.15 * 0.15) return;
    const s = Math.floor(best / m.nray), r = best % m.nray;
    setCut(gpm.dir, gpm.dir === "along" ? r : s);
  }

  $("gq-xsec").addEventListener("pointermove", e => {
    if (!gpm.ready || !gpm.slice) return;
    const cv = e.currentTarget, rc = cv.getBoundingClientRect();
    const fx = clamp((e.clientX - rc.left) / rc.width, 0, 0.9999), fy = clamp((e.clientY - rc.top) / rc.height, 0, 0.9999);
    const cells = cutCells(), k = Math.floor(fx * cells.length), l = Math.floor(fy * gpm.meta.nlev);
    const [s, r] = cells[k], z = dbzAt(s, r, l), h = gpm.meta.height_km[l];
    $("gq-read").textContent = `${Math.round(gpm.dist[k])} km along · ${h.toFixed(1)} km high · ${z === z ? z.toFixed(1) + " dBZ" : "no echo"} · rain below ${gpm.meta.rain[s * gpm.meta.nray + r].toFixed(1)} mm/h`;
    drawXsec({ x: fx * cv.width });
  });
  $("gq-xsec").addEventListener("pointerleave", () => { drawXsec(); $("gq-read").textContent = "Hover the slice to read the reflectivity."; });
  $("gq-pos").addEventListener("input", e => setCut(gpm.dir, +e.target.value));
  document.querySelectorAll("#gq-dir button").forEach(b => b.addEventListener("click", () => {
    if (!gpm.ready || b.dataset.dir === gpm.dir) return;
    const m = gpm.meta;
    setCut(b.dataset.dir, b.dataset.dir === "along" ? Math.floor(m.nray / 2) : Math.floor(m.nscan / 2));
  }));

  /* ---------- draw-a-box on the globe ---------- */
  let drawing = false, dragStart = null;
  function globeCoords(ev) {
    const r = el.getBoundingClientRect();
    const c = globe.toGlobeCoords(ev.clientX - r.left, ev.clientY - r.top);
    return c && isFinite(c.lat) ? c : null;
  }
  function setDrawing(on) {
    drawing = on;
    $("cq-draw").setAttribute("aria-pressed", String(on));
    $("draw-tip").hidden = !on;
    el.classList.toggle("drawing", on);
    if (globe) {
      globe.controls().enableRotate = !on;
      globe.renderer().domElement.style.touchAction = on ? "none" : "pan-y";
    }
  }
  el.addEventListener("pointerdown", ev => {
    if (!drawing || !globe) return;
    const c = globeCoords(ev);
    if (!c) return;
    dragStart = c;
    el.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  }, true);
  el.addEventListener("pointermove", ev => {
    if (!globe) return;
    if (drawing && dragStart) {
      const c = globeCoords(ev);
      if (c) { cube.box = { lat0: Math.min(dragStart.lat, c.lat), lat1: Math.max(dragStart.lat, c.lat), lon0: Math.min(dragStart.lng, c.lng), lon1: Math.max(dragStart.lng, c.lng) }; cube.probe = null; refreshBox(); }
      return;
    }
    if (mode !== "cube" || !cube.ready || ev.pointerType === "touch") return;
    const c = globeCoords(ev);
    if (!c || !inCube(c.lat, c.lng)) { $("probe").textContent = ""; return; }
    const v = getter(cube.varKey)(cube.t, iy(c.lat) * cube.meta.nx + ix(c.lng));
    $("probe").textContent = `${fmtLL(c.lat, c.lng, 2)} · ${fmtV(v)}`;
  });
  el.addEventListener("pointerleave", () => { if (!dragStart) $("probe").textContent = ""; });
  el.addEventListener("pointerup", ev => {
    if (!drawing || !dragStart) return;
    const c = globeCoords(ev) || dragStart;
    const b = { lat0: dragStart.lat, lat1: c.lat, lon0: dragStart.lng, lon1: c.lng };
    dragStart = null;
    setDrawing(false);
    setBox(b, null);
  }, true);

  /* =====================================================================
     Modes, tabs, globe
     ===================================================================== */
  const MODES = ["live", "cube", "gpm"];
  function setMode(m) {
    if (m === mode && globe) { globe.pointOfView(m === "live" ? HOME : m === "cube" ? CUBE_VIEW : GPM_VIEW, 1200); return; }
    mode = m;
    MODES.forEach(k => {
      const on = k === m;
      $("tab-" + k).setAttribute("aria-selected", String(on)); $("tab-" + k).tabIndex = on ? 0 : -1;
      $("pane-" + k).hidden = !on; $("key-" + k).hidden = !on;
    });
    $("probe").textContent = "";
    if (m !== "cube") { if (cube.playing) play(); setDrawing(false); }
    if (m !== "live") { following = false; $("sc-follow").setAttribute("aria-pressed", "false"); $("sc-follow").textContent = "Follow it"; }
    if (globe) globe.pointOfView(m === "live" ? HOME : m === "cube" ? CUBE_VIEW : GPM_VIEW, 1200);
    refreshTiles(); refreshSats(); refreshPaths(); refreshPoints(); refreshBox();
    buildCurtain();
    if (m === "cube") initCube();
    if (m === "gpm") initGpm();
  }

  MODES.forEach((k, i) => {
    $("tab-" + k).addEventListener("click", () => setMode(k));
    $("tab-" + k).addEventListener("keydown", e => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const next = MODES[(i + (e.key === "ArrowRight" ? 1 : MODES.length - 1)) % MODES.length];
      setMode(next); $("tab-" + next).focus();
    });
  });
  const tryBtn = $("try-cube");
  if (tryBtn) tryBtn.addEventListener("click", () => setMode("cube"));
  $("cq-t").addEventListener("input", e => { if (cube.ready) setTime(+e.target.value); });
  $("cq-play").addEventListener("click", () => { if (cube.ready) play(); });
  $("cq-draw").addEventListener("click", () => { if (cube.ready) setDrawing(!drawing); });
  $("cq-spark").addEventListener("click", e => {
    if (!cube.ready) return;
    const r = e.currentTarget.getBoundingClientRect();
    setTime(Math.round((e.clientX - r.left) / r.width * (cube.meta.times.length - 1)));
  });
  $("sc-close").addEventListener("click", () => selectSat(null));
  $("sc-follow").addEventListener("click", e => {
    following = !following;
    e.currentTarget.setAttribute("aria-pressed", String(following));
    e.currentTarget.textContent = following ? "Following. Click to stop" : "Follow it";
  });
  [["lay-swarm", "swarm"], ["lay-path", "path"], ["lay-rain", "rain"], ["lay-clouds", "clouds"], ["lay-hsaf", "hsaf"], ["lay-tc", "tc"]].forEach(([id, k]) => {
    $(id).addEventListener("change", e => { show[k] = e.target.checked; refreshSats(); refreshPaths(); refreshPoints(); refreshTiles(); });
  });

  if (window.Globe && webgl) {
    globe = new Globe(el, { animateIn: true })
      .backgroundColor("rgba(0,0,0,0)")
      .globeImageUrl("https://unpkg.com/three-globe@2.31.0/example/img/earth-blue-marble.jpg")
      .atmosphereColor("#8FB8FF")
      .atmosphereAltitude(0.16)
      .pointOfView(HOME, 0)
      .pointLat("lat").pointLng("lng")
      .pointColor(d => d.probe ? "#F2D13A" : rainColor(d.mm))
      .pointAltitude(d => d.probe ? 0.03 : 0.006 + Math.min(d.mm || 0, 12) * 0.012)
      .pointRadius(d => d.probe ? 0.25 : 0.55)
      .pointLabel(d => d.probe ? "" : `<b>${d.name}</b><br>${d.mm == null ? "no reading" : d.mm > 0 ? d.mm + " mm rain in the last 15 min" : "dry right now"}`)
      .pathPoints("pts").pathPointLat(p => p[0]).pathPointLng(p => p[1]).pathPointAlt(p => p[2])
      .pathColor(d => d.color).pathStroke(1.6).pathTransitionDuration(0)
      .polygonCapColor(() => "rgba(242,209,58,0.10)").polygonSideColor(() => "rgba(0,0,0,0)")
      .polygonStrokeColor(() => "#F2D13A").polygonAltitude(0.012).polygonsTransitionDuration(0)
      .htmlLat("lat").htmlLng("lng").htmlAltitude("alt").htmlTransitionDuration(0)
      .htmlElement(s => s.el || makeSatEl(s))
      .tileLat("lat").tileLng("lng").tileWidth("w").tileHeight("h").tileAltitude("alt")
      .tileMaterial(d => d.mat).tileCurvatureResolution(1).tilesTransitionDuration(0)
      .onTileClick((d, ev, c) => { if (c && d.onClick) d.onClick(c.lat, c.lng); })
      .onGlobeClick(c => { queryPoint(c.lat, c.lng); pickFootprint(c.lat, c.lng); });
    if (typeof globe.htmlElementVisibilityModifier === "function") {
      globe.htmlElementVisibilityModifier((e, visible) => { e.style.opacity = visible ? 1 : 0; e.style.pointerEvents = visible ? "auto" : "none"; });
    }
    const ctl = globe.controls();
    ctl.enableZoom = false;
    ctl.enablePan = false;
    ctl.minDistance = 130;
    const sizeIt = () => {
      const w = el.clientWidth;
      globe.width(w).height(w);
      if (!drawing) globe.renderer().domElement.style.touchAction = "pan-y";
    };
    sizeIt();
    if ("ResizeObserver" in window) new ResizeObserver(sizeIt).observe(el);
    const zoom = f => { const p = globe.pointOfView(); globe.pointOfView({ altitude: clamp(p.altitude * f, 0.35, 4) }, 400); };
    $("zin").addEventListener("click", () => zoom(0.7));
    $("zout").addEventListener("click", () => zoom(1.4));
  } else {
    document.querySelector(".zoom").hidden = true;
  }

  (async () => {
    try { await loadSats(); } catch (e) {}
    if (!sats.length) {
      $("live-dot").classList.add("off");
      $("live-status").textContent = "Live orbit data is unavailable right now.";
      return;
    }
    $("live-status").textContent = "Live: satellite positions and rain";
    $("swarm-n").textContent = `(${sats.length})`;
    tick(); refreshSats(); refreshPaths(); nextPass();
    setInterval(tick, 1000);
    setInterval(() => { refreshPaths(); nextPass(); }, 60e3);
  })();
  loadRain().catch(() => { $("r-rain").textContent = "Unavailable"; });
  if (globe) {
    loadLiveLayers().catch(() => { $("r-msg").textContent = "Unavailable"; });
    setInterval(() => loadLiveLayers().catch(() => {}), 15 * 60e3);
  }
  loadCyclones().catch(() => { $("r-tc").textContent = "Unavailable"; });
  setInterval(() => loadRain().catch(() => {}), 10 * 60e3);
})();
