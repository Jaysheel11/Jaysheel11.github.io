"""Fetch the newest INSAT-3DR / INSAT-3DS Hydro-Estimator (HEM) rain map from MOSDAC Live.

MOSDAC's map server does not allow other websites to load its images directly (no CORS),
so a scheduled GitHub Action runs this script and publishes the result on the `live-data`
branch, where the globe can read it.

Output (in the folder given as the first argument):
  hem.png   8-bit greyscale, value = rain rate * 255 / MAX_MM (0 = no rain or no data)
  hem.json  time, satellite, source file, bounding box and scale

Data: MOSDAC, SAC/ISRO (https://mosdac.gov.in). Non-commercial use with credit.
"""
import io, json, os, sys, time, datetime as dt, urllib.request

from PIL import Image

OUT = sys.argv[1] if len(sys.argv) > 1 else "out"
BBOX = (25.0, -40.0, 125.0, 45.0)   # lon0, lat0, lon1, lat1
W, H = 1000, 850                    # 0.1 degree grid
MAX_MM = 50.0                       # rain rates at or above this saturate
SATS = [("3R", "Insat3r", "INSAT-3DR"), ("3S", "Insat3s", "INSAT-3DS")]
BASE = "https://mosdac.gov.in"
UA = {"User-Agent": "portfolio-globe/1.0 (scheduled fetch, twice an hour)"}


def get(url, tries=3):
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90) as r:
                return r.read(), r.headers.get("Content-Type", "")
        except Exception as e:
            if k == tries - 1:
                raise
            print("retry", url[:90], e)
            time.sleep(5 * (k + 1))


def latest(code):
    q = f"{BASE}/live/backend/satellite_latest.php?file_prefix={code}IMG&file_extension=L2B_HEM&param=addlayer&timezone=utc&timezone_formal=0"
    body = get(q)[0].decode("utf-8", "replace")
    best = None
    for item in body.replace(";", ",").split(","):
        if "&" not in item:
            continue
        name = item.split("&", 1)[1].split("*", 1)[0].strip()
        p = name.split("_")
        try:
            t = dt.datetime.strptime(p[1] + p[2], "%d%b%Y%H%M").replace(tzinfo=dt.timezone.utc)
        except (IndexError, ValueError):
            continue
        if best is None or t > best[0]:
            best = (t, name)
    return best


def main():
    found = []
    for code, folder, label in SATS:
        try:
            r = latest(code)
            if r:
                found.append((r[0], r[1], code, folder, label))
                print(label, r[1])
        except Exception as e:
            print(label, "listing failed:", e)
    if not found:
        sys.exit("no HEM files listed")
    t, name, code, folder, label = max(found)
    day = name.split("_")[1]                       # e.g. 23NOV2026
    url = (f"{BASE}/live_data/wms/live{code}L2BHEM/products/{folder}/{code}_IMG/{day[5:]}/{day[:5]}/{name}"
           f"?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=HEM&STYLES=boxfill/greyscale&SRS=EPSG:4326"
           f"&BBOX={','.join(str(v) for v in BBOX)}&WIDTH={W}&HEIGHT={H}&FORMAT=image/png"
           f"&COLORSCALERANGE=0,{MAX_MM:g}&NUMCOLORBANDS=250&ABOVEMAXCOLOR=extend&BELOWMINCOLOR=extend")
    data, ctype = get(url)
    if "image/png" not in ctype:
        sys.exit(f"map request returned {ctype}: {data[:200]!r}")
    im = Image.open(io.BytesIO(data)).convert("RGBA")
    if im.size != (W, H):
        sys.exit(f"unexpected size {im.size}")
    r, g, b, a = im.split()
    grey = Image.composite(r, Image.new("L", im.size, 0), a)   # see-through pixels count as no rain
    wet = sum(grey.histogram()[2:])                            # pixels above ~0.4 mm/h
    os.makedirs(OUT, exist_ok=True)
    grey.save(os.path.join(OUT, "hem.png"), optimize=True)
    meta = {
        "product": "Hydro-Estimator rain rate (L2B HEM)",
        "satellite": label,
        "file": name,
        "time": t.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "fetched": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "bbox": {"lon0": BBOX[0], "lat0": BBOX[1], "lon1": BBOX[2], "lat1": BBOX[3]},
        "width": W, "height": H,
        "unit": "mm/h", "scale": MAX_MM / 255,
        "wet_fraction": round(wet / (W * H), 4),
        "credit": "MOSDAC, SAC/ISRO",
    }
    with open(os.path.join(OUT, "hem.json"), "w") as f:
        json.dump(meta, f, indent=1)
    print(json.dumps(meta))


if __name__ == "__main__":
    main()
