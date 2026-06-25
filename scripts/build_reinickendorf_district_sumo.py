import argparse
import gzip
import json
import os
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from pyproj import Transformer


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_EV_DASHBOARD = PROJECT_ROOT.parent / "EV Mobility Dashboard"
BEST_SUMO_DIR = (
    DEFAULT_EV_DASHBOARD / "data" / "raw" / "best-scenario" / "scenario" / "sumo"
)
SUMO_ROOT = Path(r"C:\Program Files (x86)\Eclipse\Sumo")

BOUNDARY_DIR = PROJECT_ROOT / "data" / "source" / "berlin-boundaries"
OUT_DIR = PROJECT_ROOT / "data" / "intermediate" / "sumo" / "reinickendorf-district"

WFS_URL = "https://gdi.berlin.de/services/wfs/alkis_bezirke"
TYPE_NAME = "alkis_bezirke:bezirksgrenzen"
TARGET_BEZIRK = "Reinickendorf"
SUMO_NET_OFFSET = (-372355.98, -5804722.35)


def download_berlin_bezirke() -> dict:
    params = {
        "service": "WFS",
        "version": "2.0.0",
        "request": "GetFeature",
        "typenames": TYPE_NAME,
        "outputFormat": "application/json",
    }
    url = f"{WFS_URL}?{urlencode(params)}"
    request = Request(url, headers={"User-Agent": "robotaxi-control-room-data-builder"})
    with urlopen(request, timeout=90) as response:
        return json.loads(response.read().decode("utf-8"))


def distance_to_segment(point, start, end):
    px, py = point
    sx, sy = start
    ex, ey = end
    dx = ex - sx
    dy = ey - sy
    if dx == 0 and dy == 0:
        return ((px - sx) ** 2 + (py - sy) ** 2) ** 0.5
    t = max(0, min(1, ((px - sx) * dx + (py - sy) * dy) / (dx * dx + dy * dy)))
    nx = sx + t * dx
    ny = sy + t * dy
    return ((px - nx) ** 2 + (py - ny) ** 2) ** 0.5


def simplify_ring(points, tolerance_m):
    if len(points) <= 3:
        return points

    closed = points[0] == points[-1]
    work = points[:-1] if closed else points

    def recurse(seq):
        if len(seq) <= 2:
            return seq
        start = seq[0]
        end = seq[-1]
        distances = [distance_to_segment(point, start, end) for point in seq[1:-1]]
        if not distances:
            return [start, end]
        max_distance = max(distances)
        if max_distance <= tolerance_m:
            return [start, end]
        split = distances.index(max_distance) + 1
        return recurse(seq[: split + 1])[:-1] + recurse(seq[split:])

    simplified = recurse(work)
    if closed and simplified[0] != simplified[-1]:
        simplified.append(simplified[0])
    return simplified


def polygon_area(ring):
    area = 0.0
    for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
        area += (x1 * y2) - (x2 * y1)
    return abs(area) / 2


def find_feature(feature_collection, bezirk_name):
    matches = [
        feature
        for feature in feature_collection["features"]
        if feature.get("properties", {}).get("namgem") == bezirk_name
    ]
    if len(matches) != 1:
        names = [f.get("properties", {}).get("namgem") for f in feature_collection["features"]]
        raise RuntimeError(f"Expected one {bezirk_name} feature, found {len(matches)}. Names: {names}")
    return matches[0]


def feature_to_wgs84(feature):
    transformer = Transformer.from_crs("EPSG:25833", "EPSG:4326", always_xy=True)

    def convert_pair(pair):
        lon, lat = transformer.transform(pair[0], pair[1])
        return [round(lon, 7), round(lat, 7)]

    geometry = feature["geometry"]
    if geometry["type"] != "MultiPolygon":
        raise RuntimeError(f"Expected MultiPolygon, got {geometry['type']}")

    return {
        "type": "Feature",
        "id": feature.get("id"),
        "properties": {
            **feature.get("properties", {}),
            "source": "Berlin ALKIS Bezirke WFS",
            "sourceUrl": WFS_URL,
            "sourceTypeName": TYPE_NAME,
            "sourceCrs": "EPSG:25833",
            "targetCrs": "EPSG:4326",
        },
        "geometry": {
            "type": "MultiPolygon",
            "coordinates": [
                [[convert_pair(pair) for pair in ring] for ring in polygon]
                for polygon in geometry["coordinates"]
            ],
        },
    }


def to_sumo_boundary(feature, tolerance_m):
    rings = []
    for polygon in feature["geometry"]["coordinates"]:
        outer = [(float(x), float(y)) for x, y in polygon[0]]
        rings.append(outer)
    outer_ring = max(rings, key=polygon_area)
    simplified = simplify_ring(outer_ring, tolerance_m)
    ox, oy = SUMO_NET_OFFSET
    sumo_points = [(x + ox, y + oy) for x, y in simplified]
    boundary = " ".join(f"{x:.2f},{y:.2f}" for x, y in sumo_points)
    return boundary, sumo_points, len(outer_ring), len(simplified)


def run(command, cwd, env=None):
    print(" ".join(str(part) for part in command))
    subprocess.run(command, cwd=cwd, check=True, env=env)


def gzip_if_needed(path):
    if not path.exists():
        return
    gzip_path = Path(f"{path}.gz")
    with path.open("rb") as source, gzip.open(gzip_path, "wb") as target:
        shutil.copyfileobj(source, target)
    path.unlink()


def read_net_edges(net_path):
    edge_ids = set()
    for event, elem in ET.iterparse(net_path, events=("end",)):
        if elem.tag == "edge" and elem.get("function") != "internal":
            edge_ids.add(elem.attrib["id"])
        elem.clear()
    return edge_ids


def open_text(path, mode):
    if str(path).endswith(".gz"):
        return gzip.open(path, mode, encoding="utf-8")
    return open(path, mode, encoding="utf-8")


def write_strict_contained_routes(source_routes, output_path, valid_edges):
    should_gzip = str(output_path).endswith(".gz")
    raw_path = output_path.with_suffix("") if should_gzip else output_path
    total = 0
    kept = 0
    rejected = 0
    vtypes = []

    with open_text(source_routes, "rt") as source, raw_path.open("w", encoding="utf-8", newline="\n") as out:
        out.write('<?xml version="1.0" encoding="UTF-8"?>\n')
        out.write("<!-- generated by build_reinickendorf_district_sumo.py strict-contained mode -->\n")
        out.write('<routes xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://sumo.dlr.de/xsd/routes_file.xsd">\n')

        root = None
        for event, elem in ET.iterparse(source, events=("start", "end")):
            if root is None and event == "start":
                root = elem
                continue
            if event != "end":
                continue

            if elem.tag == "vType":
                vtypes.append(ET.tostring(elem, encoding="unicode"))
                elem.clear()
                continue

            if elem.tag != "vehicle":
                continue

            total += 1
            route = elem.find("route")
            route_edges = route.get("edges", "").split() if route is not None else []
            if route_edges and all(edge in valid_edges for edge in route_edges):
                if kept == 0:
                    for vtype in vtypes:
                        out.write(f"    {vtype}\n")
                out.write(f"    {ET.tostring(elem, encoding='unicode')}\n")
                kept += 1
            else:
                rejected += 1
            elem.clear()
            if root is not None:
                root.clear()

        out.write("</routes>\n")

    if should_gzip:
        gzip_if_needed(raw_path)
    return {"totalVehicles": total, "keptVehicles": kept, "rejectedVehicles": rejected}


def main():
    parser = argparse.ArgumentParser(
        description="Build a TXL-inclusive official Reinickendorf SUMO cutout from BeST Berlin."
    )
    parser.add_argument("--best-sumo-dir", type=Path, default=BEST_SUMO_DIR)
    parser.add_argument("--sumo-root", type=Path, default=SUMO_ROOT)
    parser.add_argument("--out-dir", type=Path, default=OUT_DIR)
    parser.add_argument("--boundary-dir", type=Path, default=BOUNDARY_DIR)
    parser.add_argument(
        "--simplify-tolerance-m",
        type=float,
        default=20.0,
        help="Douglas-Peucker tolerance for the district polygon before passing it to netconvert.",
    )
    parser.add_argument("--skip-routes", action="store_true")
    parser.add_argument(
        "--route-mode",
        choices=["strict-contained", "touching-cutroutes"],
        default="strict-contained",
        help=(
            "strict-contained keeps only original routes whose every edge exists in the cutout; "
            "touching-cutroutes uses SUMO cutRoutes.py and may include clipped routes."
        ),
    )
    args = parser.parse_args()

    netconvert = args.sumo_root / "bin" / "netconvert.exe"
    cut_routes = args.sumo_root / "tools" / "route" / "cutRoutes.py"
    sumo_env = os.environ.copy()
    sumo_env["SUMO_HOME"] = str(args.sumo_root)

    for path in [args.best_sumo_dir / "berlin.net.xml", args.best_sumo_dir / "berlin.rou.gz", netconvert, cut_routes]:
        if not path.exists():
            raise FileNotFoundError(path)

    args.boundary_dir.mkdir(parents=True, exist_ok=True)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    (args.out_dir / "output").mkdir(exist_ok=True)

    bezirke = download_berlin_bezirke()
    all_bezirke_path = args.boundary_dir / "alkis-bezirke-epsg25833.geojson"
    all_bezirke_path.write_text(json.dumps(bezirke, separators=(",", ":")), encoding="utf-8")

    reinickendorf = find_feature(bezirke, TARGET_BEZIRK)
    reinickendorf_wgs84 = feature_to_wgs84(reinickendorf)
    reinickendorf_path = args.boundary_dir / "reinickendorf-bezirk.geojson"
    reinickendorf_path.write_text(
        json.dumps(
            {"type": "FeatureCollection", "features": [reinickendorf_wgs84]},
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )

    boundary, sumo_points, source_points, simplified_points = to_sumo_boundary(
        reinickendorf, args.simplify_tolerance_m
    )
    boundary_path = args.boundary_dir / "reinickendorf-bezirk.sumo-boundary.txt"
    boundary_path.write_text(boundary + "\n", encoding="utf-8")

    metadata = {
        "id": "reinickendorf-district",
        "name": "Official Bezirk Reinickendorf SUMO cutout",
        "sourceBoundary": {
            "provider": "Geoportal Berlin / ALKIS Berlin Bezirke WFS",
            "url": WFS_URL,
            "typeName": TYPE_NAME,
            "featureId": reinickendorf.get("id"),
            "properties": reinickendorf.get("properties", {}),
            "sourceCrs": "EPSG:25833",
        },
        "sumoProjection": {
            "sourceNet": str((args.best_sumo_dir / "berlin.net.xml").resolve()),
            "projParameter": "+proj=utm +zone=33 +ellps=WGS84 +datum=WGS84 +units=m +no_defs",
            "netOffset": list(SUMO_NET_OFFSET),
            "conversion": "sumoX=easting+netOffsetX; sumoY=northing+netOffsetY",
        },
        "simplification": {
            "toleranceM": args.simplify_tolerance_m,
            "sourceOuterRingPoints": source_points,
            "boundaryPoints": simplified_points,
        },
        "outputs": {
            "net": str((args.out_dir / "reinickendorf-district.net.xml").resolve()),
            "routes": str((args.out_dir / "reinickendorf-district-contained.rou.xml").resolve()),
            "config": str((args.out_dir / "reinickendorf-district.sumocfg").resolve()),
        },
    }
    (args.out_dir / "metadata.json").write_text(
        json.dumps(metadata, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    net_path = args.out_dir / "reinickendorf-district.net.xml"
    run(
        [
            netconvert,
            "-s",
            args.best_sumo_dir / "berlin.net.xml",
            "-o",
            net_path,
            "--keep-edges.in-boundary",
            boundary,
            "-v",
        ],
        cwd=PROJECT_ROOT,
        env=sumo_env,
    )

    route_raw_path = args.out_dir / "reinickendorf-district-contained.rou.xml"
    route_path = route_raw_path
    route_stats = None
    if not args.skip_routes:
        if args.route_mode == "touching-cutroutes":
            route_raw_path = args.out_dir / "reinickendorf-district-touching.rou.xml"
            route_path = Path(f"{route_raw_path}.gz")
            run(
                [
                    sys.executable,
                    cut_routes,
                    net_path,
                    args.best_sumo_dir / "berlin.rou.gz",
                    "--routes-output",
                    route_raw_path,
                    "--orig-net",
                    args.best_sumo_dir / "berlin.net.xml",
                ],
                cwd=PROJECT_ROOT,
                env=sumo_env,
            )
            gzip_if_needed(route_raw_path)
        else:
            valid_edges = read_net_edges(net_path)
            route_stats = write_strict_contained_routes(
                args.best_sumo_dir / "berlin.rou.gz",
                route_path,
                valid_edges,
            )
            metadata["routeFilter"] = {
                "mode": "strict-contained",
                "validCutoutEdges": len(valid_edges),
                **route_stats,
                "rule": "Keep only vehicles whose complete original route edge list is present in the cutout network.",
            }
            (args.out_dir / "metadata.json").write_text(
                json.dumps(metadata, indent=2, ensure_ascii=False),
                encoding="utf-8",
            )

    sumocfg = f"""<?xml version="1.0" encoding="UTF-8"?>
<configuration xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://sumo.dlr.de/xsd/sumoConfiguration.xsd">
    <input>
        <net-file value="reinickendorf-district.net.xml"/>
        <route-files value="{route_path.name}"/>
    </input>
    <output>
        <output-prefix value="output/reinickendorf_district_"/>
        <log value="console.log"/>
        <summary-output value="summary.xml"/>
        <statistic-output value="statistics.xml"/>
    </output>
    <time>
        <begin value="0.0"/>
        <end value="86400.0"/>
    </time>
    <processing>
        <route-steps value="200"/>
        <no-internal-links value="false"/>
        <ignore-junction-blocker value="20"/>
        <time-to-teleport value="120.0"/>
        <time-to-teleport.highways value="0"/>
        <eager-insert value="false"/>
    </processing>
    <random_number>
        <random value="false"/>
        <seed value="251920"/>
    </random_number>
</configuration>
"""
    (args.out_dir / "reinickendorf-district.sumocfg").write_text(sumocfg, encoding="utf-8")

    print(f"Wrote boundary: {boundary_path}")
    print(f"Wrote network:  {net_path}")
    if route_path.exists():
        print(f"Wrote routes:   {route_path}")
    if route_stats:
        print(
            "Route filter: "
            f"kept {route_stats['keptVehicles']} / {route_stats['totalVehicles']} vehicles "
            f"({route_stats['rejectedVehicles']} rejected)"
        )
    print(f"Wrote config:   {args.out_dir / 'reinickendorf-district.sumocfg'}")


if __name__ == "__main__":
    main()
