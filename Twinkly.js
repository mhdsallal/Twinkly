// Twinkly.js — SignalRGB integration
// v1.5.1-lagfix
// - HARD no-traffic while paused (after Immediate Pause OFF triggers)
// - Forced mode: send-on-change only; keepalive default 0 (disabled)
// - Early-return guardrails to avoid any UDP when not needed
// - LAG FIX: Replaced .concat() in send functions with efficient packet builder

import { encode, decode } from "@SignalRGB/base64";

export function Name(){ return "Twinkly"; }
export function Version(){ return "1.5.1-lagfix"; }
export function Type(){ return "network"; }
export function Publisher(){ return "msallal (lagfix by Gemini)"; }
export function Size(){ return [48,48]; }
export function DefaultPosition(){ return [75,70]; }
export function DefaultScale(){ return 1.0; }

export function ControllableParameters(){
  return [
    {"property":"shutdownColor","group":"lighting","label":"Shutdown/Idle Color","type":"color","default":"#000000"},
    {"property":"LightingMode","group":"lighting","label":"Lighting Mode","type":"combobox","values":["Canvas","Forced"],"default":"Canvas"},
    {"property":"forcedColor","group":"lighting","label":"Forced Color","type":"color","default":"#FF0000"},

    {"property":"startMode","group":"power","label":"Start Mode","type":"combobox","values":["Off","RT (Live)","Restore"],"default":"RT (Live)"},
    {"property":"keepOffOnShutdown","group":"power","label":"Force Off On Shutdown/Suspend","type":"boolean","default":true},
    {"property":"sendBlackOnShutdown","group":"power","label":"Send Black Before Off (Shutdown/Suspend)","type":"boolean","default":true},

    {"property":"immediatePauseOff","group":"power","label":"Immediate Pause OFF","type":"boolean","default":true},
    {"property":"offWhenIdle","group":"power","label":"Off When Paused/Idle (fallback)","type":"boolean","default":true},
    {"property":"idleOffSeconds","group":"power","label":"Idle Off After (sec)","step":"1","type":"number","min":"2","max":"60","default":"5"},

    {"property":"autoReconnect","group":"network","label":"Auto Reconnect When Lost","type":"boolean","default":true},

    {"property":"xScale","group":"layout","label":"Width Scale","step":"1","type":"number","min":"1","max":"10","default":"5"},
    {"property":"yScale","group":"layout","label":"Height Scale","step":"1","type":"number","min":"1","max":"10","default":"5"},

    {"property":"fpsLimit","group":"performance","label":"Max FPS","step":"1","type":"number","min":"10","max":"120","default":"45"},
    {"property":"keepaliveSeconds","group":"performance","label":"Keepalive Seconds (Forced mode)","step":"1","type":"number","min":"0","max":"120","default":"0"}
  ];
}

/* ------------ runtime ------------ */
let _rtActive = false;
let _offForced = false;
let _initedOnce = false;

let _lastFrameMs = 0;            // only updated when we ACTUALLY send
let _idleTimer = null;

let _lastFrameSentAt = 0;
let _lastEnsureRt = 0;
const ENSURE_RT_INTERVAL_MS = 900;

/* Forced mode tracking */
let _forcedDirty = true;
let _lastForcedHex = "";

/* CRC diffing */
let _lastCRC = -1;

/* ------------ FPS limiter ------------ */
function shouldSendFrame(){
  const limit = Math.max(10, Math.min(120, Number(fpsLimit) || 45));
  const minDeltaMs = 1000 / limit;
  const now = Date.now();
  if ((now - _lastFrameSentAt) >= minDeltaMs){
    _lastFrameSentAt = now;
    return true;
  }
  return false;
}

/* ------------ persistent RGB buffer ------------ */
let _rgbStride = 3;
let _rgbBuffer = null;    // Uint8Array
let _rgbLedCount = 0;

function ensureRgbBuffer(){
  const bytesPerLED = Twinkly.getNumberOfBytesPerLED();
  _rgbStride = (bytesPerLED === 4) ? 4 : 3;

  const vLedPositions = Twinkly.getvLedPositions();
  const needCount = vLedPositions.length;
  const needBytes = needCount * _rgbStride;

  if (!_rgbBuffer || _rgbLedCount !== needCount || _rgbBuffer.length !== needBytes){
    _rgbLedCount = needCount;
    _rgbBuffer = new Uint8Array(needBytes);
    _lastCRC = -1; // force next send decision
  }
}

function fillRgbBuffer(useShutdownColor){
  ensureRgbBuffer();
  const vLedPositions = Twinkly.getvLedPositions();

  for (let i=0;i<vLedPositions.length;i++){
    const x = vLedPositions[i][0];
    const y = vLedPositions[i][1];

    let col;
    if (useShutdownColor) col = hexToRgb(shutdownColor);
    else if (LightingMode === "Forced") col = hexToRgb(forcedColor);
    else col = device.color(x, y);

    const base = i * _rgbStride;
    if (_rgbStride === 4){
      _rgbBuffer[base    ] = 0x00;
      _rgbBuffer[base + 1] = col[0];
      _rgbBuffer[base + 2] = col[1];
      _rgbBuffer[base + 3] = col[2];
    } else {
      _rgbBuffer[base    ] = col[0];
      _rgbBuffer[base + 1] = col[1];
      _rgbBuffer[base + 2] = col[2];
    }
  }
}

/* ------------ CRC32 ------------ */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i=0;i<256;i++){
    let c = i;
    for (let k=0;k<8;k++){
      c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)) >>> 0;
    }
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32_u8(buf){
  let crc = 0 ^ (-1);
  for (let i=0;i<buf.length;i++){
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xFF];
  }
  return (crc ^ (-1)) >>> 0;
}

/* ------------ send helpers ------------ */
function sendColors(useShutdownColor=false, allowSkipSame=true){
  fillRgbBuffer(useShutdownColor);

  if (allowSkipSame){
    const crc = crc32_u8(_rgbBuffer);
    if (crc === _lastCRC) return false;   // skip network
    _lastCRC = crc;
  }

  const MAX_CHUNK = 900;
  let packetIDX = 0;
  for (let offset=0; offset<_rgbBuffer.length; offset += MAX_CHUNK, packetIDX++){
    const view = _rgbBuffer.subarray(offset, Math.min(offset+MAX_CHUNK, _rgbBuffer.length));
    Twinkly.sendGen3RTFrame(packetIDX, view);
  }
  return true;
}

/* ------------ lifecycle ------------ */
export function Initialize(){
  if (_initedOnce) return;
  _initedOnce = true;

  device.addFeature("udp");
  device.log("Init: controller ip=" + (controller && controller.ip ? controller.ip : "UNKNOWN"));

  Twinkly.fetchFirmwareVersionFromDevice();
  Twinkly.deviceLogin(() => {
    Twinkly.verifyToken(Twinkly.getAuthenticationToken(), Twinkly.getChallengeResponse(), () => {
      Twinkly.fetchDeviceInformation(() => {
        Twinkly.fetchDeviceBrightness(() => {
          if (startMode === "Off"){
            Twinkly.setDeviceBrightness("disabled","A",0);
            Twinkly.setLEDMode("off");
            _rtActive = false;
            _offForced = true;
          } else {
            Twinkly.setDeviceBrightness("enabled","A",100);
            Twinkly.setLEDMode("rt");
            _rtActive = true;
            _offForced = false;
          }

          Twinkly.decodeAuthToken();
          Twinkly.fetchDeviceLayoutType();
          Twinkly.fetchLEDMode(false, () => {});
          device.log("Device Initialized.");

          if (_idleTimer) clearInterval(_idleTimer);
          _idleTimer = setInterval(enforceIdleOff, 200);
        });
      });
    });
  });
}

export function Shutdown(suspend){
  if (!keepOffOnShutdown) return;
  try{
    if (sendBlackOnShutdown) sendColors(true, false);
    Twinkly.setLEDMode("off");
    Twinkly.setDeviceBrightness("disabled","A",0);
    _rtActive = false;
    _offForced = true;
  } catch(_){}
}

/* UI change hooks */
export function onstartModeChanged(){
  if (startMode === "Off"){
    Twinkly.setLEDMode("off");
    Twinkly.setDeviceBrightness("disabled","A",0);
    _rtActive = false;
    _offForced = true;
  } else {
    Twinkly.setDeviceBrightness("enabled","A",100);
    Twinkly.setLEDMode("rt");
    _rtActive = true;
    _offForced = false;
  }
}
export function onforcedColorChanged(){ _forcedDirty = true; _lastForcedHex = forcedColor; }
export function onLightingModeChanged(){ _forcedDirty = true; _lastCRC = -1; }
export function onxScaleChanged(){ Twinkly.fetchDeviceLayoutType(); }
export function onyScaleChanged(){ Twinkly.fetchDeviceLayoutType(); }

/* ------------ idle / pause OFF ------------ */
function enforceIdleOff(){
  const now = Date.now();

  // IMMEDIATE pause: turn off quickly and suppress any further work
  if (immediatePauseOff){
    const paused = (now - _lastFrameMs) > 300; // ms since last actual send
    if (!_offForced && paused){
      try { sendColors(true, false); } catch(_){}
      Twinkly.setLEDMode("off");
      Twinkly.setDeviceBrightness("disabled","A",0);
      _rtActive = false;
      _offForced = true;
      return;
    }
  }

  // Fallback idle seconds
  if (offWhenIdle){
    const idleSecs = Math.max(2, Number(idleOffSeconds) || 5);
    if (!_offForced && (now - _lastFrameMs) > (idleSecs*1000)){
      try { sendColors(true, false); } catch(_){}
      Twinkly.setLEDMode("off");
      Twinkly.setDeviceBrightness("disabled","A",0);
      _rtActive = false;
      _offForced = true;
    }
  }
}

/* ------------ render ------------ */
export function Render(){
  // The engine will CALL Render each tick. We guard to ensure zero network.

  // If we intentionally forced OFF (pause/idle/shutdown), do nothing at all.
  if (_offForced) return;

  // If Forced mode and nothing changed, and keepalive==0 → skip immediately.
  if (LightingMode === "Forced"){
    const ka = Math.max(0, Number(keepaliveSeconds) || 0);
    const colorChanged = _forcedDirty || (forcedColor !== _lastForcedHex);
    if (!colorChanged && ka === 0) return;
  }

  // Connection maintenance (non-blocking)
  checkConnectionStatusNonBlocking();

  // Don’t auto-wake if we were intentionally OFF.
  if (!_rtActive){
    const now = Date.now();
    if ((now - _lastEnsureRt) > ENSURE_RT_INTERVAL_MS){
      Twinkly.setDeviceBrightness("enabled","A",100);
      Twinkly.setLEDMode("rt");
      _rtActive = true;
      _lastEnsureRt = now;
    }
  }

  // Still OFF? Then nothing to do.
  if (!_rtActive) return;

  // Respect FPS limiter
  if (!shouldSendFrame()) return;

  try{
    let sent = false;

    if (LightingMode === "Forced"){
      const now = Date.now();
      const ka = Math.max(0, Number(keepaliveSeconds) || 0);
      const colorChanged = _forcedDirty || (forcedColor !== _lastForcedHex);

      if (colorChanged){
        sent = sendColors(false, false);  // force one send
        _forcedDirty = false;
        _lastForcedHex = forcedColor;
      } else if (ka > 0){
        // Keepalive path with CRC skip (won’t send if truly identical)
        sent = sendColors(false, true);
      }
    } else {
      // Canvas: CRC skip ensures no traffic if identical
      sent = sendColors(false, true);
    }

    if (sent) _lastFrameMs = Date.now();
  } catch(_){}
}

/* ------------ connection health ------------ */
let lastConnectionCheckAt = 0;
const connectionCheckIntervalMs = 60000;
let _checking = false;

function checkConnectionStatusNonBlocking(){
  const now = Date.now();
  if (_checking || (now - lastConnectionCheckAt) < connectionCheckIntervalMs) return;

  _checking = true;
  Twinkly.fetchLEDMode(true, (status) => {
    if (status !== "Ok" && autoReconnect){
      Twinkly.deviceLogin(() => {
        Twinkly.verifyToken(Twinkly.getAuthenticationToken(), Twinkly.getChallengeResponse(), () => {
          if (!_offForced && startMode !== "Off"){
            Twinkly.setLEDMode("rt");
            _rtActive = true;
          }
          Twinkly.decodeAuthToken();
          Twinkly.fetchDeviceLayoutType();
        });
      });
    }
    lastConnectionCheckAt = Date.now();
    _checking = false;
  });
}

/* ------------ helpers ------------ */
function hexToRgb(hex){
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return [parseInt(m[1],16), parseInt(m[2],16), parseInt(m[3],16)];
}

/* ------------ discovery (unchanged) ------------ */
export function DiscoveryService(){
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
  this.forceDiscover = function(ipaddress){
    if (!ipaddress){ service.log(`Force Discovery IP Address is Undefined.`); }
    else {
      service.log("Forcing Discovery for Twinkly device at IP: " + ipaddress);
      this.confirmTwinklyDevice({ip: ipaddress, id: "00:00:00:00:00:00", name: "New Twinkly Device", port: "5555"});
    }
  };
  this.Update = function(){
    for (const cont of service.controllers) cont.obj.update();
    this.CheckForDevices();
  };
  this.Discovered = function(value){
    if (this.activeDevices.includes(value.ip)) return;
    const resp = String(value.response);
    if (resp.includes("OKTwinkly") || resp.includes("WHEREAREYOU")){
      this.confirmTwinklyDevice(value);
    }
  };
  this.LoadCachedDevices = function(){
    for (const [_key, value] of this.cache.Entries()) this.confirmTwinklyDevice(value);
  };
  this.CreateControllerDevice = function(value){
    const controller = service.getController(value.id);
    if (controller === undefined) service.addController(new TwinklyController(value));
    else controller.updateWithValue(value);
  };
  this.confirmTwinklyDevice = function(value){
    const challengeInput = encode(Array.from({length:32}, () => Math.floor(Math.random()*32)));
    XmlHttp.Post(`http://${value.ip}/xled/v1/login`, (xhr) => {
      if (xhr.readyState !== 4 || xhr.status !== 200) return;
      XmlHttp.Get(`http://${value.ip}/xled/v1/gestalt`, (xhr2) => {
        if (xhr2.readyState !== 4 || xhr2.status !== 200) return;
        const info = JSON.parse(xhr2.response);
        if (info.code === 1000){
          const bytesPerLED = info.bytes_per_led;
          value.id = info.mac;
          value.name = info.device_name;
          if (bytesPerLED > 2){
            this.activeDevices.push(value.ip);
            this.CreateControllerDevice(value);
          }
        }
      }, true);
    }, {"challenge": challengeInput}, true);
  };
  this.purgeIPCache = function(){ this.cache.PurgeCache(); };
}

class XmlHttp{
  static Get(url, cb, async=true){
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, async);
    xhr.setRequestHeader("Accept","application/json");
    xhr.setRequestHeader("Content-Type","application/json");
    xhr.onreadystatechange = cb.bind(null, xhr);
    xhr.send();
  }
  static GetWithAuth(url, cb, authToken = Twinkly.getAuthenticationToken(), async=true){
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url, async);
    xhr.setRequestHeader("Accept","application/json");
    xhr.setRequestHeader("Content-Type","application/json");
    xhr.setRequestHeader("X-Auth-Token", authToken);
    xhr.onreadystatechange = cb.bind(null, xhr);
    xhr.send();
  }
  static Post(url, cb, data, async=true){
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, async);
    xhr.setRequestHeader("Accept","application/json");
    xhr.setRequestHeader("Content-Type","application/json");
    xhr.onreadystatechange = cb.bind(null, xhr);
    xhr.send(JSON.stringify(data));
  }
  static PostWithAuth(url, cb, data, authToken = Twinkly.getAuthenticationToken(), async=true){
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, async);
    xhr.setRequestHeader("Accept","application/json");
    xhr.setRequestHeader("X-Auth-Token", authToken);
    xhr.setRequestHeader("Content-Type","application/json");
    xhr.onreadystatechange = cb.bind(null, xhr);
    xhr.send(JSON.stringify(data));
  }
  static Put(url, cb, data, async=true){
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, async);
    xhr.setRequestHeader("Accept","application/json");
    xhr.setRequestHeader("Content-Type","application/json");
    xhr.onreadystatechange = cb.bind(null, xhr);
    xhr.send(JSON.stringify(data));
  }
}

class TwinklyProtocol{
  constructor(){
    this.authentication_token = "";
    this.challenge_response   = "";
    this.statusCodes = {
      1000:"Ok",1001:"Error",1101:"Invalid Argument",1102:"Error",
      1103:"Error, Value too long or missing required object key?",
      1104:"Error, Malformed Json?",1105:"Invalid Argument Key",
      1107:"Ok?",1108:"Ok?",1205:"Error With Firmware Upgrade"
    };
    this.config = {
      firmwareVersion:"", hardwareRevision:"",
      previousDeviceBrightness:-1, numberOfDeviceLEDs:-1,
      bytesPerLED:-1, decodedAuthToken:[], vLedNames:[], vLedPositions:[]
    };
    this.deviceSKULibrary = {
      "TWC400STP":"Clusters","TWW210SPP":"Curtain","TWD400STP":"Dots","TWF020STP":"Festoon","TWFL200STW":"Flex",
      "TWI190SPP":"Icicle","TWWT050SPP":"Light Tree","TWP300SPP":"Light Tree","TWL100ADP":"Line","TWG050SPP":"Garland",
      "TG70P3D93P08":"Prelit Tree","TWT400SPP":"Prelit Tree","TWT250STP":"Prelit Tree","TG70P3G21P02":"Prelit Tree",
      "TWR050SPP":"Prelit Wreath","TWB200STP":"Spritzer","TWQ064STW":"Squares",
      "TWS100SPP":"Strings","TWS250STP":"Strings","TWS600STP":"Strings"
    };
    this.deviceImageLibrary = {
      "Clusters":"https://assets.signalrgb.com/devices/brands/twinkly/cluster-multicolor-edition.png",
      "Curtain":"https://assets.signalrgb.com/devices/brands/twinkly/curtain-multicolor-white-edition.png",
      "Dots":"https://assets.signalrgb.com/devices/brands/twinkly/dots-multicolor-edition.png",
      "Festoon":"https://assets.signalrgb.com/devices/brands/twinkly/festoon-multicolor-edition.png",
      "Flex":"https://assets.signalrgb.com/devices/brands/twinkly/flex-multicolor-edition.png",
      "Icicle":"https://assets.signalrgb.com/devices/brands/twinkly/icicle-multicolor-edition.png",
      "Light Tree":"https://assets.signalrgb.com/devices/brands/twinkly/light-tree-3d-multicolor-edition.png",
      "Line":"https://assets.signalrgb.com/devices/brands/twinkly/line-multicolor-edition.png",
      "Garland":"https://assets.signalrgb.com/devices/brands/twinkly/prelit-garland-multicolor-edition.png",
      "Prelit Tree":"https://assets.signalrgb.com/devices/brands/twinkly/prelit-tree-multicolor-edition.png",
      "Prelit Wreath":"https://assets.signalrgb.com/devices/brands/twinkly/prelit-wreath-multicolor-edition.png",
      "Spritzer":"https://assets.signalrgb.com/devices/brands/twinkly/spritzer-multicolor-edition.png",
      "Squares":"https://assets.signalrgb.com/devices/brands/twinkly/squares-multicolor-edition.png",
      "Strings":"https://assets.signalrgb.com/devices/brands/twinkly/strings-multicolor-edition.png"
    };
  }
  getvLedNames(){ return this.config.vLedNames; }
  setvLedNames(v){ this.config.vLedNames = v; }
  getvLedPositions(){ return this.config.vLedPositions; }
  setvLedPositions(v){ this.config.vLedPositions = v; }
  getFirmwareVersion(){ return this.config.firmwareVersion; }
  setFirmwareVersion(v){ this.config.firmwareVersion = v; }
  getHardwareRevision(){ return this.config.hardwareRevision; }
  setHardwareRevision(v){ this.config.hardwareRevision = v; }
  getPrevousDeviceBrightness(){ return this.config.previousDeviceBrightness; }
  setPreviousDeviceBrightness(v){ this.config.previousDeviceBrightness = v; }
  getAuthenticationToken(){ return this.authentication_token; }
  setAuthenticationToken(v){ this.authentication_token = v; }
  getDecodedAuthenticationToken(){ return this.config.decodedAuthToken; }
  setDecodedAuthenticationToken(v){ this.config.decodedAuthToken = v; }
  getChallengeResponse(){ return this.challenge_response; }
  setChallengeResponse(v){ this.challenge_response = v; }
  getNumberOfLEDs(){ return this.config.numberOfDeviceLEDs; }
  setNumberOfLEDs(v){ this.config.numberOfDeviceLEDs = v; }
  getNumberOfBytesPerLED(){ return this.config.bytesPerLED; }
  setNumberOfBytesPerLED(v){ this.config.bytesPerLED = v; }

  setImageFromSKU(SKU){
    const deviceType = this.deviceSKULibrary[SKU];
    if (deviceType && this.deviceImageLibrary[deviceType]){
      device.setImageFromUrl(this.deviceImageLibrary[deviceType]);
    }
  }

  decodeAuthToken(){
    const token = this.getAuthenticationToken();
    // --- CHANGE 1: Store token as Uint8Array for efficient packet building ---
    const decoded = new Uint8Array(decode(token));
    this.setDecodedAuthenticationToken(decoded);
  }

  fetchFirmwareVersionFromDevice(cb){
    XmlHttp.Get(`http://${controller.ip}/xled/v1/fw/version`, (xhr)=>{
      if (xhr.readyState===4 && xhr.status===200){
        const p = JSON.parse(xhr.response);
        this.setFirmwareVersion(p.version);
      }
      if (cb) cb();
    });
  }

  fetchDeviceBrightness(cb){
    XmlHttp.GetWithAuth(`http://${controller.ip}/xled/v1/led/out/brightness`, (xhr)=>{
      if (xhr.readyState===4 && xhr.status===200){
        const p = JSON.parse(xhr.response);
        if (p.mode === "enabled") this.setPreviousDeviceBrightness(p.value);
      }
      if (cb) cb();
    });
  }

  setDeviceBrightness(mode="enabled", type="A", value=100, cb){
    XmlHttp.PostWithAuth(`http://${controller.ip}/xled/v1/led/out/brightness`, (_xhr)=>{
      if (cb) cb();
    }, {"mode":mode, "type":type, "value":value});
  }

  fetchLEDMode(statusCheck=false, cb=null){
    XmlHttp.GetWithAuth(`http://${controller.ip}/xled/v1/led/mode`, (xhr)=>{
      if (xhr.readyState !== 4) return;
      if (xhr.status !== 200){ if (cb) cb("Error"); return; }
      const packet = JSON.parse(xhr.response);
      let packetStatus = (this.statuses[packet.code] || "Unknown");
      if (packet.mode !== "rt") packetStatus = "Incorrect Mode";
      if (statusCheck && cb) cb(packetStatus);
    });
  }

  setLEDMode(mode="color", cb){
    XmlHttp.PostWithAuth(`http://${controller.ip}/xled/v1/led/mode`, (_xhr)=>{
      if (cb) cb();
    }, {"mode":mode});
  }

  setCurrentLEDEffect(preset_id=0){
    XmlHttp.PostWithAuth(`http://${controller.ip}/xled/v1/led/effects/current`, (_xhr)=>{}, {"preset_id":preset_id});
  }

  fetchDeviceInformation(cb){
    XmlHttp.Get(`http://${controller.ip}/xled/v1/gestalt`, (xhr)=>{
      if (xhr.readyState===4 && xhr.status===200){
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

  fetchDeviceLayoutType(){
    XmlHttp.GetWithAuth(`http://${controller.ip}/xled/v1/led/layout/full`, (xhr)=>{
      if (xhr.readyState!==4 || xhr.status!==200) return;

      const packet = JSON.parse(xhr.response);
      const xVals = [], yVals = [];

      if (packet.source === "3d"){
        for (const c of packet.coordinates){ xVals.push(c.x); yVals.push(c.z); }
      } else {
        for (const c of packet.coordinates){ xVals.push(c.x); yVals.push(c.y); }
      }

      const xMax = Math.max(...xVals);
      const yMax = Math.max(...yVals);
      this.configureDeviceLayout(packet, xMax, yMax);
    });
  }

  configureDeviceLayout(packet, xMax, yMax){
    const names = [], pos = [];
    const width = 10 * xScale + 1;
    const height = 10 * yScale + 1;

    const useZ = (packet.source === "3d");
    for (let i=0;i<packet.coordinates.length;i++){
      const c = packet.coordinates[i];
      const X = Math.round((c.x + 1)/xMax * (5*xScale));
      const Y = Math.round(((useZ ? c.z : c.y) + 1)/yMax * (5*yScale));
      pos.push([X,Y]);
      names.push(`LED ${i+1}`);
    }

    this.setvLedNames(names);
    this.setvLedPositions(pos);
    device.setSize([width, height]);
    device.setControllableLeds(this.getvLedNames(), this.getvLedPositions());
    ensureRgbBuffer();
  }

  deviceLogin(cb){
    const challengeInput = encode(Array.from({length:32}, ()=>Math.floor(Math.random()*32)));
    XmlHttp.Post(`http://${controller.ip}/xled/v1/login`, (xhr)=>{
      if (xhr.readyState===4 && xhr.status===200){
        const p = JSON.parse(xhr.response);
        this.setAuthenticationToken(p.authentication_token);
        this.setChallengeResponse(p["challenge-response"]);
      }
      if (cb) cb();
    }, {"challenge": challengeInput});
  }

  verifyToken(token, challenge_response, cb){
    XmlHttp.PostWithAuth(`http://${controller.ip}/xled/v1/verify`, (_xhr)=>{
      if (cb) cb();
    }, {"challenge-response": challenge_response}, token);
  }

  // --- CHANGE 2: Replace sendGen1RTFrame ---
  sendGen1RTFrame(numberOfLEDs, RGBData){
    const authToken = this.getDecodedAuthenticationToken(); // Uint8Array
    const header = [0x01];
    
    // RGBData is the full _rgbBuffer (Uint8Array)
    const packet = new Uint8Array(header.length + authToken.length + numberOfLEDs.length + RGBData.length);
    packet.set(header, 0);
    packet.set(authToken, header.length);
    packet.set(numberOfLEDs, header.length + authToken.length);
    packet.set(RGBData, header.length + authToken.length + numberOfLEDs.length);

    udp.send(controller.ip, 7777, Array.from(packet));
  }
  
  // --- CHANGE 3: Replace sendGen2RTFrame ---
  sendGen2RTFrame(numberOfLEDs, RGBData){
    const authToken = this.getDecodedAuthenticationToken(); // Uint8Array
    const header = [0x02];

    // RGBData is the full _rgbBuffer (Uint8Array)
    const packet = new Uint8Array(header.length + authToken.length + numberOfLEDs.length + RGBData.length);
    packet.set(header, 0);
    packet.set(authToken, header.length);
    packet.set(numberOfLEDs, header.length + authToken.length);
    packet.set(RGBData, header.length + authToken.length + numberOfLEDs.length);

    udp.send(controller.ip, 7777, Array.from(packet));
  }

  // --- CHANGE 4: Replace sendGen3RTFrame ---
  sendGen3RTFrame(packetIDX, RGBDataChunk){
    const authToken = this.getDecodedAuthenticationToken(); // Uint8Array
    const header_part1 = [0x03];
    const header_part2 = [0x00, 0x00, packetIDX];

    // RGBDataChunk is the Uint8Array subarray
    const packet = new Uint8Array(header_part1.length + authToken.length + header_part2.length + RGBDataChunk.length);

    packet.set(header_part1, 0);
    packet.set(authToken, header_part1.length);
    packet.set(header_part2, header_part1.length + authToken.length);
    packet.set(RGBDataChunk, header_part1.length + authToken.length + header_part2.length);

    udp.send(controller.ip, 7777, Array.from(packet));
  }
}

const Twinkly = new TwinklyProtocol();

class TwinklyController{
  constructor(value){
    this.id = value.id; this.port = value.port; this.ip = value.ip;
    this.name = value.name; this.authToken = ""; this.initialized = false;
  }
  updateWithValue(v){
    this.id=v.id; this.port=v.port; this.ip=v.ip; this.name=v.name;
    this.cacheControllerInfo(); service.updateController(this);
  }
  update(){
    if (!this.initialized){
      this.initialized = true; this.cacheControllerInfo();
      service.updateController(this); service.announceController(this);
    }
  }
  login(){
    const ch = encode(Array.from({length:32}, ()=>Math.floor(Math.random()*32)));
    XmlHttp.Post(`http://${this.ip}/xled/v1/login`, (xhr)=>{
      if (xhr.readyState===4 && xhr.status===200){
        const p = JSON.parse(xhr.response);
        this.authenticate(p["challenge-response"], p.authentication_token);
      }
    }, {"challenge": ch});
  }
  authenticate(cr, token){
    XmlHttp.PostWithAuth(`http://${this.ip}/xled/v1/verify`, (xhr)=>{
      if (xhr.readyState===4 && xhr.status===200){
        const code = JSON.parse(xhr.response).code;
        if (code === 1000) this.authToken = token;
      }
    }, {"challenge-response": cr}, token);
  }
  cacheControllerInfo(){
    discovery.cache.Add(this.id, { name:this.name, port:this.port, ip:this.ip, id:this.id });
  }
}

class IPCache{
  constructor(){
    this.cacheMap = new Map();
    this.persistanceId = "ipCache";
    this.persistanceKey = "cache";
    this.PopulateCacheFromStorage();
  }
  Add(key, value){ this.cacheMap.set(key, value); this.Persist(); }
  Remove(key){ this.cacheMap.delete(key); this.Persist(); }
  Has(key){ return this.cacheMap.has(key); }
  Get(key){ return this.cacheMap.get(key); }
  Entries(){ return this.cacheMap.entries(); }
  PurgeCache(){ service.removeSetting(this.persistanceId, this.persistanceKey); }
  PopulateCacheFromStorage(){
    const storage = service.getSetting(this.persistanceId, this.persistanceKey);
    if (storage === undefined) return;
    let mapValues; try { mapValues = JSON.parse(storage); } catch(e) {}
    if (!mapValues) return;
    this.cacheMap = new Map(mapValues);
  }
  Persist(){
    service.saveSetting(this.persistanceId, this.persistanceKey, JSON.stringify(Array.from(this.cacheMap.entries())));
  }
}