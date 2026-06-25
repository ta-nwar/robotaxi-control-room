import { MapPinned, Moon, Pause, Play, RotateCcw, StepForward, Sun } from "lucide-react"
import type { FeatureCollection, Geometry, LineString } from "geojson"
import maplibregl, { type GeoJSONSource } from "maplibre-gl"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import "./App.css"

const mapStyleUrl = import.meta.env.VITE_MAPTILER_STYLE_URL as string | undefined
const configuredDarkMapStyleUrl = import.meta.env.VITE_MAPTILER_DARK_STYLE_URL as string | undefined
const darkMapStyleUrl = configuredDarkMapStyleUrl ?? maptilerDarkStyleUrl(mapStyleUrl)
const scenarioApiUrl = import.meta.env.VITE_SCENARIO_API_URL as string | undefined
const districtScope = "reinickendorf-district"
const playbackFrameIntervalMs = 20
const playbackLowWatermarkFrames = 250
const playbackModes = [5, 10, 25, 50, 100, 250] as const
type PlaybackMode = (typeof playbackModes)[number]
const districtBounds: [Coordinate, Coordinate] = [
  [13.2016158, 52.5488064],
  [13.3892817, 52.6607387],
]

type Coordinate = [number, number]

type SumoVehicle = {
  id: string
  lon: number
  lat: number
  angle: number
  speed?: number
  lane?: string
  route?: string
  kind?: "background"
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
  vehicleCount?: number
  vehicles: SumoVehicle[]
  departed?: string[]
  arrived?: string[]
  trafficLights: Record<string, SumoTrafficLightState | string>
  running?: boolean
  delayMs?: number
}

type SumoSimStatus = {
  status: string
  statusText: string
  simSec: number
  step: number
  totalSteps: number
  delayMs?: number
  running?: boolean
  elapsedSec?: number
}

type SumoNetwork = {
  available: boolean
  scope?: string
  boundary?: FeatureCollection<Geometry>
  lanes: FeatureCollection<LineString>
  internalLanes: FeatureCollection<LineString>
  trafficLights: FeatureCollection
  signalLinks: FeatureCollection<LineString>
  counts: {
    lanes: number
    internalLanes: number
    trafficLights: number
    signalLinks: number
    totalLanes?: number
    totalInternalLanes?: number
  }
  limited?: boolean
}

type SumoLayerKey = "lanes" | "vehicles" | "trafficLights" | "boundary"
type AppTheme = "dark" | "light"
type MapCamera = {
  center: Coordinate
  zoom: number
  bearing: number
  pitch: number
}

type RenderDiagnostics = {
  renderFps: number
  dataFps: number
  backendStepMs: number
  backendFrameMs: number
  backendVehicleIdMs: number
  backendVehicleLoopMs: number
  backendTrafficLightMs: number
  backendChunkMs: number
  backendSendMs: number
  frontendParseMs: number
  frontendAppendMs: number
  chunkFrames: number
}

type PlaybackStatus = "Idle" | "Buffering" | "Playing" | "Paused" | "Ended" | "Error"

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

function maptilerDarkStyleUrl(styleUrl: string | undefined) {
  if (!styleUrl) {
    return undefined
  }

  if (styleUrl.includes("/bright-v2/")) {
    return styleUrl.replace("/bright-v2/", "/dataviz-dark/")
  }

  return styleUrl
}

function formatInteger(value: number) {
  return new Intl.NumberFormat("en-US").format(value)
}

function formatStepWidth(mode: PlaybackMode) {
  const stepWidth = mode / 50
  return Number.isInteger(stepWidth) ? `${stepWidth}s` : `${stepWidth.toFixed(1)}s`
}

function formatSimClock(simSec: number | null | undefined) {
  if (typeof simSec !== "number" || !Number.isFinite(simSec)) {
    return "--"
  }

  const wholeSeconds = Math.max(0, Math.floor(simSec))
  const hours = Math.floor(wholeSeconds / 3600)
  const minutes = Math.floor((wholeSeconds % 3600) / 60)
  const seconds = wholeSeconds % 60

  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isSumoFrame(value: unknown): value is SumoFrame {
  if (!isRecord(value)) {
    return false
  }

  return (
    typeof value.simSec === "number" &&
    Array.isArray(value.vehicles) &&
    isRecord(value.trafficLights)
  )
}

function normalizePlaybackFrame(frame: SumoFrame): SumoFrame {
  return {
    ...frame,
    vehicleCount: frame.vehicleCount ?? frame.vehicles.length,
    departed: frame.departed ?? [],
    arrived: frame.arrived ?? [],
    vehicles: frame.vehicles.map((vehicle) => ({
      ...vehicle,
      speed: vehicle.speed ?? 0,
      lane: vehicle.lane ?? "",
      route: vehicle.route ?? "",
      kind: vehicle.kind ?? "background",
    })),
  }
}

function playbackFramesFromPayload(payload: unknown): SumoFrame[] {
  if (isSumoFrame(payload)) {
    return [normalizePlaybackFrame(payload)]
  }

  if (Array.isArray(payload)) {
    return payload.filter(isSumoFrame).map(normalizePlaybackFrame)
  }

  if (!isRecord(payload)) {
    return []
  }

  const directFrames = payload.frames
  if (Array.isArray(directFrames)) {
    return directFrames.filter(isSumoFrame).map(normalizePlaybackFrame)
  }

  const directFrame = payload.frame
  if (isSumoFrame(directFrame)) {
    return [normalizePlaybackFrame(directFrame)]
  }

  const nestedData = payload.data
  if (nestedData !== undefined) {
    const nestedFrames = playbackFramesFromPayload(nestedData)
    if (nestedFrames.length > 0) {
      return nestedFrames
    }
  }

  const nestedChunk = payload.chunk
  if (nestedChunk !== undefined) {
    return playbackFramesFromPayload(nestedChunk)
  }

  return []
}

function playbackCursorFromPayload(payload: unknown) {
  if (!isRecord(payload)) {
    return null
  }

  const cursor = payload.nextCursor ?? payload.cursor
  if (typeof cursor === "string" || typeof cursor === "number") {
    return cursor
  }

  return null
}

function playbackDoneFromPayload(payload: unknown) {
  if (!isRecord(payload)) {
    return false
  }

  return payload.done === true || payload.type === "done"
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
        kind: vehicle.kind,
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
      const stateString = typeof liveState === "string" ? liveState : liveState?.state
      const stateChar = stateString?.[linkIndex] ?? ""

      return {
        ...feature,
        properties: {
          ...properties,
          display: displaySignalState(stateChar),
          state: stateChar,
          phase: typeof liveState === "string" ? null : liveState?.phase ?? null,
        },
      }
    }),
  }
}

function trafficLightStateSignature(trafficLights: Record<string, SumoTrafficLightState | string>) {
  return Object.keys(trafficLights)
    .sort()
    .map((id) => {
      const light = trafficLights[id]
      return typeof light === "string" ? `${id}:${light}` : `${id}:${light.phase}:${light.state}`
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

function drawRoundedRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const safeRadius = Math.max(0, Math.min(radius, width / 2, height / 2))
  context.beginPath()
  context.moveTo(x + safeRadius, y)
  context.lineTo(x + width - safeRadius, y)
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius)
  context.lineTo(x + width, y + height - safeRadius)
  context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height)
  context.lineTo(x + safeRadius, y + height)
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius)
  context.lineTo(x, y + safeRadius)
  context.quadraticCurveTo(x, y, x + safeRadius, y)
  context.closePath()
}

function createBackgroundVehicleMarkerImage() {
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
  context.fillStyle = "rgba(7, 13, 17, 0.38)"
  drawRoundedRect(context, -3.4, -7.6, 6.8, 15.4, 3)
  context.fill()

  context.fillStyle = "#f2f6f7"
  context.beginPath()
  context.moveTo(0, -9)
  context.bezierCurveTo(2.7, -7.1, 3.7, -4.4, 3.5, 4.3)
  context.bezierCurveTo(3.1, 7.1, 2, 8.4, 0, 8.8)
  context.bezierCurveTo(-2, 8.4, -3.1, 7.1, -3.5, 4.3)
  context.bezierCurveTo(-3.7, -4.4, -2.7, -7.1, 0, -9)
  context.closePath()
  context.fill()

  context.fillStyle = "#1f2b31"
  drawRoundedRect(context, -2, -3.7, 4, 6.8, 1.8)
  context.fill()
  context.fillStyle = "#d8e1e4"
  drawRoundedRect(context, -1.7, -7, 3.4, 2.4, 1)
  context.fill()
  context.fillStyle = "#c8d2d6"
  drawRoundedRect(context, -1.7, 5.1, 3.4, 2.1, 1)
  context.fill()

  return {
    data: context.getImageData(0, 0, canvas.width, canvas.height),
    pixelRatio,
  }
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

function backendWebSocketUrl(path: string) {
  if (!scenarioApiUrl) {
    return null
  }

  if (path.startsWith("ws://") || path.startsWith("wss://")) {
    return path
  }

  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path.startsWith("https://")
      ? path.replace("https://", "wss://")
      : path.replace("http://", "ws://")
  }

  const baseUrl = scenarioApiUrl.replace(/\/$/, "")
  const protocolUrl = baseUrl.startsWith("https://")
    ? baseUrl.replace("https://", "wss://")
    : baseUrl.replace("http://", "ws://")
  return `${protocolUrl}${path.startsWith("/") ? path : `/${path}`}`
}

function backendHttpUrl(path: string) {
  if (!scenarioApiUrl) {
    return null
  }

  return `${scenarioApiUrl.replace(/\/$/, "")}${path}`
}

export default function App() {
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sumoStatus, setSumoStatus] = useState("Idle")
  const [sumoFrame, setSumoFrame] = useState<SumoFrame | null>(null)
  const [sumoSimStatus, setSumoSimStatus] = useState<SumoSimStatus | null>(null)
  const [sumoNetwork, setSumoNetwork] = useState<SumoNetwork | null>(null)
  const [isSumoNetworkLoading, setIsSumoNetworkLoading] = useState(false)
  const [isSumoConnected, setIsSumoConnected] = useState(false)
  const [isSumoRunning, setIsSumoRunning] = useState(false)
  const [sumoDelayMs, setSumoDelayMs] = useState(0)
  const [playbackStatus, setPlaybackStatus] = useState<PlaybackStatus>("Idle")
  const [playbackBufferSize, setPlaybackBufferSize] = useState(0)
  const [isPlaybackPlaying, setIsPlaybackPlaying] = useState(false)
  const [playbackAppliedFrames, setPlaybackAppliedFrames] = useState(0)
  const [playbackMode, setPlaybackMode] = useState<PlaybackMode>(10)
  const [appTheme, setAppTheme] = useState<AppTheme>("light")
  const [isMapEnabled, setIsMapEnabled] = useState(true)
  const [diagnostics, setDiagnostics] = useState<RenderDiagnostics>({
    renderFps: 0,
    dataFps: 0,
    backendStepMs: 0,
    backendFrameMs: 0,
    backendVehicleIdMs: 0,
    backendVehicleLoopMs: 0,
    backendTrafficLightMs: 0,
    backendChunkMs: 0,
    backendSendMs: 0,
    frontendParseMs: 0,
    frontendAppendMs: 0,
    chunkFrames: 0,
  })
  const [sumoLayerVisibility, setSumoLayerVisibilityState] = useState<
    Record<SumoLayerKey, boolean>
  >(defaultSumoLayerVisibility)
  const [baseMapReadyTick, setBaseMapReadyTick] = useState(0)

  const baseMapContainerRef = useRef<HTMLDivElement | null>(null)
  const baseMapRef = useRef<maplibregl.Map | null>(null)
  const appThemeRef = useRef<AppTheme>("light")
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
  const sumoSocketRef = useRef<WebSocket | null>(null)
  const sumoDelayMsRef = useRef(0)
  const dataUpdateCountRef = useRef(0)
  const playbackSocketRef = useRef<WebSocket | null>(null)
  const playbackAbortControllerRef = useRef<AbortController | null>(null)
  const playbackTimelineRef = useRef<SumoFrame[]>([])
  const playbackCursorRef = useRef<string | number | null>(null)
  const playbackDoneRef = useRef(false)
  const playbackFetchInFlightRef = useRef(false)
  const isPlaybackPlayingRef = useRef(false)
  const playbackAnimationFrameRef = useRef(0)
  const playbackLastTickAtRef = useRef<number | null>(null)
  const playbackFrameRemainderMsRef = useRef(0)
  const playbackAppliedIndexRef = useRef(-1)
  const playbackModeRef = useRef<PlaybackMode>(10)
  const staticOverlaySyncFrameRef = useRef<number | null>(null)

  const currentMapStyleUrl = appTheme === "dark" ? darkMapStyleUrl : mapStyleUrl

  useEffect(() => {
    sumoNetworkRef.current = sumoNetwork
  }, [sumoNetwork])

  useEffect(() => {
    sumoLayerVisibilityRef.current = sumoLayerVisibility
  }, [sumoLayerVisibility])

  useEffect(() => {
    sumoDelayMsRef.current = sumoDelayMs
  }, [sumoDelayMs])

  useEffect(() => {
    isPlaybackPlayingRef.current = isPlaybackPlaying
  }, [isPlaybackPlaying])

  useEffect(() => {
    playbackModeRef.current = playbackMode
  }, [playbackMode])

  useEffect(() => {
    appThemeRef.current = appTheme
  }, [appTheme])

  useEffect(() => {
    let animationFrameId = 0
    let renderFrames = 0
    let lastRenderSampleAt = performance.now()

    const sampleRenderFps = (now: number) => {
      renderFrames += 1
      const elapsedMs = now - lastRenderSampleAt
      if (elapsedMs >= 1000) {
        const nextRenderFps = Math.round((renderFrames * 1000) / elapsedMs)
        setDiagnostics((current) => ({ ...current, renderFps: nextRenderFps }))
        renderFrames = 0
        lastRenderSampleAt = now
      }
      animationFrameId = requestAnimationFrame(sampleRenderFps)
    }

    animationFrameId = requestAnimationFrame(sampleRenderFps)

    return () => {
      cancelAnimationFrame(animationFrameId)
    }
  }, [])

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      const nextDataFps = dataUpdateCountRef.current
      dataUpdateCountRef.current = 0
      setDiagnostics((current) => ({ ...current, dataFps: nextDataFps }))
    }, 1000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [])

  const captureActiveMapCamera = () => {
    const map = baseMapRef.current
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
    if (!map || !network || !map.isStyleLoaded() || !ensureSumoLaneLayers(map)) {
      return false
    }

    ensureSumoTrafficLightLayers(map)
    applySumoOverlayTheme(map, appThemeRef.current)
    source(map, "sumo-lanes")?.setData(network.lanes)
    source(map, "sumo-internal-lanes")?.setData(network.internalLanes)
    source(map, "sumo-traffic-lights")?.setData(sumoTrafficLightGeojsonRef.current)
    setSumoLayerVisibility(map, sumoLayerVisibilityRef.current)
    return true
  }, [])

  const scheduleStaticOverlaySync = useCallback(() => {
    if (staticOverlaySyncFrameRef.current !== null) {
      cancelAnimationFrame(staticOverlaySyncFrameRef.current)
      staticOverlaySyncFrameRef.current = null
    }

    let attempts = 0
    const trySync = () => {
      attempts += 1
      if (syncSumoNetworkLayers() || attempts >= 90) {
        staticOverlaySyncFrameRef.current = null
        return
      }

      staticOverlaySyncFrameRef.current = requestAnimationFrame(trySync)
    }

    staticOverlaySyncFrameRef.current = requestAnimationFrame(trySync)
  }, [syncSumoNetworkLayers])

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

  const appendPlaybackFrames = useCallback((frames: SumoFrame[]) => {
    if (frames.length === 0) {
      return
    }

    playbackTimelineRef.current.push(...frames)
    setPlaybackBufferSize(
      Math.max(0, playbackTimelineRef.current.length - playbackAppliedIndexRef.current - 1),
    )
    if (isPlaybackPlayingRef.current) {
      setPlaybackStatus("Playing")
    }
  }, [])

  const applyPlaybackFrame = useCallback(
    (frame: SumoFrame) => {
      latestSumoFrameRef.current = frame
      const map = baseMapRef.current
      if (map) {
        source(map, "sumo-vehicles")?.setData(pointFeatureCollection(frame.vehicles))
        updateSumoTrafficLightSource(map, frame)
        map.triggerRepaint()
      }

      dataUpdateCountRef.current += 1
      setPlaybackAppliedFrames((count) => count + 1)
      setSumoFrame(frame)
    },
    [updateSumoTrafficLightSource],
  )

  const requestPlaybackChunk = useCallback(async () => {
    if (playbackSocketRef.current || playbackDoneRef.current) {
      return
    }

    const playbackUrl = backendWebSocketUrl(
      `/ws/sumo/${districtScope}/playback?speed=${playbackModeRef.current}`,
    )
    if (!playbackUrl) {
      setPlaybackStatus("Error")
      setLoadError("Backend URL is not configured.")
      return
    }

    playbackFetchInFlightRef.current = true
    setPlaybackStatus((status) => (status === "Idle" || status === "Paused" ? "Buffering" : status))

    const handlePlaybackPayload = (payload: unknown) => {
      const frames = playbackFramesFromPayload(payload)
      appendPlaybackFrames(frames)

      const nextCursor = playbackCursorFromPayload(payload)
      if (nextCursor !== null) {
        playbackCursorRef.current = nextCursor
      }

      if (playbackDoneFromPayload(payload)) {
        playbackDoneRef.current = true
      }
    }

    const socket = new WebSocket(playbackUrl)
    playbackSocketRef.current = socket

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ command: "start" }))
    })

    socket.addEventListener("message", (event) => {
      const parseStartedAt = performance.now()
      const payload = JSON.parse(event.data) as {
        type?: string
        message?: string
        sendMs?: number
        profile?: {
          frames?: number
          stepMs?: number
          frameMs?: number
          vehicleIdMs?: number
          vehicleLoopMs?: number
          trafficLightMs?: number
          chunkMs?: number
        }
      }
      const frontendParseMs = performance.now() - parseStartedAt
      if (payload.type === "chunk") {
        const appendStartedAt = performance.now()
        handlePlaybackPayload(payload)
        const frontendAppendMs = performance.now() - appendStartedAt
        const profile = payload.profile
        if (profile) {
          setDiagnostics((current) => ({
            ...current,
            backendStepMs: profile.stepMs ?? current.backendStepMs,
            backendFrameMs: profile.frameMs ?? current.backendFrameMs,
            backendVehicleIdMs: profile.vehicleIdMs ?? current.backendVehicleIdMs,
            backendVehicleLoopMs: profile.vehicleLoopMs ?? current.backendVehicleLoopMs,
            backendTrafficLightMs: profile.trafficLightMs ?? current.backendTrafficLightMs,
            backendChunkMs: profile.chunkMs ?? current.backendChunkMs,
            frontendParseMs: Math.round(frontendParseMs * 100) / 100,
            frontendAppendMs: Math.round(frontendAppendMs * 100) / 100,
            chunkFrames: profile.frames ?? current.chunkFrames,
          }))
        }
        if (
          playbackTimelineRef.current.length > playbackAppliedIndexRef.current + 1 &&
          isPlaybackPlayingRef.current
        ) {
          setPlaybackStatus("Playing")
        }
        return
      }

      if (payload.type === "done") {
        playbackDoneRef.current = true
        if (playbackTimelineRef.current.length <= playbackAppliedIndexRef.current + 1) {
          setPlaybackStatus("Ended")
        }
        return
      }

      if (payload.type === "stopped") {
        playbackDoneRef.current = true
        setPlaybackStatus("Paused")
        return
      }

      if (payload.type === "error") {
        setPlaybackStatus("Error")
        setLoadError(payload.message ?? "Playback unavailable.")
      }

      if (payload.type === "transportProfile" && typeof payload.sendMs === "number") {
        setDiagnostics((current) => ({ ...current, backendSendMs: payload.sendMs ?? 0 }))
        return
      }
    })

    socket.addEventListener("close", () => {
      if (playbackSocketRef.current === socket) {
        playbackSocketRef.current = null
      }
      playbackFetchInFlightRef.current = false
      setPlaybackBufferSize(
        Math.max(0, playbackTimelineRef.current.length - playbackAppliedIndexRef.current - 1),
      )
    })

    socket.addEventListener("error", () => {
      setPlaybackStatus("Error")
      setLoadError("Playback websocket unavailable.")
    })
  }, [appendPlaybackFrames])

  const startPlayback = useCallback(() => {
    const remainingFrames =
      playbackTimelineRef.current.length - Math.max(0, playbackAppliedIndexRef.current + 1)
    if (playbackDoneRef.current && remainingFrames <= 0) {
      playbackCursorRef.current = null
      playbackDoneRef.current = false
      playbackTimelineRef.current = []
      playbackAppliedIndexRef.current = -1
      setPlaybackAppliedFrames(0)
    }

    setLoadError(null)
    setIsPlaybackPlaying(true)
    isPlaybackPlayingRef.current = true
    playbackLastTickAtRef.current = null
    playbackFrameRemainderMsRef.current = 0
    setPlaybackStatus(
      playbackTimelineRef.current.length > playbackAppliedIndexRef.current + 1
        ? "Playing"
        : "Buffering",
    )
    void requestPlaybackChunk()
  }, [requestPlaybackChunk])

  const canChangePlaybackMode =
    !isPlaybackPlaying &&
    playbackStatus !== "Buffering" &&
    playbackTimelineRef.current.length === 0 &&
    playbackAppliedIndexRef.current < 0

  const pausePlayback = useCallback(() => {
    setIsPlaybackPlaying(false)
    isPlaybackPlayingRef.current = false
    setPlaybackStatus(playbackDoneRef.current ? "Ended" : "Paused")
  }, [])

  const resetPlayback = useCallback(() => {
    playbackAbortControllerRef.current?.abort()
    playbackAbortControllerRef.current = null
    playbackSocketRef.current?.send(JSON.stringify({ command: "stop" }))
    playbackSocketRef.current?.close()
    playbackSocketRef.current = null
    playbackFetchInFlightRef.current = false
    playbackTimelineRef.current = []
    playbackCursorRef.current = null
    playbackDoneRef.current = false
    playbackLastTickAtRef.current = null
    playbackFrameRemainderMsRef.current = 0
    playbackAppliedIndexRef.current = -1
    lastTrafficLightSignatureRef.current = ""
    latestSumoFrameRef.current = null

    const map = baseMapRef.current
    if (map) {
      source(map, "sumo-vehicles")?.setData(emptyFeatureCollection())
      const resetTrafficLights = trafficLightFeatureCollection(sumoNetworkRef.current, null)
      sumoTrafficLightGeojsonRef.current = resetTrafficLights
      source(map, "sumo-traffic-lights")?.setData(resetTrafficLights)
      map.triggerRepaint()
    }

    setIsPlaybackPlaying(false)
    isPlaybackPlayingRef.current = false
    setPlaybackBufferSize(0)
    setPlaybackAppliedFrames(0)
    setPlaybackStatus("Idle")
    setSumoFrame(null)
  }, [])

  useEffect(() => {
    if (!isPlaybackPlaying) {
      return
    }

    const tickPlayback = (now: number) => {
      if (!isPlaybackPlayingRef.current) {
        return
      }

      if (playbackLastTickAtRef.current === null) {
        playbackLastTickAtRef.current = now
      }

      const deltaMs = Math.min(250, now - playbackLastTickAtRef.current)
      playbackLastTickAtRef.current = now
      playbackFrameRemainderMsRef.current += deltaMs
      const timeline = playbackTimelineRef.current
      const targetIndex = playbackAppliedIndexRef.current + 1

      if (playbackFrameRemainderMsRef.current >= playbackFrameIntervalMs) {
        if (targetIndex < timeline.length) {
          playbackFrameRemainderMsRef.current -= playbackFrameIntervalMs
          playbackAppliedIndexRef.current = targetIndex
          applyPlaybackFrame(timeline[targetIndex])
          const remainingFrames = Math.max(0, timeline.length - targetIndex - 1)
          setPlaybackBufferSize(remainingFrames)
          setPlaybackStatus("Playing")

          if (remainingFrames <= playbackLowWatermarkFrames) {
            void requestPlaybackChunk()
          }
        } else if (playbackDoneRef.current) {
          setIsPlaybackPlaying(false)
          isPlaybackPlayingRef.current = false
          setPlaybackStatus("Ended")
          return
        } else {
          playbackFrameRemainderMsRef.current = Math.min(
            playbackFrameRemainderMsRef.current,
            playbackFrameIntervalMs,
          )
          setPlaybackStatus("Buffering")
          void requestPlaybackChunk()
        }
      }

      playbackAnimationFrameRef.current = requestAnimationFrame(tickPlayback)
    }

    playbackAnimationFrameRef.current = requestAnimationFrame(tickPlayback)

    return () => {
      cancelAnimationFrame(playbackAnimationFrameRef.current)
    }
  }, [applyPlaybackFrame, isPlaybackPlaying, requestPlaybackChunk])

  useEffect(() => {
    return () => {
      playbackAbortControllerRef.current?.abort()
    }
  }, [])

  const sumoVehicleGeojson = useMemo(
    () => pointFeatureCollection(sumoFrame?.vehicles ?? []),
    [sumoFrame],
  )

  const sumoTrafficLightGeojson = useMemo(
    () => trafficLightFeatureCollection(sumoNetwork, null),
    [sumoNetwork],
  )

  const sumoBoundaryGeojson = sumoNetwork?.boundary ?? null

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
    const map = baseMapRef.current
    if (!map) {
      return
    }

    source(map, "base-service-area")?.setData(
      sumoBoundaryGeojson ?? emptyFeatureCollection<Geometry>(),
    )
  }, [baseMapReadyTick, sumoBoundaryGeojson])

  useEffect(() => {
    if (!scenarioApiUrl) {
      setLoadError("Backend URL is not configured.")
      setSumoStatus("Backend not configured")
      setIsSumoNetworkLoading(false)
      return
    }

    const networkUrl = backendHttpUrl(`/sumo/${districtScope}/network`)
    if (!networkUrl) {
      setIsSumoNetworkLoading(false)
      return
    }
    const url = networkUrl

    let isCancelled = false
    async function loadSumoNetwork() {
      setIsSumoNetworkLoading(true)
      try {
        const response = await fetch(url)
        if (!response.ok) {
          throw new Error(`SUMO network request failed: ${response.status}`)
        }

        const network = (await response.json()) as SumoNetwork
        if (isCancelled) {
          return
        }

        if (!network.available) {
          throw new Error("SUMO network is unavailable.")
        }

        setSumoNetwork(network)
        setSumoStatus("Ready")
        setLoadError(null)
      } catch (error) {
        if (!isCancelled) {
          setSumoStatus("Network layer unavailable")
          setLoadError(error instanceof Error ? error.message : "Network layer unavailable.")
        }
      } finally {
        if (!isCancelled) {
          setIsSumoNetworkLoading(false)
        }
      }
    }

    void loadSumoNetwork()

    return () => {
      isCancelled = true
    }
  }, [])

  useEffect(() => {
    if (!isMapEnabled || !baseMapContainerRef.current || baseMapRef.current || !currentMapStyleUrl) {
      return
    }

    const restoredCamera = pendingThemeCameraRef.current
    const map = new maplibregl.Map({
      container: baseMapContainerRef.current,
      style: currentMapStyleUrl,
      ...(restoredCamera
        ? {
            center: restoredCamera.center,
            zoom: restoredCamera.zoom,
          }
        : {
            bounds: districtBounds,
            fitBoundsOptions: {
              padding: { top: 48, bottom: 48, left: 104, right: 430 },
              maxZoom: 11.75,
            },
          }),
      pitch: restoredCamera?.pitch ?? 0,
      bearing: restoredCamera?.bearing ?? 0,
      attributionControl: false,
    })

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right")
    map.addControl(new maplibregl.AttributionControl({ compact: true }))

    map.on("load", () => {
      map.addSource("base-service-area", {
        type: "geojson",
        data: emptyFeatureCollection<Geometry>(),
      })
      map.addSource("sumo-vehicles", {
        type: "geojson",
        data: emptyFeatureCollection(),
      })
      const backgroundVehicleMarker = createBackgroundVehicleMarkerImage()
      if (backgroundVehicleMarker && !map.hasImage("sumo-background-vehicle-marker")) {
        map.addImage("sumo-background-vehicle-marker", backgroundVehicleMarker.data, {
          pixelRatio: backgroundVehicleMarker.pixelRatio,
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
          "icon-image": "sumo-background-vehicle-marker",
          "icon-size": [
            "interpolate",
            ["linear"],
            ["zoom"],
            11,
            0.42,
            14,
            0.68,
            16,
            1.05,
          ],
          "icon-rotate": ["coalesce", ["get", "angle"], 0],
          "icon-rotation-alignment": "map",
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      })
      setSumoLayerVisibility(map, defaultSumoLayerVisibility)
      scheduleStaticOverlaySync()
      if (restoredCamera) {
        map.jumpTo(restoredCamera)
        pendingThemeCameraRef.current = null
      }
      setBaseMapReadyTick((tick) => tick + 1)
      map.once("idle", () => {
        scheduleStaticOverlaySync()
        setBaseMapReadyTick((tick) => tick + 1)
      })
    })
    baseMapRef.current = map

    const resizeObserver = new ResizeObserver(() => map.resize())
    resizeObserver.observe(baseMapContainerRef.current)

    return () => {
      if (staticOverlaySyncFrameRef.current !== null) {
        cancelAnimationFrame(staticOverlaySyncFrameRef.current)
        staticOverlaySyncFrameRef.current = null
      }
      resizeObserver.disconnect()
      map.remove()
      baseMapRef.current = null
      setBaseMapReadyTick((tick) => tick + 1)
    }
  }, [currentMapStyleUrl, isMapEnabled, scheduleStaticOverlaySync])

  useEffect(() => {
    const map = baseMapRef.current
    if (!map || !map.isStyleLoaded()) {
      return
    }

    source(map, "sumo-vehicles")?.setData(sumoVehicleGeojson)
  }, [baseMapReadyTick, sumoVehicleGeojson])

  useEffect(() => {
    scheduleStaticOverlaySync()
  }, [baseMapReadyTick, sumoLayerVisibility, sumoNetwork, scheduleStaticOverlaySync])

  useEffect(() => {
    const map = baseMapRef.current
    if (!map || !map.isStyleLoaded() || !ensureSumoTrafficLightLayers(map)) {
      const animationFrameId = requestAnimationFrame(() => {
        const nextMap = baseMapRef.current
        if (!nextMap || !nextMap.isStyleLoaded() || !ensureSumoTrafficLightLayers(nextMap)) {
          return
        }
        source(nextMap, "sumo-traffic-lights")?.setData(sumoTrafficLightGeojson)
        setSumoLayerVisibility(nextMap, sumoLayerVisibility)
      })

      return () => {
        cancelAnimationFrame(animationFrameId)
      }
    }

    source(map, "sumo-traffic-lights")?.setData(sumoTrafficLightGeojson)
    setSumoLayerVisibility(map, sumoLayerVisibility)
  }, [baseMapReadyTick, sumoLayerVisibility, sumoTrafficLightGeojson])

  useEffect(() => {
    const map = baseMapRef.current
    if (!map || !map.isStyleLoaded()) {
      return
    }

    setSumoLayerVisibility(map, sumoLayerVisibility)
  }, [sumoLayerVisibility])

  const sendSumoCommand = useCallback((command: string, payload: Record<string, unknown> = {}) => {
    const socket = sumoSocketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setSumoStatus("SUMO session unavailable")
      return false
    }

    socket.send(JSON.stringify({ command, ...payload }))
    return true
  }, [])

  const updateSumoDelay = useCallback(
    (value: number) => {
      const nextDelayMs = Number.isFinite(value)
        ? Math.max(0, Math.min(1000, Math.round(value)))
        : 0
      setSumoDelayMs(nextDelayMs)
      sumoDelayMsRef.current = nextDelayMs
      sendSumoCommand("delay", { delayMs: nextDelayMs })
    },
    [sendSumoCommand],
  )

  useEffect(() => {
    const wsUrl = backendWebSocketUrl(`/ws/sumo/${districtScope}`)
    const summaryUrl = backendHttpUrl(`/sumo/${districtScope}/summary`)
    if (!wsUrl) {
      setSumoStatus("Backend not configured")
      return
    }
    const socketUrl = wsUrl

    let isClosed = false
    let socket: WebSocket | null = null
    lastTrafficLightSignatureRef.current = ""
    latestSumoFrameRef.current = null
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

      socket = new WebSocket(socketUrl)
      sumoSocketRef.current = socket
      socket.addEventListener("open", () => {
        setIsSumoConnected(true)
        setSumoStatus("Ready")
        socket?.send(JSON.stringify({ command: "delay", delayMs: sumoDelayMsRef.current }))
      })

      socket.addEventListener("message", (event) => {
        const message = JSON.parse(event.data) as SumoFrame & {
          type?: "hello" | "frame" | "simStatus" | "delay" | "done" | "error"
          message?: string
          statusText?: string
          status?: string
          step?: number
          totalSteps?: number
          elapsedSec?: number
        }

        if (message.type === "hello") {
          setIsSumoConnected(true)
          setSumoStatus("Ready")
          return
        }

        if (message.type === "delay") {
          if (typeof message.delayMs === "number") {
            setSumoDelayMs(message.delayMs)
          }
          return
        }

        if (message.type === "simStatus") {
          const nextStatus = message as unknown as SumoSimStatus
          setSumoSimStatus(nextStatus)
          setIsSumoRunning(Boolean(nextStatus.running))
          setSumoStatus(nextStatus.statusText ?? nextStatus.status ?? "Idle")
          if (typeof nextStatus.delayMs === "number") {
            setSumoDelayMs(nextStatus.delayMs)
          }
          return
        }

        if (message.type === "frame") {
          if (typeof message.running === "boolean") {
            setIsSumoRunning(message.running)
            setSumoStatus(message.running ? "Streaming" : "Paused")
          }
          if (typeof message.delayMs === "number") {
            setSumoDelayMs(message.delayMs)
          }
          return
        }

        if (message.type === "done") {
          setIsSumoRunning(false)
          return
        }

        if (message.type === "error") {
          setSumoStatus(message.message ?? "SUMO error")
        }
      })

      socket.addEventListener("close", () => {
        if (sumoSocketRef.current === socket) {
          sumoSocketRef.current = null
        }
        setIsSumoConnected(false)
        setIsSumoRunning(false)
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
      if (sumoSocketRef.current === socket) {
        sumoSocketRef.current = null
      }
      socket?.close()
    }
  }, [])

  return (
    <main className={`app-shell theme-${appTheme}`}>
      <aside className="nav-rail" aria-label="Simulation navigation">
        <div className="brand-mark">
          <MapPinned size={18} aria-hidden="true" />
        </div>
      </aside>

      <section className="map-stage" aria-label="SUMO traffic map">
        {mapStyleUrl && isMapEnabled ? (
          <div ref={baseMapContainerRef} className="map-canvas base-map-canvas" />
        ) : mapStyleUrl ? (
          <div className="map-fallback">
            <MapPinned size={30} />
            <h1>Map disabled</h1>
            <p>MapLibre canvas is unmounted for performance diagnosis.</p>
          </div>
        ) : (
          <div className="map-fallback">
            <MapPinned size={30} />
            <h1>Map style missing</h1>
            <p>Add `VITE_MAPTILER_STYLE_URL` to `.env.local`.</p>
          </div>
        )}
        <div className="map-vignette" aria-hidden="true" />
      </section>

      <section className="sumo-panel" aria-label="Simulation control panel">
        <div className="panel-title-row">
          <div>
            <h1>Simulation Control Panel</h1>
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

        <div className="panel-box backend-sim-box" aria-label="Backend simulation controls">
          <div className="panel-box-header">
            <h2>Backend Sim</h2>
            {isSumoNetworkLoading ? (
              <span className="scope-loading" role="status" aria-label="Loading SUMO area">
                <span className="scope-loading-spinner" aria-hidden="true" />
              </span>
            ) : null}
          </div>

          <div className="sumo-status-grid">
            <Metric label="Status" value={sumoStatus} />
            <Metric label="Step" value={sumoSimStatus?.step ?? "--"} />
          </div>

          <div className="sumo-control-stack" aria-label="SUMO run controls">
            <div className="control-row">
              <button
                type="button"
                className="icon-button"
                disabled={!isSumoConnected || isSumoRunning}
                onClick={() => {
                  if (sendSumoCommand("start")) {
                    setSumoStatus("Starting")
                  }
                }}
              >
                <Play size={16} />
                <span>Start</span>
              </button>
              <button
                type="button"
                className="icon-button"
                disabled={!isSumoConnected || !isSumoRunning}
                onClick={() => {
                  if (sendSumoCommand("stop")) {
                    setSumoStatus("Paused")
                  }
                }}
              >
                <Pause size={16} />
                <span>Stop</span>
              </button>
              <button
                type="button"
                className="icon-button"
                disabled={!isSumoConnected || isSumoRunning}
                onClick={() => {
                  if (sendSumoCommand("step")) {
                    setSumoStatus("Stepping")
                  }
                }}
              >
                <StepForward size={16} />
                <span>Step</span>
              </button>
              <button
                type="button"
                className="icon-button"
                disabled={!isSumoConnected}
                onClick={() => {
                  if (sendSumoCommand("reset")) {
                    setSumoStatus("Resetting")
                  }
                }}
              >
                <RotateCcw size={16} />
                <span>Reset</span>
              </button>
            </div>

            <div className="delay-control">
              <div className="delay-control-header">
                <label htmlFor="sumo-delay-ms">Delay</label>
                <input
                  id="sumo-delay-ms"
                  type="number"
                  min={0}
                  max={1000}
                  step={10}
                  value={sumoDelayMs}
                  onChange={(event) => updateSumoDelay(Number(event.target.value))}
                  aria-label="SUMO delay in milliseconds"
                />
                <span>ms</span>
              </div>
              <input
                type="range"
                min={0}
                max={1000}
                step={10}
                value={sumoDelayMs}
                onChange={(event) => updateSumoDelay(Number(event.target.value))}
                aria-label="SUMO delay slider"
              />
            </div>
          </div>
        </div>

        <div className="panel-box playback-box" aria-label="Buffered playback controls">
          <div className="panel-box-header">
            <h2>Playback {playbackMode}x</h2>
            <span className={isPlaybackPlaying ? "status-pill is-live" : "status-pill"}>
              {playbackStatus}
            </span>
          </div>

          <div className="playback-mode-control">
            <div className="playback-mode-header">
              <span>Speed</span>
              <strong>
                {playbackMode}x · {formatStepWidth(playbackMode)} step
              </strong>
            </div>
            <input
              type="range"
              min={0}
              max={playbackModes.length - 1}
              step={1}
              value={playbackModes.indexOf(playbackMode)}
              disabled={!canChangePlaybackMode}
              aria-label="Playback speed mode"
              onChange={(event) => {
                const nextMode = playbackModes[Number(event.target.value)]
                if (nextMode) {
                  setPlaybackMode(nextMode)
                }
              }}
            />
            <div className="playback-mode-ticks" aria-hidden="true">
              {playbackModes.map((mode) => (
                <span key={mode}>{mode}x</span>
              ))}
            </div>
          </div>

          <div className="sumo-status-grid">
            <Metric label="Buffer" value={playbackBufferSize} />
            <Metric label="Sim Time" value={formatSimClock(sumoFrame?.simSec)} />
            <Metric label="Vehicles" value={sumoFrame?.vehicleCount ?? "--"} />
            <Metric label="Applied" value={playbackAppliedFrames} />
          </div>

          <div className="playback-buffer-meter" aria-hidden="true">
            <span
              style={{
                width: `${Math.min(
                  100,
                  Math.round((playbackBufferSize / playbackLowWatermarkFrames) * 100),
                )}%`,
              }}
            />
          </div>

          <div className="control-row playback-control-row">
            <button
              type="button"
              className="icon-button"
              disabled={isPlaybackPlaying}
              onClick={startPlayback}
            >
              <Play size={16} />
              <span>Play</span>
            </button>
            <button
              type="button"
              className="icon-button"
              disabled={!isPlaybackPlaying}
              onClick={pausePlayback}
            >
              <Pause size={16} />
              <span>Pause</span>
            </button>
            <button type="button" className="icon-button" onClick={resetPlayback}>
              <RotateCcw size={16} />
              <span>Reset</span>
            </button>
          </div>
        </div>

        <div className="panel-box render-layers-box" aria-label="Render layer controls">
          <div className="panel-box-header">
            <h2>Render Layers</h2>
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
              label="Traffic"
              active={sumoLayerVisibility.vehicles}
              onClick={() =>
                setSumoLayerVisibilityState((current) => ({
                  ...current,
                  vehicles: !current.vehicles,
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
          </div>
        </div>

        <div className="panel-box diagnostics-box" aria-label="Rendering diagnostics">
          <div className="panel-box-header">
            <h2>Diagnostics</h2>
          </div>

          <div className="diagnostics-grid">
            <Metric label="Render FPS" value={diagnostics.renderFps} />
            <Metric label="Data FPS" value={diagnostics.dataFps} />
            <Metric label="SUMO Step" value={`${diagnostics.backendStepMs} ms`} />
            <Metric label="Extract" value={`${diagnostics.backendFrameMs} ms`} />
            <Metric label="Vehicle IDs" value={`${diagnostics.backendVehicleIdMs} ms`} />
            <Metric label="Vehicles" value={`${diagnostics.backendVehicleLoopMs} ms`} />
            <Metric label="Lights" value={`${diagnostics.backendTrafficLightMs} ms`} />
            <Metric label="Chunk" value={`${diagnostics.backendChunkMs} ms`} />
            <Metric label="Send" value={`${diagnostics.backendSendMs} ms`} />
            <Metric label="Parse" value={`${diagnostics.frontendParseMs} ms`} />
            <Metric label="Append" value={`${diagnostics.frontendAppendMs} ms`} />
            <Metric label="Frames" value={diagnostics.chunkFrames} />
          </div>
          <div className="diagnostics-actions">
            <LayerToggle
              label="MapLibre"
              active={isMapEnabled}
              onClick={() => setIsMapEnabled((enabled) => !enabled)}
            />
          </div>
        </div>
      </section>

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
