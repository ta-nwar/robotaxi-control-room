import asyncio
import json
import math
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from functools import lru_cache
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware


APP_DIR = Path(__file__).resolve().parent
SUMO_DISTRICT_SCENARIO_DIR = APP_DIR / "sumo" / "reinickendorf-district"
SUMO_START_SEC = 21_600
SUMO_END_SEC = 25_200
SUMO_WINDOW_LABEL = "06:00-07:00"
DEFAULT_SUMO_DELAY_MS = 0
MAX_SUMO_DELAY_MS = 1000
FAST_SIM_BURST_STEPS = 500
PLAYBACK_SCOPE = "reinickendorf-district"
PLAYBACK_DATA_FPS = 50
PLAYBACK_DEFAULT_RATE = 10
PLAYBACK_SPEEDS = {5, 10, 25, 50, 100, 250}
PLAYBACK_CHUNK_SIM_SECONDS = 10

SUMO_SCENARIOS: dict[str, dict[str, Any]] = {
    "reinickendorf-district": {
        "key": "reinickendorf-district",
        "label": "Official Reinickendorf district",
        "dir": SUMO_DISTRICT_SCENARIO_DIR,
        "config": SUMO_DISTRICT_SCENARIO_DIR / "reinickendorf-district.sumocfg",
        "net": SUMO_DISTRICT_SCENARIO_DIR / "reinickendorf-district.net.xml",
        "route": SUMO_DISTRICT_SCENARIO_DIR / "reinickendorf-district-contained.rou.xml",
        "boundary": SUMO_DISTRICT_SCENARIO_DIR / "reinickendorf-district.geojson",
        "depotEdge": None,
        "startSec": SUMO_START_SEC,
        "endSec": SUMO_END_SEC,
        "networkMaxLanes": None,
        "includeInternalLanes": True,
        "includeSignalLinks": True,
    },
}

app = FastAPI(title="Robotaxi SUMO Backend", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin for origin in os.getenv("ALLOW_ORIGINS", "*").split(",") if origin],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_sumo_scenario(key: str | None) -> dict[str, Any]:
    scenario_key = (key or "reinickendorf-district").lower()
    if scenario_key not in SUMO_SCENARIOS:
        known_scopes = ", ".join(sorted(SUMO_SCENARIOS))
        raise HTTPException(
            status_code=404,
            detail=f"Unknown SUMO scope '{scenario_key}'. Known scopes: {known_scopes}",
        )
    return SUMO_SCENARIOS[scenario_key]


def parse_playback_rate(websocket: WebSocket) -> int:
    raw_speed = websocket.query_params.get("speed")
    try:
        speed = int(raw_speed) if raw_speed is not None else PLAYBACK_DEFAULT_RATE
    except (TypeError, ValueError):
        return PLAYBACK_DEFAULT_RATE
    return speed if speed in PLAYBACK_SPEEDS else PLAYBACK_DEFAULT_RATE


def find_sumo_home() -> Path | None:
    configured_home = os.getenv("SUMO_HOME")
    if configured_home and Path(configured_home).exists():
        return Path(configured_home)

    windows_home = Path(r"C:\Program Files (x86)\Eclipse\Sumo")
    if windows_home.exists():
        return windows_home

    linux_home = Path("/usr/share/sumo")
    if linux_home.exists():
        return linux_home

    return None


def find_sumo_binary() -> str | None:
    configured_binary = os.getenv("SUMO_BINARY")
    if configured_binary and Path(configured_binary).exists():
        return configured_binary

    path_binary = shutil.which("sumo")
    if path_binary:
        return path_binary

    sumo_home = find_sumo_home()
    if not sumo_home:
        return None

    candidate = sumo_home / "bin" / ("sumo.exe" if os.name == "nt" else "sumo")
    return str(candidate) if candidate.exists() else None


def ensure_traci_import() -> Any:
    ensure_sumo_tools()

    import traci  # type: ignore[import-not-found]

    return traci


def ensure_sumo_tools() -> None:
    sumo_home = find_sumo_home()
    if sumo_home:
        tools_path = sumo_home / "tools"
        if tools_path.exists() and str(tools_path) not in sys.path:
            sys.path.append(str(tools_path))


def sumo_version() -> dict[str, Any]:
    sumo_binary = find_sumo_binary()
    if not sumo_binary:
        return {"available": False, "error": "sumo binary not found"}

    try:
        result = subprocess.run(
            [sumo_binary, "--version"],
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
        return {
            "available": result.returncode == 0,
            "binary": sumo_binary,
            "returnCode": result.returncode,
            "stdout": result.stdout.strip(),
            "stderr": result.stderr.strip(),
        }
    except FileNotFoundError:
        return {"available": False, "error": "sumo binary not found"}
    except subprocess.TimeoutExpired:
        return {"available": False, "error": "sumo --version timed out"}


@app.get("/health")
def health() -> dict[str, Any]:
    sumo = sumo_version()
    files = packaged_sumo_files()
    return {
        "ok": bool(sumo["available"] and all(files.values())),
        "service": "robotaxi-sumo-backend",
        "scope": "reinickendorf-district",
        "sumoAvailable": sumo["available"],
        "packagedFiles": files,
    }


@app.get("/sumo/version")
def get_sumo_version() -> dict[str, Any]:
    return sumo_version()


def packaged_sumo_files(sumo_scenario: dict[str, Any] | None = None) -> dict[str, bool]:
    selected = sumo_scenario or get_sumo_scenario(None)
    return {
        "net": selected["net"].exists(),
        "routes": selected["route"].exists(),
        "config": selected["config"].exists(),
    }


@lru_cache(maxsize=8)
def load_geojson(path_value: str | None) -> dict[str, Any] | None:
    if not path_value:
        return None
    path = Path(path_value)
    if not path.exists():
        return None
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


@lru_cache(maxsize=8)
def load_sumo_projection(net_path_value: str | None) -> tuple[tuple[float, float], int]:
    net_path = Path(net_path_value) if net_path_value else get_sumo_scenario(None)["net"]
    root = ET.parse(net_path).getroot()
    location = root.find("location")
    if location is None:
        raise ValueError("SUMO network location metadata is missing.")

    net_offset = parse_pair(location.attrib["netOffset"])
    zone_match = re.search(r"\+zone=(\d+)", location.attrib.get("projParameter", ""))
    utm_zone = int(zone_match.group(1)) if zone_match else 33
    return net_offset, utm_zone


@lru_cache(maxsize=4)
def load_sumo_network(
    net_path_value: str | None = None,
    max_lane_features: int | None = None,
    include_internal_lanes: bool = True,
    include_signal_links: bool = True,
) -> dict[str, Any]:
    net_path = Path(net_path_value) if net_path_value else get_sumo_scenario(None)["net"]
    tree = ET.parse(net_path)
    root = tree.getroot()
    location = root.find("location")
    if location is None:
        raise ValueError("SUMO network location metadata is missing.")

    net_offset, utm_zone = load_sumo_projection(str(net_path))

    lane_features = []
    internal_lane_features = []
    lane_shapes_by_id = {}
    lane_xy_shapes_by_id = {}
    total_lane_count = 0
    total_internal_lane_count = 0
    for edge in root.findall("edge"):
        edge_id = edge.attrib.get("id", "")
        is_internal = edge.attrib.get("function") == "internal" or edge_id.startswith(":")

        for lane in edge.findall("lane"):
            total_lane_count += 1
            if is_internal:
                total_internal_lane_count += 1
                if not include_internal_lanes:
                    continue
            if max_lane_features is not None and (
                len(lane_features) + len(internal_lane_features) >= max_lane_features
            ):
                continue
            lane_id = lane.attrib.get("id", "")
            xy_shape = parse_sumo_xy_shape(lane.attrib.get("shape", ""))
            shape = sumo_xy_shape_to_lonlat(xy_shape, net_offset, utm_zone)
            if len(shape) < 2:
                continue

            lane_shapes_by_id[lane_id] = shape
            lane_xy_shapes_by_id[lane_id] = xy_shape
            feature = {
                "type": "Feature",
                "properties": {
                    "id": lane_id,
                    "edgeId": edge_id,
                    "internal": is_internal,
                    "speed": round(float(lane.attrib.get("speed", 0)), 3),
                    "length": round(float(lane.attrib.get("length", 0)), 3),
                },
                "geometry": {"type": "LineString", "coordinates": shape},
            }
            if is_internal:
                internal_lane_features.append(feature)
            else:
                lane_features.append(feature)

    traffic_light_ids_by_junction = map_traffic_light_ids_by_junction(root)
    traffic_light_features = []
    for junction in root.findall("junction"):
        if junction.attrib.get("type") != "traffic_light":
            continue

        lon, lat = sumo_xy_to_lonlat(
            float(junction.attrib["x"]),
            float(junction.attrib["y"]),
            net_offset,
            utm_zone,
        )
        traffic_light_features.append(
            {
                "type": "Feature",
                "properties": {
                    "id": junction.attrib.get("id"),
                    "trafficLightId": traffic_light_ids_by_junction.get(
                        junction.attrib.get("id", ""),
                        junction.attrib.get("id"),
                    ),
                },
                "geometry": {
                    "type": "Point",
                    "coordinates": [lon, lat],
                },
            }
        )

    signal_records = []
    if include_signal_links:
        connection_elements = root.findall("connection")
    else:
        connection_elements = []
    for connection in connection_elements:
        traffic_light_id = connection.attrib.get("tl")
        link_index = connection.attrib.get("linkIndex")
        via_lane_id = connection.attrib.get("via")
        from_edge_id = connection.attrib.get("from")
        from_lane_index = connection.attrib.get("fromLane")
        if (
            not traffic_light_id
            or link_index is None
            or not via_lane_id
            or not from_edge_id
            or from_lane_index is None
        ):
            continue

        incoming_lane_id = f"{from_edge_id}_{from_lane_index}"
        is_incoming_lane_geometry = incoming_lane_id in lane_xy_shapes_by_id
        xy_shape = lane_xy_shapes_by_id.get(incoming_lane_id)
        if not xy_shape:
            is_incoming_lane_geometry = False
            xy_shape = lane_xy_shapes_by_id.get(via_lane_id)
        if not xy_shape:
            continue

        signal_records.append(
            {
                "traffic_light_id": traffic_light_id,
                "link_index": int(link_index),
                "incoming_lane_id": incoming_lane_id,
                "via_lane_id": via_lane_id,
                "from_edge_id": from_edge_id,
                "to_edge_id": connection.attrib.get("to"),
                "direction": connection.attrib.get("dir"),
                "xy_shape": xy_shape,
                "at_end": is_incoming_lane_geometry,
            }
        )

    signal_records_by_incoming_lane: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for record in signal_records:
        key = (record["traffic_light_id"], record["incoming_lane_id"])
        signal_records_by_incoming_lane.setdefault(key, []).append(record)

    signal_link_features = []
    for records in signal_records_by_incoming_lane.values():
        records.sort(key=lambda record: record["link_index"])
        for slot_index, record in enumerate(records):
            slot_count = len(records)
            signal_link_features.append(
                {
                    "type": "Feature",
                    "properties": {
                        "id": (
                            f"{record['traffic_light_id']}:"
                            f"{record['link_index']}:"
                            f"{record['incoming_lane_id']}"
                        ),
                        "trafficLightId": record["traffic_light_id"],
                        "linkIndex": record["link_index"],
                        "incomingLaneId": record["incoming_lane_id"],
                        "viaLaneId": record["via_lane_id"],
                        "fromEdge": record["from_edge_id"],
                        "toEdge": record["to_edge_id"],
                        "direction": record["direction"],
                    },
                    "geometry": {
                        "type": "LineString",
                        "coordinates": signal_stop_line_coordinates(
                            record["xy_shape"],
                            net_offset,
                            utm_zone,
                            at_end=record["at_end"],
                            slot_index=slot_index,
                            slot_count=slot_count,
                        ),
                    },
                }
            )

    return {
        "lanes": {"type": "FeatureCollection", "features": lane_features},
        "internalLanes": {
            "type": "FeatureCollection",
            "features": internal_lane_features,
        },
        "trafficLights": {
            "type": "FeatureCollection",
            "features": traffic_light_features,
        },
        "signalLinks": {
            "type": "FeatureCollection",
            "features": signal_link_features,
        },
        "counts": {
            "lanes": len(lane_features),
            "internalLanes": len(internal_lane_features),
            "trafficLights": len(traffic_light_features),
            "signalLinks": len(signal_link_features),
            "totalLanes": total_lane_count - total_internal_lane_count,
            "totalInternalLanes": total_internal_lane_count,
        },
        "limited": max_lane_features is not None
        and len(lane_features) + len(internal_lane_features) >= max_lane_features,
    }


def map_traffic_light_ids_by_junction(root: ET.Element) -> dict[str, str]:
    traffic_junction_ids = [
        junction.attrib["id"]
        for junction in root.findall("junction")
        if junction.attrib.get("type") == "traffic_light" and junction.attrib.get("id")
    ]
    traffic_junction_ids.sort(key=len, reverse=True)

    traffic_light_ids_by_junction: dict[str, str] = {}
    for connection in root.findall("connection"):
        traffic_light_id = connection.attrib.get("tl")
        via_lane_id = connection.attrib.get("via", "")
        if not traffic_light_id or not via_lane_id.startswith(":"):
            continue

        internal_lane_id = via_lane_id[1:]
        for junction_id in traffic_junction_ids:
            if internal_lane_id.startswith(f"{junction_id}_"):
                traffic_light_ids_by_junction.setdefault(junction_id, traffic_light_id)
                break

    return traffic_light_ids_by_junction


def parse_pair(value: str) -> tuple[float, float]:
    first, second = value.split(",", maxsplit=1)
    return float(first), float(second)


def parse_sumo_shape(
    shape: str,
    net_offset: tuple[float, float],
    utm_zone: int,
) -> list[list[float]]:
    return sumo_xy_shape_to_lonlat(parse_sumo_xy_shape(shape), net_offset, utm_zone)


def parse_sumo_xy_shape(shape: str) -> list[tuple[float, float]]:
    coordinates = []
    for point in shape.split():
        coordinates.append(parse_pair(point))
    return coordinates


def sumo_xy_shape_to_lonlat(
    xy_shape: list[tuple[float, float]],
    net_offset: tuple[float, float],
    utm_zone: int,
) -> list[list[float]]:
    coordinates = []
    for x, y in xy_shape:
        lon, lat = sumo_xy_to_lonlat(x, y, net_offset, utm_zone)
        coordinates.append([lon, lat])
    return coordinates


def signal_stop_line_coordinates(
    xy_shape: list[tuple[float, float]],
    net_offset: tuple[float, float],
    utm_zone: int,
    at_end: bool = False,
    slot_index: int = 0,
    slot_count: int = 1,
) -> list[list[float]]:
    if len(xy_shape) < 2:
        return sumo_xy_shape_to_lonlat(xy_shape, net_offset, utm_zone)

    if at_end:
        anchor_x, anchor_y = xy_shape[-1]
        previous_x, previous_y = xy_shape[-2]
        dx = anchor_x - previous_x
        dy = anchor_y - previous_y
    else:
        anchor_x, anchor_y = xy_shape[0]
        next_x, next_y = xy_shape[1]
        dx = next_x - anchor_x
        dy = next_y - anchor_y

    length = math.hypot(dx, dy)
    if length == 0:
        return sumo_xy_shape_to_lonlat(xy_shape[:2], net_offset, utm_zone)

    half_width_m = 3.0
    perp_x = -dy / length
    perp_y = dx / length
    safe_slot_count = max(1, slot_count)
    gap_m = 0.75 if safe_slot_count > 1 else 0
    total_width_m = half_width_m * 2
    segment_width_m = max(
        0.35,
        (total_width_m - gap_m * (safe_slot_count - 1)) / safe_slot_count,
    )
    slot_start_m = -half_width_m + slot_index * (segment_width_m + gap_m)
    slot_end_m = slot_start_m + segment_width_m
    endpoints = [
        (anchor_x + perp_x * slot_start_m, anchor_y + perp_y * slot_start_m),
        (anchor_x + perp_x * slot_end_m, anchor_y + perp_y * slot_end_m),
    ]
    return sumo_xy_shape_to_lonlat(endpoints, net_offset, utm_zone)


def sumo_xy_to_lonlat(
    x: float,
    y: float,
    net_offset: tuple[float, float],
    utm_zone: int,
) -> tuple[float, float]:
    easting = x - net_offset[0]
    northing = y - net_offset[1]
    return utm_to_lonlat(easting, northing, utm_zone)


def utm_to_lonlat(easting: float, northing: float, zone: int) -> tuple[float, float]:
    # WGS84 UTM inverse projection. This avoids a heavyweight pyproj dependency
    # for one fixed SUMO network while matching sumolib's conversion closely.
    semi_major = 6_378_137.0
    flattening = 1 / 298.257223563
    scale_factor = 0.9996
    eccentricity = math.sqrt(flattening * (2 - flattening))
    eccentricity_prime_sq = eccentricity**2 / (1 - eccentricity**2)

    x = easting - 500_000.0
    central_meridian = math.radians((zone - 1) * 6 - 180 + 3)
    meridional_arc = northing / scale_factor
    mu = meridional_arc / (
        semi_major
        * (
            1
            - eccentricity**2 / 4
            - 3 * eccentricity**4 / 64
            - 5 * eccentricity**6 / 256
        )
    )

    e1 = (1 - math.sqrt(1 - eccentricity**2)) / (
        1 + math.sqrt(1 - eccentricity**2)
    )
    footpoint_lat = (
        mu
        + (3 * e1 / 2 - 27 * e1**3 / 32) * math.sin(2 * mu)
        + (21 * e1**2 / 16 - 55 * e1**4 / 32) * math.sin(4 * mu)
        + (151 * e1**3 / 96) * math.sin(6 * mu)
        + (1097 * e1**4 / 512) * math.sin(8 * mu)
    )

    sin_lat = math.sin(footpoint_lat)
    cos_lat = math.cos(footpoint_lat)
    tan_lat = math.tan(footpoint_lat)
    c1 = eccentricity_prime_sq * cos_lat**2
    t1 = tan_lat**2
    radius_curvature = semi_major * (1 - eccentricity**2) / (
        (1 - eccentricity**2 * sin_lat**2) ** 1.5
    )
    prime_vertical = semi_major / math.sqrt(1 - eccentricity**2 * sin_lat**2)
    d = x / (prime_vertical * scale_factor)

    latitude = footpoint_lat - (prime_vertical * tan_lat / radius_curvature) * (
        d**2 / 2
        - (5 + 3 * t1 + 10 * c1 - 4 * c1**2 - 9 * eccentricity_prime_sq)
        * d**4
        / 24
        + (
            61
            + 90 * t1
            + 298 * c1
            + 45 * t1**2
            - 252 * eccentricity_prime_sq
            - 3 * c1**2
        )
        * d**6
        / 720
    )
    longitude = central_meridian + (
        d
        - (1 + 2 * t1 + c1) * d**3 / 6
        + (5 - 2 * c1 + 28 * t1 - 3 * c1**2 + 8 * eccentricity_prime_sq + 24 * t1**2)
        * d**5
        / 120
    ) / cos_lat

    return math.degrees(longitude), math.degrees(latitude)


@app.get("/sumo/{scope}/summary")
def sumo_summary(scope: str) -> dict[str, Any]:
    selected = get_sumo_scenario(scope)
    return {
        "available": selected["config"].exists() and find_sumo_binary() is not None,
        "sumo": sumo_version(),
        "scope": selected["key"],
        "label": selected["label"],
        "config": str(selected["config"]),
        "window": {
            "startSec": selected["startSec"],
            "endSec": selected["endSec"],
            "label": SUMO_WINDOW_LABEL,
        },
        "files": packaged_sumo_files(selected),
    }


@app.get("/sumo/{scope}/network")
def sumo_network(scope: str) -> dict[str, Any]:
    selected = get_sumo_scenario(scope)
    if not selected["net"].exists():
        return {"available": False, "error": f"{selected['label']} SUMO net file is missing."}

    try:
        network = load_sumo_network(
            str(selected["net"]),
            selected["networkMaxLanes"],
            selected["includeInternalLanes"],
            selected["includeSignalLinks"],
        )
    except Exception as error:
        return {"available": False, "error": str(error)}

    boundary = load_geojson(str(selected["boundary"])) if selected.get("boundary") else None

    return {"available": True, "scope": selected["key"], "boundary": boundary, **network}


@app.get("/sumo/{scope}/validate")
def validate_sumo_scope(scope: str) -> dict[str, Any]:
    selected = get_sumo_scenario(scope)
    sumo_binary = find_sumo_binary()
    if not sumo_binary:
        return {"ok": False, "error": "sumo binary not found"}

    selected["dir"].mkdir(exist_ok=True)
    (selected["dir"] / "output").mkdir(exist_ok=True)
    sumo_home = find_sumo_home()
    env = os.environ.copy()
    if sumo_home:
        env["SUMO_HOME"] = str(sumo_home)

    command = [
        sumo_binary,
        "-c",
        str(selected["config"]),
        "--begin",
        str(selected["startSec"]),
        "--end",
        str(selected["startSec"] + 10),
        "--step-length",
        "1",
        "--no-step-log",
        "true",
        "--no-warnings",
        "true",
        "--duration-log.disable",
        "true",
        "--quit-on-end",
        "true",
    ]
    result = subprocess.run(
        command,
        cwd=str(selected["dir"]),
        env=env,
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
    )
    return {
        "ok": result.returncode == 0,
        "returnCode": result.returncode,
        "command": command,
        "stdout": result.stdout[-4000:],
        "stderr": result.stderr[-4000:],
    }


@app.get("/sumo/{scope}/playback")
def sumo_playback(scope: str) -> dict[str, Any]:
    selected = get_sumo_scenario(scope)
    return {
        "available": selected["key"] == PLAYBACK_SCOPE
        and selected["config"].exists()
        and find_sumo_binary() is not None,
        "backend": "sumo-traci-playback",
        "scope": selected["key"],
        "window": {
            "startSec": selected["startSec"],
            "endSec": selected["endSec"],
            "label": SUMO_WINDOW_LABEL,
        },
        "playbackRate": PLAYBACK_DEFAULT_RATE,
        "dataFps": PLAYBACK_DATA_FPS,
        "availablePlaybackRates": sorted(PLAYBACK_SPEEDS),
        "chunkSimSeconds": PLAYBACK_CHUNK_SIM_SECONDS,
        "frameStepSec": PLAYBACK_DEFAULT_RATE / PLAYBACK_DATA_FPS,
        "websocket": f"/ws/sumo/{selected['key']}/playback",
        "frameShape": {
            "simSec": "number",
            "vehicles": [{"id": "string", "lon": "number", "lat": "number", "angle": "number"}],
            "trafficLights": {"trafficLightId": "state"},
        },
    }


@app.websocket("/ws/sumo/{scope}/playback")
async def sumo_scope_playback(websocket: WebSocket, scope: str) -> None:
    await websocket.accept()

    try:
        selected = get_sumo_scenario(scope)
    except HTTPException as error:
        await websocket.send_json({"type": "error", "message": error.detail})
        await websocket.close()
        return

    if selected["key"] != PLAYBACK_SCOPE:
        await websocket.send_json(
            {
                "type": "error",
                "message": f"Playback recording is only available for {PLAYBACK_SCOPE}.",
            }
        )
        await websocket.close()
        return

    sumo_binary = find_sumo_binary()
    if not sumo_binary or not selected["config"].exists():
        await websocket.send_json(
            {
                "type": "error",
                "message": f"SUMO binary or {selected['label']} config is unavailable.",
                "sumoAvailable": bool(sumo_binary),
                "configExists": selected["config"].exists(),
            }
        )
        await websocket.close()
        return

    try:
        traci = ensure_traci_import()
    except Exception as error:  # pragma: no cover - runtime environment dependent
        await websocket.send_json({"type": "error", "message": f"TraCI import failed: {error}"})
        await websocket.close()
        return

    playback_rate = parse_playback_rate(websocket)
    frame_step_sec = playback_rate / PLAYBACK_DATA_FPS

    command = [
        sumo_binary,
        "-c",
        str(selected["config"]),
        "--begin",
        str(selected["startSec"]),
        "--end",
        str(selected["endSec"]),
        "--step-length",
        str(frame_step_sec),
        "--no-step-log",
        "true",
        "--quit-on-end",
        "true",
    ]

    sumo_home = find_sumo_home()
    if sumo_home:
        os.environ["SUMO_HOME"] = str(sumo_home)

    stop_event = threading.Event()
    message_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    event_loop = asyncio.get_running_loop()
    connection_label = f"{selected['key']}-playback-{id(websocket)}"
    command_task: asyncio.Task[None] | None = None
    worker_task: asyncio.Task[None] | None = None

    await websocket.send_json(
        {
            "type": "hello",
            "backend": "sumo-traci-playback",
            "scope": selected["key"],
            "window": {"startSec": selected["startSec"], "endSec": selected["endSec"]},
            "playbackRate": playback_rate,
            "dataFps": PLAYBACK_DATA_FPS,
            "chunkSimSeconds": PLAYBACK_CHUNK_SIM_SECONDS,
            "frameStepSec": frame_step_sec,
            "commands": ["stop"],
        }
    )

    async def receive_commands() -> None:
        try:
            while True:
                payload = await websocket.receive_json()
                command_name = str(payload.get("command") or payload.get("type") or "").lower()
                if command_name in {"stop", "close"}:
                    stop_event.set()
                    return
        except WebSocketDisconnect:
            stop_event.set()

    try:
        command_task = asyncio.create_task(receive_commands())
        worker_task = asyncio.create_task(
            asyncio.to_thread(
                produce_sumo_playback_chunks,
                traci,
                command,
                connection_label,
                selected,
                playback_rate,
                frame_step_sec,
                message_queue,
                event_loop,
                stop_event,
            )
        )

        while True:
            if command_task.done():
                command_error = command_task.exception()
                if command_error and not isinstance(command_error, WebSocketDisconnect):
                    raise command_error

            payload = await message_queue.get()
            send_started_at = time.perf_counter()
            await websocket.send_json(payload)
            if payload.get("type") == "chunk":
                await websocket.send_json(
                    {
                        "type": "transportProfile",
                        "chunkIndex": payload.get("chunkIndex"),
                        "sendMs": round((time.perf_counter() - send_started_at) * 1000, 2),
                    }
                )
            if payload.get("type") in {"done", "error", "stopped"}:
                break
    except WebSocketDisconnect:
        stop_event.set()
    except Exception as error:
        stop_event.set()
        await websocket.send_json({"type": "error", "message": str(error)})
    finally:
        stop_event.set()
        if command_task and not command_task.done():
            command_task.cancel()
            try:
                await command_task
            except asyncio.CancelledError:
                pass
        if worker_task:
            try:
                await worker_task
            except Exception:
                pass


@app.websocket("/ws/sumo/{scope}")
async def sumo_scope(websocket: WebSocket, scope: str) -> None:
    await websocket.accept()

    try:
        selected = get_sumo_scenario(scope)
    except HTTPException as error:
        await websocket.send_json({"type": "error", "message": error.detail})
        await websocket.close()
        return

    sumo_binary = find_sumo_binary()
    if not sumo_binary or not selected["config"].exists():
        await websocket.send_json(
            {
                "type": "error",
                "message": f"SUMO binary or {selected['label']} config is unavailable.",
                "sumoAvailable": bool(sumo_binary),
                "configExists": selected["config"].exists(),
            }
        )
        await websocket.close()
        return

    command = [
        sumo_binary,
        "-c",
        str(selected["config"]),
        "--begin",
        str(selected["startSec"]),
        "--end",
        str(selected["endSec"]),
        "--step-length",
        "1",
        "--no-step-log",
        "true",
        "--duration-log.disable",
        "true",
        "--no-warnings",
        "true",
        "--log",
        "",
        "--summary-output",
        "",
        "--statistic-output",
        "",
        "--output-prefix",
        "",
        "--quit-on-end",
        "true",
    ]

    command_task: asyncio.Task[None] | None = None
    run_task: asyncio.Task[None] | None = None
    command_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    delay_ms = parse_delay_ms(websocket)
    is_running = False
    last_step = 0
    sim_process: asyncio.subprocess.Process | None = None
    run_started_at: float | None = None
    stop_requested = False

    try:
        (selected["dir"] / "output").mkdir(exist_ok=True)
        sumo_home = find_sumo_home()
        if sumo_home:
            os.environ["SUMO_HOME"] = str(sumo_home)

        await websocket.send_json(
            {
                "type": "hello",
                "backend": "sumo-subprocess",
                "scope": selected["key"],
                "window": {"startSec": selected["startSec"], "endSec": selected["endSec"]},
                "delayMs": delay_ms,
                "commands": ["start", "stop", "step", "reset", "delay"],
            }
        )

        async def receive_commands() -> None:
            while True:
                payload = await websocket.receive_json()
                await command_queue.put(payload)

        command_task = asyncio.create_task(receive_commands())

        async def send_sim_status(
            status: str,
            elapsed_sec: float | None = None,
            error: str | None = None,
        ) -> None:
            payload: dict[str, Any] = {
                "type": "simStatus",
                "status": status,
                "statusText": error or format_sim_status(status, elapsed_sec),
                "simSec": int(selected["startSec"]) + last_step,
                "step": last_step,
                "totalSteps": int(selected["endSec"] - selected["startSec"]),
                "delayMs": delay_ms,
                "running": is_running,
            }
            if elapsed_sec is not None:
                payload["elapsedSec"] = round(elapsed_sec, 3)
            await websocket.send_json(payload)

        async def run_plain_sumo() -> None:
            nonlocal is_running, last_step, run_started_at, sim_process, stop_requested
            is_running = True
            stop_requested = False
            last_step = 0
            run_started_at = time.perf_counter()
            await send_sim_status("running")

            sim_process = await asyncio.create_subprocess_exec(
                *command,
                cwd=str(selected["dir"]),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await sim_process.communicate()
            elapsed_sec = time.perf_counter() - run_started_at
            return_code = sim_process.returncode
            sim_process = None
            is_running = False

            if stop_requested:
                await send_sim_status("stopped", elapsed_sec)
                return

            if return_code == 0:
                last_step = int(selected["endSec"] - selected["startSec"])
                await send_sim_status("finished", elapsed_sec)
                await websocket.send_json({"type": "done", "simSec": selected["endSec"]})
                return

            output = (stderr or stdout or b"").decode("utf-8", errors="replace").strip()
            await send_sim_status(
                "failed",
                elapsed_sec,
                f"SUMO exited with code {return_code}: {output[-500:]}",
            )

        async def handle_command(payload: dict[str, Any]) -> None:
            nonlocal delay_ms, is_running, last_step, run_task, sim_process, stop_requested
            command_name = str(payload.get("command") or payload.get("type") or "").lower()
            if command_name == "start":
                if is_running:
                    await send_sim_status("running")
                    return
                run_task = asyncio.create_task(run_plain_sumo())
            elif command_name == "stop":
                stop_requested = True
                if sim_process and sim_process.returncode is None:
                    sim_process.terminate()
                is_running = False
                await send_sim_status("stopped")
            elif command_name == "step":
                await send_sim_status("step-unavailable")
            elif command_name == "reset":
                is_running = False
                last_step = 0
                stop_requested = True
                if sim_process and sim_process.returncode is None:
                    sim_process.terminate()
                await send_sim_status("idle")
            elif command_name == "delay":
                delay_ms = clamp_delay_ms(payload.get("delayMs"))
                await websocket.send_json({"type": "delay", "delayMs": delay_ms})
                await send_sim_status("running" if is_running else "idle")
            else:
                await websocket.send_json(
                    {"type": "error", "message": f"Unknown SUMO command: {command_name}"}
                )

        await send_sim_status("idle")

        while True:
            handled_command = False
            while True:
                try:
                    payload = command_queue.get_nowait()
                except asyncio.QueueEmpty:
                    break
                await handle_command(payload)
                handled_command = True

            if handled_command:
                continue

            if not is_running:
                await handle_command(await command_queue.get())
                continue

            await asyncio.sleep(0.05)
    except WebSocketDisconnect:
        return
    except Exception as error:
        await websocket.send_json({"type": "error", "message": str(error)})
    finally:
        if command_task and not command_task.done():
            command_task.cancel()
            try:
                await command_task
            except asyncio.CancelledError:
                pass
        if run_task and not run_task.done():
            run_task.cancel()
        if sim_process and sim_process.returncode is None:
            sim_process.terminate()


def produce_sumo_playback_chunks(
    traci: Any,
    command: list[str],
    connection_label: str,
    selected: dict[str, Any],
    playback_rate: int,
    frame_step_sec: float,
    message_queue: asyncio.Queue[dict[str, Any]],
    event_loop: asyncio.AbstractEventLoop,
    stop_event: threading.Event,
) -> None:
    chunk_index = 0
    chunk_frames: list[dict[str, Any]] = []
    recorded_frames = 0
    started_at = time.perf_counter()
    frames_per_chunk = max(1, int(round(PLAYBACK_CHUNK_SIM_SECONDS / frame_step_sec)))
    chunk_started_at = time.perf_counter()
    chunk_step_ms = 0.0
    chunk_frame_ms = 0.0
    chunk_vehicle_id_ms = 0.0
    chunk_vehicle_loop_ms = 0.0
    chunk_traffic_light_ms = 0.0
    chunk_vehicle_count = 0

    def emit(payload: dict[str, Any]) -> None:
        future = asyncio.run_coroutine_threadsafe(message_queue.put(payload), event_loop)
        future.result()

    def emit_chunk() -> None:
        nonlocal chunk_index, chunk_frames, recorded_frames
        nonlocal chunk_started_at, chunk_step_ms, chunk_frame_ms, chunk_vehicle_count
        nonlocal chunk_vehicle_id_ms, chunk_vehicle_loop_ms, chunk_traffic_light_ms
        if not chunk_frames:
            return

        frame_count = len(chunk_frames)
        recorded_frames += len(chunk_frames)
        emit(
            {
                "type": "chunk",
                "scope": selected["key"],
                "chunkIndex": chunk_index,
                "playbackRate": playback_rate,
                "dataFps": PLAYBACK_DATA_FPS,
                "frameStepSec": frame_step_sec,
                "startSimSec": chunk_frames[0]["simSec"],
                "endSimSec": chunk_frames[-1]["simSec"],
                "frames": chunk_frames,
                "profile": {
                    "frames": frame_count,
                    "vehicles": chunk_vehicle_count,
                    "stepMs": round(chunk_step_ms, 2),
                    "frameMs": round(chunk_frame_ms, 2),
                    "vehicleIdMs": round(chunk_vehicle_id_ms, 2),
                    "vehicleLoopMs": round(chunk_vehicle_loop_ms, 2),
                    "trafficLightMs": round(chunk_traffic_light_ms, 2),
                    "chunkMs": round((time.perf_counter() - chunk_started_at) * 1000, 2),
                },
            }
        )
        chunk_index += 1
        chunk_frames = []
        chunk_started_at = time.perf_counter()
        chunk_step_ms = 0.0
        chunk_frame_ms = 0.0
        chunk_vehicle_id_ms = 0.0
        chunk_vehicle_loop_ms = 0.0
        chunk_traffic_light_ms = 0.0
        chunk_vehicle_count = 0

    try:
        traci.start(command, label=connection_label)
        connection = traci.getConnection(connection_label)
        traci_constants = traci.constants
        net_offset, utm_zone = load_sumo_projection(str(selected["net"]))
        traffic_light_ids = list(connection.trafficlight.getIDList())
        for traffic_light_id in traffic_light_ids:
            connection.trafficlight.subscribe(
                traffic_light_id,
                [traci_constants.TL_RED_YELLOW_GREEN_STATE],
            )
        subscribed_vehicle_ids: set[str] = set()
        total_steps = int(round((selected["endSec"] - selected["startSec"]) / frame_step_sec))

        emit(
            {
                "type": "recording",
                "status": "running",
                "scope": selected["key"],
                "startSimSec": selected["startSec"],
                "endSimSec": selected["endSec"],
                "totalSteps": total_steps,
                "playbackRate": playback_rate,
                "dataFps": PLAYBACK_DATA_FPS,
                "chunkSimSeconds": PLAYBACK_CHUNK_SIM_SECONDS,
                "frameStepSec": frame_step_sec,
            }
        )

        while not stop_event.is_set() and float(connection.simulation.getTime()) < selected["endSec"] - 1e-9:
            step_started_at = time.perf_counter()
            connection.simulationStep()
            chunk_step_ms += (time.perf_counter() - step_started_at) * 1000
            sim_sec = round(float(connection.simulation.getTime()), 3)
            frame_started_at = time.perf_counter()
            frame_profile: dict[str, float] = {}
            frame = build_compact_sumo_frame(
                connection,
                sim_sec,
                traci_constants,
                net_offset,
                utm_zone,
                subscribed_vehicle_ids,
                traffic_light_ids,
                frame_profile,
            )
            chunk_frame_ms += (time.perf_counter() - frame_started_at) * 1000
            chunk_vehicle_id_ms += frame_profile.get("vehicleIdMs", 0.0)
            chunk_vehicle_loop_ms += frame_profile.get("vehicleLoopMs", 0.0)
            chunk_traffic_light_ms += frame_profile.get("trafficLightMs", 0.0)
            chunk_vehicle_count += len(frame["vehicles"])
            chunk_frames.append(frame)

            if len(chunk_frames) >= frames_per_chunk or sim_sec >= selected["endSec"]:
                emit_chunk()

        emit_chunk()
        elapsed_sec = round(time.perf_counter() - started_at, 3)
        if stop_event.is_set():
            emit(
                {
                    "type": "stopped",
                    "scope": selected["key"],
                    "recordedFrames": recorded_frames,
                    "elapsedSec": elapsed_sec,
                }
            )
            return

        emit(
            {
                "type": "done",
                "scope": selected["key"],
                "simSec": selected["endSec"],
                "chunks": chunk_index,
                "recordedFrames": recorded_frames,
                "elapsedSec": elapsed_sec,
            }
        )
    except Exception as error:
        emit({"type": "error", "message": str(error)})
    finally:
        try:
            traci.switch(connection_label)
            traci.close(False)
        except Exception:
            pass


def build_compact_sumo_frame(
    connection: Any,
    sim_sec: float,
    traci_constants: Any,
    net_offset: tuple[float, float],
    utm_zone: int,
    subscribed_vehicle_ids: set[str],
    traffic_light_ids: list[str],
    profile: dict[str, float],
) -> dict[str, Any]:
    vehicles = []
    vehicle_id_started_at = time.perf_counter()
    vehicle_ids = set(connection.vehicle.getIDList())
    for vehicle_id in vehicle_ids - subscribed_vehicle_ids:
        connection.vehicle.subscribe(
            vehicle_id,
            [traci_constants.VAR_POSITION, traci_constants.VAR_ANGLE],
        )
    subscribed_vehicle_ids.intersection_update(vehicle_ids)
    subscribed_vehicle_ids.update(vehicle_ids)
    profile["vehicleIdMs"] = (time.perf_counter() - vehicle_id_started_at) * 1000

    vehicle_loop_started_at = time.perf_counter()
    vehicle_results = connection.vehicle.getAllSubscriptionResults()
    for vehicle_id in vehicle_ids:
        vehicle_data = vehicle_results.get(vehicle_id)
        if not vehicle_data:
            continue
        position = vehicle_data.get(traci_constants.VAR_POSITION)
        if position is None:
            continue
        x, y = position
        lon, lat = sumo_xy_to_lonlat(float(x), float(y), net_offset, utm_zone)
        vehicles.append(
            {
                "id": vehicle_id,
                "lon": round(float(lon), 7),
                "lat": round(float(lat), 7),
                "angle": round(float(vehicle_data.get(traci_constants.VAR_ANGLE, 0)), 2),
            }
        )
    profile["vehicleLoopMs"] = (time.perf_counter() - vehicle_loop_started_at) * 1000

    traffic_light_started_at = time.perf_counter()
    traffic_lights = compact_traffic_light_states(
        connection,
        traffic_light_ids,
        traci_constants,
    )
    profile["trafficLightMs"] = (time.perf_counter() - traffic_light_started_at) * 1000

    return {
        "simSec": sim_sec,
        "vehicles": vehicles,
        "trafficLights": traffic_lights,
    }


def compact_traffic_light_states(
    connection: Any,
    traffic_light_ids: list[str] | None = None,
    traci_constants: Any | None = None,
) -> dict[str, str]:
    if traci_constants is not None:
        results = connection.trafficlight.getAllSubscriptionResults()
        return {
            traffic_light_id: str(
                results.get(traffic_light_id, {}).get(
                    traci_constants.TL_RED_YELLOW_GREEN_STATE,
                    "",
                )
            )
            for traffic_light_id in (traffic_light_ids or results.keys())
        }

    ids = traffic_light_ids if traffic_light_ids is not None else connection.trafficlight.getIDList()
    return {
        traffic_light_id: connection.trafficlight.getRedYellowGreenState(traffic_light_id)
        for traffic_light_id in ids
    }


def build_sumo_frame(
    connection: Any,
    sim_sec: int,
    is_running: bool,
    delay_ms: int,
) -> dict[str, Any]:
    vehicle_ids = list(connection.vehicle.getIDList())
    vehicles = []
    traffic_lights = live_traffic_light_states(connection)

    for vehicle_id in vehicle_ids:
        x, y = connection.vehicle.getPosition(vehicle_id)
        lon, lat = connection.simulation.convertGeo(x, y)
        vehicle = {
            "id": vehicle_id,
            "lon": lon,
            "lat": lat,
            "angle": round(float(connection.vehicle.getAngle(vehicle_id)), 3),
            "speed": round(float(connection.vehicle.getSpeed(vehicle_id)), 3),
            "lane": connection.vehicle.getLaneID(vehicle_id),
            "route": connection.vehicle.getRouteID(vehicle_id),
            "kind": "background",
        }
        vehicles.append(vehicle)

    return {
        "type": "frame",
        "simSec": sim_sec,
        "vehicles": vehicles,
        "vehicleCount": len(vehicles),
        "departed": list(connection.simulation.getDepartedIDList()),
        "arrived": list(connection.simulation.getArrivedIDList()),
        "trafficLights": traffic_lights,
        "running": is_running,
        "delayMs": delay_ms,
    }


def format_sim_status(status: str, elapsed_sec: float | None = None) -> str:
    if status == "finished" and elapsed_sec is not None:
        return f"Finished in {elapsed_sec:.2f}s"
    if status == "running":
        return "Running"
    if status == "stopped":
        return "Stopped"
    if status == "stepped":
        return "Stepped"
    if status == "step-unavailable":
        return "Step requires TraCI"
    if status == "failed":
        return "Failed"
    return "Idle"


def live_traffic_light_states(connection: Any) -> dict[str, dict[str, Any]]:
    states = {}
    for traffic_light_id in connection.trafficlight.getIDList():
        raw_state = connection.trafficlight.getRedYellowGreenState(traffic_light_id)
        states[traffic_light_id] = {
            "state": raw_state,
            "display": display_traffic_light_state(raw_state),
            "phase": int(connection.trafficlight.getPhase(traffic_light_id)),
        }
    return states


def display_traffic_light_state(raw_state: str) -> str:
    if any(char in raw_state for char in "gG"):
        return "green"
    if any(char in raw_state for char in "yY"):
        return "yellow"
    if any(char in raw_state for char in "rRuUsS"):
        return "red"
    return "off"


def clamp_delay_ms(value: Any) -> int:
    try:
        delay_ms = int(float(value))
    except (TypeError, ValueError):
        delay_ms = DEFAULT_SUMO_DELAY_MS

    return max(0, min(delay_ms, MAX_SUMO_DELAY_MS))


def parse_delay_ms(websocket: WebSocket) -> int:
    configured_delay_ms = os.getenv("SUMO_DELAY_MS")
    raw_delay_ms = websocket.query_params.get("delayMs")
    if raw_delay_ms is not None:
        return clamp_delay_ms(raw_delay_ms)
    if configured_delay_ms is not None:
        return clamp_delay_ms(configured_delay_ms)
    return DEFAULT_SUMO_DELAY_MS
