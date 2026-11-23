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
  const show = { swarm: true, path: true, rain: true };

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
    if (mode === "live") data = show.swarm ? sats : sats.filter(s => s.main);
    else data = sats.filter(s => s.id === 41752);
    globe.htmlElementsData(data);
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
    }
    globe.pathsData(paths);
  }
  function refreshPoints() {
    if (!globe) return;
    if (mode === "live") globe.pointsData(show.rain ? CITIES : []);
    else globe.pointsData(cube.probe ? [cube.probe] : []);
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
    if (cube.overlay || !globe) return !!cube.overlay;
    const gm = globe.globeMaterial();
    if (!gm || !gm.map) return false;
    const { nx, ny, lat0, lat1, lon0, lon1 } = cube.meta;
    const canvas = document.createElement("canvas");
    canvas.width = nx; canvas.height = ny;
    const tex = new gm.map.constructor(canvas);
    if (gm.map.colorSpace) tex.colorSpace = gm.map.colorSpace;
    tex.needsUpdate = true;
    const mat = new gm.constructor({ map: tex, transparent: true, depthWrite: false, shininess: 0 });
    cube.overlay = { canvas, ctx: canvas.getContext("2d"), tex, mat, img: new ImageData(nx, ny) };
    // box fill that never hides the data under it
    const capMat = new gm.constructor({ color: 0xF2D13A, transparent: true, opacity: 0.07, depthWrite: false, shininess: 0 });
    const sideMat = new gm.constructor({ color: 0xF2D13A, transparent: true, opacity: 0, depthWrite: false });
    globe.polygonCapMaterial(() => capMat).polygonSideMaterial(() => sideMat);
    globe.tileLat("lat").tileLng("lng").tileWidth("w").tileHeight("h")
      .tileAltitude(0.006).tileCurvatureResolution(1).tilesTransitionDuration(0)
      .tileMaterial(() => mat)
      .onTileClick((d, ev, c) => c && queryPoint(c.lat, c.lng));
    cube.tile = [{ lat: (lat0 + lat1) / 2, lng: (lon0 + lon1) / 2, w: lon1 - lon0, h: lat1 - lat0 }];
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
    for (let i = 0; i < 100 && globe && !ensureOverlay(); i++) await new Promise(r => setTimeout(r, 100));
    cube.ready = true;
    const start = m.times.indexOf("2023-06-15T12:15Z");
    cube.t = start >= 0 ? start : 0;
    cube.box = PRESETS[0];
    legend();
    if (mode === "cube" && globe && cube.tile) globe.tilesData(cube.tile);
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
  function setMode(m) {
    mode = m;
    const live = m === "live";
    $("tab-live").setAttribute("aria-selected", String(live)); $("tab-live").tabIndex = live ? 0 : -1;
    $("tab-cube").setAttribute("aria-selected", String(!live)); $("tab-cube").tabIndex = live ? -1 : 0;
    $("pane-live").hidden = !live; $("pane-cube").hidden = live;
    $("key-live").hidden = !live; $("key-cube").hidden = live;
    $("probe").textContent = "";
    if (live) {
      if (cube.playing) play();
      setDrawing(false);
    } else {
      following = false;
      $("sc-follow").setAttribute("aria-pressed", "false");
      $("sc-follow").textContent = "Follow it";
    }
    if (globe) {
      globe.tilesData(!live && cube.tile ? cube.tile : []);
      globe.pointOfView(live ? HOME : CUBE_VIEW, 1200);
    }
    refreshSats(); refreshPaths(); refreshPoints(); refreshBox();
    if (!live) initCube();
  }

  ["tab-live", "tab-cube"].forEach(id => {
    $(id).addEventListener("click", () => setMode(id === "tab-live" ? "live" : "cube"));
    $(id).addEventListener("keydown", e => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const other = id === "tab-live" ? "tab-cube" : "tab-live";
      setMode(other === "tab-live" ? "live" : "cube"); $(other).focus();
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
  [["lay-swarm", "swarm"], ["lay-path", "path"], ["lay-rain", "rain"]].forEach(([id, k]) => {
    $(id).addEventListener("change", e => { show[k] = e.target.checked; refreshSats(); refreshPaths(); refreshPoints(); });
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
      .onGlobeClick(c => queryPoint(c.lat, c.lng));
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
  setInterval(() => loadRain().catch(() => {}), 10 * 60e3);
})();
