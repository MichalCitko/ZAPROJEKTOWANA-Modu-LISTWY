(() => {
  const $ = (selector) => document.querySelector(selector);
  const ui = {
    fileInput: $('#fileInput'),
    dropZone: $('#dropZone'),
    emptyState: $('#emptyState'),
    planSvg: $('#planSvg'),
    planGroup: $('#planGroup'),
    drawingStatus: $('#drawingStatus'),
    fileCard: $('#fileCard'),
    fileName: $('#fileName'),
    fileDetails: $('#fileDetails'),
    unitRow: $('#unitRow'),
    unitSelect: $('#unitSelect'),
    parseNote: $('#parseNote'),
    candidateList: $('#candidateList'),
    candidateHint: $('#candidateHint'),
    resultsBody: $('#resultsBody'),
    totalLength: $('#totalLength'),
    exportButton: $('#exportButton'),
    toast: $('#toast'),
  };

  const unitToMeters = { 0: null, 1: 0.0254, 2: 0.3048, 4: 0.001, 5: 0.01, 6: 1 };
  const proposalColors = ['#2365bd', '#178276', '#8151b5', '#bd5d18', '#bd3f69', '#547f2a', '#5b67ba', '#9c6a19'];
  const skirtingColors = [
    'Biały',
    'Czarny',
    'Szary',
    'Grafitowy',
    'Beżowy',
    'Brązowy',
    'Dąb naturalny',
    'Dąb bielony',
    'Dąb sonoma',
    'Orzech',
  ];
  const state = {
    fileName: '',
    units: 4,
    factor: unitToMeters[4],
    unitNeedsConfirmation: false,
    entities: [],
    hatches: [],
    wallPolygons: [],
    doorways: [],
    candidates: [],
    selected: new Set(),
    removedPathIds: new Set(),
    edgeDrag: null,
    panDrag: null,
    dividerDrawing: null,
    eraserDrawing: null,
    extents: null,
    toastTimer: null,
  };

  function showToast(message) {
    ui.toast.textContent = message;
    ui.toast.classList.add('visible');
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => ui.toast.classList.remove('visible'), 3400);
  }

  function normalizeText(text) {
    return String(text).replace(/[Łł]/g, 'l').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  }

  function isZigzag(lineType) {
    const name = normalizeText(lineType);
    return name.includes('zigzag') || name.includes('zygzak');
  }

  function numberAt(entity, code, fallback = NaN) {
    const pair = entity.find(([group]) => group === code);
    return pair ? Number(pair[1]) : fallback;
  }

  function valueAt(entity, code, fallback = '') {
    return entity.find(([group]) => group === code)?.[1] ?? fallback;
  }

  function getPairs(text) {
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    const pairs = [];
    for (let i = 0; i + 1 < lines.length; i += 2) {
      const code = Number.parseInt(lines[i].trim(), 10);
      if (Number.isInteger(code)) pairs.push([code, lines[i + 1].trim()]);
    }
    return pairs;
  }

  function getSections(pairs) {
    const sections = new Map();
    for (let i = 0; i < pairs.length; i++) {
      if (pairs[i][0] !== 0 || pairs[i][1] !== 'SECTION') continue;
      let sectionName = '';
      let start = i + 1;
      while (start < pairs.length && pairs[start][0] !== 0) {
        if (pairs[start][0] === 2) {
          sectionName = pairs[start][1];
          break;
        }
        start++;
      }
      if (!sectionName) continue;
      const content = [];
      for (i = start + 1; i < pairs.length; i++) {
        if (pairs[i][0] === 0 && pairs[i][1] === 'ENDSEC') break;
        content.push(pairs[i]);
      }
      sections.set(sectionName, content);
    }
    return sections;
  }

  function splitEntities(pairs) {
    const entities = [];
    let current = null;
    for (const pair of pairs) {
      if (pair[0] === 0) {
        if (current) entities.push(current);
        current = [pair];
      } else if (current) {
        current.push(pair);
      }
    }
    if (current) entities.push(current);
    return entities;
  }

  function layerStylesFrom(pairs) {
    const styles = new Map();
    for (const record of splitEntities(pairs)) {
      if (record[0][1] !== 'LAYER') continue;
      styles.set(valueAt(record, 2, '0'), {
        lineType: valueAt(record, 6, 'Continuous'),
        color: Math.abs(numberAt(record, 62, 7)),
      });
    }
    return styles;
  }

  function layerOf(record) {
    return valueAt(record, 8, '0');
  }

  function lineTypeOf(record, layerStyles, layer) {
    const entityLineType = valueAt(record, 6, '');
    if (entityLineType && normalizeText(entityLineType) !== 'bylayer') return entityLineType;
    return layerStyles.get(layer)?.lineType || 'Continuous';
  }

  function colorOf(record, layerStyles, layer) {
    const entityColor = numberAt(record, 62, 256);
    return entityColor === 256
      ? (layerStyles.get(layer)?.color ?? 7)
      : Math.abs(entityColor);
  }

  function pairsToPoints(record) {
    const points = [];
    for (let i = 0; i < record.length; i++) {
      if (record[i][0] !== 10) continue;
      const x = Number(record[i][1]);
      let y = NaN;
      let bulge = 0;
      for (let j = i + 1; j < record.length && record[j][0] !== 10; j++) {
        if (record[j][0] === 20) y = Number(record[j][1]);
        if (record[j][0] === 42) bulge = Number(record[j][1]);
      }
      if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y, bulge });
    }
    return points;
  }

  function bulgePoints(start, end, bulge) {
    if (!bulge || Math.abs(bulge) < 1e-8) return [end];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const chord = Math.hypot(dx, dy);
    const theta = 4 * Math.atan(bulge);
    const radius = chord / (2 * Math.sin(Math.abs(theta) / 2));
    const offset = chord * (1 - bulge * bulge) / (4 * bulge);
    const midX = (start.x + end.x) / 2;
    const midY = (start.y + end.y) / 2;
    const centerX = midX - dy / chord * offset;
    const centerY = midY + dx / chord * offset;
    const startAngle = Math.atan2(start.y - centerY, start.x - centerX);
    const steps = Math.max(4, Math.ceil(Math.abs(theta) / (Math.PI / 18)));
    const points = [];
    for (let i = 1; i <= steps; i++) {
      const angle = startAngle + theta * i / steps;
      points.push({ x: centerX + radius * Math.cos(angle), y: centerY + radius * Math.sin(angle), bulge: 0 });
    }
    return points;
  }

  function expandBulges(points, closed) {
    if (points.length < 2) return points;
    const expanded = [];
    const edgeCount = closed ? points.length : points.length - 1;
    for (let i = 0; i < edgeCount; i++) {
      const start = points[i];
      const end = points[(i + 1) % points.length];
      expanded.push({ x: start.x, y: start.y });
      expanded.push(...bulgePoints(start, end, start.bulge));
    }
    if (!closed) expanded.push({ x: points.at(-1).x, y: points.at(-1).y });
    return expanded;
  }

  function polylineLength(points, closed) {
    let length = 0;
    for (let i = 1; i < points.length; i++) {
      length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    }
    if (closed && points.length > 2) {
      length += Math.hypot(points[0].x - points.at(-1).x, points[0].y - points.at(-1).y);
    }
    return length;
  }

  function polygonArea(points) {
    let area = 0;
    for (let i = 0; i < points.length; i++) {
      const next = points[(i + 1) % points.length];
      area += points[i].x * next.y - next.x * points[i].y;
    }
    return Math.abs(area) / 2;
  }

  function hatchPolygons(record) {
    const loops = [];
    for (let i = 0; i < record.length; i++) {
      if (record[i][0] !== 92 || !(Number(record[i][1]) & 2)) continue;
      let end = i + 1;
      while (end < record.length && record[end][0] !== 92 && record[end][0] !== 97) end++;
      const countIndex = record.findIndex((pair, index) => index > i && index < end && pair[0] === 93);
      if (countIndex < 0) continue;
      const count = Number(record[countIndex][1]);
      const points = [];
      for (let j = countIndex + 1; j < end && points.length < count; j++) {
        if (record[j][0] !== 10) continue;
        const x = Number(record[j][1]);
        let y = NaN;
        for (let k = j + 1; k < end && record[k][0] !== 10; k++) {
          if (record[k][0] === 20) {
            y = Number(record[k][1]);
            break;
          }
        }
        if (Number.isFinite(x) && Number.isFinite(y)) points.push({ x, y });
      }
      if (points.length >= 3) loops.push(points);
      i = end - 1;
    }
    return loops;
  }

  function parseBlocks(pairs) {
    const blocks = new Map();
    let current = null;
    for (const record of splitEntities(pairs)) {
      if (record[0][1] === 'BLOCK') {
        current = {
          base: { x: numberAt(record, 10, 0), y: numberAt(record, 20, 0) },
          entities: [],
        };
        blocks.set(valueAt(record, 2), current);
      } else if (record[0][1] === 'ENDBLK') {
        current = null;
      } else if (current) {
        current.entities.push(record);
      }
    }
    return blocks;
  }

  function transformPoint(point, block, insert) {
    const angle = numberAt(insert, 50, 0) * Math.PI / 180;
    const scaleX = numberAt(insert, 41, 1);
    const scaleY = numberAt(insert, 42, 1);
    const x = (point.x - block.base.x) * scaleX;
    const y = (point.y - block.base.y) * scaleY;
    return {
      x: numberAt(insert, 10, 0) + x * Math.cos(angle) - y * Math.sin(angle),
      y: numberAt(insert, 20, 0) + x * Math.sin(angle) + y * Math.cos(angle),
    };
  }

  function readWallGeometry(entityRecords, blocks) {
    const wallPolygons = [];
    const doorways = [];
    for (const wallInsert of entityRecords) {
      if (wallInsert[0][1] !== 'INSERT') continue;
      const wallName = valueAt(wallInsert, 2);
      if (!normalizeText(wallName).startsWith('sciana')) continue;
      const wall = blocks.get(wallName);
      if (!wall) continue;

      for (const blockEntity of wall.entities) {
        if (blockEntity[0][1] !== 'HATCH' ||
            !normalizeText(valueAt(blockEntity, 2)).includes('beton')) continue;
        for (const polygon of hatchPolygons(blockEntity)) {
          wallPolygons.push(polygon.map((point) => transformPoint(point, wall, wallInsert)));
        }
      }

      for (const doorInsert of wall.entities) {
        if (doorInsert[0][1] !== 'INSERT') continue;
        const doorName = valueAt(doorInsert, 2);
        if (!normalizeText(doorName).startsWith('drzwi')) continue;
        const door = blocks.get(doorName);
        const arc = door?.entities.find((entity) => entity[0][1] === 'ARC');
        if (!door || !arc) continue;

        const radius = numberAt(arc, 40);
        const center = { x: numberAt(arc, 10), y: numberAt(arc, 20) };
        if (!Number.isFinite(radius) || radius <= 0 ||
            !Number.isFinite(center.x) || !Number.isFinite(center.y)) continue;

        const start = transformPoint(
          transformPoint({ x: center.x - radius, y: center.y }, door, doorInsert),
          wall,
          wallInsert,
        );
        const end = transformPoint(
          transformPoint(center, door, doorInsert),
          wall,
          wallInsert,
        );
        doorways.push({ a: start, b: end });
      }
    }
    return { wallPolygons, doorways };
  }

  function parseDxf(text) {
    const pairs = getPairs(text);
    const sections = getSections(pairs);
    const header = sections.get('HEADER') || [];
    let units = 0;
    for (let i = 0; i < header.length; i++) {
      if (header[i][0] === 9 && header[i][1] === '$INSUNITS') {
        units = Number(header[i + 1]?.[1]) || 0;
        break;
      }
    }

    const layerStyles = layerStylesFrom(sections.get('TABLES') || []);
    const records = splitEntities(sections.get('ENTITIES') || []);
    const blocks = parseBlocks(sections.get('BLOCKS') || []);
    const entities = [];
    const hatches = [];
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const type = record[0][1];
      const layer = layerOf(record);
      if (type === 'HATCH') {
        hatches.push({
          pattern: valueAt(record, 2, ''),
          loops: hatchPolygons(record),
        });
        continue;
      }
      const lineType = lineTypeOf(record, layerStyles, layer);
      const color = colorOf(record, layerStyles, layer);
      const addEntity = (entityType, points, closed) => {
        entities.push({
          id: `entity-${entities.length}`,
          type: entityType,
          layer,
          lineType,
          color,
          points,
          closed,
          skirting: isZigzag(lineType),
        });
      };
      if (type === 'LINE') {
        const x1 = numberAt(record, 10);
        const y1 = numberAt(record, 20);
        const x2 = numberAt(record, 11);
        const y2 = numberAt(record, 21);
        if ([x1, y1, x2, y2].every(Number.isFinite)) {
          addEntity('line', [{ x: x1, y: y1 }, { x: x2, y: y2 }], false);
        }
      } else if (type === 'LWPOLYLINE') {
        const closed = (numberAt(record, 70, 0) & 1) === 1;
        const rawPoints = pairsToPoints(record);
        if (rawPoints.length >= 2) addEntity('polyline', expandBulges(rawPoints, closed), closed);
      } else if (type === 'POLYLINE') {
        const rawPoints = [];
        for (let j = i + 1; j < records.length && records[j][0][1] === 'VERTEX'; j++) {
          const vertex = records[j];
          rawPoints.push({ x: numberAt(vertex, 10), y: numberAt(vertex, 20), bulge: numberAt(vertex, 42, 0) });
          i = j;
        }
        const closed = (numberAt(record, 70, 0) & 1) === 1;
        if (rawPoints.length >= 2 && rawPoints.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))) {
          addEntity('polyline', expandBulges(rawPoints, closed), closed);
        }
      }
    }
    if (!entities.length) throw new Error('Nie znaleziono obsługiwanych linii ani polilinii w sekcji ENTITIES.');
    const { wallPolygons, doorways } = readWallGeometry(records, blocks);
    return { units, entities, hatches, wallPolygons, doorways, entityCount: records.length };
  }

  function getPathSegments(path) {
    const points = path.entity.points;
    const count = path.entity.closed ? points.length : points.length - 1;
    const segments = [];
    for (let index = 0; index < count; index++) {
      const a = points[index];
      const b = points[(index + 1) % points.length];
      if (Math.hypot(a.x - b.x, a.y - b.y) > 0) segments.push({ a, b, index });
    }
    return segments;
  }

  function candidateSegments(candidate) {
    return candidate.paths.flatMap((path) =>
      getPathSegments(path).map((segment) => ({ ...segment, pathId: path.id, path }))
    );
  }

  function pointOnSegment(point, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    if (!lengthSquared) return Math.hypot(point.x - a.x, point.y - a.y) < 1e-7;
    const fraction = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
    return Math.hypot(point.x - (a.x + dx * fraction), point.y - (a.y + dy * fraction)) < 1e-7;
  }

  function pointInPolygon(point, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[i];
      const b = polygon[j];
      if (pointOnSegment(point, a, b)) return true;
      const crosses = (a.y > point.y) !== (b.y > point.y) &&
        point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x;
      if (crosses) inside = !inside;
    }
    return inside;
  }

  function distanceToSegment(point, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const fraction = lengthSquared
      ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared))
      : 0;
    return Math.hypot(point.x - (a.x + dx * fraction), point.y - (a.y + dy * fraction));
  }

  function distanceToPolygon(point, polygon) {
    if (pointInPolygon(point, polygon)) return 0;
    let nearest = Infinity;
    for (let i = 0; i < polygon.length; i++) {
      nearest = Math.min(nearest, distanceToSegment(point, polygon[i], polygon[(i + 1) % polygon.length]));
    }
    return nearest;
  }

  function pathMidpoint(entity) {
    const points = entity.points;
    const segments = [];
    let total = 0;
    const count = entity.closed ? points.length : points.length - 1;
    for (let i = 0; i < count; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length) {
        segments.push({ a, b, length });
        total += length;
      }
    }
    let remaining = total / 2;
    for (const segment of segments) {
      if (remaining <= segment.length) {
        const fraction = remaining / segment.length;
        return {
          x: segment.a.x + (segment.b.x - segment.a.x) * fraction,
          y: segment.a.y + (segment.b.y - segment.a.y) * fraction,
        };
      }
      remaining -= segment.length;
    }
    return points[0];
  }

  function materialName(pattern) {
    const name = String(pattern || 'Wykończenie podłogi').replaceAll('_', ' ').trim();
    return name.charAt(0).toLocaleUpperCase('pl-PL') + name.slice(1);
  }

  function floorZones(hatches, factor) {
    if (!factor) return [];
    const zones = [];
    for (const hatch of hatches) {
      const key = normalizeText(hatch.pattern);
      if (!key.includes('podloga') && !key.includes('siatka')) continue;
      const polygon = hatch.loops.sort((a, b) => polygonArea(b) - polygonArea(a))[0];
      if (!polygon) continue;
      const areaM2 = polygonArea(polygon) * factor * factor;
      if (areaM2 < 1 || areaM2 > 150) continue;
      zones.push({
        id: `zone-${zones.length}`,
        name: '',
        pattern: hatch.pattern,
        material: materialName(hatch.pattern),
        polygon,
        areaM2,
        paths: [],
      });
    }
    return zones;
  }

  function polygonBounds(polygon) {
    return polygon.reduce((bounds, point) => ({
      minX: Math.min(bounds.minX, point.x),
      minY: Math.min(bounds.minY, point.y),
      maxX: Math.max(bounds.maxX, point.x),
      maxY: Math.max(bounds.maxY, point.y),
    }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  }

  function pointInAnyPolygon(point, polygons) {
    return polygons.some((polygon) => {
      const bounds = polygon.bounds;
      return point.x >= bounds.minX && point.x <= bounds.maxX &&
        point.y >= bounds.minY && point.y <= bounds.maxY &&
        pointInPolygon(point, polygon.points);
    });
  }

  function outlinePathForCells(cells, columns, minX, minY, step) {
    const membership = new Set(cells);
    const edges = [];
    for (const index of cells) {
      const x = index % columns;
      const y = Math.floor(index / columns);
      const left = minX + x * step;
      const bottom = minY + y * step;
      if (y === 0 || !membership.has(index - columns)) edges.push(`M${left},${bottom}h${step}`);
      if (x + 1 === columns || !membership.has(index + 1)) edges.push(`M${left + step},${bottom}v${step}`);
      if (!membership.has(index + columns)) edges.push(`M${left + step},${bottom + step}h-${step}`);
      if (x === 0 || !membership.has(index - 1)) edges.push(`M${left},${bottom + step}v-${step}`);
    }
    return edges.join('');
  }

  function doorSeparatedRooms(zones, wallPolygons, doorways, factor) {
    if (!zones.length || !wallPolygons.length || !doorways.length || !factor) return null;

    const floorPolygons = zones.map((zone) => ({
      zone,
      points: zone.polygon,
      bounds: polygonBounds(zone.polygon),
    }));
    const wallShapes = wallPolygons.map((points) => ({ points, bounds: polygonBounds(points) }));
    const minX = Math.min(...floorPolygons.map(({ bounds }) => bounds.minX));
    const minY = Math.min(...floorPolygons.map(({ bounds }) => bounds.minY));
    const maxX = Math.max(...floorPolygons.map(({ bounds }) => bounds.maxX));
    const maxY = Math.max(...floorPolygons.map(({ bounds }) => bounds.maxY));
    const width = maxX - minX;
    const height = maxY - minY;
    if (!(width > 0) || !(height > 0)) return null;

    const maxCells = 250000;
    let step = 0.05 / factor;
    const estimatedCells = (width / step + 1) * (height / step + 1);
    if (estimatedCells > maxCells) step *= Math.sqrt(estimatedCells / maxCells);
    const columns = Math.ceil(width / step) + 1;
    const rows = Math.ceil(height / step) + 1;
    const size = columns * rows;
    const valid = new Uint8Array(size);
    const labels = new Int32Array(size);
    const zoneAtPoint = (point) => floorPolygons
      .filter(({ bounds }) => point.x >= bounds.minX && point.x <= bounds.maxX &&
        point.y >= bounds.minY && point.y <= bounds.maxY)
      .filter(({ points }) => pointInPolygon(point, points))
      .sort((a, b) => a.zone.areaM2 - b.zone.areaM2)[0]?.zone;

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < columns; x++) {
        const point = { x: minX + (x + 0.5) * step, y: minY + (y + 0.5) * step };
        if (zoneAtPoint(point) && !pointInAnyPolygon(point, wallShapes)) {
          valid[y * columns + x] = 1;
        }
      }
    }

    const barrierRadius = step * 0.8;
    for (const doorway of doorways) {
      const minDoorX = Math.min(doorway.a.x, doorway.b.x) - barrierRadius;
      const maxDoorX = Math.max(doorway.a.x, doorway.b.x) + barrierRadius;
      const minDoorY = Math.min(doorway.a.y, doorway.b.y) - barrierRadius;
      const maxDoorY = Math.max(doorway.a.y, doorway.b.y) + barrierRadius;
      const startX = Math.max(0, Math.floor((minDoorX - minX) / step));
      const endX = Math.min(columns - 1, Math.ceil((maxDoorX - minX) / step));
      const startY = Math.max(0, Math.floor((minDoorY - minY) / step));
      const endY = Math.min(rows - 1, Math.ceil((maxDoorY - minY) / step));
      for (let y = startY; y <= endY; y++) {
        for (let x = startX; x <= endX; x++) {
          const index = y * columns + x;
          if (!valid[index]) continue;
          const point = { x: minX + (x + 0.5) * step, y: minY + (y + 0.5) * step };
          if (distanceToSegment(point, doorway.a, doorway.b) <= barrierRadius) valid[index] = 0;
        }
      }
    }

    const queue = new Int32Array(size);
    const components = [];
    for (let start = 0; start < size; start++) {
      if (!valid[start] || labels[start]) continue;
      const id = components.length + 1;
      const cells = [];
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      labels[start] = id;
      while (head < tail) {
        const index = queue[head++];
        cells.push(index);
        const x = index % columns;
        const neighbors = [
          x > 0 ? index - 1 : -1,
          x + 1 < columns ? index + 1 : -1,
          index >= columns ? index - columns : -1,
          index + columns < size ? index + columns : -1,
        ];
        for (const neighbor of neighbors) {
          if (neighbor < 0 || !valid[neighbor] || labels[neighbor]) continue;
          labels[neighbor] = id;
          queue[tail++] = neighbor;
        }
      }
      components.push({ id, cells, zoneCounts: new Map() });
    }
    if (!components.length) return null;

    for (let index = 0; index < size; index++) {
      const id = labels[index];
      if (!id) continue;
      const point = {
        x: minX + (index % columns + 0.5) * step,
        y: minY + (Math.floor(index / columns) + 0.5) * step,
      };
      const zone = zoneAtPoint(point);
      if (zone) {
        const component = components[id - 1];
        component.zoneCounts.set(zone, (component.zoneCounts.get(zone) || 0) + 1);
      }
    }

    const componentAt = (point) => {
      const x = Math.floor((point.x - minX) / step);
      const y = Math.floor((point.y - minY) / step);
      const direct = x >= 0 && x < columns && y >= 0 && y < rows
        ? labels[y * columns + x]
        : 0;
      if (direct) return direct;
      const maxRadius = Math.ceil(0.75 / factor / step);
      for (let radius = 1; radius <= maxRadius; radius++) {
        let nearest = 0;
        let nearestDistance = Infinity;
        for (let offset = -radius; offset <= radius; offset++) {
          for (const [candidateX, candidateY] of [
            [x + offset, y - radius],
            [x + offset, y + radius],
            [x - radius, y + offset],
            [x + radius, y + offset],
          ]) {
            if (candidateX < 0 || candidateX >= columns || candidateY < 0 || candidateY >= rows) continue;
            const id = labels[candidateY * columns + candidateX];
            if (!id) continue;
            const distance = (candidateX - x) ** 2 + (candidateY - y) ** 2;
            if (distance < nearestDistance) {
              nearest = id;
              nearestDistance = distance;
            }
          }
        }
        if (nearest) return nearest;
      }
      return 0;
    };

    return components.map((component) => {
      const materialZone = [...component.zoneCounts]
        .sort((a, b) => b[1] - a[1])[0]?.[0];
      const geometry = { cells: component.cells, columns, rows, minX, minY, step };
      return {
        id: component.id,
        material: materialZone?.material || 'Wykończenie nieprzypisane',
        outlinePath: outlinePathForCells(component.cells, columns, minX, minY, step),
        roomGeometry: geometry,
        paths: [],
        componentAt,
      };
    });
  }

  function samplePath(entity, count = 9) {
    const segments = [];
    let total = 0;
    const segmentCount = entity.closed ? entity.points.length : entity.points.length - 1;
    for (let i = 0; i < segmentCount; i++) {
      const a = entity.points[i];
      const b = entity.points[(i + 1) % entity.points.length];
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length) {
        segments.push({ a, b, length });
        total += length;
      }
    }
    return Array.from({ length: count }, (_, index) => {
      let remaining = total * (index + 0.5) / count;
      for (const segment of segments) {
        if (remaining <= segment.length) {
          const fraction = remaining / segment.length;
          return {
            x: segment.a.x + (segment.b.x - segment.a.x) * fraction,
            y: segment.a.y + (segment.b.y - segment.a.y) * fraction,
          };
        }
        remaining -= segment.length;
      }
      return segments.at(-1)?.b || entity.points[0];
    });
  }

  function assignPathsToDoorRooms(rooms, paths) {
    for (const path of paths) {
      const votes = new Map();
      const componentAt = rooms[0].componentAt;
      for (const point of samplePath(path.entity)) {
        const id = componentAt(point);
        if (id) votes.set(id, (votes.get(id) || 0) + 1);
      }
      const room = rooms.find((item) => item.id === [...votes].sort((a, b) => b[1] - a[1])[0]?.[0]);
      if (room) room.paths.push(path);
    }
  }

  function clusterPaths(paths, tolerance) {
    const parents = paths.map((_, index) => index);
    const find = (index) => {
      if (parents[index] !== index) parents[index] = find(parents[index]);
      return parents[index];
    };
    const join = (first, second) => {
      const firstRoot = find(first);
      const secondRoot = find(second);
      if (firstRoot !== secondRoot) parents[secondRoot] = firstRoot;
    };
    const endpoints = paths.map((path) => [path.entity.points[0], path.entity.points.at(-1)]);
    for (let first = 0; first < paths.length; first++) {
      for (let second = first + 1; second < paths.length; second++) {
        const connected = endpoints[first].some((a) => endpoints[second].some((b) =>
          Math.hypot(a.x - b.x, a.y - b.y) <= tolerance
        ));
        if (connected) join(first, second);
      }
    }
    const groups = new Map();
    paths.forEach((path, index) => {
      const root = find(index);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(path);
    });
    return [...groups.values()].sort((a, b) => {
      const firstA = Math.min(...a.map((path) => Number(path.id.split('-').at(-1))));
      const firstB = Math.min(...b.map((path) => Number(path.id.split('-').at(-1))));
      return firstA - firstB;
    });
  }

  function buildCandidates(entities, hatches, wallPolygons, doorways, factor) {
    const measured = entities
      .filter((entity) => entity.skirting)
      .map((entity) => ({
        id: entity.id,
        entity,
        length: polylineLength(entity.points, entity.closed),
        excluded: new Set(),
        excludedSpans: new Map(),
        erasedSpans: new Map(),
      }));
    if (!measured.length) return [];

    let zones = floorZones(hatches, factor);
    const doorRooms = doorSeparatedRooms(zones, wallPolygons, doorways, factor);
    if (doorRooms) {
      const review = measured.filter((path) => normalizeText(path.entity.lineType).includes('duzy'));
      assignPathsToDoorRooms(doorRooms, measured.filter((path) => !review.includes(path)));
      const candidates = doorRooms
        .filter((room) => room.paths.length)
        .map((room, index) => ({
          id: `door-room-${room.id}`,
          name: `Propozycja ${index + 1}`,
          color: '',
          traceColor: proposalColors[index % proposalColors.length],
          material: room.material,
          floorZoneId: `door-room-${room.id}`,
          polygon: null,
          outlinePath: room.outlinePath,
          roomGeometry: room.roomGeometry,
          paths: room.paths,
        }));
      if (review.length) {
        candidates.push({
          id: 'room-review-zigzag-large',
          name: 'Do sprawdzenia — Zygzak duży',
          color: '',
          traceColor: proposalColors[candidates.length % proposalColors.length],
          material: 'Sprawdź przebieg',
          floorZoneId: null,
          polygon: null,
          paths: review,
        });
      }
      return candidates;
    }

    if (!zones.length) {
      zones = [{
        id: 'zone-all',
        name: 'Wszystkie oznaczenia Zigzag',
        pattern: '',
        material: 'Cały rysunek',
        polygon: null,
        areaM2: null,
        paths: [],
      }];
    }

    const unassigned = [];
    const review = [];
    for (const path of measured) {
      if (normalizeText(path.entity.lineType).includes('duzy')) {
        review.push(path);
        continue;
      }
      let zone = null;
      if (factor && zones.some((item) => item.polygon)) {
        const point = pathMidpoint(path.entity);
        const ranked = zones
          .filter((item) => item.polygon)
          .map((item) => ({ item, distance: distanceToPolygon(point, item.polygon) }))
          .sort((a, b) => a.distance - b.distance || (a.item.areaM2 || Infinity) - (b.item.areaM2 || Infinity));
        if (ranked[0]) zone = ranked[0].item;
      } else if (zones.length === 1) {
        zone = zones[0];
      }
      if (zone) zone.paths.push(path);
      else unassigned.push(path);
    }

    const tolerance = factor ? 0.2 / factor : 0;
    const roomGroups = [];
    let proposalIndex = 0;
    for (const zone of zones) {
      for (const paths of clusterPaths(zone.paths, tolerance)) {
        roomGroups.push({
          id: `room-${paths[0].id}`,
          name: `Propozycja ${++proposalIndex}`,
          color: '',
          traceColor: proposalColors[(proposalIndex - 1) % proposalColors.length],
          material: zone.material,
          floorZoneId: zone.id,
          polygon: zone.polygon,
          paths,
        });
      }
    }
    if (unassigned.length) {
      for (const paths of clusterPaths(unassigned, tolerance)) {
        roomGroups.push({
          id: `room-unassigned-${paths[0].id}`,
          name: `Nieprzypisane ${++proposalIndex}`,
          color: '',
          traceColor: proposalColors[(proposalIndex - 1) % proposalColors.length],
          material: 'Wykończenie nieprzypisane',
          floorZoneId: null,
          polygon: null,
          paths,
        });
      }
    }
    if (review.length) {
      roomGroups.push({
        id: 'room-review-zigzag-large',
        name: 'Do sprawdzenia — Zygzak duży',
        color: '',
        traceColor: proposalColors[proposalIndex % proposalColors.length],
        pattern: '',
        material: 'Sprawdź przebieg',
        floorZoneId: null,
        polygon: null,
        paths: review,
      });
    }
    return roomGroups;
  }

  function candidatesForCurrentFile() {
    return buildCandidates(state.entities, state.hatches, state.wallPolygons, state.doorways, state.factor)
      .map((candidate) => ({
        ...candidate,
        paths: candidate.paths.filter((path) => !state.removedPathIds.has(path.id)),
      }))
      .filter((candidate) => candidate.paths.length > 0);
  }

  function measureExtents(entities, candidates) {
    const extents = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    const include = (points) => {
      for (const point of points) {
        extents.minX = Math.min(extents.minX, point.x);
        extents.minY = Math.min(extents.minY, point.y);
        extents.maxX = Math.max(extents.maxX, point.x);
        extents.maxY = Math.max(extents.maxY, point.y);
      }
    };
    for (const entity of entities) include(entity.points);
    for (const candidate of candidates) if (candidate.polygon) include(candidate.polygon);
    return extents;
  }

  function svgPoint(point) {
    return `${point.x},${point.y}`;
  }

  function setViewBox() {
    if (!state.extents) return;
    const { minX, minY, maxX, maxY } = state.extents;
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    const pad = Math.max(width, height) * 0.035;
    const zoomFactor = state.zoomFactor || 1;
    const viewWidth = (width + 2 * pad) / zoomFactor;
    const viewHeight = (height + 2 * pad) / zoomFactor;
    const centerX = state.viewCenterX ?? (minX + maxX) / 2;
    const centerY = state.viewCenterY ?? (minY + maxY) / 2;
    ui.planSvg.setAttribute('viewBox', `${centerX - viewWidth / 2} ${-centerY - viewHeight / 2} ${viewWidth} ${viewHeight}`);
  }

  function pointOnLine(segment, fraction) {
    return {
      x: segment.a.x + (segment.b.x - segment.a.x) * fraction,
      y: segment.a.y + (segment.b.y - segment.a.y) * fraction,
    };
  }

  function mergeIntervals(intervals) {
    const sorted = intervals
      .map(([start, end]) => [Math.max(0, Math.min(start, end)), Math.min(1, Math.max(start, end))])
      .filter(([start, end]) => end - start > 0.0001)
      .sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const interval of sorted) {
      const last = merged.at(-1);
      if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
      else merged.push(interval);
    }
    return merged;
  }

  function fractionOnSegment(point, segment) {
    const dx = segment.b.x - segment.a.x;
    const dy = segment.b.y - segment.a.y;
    const lengthSquared = dx * dx + dy * dy;
    if (!lengthSquared) return 0;
    return Math.max(0, Math.min(1, ((point.x - segment.a.x) * dx + (point.y - segment.a.y) * dy) / lengthSquared));
  }

  function positionOnPath(path, point) {
    let pathPosition = 0;
    let nearest = null;
    for (const segment of getPathSegments(path)) {
      const length = Math.hypot(segment.b.x - segment.a.x, segment.b.y - segment.a.y);
      const fraction = fractionOnSegment(point, segment);
      const projected = pointOnLine(segment, fraction);
      const distance = Math.hypot(point.x - projected.x, point.y - projected.y);
      if (!nearest || distance < nearest.distance) {
        nearest = { distance, position: pathPosition + length * fraction };
      }
      pathPosition += length;
    }
    return nearest;
  }

  function nearestPathPoint(candidate, point) {
    let nearest = null;
    for (const path of candidate.paths) {
      const position = positionOnPath(path, point);
      if (position && (!nearest || position.distance < nearest.distance)) {
        nearest = { ...position, path };
      }
    }
    return nearest;
  }

  function eraserClickTolerance() {
    const rect = ui.planSvg.getBoundingClientRect();
    const viewBox = ui.planSvg.viewBox.baseVal;
    return Math.max(viewBox.width / rect.width, viewBox.height / rect.height) * 14;
  }

  function erasePathRange(path, startPosition, endPosition) {
    const segments = getPathSegments(path);
    const totalLength = segments.reduce((sum, segment) =>
      sum + Math.hypot(segment.b.x - segment.a.x, segment.b.y - segment.a.y), 0);
    if (!totalLength) return 0;

    let ranges;
    if (path.entity.closed) {
      const forwardLength = (endPosition - startPosition + totalLength) % totalLength;
      const rangeStart = forwardLength <= totalLength / 2 ? startPosition : endPosition;
      const rangeLength = Math.min(forwardLength, totalLength - forwardLength);
      const rangeEnd = rangeStart + rangeLength;
      ranges = rangeEnd <= totalLength
        ? [[rangeStart, rangeEnd]]
        : [[rangeStart, totalLength], [0, rangeEnd - totalLength]];
    } else {
      ranges = [[Math.min(startPosition, endPosition), Math.max(startPosition, endPosition)]];
    }

    const requestedLength = ranges.reduce((sum, [start, end]) => sum + end - start, 0);
    if (requestedLength <= totalLength * 0.0001) return 0;

    let segmentStart = 0;
    for (const segment of segments) {
      const segmentLength = Math.hypot(segment.b.x - segment.a.x, segment.b.y - segment.a.y);
      const segmentEnd = segmentStart + segmentLength;
      for (const [rangeStart, rangeEnd] of ranges) {
        const overlapStart = Math.max(segmentStart, rangeStart);
        const overlapEnd = Math.min(segmentEnd, rangeEnd);
        if (overlapEnd - overlapStart <= 0) continue;
        const intervals = path.erasedSpans.get(segment.index) || [];
        path.erasedSpans.set(segment.index, mergeIntervals([
          ...intervals,
          [
            (overlapStart - segmentStart) / segmentLength,
            (overlapEnd - segmentStart) / segmentLength,
          ],
        ]));
      }
      segmentStart = segmentEnd;
    }
    return requestedLength;
  }

  function finishPathErasing(point) {
    const drawing = state.eraserDrawing;
    const candidate = state.candidates.find((item) => item.id === drawing?.candidateId);
    const path = candidate?.paths.find((item) => item.id === drawing?.pathId);
    if (!path || drawing.startPosition === null) return false;
    const end = positionOnPath(path, point);
    if (!end || end.distance > eraserClickTolerance()) {
      showToast('Drugi punkt musi leżeć na tej samej linii co pierwszy.');
      return false;
    }
    const before = pathIncludedLength(path);
    const requestedLength = erasePathRange(path, drawing.startPosition, end.position);
    const removedLength = before - pathIncludedLength(path);
    if (requestedLength <= 0) {
      showToast('Wskaż dwa różne punkty na linii.');
      return false;
    }

    state.eraserDrawing = null;
    ui.planSvg.classList.remove('erasing-path');
    renderPlan();
    updateResults();
    renderCandidates();
    showToast(removedLength > 0
      ? `Pominięto ${(removedLength * state.factor).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} m listwy.`
      : 'Ten fragment listwy był już pominięty.');
    return true;
  }

  function renderPlan() {
    if (!state.entities.length) return;
    const frag = document.createDocumentFragment();
    const cadGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    cadGroup.setAttribute('class', 'cad-geometry');
    for (const entity of state.entities) {
      const shape = document.createElementNS('http://www.w3.org/2000/svg', entity.closed ? 'polygon' : 'polyline');
      shape.setAttribute('points', entity.points.map(svgPoint).join(' '));
      shape.setAttribute('class', 'plan-base');
      if (entity.layer.toLowerCase().includes('rysunki') || entity.layer.toLowerCase().includes('obrazki')) shape.classList.add('soft');
      cadGroup.append(shape);
    }
    frag.append(cadGroup);

    const zoneGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    zoneGroup.setAttribute('class', 'floor-zones');
    const renderedZones = new Set();
    for (const candidate of state.candidates) {
      if ((!candidate.polygon && !candidate.outlinePath) || renderedZones.has(candidate.floorZoneId)) continue;
      renderedZones.add(candidate.floorZoneId);
      const outline = document.createElementNS(
        'http://www.w3.org/2000/svg',
        candidate.outlinePath ? 'path' : 'polygon',
      );
      if (candidate.outlinePath) outline.setAttribute('d', candidate.outlinePath);
      else outline.setAttribute('points', candidate.polygon.map(svgPoint).join(' '));
      outline.setAttribute('class', 'zone-outline');
      if (candidate.outlinePath) outline.style.stroke = candidate.traceColor;
      zoneGroup.append(outline);
    }
    frag.append(zoneGroup);

    const selectedGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    selectedGroup.setAttribute('class', 'selected-skirt-overlays');
    for (const candidate of state.candidates) {
      if (!state.selected.has(candidate.id)) continue;
      for (const segment of candidateSegments(candidate)) {
        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.setAttribute('data-candidate-id', candidate.id);
        group.setAttribute('data-path-id', segment.pathId);
        group.setAttribute('data-segment-index', String(segment.index));
        const isExcluded = segment.path.excluded.has(segment.index);
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', segment.a.x);
        line.setAttribute('y1', segment.a.y);
        line.setAttribute('x2', segment.b.x);
        line.setAttribute('y2', segment.b.y);
        line.setAttribute('class', `room-edge ${isExcluded ? 'excluded' : 'included'}`);
        if (!isExcluded) line.style.stroke = candidate.traceColor;
        group.append(line);
        if (!isExcluded) {
          for (const [start, end] of segment.path.excludedSpans.get(segment.index) || []) {
            const span = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            const a = pointOnLine(segment, start);
            const b = pointOnLine(segment, end);
            span.setAttribute('x1', a.x);
            span.setAttribute('y1', a.y);
            span.setAttribute('x2', b.x);
            span.setAttribute('y2', b.y);
            span.setAttribute('class', 'room-edge excluded');
            group.append(span);
          }
        }
        const hit = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        hit.setAttribute('x1', segment.a.x);
        hit.setAttribute('y1', segment.a.y);
        hit.setAttribute('x2', segment.b.x);
        hit.setAttribute('y2', segment.b.y);
        hit.setAttribute('class', 'room-edge-hit');
        group.append(hit);
        selectedGroup.append(group);
      }
    }
    frag.append(selectedGroup);
    const erasedGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    erasedGroup.setAttribute('class', 'erased-skirt-spans');
    for (const candidate of state.candidates) {
      for (const path of candidate.paths) {
        for (const [segmentIndex, intervals] of path.erasedSpans) {
          const segment = getPathSegments(path).find((item) => item.index === segmentIndex);
          if (!segment) continue;
          for (const [start, end] of intervals) {
            const erased = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            const a = pointOnLine(segment, start);
            const b = pointOnLine(segment, end);
            erased.setAttribute('x1', a.x);
            erased.setAttribute('y1', a.y);
            erased.setAttribute('x2', b.x);
            erased.setAttribute('y2', b.y);
            erased.setAttribute('class', 'room-edge-erased');
            erasedGroup.append(erased);
          }
        }
      }
    }
    frag.append(erasedGroup);
    if (state.dividerDrawing?.start && state.dividerDrawing?.end) {
      const divider = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      divider.setAttribute('x1', state.dividerDrawing.start.x);
      divider.setAttribute('y1', state.dividerDrawing.start.y);
      divider.setAttribute('x2', state.dividerDrawing.end.x);
      divider.setAttribute('y2', state.dividerDrawing.end.y);
      divider.setAttribute('class', 'zone-divider-preview');
      frag.append(divider);
    }
    if (state.eraserDrawing?.start && state.eraserDrawing?.end) {
      const eraserLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      eraserLine.setAttribute('x1', state.eraserDrawing.start.x);
      eraserLine.setAttribute('y1', state.eraserDrawing.start.y);
      eraserLine.setAttribute('x2', state.eraserDrawing.end.x);
      eraserLine.setAttribute('y2', state.eraserDrawing.end.y);
      eraserLine.setAttribute('class', 'zone-eraser-preview');
      frag.append(eraserLine);
    }
    ui.planGroup.replaceChildren(frag);
    setViewBox();
  }

  function pathIncludedLength(path) {
    let excluded = 0;
    for (const segment of getPathSegments(path)) {
      const length = Math.hypot(segment.b.x - segment.a.x, segment.b.y - segment.a.y);
      if (path.excluded.has(segment.index)) {
        excluded += length;
      } else {
        const excludedFraction = mergeIntervals([
          ...(path.excludedSpans.get(segment.index) || []),
          ...(path.erasedSpans.get(segment.index) || []),
        ])
          .reduce((sum, [start, end]) => sum + end - start, 0);
        excluded += length * excludedFraction;
      }
    }
    return Math.max(0, path.length - excluded);
  }

  function selectedRoomRows() {
    const totals = new Map();
    for (const candidate of state.candidates) {
      if (!state.selected.has(candidate.id)) continue;
      const length = candidate.paths.reduce((sum, path) => sum + pathIncludedLength(path), 0) * (state.factor || 0);
      candidate.calculatedLength = length;
      const name = candidate.name.trim() || 'Pokój';
      const color = candidate.color.trim();
      const key = `${normalizeText(name)}\u0000${normalizeText(color)}`;
      const row = totals.get(key);
      if (row) row.length += length;
      else totals.set(key, { name, color, length });
    }
    return [...totals.values()];
  }

  function updateResults() {
    const rows = selectedRoomRows();
    const total = rows.reduce((sum, row) => sum + row.length, 0);
    ui.totalLength.textContent = total.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    ui.exportButton.disabled = rows.length === 0 || !state.factor;
    ui.resultsBody.replaceChildren();
    if (!rows.length) {
      const tr = document.createElement('tr');
      tr.className = 'empty-result';
      const message = state.entities.some((entity) => entity.skirting)
        ? 'Brak stref w zestawieniu'
        : 'Nie znaleziono oznaczeń Zigzag do zestawienia';
      tr.innerHTML = `<td colspan="3">${message}</td>`;
      ui.resultsBody.append(tr);
      return;
    }
    for (const row of rows) {
      const tr = document.createElement('tr');
      const room = document.createElement('td');
      room.textContent = row.name;
      const color = document.createElement('td');
      color.textContent = row.color || '—';
      const value = document.createElement('td');
      value.textContent = state.factor
        ? `${row.length.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} m`
        : '—';
      tr.append(room, color, value);
      ui.resultsBody.append(tr);
    }
  }

  function renderCandidates() {
    ui.candidateList.replaceChildren();
    if (!state.candidates.length) {
      const empty = document.createElement('div');
      empty.className = 'list-placeholder';
      empty.textContent = state.entities.some((entity) => entity.skirting)
        ? 'Wszystkie propozycje usunięto z zestawienia. Wczytaj plik ponownie, aby je przywrócić.'
        : 'Nie znaleziono obiektów z typem linii Zigzag/Zygzak. Zaimportuj DXF, który zachowuje oznaczenia przebiegu listew.';
      ui.candidateList.append(empty);
      ui.candidateHint.textContent = state.entities.some((entity) => entity.skirting)
        ? 'Brak propozycji pokoi'
        : 'Brak oznaczeń listew w tym pliku';
      return;
    }
    const pathCount = state.candidates.reduce((sum, candidate) => sum + candidate.paths.length, 0);
    ui.candidateHint.textContent = `${state.candidates.length} propozycji · ${pathCount} oznaczeń`;
    for (const candidate of state.candidates) {
      const item = document.createElement('div');
      item.className = `candidate-item${state.selected.has(candidate.id) ? ' active' : ''}`;
      item.style.setProperty('--proposal-color', candidate.traceColor);
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = state.selected.has(candidate.id);
      checkbox.setAttribute('aria-label', `Uwzględnij ${candidate.name}`);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) state.selected.add(candidate.id);
        else {
          state.selected.delete(candidate.id);
          if (state.dividerDrawing?.candidateId === candidate.id) cancelRoomDivision(false);
          if (state.eraserDrawing?.candidateId === candidate.id) cancelPathErasing(false);
        }
        renderPlan();
        updateResults();
        renderCandidates();
      });
      const label = document.createElement('span');
      label.className = 'candidate-label';
      const name = document.createElement('input');
      name.value = candidate.name;
      name.setAttribute('aria-label', 'Nazwa pokoju lub grupy');
      name.addEventListener('click', (event) => event.stopPropagation());
      name.addEventListener('input', () => {
        candidate.name = name.value.trim() || 'Pokój';
        updateResults();
      });
      const meta = document.createElement('small');
      meta.textContent = `${candidate.material} · ${candidate.paths.length} oznaczeń`;
      label.append(name, meta);
      const color = document.createElement('select');
      color.className = 'candidate-color';
      color.setAttribute('aria-label', `Kolor listwy dla ${candidate.name}`);
      const emptyColor = document.createElement('option');
      emptyColor.value = '';
      emptyColor.textContent = 'Wybierz kolor';
      color.append(emptyColor);
      for (const skirtingColor of skirtingColors) {
        const option = document.createElement('option');
        option.value = skirtingColor;
        option.textContent = skirtingColor;
        color.append(option);
      }
      color.value = candidate.color;
      color.addEventListener('click', (event) => event.stopPropagation());
      color.addEventListener('change', () => {
        candidate.color = color.value;
        updateResults();
      });
      const roomSplit = document.createElement('button');
      roomSplit.type = 'button';
      roomSplit.className = 'candidate-room-split';
      roomSplit.textContent = '✂';
      roomSplit.title = candidate.roomGeometry
        ? 'Podziel strefę linią poprowadzoną od krawędzi do krawędzi'
        : 'Podział dostępny dla stref wykrytych na podstawie ścian i drzwi';
      roomSplit.setAttribute('aria-label', `Podziel strefę ${candidate.name}`);
      roomSplit.disabled = !candidate.roomGeometry || candidate.paths.length < 2;
      roomSplit.classList.toggle('active', state.dividerDrawing?.candidateId === candidate.id);
      roomSplit.addEventListener('click', (event) => {
        event.stopPropagation();
        startRoomDivision(candidate.id);
      });
      const eraser = document.createElement('button');
      eraser.type = 'button';
      eraser.className = 'candidate-eraser';
      eraser.textContent = '⌫';
      eraser.title = 'Usuń fragment listwy między dwoma punktami na tej samej linii';
      eraser.setAttribute('aria-label', `Gumka dla ${candidate.name}`);
      eraser.disabled = !state.selected.has(candidate.id);
      eraser.classList.toggle('active', state.eraserDrawing?.candidateId === candidate.id);
      eraser.addEventListener('click', (event) => {
        event.stopPropagation();
        startPathErasing(candidate.id);
      });
      const length = document.createElement('span');
      length.className = 'candidate-length';
      const initialLength = candidate.paths.reduce((sum, path) => sum + path.length, 0) * (state.factor || 0);
      length.textContent = `${(candidate.calculatedLength ?? initialLength).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} m`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'candidate-remove';
      remove.textContent = '×';
      remove.title = 'Usuń propozycję z zestawienia';
      remove.setAttribute('aria-label', 'Usuń propozycję z zestawienia');
      remove.addEventListener('click', (event) => {
        event.stopPropagation();
        removeCandidate(candidate.id);
      });
      item.append(checkbox, label, color, length, roomSplit, eraser, remove);
      ui.candidateList.append(item);
    }
  }

  function startRoomDivision(candidateId) {
    if (state.dividerDrawing?.candidateId === candidateId) {
      cancelRoomDivision(true);
      return;
    }
    if (state.eraserDrawing) cancelPathErasing(false);
    state.dividerDrawing = { candidateId, start: null, end: null };
    ui.planSvg.classList.add('dividing-zone');
    renderCandidates();
    showToast('Kliknij dwa punkty po obu stronach przejścia, aby czerwona linia je przecięła. Esc anuluje.');
  }

  function cancelRoomDivision(notify) {
    state.dividerDrawing = null;
    ui.planSvg.classList.remove('dividing-zone');
    renderCandidates();
    renderPlan();
    if (notify) showToast('Anulowano podział strefy.');
  }

  function startPathErasing(candidateId) {
    if (state.eraserDrawing?.candidateId === candidateId) {
      cancelPathErasing(true);
      return;
    }
    if (state.dividerDrawing) cancelRoomDivision(false);
    state.eraserDrawing = {
      candidateId,
      start: null,
      end: null,
      pathId: null,
      startPosition: null,
    };
    ui.planSvg.classList.add('erasing-path');
    renderCandidates();
    showToast('Kliknij dwa punkty na tej samej linii. Gumka usunie fragment pomiędzy nimi; Esc anuluje.');
  }

  function cancelPathErasing(notify) {
    state.eraserDrawing = null;
    ui.planSvg.classList.remove('erasing-path');
    renderCandidates();
    renderPlan();
    if (notify) showToast('Anulowano gumkę.');
  }

  function partitionRoomCells(geometry, start, end) {
    const { cells, columns, rows, minX, minY, step } = geometry;
    const cellSet = new Set(cells);
    const blocked = new Set();
    const size = columns * rows;
    const labels = new Int32Array(size);
    const barrierWidth = step * 0.8;
    const lineLength = Math.hypot(end.x - start.x, end.y - start.y);
    const extension = step * 2;
    const barrierStart = {
      x: start.x - (end.x - start.x) / lineLength * extension,
      y: start.y - (end.y - start.y) / lineLength * extension,
    };
    const barrierEnd = {
      x: end.x + (end.x - start.x) / lineLength * extension,
      y: end.y + (end.y - start.y) / lineLength * extension,
    };
    for (const cell of cells) {
      const x = cell % columns;
      const y = Math.floor(cell / columns);
      const center = { x: minX + (x + 0.5) * step, y: minY + (y + 0.5) * step };
      if (distanceToSegment(center, barrierStart, barrierEnd) <= barrierWidth) blocked.add(cell);
    }

    const queue = new Int32Array(cells.length);
    const components = [];
    for (const first of cells) {
      if (blocked.has(first) || labels[first]) continue;
      const id = components.length + 1;
      const componentCells = [];
      let head = 0;
      let tail = 0;
      queue[tail++] = first;
      labels[first] = id;
      while (head < tail) {
        const cell = queue[head++];
        componentCells.push(cell);
        const x = cell % columns;
        const neighbors = [
          x > 0 ? cell - 1 : -1,
          x + 1 < columns ? cell + 1 : -1,
          cell >= columns ? cell - columns : -1,
          cell + columns < size ? cell + columns : -1,
        ];
        for (const neighbor of neighbors) {
          if (neighbor < 0 || !cellSet.has(neighbor) || blocked.has(neighbor) || labels[neighbor]) continue;
          labels[neighbor] = id;
          queue[tail++] = neighbor;
        }
      }
      components.push({ id, cells: componentCells });
    }
    if (components.length < 2) return null;

    components.sort((a, b) => b.cells.length - a.cells.length);
    const groups = components.slice(0, 2);
    const centroid = (group) => group.cells.reduce((sum, cell) => ({
      x: sum.x + cell % columns,
      y: sum.y + Math.floor(cell / columns),
    }), { x: 0, y: 0 });
    const centers = groups.map((group) => {
      const point = centroid(group);
      return { x: point.x / group.cells.length, y: point.y / group.cells.length };
    });
    for (const extra of components.slice(2)) {
      const point = centroid(extra);
      const center = { x: point.x / extra.cells.length, y: point.y / extra.cells.length };
      const firstDistance = Math.hypot(center.x - centers[0].x, center.y - centers[0].y);
      const secondDistance = Math.hypot(center.x - centers[1].x, center.y - centers[1].y);
      const groupIndex = firstDistance <= secondDistance ? 0 : 1;
      groups[groupIndex].cells.push(...extra.cells);
      const updated = centroid(groups[groupIndex]);
      centers[groupIndex] = {
        x: updated.x / groups[groupIndex].cells.length,
        y: updated.y / groups[groupIndex].cells.length,
      };
    }

    labels.fill(0);
    groups.forEach((group, index) => {
      group.id = index + 1;
      for (const cell of group.cells) labels[cell] = group.id;
    });
    const maxRadius = Math.ceil(0.75 / state.factor / step);
    const componentAt = (point) => {
      const x = Math.floor((point.x - minX) / step);
      const y = Math.floor((point.y - minY) / step);
      if (x >= 0 && x < columns && y >= 0 && y < rows) {
        const direct = labels[y * columns + x];
        if (direct) return direct;
      }
      for (let radius = 1; radius <= maxRadius; radius++) {
        let nearest = 0;
        let nearestDistance = Infinity;
        for (let offset = -radius; offset <= radius; offset++) {
          for (const [candidateX, candidateY] of [
            [x + offset, y - radius],
            [x + offset, y + radius],
            [x - radius, y + offset],
            [x + radius, y + offset],
          ]) {
            if (candidateX < 0 || candidateX >= columns || candidateY < 0 || candidateY >= rows) continue;
            const id = labels[candidateY * columns + candidateX];
            if (!id) continue;
            const distance = (candidateX - x) ** 2 + (candidateY - y) ** 2;
            if (distance < nearestDistance) {
              nearest = id;
              nearestDistance = distance;
            }
          }
        }
        if (nearest) return nearest;
      }
      return 0;
    };
    return { groups, componentAt };
  }

  function finishRoomDivision(start, end) {
    const candidateIndex = state.candidates.findIndex((item) => item.id === state.dividerDrawing?.candidateId);
    const candidate = state.candidates[candidateIndex];
    if (!candidate?.roomGeometry) return false;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    if (Math.hypot(dx, dy) < candidate.roomGeometry.step * 2) {
      showToast('Wskaż dwa wyraźnie różne punkty linii podziału.');
      return false;
    }
    const partition = partitionRoomCells(candidate.roomGeometry, start, end);
    if (!partition) {
      showToast('Linia nie rozdziela strefy. Poprowadź ją przez przejście, od jednej krawędzi do przeciwległej.');
      return false;
    }
    const pathGroups = [[], []];
    for (const path of candidate.paths) {
      const samples = samplePath(path.entity);
      const votes = new Map();
      for (const point of samples) {
        const id = partition.componentAt(point);
        if (id) votes.set(id, (votes.get(id) || 0) + 1);
      }
      const groupId = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (groupId) {
        pathGroups[groupId - 1].push(path);
      } else {
        const midpoint = pathMidpoint(path.entity);
        let nearestGroup = null;
        let nearestDistance = Infinity;
        for (const group of partition.groups) {
          for (const cell of group.cells) {
            const x = cell % candidate.roomGeometry.columns;
            const y = Math.floor(cell / candidate.roomGeometry.columns);
            const distance = Math.hypot(
              midpoint.x - (candidate.roomGeometry.minX + (x + 0.5) * candidate.roomGeometry.step),
              midpoint.y - (candidate.roomGeometry.minY + (y + 0.5) * candidate.roomGeometry.step),
            );
            if (distance < nearestDistance) {
              nearestGroup = group;
              nearestDistance = distance;
            }
          }
        }
        if (nearestGroup) pathGroups[nearestGroup.id - 1].push(path);
      }
    }
    if (pathGroups.some((group) => !group.length)) {
      showToast('Linia rozdzieliła obrys, ale nie przebiegi listew na dwie grupy. Spróbuj poprowadzić ją inaczej.');
      return false;
    }

    const wasSelected = state.selected.has(candidate.id);
    const parts = pathGroups.map((paths, index) => {
      const roomGeometry = { ...candidate.roomGeometry, cells: partition.groups[index].cells };
      const suffix = index === 0 ? 'A' : 'B';
      const id = `${candidate.id}-${suffix.toLowerCase()}`;
      return {
        ...candidate,
        id,
        name: `${candidate.name} — ${suffix}`,
        color: '',
        traceColor: proposalColors[(state.candidates.length + index) % proposalColors.length],
        floorZoneId: id,
        outlinePath: outlinePathForCells(
          roomGeometry.cells,
          roomGeometry.columns,
          roomGeometry.minX,
          roomGeometry.minY,
          roomGeometry.step,
        ),
        roomGeometry,
        paths,
      };
    });
    state.candidates.splice(candidateIndex, 1, ...parts);
    state.selected.delete(candidate.id);
    if (wasSelected) for (const part of parts) state.selected.add(part.id);
    state.dividerDrawing = null;
    ui.planSvg.classList.remove('dividing-zone');
    renderPlan();
    updateResults();
    renderCandidates();
    updateParseNote();
    showToast(`Strefę podzielono na „${parts[0].name}” i „${parts[1].name}”.`);
    return true;
  }

  function removeCandidate(candidateId) {
    const candidate = state.candidates.find((item) => item.id === candidateId);
    if (!candidate) return;
    if (state.dividerDrawing?.candidateId === candidateId) cancelRoomDivision(false);
    if (state.eraserDrawing?.candidateId === candidateId) cancelPathErasing(false);
    for (const path of candidate.paths) state.removedPathIds.add(path.id);
    state.selected.delete(candidateId);
    state.candidates = state.candidates.filter((item) => item.id !== candidateId);
    state.extents = measureExtents(state.entities, state.candidates);
    renderCandidates();
    renderPlan();
    updateResults();
    showToast(`Usunięto „${candidate.name}” z zestawienia.`);
  }

  function updateUnit() {
    if (state.dividerDrawing) cancelRoomDivision(false);
    if (state.eraserDrawing) cancelPathErasing(false);
    state.units = Number(ui.unitSelect.value);
    state.factor = unitToMeters[state.units];
    state.unitNeedsConfirmation = false;
    if (state.entities.length) {
      state.candidates = candidatesForCurrentFile();
      state.selected = new Set(state.candidates.map((candidate) => candidate.id));
      state.extents = measureExtents(state.entities, state.candidates);
      renderCandidates();
      renderPlan();
      updateResults();
      updateParseNote();
    }
  }

  function updateParseNote() {
    ui.parseNote.hidden = false;
    ui.parseNote.classList.toggle('warning', !state.factor || state.unitNeedsConfirmation);
    const count = state.entities.filter((entity) => entity.skirting).length;
    if (!state.factor) {
      ui.parseNote.textContent = 'Rysunek nie określa jednostek. Wybierz jednostkę, aby przeliczyć długość oznaczeń.';
      return;
    }
    if (state.unitNeedsConfirmation) {
      ui.parseNote.textContent = 'Nie rozpoznano jednostki metrycznej. Przyjęto milimetry — sprawdź jednostkę rysunku i wybierz właściwą z listy.';
      return;
    }
    const total = state.entities
      .filter((entity) => entity.skirting)
      .reduce((sum, entity) => sum + polylineLength(entity.points, entity.closed), 0) * state.factor;
    const doorRoomCount = state.candidates.filter((candidate) => candidate.outlinePath).length;
    ui.parseNote.textContent = count
      ? `Wykryto ${count} przebiegów Zigzag/Zygzak (${total.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} m). ${doorRoomCount ? `Na podstawie ${state.doorways.length} drzwi utworzono propozycje stref: ${doorRoomCount}.` : 'Nie udało się odczytać podziału drzwiowego; propozycje oparto na połączeniach odcinków.'}`
      : 'Nie wykryto przebiegów Zigzag/Zygzak. Sprawdź, czy DXF zachował typy linii.';
  }

  function clearDrawing() {
    state.fileName = '';
    state.entities = [];
    state.hatches = [];
    state.wallPolygons = [];
    state.doorways = [];
    state.candidates = [];
    state.selected.clear();
    state.removedPathIds.clear();
    state.edgeDrag = null;
    state.panDrag = null;
    state.dividerDrawing = null;
    state.eraserDrawing = null;
    state.extents = null;
    state.viewCenterX = null;
    state.viewCenterY = null;
    ui.planSvg.classList.remove('panning');
    ui.planSvg.classList.remove('dividing-zone');
    ui.planSvg.classList.remove('erasing-path');
    ui.emptyState.hidden = false;
    ui.planSvg.setAttribute('hidden', '');
    ui.planGroup.replaceChildren();
    ui.fileCard.hidden = true;
    ui.unitRow.hidden = true;
    ui.parseNote.hidden = true;
    ui.fileName.textContent = '—';
    ui.fileDetails.textContent = '—';
    ui.candidateHint.textContent = 'Propozycje stref według ścian i drzwi';
    ui.candidateList.innerHTML = '<div class="list-placeholder">Po wczytaniu DXF zaproponujemy strefy na podstawie ścian i drzwi. Przestrzenie bez drzwi pozostaną połączone.</div>';
    ui.drawingStatus.textContent = 'Wczytaj plik DXF, aby rozpocząć';
    updateResults();
  }

  async function decodeFile(file) {
    const buffer = await file.arrayBuffer();
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      return new TextDecoder('windows-1250').decode(buffer);
    }
  }

  async function loadFile(file) {
    if (!file || !file.name.toLowerCase().endsWith('.dxf')) {
      showToast('Wybierz plik DXF. Inne formaty nie są jeszcze obsługiwane.');
      return;
    }
    state.dividerDrawing = null;
    state.eraserDrawing = null;
    ui.planSvg.classList.remove('dividing-zone');
    ui.planSvg.classList.remove('erasing-path');
    ui.drawingStatus.textContent = 'Odczytywanie oznaczeń i stref…';
    try {
      const content = await decodeFile(file);
      const parsed = parseDxf(content);
      state.fileName = file.name;
      state.entities = parsed.entities;
      state.hatches = parsed.hatches;
      state.wallPolygons = parsed.wallPolygons;
      state.doorways = parsed.doorways;
      state.removedPathIds.clear();
      state.unitNeedsConfirmation = ![4, 5, 6].includes(parsed.units);
      state.units = state.unitNeedsConfirmation ? 4 : parsed.units;
      state.factor = unitToMeters[state.units];
      state.candidates = candidatesForCurrentFile();
      state.selected = new Set(state.candidates.map((candidate) => candidate.id));
      state.extents = measureExtents(state.entities, state.candidates);
      state.zoomFactor = 1;
      state.viewCenterX = (state.extents.minX + state.extents.maxX) / 2;
      state.viewCenterY = (state.extents.minY + state.extents.maxY) / 2;
      ui.unitSelect.value = String(state.units);
      ui.emptyState.hidden = true;
      ui.planSvg.removeAttribute('hidden');
      ui.fileCard.hidden = false;
      ui.unitRow.hidden = false;
      ui.fileName.textContent = file.name;
      ui.fileDetails.textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB · ${parsed.entityCount.toLocaleString('pl-PL')} elementów`;
      ui.drawingStatus.textContent = state.candidates.length
        ? 'Kolory na rzucie oznaczają propozycje grup; kliknij lub przeciągnij odcinek, aby go pominąć'
        : 'Nie znaleziono oznaczeń Zigzag/Zygzak w tym rysunku';
      updateParseNote();
      renderCandidates();
      renderPlan();
      updateResults();
    } catch (error) {
      clearDrawing();
      ui.drawingStatus.textContent = 'Nie udało się odczytać pliku';
      showToast(error instanceof Error ? error.message : 'Nieznany błąd podczas odczytu DXF.');
    }
  }

  function getWorldPoint(event) {
    const matrix = ui.planGroup.getScreenCTM();
    if (!matrix) return null;
    const point = ui.planSvg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const local = point.matrixTransform(matrix.inverse());
    return { x: local.x, y: local.y };
  }

  function getCandidateSegment(candidate, pathId, segmentIndex) {
    return candidateSegments(candidate).find((segment) =>
      segment.pathId === pathId && segment.index === segmentIndex
    );
  }

  ui.fileInput.addEventListener('change', (event) => {
    const file = event.target.files[0];
    event.target.value = '';
    loadFile(file);
  });
  $('#replaceFileButton').addEventListener('click', () => ui.fileInput.click());
  ui.unitSelect.addEventListener('change', updateUnit);
  ui.dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    ui.dropZone.classList.add('drag-over');
  });
  ui.dropZone.addEventListener('dragleave', (event) => {
    if (!ui.dropZone.contains(event.relatedTarget)) ui.dropZone.classList.remove('drag-over');
  });
  ui.dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    ui.dropZone.classList.remove('drag-over');
    loadFile(event.dataTransfer.files[0]);
  });
  ui.planSvg.addEventListener('pointerdown', (event) => {
    if (state.eraserDrawing) {
      const point = getWorldPoint(event);
      if (!point) return;
      event.preventDefault();
      ui.planSvg.setPointerCapture(event.pointerId);
      const drawing = state.eraserDrawing;
      if (!drawing.start) {
        const candidate = state.candidates.find((item) => item.id === drawing.candidateId);
        const nearest = candidate && nearestPathPoint(candidate, point);
        if (!nearest || nearest.distance > eraserClickTolerance()) {
          showToast('Kliknij pierwszy punkt na linii listwy.');
          return;
        }
        drawing.pathId = nearest.path.id;
        drawing.startPosition = nearest.position;
        drawing.start = point;
        drawing.end = point;
        renderPlan();
        showToast('Kliknij drugi punkt na tej samej linii.');
        return;
      }
      if (!finishPathErasing(point)) {
        drawing.start = null;
        drawing.end = null;
        drawing.pathId = null;
        drawing.startPosition = null;
        renderPlan();
      }
      return;
    }
    if (state.dividerDrawing) {
      const point = getWorldPoint(event);
      if (!point) return;
      event.preventDefault();
      ui.planSvg.setPointerCapture(event.pointerId);
      if (!state.dividerDrawing.start) {
        state.dividerDrawing.start = point;
        state.dividerDrawing.end = point;
        renderPlan();
        showToast('Kliknij drugi punkt linii podziału.');
        return;
      }
      const start = state.dividerDrawing.start;
      if (!finishRoomDivision(start, point)) {
        state.dividerDrawing.start = null;
        state.dividerDrawing.end = null;
        renderPlan();
      }
      return;
    }
    const hit = event.target.closest('.room-edge-hit');
    if (hit) {
      const point = getWorldPoint(event);
      if (!point) return;
      state.edgeDrag = {
        candidateId: hit.parentElement.dataset.candidateId,
        pathId: hit.parentElement.dataset.pathId,
        segmentIndex: Number(hit.parentElement.dataset.segmentIndex),
        point,
        clientX: event.clientX,
        clientY: event.clientY,
      };
    } else {
      const rect = ui.planSvg.getBoundingClientRect();
      const viewBox = ui.planSvg.viewBox.baseVal;
      state.panDrag = {
        clientX: event.clientX,
        clientY: event.clientY,
        startCenterX: state.viewCenterX,
        startCenterY: state.viewCenterY,
        unitsPerPixelX: viewBox.width / rect.width,
        unitsPerPixelY: viewBox.height / rect.height,
      };
      ui.planSvg.classList.add('panning');
    }
    ui.planSvg.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  ui.planSvg.addEventListener('pointermove', (event) => {
    if (state.eraserDrawing?.start) {
      const point = getWorldPoint(event);
      const preview = ui.planGroup.querySelector('.zone-eraser-preview');
      if (point && preview) {
        state.eraserDrawing.end = point;
        preview.setAttribute('x2', point.x);
        preview.setAttribute('y2', point.y);
      }
      return;
    }
    if (state.dividerDrawing?.start) {
      const point = getWorldPoint(event);
      const preview = ui.planGroup.querySelector('.zone-divider-preview');
      if (point && preview) {
        state.dividerDrawing.end = point;
        preview.setAttribute('x2', point.x);
        preview.setAttribute('y2', point.y);
      }
      return;
    }
    if (!state.panDrag) return;
    state.viewCenterX = state.panDrag.startCenterX - (event.clientX - state.panDrag.clientX) * state.panDrag.unitsPerPixelX;
    state.viewCenterY = state.panDrag.startCenterY + (event.clientY - state.panDrag.clientY) * state.panDrag.unitsPerPixelY;
    setViewBox();
  });
  ui.planSvg.addEventListener('pointerup', (event) => {
    const drag = state.edgeDrag;
    if (!drag) {
      state.panDrag = null;
      ui.planSvg.classList.remove('panning');
      return;
    }
    state.edgeDrag = null;
    const candidate = state.candidates.find((item) => item.id === drag.candidateId);
    const path = candidate?.paths.find((item) => item.id === drag.pathId);
    const segment = candidate && getCandidateSegment(candidate, drag.pathId, drag.segmentIndex);
    if (!candidate || !path || !segment) return;
    const moved = Math.hypot(event.clientX - drag.clientX, event.clientY - drag.clientY) > 7;
    if (moved) {
      const endPoint = getWorldPoint(event);
      if (!endPoint) return;
      const start = fractionOnSegment(drag.point, segment);
      const end = fractionOnSegment(endPoint, segment);
      const intervals = path.excludedSpans.get(drag.segmentIndex) || [];
      path.excludedSpans.set(drag.segmentIndex, mergeIntervals([...intervals, [start, end]]));
    } else if (path.excluded.has(drag.segmentIndex)) {
      path.excluded.delete(drag.segmentIndex);
    } else {
      path.excluded.add(drag.segmentIndex);
      path.excludedSpans.delete(drag.segmentIndex);
    }
    renderPlan();
    updateResults();
    renderCandidates();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.dividerDrawing) cancelRoomDivision(true);
    if (event.key === 'Escape' && state.eraserDrawing) cancelPathErasing(true);
  });
  ui.planSvg.addEventListener('wheel', (event) => {
    event.preventDefault();
    const point = getWorldPoint(event);
    if (!point || !state.extents) return;
    const rect = ui.planSvg.getBoundingClientRect();
    const horizontalOffset = (event.clientX - rect.left) / rect.width - 0.5;
    const verticalOffset = (event.clientY - rect.top) / rect.height - 0.5;
    state.zoomFactor = Math.max(0.4, Math.min(8, (state.zoomFactor || 1) * (event.deltaY < 0 ? 1.12 : 1 / 1.12)));
    const baseWidth = state.extents.maxX - state.extents.minX;
    const baseHeight = state.extents.maxY - state.extents.minY;
    const padding = Math.max(baseWidth, baseHeight) * 0.035;
    const viewWidth = (baseWidth + 2 * padding) / state.zoomFactor;
    const viewHeight = (baseHeight + 2 * padding) / state.zoomFactor;
    state.viewCenterX = point.x - horizontalOffset * viewWidth;
    state.viewCenterY = point.y + verticalOffset * viewHeight;
    setViewBox();
  }, { passive: false });
  $('#fitButton').addEventListener('click', () => {
    if (!state.extents) return;
    state.zoomFactor = 1;
    state.viewCenterX = (state.extents.minX + state.extents.maxX) / 2;
    state.viewCenterY = (state.extents.minY + state.extents.maxY) / 2;
    setViewBox();
  });
  $('#zoomInButton').addEventListener('click', () => {
    state.zoomFactor = Math.min(8, (state.zoomFactor || 1) * 1.25);
    setViewBox();
  });
  $('#zoomOutButton').addEventListener('click', () => {
    state.zoomFactor = Math.max(0.4, (state.zoomFactor || 1) / 1.25);
    setViewBox();
  });
  ui.exportButton.addEventListener('click', () => {
    const rows = selectedRoomRows();
    const csvRows = [['Pomieszczenie', 'Kolor listwy', 'Długość listwy (m)'], ...rows.map((row) => [
      row.name,
      row.color,
      row.length.toFixed(2).replace('.', ','),
    ])];
    const csv = '\uFEFF' + csvRows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(';')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${state.fileName.replace(/\.dxf$/i, '') || 'zestawienie'}-listwy.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
})();
