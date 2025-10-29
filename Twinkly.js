// Twinkly.js — SignalRGB integration (lag-reduced)
// Notes:
// - Avoids O(n^2) splice in frame builder
// - Adds FPS limiter
// - Makes token checks non-blocking
// - Fixes 2D layout (Y axis)
// - Uses imported base64 encode/decode consistently
// - ADDED: Caches RGBData array to eliminate GC lag
// - ADDED: Implements Shutdown() to force device "off"

import { encode, decode } from "@SignalRGB/base64";

export function Name() { return "Twinkly"; }
export function Version() { return "1.0.1"; }
export function Type() { return "network"; }
export function Publisher() { return "WhirlwindFX (perf-tuned)"; }
export function Size() { return [48, 48]; }
export function DefaultPosition() { return [75, 70]; }
export function DefaultScale(){ return 1.0; }

/* global
discovery:readonly
controller:readonly
shutdownColor:readonly
LightingMode:readonly
forcedColor:readonly
autoReconnect:readonly
xScale:readonly
yScale:readonly
fpsLimit:readonly
*/

export function ControllableParameters() {
  return [
    {"property":"shutdownColor", "group":"lighting", "label":"Shutdown Color", "min":"0", "max":"360", "type":"color", "default":"#009bde"},
    {"property":"LightingMode", "group":"lighting", "label":"Lighting Mode", "type":"combobox", "values":["Canvas", "Forced"], "default":"Canvas"},
    {"property":"forcedColor", "group":"lighting", "label":"Forced Color", "min":"0", "max":"360", "type":"color", "default":"#009bde"},
    {"property":"autoReconnect", "group":"", "label":"Auto Reconnect to Devices When Lost", "type":"boolean", "default": "false"},
    {"property":"xScale", "group":"", "label":"Width Scale", "step":"1", "type":"number", "min":"1", "max":"10", "default":"5"},
    {"property":"yScale", "group":"", "label":"Height Scale", "step":"1", "type":"number", "min":"1", "max":"10", "default":"5"},
    // New: FPS limiter to avoid oversending frames
    {"property":"fpsLimit", "group":"", "label":"Max FPS", "step":"1", "type":"number", "min":"10", "max":"120", "default":"60"}
  ];
}

export function Initialize() {
  device.addFeature("udp");

  Twinkly.fetchFirmwareVersionFromDevice();
  Twinkly.deviceLogin(() => {
    Twinkly.verifyToken(Twinkly.getAuthenticationToken(), Twinkly.getChallengeResponse(), () => {
      Twinkly.fetchDeviceInformation(() => {
        Twinkly.fetchDeviceBrightness(() => {
          Twinkly.setDeviceBrightness("enabled", "A", 100);
          Twinkly.setLEDMode("rt");
          Twinkly.decodeAuthToken();
          Twinkly.fetchDeviceLayoutType();
          device.log("Device Initialized.");
        });
      });
    });
  });
}

let _lastFrameSentAt = 0;
// --- CHANGE 1: Cache for RGB data to reduce GC lag ---
let _persistentRGBData = null; 

function shouldSendFrame() {
  const limit = Math.max(10, Math.min(120, Number(fpsLimit) || 60));
  const minDeltaMs = 1000 / limit;
  const now = Date.now();
  if ((now - _lastFrameSentAt) >= minDeltaMs) {
    _lastFrameSentAt = now;
    return true;
  }
  return false;
}

export function Render() {
  checkConnectionStatusNonBlocking();
  if (shouldSendFrame()) {
    sendColors();
  }
}

export function Shutdown(_suspend) {
  // --- CHANGE 2: Tell device to turn off synchronously on exit ---
  // This prevents it from reverting to the default blue preset.
  // We pass 'false' for async to make sure the command is sent
  // before SignalRGB closes the script.
  device.log('shutdown0');
  Twinkly.setLEDMode("off", null, false);
}

export function onxScaleChanged() {
  Twinkly.fetchDeviceLayoutType();
}

export function onyScaleChanged() {
  Twinkly.fetchDeviceLayoutType();
}

/* -------------------- Connection Health (non-blocking) -------------------- */

let lastConnectionCheckAt = 0;
const connectionCheckIntervalMs = 60000;
let lastTokenStatus = "Unknown";
let _checking = false;

function checkConnectionStatusNonBlocking() {
  const now = Date.now();
  if (_checking || (now - lastConnectionCheckAt) < connectionCheckIntervalMs) return;

  _checking = true;
  Twinkly.fetchLEDMode(true, (status) => {
    lastTokenStatus = status;
    if (status !== "Ok") {
      device.log(`Auth token invalidated (${status}).`);
      if (autoReconnect) {
        device.log("Re-authenticating and restoring RT mode...");
        Twinkly.deviceLogin(() => {
          Twinkly.verifyToken(Twinkly.getAuthenticationToken(), Twinkly.getChallengeResponse(), () => {
            Twinkly.setLEDMode("rt");
            Twinkly.decodeAuthToken();
            Twinkly.fetchDeviceLayoutType();
          });
        });
      }
    }
    lastConnectionCheckAt = Date.now();
    _checking = false;
  });
}

/* -------------------- Frame Send (no splice!) -------------------- */

function sendColors(shutdown = false) {
  const RGBData = grabColors(shutdown);

  // Twinkly gen3 RT allows ~900 bytes per packet payload here (kept same),
  // but avoid splice; index across the big array.
  const MAX_CHUNK = 900;
  let packetIDX = 0;
  for (let offset = 0; offset < RGBData.length; offset += MAX_CHUNK, packetIDX++) {
    const chunk = RGBData.slice(offset, offset + MAX_CHUNK);
    Twinkly.sendGen3RTFrame(packetIDX, chunk);
  }
}

function grabColors(shutdown) {
  const vLedPositions = Twinkly.getvLedPositions();
  const bytesPerLED = Twinkly.getNumberOfBytesPerLED();
  const stride = (bytesPerLED === 4) ? 4 : 3;

  // --- CHANGE 3: Reuse the RGBData array to prevent lag from garbage collection ---
  const requiredSize = vLedPositions.length * stride;
  if (!_persistentRGBData || _persistentRGBData.length !== requiredSize) {
    _persistentRGBData = new Array(requiredSize);
  }
  const RGBData = _persistentRGBData; // Use the cached array
  // --- END CHANGE 3 ---


  for (let iIdx = 0; iIdx < vLedPositions.length; iIdx++) {
    const iPxX = vLedPositions[iIdx][0];
    const iPxY = vLedPositions[iIdx][1];

    let col;
    if (shutdown) {
      col = hexToRgb(shutdownColor);
    } else if (LightingMode === "Forced") {
      col = hexToRgb(forcedColor);
    } else {
      col = device.color(iPxX, iPxY);
    }

    const base = iIdx * stride;
    if (stride === 4) {
      RGBData[base    ] = 0x00;    // padding/white byte for RGBW-formats on some devices
      RGBData[base + 1] = col[0];
      RGBData[base + 2] = col[1];
      RGBData[base + 3] = col[2];
    } else {
      RGBData[base    ] = col[0];
      RGBData[base + 1] = col[1];
      RGBData[base + 2] = col[2];
    }
  }

  return RGBData;
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

/* -------------------------------------------<( Discovery Service )>-------------------------------------------------- */

export function DiscoveryService() {
  this.IconUrl = "https://assets.signalrgb.com/brands/twinkly/logo.jpg";

  this.firstRun = true;

  this.Initialize = function(){
    service.log("Initializing Plugin!");
    service.log("Searching for network devices...");
    this.LoadCachedDevices();
  };

  this.UdpBroadcastPort = 5555;
  this.UdpListenPort = 59136;

  this.lastPollTime = 0;
  this.PollInterval = 60000;

  this.cache = new IPCache();
  this.activeDevices = [];

  this.CheckForDevices = function(){
    if (Date.now() - discovery.lastPollTime < discovery.PollInterval) return;
    discovery.lastPollTime = Date.now();
    service.log("Broadcasting device scan...");
    service.broadcast(`\x01discover`);
  };

  this.forceDiscover = function(ipaddress) {
    if(!ipaddress) {
      service.log(`Force Discovery IP Address is Undefined.`);
    } else {
      service.log("Forcing Discovery for Twinkly device at IP: " + ipaddress);
      this.confirmTwinklyDevice({ip : ipaddress, id: "00:00:00:00:00:00", name: "New Twinkly Device", port: "5555"});
    }
  };

  this.Update = function(){
    for (const cont of service.controllers) cont.obj.update();
    this.CheckForDevices();
  };

  this.Discovered = function(value) {
    service.log(`Response: ${value.response}`);
    if (this.activeDevices.includes(value.ip)) {
      service.log("Device Already Active! Ignoring.");
      return;
    }
    const resp = String(value.response);
    if (resp.includes("OKTwinkly") || resp.includes("WHEREAREYOU")) {
      service.log("Possible Twinkly Lights Found!");
      this.confirmTwinklyDevice(value);
    } else {
      service.log("Bad response; likely not a Twinkly.");
    }
  };

  this.LoadCachedDevices = function(){
    service.log("Loading Cached Devices...");
    for (const [key, value] of this.cache.Entries()){
      service.log(`Cached Device: [${key}: ${JSON.stringify(value)}]`);
      this.confirmTwinklyDevice(value);
    }
  };

  this.CreateControllerDevice = function(value){
    const controller = service.getController(value.id);
    if (controller === undefined) {
      service.addController(new TwinklyController(value));
    } else {
      controller.updateWithValue(value);
    }
  };

  // Make this whole flow non-blocking
  this.confirmTwinklyDevice = function(value) {
    const challengeInput = encode(Array.from({length: 32}, () => Math.floor(Math.random() * 32)));
    let bytesPerLED = 0;

    XmlHttp.Post(`http://${value.ip}/xled/v1/login`, (xhr) => {
      if (xhr.readyState !== 4) return;
      if (xhr.status !== 200) return;

      const deviceLoginPacket = JSON.parse(xhr.response);
      service.log(`Login Code: ${deviceLoginPacket.code}`);

      XmlHttp.Get(`http://${value.ip}/xled/v1/gestalt`, (xhr2) => {
        if (xhr2.readyState !== 4) return;
        if (xhr2.status !== 200) return;

        const info = JSON.parse(xhr2.response);
        if (info.code === 1000) {
          bytesPerLED = info.bytes_per_led;
          value.id = info.mac;
          value.name = info.device_name;
          service.log(`Detected ${value.name} @ ${value.ip} (bytes/LED=${bytesPerLED})`);
          if (bytesPerLED > 2) {
            this.activeDevices.push(value.ip);
            this.CreateControllerDevice(value);
          }
        }
      }, /*async=*/true);
    }, {"challenge" : challengeInput}, /*async=*/true);
  };

  this.purgeIPCache = function() {
    this.cache.PurgeCache();
  };
}

/* -------------------------------------------<( HTTP helpers )>-------------------------------------------------- */

class XmlHttp{
  static Get(url, callback, async = true){
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, async);
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.onreadystatechange = callback.bind(null, xhr);
    xhr.send();
  }

  static GetWithAuth(url, callback, authToken = Twinkly.getAuthenticationToken(), async = true){
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, async);
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.setRequestHeader("X-Auth-Token", authToken);
    xhr.onreadystatechange = callback.bind(null, xhr);
    xhr.send();
  }

  static Post(url, callback, data, async = true){
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, async);
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.onreadystatechange = callback.bind(null, xhr);
    xhr.send(JSON.stringify(data));
  }

  static PostWithAuth(url, callback, data, authToken = Twinkly.getAuthenticationToken(), async = true){
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, async);
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader("X-Auth-Token", authToken);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.onreadystatechange = callback.bind(null, xhr);
    xhr.send(JSON.stringify(data));
  }

  static Put(url, callback, data, async = true){
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, async);
    xhr.setRequestHeader("Accept", "application/json");
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.onreadystatechange = callback.bind(null, xhr);
    xhr.send(JSON.stringify(data));
  }
}

/* -------------------------------------------<( Twinkly Protocol )>-------------------------------------------------- */

class TwinklyProtocol {
  constructor() {
    this.authentication_token = "";
    this.challenge_response = "";

    this.statusCodes = {
      1000 : "Ok",
      1001 : "Error",
      1101 : "Invalid Argument",
      1102 : "Error",
      1103 : "Error, Value too long or missing required object key?",
      1104 : "Error, Malformed Json?",
      1105 : "Invalid Argument Key",
      1107 : "Ok?",
      1108 : "Ok?",
      1205 : "Error With Firmware Upgrade"
    };

    this.config = {
      firmwareVersion : "",
      hardwareRevision: "",
      previousDeviceBrightness : -1,
      numberOfDeviceLEDs : -1,
      bytesPerLED : -1,
      decodedAuthToken : [],
      vLedNames : [],
      vLedPositions : []
    };

    this.layoutScale = {
      "25x25" : 12.5,
      "50x50" : 25,
      "100x100" : 50
    };

    this.deviceSKULibrary = {
      "TWC400STP" : "Clusters",
      "TWW210SPP" : "Curtain",
      "TWD400STP" : "Dots",
      "TWF020STP" : "Festoon",
      "TWFL200STW" : "Flex",
      "TWI190SPP" : "Icicle",
      "TWWT050SPP" : "Light Tree",
      "TWP300SPP" : "Light Tree",
      "TWL100ADP" : "Line",
      "TWG050SPP" : "Garland",
      "TG70P3D93P08" : "Prelit Tree",
      "TWT400SPP" : "Prelit Tree",
      "TWT250STP" : "Prelit Tree",
      "TG70P3G21P02" : "Prelit Tree",
      "TWR050SPP" : "Prelit Wreath",
      "TWB200STP" : "Spritzer",
      "TWQ064STW" : "Squares",
      "TWS100SPP" : "Strings",
      "TWS250STP" : "Strings",
      "TWS600STP" : "Strings"
    };

    this.deviceImageLibrary = {
      "Clusters" : "https://marketplace.signalrgb.com/devices/brands/twinkly/cluster-multicolor-edition.png",
      "Curtain" : "https://marketplace.signalrgb.com/devices/brands/twinkly/curtain-multicolor-white-edition.png",
      "Dots" : "https://marketplace.signalrgb.com/devices/brands/twinkly/dots-multicolor-edition.png",
      "Festoon" : "https://marketplace.signalrgb.com/devices/brands/twinkly/festoon-multicolor-edition.png",
      "Flex" : "https://marketplace.signalrgb.com/devices/brands/twinkly/flex-multicolor-edition.png",
      "Icicle" : "https://marketplace.signalrgb.com/devices/brands/twinkly/icicle-multicolor-edition.png",
      "Light Tree" : "https://marketplace.signalrgb.com/devices/brands/twinkly/light-tree-3d-multicolor-edition.png",
      "Line" : "https://marketplace.signalrgb.com/devices/brands/twinkly/line-multicolor-edition.png",
      "Garland" : "https://marketplace.signalrgb.com/devices/brands/twinkly/prelit-garland-multicolor-edition.png",
      "Prelit Tree" : "https://marketplace.signalrgb.com/devices/brands/twinkly/prelit-tree-multicolor-edition.png",
      "Prelit Wreath" : "https://marketplace.signalrgb.com/devices/brands/twinkly/prelit-wreath-multicolor-edition.png",
      "Spritzer" : "https://marketplace.signalrgb.com/devices/brands/twinkly/spritzer-multicolor-edition.png",
      "Squares" : "https://marketplace.signalrgb.com/devices/brands/twinkly/squares-multicolor-edition.png",
      "Strings" : "https://marketplace.signalrgb.com/devices/brands/twinkly/strings-multicolor-edition.png"
    };
  }

  getvLedNames() { return this.config.vLedNames; }
  setvLedNames(vLedNames) { this.config.vLedNames = vLedNames; }

  getvLedPositions() { return this.config.vLedPositions; }
  setvLedPositions(vLedPositions) { this.config.vLedPositions = vLedPositions; }

  getFirmwareVersion() { return this.config.firmwareVersion; }
  setFirmwareVersion(firmwareVersion) { this.config.firmwareVersion = firmwareVersion; }

  getHardwareRevision() { return this.config.hardwareRevision; }
  setHardwareRevision(hardwareRevision) { this.config.hardwareRevision = hardwareRevision; }

  getPrevousDeviceBrightness() { return this.config.previousDeviceBrightness; }
  setPreviousDeviceBrightness(previousDeviceBrightness) { this.config.previousDeviceBrightness = previousDeviceBrightness; }

  getAuthenticationToken() { return this.authentication_token; }
  setAuthenticationToken(authenticationToken) { this.authentication_token = authenticationToken; }

  getDecodedAuthenticationToken() { return this.config.decodedAuthToken; }
  setDecodedAuthenticationToken(decodedAuthToken) { this.config.decodedAuthToken = decodedAuthToken; }

  getChallengeResponse() { return this.challenge_response; }
  setChallengeResponse(challenge_response) { this.config.challenge_response = challenge_response; }

  getNumberOfLEDs() { return this.config.numberOfDeviceLEDs; }
  setNumberOfLEDs(numberOfDeviceLEDs) { this.config.numberOfDeviceLEDs = numberOfDeviceLEDs; }

  getNumberOfBytesPerLED() { return this.config.bytesPerLED; }
  setNumberOfBytesPerLED(bytesPerLED) { this.config.bytesPerLED = bytesPerLED; }

  setImageFromSKU(SKU) {
    const deviceType = this.deviceSKULibrary[SKU];
    device.setImageFromUrl(this.deviceImageLibrary[deviceType]);
  }

  decodeAuthToken() {
    const token = this.getAuthenticationToken();
    const decodedToken = decode(token);  // use imported base64
    this.setDecodedAuthenticationToken(decodedToken);
  }

  fetchFirmwareVersionFromDevice(cb) {
    XmlHttp.Get(`http://${controller.ip}/xled/v1/fw/version`, (xhr) => {
      if (xhr.readyState === 4 && xhr.status === 200) {
        const p = JSON.parse(xhr.response);
        this.setFirmwareVersion(p.version);
      }
      if (cb) cb();
    });
  }

  fetchDeviceBrightness(cb) {
    XmlHttp.GetWithAuth(`http://${controller.ip}/xled/v1/led/out/brightness`, (xhr) => {
      if (xhr.readyState === 4 && xhr.status === 200) {
        const p = JSON.parse(xhr.response);
        if (p.mode === "enabled") {
          this.setPreviousDeviceBrightness(p.value);
        }
      }
      if (cb) cb();
    });
  }

  setDeviceBrightness(mode = "enabled", type = "A", value = 100, cb) {
    XmlHttp.PostWithAuth(`http://${controller.ip}/xled/v1/led/out/brightness`, (_xhr) => {
      if (cb) cb();
    }, {"mode" : mode, "type" : type, "value": value});
  }

  fetchDeviceLEDEffects() {
    XmlHttp.GetWithAuth(`http://${controller.ip}/xled/v1/led/effects`, (_xhr) => {});
  }

  fetchCurrentLEDEffect() {
    XmlHttp.GetWithAuth(`http://${controller.ip}/xled/v1/led/effects/current`, (_xhr) => {});
  }

  // statusCheck true => callback receives translated status string
  fetchLEDMode(statusCheck = false, cb = null) {
    XmlHttp.GetWithAuth(`http://${controller.ip}/xled/v1/led/mode`, (xhr) => {
      if (xhr.readyState !== 4) return;
      if (xhr.status !== 200) { if (cb) cb("Error"); return; }
      const packet = JSON.parse(xhr.response);
      let packetStatus = this.statusCodes[packet.code] || "Unknown";
      if (packet.mode !== "rt") packetStatus = "Incorrect Mode";
      if (statusCheck && cb) cb(packetStatus);
    });
  }

  // --- CHANGE 4: Allow async parameter for synchronous calls ---
  setLEDMode(LEDMode = "color", cb, async = true) {
    XmlHttp.PostWithAuth(`http://${controller.ip}/xled/v1/led/mode`, (_xhr) => {
      if (cb) cb();
    }, {"mode" : LEDMode}, this.getAuthenticationToken(), async); // <-- Pass async flag
  }

  setCurrentLEDEffect(preset_id = 0) {
    XmlHttp.PostWithAuth(`http://${controller.ip}/xled/v1/led/effects/current`, (_xhr) => {}, {"preset_id" : preset_id});
  }

  fetchDeviceInformation(cb) {
    XmlHttp.Get(`http://${controller.ip}/xled/v1/gestalt`, (xhr) => {
      if (xhr.readyState === 4 && xhr.status === 200) {
        const p = JSON.parse(xhr.response);
        this.setNumberOfBytesPerLED(p.bytes_per_led);
        this.setNumberOfLEDs(p.number_of_led);
        this.setHardwareRevision(p.hardware_version);
        device.setName(p.device_name);
        this.setImageFromSKU(p.product_code);
      }
      if (cb) cb();
    });
  }

  fetchDeviceLayoutType() {
    XmlHttp.GetWithAuth(`http://${controller.ip}/xled/v1/led/layout/full`, (xhr) => {
      if (xhr.readyState !== 4 || xhr.status !== 200) return;

      const packet = JSON.parse(xhr.response);

      const xVals = [];
      const yVals = [];

      if (packet.source === "3d") {
        for (const c of packet.coordinates) {
          xVals.push(c.x);
          yVals.push(c.z);
        }
      } else if (packet.source === "2d") {
        for (const c of packet.coordinates) {
          xVals.push(c.x);
          yVals.push(c.y); // FIX: 2D uses .y, not .z
        }
      }

      const xMax = Math.max(...xVals);
      const yMax = Math.max(...yVals);
      this.configureDeviceLayout(packet, xMax, yMax);
    });
  }

  configureDeviceLayout(packet, xMax, yMax) {
    const vLedNames = [];
    const vLedPositions = [];
    this.setvLedNames(vLedNames);
    this.setvLedPositions(vLedPositions);

    const width = 10 * xScale + 1;
    const height = 10 * yScale + 1;

    if (packet.source === "3d") {
      for (let i = 0; i < packet.coordinates.length; i++) {
        const c = packet.coordinates[i];
        const X = Math.round((c.x + 1) / xMax * (5 * xScale));
        const Y = Math.round((c.z + 1) / yMax * (5 * yScale));
        vLedPositions.push([X, Y]);
        vLedNames.push(`LED ${i + 1}`);
      }
    } else if (packet.source === "2d") {
      for (let i = 0; i < packet.coordinates.length; i++) {
        const c = packet.coordinates[i];
        const X = Math.round((c.x + 1) / xMax * (5 * xScale));
        const Y = Math.round((c.y + 1) / yMax * (5 * yScale)); // FIX: proper Y for 2D
        vLedPositions.push([X, Y]);
        vLedNames.push(`LED ${i + 1}`);
      }
    }

    this.setvLedNames(vLedNames);
    this.setvLedPositions(vLedPositions);
    device.setSize([width, height]);
    device.setControllableLeds(this.getvLedNames(), this.getvLedPositions());
  }

  deviceLogin(cb) {
    const challengeInput = encode(Array.from({length: 32}, () => Math.floor(Math.random() * 32)));
    XmlHttp.Post(`http://${controller.ip}/xled/v1/login`, (xhr) => {
      if (xhr.readyState === 4 && xhr.status === 200) {
        const p = JSON.parse(xhr.response);
        this.setAuthenticationToken(p.authentication_token);
        this.setChallengeResponse(p["challenge-response"]);
      }
      if (cb) cb();
    }, {"challenge" : challengeInput});
  }

  verifyToken(token, challenge_response, cb) {
    XmlHttp.PostWithAuth(`http://${controller.ip}/xled/v1/verify`, (xhr) => {
      // We could check 1000 == Ok here, but fine to proceed either way
      if (cb) cb();
    }, {"challenge-response" : challenge_response}, token);
  }

  sendGen1RTFrame(numberOfLEDs, RGBData) {
    udp.send(controller.ip, 7777, [0x01].concat(this.getDecodedAuthenticationToken()).concat(numberOfLEDs).concat(RGBData));
  }
  sendGen2RTFrame(numberOfLEDs, RGBData) {
    udp.send(controller.ip, 7777, [0x02].concat(this.getDecodedAuthenticationToken()).concat(numberOfLEDs).concat(RGBData));
  }
  sendGen3RTFrame(packetIDX, RGBData) {
    udp.send(controller.ip, 7777, [0x03].concat(this.getDecodedAuthenticationToken()).concat([0x00, 0x00, packetIDX]).concat(RGBData));
  }
}

const Twinkly = new TwinklyProtocol();

/* -------------------------------------------<( Controller / Cache )>-------------------------------------------------- */

class TwinklyController{
  constructor(value){
    this.id = value.id;
    this.port = value.port;
    this.ip = value.ip;
    this.name = value.name;
    this.authToken = "";
    this.initialized = false;
  }

  updateWithValue(value){
    this.id = value.id;
    this.port = value.port;
    this.ip = value.ip;
    this.name = value.name;
    this.cacheControllerInfo();
    service.updateController(this);
  }

  update(){
    if (!this.initialized){
      this.initialized = true;
      this.cacheControllerInfo();
      service.updateController(this);
      service.announceController(this);
    }
  }

  login() {
    const challengeInput = encode(Array.from({length: 32}, () => Math.floor(Math.random() * 32)));
    XmlHttp.Post(`http://${this.ip}/xled/v1/login`, (xhr) => {
      if (xhr.readyState === 4 && xhr.status === 200) {
        const p = JSON.parse(xhr.response);
        this.authenticate(p["challenge-response"], p.authentication_token);
      }
    }, {"challenge" : challengeInput});
  }

  authenticate(challengeResponse, authToken) {
    XmlHttp.PostWithAuth(`http://${this.ip}/xled/v1/verify`, (xhr) => {
      if (xhr.readyState === 4 && xhr.status === 200) {
        const code = JSON.parse(xhr.response).code;
        if (code === 1000) this.authToken = authToken;
      }
    }, {"challenge-response" : challengeResponse}, authToken);
  }

  cacheControllerInfo(){
    discovery.cache.Add(this.id, {
      name: this.name,
      port: this.port,
      ip: this.ip,
      id: this.id
    });
  }
}

class IPCache{
  constructor(){
    this.cacheMap = new Map();
    this.persistanceId = "ipCache";
    this.persistanceKey = "cache";
    this.PopulateCacheFromStorage();
  }
  Add(key, value){
    service.log(`Cache add ${key}`);
    this.cacheMap.set(key, value);
    this.Persist();
  }
  Remove(key){
    this.cacheMap.delete(key);
    this.Persist();
  }
  Has(key){ return this.cacheMap.has(key); }
  Get(key){ return this.cacheMap.get(key); }
  Entries(){ return this.cacheMap.entries(); }
  PurgeCache() {
    service.removeSetting(this.persistanceId, this.persistanceKey);
    service.log("Purged IP Cache.");
  }
  PopulateCacheFromStorage(){
    const storage = service.getSetting(this.persistanceId, this.persistanceKey);
    if (storage === undefined) return;
    let mapValues;
    try { mapValues = JSON.parse(storage); } catch(e) { service.log(e); }
    if (!mapValues) return;
    this.cacheMap = new Map(mapValues);
  }
  Persist(){
    service.saveSetting(this.persistanceId, this.persistanceKey, JSON.stringify(Array.from(this.cacheMap.entries())));
  }
}