# Robotaxi Control Room Operations

This project has two deployable pieces:

- GitHub Pages frontend: `https://ta-nwar.github.io/robotaxi-control-room/`
- Hugging Face Docker Space backend:
  `https://icybean-robotaxi-sumo-backend.hf.space`

## Local Development

Start the backend:

```powershell
npm run backend:dev
```

Start the frontend:

```powershell
npm run dev
```

For local backend testing, `.env.local` should include:

```text
VITE_SCENARIO_API_URL=http://127.0.0.1:7860
```

Expected local checks:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:7860/health
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:7860/sumo/reinickendorf-district/summary
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:7860/sumo/reinickendorf-district/network
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:7860/sumo/reinickendorf-district/validate
python scripts\smoke_backend.py --base-url http://127.0.0.1:7860
python scripts\smoke_backend.py --base-url http://127.0.0.1:7860 --check-websocket
npm run check
```

## Hugging Face Deploy

The Space Dockerfile is based on the official Eclipse SUMO container. Deploy
with:

```powershell
npm run deploy:hf
```

Or run the `Deploy Hugging Face Space` GitHub Action after adding the `HF_TOKEN`
repository secret.

Verify:

```powershell
python scripts\smoke_backend.py --base-url https://icybean-robotaxi-sumo-backend.hf.space --check-websocket
```

If the live frontend shows `HF Space needs redeploy`, the Pages frontend is
newer than the HF backend.

## GitHub Pages Deploy

Pushes to `main` run `.github/workflows/pages.yml`.

The Vite production build uses:

```text
base=/robotaxi-control-room/
VITE_SCENARIO_API_URL=https://icybean-robotaxi-sumo-backend.hf.space
```

Verify:

```powershell
Invoke-WebRequest -UseBasicParsing https://ta-nwar.github.io/robotaxi-control-room/
```

## Data Included

The active backend package includes only:

```text
hf-space/app/sumo/reinickendorf-district/reinickendorf-district.net.xml
hf-space/app/sumo/reinickendorf-district/reinickendorf-district-contained.rou.xml
hf-space/app/sumo/reinickendorf-district/reinickendorf-district.sumocfg
hf-space/app/sumo/reinickendorf-district/reinickendorf-district.geojson
```

Generated SUMO output files under `hf-space/app/sumo/**/output/` are ignored.
Only `.gitkeep` is tracked there.
