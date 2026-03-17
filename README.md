# LeafLink — IoT Plant Monitoring System

LeafLink is a browser-based dashboard for monitoring plant environments in real time. It connects directly to an Arduino or ESP32 microcontroller over USB using the Web Serial API, reads JSON sensor packets, and visualizes everything — soil moisture, temperature, humidity, pH, light intensity, water level, and motion — without any backend server, cloud service, or installation requirement.

The entire system runs in a single browser tab. There is no Node.js server, no Python backend, no database, and no internet connection required after the page loads. Everything from the serial communication to the charting to the CSV export happens locally in the browser.

---

## Table of contents

- [What it does](#what-it-does)
- [Project structure](#project-structure)
- [Browser requirements](#browser-requirements)
- [Recommended hardware](#recommended-hardware)
- [Wiring reference](#wiring-reference)
- [Firmware and serial output](#firmware-and-serial-output)
- [Connecting your microcontroller](#connecting-your-microcontroller)
- [Sensors supported](#sensors-supported)
- [Alert thresholds](#alert-thresholds)
- [Pages in detail](#pages-in-detail)
- [Data history and export](#data-history-and-export)
- [How the serial pipeline works](#how-the-serial-pipeline-works)
- [How the state model works](#how-the-state-model-works)
- [How the charts work](#how-the-charts-work)
- [How the CSS icons work](#how-the-css-icons-work)
- [Customization](#customization)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)
- [Technical notes](#technical-notes)
- [External dependencies](#external-dependencies)

---

## What it does

Once your microcontroller is connected and sending data, the dashboard comes alive. Every JSON packet that arrives from the device triggers a full UI refresh: sensor cards update their displayed values and progress bars, the alert panel rescans all readings against their thresholds, the overview chart on the dashboard gains a new data point, and the session log on the History page gains a new row.

The seven sensor cards on the dashboard each show the current reading, a unit label, a small horizontal progress bar scaled to that sensor's expected range, and a plain-language status line that tells you whether the reading is acceptable or whether something needs attention. Cards shift to an amber or red color scheme when their values cross a warning or danger threshold, making problem readings visible at a glance without needing to read the numbers.

The alerts panel below the cards consolidates all out-of-range readings into a prioritized list. Danger-level alerts appear at the top and use a red left border. Warning-level alerts use amber. If everything is within range, the panel simply says so. The same alert logic drives the system status badge in the top-right corner of the page header, which reads "All Systems Normal", "Check Sensors", or "Attention Required" based on the worst current state across all sensors.

The Power and Solar page is independently optional. If your device sends `battery` and `solar` fields in its JSON output, the page displays animated ring charts for battery percentage, solar wattage, and estimated runtime. If those fields are absent, the page just waits and says so. You do not have to include them.

---

## Project structure

```
leaflink/
  index.html      -- all five page sections, the navigation bar, the connection modal,
                     and the footer; no page is rendered server-side
  styles.css      -- the complete visual system; colors, typography, layout, animations,
                     every icon, and all responsive breakpoints
  script.js       -- serial connection management, incoming data parsing, sensor state,
                     rolling history, Chart.js initialization and live updates,
                     alert rendering, CSV export, and page navigation
  favicon.svg     -- the small leaf icon shown in the browser tab
```

The three files are fully self-contained. `index.html` links to `styles.css` and `script.js` as local files and loads Chart.js from the cdnjs CDN and fonts from Google Fonts. Those are the only two external requests the page makes, and neither is required for the dashboard logic to function — if you are offline and the CDN is unavailable, you will lose the charts and custom fonts but everything else will still work.

There is no build step, no package manager, and no compilation. Open `index.html` in Chrome or Edge and it works.

---

## Browser requirements

LeafLink uses the **Web Serial API**, which is a relatively recent browser capability that allows web pages to open and read from physical serial ports. As of the time this project was built, the API is only available in:

- Google Chrome (version 89 and later)
- Microsoft Edge (version 89 and later)
- Any other Chromium-based browser that exposes the Web Serial API

Firefox does not support Web Serial and has not announced plans to do so. Safari does not support it either. The LeafLink dashboard will load without errors in those browsers, but when you click Connect Device the modal will show a warning that the API is unavailable, and the connect button will be disabled.

If you are running Chrome or Edge and the connection still does not work, check that the page is not being served from a context that restricts the API. Opening `index.html` directly as a local file (`file://` protocol) works fine in most cases. If you are serving it from a local web server, make sure it is running on `localhost` or over HTTPS, as the Web Serial API is restricted to secure contexts.

On Linux, you may also need to add your user to the `dialout` group to get permission to access serial ports:

```bash
sudo usermod -a -G dialout $USER
```

Log out and back in for the group change to take effect.

---

## Recommended hardware

LeafLink was designed around common, widely available components. The JSON keys in the firmware example correspond to these specific parts, though you can substitute equivalents as long as the output format stays the same.

**Microcontroller**

Either an Arduino Uno, Arduino Nano, or an ESP32 development board will work. The ESP32 has the advantage of built-in Wi-Fi, which means you could extend the firmware to send data wirelessly in the future, though LeafLink itself communicates over USB serial. The Arduino Uno and Nano work fine for purely wired setups.

**Soil moisture sensor**

A standard resistive soil moisture sensor with an analog output works directly with `analogRead`. The raw analog value (0 to 1023 on a 5V Arduino) is converted to a percentage by dividing by 10.24 in the firmware snippet. Capacitive soil moisture sensors are more accurate and do not corrode over time, but they require slightly different calibration.

**Temperature and humidity sensor**

The DHT22 (also sold as AM2302) is the recommended choice. It has better accuracy than the DHT11 (±0.5 C and ±2% RH versus ±2 C and ±5% RH) and a wider measurement range. Use the DHT library from Adafruit or the DHTNew library. The sensor outputs both temperature and humidity over a single digital pin.

**pH sensor**

A soil pH sensor with an analog voltage output and its associated signal conditioning board. The `readPH()` function in the firmware is a placeholder — actual pH calculation requires calibration with buffer solutions at pH 4.0 and pH 7.0, producing a voltage-to-pH conversion curve. Most pH sensor modules ship with calibration instructions.

**Light sensor**

The BH1750 is a digital ambient light sensor that communicates over I2C and outputs values directly in lux. It is considerably more accurate than simple photoresistors and does not require analog calibration. Use the BH1750 library by Christopher Laws. The sensor is addressed at 0x23 by default (ADDR pin low).

**Ultrasonic distance sensor**

The HC-SR04 measures the distance from the sensor face to the water surface in a reservoir. The water level percentage is calculated from this distance relative to the known reservoir depth. Trigger on one digital pin, read the echo pulse duration on another. The conversion formula in `getWaterLevel()` depends on your reservoir dimensions.

**PIR motion sensor**

Any standard HC-SR501 or equivalent passive infrared motion sensor. Output is a digital HIGH when motion is detected, LOW when not. The sensitivity and hold time are typically adjustable with two potentiometers on the module.

**Solar panel and battery (optional)**

LeafLink includes a Power and Solar page for setups where the microcontroller is running on a battery charged by a solar panel. A 6W solar panel paired with a TP4056-based lithium charging module and an 18650 cell is a common configuration. The `getBatteryPct()` and `getSolarWatts()` functions need to be implemented for your specific hardware — typically by reading an analog voltage divider for the battery and a current sensor for the solar input.

---

## Wiring reference

The following pin assignments match the firmware example. Adjust them to suit your actual board layout.

**Arduino Uno / Nano**

```
Soil Moisture (analog)   -- A0
DHT22 (data)             -- D2
pH Sensor (analog)       -- A1
BH1750 SDA               -- A4
BH1750 SCL               -- A5
HC-SR04 Trigger          -- D9
HC-SR04 Echo             -- D10
PIR Sensor (digital out) -- D7
```

**ESP32**

```
Soil Moisture (analog)   -- GPIO34 (input only, ADC1)
DHT22 (data)             -- GPIO4
pH Sensor (analog)       -- GPIO35 (input only, ADC1)
BH1750 SDA               -- GPIO21
BH1750 SCL               -- GPIO22
HC-SR04 Trigger          -- GPIO5
HC-SR04 Echo             -- GPIO18
PIR Sensor (digital out) -- GPIO15
```

Note that the ESP32 has two ADC units. ADC2 pins (GPIO0, 2, 4, 12 to 15, 25 to 27) are unavailable when Wi-Fi is active. Stick to ADC1 pins (GPIO32 to 39) for analog sensors if you plan to use Wi-Fi.

---

## Firmware and serial output

The only hard requirement for LeafLink is that the device sends complete JSON objects over serial, each ending with a newline character (`\n`). The keys must match exactly — lowercase, no spaces. The dashboard looks for `moisture`, `temp`, `humidity`, `ph`, `light`, `water`, and `pir`. The `battery` and `solar` keys are optional.

Any key that is absent from a packet is simply ignored — the dashboard holds the previous value for that sensor. Any key that is present but not a valid number is also ignored. This means you can send partial packets if some sensors are temporarily unavailable, and the rest of the dashboard will continue working normally.

A minimal, self-contained firmware example for Arduino:

```cpp
#include <DHT.h>
#include <Wire.h>
#include <BH1750.h>

#define DHT_PIN    2
#define DHT_TYPE   DHT22
#define PIR_PIN    7
#define TRIG_PIN   9
#define ECHO_PIN   10
#define MOISTURE_PIN A0
#define PH_PIN     A1

#define RESERVOIR_DEPTH_CM 20.0   // adjust to match your container

DHT    dht(DHT_PIN, DHT_TYPE);
BH1750 lightMeter;

void setup() {
  Serial.begin(9600);
  dht.begin();
  Wire.begin();
  lightMeter.begin();
  pinMode(PIR_PIN, INPUT);
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
}

float getWaterLevel() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  long duration = pulseIn(ECHO_PIN, HIGH);
  float distanceCm = duration * 0.034 / 2.0;
  float pct = (1.0 - (distanceCm / RESERVOIR_DEPTH_CM)) * 100.0;
  return constrain(pct, 0, 100);
}

float readPH() {
  // Replace with your calibrated voltage-to-pH formula.
  // Example for a generic pH module:
  int raw = analogRead(PH_PIN);
  float voltage = raw * (5.0 / 1023.0);
  return 3.5 * voltage + 0.0;  // calibrate these constants with buffer solutions
}

void loop() {
  float moisture  = (analogRead(MOISTURE_PIN) / 10.24);
  float temp      = dht.readTemperature();
  float humidity  = dht.readHumidity();
  float ph        = readPH();
  float light     = lightMeter.readLightLevel();
  float water     = getWaterLevel();
  int   pir       = digitalRead(PIR_PIN);

  if (!isnan(temp) && !isnan(humidity)) {
    Serial.print("{\"moisture\":");  Serial.print(moisture, 1);
    Serial.print(",\"temp\":");      Serial.print(temp, 1);
    Serial.print(",\"humidity\":");  Serial.print(humidity, 1);
    Serial.print(",\"ph\":");        Serial.print(ph, 2);
    Serial.print(",\"light\":");     Serial.print((int)light);
    Serial.print(",\"water\":");     Serial.print(water, 1);
    Serial.print(",\"pir\":");       Serial.print(pir);
    Serial.println("}");
  }

  delay(2000);
}
```

The DHT22 guard (`if (!isnan(temp) && !isnan(humidity))`) is important. The DHT22 can return NaN on failed reads, and sending NaN in a JSON field would break the parser on the dashboard side. The simplest fix is to skip that packet entirely and try again on the next loop cycle.

The `delay(2000)` at the end gives the DHT22 enough time between readings. The DHT22 can only sample once every two seconds. Going faster than this will produce read errors.

---

## Connecting your microcontroller

**Step 1 — Flash the firmware**

Write your firmware, set your baud rate, and upload it to the board using the Arduino IDE or PlatformIO. Open the Serial Monitor at the same baud rate and confirm that valid JSON is coming through before you try to connect from LeafLink. It is much easier to debug the firmware output in the Arduino Serial Monitor than to troubleshoot it through the browser.

A correct output line looks exactly like this, with no extra spaces, no trailing characters other than the newline, and all values as numbers not strings:

```
{"moisture":68.0,"temp":24.5,"humidity":62.0,"ph":6.40,"light":820,"water":74.0,"pir":0}
```

**Step 2 — Close the Arduino Serial Monitor**

This is a step that is easy to forget. Only one application can hold the serial port open at a time. If the Arduino Serial Monitor (or any other terminal) still has the port open, Chrome will not be able to request it. Close the Serial Monitor completely before trying to connect from LeafLink.

**Step 3 — Open the dashboard in Chrome or Edge**

Open `index.html` directly from your file system. Chrome will show a `file://` URL in the address bar. This is fine — the Web Serial API works in the `file://` context. No local server is needed.

**Step 4 — Click Connect Device**

The button is in the top-right corner of the navigation bar. A modal will appear with three configuration fields: baud rate, data bits, and stop bits. The baud rate must match exactly what your firmware uses in `Serial.begin()`. If your firmware says `Serial.begin(9600)`, select 9600 from the dropdown. Data bits should be 8 and stop bits should be 1 for almost all Arduino and ESP32 setups — only change these if you have a specific reason to.

Click the Connect button inside the modal. Chrome will open a port picker dialog showing every available serial port on the system. Your board will typically appear as one of the following names depending on the USB-to-serial chip it uses:

- USB Serial Device (the generic Windows label)
- CH340 or CH341 (used on many inexpensive Arduino clones and ESP32 boards)
- CP2102 or CP210x (used on many ESP32 devkits)
- FTDI (used on official Arduino Uno R3 and older boards)
- Arduino Uno on COMx (Windows sometimes labels it with the board name)
- /dev/ttyUSB0 or /dev/ttyACM0 (Linux)
- /dev/cu.usbserial-* or /dev/cu.SLAB_USBtoUART (macOS)

Select the right port and click Connect in the picker.

**Step 5 — Wait for the first packet**

After the port opens, the modal will close automatically and a toast notification will appear saying "Device connected — waiting for first packet." The nav bar status dot turns amber while waiting. The first valid JSON packet triggers the full UI reveal — all no-device banners disappear, sensor cards populate with real numbers, and charts initialize. The status dot turns green and stays that way as long as data is flowing.

---

## Sensors supported

| Sensor | JSON key | Unit | Hardware | Notes |
|---|---|---|---|---|
| Soil Moisture | `moisture` | % | Resistive or capacitive probe | Raw analog divided by 10.24 for Arduino 10-bit ADC |
| Temperature | `temp` | C | DHT22 / AM2302 | Shared sensor with humidity |
| Humidity | `humidity` | % | DHT22 / AM2302 | Shared sensor with temperature |
| Soil pH | `ph` | pH | Analog pH module | Requires calibration with buffer solutions |
| Light Intensity | `light` | lux | BH1750 (I2C) | Returns lux directly; no calibration needed |
| Water Level | `water` | % | HC-SR04 ultrasonic | Calculated from distance to water surface |
| PIR Motion | `pir` | 0 or 1 | HC-SR501 or equivalent | 1 means motion detected; 0 means clear |
| Battery Level | `battery` | % | Analog voltage divider + ADC | Optional; only used on Power page |
| Solar Input | `solar` | W | Current sensor (e.g. INA219) | Optional; peak assumed at 6W on the ring chart |

All values must be sent as JSON numbers, not strings. `"moisture":68` is correct. `"moisture":"68"` will be rejected by the parser.

---

## Alert thresholds

Alerts are evaluated fresh on every incoming packet. The `sensorStatus()` function in `script.js` handles this logic. It returns one of three states for each sensor: no class (normal), `warn` (amber), or `danger` (red). The card color, the status line text, and the alert panel entry all respond to the returned state.

**Soil Moisture**

The optimal range for most houseplants and common crops is 45% to 85% volumetric water content as reported by the sensor.

- Below 30%: Dry — Water Soon (danger)
- 30% to 44%: Low Moisture (warning)
- 45% to 85%: Optimal (normal)
- Above 85%: Overwatered (warning)

**Temperature**

Comfortable range for most tropical and subtropical plants.

- Below 15 C: Too Cold (warning)
- 15 C to 35 C: Comfortable (normal)
- Above 35 C: Too Hot (danger)

**Humidity**

Ambient air humidity around the plant canopy.

- Below 35%: Very Dry Air (warning)
- 35% to 85%: Good (normal)
- Above 85%: Very Humid (warning)

**Soil pH**

The pH range where most nutrient uptake pathways are active. Outside this range, certain nutrients become chemically unavailable to roots even if they are physically present in the soil.

- Below 5.5: Too Acidic (danger)
- 5.5 to 7.5: Optimal (normal)
- Above 7.5: Too Alkaline (warning)

**Light Intensity**

Expressed in lux. Full direct sunlight outdoors is around 100,000 lux. A bright windowsill indoors is typically 1,000 to 3,000 lux. Shade-tolerant plants can get by on 200 lux or less.

- Below 200 lux: Very Low Light (warning)
- 200 to 399 lux: Low Light (warning)
- 400 lux and above: Bright (normal)

**Water Level**

Percentage of the reservoir that is currently filled, measured by the ultrasonic sensor.

- Below 20%: Critically Low (danger)
- 20% to 39%: Low (warning)
- 40% and above: Sufficient (normal)

**PIR Motion**

The PIR sensor is binary — it either detects motion or it does not. When it detects motion, the card switches to the warning state with the text "Motion Detected!" When there is no motion it shows "No Motion" in the normal state.

---

## Pages in detail

**Dashboard**

The Dashboard is the default landing page. It is divided into four sections. At the top is the page header, which shows a time-of-day greeting, the system status badge, and a live clock that ticks every second. Below that are the seven sensor cards arranged in a responsive grid. Each card shows an icon drawn in CSS, the current sensor value in a large number, a unit label, a horizontal progress bar scaled to the sensor's expected range, and a plain-language status line.

Below the sensor cards is the alerts panel, which lists any out-of-range readings as colored notification rows with danger items first and warning items second. If all sensors are normal it shows a single line confirming that. At the bottom is the Today's Overview chart, which plots moisture, temperature, and humidity on a shared time axis using the last 60 readings.

Before a device is connected, every section displays a dashed banner explaining that no device is linked yet and pointing the user toward the Connect Device button. These banners disappear the moment the first valid packet arrives.

**Sensor Data**

The Sensor Data page provides four individual trend charts for closer inspection: moisture and humidity on a shared chart, temperature alone, light intensity alone, and soil pH alone. Each chart shows up to the last 60 readings on a rolling window — the oldest entries drop off the left side as new ones arrive on the right.

Below the charts is a real-time readings table with a row for each sensor showing the current value, the session minimum, the session maximum, and a colored status badge. The Refresh button at the top of the page rebuilds the charts and repopulates the table from the current state — useful if you have navigated away and come back after a lot of readings have accumulated, or if charts did not initialize because the page was not active when the first packet arrived.

**Power and Solar**

The Power and Solar page displays three animated SVG ring charts: battery level in blue, solar input in amber, and estimated runtime in grey-blue. The rings animate smoothly as values change using CSS stroke-dashoffset transitions.

The battery ring fills based on the incoming `battery` value from 0 to 100%. The solar ring fills based on the incoming `solar` value relative to a 6W maximum. The runtime ring mirrors the battery ring and shows a rough estimate of hours remaining calculated as `(battery / 100) * 24` — a simplified linear approximation based on a 24-hour baseline rather than a measurement of actual power draw.

Below the rings is a trend chart showing battery percentage and solar wattage over the full session, and a power notifications panel that shows context-aware messages about whether the solar panel is currently generating power, whether the battery is healthy, or whether a low battery warning needs attention.

**History**

The History page is the session log. It shows a full chart of all three main sensors (moisture, temperature, humidity) across the entire session, four summary cards showing session averages for moisture, temperature, light, and pH, and a data table showing the 50 most recent readings in reverse chronological order. The averages and the table both update live as new readings arrive.

The Export CSV button at the top right of the page header downloads the complete session log (up to 200 rows) as a comma-separated file with headers and one row per reading. The button is disabled until the first packet arrives and greys out again after a disconnect.

**About**

The About page is documentation embedded directly in the dashboard. It includes a hero section describing the system, a numbered four-step connection guide with the firmware code snippet, six sensor information cards explaining how each physical sensor works and what it measures, and a sustainability block describing the solar power rationale. The page exists so that anyone opening the dashboard without prior context can understand what the system is and how to get it running without leaving the browser tab.

---

## Data history and export

LeafLink stores up to 200 readings in the `sessionLog` array in memory. Each entry is a plain object containing the timestamp string and all sensor values as numbers, or null if that sensor did not report in that packet.

Separately, each of the seven main sensors maintains its own rolling `sensorHistory` array capped at 60 entries. This is what powers the live trend charts — it is a shorter, faster window focused on recent readings, whereas `sessionLog` is the full archive used by the History page and the CSV export.

The History page calculates session averages by iterating over `sessionLog`, filtering out null values for each sensor key, summing the valid values, and dividing by the count. These averages recalculate and re-render on every incoming packet.

The CSV export flattens `sessionLog` into a text table with the following columns:

```
Time, Moisture (%), Temp (°C), Humidity (%), Soil pH, Light (lux), Water Level (%)
```

Battery and solar are not currently included in the CSV export. Values are formatted to one or two decimal places depending on the sensor. Missing values (null) are written as empty fields so the CSV remains valid for import into Excel, Google Sheets, or any other spreadsheet application.

Everything in memory is lost when the page is refreshed or the tab is closed. This is intentional — LeafLink does not write to localStorage, IndexedDB, or any other persistent storage. If you want to keep the data from a session, export the CSV before closing the tab.

---

## How the serial pipeline works

Understanding the serial data flow is useful when debugging connection issues or writing firmware.

When you click Connect in the modal, the browser calls `navigator.serial.requestPort()`, which triggers the native port picker dialog. Once a port is selected, `serialPort.open()` is called with the baud rate, data bits, and stop bits from the modal form. If that succeeds, `startReadLoop()` is called.

The read loop pipes `serialPort.readable` through a `TextDecoderStream` to decode the raw bytes into UTF-8 text. A `ReadableStreamDefaultReader` is obtained from the decoded stream and a `while` loop calls `reader.read()` in a continuous await cycle. Each call resolves with a chunk of text — a fragment of whatever the device has sent since the last read. Chunks do not correspond to individual lines. A single chunk might contain half a line, one full line, or several lines at once depending on timing, baud rate, and USB buffering.

To handle fragmented chunks reliably, every incoming chunk is appended to a `serialBuffer` string. After each append, `flushBuffer()` is called. This function splits the buffer on `\n`, processes every segment except the last (which may be incomplete), and puts the remainder back into `serialBuffer` to wait for the rest of it to arrive. This guarantees that only complete, newline-terminated strings reach the JSON parser — never a partial line.

Each complete string is trimmed and passed to `JSON.parse()`. If parsing succeeds, the result object goes to `ingestPacket()`. If parsing fails because the line is a debug message, a startup banner, a DHT error message, or anything else that is not valid JSON, the line is appended to the serial monitor log inside the connection modal and silently discarded. It does not cause an error or interrupt the data stream.

When the device disconnects unexpectedly because the cable is pulled or power is lost, the `reader.read()` call eventually rejects with an error. The catch block in the read loop checks `readLoopActive` to confirm this was not a deliberate stop, then calls `disconnectSerial()`. That function sets `readLoopActive` to false, cancels the reader, closes the port object, resets all state variables, and restores the entire UI to the empty "waiting for device" state.

---

## How the state model works

All live sensor data lives in two objects at the top of `script.js`: `sensorState` and `powerState`.

`sensorState` is a fixed-shape object with one entry per sensor. Each entry holds the current `value` as a number or null, the `unit` string for display, and the human-readable `label`. Values start as null and stay null until the device sends a reading for that key. The object never changes shape — only the `value` fields are mutated.

```javascript
const sensorState = {
  moisture: { value: null, unit: '%',   label: 'Soil Moisture' },
  temp:     { value: null, unit: '°C',  label: 'Temperature' },
  humidity: { value: null, unit: '%',   label: 'Humidity' },
  ph:       { value: null, unit: 'pH',  label: 'Soil pH' },
  light:    { value: null, unit: 'lux', label: 'Light Intensity' },
  water:    { value: null, unit: '%',   label: 'Water Level' },
  pir:      { value: null, unit: '',    label: 'PIR Sensor' },
};
```

`powerState` is simpler — just `{ battery: null, solar: null }`. These are updated only when the corresponding keys appear in an incoming packet.

Each sensor also has a rolling history array in `sensorHistory`. When `ingestPacket()` runs, it updates `sensorState[key].value` and pushes the new value onto `sensorHistory[key]`, then shifts the oldest entry off if the array exceeds 60 items. The parallel `histLabels` array holds the timestamp strings that correspond to each position in the history arrays — these become the x-axis tick labels on all trend charts.

The `sessionLog` array is separate from both of those structures. It accumulates one flat object per packet, copying all current sensor values and the timestamp into a plain record. This is the source of truth for the History page and the CSV export.

When `disconnectSerial()` runs, it calls `resetToEmptyState()`, which sets all `sensorState` values to null, empties all `sensorHistory` arrays, clears `histLabels`, nulls `powerState`, sets `firstPacket` back to true, and destroys all Chart.js instances. The next connection starts with a completely clean slate.

---

## How the charts work

All charts use Chart.js 4.4.1 loaded from cdnjs. There are seven chart instances managed through the `allCharts` object: `dash` on the Dashboard, `moisture`, `temp`, `light`, and `ph` on the Sensor Data page, `power` on the Power page, and `history` on the History page.

Charts are built lazily — they are only initialized when the page they live on becomes the active page. On the first packet, `initAllCharts()` is called, but it only builds the chart for the currently visible page. When the user navigates to another page, `showPage()` calls the relevant init function if a connection is active. This avoids wasting time initializing canvases that are not visible and cannot render correctly.

All line datasets are created through the `lineDS()` helper function, which produces a consistently styled Chart.js dataset object: no visible data points except on hover, a subtle filled gradient beneath the line, a smooth bezier tension of 0.42, and a borderWidth of 2. Shared chart configuration (tooltip style, axis tick fonts, grid line opacity, responsive flag, animation duration) lives in `chartOpts()` and is spread into every chart's options object.

Live updates during active data streaming do not rebuild charts. They push new arrays into the existing `chart.data.labels` and `chart.data.datasets[n].data` references and call `chart.update('none')`. The `'none'` mode skips Chart.js animation entirely on updates so the values appear instantaneously. Animation only plays on the initial render when a chart is first created.

The ring charts on the Power page are not Chart.js — they are hand-written SVG. Each ring is a `<circle>` element with `stroke-dasharray` set to 314 (the circumference of a circle with radius 50 at the scale used) and `stroke-dashoffset` controlled by inline style. Setting the offset to `314 * (1 - fraction)` produces the correct arc fill. A CSS transition of 1.2 seconds with a cubic-bezier easing curve makes the rings animate smoothly when values change.

---

## How the CSS icons work

LeafLink uses no images, no SVG files, and no icon fonts. Every icon in the dashboard is drawn entirely with CSS using `::before` and `::after` pseudo-elements on empty `<span>` elements with meaningful class names like `icon-drop`, `icon-thermometer`, and `icon-sun`.

The technique works by combining border tricks, box-shadow, clip-path, and the `content` property to form recognizable shapes. A few examples of how specific icons are constructed:

The water drop icon uses `::before` for the circular base (a `border-radius: 50%` circle) and `::after` for the pointed top using the standard CSS border triangle — a zero-width, zero-height element with transparent left and right borders and a solid bottom border, which forces the browser to render a filled triangle.

The sun icon uses a single `::before` pseudo-element with a small filled circle as the sun body and a `box-shadow` list with eight values, each offset diagonally or axially at the same radius, to create evenly distributed rays around the center without any additional markup.

The pH icon uses `content: 'pH'` on the `::before` pseudo-element with flexbox centering and a circular border to render the two letters inside a circle shape, essentially using text as the icon.

The USB connector icon uses `::before` for the rectangular connector body (a bordered box with a border-radius of 1px) and `::after` for the forked prongs — a thin bar with two `box-shadow` offsets to the left and right that simulate the two prongs of a USB-A connector, all without additional elements.

All icons inherit their color from the `currentColor` keyword, meaning they automatically pick up the color of the element they are placed inside. This makes theming easy: the `.warn` and `.danger` state classes change the text color of the card, and the icons shift color automatically without needing separate override rules.

---

## Customization

**Changing the color scheme**

All color values are defined as CSS custom properties in the `:root` block at the very top of `styles.css`. Changing any one of these will update every element that references that variable:

```css
:root {
  --primary:   #011f4b;   /* main dark blue; nav bar, headings, primary text */
  --secondary: #03396c;   /* slightly lighter blue; subheadings, section labels */
  --accent:    #005b96;   /* mid blue; card bars, chart lines, connect button */
  --bg:        #b3cde0;   /* page background */
  --soft:      #6497b1;   /* muted blue; secondary text, icon fills, timestamps */
  --white:     #f4f8fc;   /* near-white; card surfaces, nav text */
  --card-bg:   rgba(244,248,252,0.84);  /* frosted glass card background */
  --border:    rgba(1,31,75,0.10);      /* card and section borders */
}
```

**Changing alert thresholds**

Open `script.js` and find the `sensorStatus()` function. Each sensor has its own `case` block in the switch statement. The return object has three fields: `text` for the status line string, `cls` for the card CSS class (empty string for normal, `'warn'`, or `'danger'`), and `tdCls` for the table badge class (`'td-ok'`, `'td-warn'`, or `'td-danger'`).

To change the moisture danger threshold from 30% to 25%:

```javascript
case 'moisture':
  if (value < 25)  return { text:'Dry — Water Soon', cls:'danger', tdCls:'td-danger' };
  if (value < 45)  return { text:'Low Moisture',     cls:'warn',   tdCls:'td-warn'   };
  // rest unchanged
```

**Changing chart appearance**

The `lineDS()` function controls the dataset style. To increase the line thickness, add `borderWidth: 3` to the returned object. To show data points on the line at all times (not just on hover), change `pointRadius: 0` to `pointRadius: 3`. To adjust the smoothness of the curve, change the `tension` value — 0 gives straight lines, 0.5 gives a more pronounced curve.

The `chartOpts()` function controls axis labels, grid lines, tooltips, and animation. Any Chart.js configuration option can be added or modified here.

**Changing the session log size**

The `MAX_SESSION` constant at the top of `script.js` controls how many readings are retained in memory. The default is 200. The `MAX_HIST` constant controls the rolling history length used by trend charts; its default is 60. Raise either if you want more data depth, lower them if you are running on constrained hardware or sending packets at a very high frequency.

**Adding a new sensor**

To add an eighth sensor, you would need to add a new `sensor-card` div to `index.html` following the existing id naming pattern (`card-X`, `val-X`, `unit-X`, `bar-X`, `status-X`); add a new CSS icon class to `styles.css`; add the key to `sensorState` and `sensorHistory` in `script.js`; add a case to `sensorStatus()` with threshold logic; add the range to `barPct()`; and add the key to the session log schema and the CSV export headers and columns.

---

## Troubleshooting

**The Connect Device button shows a warning and is disabled**

Your browser does not support the Web Serial API. Switch to Google Chrome or Microsoft Edge version 89 or later. The warning message appears immediately when the modal opens if `'serial' in navigator` returns false.

**Chrome shows the port picker but the board does not appear in the list**

The USB driver for your board's serial chip may not be installed on the host computer. On Windows, open Device Manager and look for unknown devices or devices with yellow warning icons under "Ports (COM and LPT)". Common driver downloads: CH340/CH341 driver from the WCH website, CP210x driver from Silicon Labs, FTDI VCP driver from FTDI Chip. On macOS, the CH340 driver sometimes needs to be installed manually as it is not included with the OS.

**The port appears in the picker but the connection fails immediately after selecting it**

Another application has the port open. Close the Arduino Serial Monitor, PlatformIO Serial Monitor, any terminal running `screen` or `minicom`, and any other program that may have claimed the port. On Windows, sometimes just unplugging and replugging the USB cable is enough to release a stale handle.

**The connection succeeds but no data appears and the first packet never comes**

The baud rate in the modal does not match `Serial.begin()` in your firmware. Open the modal again with the Disconnect state, change the baud rate to match your firmware exactly, and reconnect. The baud rate must be identical on both sides down to the exact number — 9600 and 115200 are not interchangeable.

**Data appears in the serial monitor log but sensor cards stay empty**

The incoming data is not valid JSON. Check the serial monitor in the modal for the raw lines. Common causes: extra debug print statements before the JSON line, the firmware is using `Serial.print` rather than `Serial.println` so there is no newline delimiter, or the JSON has a formatting error like a missing closing brace or a NaN value from a failed DHT read.

**The connection succeeds but the data looks garbled in the serial monitor**

Garbled output — random characters, misaligned text, wrong encoding — is the classic symptom of a baud rate mismatch. The receiver and transmitter are interpreting the bit timing differently. Make sure the baud rate in `Serial.begin()` matches the selection in the LeafLink modal exactly.

**The DHT22 keeps returning NaN and packets are not being sent**

The DHT22 requires a pull-up resistor (typically 10K ohm) between the data pin and VCC. Many breakout boards include this, but bare sensors do not. Also verify that `delay(2000)` or longer is present at the end of the loop — the DHT22 cannot be sampled more frequently than once every two seconds. Sampling faster than this produces read failures.

**The charts do not appear on the Sensor Data page after navigating there**

Charts on the Sensor Data page are only initialized when that page is active. If you were on a different page when the first packet arrived, the Sensor Data charts were not built. Navigate to the page while connected and click the Refresh button to force initialization.

**The water level percentage reads 0% or over 100%**

The `RESERVOIR_DEPTH_CM` constant in the firmware does not match the physical distance from your HC-SR04 sensor face to the bottom of the empty reservoir. Measure this distance accurately and update the constant. Also confirm that the sensor is mounted directly above the water surface and is not at an angle.

**The page is slow or the browser tab is consuming a lot of memory**

Lower `MAX_HIST` and `MAX_SESSION` in `script.js`. At the default packet interval of 2 seconds, 200 session entries represents about 6.5 minutes of data. If your device sends packets every 500ms, 200 entries is only 100 seconds. Adjust the limits to match your actual use case. You can also increase the `delay()` in the firmware to reduce the packet frequency.

---

## Known limitations

No data persistence. All session data lives only in memory and is lost when the tab is refreshed or closed. There is no write to localStorage, IndexedDB, cookies, or any server. If long-term logging is needed, export CSV regularly or extend the project with a local backend.

One device at a time. The dashboard is designed around a single serial connection. There is no interface for selecting between multiple connected boards or merging streams from two ports.

Session log does not account for time gaps. If the device stops sending for several minutes and then resumes, the chart will connect the last reading before the gap to the first reading after it with a straight line. The timestamps will be accurate, but the visual will not show a break in the data.

Battery runtime estimate is approximate. The estimated runtime on the Power page is `(battery / 100) * 24` hours. It does not factor in actual power consumption rate, solar charging input, or varying loads. It is a rough directional number.

pH calibration is the user's responsibility. The dashboard has no way to validate whether the pH sensor is calibrated correctly. If the sensor is drifting or was never calibrated with buffer solutions, the displayed values and alerts will be wrong.

No mobile Web Serial support. Chrome on Android does not support the Web Serial API. The dashboard renders correctly on mobile screens but the Connect Device button will not work. The system is intended for desktop and laptop use.

---

## Technical notes

The Web Serial API requires a user gesture — specifically a button click — to open a port. This is a browser security policy and cannot be bypassed. The dashboard cannot auto-connect on page load, cannot remember a previously selected port between sessions without another click, and cannot silently re-open a port after a disconnect without user action.

The `firstPacket` boolean flag is the gate between the empty UI and the live UI. It is set to `true` on page load and after every disconnect, and flipped to `false` by the first valid call to `ingestPacket()`. That flip triggers `revealLiveUI()`, which hides all no-device banners, shows all content sections, and removes the `no-data` class from all sensor cards simultaneously. The cards fading in together is caused by the existing `fadeInUp` CSS animation that is already applied to most content blocks.

The greeting text in the dashboard header is set once on `DOMContentLoaded` by reading `new Date().getHours()` and choosing between "Good morning", "Good afternoon", and "Good evening". It does not update while the page is open. If you load the page at 11:59pm and leave it running, it will say "Good evening" all morning.

Chart.js global defaults are overridden at the top of `script.js` for `font.family` and `color` to align with the LeafLink design system. These global settings apply automatically to every chart instance so the same font and muted tick color do not need to be repeated in every `chartOpts()` invocation.

The `showPage()` function is the only mechanism for changing the visible page. It removes `active` from all `.page` elements, adds it to the target, and synchronizes the active highlight on the nav buttons. If a connection is live and the session log is non-empty, it also calls the appropriate chart init function for the newly active page. This is why navigating between pages while connected does not lose any data — `sensorState`, `sensorHistory`, and `sessionLog` all persist in memory independently of which page is visible.

All sensor card progress bars are driven by the `barPct()` function, which maps each sensor's raw value onto a 0 to 100 percentage using a predefined expected range per sensor. Soil moisture and humidity map to their natural 0 to 100% ranges. Temperature maps from 10 C to 45 C. Soil pH maps from 3 to 10. Light maps from 0 to 1200 lux. This means a light reading of 1200 lux fills the bar completely, and anything above that clips at 100%.

---

## External dependencies

| Dependency | Version | How it is loaded | Purpose |
|---|---|---|---|
| Chart.js | 4.4.1 | cdnjs CDN script tag in index.html | All line charts and chart configuration |
| Montserrat | variable | Google Fonts link tag | Page headings, sensor value numbers, brand name |
| Roboto | variable | Google Fonts link tag | Labels, subheadings, table headers, nav links |
| Open Sans | variable | Google Fonts link tag | Body text, alert descriptions, card status lines |
| Roboto Mono | variable | Google Fonts link tag | Timestamps, unit labels, code blocks, serial log |

No npm packages are used, no bundler is involved, and nothing needs to be compiled. All JavaScript is standard ES2017 using async/await, which is supported in every browser that also supports the Web Serial API. If Chart.js fails to load from the CDN, the charts will not render but all other dashboard functionality including serial connection, sensor cards, alerts, and data logging will continue to work.

---

## License

Built for smart, sustainable plant care. LeafLink is a self-contained client-side application with no server component and no external data transmission. All sensor readings stay on the local machine. No analytics, no telemetry, no external API calls beyond the CDN and font requests.
