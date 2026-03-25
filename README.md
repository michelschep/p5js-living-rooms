# 🏠 Living Rooms — Cellular Life

A p5.js simulation of cellular life living in the rooms of a real house.

Environmental data from **Home Assistant** (temperature, humidity, light, motion, CO₂) drives how cells live, eat, replicate, migrate, and die.

## Live demo

👉 [https://michel-hulsbergen.github.io/p5js-living-rooms/](https://michel-hulsbergen.github.io/p5js-living-rooms/)

## Rooms

Three floors stacked vertically (as in a real house):

| Floor | Room | Connected to |
|---|---|---|
| 3 | Tweede verdieping | Floor 2 via door |
| 2 | Eerste verdieping | Floor 1 & 3 via doors |
| 1 | Begane grond | Floor 2 via door |

Cells migrate through the **doors** (small openings) between floors. When motion is detected in a room, cells scatter and migration increases.

## Cell types

| Type | Colour | Eats | Thrives when |
|---|---|---|---|
| **Producer** | 🟢 Green | Light (photosynthesis) | High light, low CO₂ |
| **Herbivore** | 🔵 Cyan | Producers | Moderate temperature |
| **Predator** | 🔴 Red | Herbivores | High temperature |
| **Decomposer** | 🟣 Purple | Dead cells | High humidity + CO₂ |

## Environmental effects

- **Temperature** → metabolic speed (hotter = faster movement + shorter lifespan)
- **Humidity** → Decomposer + Producer replication
- **Light** → Producer splitting; Herbivore activity
- **Motion** → cells scatter and flee toward doors
- **CO₂** → Decomposers thrive; high CO₂ stresses Producers

## Data

Environmental data is loaded from `rooms.json` and refreshed every 3 minutes (configurable via `refreshIntervalMs`). In production, a separate process updates this file from Home Assistant.

## Run locally

Just open `index.html` in a browser. For the JSON fetch to work, serve via a local HTTP server:

```bash
npx serve .
# or
python -m http.server 8080
```

## Built with

- [p5.js 1.7.0](https://p5js.org/)
- Home Assistant sensor data
