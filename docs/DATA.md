# Robotaxi Data Guide

The active app uses one SUMO scenario: the official Berlin Bezirk
Reinickendorf district cutout.

## Active Runtime Data

Packaged for the backend in:

```text
hf-space/app/sumo/reinickendorf-district/
```

Files:

- `reinickendorf-district.net.xml`
  - SUMO network for the official district cutout.
- `reinickendorf-district-contained.rou.xml`
  - Strict-contained vehicle routes. A route is included only if the full
    original edge sequence is inside the cutout network.
- `reinickendorf-district.sumocfg`
  - SUMO config used by the backend.
- `reinickendorf-district.geojson`
  - Official district boundary rendered by the frontend.

Removed from the active app:

- `public/data/six-seven-scenario.json`
- `hf-space/app/data/six-seven-scenario.json`
- `hf-space/app/sumo/reinickendorf/`
- `hf-space/app/sumo/berlin/`
- `data/source/reinickendorf/`

Those older experiment assets are recoverable from git history if needed.

## Regenerating The District Cutout

Use:

```powershell
python scripts\build_reinickendorf_district_sumo.py
```

The generator:

1. Downloads the official Berlin ALKIS Bezirke WFS layer.
2. Extracts the `Reinickendorf` feature.
3. Converts the EPSG:25833 district polygon into SUMO XY using the BeST
   `berlin.net.xml` `netOffset`.
4. Runs `netconvert --keep-edges.in-boundary`.
5. Filters `berlin.rou.gz` to strict-contained vehicle routes.

Tracked provenance files:

```text
data/source/berlin-boundaries/
```

Heavy generated intermediate files:

```text
data/intermediate/sumo/reinickendorf-district/
```

The generated intermediate SUMO files are ignored by git. The packaged backend
copies live under `hf-space/app/sumo/reinickendorf-district/`.

## Modeling Notes

- The frontend should not draw placeholder service areas. The district boundary
  must come from `/sumo/reinickendorf-district/network`.
- The current app is a traffic viewer, not a robotaxi dispatch model.
- Future robotaxi work should define requests, depot, fleet logic, and metrics
  before adding UI.
- Do not use clipped/touching routes for a service model unless the product
  intentionally wants vehicles to appear at the cutout boundary.

## Local SUMO Tools

SUMO is installed locally at:

```text
C:\Program Files (x86)\Eclipse\Sumo\
```

Useful tools include `netconvert.exe`, `duarouter.exe`, `sumo.exe`,
`sumo-gui.exe`, `osmGet.py`, and `osmBuild.py`.
