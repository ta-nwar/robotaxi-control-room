import {
  Activity,
  CarFront,
  FastForward,
  Gauge,
  MapPinned,
  Pause,
  Play,
  RotateCcw,
  Timer,
} from "lucide-react"
import type { Feature, FeatureCollection, LineString, Polygon } from "geojson"
import maplibregl, { type GeoJSONSource, type LngLatBoundsLike } from "maplibre-gl"
import { useEffect, useMemo, useRef, useState } from "react"
import "./App.css"

const mapStyleUrl = import.meta.env.VITE_MAPTILER_STYLE_URL as string | undefined
const scenarioApiUrl = import.meta.env.VITE_SCENARIO_API_URL as string | undefined
const alignedFlatBearing = -1.3
const cinematicTiltBearing = -13

type Coordinate = [number, number]

type Trip = {
  id: string
  departSec: number
  departOffsetSec: number
  distanceKm: number
  routeLengthKm: number
  origin: Coordinate
  destination: Coordinate
  route: Coordinate[]
}

type SumoVehicle = {
  id: string
  lon: number
  lat: number
  speed: number
  lane: string
  route: string
}

type SumoFrame = {
  simSec: number
  vehicleCount: number
  vehicles: SumoVehicle[]
  departed: string[]
  arrived: string[]
}

type Scenario = {
  schemaVersion: string
  scenario: {
    id: string
    name: string
    areaLabel: string
    windowLabel: string
    startSec: number
    endSec: number
    durationSec: number
    totalRequests: number
    notes: string[]
  }
  summary: {
    allDayInternalTrips: number
    peakHour: { hour: number; trips: number }
    peak15MinuteWindow: { label: string; trips: number }
    windowRequests: number
    windowUniqueEdges: number
  }
  serviceArea: Feature<Polygon>
  depot: {
    id: string
    label: string
    coordinates: Coordinate
    status: string
  }
  roads: FeatureCollection<LineString>
  trips: Trip[]
}

type PreparedTrip = Trip & {
  durationSec: number
  endSec: number
  cumulativeMeters: number[]
  totalMeters: number
}

type MapSection = "replay" | "base"
type ScenarioDataSource = "local-bundle" | "local-backend" | "remote-backend"

const speedOptions = [1, 10, 30, 60, 120, 240]
const replayLayerIds = [
  "roads-glow",
  "roads",
  "active-routes",
  "requests",
  "depot",
  "vehicles",
]
const referenceLayerIds = ["outside-mask", "service-area-line"]

function formatClock(sec: number) {
  const hour = Math.floor(sec / 3600)
  const minute = Math.floor((sec % 3600) / 60)
  const second = Math.floor(sec % 60)
  return `${hour.toString().padStart(2, "0")}:${minute
    .toString()
    .padStart(2, "0")}:${second.toString().padStart(2, "0")}`
}

function formatInteger(value: number) {
  return new Intl.NumberFormat("en-US").format(value)
}

function haversineMeters(a: Coordinate, b: Coordinate) {
  const radius = 6_371_000
  const toRad = Math.PI / 180
  const dLat = (b[1] - a[1]) * toRad
  const dLon = (b[0] - a[0]) * toRad
  const lat1 = a[1] * toRad
  const lat2 = b[1] * toRad
  const sinLat = Math.sin(dLat / 2)
  const sinLon = Math.sin(dLon / 2)
  const c =
    sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon
  return radius * 2 * Math.atan2(Math.sqrt(c), Math.sqrt(1 - c))
}

function prepareTrip(trip: Trip): PreparedTrip {
  const cumulativeMeters = [0]
  for (let index = 1; index < trip.route.length; index += 1) {
    cumulativeMeters.push(
      cumulativeMeters[index - 1] + haversineMeters(trip.route[index - 1], trip.route[index]),
    )
  }

  const totalMeters = cumulativeMeters.at(-1) ?? trip.routeLengthKm * 1000
  const urbanKmh = 24
  const durationSec = Math.max(75, Math.round((Math.max(trip.routeLengthKm, 0.25) / urbanKmh) * 3600))

  return {
    ...trip,
    cumulativeMeters,
    totalMeters,
    durationSec,
    endSec: trip.departSec + durationSec,
  }
}

function interpolateRoute(trip: PreparedTrip, progress: number): Coordinate {
  if (trip.route.length <= 1 || trip.totalMeters <= 0) {
    return trip.destination
  }

  const target = Math.max(0, Math.min(1, progress)) * trip.totalMeters
  const nextIndex = trip.cumulativeMeters.findIndex((distance) => distance >= target)

  if (nextIndex <= 0) {
    return trip.route[0]
  }

  const previousDistance = trip.cumulativeMeters[nextIndex - 1]
  const nextDistance = trip.cumulativeMeters[nextIndex]
  const localProgress =
    nextDistance === previousDistance
      ? 0
      : (target - previousDistance) / (nextDistance - previousDistance)
  const previous = trip.route[nextIndex - 1]
  const next = trip.route[nextIndex]

  return [
    previous[0] + (next[0] - previous[0]) * localProgress,
    previous[1] + (next[1] - previous[1]) * localProgress,
  ]
}

function featureCollection(features: Feature[]): FeatureCollection {
  return { type: "FeatureCollection", features }
}

function pointFeatureCollection(vehicles: SumoVehicle[]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: vehicles.map((vehicle) => ({
      type: "Feature",
      properties: {
        id: vehicle.id,
        speed: vehicle.speed,
        lane: vehicle.lane,
        route: vehicle.route,
      },
      geometry: {
        type: "Point",
        coordinates: [vehicle.lon, vehicle.lat],
      },
    })),
  }
}

function source(map: maplibregl.Map, id: string) {
  return map.getSource(id) as GeoJSONSource | undefined
}

function outsideServiceAreaMask(serviceArea: Feature<Polygon>): Feature<Polygon> {
  return {
    type: "Feature",
    properties: { name: "Outside service area mask" },
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [-180, -85],
          [180, -85],
          [180, 85],
          [-180, 85],
          [-180, -85],
        ],
        serviceArea.geometry.coordinates[0],
      ],
    },
  }
}

function setOverlayVisibility(map: maplibregl.Map, section: MapSection) {
  replayLayerIds.forEach((layerId) => {
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, "visibility", section === "replay" ? "visible" : "none")
    }
  })

  referenceLayerIds.forEach((layerId) => {
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(layerId, "visibility", "visible")
    }
  })
}

function applyMapCamera(map: maplibregl.Map, isTiltEnabled: boolean, duration = 420) {
  map.easeTo({
    pitch: isTiltEnabled ? 42 : 0,
    bearing: isTiltEnabled ? cinematicTiltBearing : alignedFlatBearing,
    duration,
  })
}

function describeScenarioSource(sourceName: ScenarioDataSource) {
  if (sourceName === "local-backend") {
    return "Local backend"
  }

  if (sourceName === "remote-backend") {
    return "Remote backend"
  }

  return "Local bundle"
}

function classifyScenarioSource(url: string | undefined): ScenarioDataSource {
  if (!url) {
    return "local-bundle"
  }

  return url.includes("127.0.0.1") || url.includes("localhost")
    ? "local-backend"
    : "remote-backend"
}

function backendWebSocketUrl(path: string) {
  if (!scenarioApiUrl) {
    return null
  }

  const baseUrl = scenarioApiUrl.replace(/\/$/, "")
  const protocolUrl = baseUrl.startsWith("https://")
    ? baseUrl.replace("https://", "wss://")
    : baseUrl.replace("http://", "ws://")
  return `${protocolUrl}${path}`
}

function backendHttpUrl(path: string) {
  if (!scenarioApiUrl) {
    return null
  }

  return `${scenarioApiUrl.replace(/\/$/, "")}${path}`
}

export default function App() {
  const [scenario, setScenario] = useState<Scenario | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [scenarioSource, setScenarioSource] = useState<ScenarioDataSource>("local-bundle")
  const [sumoStatus, setSumoStatus] = useState("Idle")
  const [sumoFrame, setSumoFrame] = useState<SumoFrame | null>(null)
  const [sumoSessionKey, setSumoSessionKey] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isTiltEnabled, setIsTiltEnabled] = useState(false)
  const [activeSection, setActiveSection] = useState<MapSection>("base")
  const [speed, setSpeed] = useState(60)
  const [timeSec, setTimeSec] = useState(21_600)
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null)

  const mapContainerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const baseMapContainerRef = useRef<HTMLDivElement | null>(null)
  const baseMapRef = useRef<maplibregl.Map | null>(null)
  const activeSectionRef = useRef<MapSection>("base")
  const animationRef = useRef<number | null>(null)
  const lastFrameRef = useRef<number | null>(null)

  useEffect(() => {
    async function loadScenario() {
      try {
        const requestedSource = classifyScenarioSource(scenarioApiUrl)
        const scenarioUrl = scenarioApiUrl
          ? `${scenarioApiUrl.replace(/\/$/, "")}/scenario`
          : `${import.meta.env.BASE_URL}data/six-seven-scenario.json`

        const response = await fetch(scenarioUrl)
        if (!response.ok) {
          throw new Error(`Scenario request failed: ${response.status}`)
        }
        const nextScenario = (await response.json()) as Scenario
        setScenario(nextScenario)
        setScenarioSource(requestedSource)
        setTimeSec(nextScenario.scenario.startSec)
        setLoadError(null)
      } catch (error) {
        if (scenarioApiUrl) {
          try {
            const fallbackResponse = await fetch(`${import.meta.env.BASE_URL}data/six-seven-scenario.json`)
            if (!fallbackResponse.ok) {
              throw new Error(`Fallback request failed: ${fallbackResponse.status}`)
            }
            const fallbackScenario = (await fallbackResponse.json()) as Scenario
            setScenario(fallbackScenario)
            setScenarioSource("local-bundle")
            setTimeSec(fallbackScenario.scenario.startSec)
            setLoadError("Backend unavailable; using local scenario bundle.")
            return
          } catch {
            // Preserve the original backend error below.
          }
        }

        setLoadError(error instanceof Error ? error.message : "Scenario could not be loaded.")
      }
    }

    void loadScenario()
  }, [])

  useEffect(() => {
    activeSectionRef.current = activeSection
  }, [activeSection])

  const preparedTrips = useMemo(
    () => scenario?.trips.map(prepareTrip) ?? [],
    [scenario],
  )

  const selectedTrip = useMemo(
    () => preparedTrips.find((trip) => trip.id === selectedTripId) ?? null,
    [preparedTrips, selectedTripId],
  )

  const sumoVehicleGeojson = useMemo(
    () => pointFeatureCollection(sumoFrame?.vehicles ?? []),
    [sumoFrame],
  )

  const simulation = useMemo(() => {
    if (!scenario) {
      return null
    }

    const requestedTrips = preparedTrips.filter((trip) => trip.departSec <= timeSec)
    const activeTrips = preparedTrips.filter(
      (trip) => trip.departSec <= timeSec && trip.endSec >= timeSec,
    )
    const completedTrips = preparedTrips.filter((trip) => trip.endSec < timeSec)
    const recentTrips = preparedTrips.filter(
      (trip) => trip.departSec <= timeSec && trip.departSec >= timeSec - 90,
    )

    const vehicleFeatures = activeTrips.map((trip) => {
      const progress = (timeSec - trip.departSec) / trip.durationSec
      return {
        type: "Feature" as const,
        properties: {
          id: trip.id,
          progress: Math.round(progress * 100),
        },
        geometry: {
          type: "Point" as const,
          coordinates: interpolateRoute(trip, progress),
        },
      }
    })

    const activeRouteFeatures = activeTrips.slice(0, 90).map((trip) => ({
      type: "Feature" as const,
      properties: { id: trip.id },
      geometry: {
        type: "LineString" as const,
        coordinates: trip.route,
      },
    }))

    const requestFeatures = recentTrips.flatMap((trip) => [
      {
        type: "Feature" as const,
        properties: { id: trip.id, kind: "origin" },
        geometry: { type: "Point" as const, coordinates: trip.origin },
      },
      {
        type: "Feature" as const,
        properties: { id: trip.id, kind: "destination" },
        geometry: { type: "Point" as const, coordinates: trip.destination },
      },
    ])

    return {
      requestedTrips,
      activeTrips,
      completedTrips,
      recentTrips,
      vehicleGeojson: featureCollection(vehicleFeatures),
      activeRoutesGeojson: featureCollection(activeRouteFeatures),
      requestGeojson: featureCollection(requestFeatures),
    }
  }, [preparedTrips, scenario, timeSec])

  useEffect(() => {
    if (
      !scenario ||
      activeSection !== "replay" ||
      !mapContainerRef.current ||
      mapRef.current ||
      !mapStyleUrl
    ) {
      return
    }

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: mapStyleUrl,
      center: [13.3603, 52.5634],
      zoom: 12.4,
      pitch: 0,
      bearing: alignedFlatBearing,
      attributionControl: false,
    })

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right")
    map.addControl(new maplibregl.AttributionControl({ compact: true }))

    map.on("load", () => {
      map.addSource("service-area", { type: "geojson", data: scenario.serviceArea })
      map.addSource("outside-mask", {
        type: "geojson",
        data: outsideServiceAreaMask(scenario.serviceArea),
      })
      map.addSource("roads", { type: "geojson", data: scenario.roads })
      map.addSource("depot", {
        type: "geojson",
        data: {
          type: "Feature",
          properties: scenario.depot,
          geometry: { type: "Point", coordinates: scenario.depot.coordinates },
        },
      })
      map.addSource("active-routes", {
        type: "geojson",
        data: featureCollection([]),
      })
      map.addSource("requests", {
        type: "geojson",
        data: featureCollection([]),
      })
      map.addSource("vehicles", {
        type: "geojson",
        data: featureCollection([]),
      })

      map.addLayer({
        id: "outside-mask",
        type: "fill",
        source: "outside-mask",
        paint: {
          "fill-color": "#b9c2c7",
          "fill-opacity": 0.34,
        },
      })
      map.addLayer({
        id: "roads-glow",
        type: "line",
        source: "roads",
        paint: {
          "line-color": "#9ad8ff",
          "line-width": 2.5,
          "line-opacity": 0.14,
        },
      })
      map.addLayer({
        id: "roads",
        type: "line",
        source: "roads",
        paint: {
          "line-color": "#c8f6ff",
          "line-width": 0.78,
          "line-opacity": 0.38,
        },
      })
      map.addLayer({
        id: "active-routes",
        type: "line",
        source: "active-routes",
        paint: {
          "line-color": "#31d7ff",
          "line-width": 2,
          "line-opacity": 0.5,
        },
      })
      map.addLayer({
        id: "service-area-line",
        type: "line",
        source: "service-area",
        paint: {
          "line-color": "#37d9ff",
          "line-width": 2.4,
          "line-dasharray": [2.4, 1.2],
          "line-opacity": 0.96,
        },
      })
      map.addLayer({
        id: "requests",
        type: "circle",
        source: "requests",
        paint: {
          "circle-color": [
            "match",
            ["get", "kind"],
            "origin",
            "#ff4fa3",
            "#ffcc66",
          ],
          "circle-radius": 5,
          "circle-opacity": 0.82,
          "circle-stroke-color": "#080d12",
          "circle-stroke-width": 1,
        },
      })
      map.addLayer({
        id: "depot",
        type: "circle",
        source: "depot",
        paint: {
          "circle-color": "#ffb84a",
          "circle-radius": 8,
          "circle-stroke-color": "#1a0e03",
          "circle-stroke-width": 2,
        },
      })
      map.addLayer({
        id: "vehicles",
        type: "circle",
        source: "vehicles",
        paint: {
          "circle-color": "#effcff",
          "circle-radius": 4.8,
          "circle-opacity": 0.94,
          "circle-stroke-color": "#31d7ff",
          "circle-stroke-width": 1.5,
        },
      })
      setOverlayVisibility(map, activeSectionRef.current)

      const bounds = scenario.serviceArea.geometry.coordinates[0].reduce(
        (nextBounds, point) => nextBounds.extend(point as Coordinate),
        new maplibregl.LngLatBounds(scenario.depot.coordinates, scenario.depot.coordinates),
      )
      map.fitBounds(bounds as LngLatBoundsLike, {
        padding: 92,
        duration: 0,
      })
      map.jumpTo({ bearing: alignedFlatBearing, pitch: 0 })
      requestAnimationFrame(() => applyMapCamera(map, false, 0))
    })

    map.on("click", "vehicles", (event) => {
      const id = event.features?.[0]?.properties?.id as string | undefined
      setSelectedTripId(id ?? null)
    })

    mapRef.current = map

    const resizeObserver = new ResizeObserver(() => map.resize())
    resizeObserver.observe(mapContainerRef.current)

    return () => {
      resizeObserver.disconnect()
      map.remove()
      mapRef.current = null
    }
  }, [activeSection, scenario])

  useEffect(() => {
    if (
      !scenario ||
      activeSection !== "base" ||
      !baseMapContainerRef.current ||
      baseMapRef.current ||
      !mapStyleUrl
    ) {
      return
    }

    const map = new maplibregl.Map({
      container: baseMapContainerRef.current,
      style: mapStyleUrl,
      center: [13.3603, 52.5634],
      zoom: 12.2,
      pitch: 0,
      bearing: 0,
      attributionControl: false,
    })

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right")
    map.addControl(new maplibregl.AttributionControl({ compact: true }))

    map.on("load", () => {
      map.addSource("base-service-area", {
        type: "geojson",
        data: scenario.serviceArea,
      })
      map.addSource("base-roads", {
        type: "geojson",
        data: scenario.roads,
      })
      map.addSource("sumo-vehicles", {
        type: "geojson",
        data: featureCollection([]),
      })
      map.addLayer({
        id: "base-roads",
        type: "line",
        source: "base-roads",
        paint: {
          "line-color": "#86cde2",
          "line-width": 0.9,
          "line-opacity": 0.38,
        },
      })
      map.addLayer({
        id: "base-service-area-line",
        type: "line",
        source: "base-service-area",
        paint: {
          "line-color": "#37d9ff",
          "line-width": 2.4,
          "line-dasharray": [2.4, 1.2],
          "line-opacity": 0.96,
        },
      })
      map.addLayer({
        id: "sumo-vehicles",
        type: "circle",
        source: "sumo-vehicles",
        paint: {
          "circle-color": "#10252d",
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            11,
            2.2,
            14,
            4.6,
          ],
          "circle-opacity": 0.9,
          "circle-stroke-color": "#37d9ff",
          "circle-stroke-width": 1.2,
        },
      })
    })
    baseMapRef.current = map

    const resizeObserver = new ResizeObserver(() => map.resize())
    resizeObserver.observe(baseMapContainerRef.current)

    return () => {
      resizeObserver.disconnect()
      map.remove()
      baseMapRef.current = null
    }
  }, [activeSection, scenario])

  useEffect(() => {
    const map = baseMapRef.current
    if (!map || !map.isStyleLoaded()) {
      return
    }

    source(map, "sumo-vehicles")?.setData(sumoVehicleGeojson)
  }, [sumoVehicleGeojson])

  useEffect(() => {
    if (activeSection !== "base") {
      return
    }

    const wsUrl = backendWebSocketUrl("/ws/sumo/reinickendorf")
    const summaryUrl = backendHttpUrl("/sumo/reinickendorf/summary")
    if (!wsUrl) {
      setSumoStatus("Local bundle only")
      return
    }

    const nextWsUrl = wsUrl
    let isClosed = false
    let socket: WebSocket | null = null
    setSumoStatus("Checking backend")

    async function connectToSumo() {
      if (!summaryUrl) {
        setSumoStatus("Backend not configured")
        return
      }

      try {
        const response = await fetch(summaryUrl)
        if (!response.ok) {
          setSumoStatus(
            response.status === 404
              ? "HF Space needs redeploy"
              : `Backend check failed ${response.status}`,
          )
          return
        }
      } catch {
        setSumoStatus("Backend unavailable")
        return
      }

      if (isClosed) {
        return
      }

      socket = new WebSocket(nextWsUrl)
      setSumoStatus("Connecting")

      socket.addEventListener("open", () => {
        if (!isClosed) {
          setSumoStatus("Starting SUMO")
        }
      })

      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data as string) as
          | { type: "hello" }
          | ({ type: "frame" } & SumoFrame)
          | { type: "done" }
          | { type: "error"; message: string }

        if (message.type === "hello") {
          setSumoStatus("SUMO running")
          return
        }

        if (message.type === "frame") {
          setSumoFrame({
            simSec: message.simSec,
            vehicleCount: message.vehicleCount,
            vehicles: message.vehicles,
            departed: message.departed,
            arrived: message.arrived,
          })
          setSumoStatus("Streaming")
          return
        }

        if (message.type === "done") {
          setSumoStatus("Complete")
          return
        }

        if (message.type === "error") {
          setSumoStatus(message.message)
        }
      })

      socket.addEventListener("close", () => {
        if (!isClosed) {
          setSumoStatus("Disconnected")
        }
      })

      socket.addEventListener("error", () => {
        setSumoStatus("Connection error")
      })
    }

    void connectToSumo()

    return () => {
      isClosed = true
      socket?.close()
    }
  }, [activeSection, sumoSessionKey])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded()) {
      return
    }

    setOverlayVisibility(map, activeSection)
    applyMapCamera(map, isTiltEnabled)
  }, [activeSection, isTiltEnabled])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !simulation || !map.isStyleLoaded()) {
      return
    }

    source(map, "vehicles")?.setData(simulation.vehicleGeojson)
    source(map, "active-routes")?.setData(simulation.activeRoutesGeojson)
    source(map, "requests")?.setData(simulation.requestGeojson)
  }, [simulation])

  useEffect(() => {
    if (!scenario || !isPlaying) {
      lastFrameRef.current = null
      return
    }

    function step(timestamp: number) {
      if (!scenario) {
        return
      }

      const lastFrame = lastFrameRef.current ?? timestamp
      const elapsed = (timestamp - lastFrame) / 1000
      lastFrameRef.current = timestamp

      setTimeSec((current) => {
        const next = current + elapsed * speed
        if (next >= scenario.scenario.endSec) {
          setIsPlaying(false)
          return scenario.scenario.endSec
        }
        return next
      })

      animationRef.current = requestAnimationFrame(step)
    }

    animationRef.current = requestAnimationFrame(step)
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
    }
  }, [isPlaying, scenario, speed])

  const progressPercent = scenario
    ? ((timeSec - scenario.scenario.startSec) / scenario.scenario.durationSec) * 100
    : 0

  const reset = () => {
    if (!scenario) {
      return
    }
    setTimeSec(scenario.scenario.startSec)
    setSelectedTripId(null)
    setIsPlaying(false)
  }

  return (
    <main className="app-shell">
      <aside className="nav-rail" aria-label="Simulation navigation">
        <div className="brand-mark">
          <CarFront size={18} aria-hidden="true" />
        </div>
        <button
          type="button"
          className={activeSection === "replay" ? "rail-button is-active" : "rail-button"}
          title="Demand replay"
          onClick={() => setActiveSection("replay")}
        >
          <MapPinned size={18} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={activeSection === "base" ? "rail-button is-active" : "rail-button"}
          title="SUMO live"
          onClick={() => setActiveSection("base")}
        >
          <Activity size={18} aria-hidden="true" />
        </button>
        <button type="button" className="rail-button" title="Timing">
          <Timer size={18} aria-hidden="true" />
        </button>
      </aside>

      <section className="map-stage" aria-label="Robotaxi simulation map">
        {mapStyleUrl ? (
          activeSection === "base" ? (
            <div
              ref={baseMapContainerRef}
              className="map-canvas base-map-canvas"
            />
          ) : (
            <div ref={mapContainerRef} className="map-canvas" />
          )
        ) : (
          <div className="map-fallback">
            <MapPinned size={30} />
            <h1>Map style missing</h1>
            <p>Add `VITE_MAPTILER_STYLE_URL` to `.env.local`.</p>
          </div>
        )}
        <div className="map-vignette" aria-hidden="true" />
      </section>

      {activeSection === "base" ? (
        <section className="sumo-panel" aria-label="SUMO live simulation">
          <div>
            <p className="label">SUMO Live</p>
            <h1>Reinickendorf microscopic replay</h1>
            <p>
              Vehicle positions are streamed from the SUMO backend through TraCI.
            </p>
          </div>
          <div className="sumo-status-grid">
            <Metric label="Status" value={sumoStatus} />
            <Metric label="Time" value={sumoFrame ? formatClock(sumoFrame.simSec) : "--"} />
            <Metric label="Vehicles" value={sumoFrame?.vehicleCount ?? 0} />
            <Metric label="Departed" value={sumoFrame?.departed.length ?? 0} />
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={() => {
              setSumoFrame(null)
              setSumoSessionKey((current) => current + 1)
            }}
          >
            <RotateCcw size={16} />
            <span>Restart stream</span>
          </button>
        </section>
      ) : null}

      {activeSection === "replay" ? (
        <>
          <header className="top-strip">
            <div>
              <p className="label">Scenario</p>
              <h1>{scenario?.scenario.name ?? "Loading scenario"}</h1>
            </div>
            <div className="source-pill">
              {describeScenarioSource(scenarioSource)}
            </div>
            <div className="status-pill">
              <span className={isPlaying ? "pulse-dot" : "pulse-dot is-paused"} />
              {isPlaying ? "Live replay" : "Paused"}
            </div>
            <div className="clock-readout">
              <span>{formatClock(timeSec)}</span>
              <small>{scenario?.scenario.windowLabel ?? "06:00-07:00"}</small>
            </div>
          </header>

          <section className="control-panel" aria-label="Scenario controls">
            <div className="panel-heading">
              <p className="label">Demand replay</p>
              <h2>{scenario?.scenario.areaLabel ?? "BeST Reinickendorf cutout"}</h2>
              <p>
                701 real internal trip requests from the BeST SUMO scenario. Robotaxi
                dispatch comes next.
              </p>
            </div>

            <div className="metric-grid">
              <Metric label="Requests" value={simulation?.requestedTrips.length ?? 0} />
              <Metric label="Active" value={simulation?.activeTrips.length ?? 0} />
              <Metric label="Completed" value={simulation?.completedTrips.length ?? 0} />
              <Metric label="Wait" value="--" />
              <Metric label="Deadhead" value="--" />
              <Metric label="Road edges" value={scenario?.summary.windowUniqueEdges ?? 0} />
            </div>

            <div className="control-row">
              <button type="button" className="icon-button" onClick={() => setIsPlaying((next) => !next)}>
                {isPlaying ? <Pause size={16} /> : <Play size={16} />}
                <span>{isPlaying ? "Pause" : "Play"}</span>
              </button>
              <button type="button" className="icon-button" onClick={reset}>
                <RotateCcw size={16} />
                <span>Reset</span>
              </button>
            </div>

            <div className="view-mode" aria-label="Map tilt">
              <span>Map tilt</span>
              <div className="view-mode-options">
                <button
                  type="button"
                  className={isTiltEnabled ? "view-mode-option" : "view-mode-option is-active"}
                  onClick={() => setIsTiltEnabled(false)}
                >
                  Flat
                </button>
                <button
                  type="button"
                  className={isTiltEnabled ? "view-mode-option is-active" : "view-mode-option"}
                  onClick={() => setIsTiltEnabled(true)}
                >
                  Tilt
                </button>
              </div>
            </div>

            <div className="speed-list" aria-label="Playback speed">
              <div className="speed-label">
                <FastForward size={15} />
                <span>Speed</span>
              </div>
              <div className="speed-options">
                {speedOptions.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={option === speed ? "speed-option is-active" : "speed-option"}
                    onClick={() => setSpeed(option)}
                  >
                    {option}x
                  </button>
                ))}
              </div>
            </div>

            <div className="selected-trip">
              <div className="selected-trip-header">
                <Gauge size={15} />
                <span>{selectedTrip ? `Trip ${selectedTrip.id}` : "Select a vehicle"}</span>
              </div>
              {selectedTrip ? (
                <dl>
                  <div>
                    <dt>Depart</dt>
                    <dd>{formatClock(selectedTrip.departSec)}</dd>
                  </div>
                  <div>
                    <dt>Distance</dt>
                    <dd>{selectedTrip.distanceKm.toFixed(2)} km</dd>
                  </div>
                  <div>
                    <dt>Est. duration</dt>
                    <dd>{Math.round(selectedTrip.durationSec / 60)} min</dd>
                  </div>
                </dl>
              ) : (
                <p>Click a moving dot to inspect its current demand-trip replay.</p>
              )}
            </div>
          </section>
        </>
      ) : null}

      {activeSection === "replay" ? (
        <section className="timeline-panel" aria-label="Timeline">
          <div className="timeline-meta">
            <strong>06:00</strong>
            <span>{formatInteger(scenario?.summary.windowRequests ?? 701)} requests</span>
            <strong>07:00</strong>
          </div>
          <input
            type="range"
            min={scenario?.scenario.startSec ?? 21_600}
            max={scenario?.scenario.endSec ?? 25_200}
            value={timeSec}
            onChange={(event) => {
              setTimeSec(Number(event.target.value))
              setIsPlaying(false)
            }}
            aria-label="Simulation time"
          />
          <div className="timeline-track" aria-hidden="true">
            <span style={{ width: `${progressPercent}%` }} />
          </div>
        </section>
      ) : null}

      {loadError ? <div className="error-banner">{loadError}</div> : null}
    </main>
  )
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{typeof value === "number" ? formatInteger(value) : value}</strong>
    </div>
  )
}
