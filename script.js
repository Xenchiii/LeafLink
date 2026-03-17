// LeafLink — script.js
// This file handles everything: serial connection, reading live sensor data,
// updating the UI, drawing charts, and managing the session log.
// Nothing here runs on fake data — if no device is connected, the dashboard
// just sits empty and waits. That's intentional.

'use strict';

// Set up Chart.js to match the LeafLink font and color system
Chart.defaults.font.family = "'Roboto','Open Sans',sans-serif";
Chart.defaults.color       = '#6497b1';
Chart.defaults.borderColor = 'rgba(1,31,75,0.07)';

// Shorthand color references so we're not typing hex codes everywhere
const C = { primary:'#011f4b', secondary:'#03396c', accent:'#005b96', soft:'#6497b1' };


// Serial connection state — these track whether we're connected,
// currently trying to connect, or actively reading from the port
let serialPort     = null;
let serialReader   = null;
let serialBuffer   = '';
let isConnected    = false;
let isConnecting   = false;
let readLoopActive = false;
let firstPacket    = true; // flipped to false the moment the first real packet arrives


// The session log stores every reading we receive during this browser session.
// We cap it at 200 entries so memory doesn't balloon on long sessions.
const sessionLog = [];
const MAX_SESSION = 200;

// Each sensor gets its own rolling history array for charting.
// We keep the last 60 readings so charts always have something to draw.
const sensorHistory = {
  moisture:[], temp:[], humidity:[],
  ph:[], light:[], water:[], pir:[],
};
const MAX_HIST   = 60;
const histLabels = []; // the timestamps that line up with each history entry


// This is the live sensor state object. Every value starts as null
// because we genuinely don't know anything until the device tells us.
const sensorState = {
  moisture: { value:null, unit:'%',   label:'Soil Moisture'   },
  temp:     { value:null, unit:'°C',  label:'Temperature'     },
  humidity: { value:null, unit:'%',   label:'Humidity'        },
  ph:       { value:null, unit:'pH',  label:'Soil pH'         },
  light:    { value:null, unit:'lux', label:'Light Intensity' },
  water:    { value:null, unit:'%',   label:'Water Level'     },
  pir:      { value:null, unit:'',    label:'PIR Sensor'      },
};

// Power data is optional — the device can include battery and solar fields
// in its JSON output, but it doesn't have to. We handle both cases.
const powerState = { battery:null, solar:null };

// We keep track of raw lines we couldn't parse so we can show them in
// the waiting panel — super helpful for debugging what the device is
// actually spitting out before the JSON format is right
let lastRawLine = '';


// When the user clicks the nav button, we either open the connect modal
// or trigger a disconnect depending on the current connection state
function toggleConnection() {
  if (isConnected || isConnecting) {
    disconnectSerial();
  } else {
    openModal();
  }
}

function openModal() {
  document.getElementById('connectModal').classList.add('open');
  // If this browser doesn't support Web Serial, show the warning
  // and disable the connect button right away
  if (!('serial' in navigator)) {
    document.getElementById('serialWarning').style.display = 'flex';
    document.getElementById('modalConnectBtn').disabled = true;
  }
}

function closeModal() {
  document.getElementById('connectModal').classList.remove('open');
}

// This is where the actual connection happens. We grab the settings
// from the modal form, ask the browser to show the port picker,
// then open the port at the requested baud rate.
async function connectSerial() {
  if (!('serial' in navigator)) return;

  isConnecting = true;
  setConnectionUI('connecting');
  document.getElementById('serialLogSection').style.display = 'block';
  logSerial('Requesting serial port…');

  try {
    const baud     = parseInt(document.getElementById('baudRate').value);
    const dataBits = parseInt(document.getElementById('dataBits').value);
    const stopBits = parseInt(document.getElementById('stopBits').value);

    serialPort = await navigator.serial.requestPort();
    logSerial(`Port selected — opening at ${baud} baud…`);

    await serialPort.open({ baudRate:baud, dataBits, stopBits, parity:'none' });
    logSerial('Port opened.', 'ok');

    isConnected  = true;
    isConnecting = false;
    firstPacket  = true;
    lastRawLine  = '';
    setConnectionUI('connected');
    closeModal();
    showToast('Device connected — waiting for data…');

    // the port is open so we remove all the no-device banners immediately —
    // there's nothing worse than staring at "no device connected" when the
    // nav bar is already green and you clearly just plugged something in
    revealConnectedUI();

    startReadLoop();

  } catch (err) {
    // Something went wrong — could be the user cancelled the picker,
    // or the port failed to open. Either way, reset cleanly.
    isConnected  = false;
    isConnecting = false;
    setConnectionUI('none');
    logSerial('Error: ' + err.message, 'err');
  }
}

// Gracefully close everything down when the user disconnects.
// We stop the read loop first, then cancel the reader, then close the port.
async function disconnectSerial() {
  readLoopActive = false;
  try {
    if (serialReader) { await serialReader.cancel(); serialReader = null; }
    if (serialPort)   { await serialPort.close(); serialPort = null; }
  } catch (_) {}
  isConnected  = false;
  isConnecting = false;
  setConnectionUI('none');
  showToast('Device disconnected.');
  resetToEmptyState();
}

// The read loop runs continuously while connected. It pipes the serial
// readable stream through a TextDecoder and hands chunks to flushBuffer
// as they arrive. If the port closes unexpectedly we call disconnect.
async function startReadLoop() {
  if (!serialPort?.readable) return;
  readLoopActive = true;
  serialBuffer   = '';

  const dec  = new TextDecoderStream();
  serialPort.readable.pipeTo(dec.writable);
  serialReader = dec.readable.getReader();

  try {
    while (readLoopActive) {
      const { value, done } = await serialReader.read();
      if (done) break;
      if (value) {
        serialBuffer += value;
        flushBuffer();
      }
    }
  } catch (err) {
    if (readLoopActive) {
      logSerial('Read error: ' + err.message, 'err');
      disconnectSerial();
    }
  } finally {
    try { serialReader.releaseLock(); } catch (_) {}
  }
}

// We split the buffer on newlines and try to parse each complete line as JSON.
// The last chunk might be incomplete, so we hold it back in the buffer
// and wait for the rest of it to arrive on the next read.
function flushBuffer() {
  const lines = serialBuffer.split('\n');
  serialBuffer = lines.pop();
  lines.forEach(line => {
    line = line.trim();
    if (!line) return;

    // try it as proper JSON first — that's the happy path
    let parsed = null;
    try {
      parsed = JSON.parse(line);
    } catch (_) {
      // not clean JSON. before giving up let's try fixing common firmware
      // mistakes — trailing commas, missing braces, that sort of thing.
      // a lot of beginner Arduino sketches don't wrap the whole thing in {}
      // or accidentally leave a trailing comma on the last field
      try {
        let attempt = line;
        // wrap bare key:value output in braces if it looks like one
        if (!attempt.startsWith('{')) attempt = '{' + attempt + '}';
        // strip trailing commas before closing brace — super common mistake
        attempt = attempt.replace(/,\s*}/g, '}');
        parsed = JSON.parse(attempt);
      } catch (_) {
        // still not valid JSON even after the patch-up attempt.
        // last resort — try to pull sensor values straight out of the
        // human-readable text your firmware is printing. this handles
        // lines like "Water Level Sensor Value: 1317 | Water Level: 32% | Status: Low"
        // or "Temperature: 24.5C" or "Soil Moisture: 68%" without you
        // having to change a single line of your ESP32 code.
        const extracted = tryParseRawText(line);
        if (extracted) {
          logSerial(line + ' → parsed as text', 'ok');
          ingestPacket(extracted);
          return;
        }

        // genuinely can't figure it out — log it so the waiting panel
        // can show the user exactly what's coming through the wire,
        // which makes baud rate and format problems much easier to spot
        lastRawLine = line;
        updateWaitingPanel();
        logSerial(line);
        return;
      }
    }

    if (parsed) ingestPacket(parsed);
  });
}

// Tries to extract known sensor values from a plain-text line that the
// firmware printed for human reading instead of as JSON. We look for
// percentage values near known keywords, labelled numbers, and the
// specific "| Water Level: 32% |" pipe-delimited format your ESP32 uses.
// Returns a partial sensor object if anything useful was found, or null
// if the line really doesn't contain anything we recognise.
function tryParseRawText(line) {
  const lower = line.toLowerCase();
  const out   = {};

  // helper — grabs the first number that appears after a keyword match
  const grab = (pattern) => {
    const m = line.match(pattern);
    return m ? parseFloat(m[1]) : null;
  };

  // water level — handles all of these formats your ESP32 might send:
  //   "Water Level: 32%"
  //   "Water Level Sensor Value: 1317 | Water Level: 32% | Status: Low"
  //   "water:32"  /  "water level:32"
  // we scan the whole line for any % number that follows a "water level" label,
  // using a global search so the pipe-delimited format doesn't fool us
  let waterPct = null;
  const waterMatches = [...line.matchAll(/water\s*level[^:|]*:\s*([\d.]+)\s*%/gi)];
  if (waterMatches.length > 0) {
    // grab the last match — in "...Value: 1317 | Water Level: 32%" the
    // last one is always the actual percentage, not the raw ADC count
    waterPct = parseFloat(waterMatches[waterMatches.length - 1][1]);
  }
  if (waterPct !== null && !isNaN(waterPct)) out.water = waterPct;
  else {
    // no percentage found anywhere — if there's a raw ADC reading we
    // convert it from the typical 0–4095 ESP32 12-bit ADC range to 0–100%
    const waterRaw = grab(/water\s*level\s*sensor\s*value[^:]*:\s*([\d.]+)/i);
    if (waterRaw !== null) out.water = Math.round((waterRaw / 4095) * 100);
  }

  // soil moisture
  const moist = grab(/(?:soil\s*)?moisture[^:]*:\s*([\d.]+)\s*%/i);
  if (moist !== null) out.moisture = moist;
  else {
    const moistRaw = grab(/(?:soil\s*)?moisture[^:]*:\s*([\d.]+)/i);
    if (moistRaw !== null) out.moisture = Math.round((moistRaw / 4095) * 100);
  }

  // temperature — grabs the number before an optional C or F suffix
  const temp = grab(/temp(?:erature)?[^:]*:\s*([\d.]+)\s*[°]?[CF]?/i);
  if (temp !== null) out.temp = temp;

  // humidity
  const hum = grab(/humid(?:ity)?[^:]*:\s*([\d.]+)\s*%?/i);
  if (hum !== null) out.humidity = hum;

  // soil pH
  const ph = grab(/p\s*h[^:]*:\s*([\d.]+)/i);
  if (ph !== null) out.ph = ph;

  // light / lux / ldr
  const light = grab(/(?:light|lux|ldr)[^:]*:\s*([\d.]+)/i);
  if (light !== null) out.light = light;

  // PIR / motion — looks for 1/0 or detected/clear keywords
  if (/pir|motion/i.test(lower)) {
    if (/detected|triggered|1/i.test(lower)) out.pir = 1;
    else if (/clear|none|no motion|0/i.test(lower)) out.pir = 0;
  }

  // battery and solar while we're here
  const bat = grab(/batt(?:ery)?[^:]*:\s*([\d.]+)\s*%?/i);
  if (bat !== null) out.battery = bat;

  const sol = grab(/solar[^:]*:\s*([\d.]+)/i);
  if (sol !== null) out.solar = sol;

  // only return something if we actually found at least one value
  return Object.keys(out).length > 0 ? out : null;
}

// This runs every time we get a valid JSON packet from the device.
// It updates the sensor state, pushes to history, logs the reading,
// and then refreshes every part of the UI that cares about the new data.
function ingestPacket(data) {
  const now = new Date();
  const ts  = now.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });

  // we accept any subset of these keys — if your device only has a water
  // sensor right now, that's fine, just send {"water":75} and it'll work.
  // all the other cards stay at their last known value or No Data.
  const keyMap = { moisture:'moisture', temp:'temp', humidity:'humidity',
                   ph:'ph', light:'light', water:'water', pir:'pir' };

  let hasAny = false;
  for (const [k, sk] of Object.entries(keyMap)) {
    if (data[k] !== undefined) {
      const v = parseFloat(data[k]);
      if (!isNaN(v)) {
        sensorState[sk].value = v;
        sensorHistory[sk].push(v);
        if (sensorHistory[sk].length > MAX_HIST) sensorHistory[sk].shift();
        hasAny = true;
      }
    }
  }

  // Battery and solar are totally optional fields — we update them if present
  if (data.battery !== undefined && !isNaN(parseFloat(data.battery)))
    powerState.battery = parseFloat(data.battery);
  if (data.solar !== undefined && !isNaN(parseFloat(data.solar)))
    powerState.solar = parseFloat(data.solar);

  // if none of the keys matched anything we know about, log it and bail —
  // the packet was valid JSON but not in the LeafLink format at all
  if (!hasAny) {
    logSerial('Received JSON but no recognised sensor keys found: ' + JSON.stringify(data));
    lastRawLine = JSON.stringify(data);
    updateWaitingPanel();
    return;
  }

  // Keep the timestamp labels in sync with the history arrays
  histLabels.push(ts);
  if (histLabels.length > MAX_HIST) histLabels.shift();

  // Add this reading to the session log so the History page has real data
  const row = { time:ts };
  for (const k in sensorState) row[k] = sensorState[k].value;
  sessionLog.push(row);
  if (sessionLog.length > MAX_SESSION) sessionLog.shift();

  // The very first packet is special — we use it to reveal the live UI
  // and initialize all the charts for the first time
  if (firstPacket) {
    firstPacket = false;
    revealLiveUI();
    initAllCharts();
    // figure out which sensors actually reported so we can tell the user
    const active = Object.keys(keyMap).filter(k => sensorState[k].value !== null);
    showToast('Live data streaming — ' + active.length + ' sensor' + (active.length !== 1 ? 's' : '') + ' active.');
  }

  // Refresh everything on screen with the new values
  updateSensorCards();
  renderAlerts();
  updateTimestamp(ts);
  liveUpdateCharts();
  liveUpdateHistory();
  updatePower();

  logSerial(JSON.stringify(data), 'ok');
}


// Called the moment the port opens successfully, before any data has
// arrived. This clears all the no-device banners right away and shows
// the page skeleton with a "connected but waiting" message so the user
// knows the link is live and we're just waiting for the firmware to
// start sending. Sensor cards stay dimmed — revealLiveUI handles that
// once the first actual packet comes through.
function revealConnectedUI() {
  document.getElementById('noBanner').style.display        = 'none';

  document.getElementById('sensorsNoDevice').style.display = 'none';
  document.getElementById('sensorsContent').style.display  = 'block';

  document.getElementById('powerNoDevice').style.display   = 'none';
  document.getElementById('powerContent').style.display    = 'block';

  document.getElementById('historyNoDevice').style.display = 'none';
  document.getElementById('historyContent').style.display  = 'block';

  // show "waiting" message in the alerts panel instead of the no-device text
  const panel = document.getElementById('alertsPanel');
  if (panel) panel.innerHTML = '<div class="alert-none" id="waitingMsg">Device connected — waiting for the first packet from your microcontroller…</div>';

  // populate the sensor table now so the user sees a proper table of
  // No Data rows rather than just a blank empty tbody sitting there
  populateSensorTable();

  // show the dashboard chart waiting placeholder while we wait for data
  document.getElementById('dashChartEmpty').style.display = 'flex';
  document.getElementById('dashChart').style.display      = 'none';
}

// Updates the "waiting" panel with whatever raw line the device last sent
// so the user can see what's actually coming through the serial port —
// makes it really obvious if the baud rate is wrong or the JSON format
// is off before a single valid packet has been received
function updateWaitingPanel() {
  const el = document.getElementById('waitingMsg');
  if (!el) return;
  if (lastRawLine) {
    el.innerHTML = 'Device is sending data but it\'s not in the expected format yet.<br>'
      + '<span style="font-family:\'Roboto Mono\',monospace;font-size:0.78rem;color:var(--accent);">Last received: '
      + escapeHtml(lastRawLine.slice(0, 120))
      + '</span><br><span style="font-size:0.78rem;">Check your baud rate and that your firmware outputs valid JSON ending with \\n</span>';
  }
}

// quick HTML escape so raw serial output can't accidentally inject anything
function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Called the moment the first real packet arrives. This removes all the
// "no device" banners, shows the actual content, and turns the sensor
// cards from dim placeholders into live readable tiles.
function revealLiveUI() {
  document.getElementById('noBanner').style.display       = 'none';
  document.getElementById('dashChartEmpty').style.display = 'none';
  document.getElementById('dashChart').style.display      = 'block';

  document.querySelectorAll('.sensor-card').forEach(c => c.classList.remove('no-data'));

  document.getElementById('sensorsNoDevice').style.display = 'none';
  document.getElementById('sensorsContent').style.display  = 'block';

  document.getElementById('powerNoDevice').style.display = 'none';
  document.getElementById('powerContent').style.display  = 'block';

  document.getElementById('historyNoDevice').style.display = 'none';
  document.getElementById('historyContent').style.display  = 'block';
  document.getElementById('exportBtn').disabled = false;
}

// When the device disconnects, we wipe all values back to null
// and restore every page to its empty "waiting for device" state.
function resetToEmptyState() {
  for (const k in sensorState) sensorState[k].value = null;
  for (const k in sensorHistory) sensorHistory[k] = [];
  histLabels.length = 0;
  powerState.battery = null;
  powerState.solar   = null;
  firstPacket = true;
  lastRawLine = '';

  // Reset every sensor card back to dashes
  for (const k in sensorState) {
    const valEl  = document.getElementById('val-' + k);
    const unitEl = document.getElementById('unit-' + k);
    const barEl  = document.getElementById('bar-' + k);
    const stEl   = document.getElementById('status-' + k);
    const cardEl = document.getElementById('card-' + k);
    if (valEl)  valEl.textContent  = '—';
    if (unitEl) unitEl.textContent = '';
    if (barEl)  barEl.style.width  = '0%';
    if (stEl)   stEl.textContent   = 'No Data';
    if (cardEl) { cardEl.classList.remove('warn','danger'); cardEl.classList.add('no-data'); }
  }

  const badge = document.getElementById('systemBadge');
  if (badge) { badge.textContent = 'Awaiting Device'; badge.className = 'badge badge-grey'; }

  // Bring back all the no-device banners
  document.getElementById('noBanner').style.display       = 'flex';
  document.getElementById('dashChartEmpty').style.display = 'flex';
  document.getElementById('dashChart').style.display      = 'none';

  document.getElementById('sensorsNoDevice').style.display = 'flex';
  document.getElementById('sensorsContent').style.display  = 'none';

  document.getElementById('powerNoDevice').style.display = 'flex';
  document.getElementById('powerContent').style.display  = 'none';

  document.getElementById('historyNoDevice').style.display = 'flex';
  document.getElementById('historyContent').style.display  = 'none';
  document.getElementById('exportBtn').disabled = true;

  document.getElementById('alertsPanel').innerHTML =
    '<div class="alert-none">No device connected — alerts will appear here once your hardware is linked.</div>';

  // Destroy any existing charts to free up memory
  Object.values(allCharts).forEach(c => { try { c.destroy(); } catch (_) {} });
  for (const k in allCharts) allCharts[k] = null;
}


// Given a sensor key and its current value, this figures out whether
// things are fine, borderline, or actually a problem. Returns the
// display text, the card CSS class, and the table badge class.
function sensorStatus(key, value) {
  if (value === null) return { text:'No Data', cls:'', tdCls:'td-nodata' };
  switch (key) {
    case 'moisture':
      if (value < 30)  return { text:'Dry — Water Soon', cls:'danger', tdCls:'td-danger' };
      if (value < 45)  return { text:'Low Moisture',     cls:'warn',   tdCls:'td-warn'   };
      if (value > 85)  return { text:'Overwatered',      cls:'warn',   tdCls:'td-warn'   };
      return              { text:'Optimal',            cls:'',       tdCls:'td-ok'     };
    case 'temp':
      if (value < 15)  return { text:'Too Cold',         cls:'warn',   tdCls:'td-warn'   };
      if (value > 35)  return { text:'Too Hot',          cls:'danger', tdCls:'td-danger' };
      return              { text:'Comfortable',        cls:'',       tdCls:'td-ok'     };
    case 'humidity':
      if (value < 35)  return { text:'Very Dry Air',     cls:'warn',   tdCls:'td-warn'   };
      if (value > 85)  return { text:'Very Humid',       cls:'warn',   tdCls:'td-warn'   };
      return              { text:'Good',               cls:'',       tdCls:'td-ok'     };
    case 'ph':
      if (value < 5.5) return { text:'Too Acidic',       cls:'danger', tdCls:'td-danger' };
      if (value > 7.5) return { text:'Too Alkaline',     cls:'warn',   tdCls:'td-warn'   };
      return              { text:'Optimal',            cls:'',       tdCls:'td-ok'     };
    case 'light':
      if (value < 200) return { text:'Very Low Light',   cls:'warn',   tdCls:'td-warn'   };
      if (value < 400) return { text:'Low Light',        cls:'warn',   tdCls:'td-warn'   };
      return              { text:'Bright',             cls:'',       tdCls:'td-ok'     };
    case 'water':
      if (value < 20)  return { text:'Critically Low',   cls:'danger', tdCls:'td-danger' };
      if (value < 40)  return { text:'Low',              cls:'warn',   tdCls:'td-warn'   };
      return              { text:'Sufficient',         cls:'',       tdCls:'td-ok'     };
    case 'pir':
      return value ? { text:'Motion Detected!', cls:'warn', tdCls:'td-warn' }
                   : { text:'No Motion',         cls:'',    tdCls:'td-ok'   };
    default:
      return { text:'OK', cls:'', tdCls:'td-ok' };
  }
}

// Converts a raw sensor value into a 0-100 percentage for the progress bar.
// Each sensor has its own expected range, so they each scale differently.
function barPct(key, value) {
  if (value === null) return 0;
  const R = { moisture:[0,100], temp:[10,45], humidity:[0,100],
              ph:[3,10], light:[0,1200], water:[0,100], pir:[0,1] };
  const [lo, hi] = R[key] || [0, 100];
  return Math.max(0, Math.min(100, ((value - lo) / (hi - lo)) * 100));
}


// Loops through every sensor and updates its card on the dashboard —
// the number, the unit, the progress bar fill, the status text,
// and any warning/danger color changes on the card itself.
function updateSensorCards() {
  for (const key in sensorState) {
    const { value, unit } = sensorState[key];
    const st = sensorStatus(key, value);

    const valEl  = document.getElementById('val-' + key);
    const unitEl = document.getElementById('unit-' + key);
    const barEl  = document.getElementById('bar-' + key);
    const stEl   = document.getElementById('status-' + key);
    const cardEl = document.getElementById('card-' + key);

    if (valEl) {
      if (value === null)       valEl.textContent = '—';
      else if (key === 'pir')   valEl.textContent = value ? 'Motion!' : 'Clear';
      else if (key === 'ph')    valEl.textContent = value.toFixed(1);
      else if (key === 'light') valEl.textContent = Math.round(value);
      else                      valEl.textContent = Math.round(value);
    }
    if (unitEl) unitEl.textContent = value !== null ? ' ' + unit : '';
    if (barEl)  barEl.style.width  = barPct(key, value) + '%';
    if (stEl)   stEl.textContent   = st.text;
    if (cardEl) {
      cardEl.classList.remove('warn','danger','no-data');
      if (st.cls) cardEl.classList.add(st.cls);
    }
  }

  // Update the system-wide badge in the top right corner
  const keys = Object.keys(sensorState);
  const hasDanger = keys.some(k => sensorState[k].value !== null && sensorStatus(k, sensorState[k].value).cls === 'danger');
  const hasWarn   = keys.some(k => sensorState[k].value !== null && sensorStatus(k, sensorState[k].value).cls === 'warn');
  const badge = document.getElementById('systemBadge');
  if (badge) {
    if (hasDanger)    { badge.textContent = 'Attention Required'; badge.className = 'badge badge-red'; }
    else if (hasWarn) { badge.textContent = 'Check Sensors';      badge.className = 'badge badge-yellow'; }
    else              { badge.textContent = 'All Systems Normal'; badge.className = 'badge badge-green'; }
  }
}


// Scans all sensors for anything out of range and builds the alert panel.
// Only sensors that have actual data trigger alerts — null values are skipped.
function renderAlerts() {
  const panel = document.getElementById('alertsPanel');
  if (!panel) return;
  const alerts = [];
  for (const key in sensorState) {
    const { value } = sensorState[key];
    if (value === null) continue;
    const st = sensorStatus(key, value);
    if (st.cls === 'danger') alerts.push({ cls:'alert-danger', icon:'icon-warning', label:sensorState[key].label, text:st.text });
    else if (st.cls === 'warn') alerts.push({ cls:'alert-warn', icon:'icon-warning', label:sensorState[key].label, text:st.text });
  }
  if (!alerts.length) {
    panel.innerHTML = '<div class="alert-none">All sensor readings are within normal ranges.</div>';
  } else {
    panel.innerHTML = alerts.map(a =>
      `<div class="alert ${a.cls}">
        <span class="alert-icon-wrap"><span class="${a.icon}"></span></span>
        <div><strong>${a.label}:</strong> ${a.text}</div>
      </div>`
    ).join('');
  }
}


// Updates the timestamp shown under the dashboard header
function updateTimestamp(ts) {
  const el = document.getElementById('dashTimestamp');
  if (el) el.textContent = ts || new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
}


// Handles all the power page UI — the ring charts, the values,
// the badge in the header, and the power notification alerts.
// Battery and solar are optional so we guard against null carefully.
function updatePower() {
  const C2  = 314; // circumference of our SVG ring (2π × radius 50)
  const bat = powerState.battery;
  const sol = powerState.solar;

  const battRing = document.getElementById('batteryRing');
  const battVal  = document.getElementById('batteryVal');
  const battUnit = document.getElementById('batteryUnit');
  const battMeta = document.getElementById('batteryMeta');

  if (bat !== null) {
    if (battRing) battRing.style.strokeDashoffset = C2 * (1 - bat / 100);
    if (battVal)  battVal.textContent  = Math.round(bat);
    if (battUnit) battUnit.textContent = '%';
    if (battMeta) battMeta.textContent = bat > 20 ? 'Charging via solar panel' : 'Low battery — check solar';

    const pb = document.getElementById('powerBadge');
    if (pb) {
      if (bat < 20)  { pb.textContent = 'Low Battery';  pb.className = 'badge badge-red'; }
      else if (sol)  { pb.textContent = 'Solar Active';  pb.className = 'badge badge-green'; }
      else           { pb.textContent = 'Battery Only';  pb.className = 'badge badge-yellow'; }
    }
  }

  const solRing = document.getElementById('solarRing');
  const solVal  = document.getElementById('solarVal');
  const solUnit = document.getElementById('solarUnit');
  const maxSolar = 6;
  if (sol !== null) {
    if (solRing) solRing.style.strokeDashoffset = C2 * (1 - Math.min(sol / maxSolar, 1));
    if (solVal)  solVal.textContent  = sol.toFixed(1);
    if (solUnit) solUnit.textContent = 'W';
  }

  // Rough runtime estimate — we just scale battery % against a 24-hour baseline
  const runVal  = document.getElementById('runtimeVal');
  const runUnit = document.getElementById('runtimeUnit');
  const runRing = document.getElementById('runtimeRing');
  if (bat !== null) {
    const hrs = Math.round((bat / 100) * 24);
    if (runVal)  runVal.textContent  = hrs;
    if (runUnit) runUnit.textContent = 'hrs';
    if (runRing) runRing.style.strokeDashoffset = C2 * (1 - bat / 100);
  }

  // Build the power notifications based on what we actually know
  const pa = document.getElementById('powerAlerts');
  if (pa) {
    const lines = [];
    if (sol !== null && sol > 0.5) {
      lines.push(`<div class="alert alert-info">
        <span class="alert-icon-wrap"><span class="icon-alert-info"></span></span>
        <div><strong>Solar panel active.</strong> Currently generating ${sol.toFixed(1)}W.</div>
      </div>`);
    }
    if (bat !== null && bat > 20) {
      lines.push(`<div class="alert alert-success">
        <span class="alert-icon-wrap"><span class="icon-alert-success"></span></span>
        <div><strong>Battery healthy.</strong> ${Math.round(bat)}% charge.</div>
      </div>`);
    }
    if (bat !== null && bat <= 20) {
      lines.push(`<div class="alert alert-danger">
        <span class="alert-icon-wrap"><span class="icon-warning"></span></span>
        <div><strong>Low battery warning.</strong> ${Math.round(bat)}% — check your solar panel connection.</div>
      </div>`);
    }
    pa.innerHTML = lines.length ? lines.join('') : '<div class="alert-none">Waiting for power data from device.</div>';
  }
}


// All chart instances live here so we can destroy and rebuild them cleanly
const allCharts = {
  dash:null, moisture:null, temp:null, light:null, ph:null,
  power:null, history:null,
};

// Returns a copy of the current timestamp labels (used as chart x-axis)
function getLabels() { return [...histLabels]; }

// Returns a copy of the rolling history for a given sensor key
function getHist(key) { return [...sensorHistory[key]]; }

// Called on the first packet to build every chart that's currently visible.
// Charts on hidden pages get built when the user navigates to them.
function initAllCharts() {
  initDashChart();
  if (currentPage === 'sensors') initSensorCharts();
  if (currentPage === 'power')   initPowerChart();
  if (currentPage === 'history') initHistoryChart();
}

// Draws the main overview line chart on the dashboard —
// moisture, temperature, and humidity plotted together over time
function initDashChart() {
  const ctx = document.getElementById('dashChart');
  if (!ctx) return;
  if (allCharts.dash) allCharts.dash.destroy();

  allCharts.dash = new Chart(ctx, {
    type:'line',
    data:{
      labels: getLabels(),
      datasets:[
        lineDS('Moisture (%)',     getHist('moisture'), C.accent, true),
        lineDS('Temperature (°C)', getHist('temp'),     C.soft,   true),
        lineDS('Humidity (%)',     getHist('humidity'), 'rgba(3,57,108,0.6)', false, true),
      ],
    },
    options: chartOpts(),
  });
}

// Pushes the latest values into all visible charts without rebuilding them.
// Using 'none' as the update mode skips the animation so updates feel instant.
function liveUpdateCharts() {
  if (allCharts.dash) {
    allCharts.dash.data.labels            = getLabels();
    allCharts.dash.data.datasets[0].data  = getHist('moisture');
    allCharts.dash.data.datasets[1].data  = getHist('temp');
    allCharts.dash.data.datasets[2].data  = getHist('humidity');
    allCharts.dash.update('none');
  }
  if (allCharts.moisture) {
    allCharts.moisture.data.labels           = getLabels();
    allCharts.moisture.data.datasets[0].data = getHist('moisture');
    allCharts.moisture.data.datasets[1].data = getHist('humidity');
    allCharts.moisture.update('none');
  }
  if (allCharts.temp) {
    allCharts.temp.data.labels           = getLabels();
    allCharts.temp.data.datasets[0].data = getHist('temp');
    allCharts.temp.update('none');
  }
  if (allCharts.light) {
    allCharts.light.data.labels           = getLabels();
    allCharts.light.data.datasets[0].data = getHist('light');
    allCharts.light.update('none');
  }
  if (allCharts.ph) {
    allCharts.ph.data.labels           = getLabels();
    allCharts.ph.data.datasets[0].data = getHist('ph');
    allCharts.ph.update('none');
  }
}

// Builds all four individual charts on the Sensor Data page
function initSensorCharts() {
  [
    { id:'moistureHumidityChart', key:'moisture', ds:[
        lineDS('Moisture (%)', getHist('moisture'), C.accent, true),
        lineDS('Humidity (%)', getHist('humidity'), C.soft,   false),
    ]},
    { id:'tempChart',  key:'temp',  ds:[ lineDS('Temperature (°C)', getHist('temp'),  C.accent, true) ]},
    { id:'lightChart', key:'light', ds:[ lineDS('Light (lux)',       getHist('light'), '#f59e0b', true) ]},
    { id:'phChart',    key:'ph',    ds:[ lineDS('Soil pH',           getHist('ph'),    '#10b981', true) ]},
  ].forEach(({ id, key, ds }) => {
    const ctx = document.getElementById(id);
    if (!ctx) return;
    if (allCharts[key]) allCharts[key].destroy();
    allCharts[key] = new Chart(ctx, {
      type:'line', data:{ labels:getLabels(), datasets:ds }, options:chartOpts(),
    });
  });
}

// Builds the battery and solar trend chart on the Power page.
// We pull battery/solar values from the session log since those
// aren't tracked in the rolling sensorHistory arrays.
function initPowerChart() {
  const ctx = document.getElementById('powerChart');
  if (!ctx) return;
  if (allCharts.power) allCharts.power.destroy();

  const batHist = sessionLog.map(r => r.battery ?? null);
  const solHist = sessionLog.map(r => r.solar   ?? null);
  const labels  = sessionLog.map(r => r.time);

  allCharts.power = new Chart(ctx, {
    type:'line',
    data:{
      labels,
      datasets:[
        lineDS('Battery (%)',      batHist, C.accent,  true),
        lineDS('Solar Input (W)',  solHist, '#f59e0b', true),
      ],
    },
    options:{
      ...chartOpts(),
      plugins:{
        ...chartOpts().plugins,
        legend:{ display:true, position:'top', labels:{ color:C.soft, font:{ size:11 } } },
      },
    },
  });
}

// Builds the session chart on the History page showing all three
// main sensors across the full session timeline
function initHistoryChart() {
  const ctx = document.getElementById('historyChart');
  if (!ctx) return;
  if (allCharts.history) allCharts.history.destroy();

  allCharts.history = new Chart(ctx, {
    type:'line',
    data:{
      labels: sessionLog.map(r => r.time),
      datasets:[
        lineDS('Moisture (%)',     sessionLog.map(r => r.moisture), C.accent, false),
        lineDS('Temperature (°C)', sessionLog.map(r => r.temp),     C.soft,   false),
        lineDS('Humidity (%)',     sessionLog.map(r => r.humidity), 'rgba(3,57,108,0.7)', false),
      ],
    },
    options:{
      ...chartOpts(),
      plugins:{
        ...chartOpts().plugins,
        legend:{ display:true, position:'top', labels:{ color:C.soft, font:{ size:11 } } },
      },
    },
  });
}

// Called on every new packet to keep the History page in sync.
// Rebuilds the data log table, recalculates session averages,
// and pushes the latest data into the history chart.
function liveUpdateHistory() {
  const tbody = document.getElementById('historyTableBody');
  if (!tbody) return;

  if (!sessionLog.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--soft);font-style:italic;padding:24px;">No data yet</td></tr>';
    return;
  }

  // Show the 50 most recent readings, newest first
  const rows = [...sessionLog].reverse().slice(0, 50).map(r => `<tr>
    <td>${r.time}</td>
    <td>${r.moisture !== null ? Math.round(r.moisture)+'%' : '—'}</td>
    <td>${r.temp     !== null ? r.temp.toFixed(1)          : '—'}</td>
    <td>${r.humidity !== null ? Math.round(r.humidity)+'%' : '—'}</td>
    <td>${r.ph       !== null ? r.ph.toFixed(2)            : '—'}</td>
    <td>${r.light    !== null ? Math.round(r.light)        : '—'}</td>
    <td>${r.water    !== null ? Math.round(r.water)+'%'    : '—'}</td>
  </tr>`);
  tbody.innerHTML = rows.join('');

  // Recalculate the session averages for the summary cards
  const avg = key => {
    const vals = sessionLog.map(r => r[key]).filter(v => v !== null && !isNaN(v));
    if (!vals.length) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  };
  const setAvg = (id, val, unit, dec=0) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val !== null ? val.toFixed(dec) + unit : '—';
  };
  setAvg('avg-moisture', avg('moisture'), '%');
  setAvg('avg-temp',     avg('temp'),     '°C', 1);
  setAvg('avg-light',    avg('light'),    ' lux');
  setAvg('avg-ph',       avg('ph'),       ' pH', 2);

  // Push new data into the history chart if it's already been initialized
  if (allCharts.history) {
    allCharts.history.data.labels            = sessionLog.map(r => r.time);
    allCharts.history.data.datasets[0].data  = sessionLog.map(r => r.moisture);
    allCharts.history.data.datasets[1].data  = sessionLog.map(r => r.temp);
    allCharts.history.data.datasets[2].data  = sessionLog.map(r => r.humidity);
    allCharts.history.update('none');
  }
}

// Rebuilds the real-time readings table on the Sensor Data page,
// showing the current value plus the min and max seen this session
function populateSensorTable() {
  const tbody = document.getElementById('sensorTableBody');
  if (!tbody) return;
  const rows = Object.entries(sensorState).map(([k, s]) => {
    const v   = s.value;
    const st  = sensorStatus(k, v);
    const h   = sensorHistory[k];
    const min = h.length ? Math.min(...h).toFixed(1) : '—';
    const max = h.length ? Math.max(...h).toFixed(1) : '—';
    const disp = v === null ? '—'
               : k === 'pir'   ? (v ? 'Motion' : 'None')
               : k === 'ph'    ? v.toFixed(1) + ' pH'
               : k === 'light' ? Math.round(v) + ' lux'
               : Math.round(v) + ' ' + s.unit;
    return `<tr>
      <td><strong>${s.label}</strong></td>
      <td>${disp}</td>
      <td>${min}</td>
      <td>${max}</td>
      <td><span class="td-status ${st.tdCls}">${st.text}</span></td>
    </tr>`;
  });
  tbody.innerHTML = rows.join('');
}

// The Refresh button on the Sensor Data page — repopulates the table
// and rebuilds the charts with the latest rolling history
function refreshSensors() {
  populateSensorTable();
  if (isConnected) initSensorCharts();
}


// Exports everything in the session log as a proper CSV file.
// If there's no data yet we just show a toast and bail out early.
function exportCSV() {
  if (!sessionLog.length) { showToast('No data to export yet.'); return; }
  const headers = ['Time','Moisture (%)','Temp (°C)','Humidity (%)','Soil pH','Light (lux)','Water Level (%)'];
  const rows = [headers.join(','), ...sessionLog.map(r =>
    [r.time,
     r.moisture !== null ? r.moisture.toFixed(1) : '',
     r.temp     !== null ? r.temp.toFixed(1)     : '',
     r.humidity !== null ? r.humidity.toFixed(1) : '',
     r.ph       !== null ? r.ph.toFixed(2)       : '',
     r.light    !== null ? Math.round(r.light)   : '',
     r.water    !== null ? r.water.toFixed(1)    : '',
    ].join(',')
  )];
  const blob = new Blob([rows.join('\n')], { type:'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href:url, download:`leaflink-${new Date().toLocaleDateString('en-CA')}.csv`
  });
  a.click();
  URL.revokeObjectURL(url);
}


// A shorthand for creating Chart.js line dataset objects.
// Most of our charts share the same style so this keeps things DRY.
function lineDS(label, data, color, fill=false, dashed=false) {
  return {
    label, data,
    borderColor: color,
    backgroundColor: color + '14',
    fill, tension: 0.42, borderWidth: 2,
    borderDash: dashed ? [5,4] : [],
    pointRadius: 0, pointHoverRadius: 5,
  };
}

// Shared chart configuration — all our charts use these same axis
// styles, tooltip colors, and interaction settings
function chartOpts() {
  return {
    responsive: true,
    interaction: { mode:'index', intersect:false },
    plugins: {
      legend: { display:false },
      tooltip: {
        backgroundColor:'rgba(1,31,75,0.90)',
        titleColor:'#b3cde0', bodyColor:'#f4f8fc',
        padding:10, cornerRadius:8,
        titleFont:{ size:11, weight:'600', family:"'Roboto Mono',monospace" },
        bodyFont:{ size:12, family:"'Roboto',sans-serif" },
      },
    },
    scales: {
      x: { grid:{ display:false }, ticks:{ font:{ size:10, family:"'Roboto Mono',monospace" }, color:'#6497b1', maxTicksLimit:8 } },
      y: { grid:{ color:'rgba(1,31,75,0.06)' }, ticks:{ font:{ size:10, family:"'Roboto Mono',monospace" }, color:'#6497b1' } },
    },
    animation: { duration: 200 },
  };
}


// Updates the nav dot, the status label, and the connect button text
// based on whatever connection state we're currently in
function setConnectionUI(state) {
  const dot   = document.getElementById('statusDot');
  const label = document.getElementById('statusLabel');
  const btn   = document.getElementById('connectBtn');
  const txt   = document.getElementById('connectBtnText');

  dot.className = 'status-dot';
  btn.classList.remove('connected');

  switch (state) {
    case 'connected':
      dot.classList.add('connected');
      label.textContent = 'Device Connected';
      label.style.color = '#4ade80';
      txt.textContent   = 'Disconnect';
      btn.classList.add('connected');
      break;
    case 'connecting':
      dot.classList.add('connecting');
      label.textContent = 'Connecting…';
      label.style.color = '#f59e0b';
      txt.textContent   = 'Connecting…';
      break;
    default:
      // Covers both "none" and "disconnected" — same visual result
      dot.style.background = '#4b5563';
      label.textContent    = 'No Device';
      label.style.color    = '';
      txt.textContent      = 'Connect Device';
      break;
  }
}


// Appends a timestamped line to the serial monitor inside the modal.
// We cap it at 200 lines so the log doesn't grow forever.
function logSerial(msg, type = '') {
  const log = document.getElementById('serialLog');
  if (!log) return;
  const ts   = new Date().toLocaleTimeString();
  const line = document.createElement('div');
  line.className   = type === 'err' ? 'log-err' : type === 'ok' ? 'log-ok' : 'log-line';
  line.textContent = `[${ts}] ${msg}`;
  log.appendChild(line);
  if (log.children.length > 200) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}


// Shows a small notification toast in the bottom right corner.
// It fades out automatically after 3.6 seconds.
function showToast(msg) {
  let t = document.getElementById('ll-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'll-toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 3600);
}


// Handles switching between the five main pages. If we're already
// connected and have data, we rebuild that page's charts on the way in.
let currentPage = 'dashboard';

function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  document.querySelectorAll('.nav-links button').forEach(b => {
    b.classList.toggle('active', b.dataset.page === name);
  });
  currentPage = name;

  if (isConnected && sessionLog.length) {
    if (name === 'sensors') { initSensorCharts(); populateSensorTable(); }
    if (name === 'power')   { initPowerChart(); }
    if (name === 'history') { initHistoryChart(); liveUpdateHistory(); }
  }
}


// Sets the greeting text in the page eyebrow based on the time of day
function setGreeting() {
  const h  = new Date().getHours();
  const el = document.getElementById('greeting');
  if (el) el.textContent = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}


// Everything kicks off here once the DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  setGreeting();

  // All sensor cards start dimmed since we have no data yet
  document.querySelectorAll('.sensor-card').forEach(c => c.classList.add('no-data'));

  // If the browser doesn't support Web Serial, flag it in the nav
  // so the user knows why connecting won't work
  if (!('serial' in navigator)) {
    const dot   = document.getElementById('statusDot');
    const label = document.getElementById('statusLabel');
    if (dot)   dot.style.background = '#f59e0b';
    if (label) label.textContent    = 'No Serial API';
  }

  // Clicking outside the modal should close it
  document.getElementById('connectModal').addEventListener('click', function(e) {
    if (e.target === this) closeModal();
  });

  // Keep the clock ticking in the dashboard header even when no device is connected
  setInterval(() => {
    if (!isConnected) {
      const el = document.getElementById('dashTimestamp');
      if (el) el.textContent = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    }
  }, 1000);
});
