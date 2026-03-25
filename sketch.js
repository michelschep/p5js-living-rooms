// =============================================================================
// Living Rooms — Cellular Life Simulation
// Environmental data from Home Assistant drives cellular behaviour.
//
// ⚠ Variable naming rule: Never use p5.js reserved names (width, height, color,
//   fill, stroke, random, noise, map, text, key, image, frameCount, mouseX,
//   mouseY, etc.) as variable names. Use prefixed alternatives instead.
// =============================================================================

// ---------------------------------------------------------------------------
// Canvas & layout constants  (avoid using p5 reserved 'width'/'height')
// ---------------------------------------------------------------------------
const CANVAS_W = 900;
const CANVAS_H = 730;
const FLOOR_H  = 210;   // height of each room area in pixels
const BORDER_H = 25;    // gap between floors (where doors sit)
const HUD_MARGIN = 8;
const DOOR_WIDTH = 44;  // width of doorway opening

// ---------------------------------------------------------------------------
// Cell constants
// ---------------------------------------------------------------------------
const CELL_RADIUS     = 5;
const MAX_CELLS_ROOM  = 120;
const INITIAL_CELLS   = 18;  // per cell type per room
const DEAD_DECAY_LIFE = 200; // frames a dead cell persists

// ---------------------------------------------------------------------------
// App state  (never named 'config' alone — use 'appConfig' / 'roomDataList')
// ---------------------------------------------------------------------------
let appConfig         = null;   // parsed rooms.json
let roomDataList      = [];     // RoomConfig objects
let allCells          = [];     // flat list of all living cells
let deadCells         = [];     // recently dead cells (food for decomposers)
let lastRefreshTime   = 0;
let nextRefreshSecs   = 0;
let dataLoaded        = false;

// ---------------------------------------------------------------------------
// Floor layout helpers — called after appConfig is loaded
// ---------------------------------------------------------------------------

// Returns the y-coordinate (top of room drawing area) for a given floor number
// Floor 3 is at top, Floor 1 at bottom.
function floorTopY(floorNum) {
  // floors: 3 → row 0, 2 → row 1, 1 → row 2
  const rowIndex = 3 - floorNum;
  return rowIndex * (FLOOR_H + BORDER_H);
}

function floorBounds(floorNum) {
  const topY = floorTopY(floorNum);
  return { x: 0, y: topY, w: CANVAS_W, h: FLOOR_H };
}

// Doorway centre-x and y-position between two adjacent floors
function doorInfo(fromFloor, toFloor, positionFraction) {
  const lowerFloor = Math.min(fromFloor, toFloor);
  const topOfLower = floorTopY(lowerFloor);
  const doorY      = topOfLower - BORDER_H; // top of the gap (gap sits between upperFloor bottom and lowerFloor top)
  const doorCentreX = CANVAS_W * positionFraction;
  return {
    x: doorCentreX - DOOR_WIDTH / 2,
    y: doorY,
    w: DOOR_WIDTH,
    h: BORDER_H,
    centreX: doorCentreX,
    centreY: doorY + BORDER_H / 2,
    lowerFloor,
    upperFloor: lowerFloor + 1
  };
}

// ---------------------------------------------------------------------------
// RoomConfig — wraps one room's definition and sensor values
// ---------------------------------------------------------------------------
class RoomConfig {
  constructor(data) {
    this.id    = data.id;
    this.roomName  = data.name; // renamed: avoid 'name' shadowing issues
    this.floorNum  = data.floor;
    this.sensors   = { ...data.sensors };
    this.bounds    = floorBounds(data.floor);
  }

  // Normalised 0–1 sensor helpers
  normTemp()     { return constrain((this.sensors.temperature - 10) / 25, 0, 1); }  // 10–35°C
  normHumidity() { return constrain(this.sensors.humidity / 100, 0, 1); }
  normLight()    { return constrain(this.sensors.light / 600, 0, 1); }              // 0–600 lux
  normCo2()      { return constrain((this.sensors.co2 - 400) / 800, 0, 1); }       // 400–1200 ppm
  hasMotion()    { return this.sensors.motion === true; }

  update(newSensors) {
    this.sensors = { ...newSensors };
  }
}

// ---------------------------------------------------------------------------
// Base Cell class
// ---------------------------------------------------------------------------
class BaseCell {
  constructor(roomCfg) {
    const b = roomCfg.bounds;
    this.roomId    = roomCfg.id;
    this.floorNum  = roomCfg.floorNum;
    this.posX      = b.x + random(CELL_RADIUS + 4, b.w - CELL_RADIUS - 4);
    this.posY      = b.y + random(CELL_RADIUS + 4, b.h - CELL_RADIUS - 4);
    this.velX      = random(-0.8, 0.8);
    this.velY      = random(-0.8, 0.8);
    this.energy    = random(60, 100);
    this.lifespan  = random(400, 800);
    this.age       = 0;
    this.cellSize  = CELL_RADIUS;
    this.isDead    = false;
    this.cellType  = 'base';
  }

  getRoomConfig() {
    return roomDataList.find(r => r.id === this.roomId);
  }

  // Apply environmental modifiers each frame
  applyEnvironment() {
    const roomCfg = this.getRoomConfig();
    if (!roomCfg) return;

    const speedFactor = 0.5 + roomCfg.normTemp() * 1.5;  // hotter → faster
    this.velX *= speedFactor;
    this.velY *= speedFactor;

    // Motion detected → scatter burst
    if (roomCfg.hasMotion() && random() < 0.04) {
      this.velX += random(-3, 3);
      this.velY += random(-3, 3);
    }
  }

  // Clamp velocity
  limitSpeed(maxSpd) {
    const spd = sqrt(this.velX * this.velX + this.velY * this.velY);
    if (spd > maxSpd) {
      this.velX = (this.velX / spd) * maxSpd;
      this.velY = (this.velY / spd) * maxSpd;
    }
  }

  // Keep cell within its room bounds; bounce off walls.
  // Door zones in top/bottom edges allow cells to pass through instead of bouncing.
  bounceInRoom() {
    const roomCfg = this.getRoomConfig();
    if (!roomCfg) return;
    const b      = roomCfg.bounds;
    const margin = this.cellSize;

    // Left / right walls always bounce
    if (this.posX < b.x + margin)       { this.posX = b.x + margin;       this.velX *= -1; }
    if (this.posX > b.x + b.w - margin) { this.posX = b.x + b.w - margin; this.velX *= -1; }

    // Top edge — bounce unless cell is inside a door X-zone
    if (this.posY < b.y + margin) {
      if (!this.isInDoorXZone('top')) {
        this.posY = b.y + margin;
        this.velY *= -1;
      }
    }

    // Bottom edge — bounce unless cell is inside a door X-zone
    if (this.posY > b.y + b.h - margin) {
      if (!this.isInDoorXZone('bottom')) {
        this.posY = b.y + b.h - margin;
        this.velY *= -1;
      }
    }
  }

  // Returns true when this cell is horizontally inside a doorway opening at the
  // given vertical edge ('top' or 'bottom') of its current floor.
  isInDoorXZone(edge) {
    if (!appConfig || !appConfig.doors) return false;
    for (const door of appConfig.doors) {
      const di = doorInfo(door.fromFloor, door.toFloor, door.positionFraction);
      // lowerFloor (lower floor number) connects at its TOP edge
      // upperFloor (higher floor number) connects at its BOTTOM edge
      const edgeMatches =
        (edge === 'top'    && this.floorNum === di.lowerFloor) ||
        (edge === 'bottom' && this.floorNum === di.upperFloor);
      if (edgeMatches && this.posX >= di.x && this.posX <= di.x + di.w) return true;
    }
    return false;
  }

  // Teleport cell to adjacent floor when it has drifted into the gap zone.
  // This runs AFTER bounceInRoom so only cells that passed the door edge reach here.
  checkDoorMigration() {
    if (!appConfig || !appConfig.doors) return;

    for (const door of appConfig.doors) {
      const di       = doorInfo(door.fromFloor, door.toFloor, door.positionFraction);
      const gapTop   = di.y;              // top of gap    = bottom of upperFloor room
      const gapBot   = di.y + BORDER_H;  // bottom of gap = top of lowerFloor room

      // Cell must be horizontally inside the doorway
      if (this.posX < di.x || this.posX > di.x + di.w) continue;

      // Cell must have entered the gap zone between the two floors
      if (this.posY < gapTop || this.posY > gapBot) continue;

      // Determine target floor from direction of travel
      let targetFloor;
      if (this.floorNum === di.lowerFloor) {
        targetFloor = di.upperFloor;   // moving up (toward lower Y)
      } else if (this.floorNum === di.upperFloor) {
        targetFloor = di.lowerFloor;   // moving down (toward higher Y)
      } else {
        continue; // cell somehow from a different floor — skip
      }

      const originalFloor = this.floorNum;
      const targetRoom    = roomDataList.find(r => r.floorNum === targetFloor);
      if (!targetRoom) continue;

      this.roomId   = targetRoom.id;
      this.floorNum = targetRoom.floorNum;
      const tb      = targetRoom.bounds;
      this.posX     = constrain(this.posX, tb.x + this.cellSize + 2, tb.x + tb.w - this.cellSize - 2);
      // Place cell just inside the target room, adjacent to the door gap
      this.posY = (targetFloor > originalFloor)
        ? tb.y + tb.h - this.cellSize - 3   // going up   → appear at bottom of upper room
        : tb.y + this.cellSize + 3;          // going down → appear at top of lower room
      break;
    }
  }

  baseUpdate() {
    this.age++;
    this.energy -= 0.12;
    this.applyEnvironment();
    this.velX += random(-0.15, 0.15);
    this.velY += random(-0.15, 0.15);
    this.limitSpeed(2.5);
    this.posX += this.velX;
    this.posY += this.velY;
    this.bounceInRoom();
    this.checkDoorMigration();

    if (this.energy <= 0 || this.age >= this.lifespan) {
      this.isDead = true;
    }
  }
}

// ---------------------------------------------------------------------------
// CellProducer — photosynthetic, needs light, hurt by high CO2
// ---------------------------------------------------------------------------
class CellProducer extends BaseCell {
  constructor(roomCfg) {
    super(roomCfg);
    this.cellType = 'producer';
    this.cellSize = CELL_RADIUS - 1;
  }

  update() {
    this.baseUpdate();
    if (this.isDead) return;

    const roomCfg = this.getRoomConfig();
    if (!roomCfg) return;

    // Photosynthesis: gain energy from light
    this.energy += roomCfg.normLight() * 0.6;

    // CO2 stress
    this.energy -= roomCfg.normCo2() * 0.25;

    // Humidity boost
    this.energy += roomCfg.normHumidity() * 0.08;

    // Clamp energy
    this.energy = constrain(this.energy, 0, 120);

    // Replicate when well-fed and light is good
    if (this.energy > 90 && roomCfg.normLight() > 0.3 && random() < 0.004) {
      trySpawnCell('producer', roomCfg);
      this.energy -= 30;
    }
  }

  draw() {
    const alpha = map(this.energy, 0, 120, 80, 255);
    fill(94, 207, 122, alpha);
    noStroke();
    const pulse = this.cellSize + sin(this.age * 0.08) * 0.8;
    ellipse(this.posX, this.posY, pulse * 2, pulse * 2);
  }
}

// ---------------------------------------------------------------------------
// CellHerbivore — eats producers, temp-driven, flees predators
// ---------------------------------------------------------------------------
class CellHerbivore extends BaseCell {
  constructor(roomCfg) {
    super(roomCfg);
    this.cellType = 'herbivore';
    this.cellSize = CELL_RADIUS;
  }

  update() {
    this.baseUpdate();
    if (this.isDead) return;

    const roomCfg = this.getRoomConfig();
    if (!roomCfg) return;

    // Find nearest producer to eat
    let nearestProducer = null;
    let nearestDist     = 80;
    for (const c of allCells) {
      if (c.cellType === 'producer' && c.roomId === this.roomId && !c.isDead) {
        const d = dist(this.posX, this.posY, c.posX, c.posY);
        if (d < nearestDist) {
          nearestDist    = d;
          nearestProducer = c;
        }
      }
    }

    if (nearestProducer) {
      // Move toward it
      const dx = nearestProducer.posX - this.posX;
      const dy = nearestProducer.posY - this.posY;
      const mag = sqrt(dx * dx + dy * dy) || 1;
      this.velX += (dx / mag) * 0.4;
      this.velY += (dy / mag) * 0.4;

      if (nearestDist < this.cellSize + nearestProducer.cellSize + 2) {
        nearestProducer.isDead = true;
        this.energy += 35;
      }
    }

    // Flee predators
    for (const c of allCells) {
      if (c.cellType === 'predator' && c.roomId === this.roomId && !c.isDead) {
        const d = dist(this.posX, this.posY, c.posX, c.posY);
        if (d < 70) {
          this.velX -= (c.posX - this.posX) * 0.06;
          this.velY -= (c.posY - this.posY) * 0.06;
        }
      }
    }

    this.energy -= 0.05;
    this.energy = constrain(this.energy, 0, 120);

    // Replicate when fed
    if (this.energy > 95 && random() < 0.003) {
      trySpawnCell('herbivore', roomCfg);
      this.energy -= 35;
    }
  }

  draw() {
    const alpha = map(this.energy, 0, 120, 80, 255);
    fill(90, 180, 212, alpha);
    noStroke();
    ellipse(this.posX, this.posY, this.cellSize * 2, this.cellSize * 2);
    // Small flagellum hint
    stroke(90, 180, 212, alpha * 0.5);
    strokeWeight(1);
    const angle = atan2(this.velY, this.velX) + PI;
    line(
      this.posX, this.posY,
      this.posX + cos(angle) * 6,
      this.posY + sin(angle) * 6
    );
    noStroke();
  }
}

// ---------------------------------------------------------------------------
// CellPredator — hunts herbivores, thrives in warm rooms
// ---------------------------------------------------------------------------
class CellPredator extends BaseCell {
  constructor(roomCfg) {
    super(roomCfg);
    this.cellType = 'predator';
    this.cellSize = CELL_RADIUS + 1;
    this.lifespan = random(600, 1000);
  }

  update() {
    this.baseUpdate();
    if (this.isDead) return;

    const roomCfg = this.getRoomConfig();
    if (!roomCfg) return;

    // Warm rooms help predators
    this.energy += roomCfg.normTemp() * 0.15;
    // Cold stresses them
    this.energy -= (1 - roomCfg.normTemp()) * 0.1;
    this.energy -= 0.18; // higher baseline cost
    this.energy = constrain(this.energy, 0, 130);

    // Hunt nearest herbivore
    let prey = null;
    let preyDist = 100;
    for (const c of allCells) {
      if (c.cellType === 'herbivore' && c.roomId === this.roomId && !c.isDead) {
        const d = dist(this.posX, this.posY, c.posX, c.posY);
        if (d < preyDist) {
          preyDist = d;
          prey = c;
        }
      }
    }

    if (prey) {
      const dx = prey.posX - this.posX;
      const dy = prey.posY - this.posY;
      const mag = sqrt(dx * dx + dy * dy) || 1;
      this.velX += (dx / mag) * 0.5;
      this.velY += (dy / mag) * 0.5;

      if (preyDist < this.cellSize + prey.cellSize + 2) {
        prey.isDead = true;
        this.energy += 50;
      }
    }

    // Replicate when very well-fed
    if (this.energy > 110 && random() < 0.002) {
      trySpawnCell('predator', roomCfg);
      this.energy -= 50;
    }
  }

  draw() {
    const alpha = map(this.energy, 0, 130, 80, 255);
    fill(224, 92, 92, alpha);
    noStroke();
    // Triangle shape for predators
    const sz = this.cellSize * 2;
    const angle = atan2(this.velY, this.velX);
    push();
    translate(this.posX, this.posY);
    rotate(angle);
    triangle(sz, 0, -sz * 0.6, -sz * 0.5, -sz * 0.6, sz * 0.5);
    pop();
  }
}

// ---------------------------------------------------------------------------
// CellDecomposer — eats dead cells, needs humidity + CO2
// ---------------------------------------------------------------------------
class CellDecomposer extends BaseCell {
  constructor(roomCfg) {
    super(roomCfg);
    this.cellType = 'decomposer';
    this.cellSize = CELL_RADIUS - 1;
    this.lifespan = random(500, 900);
  }

  update() {
    this.baseUpdate();
    if (this.isDead) return;

    const roomCfg = this.getRoomConfig();
    if (!roomCfg) return;

    // Thrive with humidity + CO2
    this.energy += roomCfg.normHumidity() * 0.2;
    this.energy += roomCfg.normCo2() * 0.2;
    this.energy -= 0.14;
    this.energy = constrain(this.energy, 0, 100);

    // Eat nearest dead cell
    let nearDead = null;
    let nearDeadDist = 60;
    for (const dc of deadCells) {
      if (dc.roomId === this.roomId) {
        const d = dist(this.posX, this.posY, dc.posX, dc.posY);
        if (d < nearDeadDist) {
          nearDeadDist = d;
          nearDead = dc;
        }
      }
    }

    if (nearDead) {
      const dx = nearDead.posX - this.posX;
      const dy = nearDead.posY - this.posY;
      const mag = sqrt(dx * dx + dy * dy) || 1;
      this.velX += (dx / mag) * 0.3;
      this.velY += (dy / mag) * 0.3;

      if (nearDeadDist < this.cellSize + 4) {
        nearDead.decayLife = 0; // consume it
        this.energy += 25;
      }
    }

    // Replicate in rich conditions
    if (this.energy > 80 && roomCfg.normHumidity() > 0.5 && random() < 0.003) {
      trySpawnCell('decomposer', roomCfg);
      this.energy -= 30;
    }
  }

  draw() {
    const alpha = map(this.energy, 0, 100, 80, 255);
    fill(155, 127, 201, alpha);
    noStroke();
    // Irregular blob using several overlapping small circles
    for (let i = 0; i < 3; i++) {
      const ox = sin(this.age * 0.05 + i * TWO_PI / 3) * 2;
      const oy = cos(this.age * 0.05 + i * TWO_PI / 3) * 2;
      ellipse(this.posX + ox, this.posY + oy, this.cellSize * 1.6, this.cellSize * 1.6);
    }
  }
}

// ---------------------------------------------------------------------------
// Dead cell (visual remnant + food for decomposers)
// ---------------------------------------------------------------------------
class DeadCell {
  constructor(liveCell) {
    this.posX      = liveCell.posX;
    this.posY      = liveCell.posY;
    this.roomId    = liveCell.roomId;
    this.decayLife = DEAD_DECAY_LIFE;
    this.cellType  = liveCell.cellType;
  }

  update() { this.decayLife--; }
  isGone()  { return this.decayLife <= 0; }

  draw() {
    const alpha = map(this.decayLife, 0, DEAD_DECAY_LIFE, 0, 100);
    fill(85, 85, 85, alpha);
    noStroke();
    ellipse(this.posX, this.posY, CELL_RADIUS * 1.4, CELL_RADIUS * 1.4);
  }
}

// ---------------------------------------------------------------------------
// Cell factory
// ---------------------------------------------------------------------------
function makeCell(cellTypeName, roomCfg) {
  switch (cellTypeName) {
    case 'producer':   return new CellProducer(roomCfg);
    case 'herbivore':  return new CellHerbivore(roomCfg);
    case 'predator':   return new CellPredator(roomCfg);
    case 'decomposer': return new CellDecomposer(roomCfg);
    default: return new CellProducer(roomCfg);
  }
}

function trySpawnCell(cellTypeName, roomCfg) {
  const roomCells = allCells.filter(c => c.roomId === roomCfg.id);
  if (roomCells.length >= MAX_CELLS_ROOM) return;
  allCells.push(makeCell(cellTypeName, roomCfg));
}

// ---------------------------------------------------------------------------
// Seed initial population
// ---------------------------------------------------------------------------
function seedPopulation() {
  allCells = [];
  deadCells = [];
  for (const roomCfg of roomDataList) {
    for (const typeName of ['producer', 'herbivore', 'predator', 'decomposer']) {
      for (let i = 0; i < INITIAL_CELLS; i++) {
        allCells.push(makeCell(typeName, roomCfg));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Load / refresh data from rooms.json
// ---------------------------------------------------------------------------
function loadRoomsData() {
  fetch('rooms.json?' + Date.now())
    .then(resp => resp.json())
    .then(data => {
      appConfig = data;
      if (!dataLoaded) {
        // First load: build room objects and seed
        roomDataList = data.rooms.map(r => new RoomConfig(r));
        seedPopulation();
        dataLoaded = true;
      } else {
        // Subsequent refresh: update sensor values only
        for (const rawRoom of data.rooms) {
          const existing = roomDataList.find(r => r.id === rawRoom.id);
          if (existing) existing.update(rawRoom.sensors);
        }
      }
      lastRefreshTime = millis();
      nextRefreshSecs = data.refreshIntervalMs / 1000;
      document.getElementById('status-bar').textContent =
        '✅ Data geladen — ' + new Date().toLocaleTimeString('nl-NL');
    })
    .catch(() => {
      // Offline / no server: use embedded fallback
      if (!dataLoaded) {
        appConfig = buildFallbackConfig();
        roomDataList = appConfig.rooms.map(r => new RoomConfig(r));
        seedPopulation();
        dataLoaded = true;
        lastRefreshTime = millis();
        nextRefreshSecs = 180;
        document.getElementById('status-bar').textContent =
          '⚠️ Offline modus — statische demo data';
      }
    });
}

function buildFallbackConfig() {
  return {
    refreshIntervalMs: 180000,
    rooms: [
      { id: 'floor1', name: 'Begane grond',       floor: 1, sensors: { temperature: 21.5, humidity: 55, light: 320, motion: false, co2: 820 } },
      { id: 'floor2', name: 'Eerste verdieping',  floor: 2, sensors: { temperature: 19.2, humidity: 62, light: 80,  motion: true,  co2: 650 } },
      { id: 'floor3', name: 'Tweede verdieping',  floor: 3, sensors: { temperature: 17.8, humidity: 45, light: 15,  motion: false, co2: 480 } }
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
function drawRoomBackground(roomCfg) {
  const b = roomCfg.bounds;

  // Base room colour tinted by temperature
  const tempTint = roomCfg.normTemp();
  const lightTint = roomCfg.normLight();
  const rVal = 15 + tempTint * 25;
  const gVal = 15 + lightTint * 18;
  const bVal = 25 + (1 - tempTint) * 20;
  fill(rVal, gVal, bVal);
  noStroke();
  rect(b.x, b.y, b.w, b.h);

  // Subtle floor label strip
  fill(0, 0, 0, 60);
  rect(b.x, b.y, b.w, 22);
}

function drawDoors() {
  if (!appConfig || !appConfig.doors) return;
  for (const door of appConfig.doors) {
    const di = doorInfo(door.fromFloor, door.toFloor, door.positionFraction);

    // Whole gap between floors is dark
    fill(8, 8, 8);
    noStroke();
    rect(0, di.y, CANVAS_W, BORDER_H);

    // Door opening highlight
    fill(40, 60, 40, 180);
    noStroke();
    rect(di.x, di.y, di.w, BORDER_H);

    // Door frame lines
    stroke(80, 120, 80, 160);
    strokeWeight(1);
    line(di.x, di.y, di.x, di.y + BORDER_H);
    line(di.x + di.w, di.y, di.x + di.w, di.y + BORDER_H);
    noStroke();
  }
}

function drawRoomHUD(roomCfg) {
  const b   = roomCfg.bounds;
  const s   = roomCfg.sensors;
  const mx  = b.x + HUD_MARGIN;
  const myStart = b.y + HUD_MARGIN + 2;

  // Count cells in this room
  let cntProducer = 0, cntHerbivore = 0, cntPredator = 0, cntDecomposer = 0;
  for (const c of allCells) {
    if (c.roomId !== roomCfg.id) continue;
    if (c.cellType === 'producer')   cntProducer++;
    else if (c.cellType === 'herbivore')  cntHerbivore++;
    else if (c.cellType === 'predator')   cntPredator++;
    else if (c.cellType === 'decomposer') cntDecomposer++;
  }

  textSize(11);
  textAlign(LEFT, TOP);
  noStroke();

  // Room name — bright
  fill(200, 240, 200);
  text('▣ ' + roomCfg.roomName, mx, myStart);

  // Sensor row
  fill(180, 180, 180);
  const sensorRow = myStart + 14;
  const motionIcon = s.motion ? '🏃' : '💤';
  text(
    `🌡 ${s.temperature.toFixed(1)}°C  💧 ${s.humidity}%  💡 ${s.light} lux  ${motionIcon}  CO₂ ${s.co2}ppm`,
    mx, sensorRow
  );

  // Cell counts
  fill(130, 210, 150);
  text(`🌿 ${cntProducer}`, mx, sensorRow + 14);
  fill(120, 190, 220);
  text(`🔵 ${cntHerbivore}`, mx + 52, sensorRow + 14);
  fill(220, 120, 120);
  text(`🔴 ${cntPredator}`, mx + 110, sensorRow + 14);
  fill(180, 150, 220);
  text(`🟣 ${cntDecomposer}`, mx + 168, sensorRow + 14);
}

function drawRefreshCountdown() {
  if (!dataLoaded) return;
  const elapsedSec = (millis() - lastRefreshTime) / 1000;
  const remaining  = Math.max(0, nextRefreshSecs - elapsedSec) | 0;
  const mins = (remaining / 60) | 0;
  const secs = remaining % 60;
  document.getElementById('refresh-info').textContent =
    `⟳ Volgende data-refresh over ${mins}m ${secs < 10 ? '0' : ''}${secs}s`;
}

// ---------------------------------------------------------------------------
// p5.js lifecycle
// ---------------------------------------------------------------------------
function setup() {
  const canvas = createCanvas(CANVAS_W, CANVAS_H);
  canvas.parent('canvas-container');
  loadRoomsData();
}

function draw() {
  // Data not yet loaded
  if (!dataLoaded) {
    background(13, 13, 13);
    fill(100, 200, 120);
    textAlign(CENTER, CENTER);
    textSize(14);
    text('Laden…', CANVAS_W / 2, CANVAS_H / 2);
    return;
  }

  // Check if refresh interval elapsed
  if (millis() - lastRefreshTime > appConfig.refreshIntervalMs) {
    loadRoomsData();
  }

  // Background fill
  background(13, 13, 13);

  // Draw each room
  for (const roomCfg of roomDataList) {
    drawRoomBackground(roomCfg);
  }

  // Draw door gaps on top of room backgrounds
  drawDoors();

  // Draw dead cells
  for (const dc of deadCells) {
    dc.update();
    dc.draw();
  }
  deadCells = deadCells.filter(dc => !dc.isGone());

  // Update + draw living cells
  for (const cell of allCells) {
    cell.update();
    cell.draw();
    if (cell.isDead) {
      deadCells.push(new DeadCell(cell));
    }
  }
  allCells = allCells.filter(c => !c.isDead);

  // Room HUDs (drawn after cells so text is on top)
  for (const roomCfg of roomDataList) {
    drawRoomHUD(roomCfg);
  }

  // Refresh countdown (DOM, not canvas)
  if (frameCount % 60 === 0) {
    drawRefreshCountdown();
  }
}
