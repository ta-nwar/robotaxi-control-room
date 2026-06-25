import {
  Activity,
  CarFront,
  FastForward,
  Gauge,
  MapPinned,
  Moon,
  Pause,
  Play,
  RotateCcw,
  Sun,
  Timer,
} from "lucide-react"
import type { Feature, FeatureCollection, Geometry, LineString, Polygon } from "geojson"
import maplibregl, { type GeoJSONSource, type LngLatBoundsLike } from "maplibre-gl"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import "./App.css"

const mapStyleUrl = import.meta.env.VITE_MAPTILER_STYLE_URL as string | undefined
const configuredDarkMapStyleUrl = import.meta.env.VITE_MAPTILER_DARK_STYLE_URL as string | undefined
const darkMapStyleUrl = configuredDarkMapStyleUrl ?? maptilerDarkStyleUrl(mapStyleUrl)
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
  angle: number
  speed: number
  lane: string
  route: string
}

type SumoTrafficLightDisplay =
  | "green"
  | "yellow"
  | "red"
  | "orange"
  | "off"
  | "static"

type SumoTrafficLightState = {
  state: string
  display: SumoTrafficLightDisplay
  phase: number
}

type SumoFrame = {
  simSec: number
  vehicleCount: number
  vehicles: SumoVehicle[]
  departed: string[]
  arrived: string[]
  trafficLights: Record<string, SumoTrafficLightState>
  wallElapsedSec?: number
  requestedSpeed?: number
  effectiveSpeed?: number
}

type SumoNetwork = {
  available: boolean
  lanes: FeatureCollection<LineString>
  internalLanes: FeatureCollection<LineString>
  trafficLights: FeatureCollection
  signalLinks: FeatureCollection<LineString>
  counts: {
    lanes: number
    internalLanes: number
    trafficLights: number
    signalLinks: number
  }
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
type SumoLayerKey = "lanes" | "vehicles" | "trafficLights" | "boundary"
type AppTheme = "dark" | "light"
type MapCamera = {
  center: Coordinate
  zoom: number
  bearing: number
  pitch: number
}

const speedOptions = [1, 10, 30, 60, 120, 240]
const sumoSpeedOptions = [1, 2, 3, 10, 60, 600]
const replayLayerIds = [
  "roads-glow",
  "roads",
  "active-routes",
  "requests",
  "depot",
  "vehicles",
]
const referenceLayerIds = ["outside-mask", "service-area-line"]
const defaultSumoLayerVisibility: Record<SumoLayerKey, boolean> = {
  lanes: true,
  vehicles: true,
  trafficLights: true,
  boundary: true,
}
const sumoLayerIds: Record<SumoLayerKey, string[]> = {
  lanes: ["sumo-internal-lanes", "sumo-lanes"],
  vehicles: ["sumo-vehicles"],
  trafficLights: ["sumo-traffic-lights"],
  boundary: ["base-service-area-line"],
}

function formatClock(sec: number) {
  const hour = Math.floor(sec / 3600)
  const minute = Math.floor((sec % 3600) / 60)
  const second = Math.floor(sec % 60)
  return `${hour.toString().padStart(2, "0")}:${minute
    .toString()
    .padStart(2, "0")}:${second.toString().padStart(2, "0")}`
}

function maptilerDarkStyleUrl(styleUrl: string | undefined) {
  if (!styleUrl) {
    return undefined
  }

  try {
    const url = new URL(styleUrl)
    const key = url.searchParams.get("key")
    if (!key) {
      return styleUrl
    }

    return `https://api.maptiler.com/maps/dataviz-dark/style.json?key=${key}`
  } catch {
    return styleUrl
  }
}

function formatInteger(value: number) {
  return new Intl.NumberFormat("en-US").format(value)
}

function formatDuration(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(safeSeconds / 60)
  const remainingSeconds = safeSeconds % 60
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`
}

function formatSpeedFactor(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) {
    return "--"
  }

  return `${value.toFixed(value >= 100 ? 0 : 1)}x`
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
        angle: vehicle.angle,
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

function trafficLightFeatureCollection(
  network: SumoNetwork | null,
  frame: SumoFrame | null,
): FeatureCollection<LineString> {
  if (!network) {
    return emptyFeatureCollection()
  }

  const liveStates = frame?.trafficLights ?? {}

  return {
    type: "FeatureCollection",
    features: network.signalLinks.features.map((feature) => {
      const properties = feature.properties ?? {}
      const trafficLightId = String(properties.trafficLightId ?? "")
      const linkIndex =
        typeof properties.linkIndex === "number"
          ? properties.linkIndex
          : Number(properties.linkIndex)
      const liveState = trafficLightId ? liveStates[trafficLightId] : undefined
      const stateChar = liveState?.state?.[linkIndex] ?? ""

      return {
        ...feature,
        properties: {
          ...properties,
          display: displaySignalState(stateChar),
          state: stateChar,
          phase: liveState?.phase ?? null,
        },
      }
    }),
  }
}

function trafficLightStateSignature(trafficLights: Record<string, SumoTrafficLightState>) {
  return Object.keys(trafficLights)
    .sort()
    .map((id) => {
      const light = trafficLights[id]
      return `${id}:${light.phase}:${light.state}`
    })
    .join("|")
}

function displaySignalState(stateChar: string): SumoTrafficLightDisplay {
  if (stateChar === "G" || stateChar === "g") {
    return "green"
  }

  if (stateChar === "y" || stateChar === "Y") {
    return "yellow"
  }

  if (stateChar === "u") {
    return "orange"
  }

  if (stateChar === "r" || stateChar === "R" || stateChar === "s") {
    return "red"
  }

  if (stateChar === "o" || stateChar === "O") {
    return "off"
  }

  return "static"
}

function source(map: maplibregl.Map, id: string) {
  return map.getSource(id) as GeoJSONSource | undefined
}

function emptyFeatureCollection<T extends Geometry = Geometry>(): FeatureCollection<T> {
  return { type: "FeatureCollection", features: [] }
}

function ensureSumoLaneLayers(map: maplibregl.Map) {
  if (!map.isStyleLoaded()) {
    return false
  }

  if (!map.getSource("sumo-internal-lanes")) {
    map.addSource("sumo-internal-lanes", {
      type: "geojson",
      data: emptyFeatureCollection<LineString>(),
    })
  }

  if (!map.getSource("sumo-lanes")) {
    map.addSource("sumo-lanes", {
      type: "geojson",
      data: emptyFeatureCollection<LineString>(),
    })
  }

  const beforeVehicleLayer = map.getLayer("sumo-vehicles") ? "sumo-vehicles" : undefined

  if (!map.getLayer("sumo-internal-lanes")) {
    map.addLayer(
      {
        id: "sumo-internal-lanes",
        type: "line",
        source: "sumo-internal-lanes",
        paint: {
          "line-color": "#8bfff0",
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            11,
            0.24,
            14,
            0.58,
            16,
            1.1,
          ],
          "line-opacity": 0.2,
        },
      },
      beforeVehicleLayer,
    )
  }

  if (!map.getLayer("sumo-lanes")) {
    map.addLayer(
      {
        id: "sumo-lanes",
        type: "line",
        source: "sumo-lanes",
        paint: {
          "line-color": "#d8f7ff",
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            11,
            0.32,
            14,
            0.8,
            16,
            1.45,
          ],
          "line-opacity": 0.46,
        },
      },
      beforeVehicleLayer,
    )
  }

  return true
}

function applySumoOverlayTheme(map: maplibregl.Map, theme: AppTheme) {
  if (map.getLayer("sumo-internal-lanes")) {
    map.setPaintProperty(
      "sumo-internal-lanes",
      "line-color",
      theme === "light" ? "#138b86" : "#8bfff0",
    )
    map.setPaintProperty("sumo-internal-lanes", "line-opacity", theme === "light" ? 0.34 : 0.2)
  }

  if (map.getLayer("sumo-lanes")) {
    map.setPaintProperty(
      "sumo-lanes",
      "line-color",
      theme === "light" ? "#355c67" : "#d8f7ff",
    )
    map.setPaintProperty("sumo-lanes", "line-opacity", theme === "light" ? 0.68 : 0.46)
  }
}

function ensureSumoTrafficLightLayers(map: maplibregl.Map) {
  const hasSignalSource = Boolean(map.getSource("sumo-traffic-lights"))
  const hasSignalLayer = Boolean(map.getLayer("sumo-traffic-lights"))
  if (!map.isStyleLoaded() && (!hasSignalSource || !hasSignalLayer)) {
    return false
  }

  if (!hasSignalSource) {
    map.addSource("sumo-traffic-lights", {
      type: "geojson",
      data: emptyFeatureCollection<LineString>(),
    })
  }

  if (!hasSignalLayer) {
    map.addLayer(
      {
        id: "sumo-traffic-lights",
        type: "line",
        source: "sumo-traffic-lights",
        paint: {
          "line-color": [
            "match",
            ["get", "display"],
            "green",
            "#35e878",
            "yellow",
            "#d8c344",
            "red",
            "#e34343",
            "orange",
            "#c98532",
            "off",
            "#8b969b",
            "static",
            "#8b969b",
            "#8b969b",
          ],
          "line-width": [
            "interpolate",
            ["linear"],
            ["zoom"],
            13,
            0.35,
            15.2,
            0.95,
            16.2,
            1.55,
            18,
            2.25,
          ],
          "line-opacity": [
            "interpolate",
            ["linear"],
            ["zoom"],
            13,
            0.3,
            15.2,
            0.72,
            16.2,
            0.92,
            18,
            1,
          ],
        },
      },
      map.getLayer("sumo-vehicles") ? "sumo-vehicles" : undefined,
    )
  }

  return true
}

function createVehicleMarkerImage() {
  const pixelRatio = 4
  const canvas = document.createElement("canvas")
  canvas.width = 14 * pixelRatio
  canvas.height = 24 * pixelRatio
  const context = canvas.getContext("2d")
  if (!context) {
    return null
  }

  context.scale(pixelRatio, pixelRatio)
  context.translate(7, 12)

  context.shadowColor = "rgba(255, 182, 36, 0.7)"
  context.shadowBlur = 4
  context.fillStyle = "rgba(255, 191, 52, 0.38)"
  context.beginPath()
  context.roundRect(-4.2, -8.6, 8.4, 17.2, 3.7)
  context.fill()
  context.shadowBlur = 0

  context.fillStyle = "rgba(68, 43, 4, 0.38)"
  context.beginPath()
  context.roundRect(-3.2, -7.2, 6.4, 14.6, 2.8)
  context.fill()

  context.fillStyle = "#e5a51d"
  context.beginPath()
  context.moveTo(0, -9)
  context.bezierCurveTo(2.8, -7.3, 3.8, -4.4, 3.6, 4.5)
  context.bezierCurveTo(3.2, 7.3, 2.1, 8.5, 0, 8.9)
  context.bezierCurveTo(-2.1, 8.5, -3.2, 7.3, -3.6, 4.5)
  context.bezierCurveTo(-3.8, -4.4, -2.8, -7.3, 0, -9)
  context.closePath()
  context.fill()

  context.fillStyle = "#ffd76a"
  context.beginPath()
  context.roundRect(-1.8, -7.1, 3.6, 2.5, 1.1)
  context.fill()

  context.fillStyle = "#10161a"
  context.beginPath()
  context.roundRect(-2.1, -3.7, 4.2, 6.9, 1.9)
  context.fill()

  context.fillStyle = "#b87b10"
  context.beginPath()
  context.roundRect(-1.8, 5.1, 3.6, 2.2, 1)
  context.fill()

  return {
    data: context.getImageData(0, 0, canvas.width, canvas.height),
    pixelRatio,
  }
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

function setSumoLayerVisibility(
  map: maplibregl.Map,
  visibility: Record<SumoLayerKey, boolean>,
) {
  Object.entries(sumoLayerIds).forEach(([key, layerIds]) => {
    layerIds.forEach((layerId) => {
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(
          layerId,
          "visibility",
          visibility[key as SumoLayerKey] ? "visible" : "none",
        )
      }
    })
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

function withQueryParam(url: string, key: string, value: string | number) {
  const separator = url.includes("?") ? "&" : "?"
  return `${url}${separator}${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`
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
  const [sumoNetwork, setSumoNetwork] = useState<SumoNetwork | null>(null)
  const [isSumoRunning, setIsSumoRunning] = useState(false)
  const [sumoSessionKey, setSumoSessionKey] = useState(0)
  const [sumoPlaybackSpeed, setSumoPlaybackSpeed] = useState(60)
  const [sumoSeekSec, setSumoSeekSec] = useState(21_600)
  const [sumoSeekDraftSec, setSumoSeekDraftSec] = useState(21_600)
  const [isSumoScrubbing, setIsSumoScrubbing] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isTiltEnabled, setIsTiltEnabled] = useState(false)
  const [activeSection, setActiveSection] = useState<MapSection>("base")
  const [appTheme, setAppTheme] = useState<AppTheme>("dark")
  const [sumoLayerVisibility, setSumoLayerVisibilityState] = useState<
    Record<SumoLayerKey, boolean>
  >(defaultSumoLayerVisibility)
  const [baseMapReadyTick, setBaseMapReadyTick] = useState(0)
  const [speed, setSpeed] = useState(60)
  const [timeSec, setTimeSec] = useState(21_600)
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null)

  const mapContainerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const baseMapContainerRef = useRef<HTMLDivElement | null>(null)
  const baseMapRef = useRef<maplibregl.Map | null>(null)
  const activeSectionRef = useRef<MapSection>("base")
  const appThemeRef = useRef<AppTheme>("dark")
  const pendingThemeCameraRef = useRef<MapCamera | null>(null)
  const sumoNetworkRef = useRef<SumoNetwork | null>(null)
  const sumoLayerVisibilityRef = useRef<Record<SumoLayerKey, boolean>>(
    defaultSumoLayerVisibility,
  )
  const sumoTrafficLightGeojsonRef = useRef<FeatureCollection<LineString>>(
    emptyFeatureCollection<LineString>(),
  )
  const latestSumoFrameRef = useRef<SumoFrame | null>(null)
  const lastTrafficLightSignatureRef = useRef("")
  const lastSumoUiUpdateRef = useRef(0)
  const isSumoScrubbingRef = useRef(false)
  const animationRef = useRef<number | null>(null)
  const lastFrameRef = useRef<number | null>(null)

  useEffect(() => {
    sumoNetworkRef.current = sumoNetwork
  }, [sumoNetwork])

  useEffect(() => {
    sumoLayerVisibilityRef.current = sumoLayerVisibility
  }, [sumoLayerVisibility])

  useEffect(() => {
    isSumoScrubbingRef.current = isSumoScrubbing
  }, [isSumoScrubbing])

  useEffect(() => {
    appThemeRef.current = appTheme
  }, [appTheme])

  const currentMapStyleUrl = appTheme === "dark" ? darkMapStyleUrl : mapStyleUrl

  const captureActiveMapCamera = () => {
    const map = activeSection === "base" ? baseMapRef.current : mapRef.current
    if (!map) {
      return
    }

    const center = map.getCenter()
    pendingThemeCameraRef.current = {
      center: [center.lng, center.lat],
      zoom: map.getZoom(),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
    }
  }

  const syncSumoNetworkLayers = useCallback((map = baseMapRef.current) => {
    const network = sumoNetworkRef.current
    if (!map || !network || !ensureSumoLaneLayers(map)) {
      return false
    }

    ensureSumoTrafficLightLayers(map)
    applySumoOverlayTheme(map, appThemeRef.current)
    source(map, "sumo-lanes")?.setData(network.lanes)
    source(map, "sumo-internal-lanes")?.setData(network.internalLanes)
    source(map, "sumo-traffic-lights")?.setData(sumoTrafficLightGeojsonRef.current)
    setSumoLayerVisibility(map, sumoLayerVisibilityRef.current)
    map.triggerRepaint()
    return true
  }, [])

  const updateSumoTrafficLightSource = useCallback(
    (map: maplibregl.Map, frame: SumoFrame, force = false) => {
      const network = sumoNetworkRef.current
      if (!network || network.signalLinks.features.length === 0) {
        return false
      }

      const lightSignature = trafficLightStateSignature(frame.trafficLights)
      if (!force && lightSignature === lastTrafficLightSignatureRef.current) {
        return true
      }

      if (!ensureSumoTrafficLightLayers(map)) {
        return false
      }

      const nextTrafficLights = trafficLightFeatureCollection(network, frame)
      if (nextTrafficLights.features.length === 0) {
        return false
      }

      lastTrafficLightSignatureRef.current = lightSignature
      sumoTrafficLightGeojsonRef.current = nextTrafficLights
      source(map, "sumo-traffic-lights")?.setData(nextTrafficLights)
      map.triggerRepaint()
      return true
    },
    [],
  )

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

  const sumoTrafficLightGeojson = useMemo(
    () => trafficLightFeatureCollection(sumoNetwork, null),
    [sumoNetwork],
  )

  useEffect(() => {
    sumoTrafficLightGeojsonRef.current = sumoTrafficLightGeojson
    lastTrafficLightSignatureRef.current = ""
    const map = baseMapRef.current
    const latestFrame = latestSumoFrameRef.current
    if (map && latestFrame) {
      updateSumoTrafficLightSource(map, latestFrame, true)
    }
  }, [sumoTrafficLightGeojson, updateSumoTrafficLightSource])

  useEffect(() => {
    if (activeSection !== "base" || sumoNetwork || !scenarioApiUrl) {
      return
    }

    const networkUrl = backendHttpUrl("/sumo/reinickendorf/network")
    if (!networkUrl) {
      return
    }
    const url = networkUrl

    let isCancelled = false
    async function loadSumoNetwork() {
      try {
        const response = await fetch(url)
        if (!response.ok) {
          throw new Error(`SUMO network request failed: ${response.status}`)
        }

        const network = (await response.json()) as SumoNetwork
        if (!isCancelled && network.available) {
          setSumoNetwork(network)
        }
      } catch {
        if (!isCancelled) {
          setSumoStatus("Network layer unavailable")
        }
      }
    }

    void loadSumoNetwork()

    return () => {
      isCancelled = true
    }
  }, [activeSection, sumoNetwork])

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
      !currentMapStyleUrl
    ) {
      return
    }

    const restoredCamera = pendingThemeCameraRef.current
    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: currentMapStyleUrl,
      center: restoredCamera?.center ?? [13.3603, 52.5634],
      zoom: restoredCamera?.zoom ?? 12.4,
      pitch: restoredCamera?.pitch ?? 0,
      bearing: restoredCamera?.bearing ?? alignedFlatBearing,
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
          "fill-color": "#071015",
          "fill-opacity": 0.38,
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

      if (restoredCamera) {
        map.jumpTo(restoredCamera)
        pendingThemeCameraRef.current = null
      } else {
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
      }
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
  }, [activeSection, currentMapStyleUrl, scenario])

  useEffect(() => {
    if (
      !scenario ||
      activeSection !== "base" ||
      !baseMapContainerRef.current ||
      baseMapRef.current ||
      !currentMapStyleUrl
    ) {
      return
    }

    const restoredCamera = pendingThemeCameraRef.current
    const map = new maplibregl.Map({
      container: baseMapContainerRef.current,
      style: currentMapStyleUrl,
      center: restoredCamera?.center ?? [13.3603, 52.5634],
      zoom: restoredCamera?.zoom ?? 12.2,
      pitch: restoredCamera?.pitch ?? 0,
      bearing: restoredCamera?.bearing ?? 0,
      attributionControl: false,
    })

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right")
    map.addControl(new maplibregl.AttributionControl({ compact: true }))

    const syncNetworkLayers = () => {
      syncSumoNetworkLayers(map)
    }

    map.on("load", () => {
      map.addSource("base-service-area", {
        type: "geojson",
        data: scenario.serviceArea,
      })
      map.addSource("sumo-vehicles", {
        type: "geojson",
        data: emptyFeatureCollection(),
      })
      const vehicleMarker = createVehicleMarkerImage()
      if (vehicleMarker && !map.hasImage("sumo-vehicle-marker")) {
        map.addImage("sumo-vehicle-marker", vehicleMarker.data, {
          pixelRatio: vehicleMarker.pixelRatio,
        })
      }
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
        type: "symbol",
        source: "sumo-vehicles",
        layout: {
          "icon-image": "sumo-vehicle-marker",
          "icon-size": [
            "interpolate",
            ["linear"],
            ["zoom"],
            11,
            0.34,
            14,
            0.58,
            16,
            0.9,
          ],
          "icon-rotate": ["coalesce", ["get", "angle"], 0],
          "icon-rotation-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      })
      setSumoLayerVisibility(map, defaultSumoLayerVisibility)
      syncNetworkLayers()
      if (restoredCamera) {
        map.jumpTo(restoredCamera)
        pendingThemeCameraRef.current = null
      }
      setBaseMapReadyTick((tick) => tick + 1)
      map.once("idle", () => {
        syncNetworkLayers()
        setBaseMapReadyTick((tick) => tick + 1)
      })
    })
    map.on("idle", syncNetworkLayers)
    map.on("styledata", syncNetworkLayers)
    baseMapRef.current = map

    const resizeObserver = new ResizeObserver(() => map.resize())
    resizeObserver.observe(baseMapContainerRef.current)

    return () => {
      resizeObserver.disconnect()
      map.off("idle", syncNetworkLayers)
      map.off("styledata", syncNetworkLayers)
      map.remove()
      baseMapRef.current = null
      setBaseMapReadyTick((tick) => tick + 1)
    }
  }, [activeSection, currentMapStyleUrl, scenario, syncSumoNetworkLayers])

  useEffect(() => {
    const map = baseMapRef.current
    if (!map || !map.isStyleLoaded()) {
      return
    }

    source(map, "sumo-vehicles")?.setData(sumoVehicleGeojson)
  }, [baseMapReadyTick, sumoVehicleGeojson])

  useEffect(() => {
    syncSumoNetworkLayers()
  }, [baseMapReadyTick, sumoLayerVisibility, sumoNetwork, syncSumoNetworkLayers])

  useEffect(() => {
    const map = baseMapRef.current
    if (!map || !ensureSumoTrafficLightLayers(map)) {
      return
    }

    source(map, "sumo-traffic-lights")?.setData(sumoTrafficLightGeojson)
    setSumoLayerVisibility(map, sumoLayerVisibility)
    map.triggerRepaint()
  }, [baseMapReadyTick, sumoLayerVisibility, sumoTrafficLightGeojson])

  useEffect(() => {
    const map = baseMapRef.current
    if (!map || !map.isStyleLoaded()) {
      return
    }

    setSumoLayerVisibility(map, sumoLayerVisibility)
  }, [sumoLayerVisibility])

  useEffect(() => {
    if (activeSection !== "base") {
      return
    }

    if (!isSumoRunning) {
      setSumoStatus("Ready")
      return
    }

    const wsUrl = backendWebSocketUrl("/ws/sumo/reinickendorf")
    const summaryUrl = backendHttpUrl("/sumo/reinickendorf/summary")
    if (!wsUrl) {
      setSumoStatus("Local bundle only")
      return
    }

    const nextWsUrl = withQueryParam(
      withQueryParam(wsUrl, "speed", sumoPlaybackSpeed),
      "seekSec",
      sumoSeekSec,
    )
    let isClosed = false
    let socket: WebSocket | null = null
    lastTrafficLightSignatureRef.current = ""
    latestSumoFrameRef.current = null
    lastSumoUiUpdateRef.current = 0
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
          const nextFrame = {
            simSec: message.simSec,
            vehicleCount: message.vehicleCount,
            vehicles: message.vehicles,
            departed: message.departed,
            arrived: message.arrived,
            trafficLights: message.trafficLights ?? {},
            wallElapsedSec: message.wallElapsedSec,
            requestedSpeed: message.requestedSpeed,
            effectiveSpeed: message.effectiveSpeed,
          }
          latestSumoFrameRef.current = nextFrame
          const map = baseMapRef.current
          if (map?.isStyleLoaded()) {
            source(map, "sumo-vehicles")?.setData(pointFeatureCollection(nextFrame.vehicles))
          }
          if (map) {
            updateSumoTrafficLightSource(map, nextFrame)
          }
          const now = performance.now()
          if (now - lastSumoUiUpdateRef.current > 250) {
            lastSumoUiUpdateRef.current = now
            if (!isSumoScrubbingRef.current) {
              setSumoSeekDraftSec(message.simSec)
            }
            setSumoFrame(nextFrame)
            setSumoStatus("Streaming")
          }
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
          setIsSumoRunning(false)
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
  }, [
    activeSection,
    isSumoRunning,
    sumoPlaybackSpeed,
    sumoSeekSec,
    sumoSessionKey,
    updateSumoTrafficLightSource,
  ])

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
  const sumoWindowStartSec = scenario?.scenario.startSec ?? 21_600
  const sumoWindowEndSec = scenario?.scenario.endSec ?? 25_200
  const sumoProgressPercent = scenario
    ? ((sumoSeekDraftSec - sumoWindowStartSec) / scenario.scenario.durationSec) * 100
    : 0

  const commitSumoSeek = (targetSec = sumoSeekDraftSec) => {
    const nextSeekSec = Math.max(
      sumoWindowStartSec,
      Math.min(Math.round(targetSec), sumoWindowEndSec),
    )
    setIsSumoScrubbing(false)
    setSumoSeekDraftSec(nextSeekSec)
    setSumoSeekSec(nextSeekSec)
    setSumoFrame(null)
    if (isSumoRunning) {
      setSumoStatus("Seeking")
      setSumoSessionKey((current) => current + 1)
    } else {
      setSumoStatus("Ready")
    }
  }

  const reset = () => {
    if (!scenario) {
      return
    }
    setTimeSec(scenario.scenario.startSec)
    setSelectedTripId(null)
    setIsPlaying(false)
  }

  return (
    <main className={`app-shell theme-${appTheme}`}>
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
          <div className="panel-title-row">
            <div>
              <p className="label">SUMO Live</p>
              <h1>Reinickendorf microscopic replay</h1>
              <p>
                Vehicle positions are streamed from the SUMO backend through TraCI.
              </p>
            </div>
            <button
              type="button"
              className="theme-toggle"
              title={appTheme === "dark" ? "Switch to light map" : "Switch to dark map"}
              aria-label={appTheme === "dark" ? "Switch to light map" : "Switch to dark map"}
              onClick={() => {
                captureActiveMapCamera()
                setAppTheme((theme) => (theme === "dark" ? "light" : "dark"))
              }}
            >
              {appTheme === "dark" ? (
                <Sun size={16} aria-hidden="true" />
              ) : (
                <Moon size={16} aria-hidden="true" />
              )}
            </button>
          </div>
          <div className="sumo-status-grid">
            <Metric label="Status" value={sumoStatus} />
            <Metric label="Time" value={sumoFrame ? formatClock(sumoFrame.simSec) : "--"} />
            <Metric
              label="Elapsed"
              value={
                sumoFrame?.wallElapsedSec !== undefined
                  ? formatDuration(sumoFrame.wallElapsedSec)
                  : "--"
              }
            />
            <Metric label="Actual" value={formatSpeedFactor(sumoFrame?.effectiveSpeed)} />
            <Metric label="Vehicles" value={sumoFrame?.vehicleCount ?? 0} />
            <Metric
              label="Lights"
              value={
                sumoNetwork
                  ? `${sumoTrafficLightGeojson.features.length}/${sumoNetwork.counts.signalLinks}`
                  : "--"
              }
            />
          </div>
          <div className="sumo-run-controls" aria-label="SUMO run controls">
            <div className="sumo-timeline-panel" aria-label="SUMO timeline">
              <div className="timeline-meta">
                <strong>{formatClock(sumoSeekDraftSec)}</strong>
                <span>{scenario?.scenario.windowLabel ?? "06:00-07:00"}</span>
              </div>
              <input
                type="range"
                min={sumoWindowStartSec}
                max={sumoWindowEndSec}
                step={1}
                value={sumoSeekDraftSec}
                onChange={(event) => {
                  setIsSumoScrubbing(true)
                  setSumoSeekDraftSec(Number(event.target.value))
                }}
                onPointerDown={() => setIsSumoScrubbing(true)}
                onPointerUp={(event) => commitSumoSeek(Number(event.currentTarget.value))}
                onKeyUp={(event) => {
                  if (
                    event.key === "Enter" ||
                    event.key === "ArrowLeft" ||
                    event.key === "ArrowRight" ||
                    event.key === "Home" ||
                    event.key === "End"
                  ) {
                    commitSumoSeek(Number(event.currentTarget.value))
                  }
                }}
                onBlur={(event) => {
                  if (isSumoScrubbingRef.current) {
                    commitSumoSeek(Number(event.currentTarget.value))
                  }
                }}
                aria-label="Seek SUMO simulation time"
              />
              <div className="timeline-track" aria-hidden="true">
                <span style={{ width: `${sumoProgressPercent}%` }} />
              </div>
            </div>
            <div className="delay-control">
              <div className="delay-control-header">
                <span>Speed</span>
                <strong>{sumoPlaybackSpeed}x</strong>
              </div>
              <input
                type="range"
                min={0}
                max={sumoSpeedOptions.length - 1}
                step={1}
                value={Math.max(0, sumoSpeedOptions.indexOf(sumoPlaybackSpeed))}
                onChange={(event) => {
                  const nextSpeed =
                    sumoSpeedOptions[Number(event.target.value)] ?? sumoPlaybackSpeed
                  setSumoSeekDraftSec(sumoFrame?.simSec ?? sumoSeekDraftSec)
                  setSumoSeekSec(sumoFrame?.simSec ?? sumoSeekDraftSec)
                  setSumoPlaybackSpeed(nextSpeed)
                  if (isSumoRunning) {
                    setSumoStatus("Changing speed")
                    setSumoSessionKey((current) => current + 1)
                  }
                }}
                aria-label="SUMO playback speed"
              />
              <div className="delay-options">
                {sumoSpeedOptions.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={
                      option === sumoPlaybackSpeed ? "delay-option is-active" : "delay-option"
                    }
                    onClick={() => {
                      setSumoSeekDraftSec(sumoFrame?.simSec ?? sumoSeekDraftSec)
                      setSumoSeekSec(sumoFrame?.simSec ?? sumoSeekDraftSec)
                      setSumoPlaybackSpeed(option)
                      if (isSumoRunning) {
                        setSumoStatus("Changing speed")
                        setSumoSessionKey((current) => current + 1)
                      }
                    }}
                  >
                    {option}x
                  </button>
                ))}
              </div>
            </div>
            <div className="control-row">
              <button
                type="button"
                className="icon-button"
                disabled={isSumoRunning}
                onClick={() => {
                  commitSumoSeek()
                  setSumoFrame(null)
                  setIsSumoRunning(true)
                }}
              >
                <Play size={16} />
                <span>Start</span>
              </button>
              <button
                type="button"
                className="icon-button"
                disabled={!isSumoRunning}
                onClick={() => setIsSumoRunning(false)}
              >
                <Pause size={16} />
                <span>Stop</span>
              </button>
            </div>
          </div>
          <div className="sumo-layer-list" aria-label="SUMO map layers">
            <LayerToggle
              label="Lanes"
              active={sumoLayerVisibility.lanes}
              onClick={() =>
                setSumoLayerVisibilityState((current) => ({
                  ...current,
                  lanes: !current.lanes,
                }))
              }
            />
            <LayerToggle
              label="Vehicles"
              active={sumoLayerVisibility.vehicles}
              onClick={() =>
                setSumoLayerVisibilityState((current) => ({
                  ...current,
                  vehicles: !current.vehicles,
                }))
              }
            />
            <LayerToggle
              label="Lights"
              active={sumoLayerVisibility.trafficLights}
              onClick={() =>
                setSumoLayerVisibilityState((current) => ({
                  ...current,
                  trafficLights: !current.trafficLights,
                }))
              }
            />
            <LayerToggle
              label="Boundary"
              active={sumoLayerVisibility.boundary}
              onClick={() =>
                setSumoLayerVisibilityState((current) => ({
                  ...current,
                  boundary: !current.boundary,
                }))
              }
            />
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={() => {
              commitSumoSeek()
              if (!isSumoRunning) {
                setIsSumoRunning(true)
              }
            }}
          >
            <RotateCcw size={16} />
            <span>{isSumoRunning ? "Restart stream" : "Start stream"}</span>
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

function LayerToggle({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={active ? "layer-toggle is-active" : "layer-toggle"}
      onClick={onClick}
      aria-pressed={active}
    >
      <span />
      {label}
    </button>
  )
}
