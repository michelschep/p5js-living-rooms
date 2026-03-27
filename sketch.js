// =============================================================================
// Living Rooms — Cellular Life Simulation  v2
// Environmental data from Home Assistant drives cellular behaviour.
//
// ⚠ Variable naming rule: NEVER use p5.js reserved names as variables.
//   Forbidden: width, height, color, fill, stroke, random, noise, map,
//   text, key, image, frameCount, mouseX, mouseY, dist, constrain, etc.
//   Use prefixes: canvasW, canvasH, cellColor, rndFloat(), ...
// =============================================================================

// ---------------------------------------------------------------------------
// Layout — computed responsively in setup() / windowResized()
// ---------------------------------------------------------------------------
let canvasW  = 700;
let floorH   = 180;   // slightly shorter floors → relative corridor is larger
let canvasH  = 700;

const CORRIDOR_H  = 90;   // wide open passage — cells cross floors naturally
const MIN_FLOOR_H = 120;

function recomputeLayout() {
  // Leave 200px for side panels + 6px gap on ≥560px screens
  const availW = windowWidth - 16;
  if (availW >= 560) {
    canvasW = Math.min(availW - 200 - 14, 700); // panels=190 + gap=6 + padding
  } else {
    canvasW = Math.min(availW, 700);
  }
  floorH  = canvasW < 400 ? MIN_FLOOR_H : 180;
  canvasH = 3 * floorH + 2 * CORRIDOR_H;  // corridors add height
}

// ---------------------------------------------------------------------------
// Cell constants
// ---------------------------------------------------------------------------
const BASE_RADIUS    = 7;    // base cell radius (cells also grow)
const MAX_CELLS_ROOM = 100;  // cap per room
const INITIAL_CELLS  = 12;   // per type per room
const DEAD_DECAY     = 400;  // frames a dead cell lingers
const DAMPING        = 0.975; // velocity damping — higher = more zen/slower

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
let appConfig      = null;
let roomDataList   = [];
let allCells       = [];
let deadCells      = [];
let lastRefreshMs  = 0;
let refreshSecs    = 180;
let dataLoaded     = false;
let domUpdateTimer = 0;

// ---------------------------------------------------------------------------
// Floor layout helpers
// ---------------------------------------------------------------------------
function floorTopY(floorNum) {
  // Floor 3 → top (row 0), Floor 1 → bottom (row 2)
  // Each floor slot = floorH + CORRIDOR_H, except last has no trailing corridor
  return (3 - floorNum) * (floorH + CORRIDOR_H);
}

function floorBounds(floorNum) {
  return { x: 0, y: floorTopY(floorNum), w: canvasW, h: floorH };
}

// Returns a synthetic env object blending two adjacent rooms.
// Used when a cell is in the corridor transition zone.
// Inverse-distance weighted environment at a given Y position.
// Each floor's sensors are weighted by 1/distance to that floor's center Y.
// This gives smooth, physically correct blending everywhere on the canvas.
function weightedEnvAtY(posY) {
  const eps = 1; // avoid division by zero
  let totalW = 0;
  const weights = [];
  for (const rc of roomDataList) {
    const centerY = floorTopY(rc.floorNum) + floorH / 2;
    const w = 1 / (abs(posY - centerY) + eps);
    weights.push(w);
    totalW += w;
  }

  // Blend all sensor values by normalized weights
  let temperature = 0, humidity = 0, lightVal = 0, co2 = 0;
  let motionAny = false;
  for (let i = 0; i < roomDataList.length; i++) {
    const rc = roomDataList[i];
    const wn = weights[i] / totalW;
    temperature += rc.sensors.temperature * wn;
    humidity    += rc.sensors.humidity    * wn;
    lightVal    += rc.sensors.light       * wn;
    co2         += rc.sensors.co2         * wn;
    if (rc.sensors.motion) motionAny = true;
  }

  const s = { temperature, humidity, light: lightVal, co2, motion: motionAny };
  // Nearest floor for room assignment
  let nearest = roomDataList[0];
  let minD = Infinity;
  for (let i = 0; i < roomDataList.length; i++) {
    if (weights[i] > minD) continue;  // higher weight = closer
    const centerY = floorTopY(roomDataList[i].floorNum) + floorH / 2;
    const d = abs(posY - centerY);
    if (d < minD) { minD = d; nearest = roomDataList[i]; }
  }
  return {
    id: nearest.id, floorNum: nearest.floorNum,
    sensors: s, bounds: nearest.bounds,
    normTemp()     { return constrain((s.temperature - 10) / 25, 0, 1); },
    normHumidity() { return constrain(s.humidity / 100, 0, 1); },
    normLight()    { return constrain(s.light / 600, 0, 1); },
    normCo2()      { return constrain((s.co2 - 400) / 800, 0, 1); },
    hasMotion()    { return s.motion; },
  };
}

function blendRoomConfigs(rcLow, rcHigh, t) {
  const lrp = (a, b) => a + (b - a) * t;
  const s = {
    temperature: lrp(rcLow.sensors.temperature, rcHigh.sensors.temperature),
    humidity:    lrp(rcLow.sensors.humidity,    rcHigh.sensors.humidity),
    light:       lrp(rcLow.sensors.light,       rcHigh.sensors.light),
    co2:         lrp(rcLow.sensors.co2,         rcHigh.sensors.co2),
    motion:      rcLow.sensors.motion || rcHigh.sensors.motion,
  };
  return {
    id: rcLow.id, floorNum: rcLow.floorNum, sensors: s,
    bounds: rcLow.bounds,
    normTemp()     { return constrain((s.temperature - 10) / 25, 0, 1); },
    normHumidity() { return constrain(s.humidity / 100, 0, 1); },
    normLight()    { return constrain(s.light / 600, 0, 1); },
    normCo2()      { return constrain((s.co2 - 400) / 800, 0, 1); },
    hasMotion()    { return s.motion; },
  };
}

// ---------------------------------------------------------------------------
// RoomConfig
// ---------------------------------------------------------------------------
class RoomConfig {
  constructor(data) {
    this.id        = data.id;
    this.roomName  = data.name;
    this.floorNum  = data.floor;
    this.sensors   = { ...data.sensors };
  }
  get bounds() { return floorBounds(this.floorNum); }

  normTemp()     { return constrain((this.sensors.temperature - 10) / 25, 0, 1); }
  normHumidity() { return constrain(this.sensors.humidity / 100, 0, 1); }
  normLight()    { return constrain(this.sensors.light / 600, 0, 1); }
  normCo2()      { return constrain((this.sensors.co2 - 400) / 800, 0, 1); }
  hasMotion()    { return this.sensors.motion === true; }

  update(s) { this.sensors = { ...s }; }
}

// ---------------------------------------------------------------------------
// BaseCell
// ---------------------------------------------------------------------------
class BaseCell {
  constructor(roomCfg) {
    this.roomId    = roomCfg.id;
    this.floorNum  = roomCfg.floorNum;
    // Spawn anywhere on the full canvas — rooms and corridors are one unified space
    this.posX      = random(BASE_RADIUS + 6, canvasW - BASE_RADIUS - 6);
    this.posY      = random(BASE_RADIUS + 6, canvasH - BASE_RADIUS - 6);
    this.velX      = random(-0.3, 0.3);
    this.velY      = random(-0.3, 0.3);
    this.energy    = random(80, 140);   // more starting energy
    this.lifespan  = random(1800, 4000); // much longer lifespan
    this.age       = 0;
    this.cellSize  = BASE_RADIUS * random(0.7, 1.0);  // start small, grows
    this.maxSize   = BASE_RADIUS * random(1.0, 1.6);
    this.isDead    = false;
    this.cellType  = 'base';
    this.noiseOff  = random(1000); // unique noise offset for organic shape
    this.currentEnv = null; // set by updateRoomByPosition each frame
  }

  getRoomConfig() {
    return this.currentEnv ?? roomDataList.find(r => r.id === this.roomId);
  }

  grow() {
    // Gradually grow toward maxSize when energy is good
    if (this.energy > 40 && this.cellSize < this.maxSize) {
      this.cellSize += 0.015;
    }
  }

  applyEnvironment() {
    const rc = this.getRoomConfig();
    if (!rc) return;
    // Temperature drives metabolic speed (subtle — 0.7–1.3×)
    const speedMod = 0.7 + rc.normTemp() * 0.6;
    this.velX *= speedMod;
    this.velY *= speedMod;
    // Motion detected — different per cell type
    if (rc.hasMotion()) {
      if (this.cellType === 'predator') {
        // Predators get excited: faster, more energy
        if (random() < 0.06) { this.velX += random(-1.2, 1.2); this.velY += random(-1.2, 1.2); }
        this.energy += 0.04;
      } else if (this.cellType === 'herbivore') {
        // Herbivores panic and scatter hard
        if (random() < 0.08) { this.velX += random(-1.8, 1.8); this.velY += random(-1.8, 1.8); }
      } else if (this.cellType === 'plant') {
        // Plants get disturbed — mild energy drain (being stepped on)
        this.energy -= 0.02;
      } else if (this.cellType === 'fungus') {
        // Fungus dislikes disturbance
        this.energy -= 0.03;
      }
      // Decomposers love the extra organic material stirred up
      if (this.cellType === 'decomposer') this.energy += 0.03;
    }
  }

  limitVel(maxSpd) {
    const spd = sqrt(this.velX * this.velX + this.velY * this.velY);
    if (spd > maxSpd) {
      this.velX = (this.velX / spd) * maxSpd;
      this.velY = (this.velY / spd) * maxSpd;
    }
  }

  // Bounce only off canvas outer edges — floors are open space
  bounceCanvas() {
    const mg = this.cellSize;
    if (this.posX < mg)           { this.posX = mg;           this.velX *= -1; }
    if (this.posX > canvasW - mg) { this.posX = canvasW - mg; this.velX *= -1; }
    if (this.posY < mg)           { this.posY = mg;           this.velY *= -1; }
    if (this.posY > canvasH - mg) { this.posY = canvasH - mg; this.velY *= -1; }
  }

  // Update room membership + IDW-blended environment based on Y position.
  // Uses inverse-distance weighting to all floor centers — smooth everywhere.
  updateRoomByPosition() {
    const env = weightedEnvAtY(this.posY);
    this.currentEnv = env;
    this.roomId     = env.id;
    this.floorNum   = env.floorNum;
  }

  baseUpdate(maxSpd, driftAmt) {
    this.age++;
    this.energy -= 0.03;  // much lower base cost: 1.8 energy/sec at 60fps
    this.grow();
    this.applyEnvironment();
    this.velX += random(-driftAmt, driftAmt);
    this.velY += random(-driftAmt, driftAmt);
    this.velX *= DAMPING;
    this.velY *= DAMPING;
    this.limitVel(maxSpd);
    this.posX += this.velX;
    this.posY += this.velY;
    this.bounceCanvas();
    this.updateRoomByPosition();
    if (this.energy <= 0 || this.age >= this.lifespan) this.isDead = true;
  }
}

// ---------------------------------------------------------------------------
// CellPlant — photosynthetic, nearly stationary, grows in clumps
// ---------------------------------------------------------------------------
class CellPlant extends BaseCell {
  constructor(roomCfg) {
    super(roomCfg);
    this.cellType = 'plant';
    this.lobes    = floor(random(3, 7));
    this.maxSize  = BASE_RADIUS * random(1.4, 2.2);
    this.lifespan = random(2000, 5000); // plants live long
  }

  update() {
    this.baseUpdate(0.15, 0.020); // nearly stationary but more drift
    if (this.isDead) return;
    const rc = this.getRoomConfig();
    if (!rc) return;

    this.energy += rc.normLight() * 0.38;     // photosynthesis — main income
    this.energy += rc.normHumidity() * 0.06;  // moisture helps
    this.energy -= rc.normCo2() * 0.04;       // mild CO2 stress only
    this.energy  = constrain(this.energy, 0, 160);

    // Split when big and well-lit
    if (this.energy > 130 && this.cellSize > this.maxSize * 0.85 && rc.normLight() > 0.15 && random() < 0.003) {
      spawnCell('plant', rc);
      this.energy   -= 40;
      this.cellSize *= 0.75;
    }
  }

  draw() {
    const rc    = this.getRoomConfig();
    const lval  = rc ? rc.normLight() : 0.5;
    const alpha = map(this.energy, 0, 130, 60, 230);
    const sz    = this.cellSize;

    push();
    translate(this.posX, this.posY);
    rotate(this.age * 0.004); // very slow drift rotation

    for (let i = 0; i < this.lobes; i++) {
      const ang  = (i / this.lobes) * TWO_PI;
      push();
      translate(cos(ang) * sz * 0.55, sin(ang) * sz * 0.55);
      rotate(ang + HALF_PI); // leaf tip points outward

      const leafL = sz * 1.5;
      const leafW = sz * 0.52;
      const gr    = 30 + lval * 80;
      const gg    = 145 + lval * 75;
      const gb    = 40 + lval * 15;

      // Leaf shape via bezier curves
      noStroke();
      fill(gr, gg, gb, alpha);
      beginShape();
      vertex(0, 0);
      bezierVertex(-leafW, leafL * 0.28, -leafW * 0.55, leafL * 0.72, 0, leafL);
      bezierVertex( leafW * 0.55, leafL * 0.72,  leafW, leafL * 0.28, 0, 0);
      endShape(CLOSE);

      // Midrib vein
      stroke(gr * 0.6, gg + 20, gb * 0.7, alpha * 0.7);
      strokeWeight(0.7);
      line(0, sz * 0.1, 0, leafL * 0.88);

      // Side veins (2 pairs)
      for (let v = 1; v <= 2; v++) {
        const vy = leafL * (v * 0.28);
        const vx = leafW * (0.55 - v * 0.08);
        line(0, vy, -vx, vy - leafL * 0.09);
        line(0, vy,  vx, vy - leafL * 0.09);
      }
      noStroke();
      pop();
    }

    // Centre node / stem base
    fill(40 + lval * 50, 160 + lval * 50, 45, alpha * 0.7);
    ellipse(0, 0, sz * 0.55, sz * 0.55);

    pop();
  }
}

// ---------------------------------------------------------------------------
// CellHerbivore — eats plants, moderate speed
// ---------------------------------------------------------------------------
class CellHerbivore extends BaseCell {
  constructor(roomCfg) {
    super(roomCfg);
    this.cellType = 'herbivore';
    this.maxSize  = BASE_RADIUS * random(0.9, 1.4);
  }

  update() {
    this.baseUpdate(0.45, 0.035); // more drift → wanders between floors
    if (this.isDead) return;
    const rc = this.getRoomConfig();
    if (!rc) return;

    // Seek nearest plant
    let prey = null, preyDist = 90;
    for (const c of allCells) {
      if (c.cellType !== 'plant' || c.isDead) continue;
      const d = dist(this.posX, this.posY, c.posX, c.posY);
      if (d < preyDist) { preyDist = d; prey = c; }
    }
    if (prey) {
      const dx = prey.posX - this.posX, dy = prey.posY - this.posY;
      const mg = sqrt(dx * dx + dy * dy) || 1;
      this.velX += (dx / mg) * 0.18;
      this.velY += (dy / mg) * 0.18;
      if (preyDist < this.cellSize + prey.cellSize + 1) {
        prey.isDead  = true;
        this.energy += 70;  // more energy per plant eaten
      }
    }

    // Flee predators more aggressively
    for (const c of allCells) {
      if (c.cellType !== 'predator' || c.isDead) continue;
      const d = dist(this.posX, this.posY, c.posX, c.posY);
      if (d < 100) {
        const strength = map(d, 0, 100, 0.08, 0.01);
        this.velX -= (c.posX - this.posX) * strength;
        this.velY -= (c.posY - this.posY) * strength;
      }
    }

    this.energy = constrain(this.energy - 0.02, 0, 140);
    if (this.energy > 85 && random() < 0.007) { spawnCell('herbivore', rc); this.energy -= 30; }
  }

  draw() {
    const alpha = map(this.energy, 0, 120, 60, 220);
    const sz    = this.cellSize;
    noStroke();
    // Amoeba-like shape using noise
    fill(70, 170, 210, alpha);
    beginShape();
    for (let a = 0; a < TWO_PI; a += 0.35) {
      const nv = noise(this.noiseOff + cos(a) * 0.5, this.noiseOff + sin(a) * 0.5, this.age * 0.008);
      const r  = sz * (0.75 + nv * 0.5);
      vertex(this.posX + cos(a) * r, this.posY + sin(a) * r);
    }
    endShape(CLOSE);
    // Nucleus
    fill(120, 200, 240, alpha * 0.6);
    ellipse(this.posX, this.posY, sz * 0.55, sz * 0.55);
  }
}

// ---------------------------------------------------------------------------
// CellPredator — hunts herbivores, thrives warm
// ---------------------------------------------------------------------------
class CellPredator extends BaseCell {
  constructor(roomCfg) {
    super(roomCfg);
    this.cellType = 'predator';
    this.maxSize  = BASE_RADIUS * random(1.1, 1.7);
    this.lifespan = random(3000, 6000);  // was 800-1400 (13-23s) — predators live long
  }

  update() {
    this.baseUpdate(0.60, 0.028); // predator wanders, hunts across floors
    if (this.isDead) return;
    const rc = this.getRoomConfig();
    if (!rc) return;

    // Warm rooms help predators; cold rooms punish harder
    this.energy += rc.normTemp() * 0.05 - 0.025;
    this.energy  = constrain(this.energy, 0, 160);

    let prey = null, preyDist = 80;
    for (const c of allCells) {
      if (c.cellType !== 'herbivore' || c.isDead) continue;
      const d = dist(this.posX, this.posY, c.posX, c.posY);
      if (d < preyDist) { preyDist = d; prey = c; }
    }
    if (prey) {
      const dx = prey.posX - this.posX, dy = prey.posY - this.posY;
      const mg = sqrt(dx * dx + dy * dy) || 1;
      this.velX += (dx / mg) * 0.20;
      this.velY += (dy / mg) * 0.20;
      if (preyDist < this.cellSize + prey.cellSize + 1) {
        prey.isDead  = true;
        this.energy += 60;
      }
    } else {
      // No prey visible — extra starvation drain
      this.energy -= 0.025;
    }
    if (this.energy > 120 && random() < 0.003) { spawnCell('predator', rc); this.energy -= 55; }
  }

  draw() {
    const alpha = map(this.energy, 0, 140, 60, 220);
    const sz    = this.cellSize;
    const ang   = atan2(this.velY, this.velX);
    noStroke();
    // Spiky predator shape
    fill(200, 70, 70, alpha);
    beginShape();
    const spikes = 6;
    for (let i = 0; i < spikes * 2; i++) {
      const a = ang + (i / (spikes * 2)) * TWO_PI;
      const r = (i % 2 === 0) ? sz * 1.2 : sz * 0.55;
      vertex(this.posX + cos(a) * r, this.posY + sin(a) * r);
    }
    endShape(CLOSE);
    fill(240, 120, 120, alpha * 0.5);
    ellipse(this.posX, this.posY, sz * 0.5, sz * 0.5);
  }
}

// ---------------------------------------------------------------------------
// CellDecomposer — eats dead cells, loves humidity + CO2
// ---------------------------------------------------------------------------
class CellDecomposer extends BaseCell {
  constructor(roomCfg) {
    super(roomCfg);
    this.cellType = 'decomposer';
    this.maxSize  = BASE_RADIUS * random(0.9, 1.3);
  }

  update() {
    this.baseUpdate(0.22, 0.022); // decomposer drifts enough to find dead cells
    if (this.isDead) return;
    const rc = this.getRoomConfig();
    if (!rc) return;

    this.energy += rc.normHumidity() * 0.07 + rc.normCo2() * 0.05 - 0.03;
    this.energy  = constrain(this.energy, 0, 130);

    // Overcrowding pressure: if too many decomposers globally, extra mortality
    const globalDecomp = allCells.filter(c => c.cellType === 'decomposer').length;
    if (globalDecomp > 40) this.energy -= 0.04 * (globalDecomp - 40) / 10;

    let target = null, targetDist = 70;
    for (const dc of deadCells) {
      const d = dist(this.posX, this.posY, dc.posX, dc.posY);
      if (d < targetDist) { targetDist = d; target = dc; }
    }
    if (target) {
      const dx = target.posX - this.posX, dy = target.posY - this.posY;
      const mg = sqrt(dx * dx + dy * dy) || 1;
      this.velX += (dx / mg) * 0.15;
      this.velY += (dy / mg) * 0.15;
      if (targetDist < this.cellSize + 4) { target.decayLife = 0; this.energy += 32; }
    }

    if (this.energy > 120 && rc.normHumidity() > 0.55 && random() < 0.0008) {
      spawnCell('decomposer', rc);
      this.energy -= 40;
    }
  }

  draw() {
    const alpha = map(this.energy, 0, 110, 60, 210);
    const sz    = this.cellSize;
    const ang   = atan2(this.velY, this.velX); // orient body along movement

    push();
    translate(this.posX, this.posY);
    rotate(ang + HALF_PI + this.age * 0.018); // slow tumble

    const bodyL = sz * 1.55;
    const bodyW = sz * 0.80;

    // Body — noise-warped elongated oval (paramecium-like)
    noStroke();
    fill(110, 65, 175, alpha);
    beginShape();
    for (let a = 0; a < TWO_PI; a += 0.25) {
      const nv = noise(this.noiseOff + cos(a) * 0.45, this.noiseOff + sin(a) * 0.45, this.age * 0.003);
      vertex(cos(a) * bodyW * (0.82 + nv * 0.28),
             sin(a) * bodyL * (0.82 + nv * 0.22));
    }
    endShape(CLOSE);

    // Large kidney-shaped nucleus
    fill(75, 40, 125, alpha * 0.85);
    push();
    translate(0, sz * 0.15);
    rotate(0.4);
    ellipse(0, 0, sz * 0.52, sz * 0.72);
    pop();

    // Food vacuoles — small bright orbiting circles
    for (let i = 0; i < 4; i++) {
      const va = this.age * 0.04 + i * HALF_PI;
      fill(175, 120, 235, alpha * 0.55);
      ellipse(sin(va) * sz * 0.38, cos(va) * sz * 0.48, sz * 0.25, sz * 0.25);
    }

    // Cilia — short bristles around the perimeter
    stroke(160, 110, 215, alpha * 0.45);
    strokeWeight(0.65);
    const ciliaCount = 18;
    for (let i = 0; i < ciliaCount; i++) {
      const ca      = (i / ciliaCount) * TWO_PI;
      const ciliaWobble = sin(this.age * 0.12 + i * 0.7) * 0.18;
      const cx1 = cos(ca) * bodyW * 0.88;
      const cy1 = sin(ca) * bodyL * 0.88;
      const cx2 = cos(ca + ciliaWobble) * (bodyW + sz * 0.42);
      const cy2 = sin(ca + ciliaWobble) * (bodyL + sz * 0.42);
      line(cx1, cy1, cx2, cy2);
    }
    noStroke();

    pop();
  }
}

// ---------------------------------------------------------------------------
// CellFungus (Schimmel) — nearly stationary, spreads by budding, loves humidity
// ---------------------------------------------------------------------------
class CellFungus extends BaseCell {
  constructor(roomCfg) {
    super(roomCfg);
    this.cellType  = 'fungus';
    this.maxSize   = BASE_RADIUS * random(1.5, 2.5);
    this.lifespan  = random(2000, 4000); // long-lived
    this.hyphaeAng = random(TWO_PI); // direction of hyphae filaments
    this.velX      = 0;
    this.velY      = 0;
  }

  update() {
    this.baseUpdate(0.25, 0.025); // increased drift so fungi wander between floors
    if (this.isDead) return;
    const rc = this.getRoomConfig();
    if (!rc) return;

    // Occasional random impulse to break out of clusters
    if (frameCount % 180 === 0 && random() < 0.3) {
      const ang = random(TWO_PI);
      this.velX += cos(ang) * 0.3;
      this.velY += sin(ang) * 0.3;
    }

    // Thrives on humidity, CO2, and mild temperature
    this.energy += rc.normHumidity() * 0.10 + rc.normCo2() * 0.05 - 0.03;
    // Eats nearby plants (absorbs nutrients)
    for (const c of allCells) {
      if ((c.cellType !== 'plant') || c.isDead) continue;
      const d = dist(this.posX, this.posY, c.posX, c.posY);
      if (d < this.cellSize + c.cellSize + 2 && random() < 0.015) {
        c.energy    -= 8;
        this.energy += 5;
      }
    }
    // Also eats nearby dead cells
    for (const dc of deadCells) {
      const d = dist(this.posX, this.posY, dc.posX, dc.posY);
      if (d < this.cellSize + 6) { dc.decayLife = 0; this.energy += 20; }
    }
    this.energy = constrain(this.energy, 0, 190);

    // Bud (spread) when large and well-fed
    if (this.energy > 155 && this.cellSize > this.maxSize * 0.8 && random() < 0.003) {
      spawnFungusNear(rc, this);
      this.energy   -= 50;
      this.cellSize *= 0.8;
    }
  }

  draw() {
    const alpha = map(this.energy, 0, 160, 50, 200);
    const sz    = this.cellSize;
    noStroke();

    // Main body — organic noise blob
    fill(200, 140, 60, alpha);
    beginShape();
    for (let a = 0; a < TWO_PI; a += 0.28) {
      const nv = noise(this.noiseOff + cos(a) * 0.6, this.noiseOff + sin(a) * 0.6, this.age * 0.004);
      const r  = sz * (0.7 + nv * 0.6);
      vertex(this.posX + cos(a) * r, this.posY + sin(a) * r);
    }
    endShape(CLOSE);

    // Hyphae filaments
    stroke(200, 140, 60, alpha * 0.35);
    strokeWeight(0.8);
    const filaments = 5;
    for (let i = 0; i < filaments; i++) {
      const ang  = this.hyphaeAng + (i / filaments) * TWO_PI;
      const flen = sz * (1.8 + noise(this.noiseOff + i, this.age * 0.005) * 1.4);
      const ex   = this.posX + cos(ang) * flen;
      const ey   = this.posY + sin(ang) * flen;
      line(this.posX + cos(ang) * sz * 0.7, this.posY + sin(ang) * sz * 0.7, ex, ey);
      // Tip dot
      noStroke();
      fill(220, 160, 80, alpha * 0.5);
      ellipse(ex, ey, 3, 3);
      stroke(200, 140, 60, alpha * 0.35);
    }
    noStroke();

    // Spore dots on top
    fill(255, 200, 100, alpha * 0.7);
    for (let i = 0; i < 3; i++) {
      const ox = sin(this.age * 0.06 + i * 2.1) * sz * 0.4;
      const oy = cos(this.age * 0.06 + i * 2.1) * sz * 0.4;
      ellipse(this.posX + ox, this.posY + oy, 2.5, 2.5);
    }
  }
}

// ---------------------------------------------------------------------------
// Dead cell remnant
// ---------------------------------------------------------------------------
class DeadCell {
  constructor(liveCell) {
    this.posX      = liveCell.posX;
    this.posY      = liveCell.posY;
    this.roomId    = liveCell.roomId;
    this.decayLife = DEAD_DECAY;
    this.sz        = liveCell.cellSize * 0.7;
  }
  update() { this.decayLife--; }
  isGone()  { return this.decayLife <= 0; }
  draw() {
    const alpha = map(this.decayLife, 0, DEAD_DECAY, 0, 80);
    fill(100, 90, 80, alpha);
    noStroke();
    ellipse(this.posX, this.posY, this.sz * 2, this.sz * 2);
  }
}

// ---------------------------------------------------------------------------
// Cell factory + spawn helpers
// ---------------------------------------------------------------------------
function makeCell(cellTypeName, roomCfg) {
  switch (cellTypeName) {
    case 'plant':      return new CellPlant(roomCfg);
    case 'herbivore':  return new CellHerbivore(roomCfg);
    case 'predator':   return new CellPredator(roomCfg);
    case 'decomposer': return new CellDecomposer(roomCfg);
    case 'fungus':     return new CellFungus(roomCfg);
    default:           return new CellPlant(roomCfg);
  }
}

// Global soft cap per species — prevents any one type from monopolising
const MAX_SPECIES_GLOBAL = {
  plant: 70, herbivore: 45, predator: 18, decomposer: 35, fungus: 30
};

function spawnCell(cellTypeName, roomCfg) {
  if (allCells.length >= MAX_CELLS_ROOM * roomDataList.length) return;
  const globalCap   = MAX_SPECIES_GLOBAL[cellTypeName] ?? 60;
  const globalCount = allCells.filter(c => c.cellType === cellTypeName).length;
  if (globalCount >= globalCap) return;
  allCells.push(makeCell(cellTypeName, roomCfg));
}

function spawnFungusNear(roomCfg, parent) {
  if (allCells.length >= MAX_CELLS_ROOM * roomDataList.length) return;
  const globalCount = allCells.filter(c => c.cellType === 'fungus').length;
  if (globalCount >= MAX_SPECIES_GLOBAL.fungus) return;
  const child = new CellFungus(roomCfg);
  const ang   = random(TWO_PI);
  const spDist = parent.cellSize * 2 + random(4, 12);
  child.posX  = constrain(parent.posX + cos(ang) * spDist, 8, canvasW - 8);
  child.posY  = constrain(parent.posY + sin(ang) * spDist, 8, canvasH - 8);
  child.energy = 60;
  allCells.push(child);
}

// ---------------------------------------------------------------------------
// Seed initial population — carefully balanced ratios
// ---------------------------------------------------------------------------
function seedPopulation() {
  allCells  = [];
  deadCells = [];
  for (const rc of roomDataList) {
    for (let i = 0; i < 18; i++) allCells.push(makeCell('plant',      rc));
    for (let i = 0; i < 8;  i++) allCells.push(makeCell('herbivore',  rc));
    for (let i = 0; i < 3;  i++) allCells.push(makeCell('predator',   rc));
    for (let i = 0; i < 6;  i++) allCells.push(makeCell('decomposer', rc));
    for (let i = 0; i < 6;  i++) allCells.push(makeCell('fungus',     rc));
  }
}

// Prevent full extinction: repopulate if a species drops critically low
function checkMinPopulation() {
  let cntP = 0, cntH = 0, cntPr = 0;
  for (const c of allCells) {
    if (c.cellType === 'plant')     cntP++;
    if (c.cellType === 'herbivore') cntH++;
    if (c.cellType === 'predator')  cntPr++;
  }
  // Spawn anywhere on canvas — no room preference
  const anyRoom = roomDataList[0];
  if (cntP  < 15) { for (let i = 0; i < 4; i++) allCells.push(makeCell('plant',     anyRoom)); }
  if (cntH  < 8)  { for (let i = 0; i < 3; i++) allCells.push(makeCell('herbivore', anyRoom)); }
  if (cntPr < 3)  {                               allCells.push(makeCell('predator',  anyRoom)); }
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
function loadRoomsData() {
  const rawUrl = 'https://raw.githubusercontent.com/michelschep/p5js-living-rooms/main/rooms.json';
  fetch(rawUrl + '?t=' + Date.now())
    .then(r => r.json())
    .then(data => {
      appConfig = data;
      if (!dataLoaded) {
        roomDataList = data.rooms.map(r => new RoomConfig(r));
        seedPopulation();
        dataLoaded   = true;
      } else {
        for (const raw of data.rooms) {
          const ex = roomDataList.find(r => r.id === raw.id);
          if (ex) ex.update(raw.sensors);
        }
      }
      lastRefreshMs = millis();
      refreshSecs   = data.refreshIntervalMs / 1000;
      document.getElementById('status-text').textContent =
        '✅ Data geladen — ' + new Date().toLocaleTimeString('nl-NL');
    })
    .catch(() => {
      if (!dataLoaded) {
        appConfig    = fallbackConfig();
        roomDataList = appConfig.rooms.map(r => new RoomConfig(r));
        seedPopulation();
        dataLoaded   = true;
        lastRefreshMs = millis();
        document.getElementById('status-text').textContent = '⚠️ Offline — demo data';
      }
    });
}

function fallbackConfig() {
  return {
    refreshIntervalMs: 180000,
    rooms: [
      { id: 'floor1', name: 'Begane grond',      floor: 1, sensors: { temperature: 21.5, humidity: 55, light: 320, motion: false, co2: 820 } },
      { id: 'floor2', name: 'Eerste verdieping', floor: 2, sensors: { temperature: 19.2, humidity: 62, light: 80,  motion: true,  co2: 650 } },
      { id: 'floor3', name: 'Tweede verdieping', floor: 3, sensors: { temperature: 17.8, humidity: 45, light: 15,  motion: false, co2: 480 } }
    ],
    doors: [
      { fromFloor: 1, toFloor: 2, positionFraction: 0.5 },
      { fromFloor: 2, toFloor: 3, positionFraction: 0.5 }
    ]
  };
}

// ---------------------------------------------------------------------------
// Draw helpers
// ---------------------------------------------------------------------------
// Single background color for all floors; corridors slightly darker
const FLOOR_BG    = [25, 35, 45];
const CORRIDOR_BG = [12, 18, 25];

function drawRoomBackground(rc) {
  const b = rc.bounds;
  fill(FLOOR_BG[0], FLOOR_BG[1], FLOOR_BG[2]);
  noStroke();
  rect(b.x, b.y, b.w, b.h);
}

function drawFloorDividers() {
  // Both corridors: same darker background color
  for (let f = 1; f <= 2; f++) {
    const corrY = floorTopY(f) + floorH;
    fill(CORRIDOR_BG[0], CORRIDOR_BG[1], CORRIDOR_BG[2]);
    noStroke();
    rect(0, corrY, canvasW, CORRIDOR_H);
    stroke(255, 255, 255, 20);
    strokeWeight(0.5);
    line(0, corrY, canvasW, corrY);
    line(0, corrY + CORRIDOR_H, canvasW, corrY + CORRIDOR_H);
    noStroke();
  }
}

// Set left panel heights to match floorH (corridors are canvas-only, not in panels)
function updatePanelHeights() {
  const totalH = canvasH;  // distribute evenly across 3 panels
  const panelH = Math.floor(totalH / 3);
  for (let f = 1; f <= 3; f++) {
    const el = document.getElementById('panel-floor' + f);
    if (el) el.style.height = panelH + 'px';
  }
}

// Update DOM metric panels (called every 60 frames)
function updateDomPanels() {
  if (!dataLoaded) return;
  for (const rc of roomDataList) {
    const s = rc.sensors;
    const sEl = document.getElementById('sensors-floor' + rc.floorNum);
    const cEl = document.getElementById('counts-floor' + rc.floorNum);
    if (!sEl || !cEl) continue;

    const motStr = s.motion ? '🏃 beweging' : '💤 stil';
    sEl.innerHTML =
      `<span class="sensor-val">🌡 ${s.temperature.toFixed(1)}°C</span>` +
      `<span class="sensor-val">💧 ${s.humidity}%</span>` +
      `<span class="sensor-val">💡 ${s.light} lux</span>` +
      `<span class="sensor-val">${motStr}</span>` +
      `<span class="sensor-val">CO₂ ${s.co2}ppm</span>`;

    let cntP=0, cntH=0, cntPr=0, cntD=0, cntF=0;
    for (const c of allCells) {
      if (c.roomId !== rc.id) continue;
      if      (c.cellType === 'plant')      cntP++;
      else if (c.cellType === 'herbivore')  cntH++;
      else if (c.cellType === 'predator')   cntPr++;
      else if (c.cellType === 'decomposer') cntD++;
      else if (c.cellType === 'fungus')     cntF++;
    }
    cEl.innerHTML =
      `<span class="count-item" style="color:#4daf5e">🌿 ${cntP}</span>` +
      `<span class="count-item" style="color:#5ab4d4">💧 ${cntH}</span>` +
      `<span class="count-item" style="color:#d45a5a">🔴 ${cntPr}</span>` +
      `<span class="count-item" style="color:#9b7fc9">🟣 ${cntD}</span>` +
      `<span class="count-item" style="color:#c8904a">🍄 ${cntF}</span>`;
  }
}

// ---------------------------------------------------------------------------
// p5.js lifecycle
// ---------------------------------------------------------------------------
function setup() {
  recomputeLayout();
  const cnv = createCanvas(canvasW, canvasH);
  cnv.parent('canvas-container');
  updatePanelHeights();
  loadRoomsData();
}

function windowResized() {
  recomputeLayout();
  resizeCanvas(canvasW, canvasH);
  updatePanelHeights();
}

function draw() {
  if (!dataLoaded) {
    background(10, 10, 10);
    fill(100, 200, 120);
    textAlign(CENTER, CENTER);
    textSize(14);
    text('Laden…', canvasW / 2, canvasH / 2);
    return;
  }

  if (millis() - lastRefreshMs > (appConfig?.refreshIntervalMs ?? 180000)) {
    loadRoomsData();
  }

  background(10, 10, 10);

  for (const rc of roomDataList) drawRoomBackground(rc);
  drawFloorDividers();

  // Dead cells
  for (const dc of deadCells) { dc.update(); dc.draw(); }
  deadCells = deadCells.filter(dc => !dc.isGone());

  // Living cells
  for (const c of allCells) {
    c.update();
    c.draw();
    if (c.isDead) deadCells.push(new DeadCell(c));
  }
  allCells = allCells.filter(c => !c.isDead);

  // Ecosystem safety net: prevent total extinction (every 3 seconds)
  if (frameCount % 180 === 0) checkMinPopulation();

  // Update DOM panels every 60 frames (~1s)
  domUpdateTimer++;
  if (domUpdateTimer >= 60) {
    updateDomPanels();
    domUpdateTimer = 0;
  }

  // Countdown update every second
  if (frameCount % 60 === 0) {
    const interval = appConfig?.refreshIntervalMs ?? 180000;
    const secsLeft = Math.max(0, Math.round((interval - (millis() - lastRefreshMs)) / 1000));
    const cdEl = document.getElementById('countdown-text');
    if (cdEl) cdEl.textContent = '⏱ refresh over ' + secsLeft + 's';
  }
}
