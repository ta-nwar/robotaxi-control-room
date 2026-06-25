import asyncio
import json
import math
import os
import re
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from functools import lru_cache
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware


APP_DIR = Path(__file__).resolve().parent
SCENARIO_PATH = APP_DIR / "data" / "six-seven-scenario.json"
SUMO_SCENARIO_DIR = APP_DIR / "sumo" / "reinickendorf"
SUMO_CONFIG_PATH = SUMO_SCENARIO_DIR / "reinickendorf-internal.sumocfg"
SUMO_NET_PATH = SUMO_SCENARIO_DIR / "reinickendorf.net.xml"
SUMO_START_SEC = 21_600
SUMO_END_SEC = 25_200
DEFAULT_FRAME_DELAY_SEC = 0.035
DEFAULT_SUMO_SPEED = 60.0
MAX_WEBSOCKET_FPS = 60.0

app = FastAPI(title="Robotaxi SUMO Backend", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin for origin in os.getenv("ALLOW_ORIGINS", "*").split(",") if origin],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def load_scenario() -> dict[str, Any]:
    with SCENARIO_PATH.open("r", encoding="utf-8") as handle:
        return json.load(handle)


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
    scenario = load_scenario()
    sumo = sumo_version()
    files = packaged_sumo_files()
    return {
        "ok": bool(sumo["available"] and all(files.values())),
        "service": "robotaxi-sumo-backend",
        "scenario": scenario["scenario"]["id"],
        "sumoAvailable": sumo["available"],
        "packagedFiles": files,
    }


@app.get("/sumo/version")
def get_sumo_version() -> dict[str, Any]:
    return sumo_version()


def packaged_sumo_files() -> dict[str, bool]:
    return {
        "net": SUMO_NET_PATH.exists(),
        "routes": (SUMO_SCENARIO_DIR / "reinickendorf-internal.rou.gz").exists(),
        "config": SUMO_CONFIG_PATH.exists(),
    }


@lru_cache(maxsize=1)
def load_sumo_network() -> dict[str, Any]:
    tree = ET.parse(SUMO_NET_PATH)
    root = tree.getroot()
    location = root.find("location")
    if location is None:
        raise ValueError("SUMO network location metadata is missing.")

    net_offset = parse_pair(location.attrib["netOffset"])
    zone_match = re.search(r"\+zone=(\d+)", location.attrib.get("projParameter", ""))
    utm_zone = int(zone_match.group(1)) if zone_match else 33

    lane_features = []
    internal_lane_features = []
    lane_shapes_by_id = {}
    lane_xy_shapes_by_id = {}
    for edge in root.findall("edge"):
        edge_id = edge.attrib.get("id", "")
        is_internal = edge.attrib.get("function") == "internal" or edge_id.startswith(":")

        for lane in edge.findall("lane"):
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
    for connection in root.findall("connection"):
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
        },
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


@app.get("/scenario/summary")
def scenario_summary() -> dict[str, Any]:
    scenario = load_scenario()
    return {
        "schemaVersion": scenario["schemaVersion"],
        "scenario": scenario["scenario"],
        "summary": scenario["summary"],
        "serviceArea": scenario["serviceArea"],
        "depot": scenario["depot"],
        "counts": {
            "roads": len(scenario["roads"]["features"]),
            "trips": len(scenario["trips"]),
        },
    }


@app.get("/scenario")
def get_scenario() -> dict[str, Any]:
    return load_scenario()


@app.get("/sumo/reinickendorf/summary")
def sumo_reinickendorf_summary() -> dict[str, Any]:
    scenario = load_scenario()
    return {
        "available": SUMO_CONFIG_PATH.exists() and find_sumo_binary() is not None,
        "sumo": sumo_version(),
        "config": str(SUMO_CONFIG_PATH),
        "window": {
            "startSec": SUMO_START_SEC,
            "endSec": SUMO_END_SEC,
            "label": scenario["scenario"]["windowLabel"],
        },
        "files": packaged_sumo_files(),
    }


@app.get("/sumo/reinickendorf/network")
def sumo_reinickendorf_network() -> dict[str, Any]:
    if not SUMO_NET_PATH.exists():
        return {"available": False, "error": "Reinickendorf SUMO net file is missing."}

    try:
        network = load_sumo_network()
    except Exception as error:
        return {"available": False, "error": str(error)}

    return {"available": True, **network}


@app.get("/sumo/reinickendorf/validate")
def validate_sumo_reinickendorf() -> dict[str, Any]:
    sumo_binary = find_sumo_binary()
    if not sumo_binary:
        return {"ok": False, "error": "sumo binary not found"}

    (SUMO_SCENARIO_DIR / "output").mkdir(exist_ok=True)
    sumo_home = find_sumo_home()
    env = os.environ.copy()
    if sumo_home:
        env["SUMO_HOME"] = str(sumo_home)

    command = [
        sumo_binary,
        "-c",
        str(SUMO_CONFIG_PATH),
        "--begin",
        str(SUMO_START_SEC),
        "--end",
        str(SUMO_START_SEC + 10),
        "--step-length",
        "1",
        "--no-step-log",
        "true",
        "--quit-on-end",
        "true",
    ]
    result = subprocess.run(
        command,
        cwd=str(SUMO_SCENARIO_DIR),
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


@app.websocket("/ws/replay")
async def replay(websocket: WebSocket) -> None:
    await websocket.accept()
    scenario = load_scenario()
    trips = sorted(scenario["trips"], key=lambda trip: trip["departOffsetSec"])
    start_sec = scenario["scenario"]["startSec"]

    try:
        await websocket.send_json(
            {
                "type": "hello",
                "scenario": scenario["scenario"],
                "counts": {"trips": len(trips)},
            }
        )

        speed = 120.0
        frame_step_sec = 30
        current_offset = 0
        trip_index = 0

        while current_offset <= scenario["scenario"]["durationSec"]:
            new_requests = []
            while (
                trip_index < len(trips)
                and trips[trip_index]["departOffsetSec"] <= current_offset
            ):
                trip = trips[trip_index]
                new_requests.append(
                    {
                        "id": trip["id"],
                        "origin": trip["origin"],
                        "destination": trip["destination"],
                        "distanceKm": trip["distanceKm"],
                    }
                )
                trip_index += 1

            await websocket.send_json(
                {
                    "type": "frame",
                    "simSec": start_sec + current_offset,
                    "offsetSec": current_offset,
                    "newRequests": new_requests,
                }
            )
            current_offset += frame_step_sec
            await asyncio.sleep(frame_step_sec / speed)

        await websocket.send_json({"type": "done"})
    except WebSocketDisconnect:
        return


@app.websocket("/ws/sumo/reinickendorf")
async def sumo_reinickendorf(websocket: WebSocket) -> None:
    await websocket.accept()

    sumo_binary = find_sumo_binary()
    if not sumo_binary or not SUMO_CONFIG_PATH.exists():
        await websocket.send_json(
            {
                "type": "error",
                "message": "SUMO binary or Reinickendorf config is unavailable.",
                "sumoAvailable": bool(sumo_binary),
                "configExists": SUMO_CONFIG_PATH.exists(),
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

    command = [
        sumo_binary,
        "-c",
        str(SUMO_CONFIG_PATH),
        "--begin",
        str(SUMO_START_SEC),
        "--end",
        str(SUMO_END_SEC),
        "--step-length",
        "1",
        "--no-step-log",
        "true",
        "--quit-on-end",
        "true",
    ]

    connection_label = f"reinickendorf-{id(websocket)}"
    speed_factor = parse_playback_speed(websocket)
    seek_sec = parse_seek_sec(websocket)
    producer_task: asyncio.Task[None] | None = None

    try:
        (SUMO_SCENARIO_DIR / "output").mkdir(exist_ok=True)
        sumo_home = find_sumo_home()
        if sumo_home:
            os.environ["SUMO_HOME"] = str(sumo_home)

        await websocket.send_json(
            {
                "type": "hello",
                "backend": "sumo-traci",
                "window": {"startSec": SUMO_START_SEC, "endSec": SUMO_END_SEC},
                "speedFactor": speed_factor,
                "maxWebsocketFps": MAX_WEBSOCKET_FPS,
                "seekSec": seek_sec,
            }
        )

        await asyncio.to_thread(
            traci.start,
            command,
            label=connection_label,
        )
        connection = traci.getConnection(connection_label)

        latest_frame: dict[str, Any] | None = None
        latest_sent_sec: int | None = None
        producer_done = False
        producer_error: Exception | None = None
        frame_event = asyncio.Event()

        async def produce_frames() -> None:
            nonlocal latest_frame, producer_done, producer_error
            try:
                sim_sec = int(connection.simulation.getTime())
                while sim_sec < seek_sec:
                    await asyncio.to_thread(connection.simulationStep)
                    sim_sec = int(connection.simulation.getTime())

                loop = asyncio.get_running_loop()
                playback_started_at = loop.time()
                latest_frame = await asyncio.to_thread(
                    build_sumo_frame,
                    connection,
                    sim_sec,
                    0,
                    speed_factor,
                    speed_factor,
                )
                frame_event.set()

                while sim_sec < SUMO_END_SEC:
                    wall_elapsed_sec = max(0.0, loop.time() - playback_started_at)
                    target_sim_sec = min(
                        SUMO_END_SEC,
                        seek_sec + int(wall_elapsed_sec * speed_factor),
                    )
                    if target_sim_sec <= sim_sec:
                        await asyncio.sleep(1 / MAX_WEBSOCKET_FPS)
                        continue

                    while sim_sec < target_sim_sec:
                        await asyncio.to_thread(connection.simulationStep)
                        sim_sec = int(connection.simulation.getTime())

                    wall_elapsed_sec = max(0.0, loop.time() - playback_started_at)
                    sim_elapsed_sec = max(0, sim_sec - seek_sec)
                    effective_speed = (
                        sim_elapsed_sec / wall_elapsed_sec if wall_elapsed_sec > 0 else speed_factor
                    )
                    latest_frame = await asyncio.to_thread(
                        build_sumo_frame,
                        connection,
                        sim_sec,
                        wall_elapsed_sec,
                        speed_factor,
                        effective_speed,
                    )
                    frame_event.set()
            except Exception as error:  # pragma: no cover - runtime dependent
                producer_error = error
            finally:
                producer_done = True
                frame_event.set()

        producer_task = asyncio.create_task(produce_frames())
        send_interval_sec = 1 / MAX_WEBSOCKET_FPS

        while True:
            try:
                await asyncio.wait_for(frame_event.wait(), timeout=send_interval_sec)
            except asyncio.TimeoutError:
                pass

            frame = latest_frame
            if frame is not None and frame.get("simSec") != latest_sent_sec:
                await websocket.send_json(frame)
                latest_sent_sec = int(frame["simSec"])

            frame_event.clear()

            if producer_done:
                break

        if producer_error:
            raise producer_error
        await websocket.send_json({"type": "done"})
    except WebSocketDisconnect:
        return
    except Exception as error:
        await websocket.send_json({"type": "error", "message": str(error)})
    finally:
        if producer_task and not producer_task.done():
            producer_task.cancel()
            try:
                await producer_task
            except asyncio.CancelledError:
                pass
        try:
            traci.switch(connection_label)
            traci.close(False)
        except Exception:
            pass


def build_sumo_frame(
    connection: Any,
    sim_sec: int,
    wall_elapsed_sec: float,
    requested_speed: float,
    effective_speed: float,
) -> dict[str, Any]:
    vehicle_ids = list(connection.vehicle.getIDList())
    vehicles = []
    traffic_lights = live_traffic_light_states(connection)

    for vehicle_id in vehicle_ids:
        x, y = connection.vehicle.getPosition(vehicle_id)
        lon, lat = connection.simulation.convertGeo(x, y)
        vehicles.append(
            {
                "id": vehicle_id,
                "lon": lon,
                "lat": lat,
                "angle": round(float(connection.vehicle.getAngle(vehicle_id)), 3),
                "speed": round(float(connection.vehicle.getSpeed(vehicle_id)), 3),
                "lane": connection.vehicle.getLaneID(vehicle_id),
                "route": connection.vehicle.getRouteID(vehicle_id),
            }
        )

    return {
        "type": "frame",
        "simSec": sim_sec,
        "vehicles": vehicles,
        "vehicleCount": len(vehicles),
        "departed": list(connection.simulation.getDepartedIDList()),
        "arrived": list(connection.simulation.getArrivedIDList()),
        "trafficLights": traffic_lights,
        "wallElapsedSec": round(wall_elapsed_sec, 3),
        "requestedSpeed": round(requested_speed, 3),
        "effectiveSpeed": round(effective_speed, 3),
    }


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


def parse_frame_delay(websocket: WebSocket) -> float:
    configured_delay = os.getenv("SUMO_FRAME_DELAY_SEC")
    raw_delay_ms = websocket.query_params.get("delayMs")

    try:
        if raw_delay_ms is not None:
            delay = float(raw_delay_ms) / 1000
        elif configured_delay is not None:
            delay = float(configured_delay)
        else:
            delay = DEFAULT_FRAME_DELAY_SEC
    except ValueError:
        delay = DEFAULT_FRAME_DELAY_SEC

    return max(0.0, min(delay, 2.0))


def parse_playback_speed(websocket: WebSocket) -> float:
    configured_speed = os.getenv("SUMO_PLAYBACK_SPEED")
    raw_speed = websocket.query_params.get("speed")
    raw_delay_ms = websocket.query_params.get("delayMs")

    try:
        if raw_speed is not None:
            speed = float(raw_speed)
        elif configured_speed is not None:
            speed = float(configured_speed)
        elif raw_delay_ms is not None:
            delay_ms = max(0.001, float(raw_delay_ms))
            speed = 1000 / delay_ms
        else:
            speed = DEFAULT_SUMO_SPEED
    except ValueError:
        speed = DEFAULT_SUMO_SPEED

    return max(1.0, min(speed, 3600.0))


def parse_seek_sec(websocket: WebSocket) -> int:
    raw_seek_sec = websocket.query_params.get("seekSec")
    if raw_seek_sec is None:
        return SUMO_START_SEC

    try:
        seek_sec = int(float(raw_seek_sec))
    except ValueError:
        return SUMO_START_SEC

    return max(SUMO_START_SEC, min(seek_sec, SUMO_END_SEC))
