// Twinkly.js — SignalRGB integration
// v1.8.4-absolute-zero-gc
// - GC FIX (THE FINAL BOSS): Implemented a persistent UDP Array Memory Pool. Completely eliminates `new Array()` and `.subarray()` allocations during the Render loop. 
// - THREAD FIX: Bypasses C++ segfaults by ensuring each UDP chunk has a dedicated, permanent memory address.
// - CPU FIX: Unrolled bitwise additive checksum.
// - UI FIX: Compliant with 2.5.68-beta strict schema ("settings" and "lighting").
// - MATRIX FIX: Forced Matrix mode for 1:1 overlapping pixel elimination.

import { encode, decode } from "@SignalRGB/base64";

export function Name(){ return "Twinkly"; }
export function Version(){ return "1.8.4-absolute-zero-gc"; }
export function Type(){ return "network"; }
export function Publisher(){ return "msallal"; }
export function Size(){ return [48,48]; }
export function DefaultPosition(){ return [10,10]; }
export function DefaultScale(){ return 1.0; }

/* global
enableMatrix:readonly
matrixWidth:readonly
matrixHeight:readonly
xScale:readonly
yScale:readonly
shutdownColor:readonly
LightingMode:readonly
forcedColor:readonly
startMode:readonly
keepOffOnShutdown:readonly
sendBlackOnShutdown:readonly
immediatePauseOff:readonly
offWhenIdle:readonly
idleOffSeconds:readonly
autoReconnect:readonly
fpsLimit:readonly
keepaliveSeconds:readonly
*/

export function ControllableParameters(){
  return [
    { property:"shutdownColor", group:"lighting", label:"Shutdown Color", type:"color", default:"#000000" },
    { property:"LightingMode", group:"lighting", label:"Lighting Mode", type:"combobox", values:["Canvas","Forced"], default:"Canvas" },
    { property:"forcedColor", group:"lighting", label:"Forced Color", type:"color", default:"#FF0000" },

    { property:"enableMatrix", group:"settings", label:"Enable Matrix Mode", type:"boolean", default:"0" },
    { property:"matrixWidth", group:"settings", label:"Matrix Width", step:"1", type:"number", min:"1", max:"128", default:"32" },
    { property:"matrixHeight", group:"settings", label:"Matrix Height", step:"1", type:"number", min:"1", max:"128", default:"32" },
    { property:"xScale", group:"settings", label:"Width Scale (If Auto-Scale)", step:"1", type:"number", min:"1", max:"10", default:"2" },
    { property:"yScale", group:"settings", label:"Height Scale (If Auto-Scale)", step:"1", type:"number", min:"1", max:"10", default:"2" },

    { property:"startMode", group:"settings", label:"Start Mode", type:"combobox", values:["Off","RT Live","Restore"], default:"RT Live" },
    { property:"keepOffOnShutdown", group:"settings", label:"Force Off On Shutdown", type:"boolean", default:"1" },
    { property:"sendBlackOnShutdown", group:"settings", label:"Send Black Before Off", type:"boolean", default:"1" },

    { property:"immediatePauseOff", group:"settings", label:"Immediate Pause OFF", type:"boolean", default:"1" },
    { property:"offWhenIdle", group:"settings", label:"Off When Paused", type:"boolean", default:"1" },
    { property:"idleOffSeconds", group:"settings", label:"Idle Off After Seconds", step:"1", type:"number", min:"2", max:"60", default:"5" },

    { property:"autoReconnect", group:"settings", label:"Auto Reconnect", type:"boolean", default:"1" },
    { property:"fpsLimit", group:"settings", label:"Max FPS", step:"1", type:"number", min:"10", max:"120", default:"30" },
    { property:"keepaliveSeconds", group:"settings", label:"Keepalive Seconds", step:"1", type:"number", min:"0", max:"120", default:"0" }
  ];
}

/* ------------ runtime ------------ */
let _rtActive = false;
let _offForced = false;
let _initedOnce = false;

let _lastFrameMs = 0;            
let _idleTimer = null;

let _lastFrameSentAt = 0;
let _lastEnsureRt = 0;
const ENSURE_RT_INTERVAL_MS = 900;

let _forcedDirty = true;
let _lastForcedHex = "";
let _forcedRgb = [255, 0, 0];
let _shutdownRgb = [0, 0, 0];

let _lastCRC = -1;
let _cachedIdleOffSeconds = 5;
let _forceRelogin = false;

function isTrue(val) { return val === true || val === "true" || val === 1 || val === "1"; }

function shouldSendFrame(){
  let limit = 30;
  try { limit = Math.max(10, Math.min(120, Number(fpsLimit) || 30)); } catch(e){}
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
let _rgbBuffer = null;
let _rgbLedCount = 0;

let _ledX = [];
let _ledY = [];

function ensureRgbBuffer(){
  const bytesPerLED = Twinkly.getNumberOfBytesPerLED();
  _rgbStride = (bytesPerLED === 4) ? 4 : 3;

  const vLedPositions = Twinkly.getvLedPositions();
  const needCount = vLedPositions.length;
  const needBytes = needCount * _rgbStride;

  if (!_rgbBuffer || _rgbLedCount !== needCount || _rgbBuffer.length !== needBytes){
    _rgbLedCount = needCount;
    _rgbBuffer = new Uint8Array(needBytes);
    
    _ledX = new Array(needCount);
    _ledY = new Array(needCount);
    for(let i=0; i<needCount; i++){
       _ledX[i] = vLedPositions[i][0] || 0;
       _ledY[i] = vLedPositions[i][1] || 0;
    }
    _lastCRC = -1; 
  }
}

function fillRgbBuffer(useShutdownColor){
  ensureRgbBuffer();
  const ledCount = _rgbLedCount;

  let staticColor = null;
  if (useShutdownColor) staticColor = _shutdownRgb;
  else {
    try { if (LightingMode === "Forced") staticColor = _forcedRgb; } catch(e){}
  }

  if (staticColor) {
    const r = staticColor[0];
    const g = staticColor[1];
    const b = staticColor[2];

    if (_rgbStride === 4) {
      for (let i = 0, base = 0; i < ledCount; i++, base += 4) {
        _rgbBuffer[base    ] = 0x00;
        _rgbBuffer[base + 1] = r;
        _rgbBuffer[base + 2] = g;
        _rgbBuffer[base + 3] = b;
      }
    } else {
      for (let i = 0, base = 0; i < ledCount; i++, base += 3) {
        _rgbBuffer[base    ] = r;
        _rgbBuffer[base + 1] = g;
        _rgbBuffer[base + 2] = b;
      }
    }
  } else {
    if (_rgbStride === 4) {
      for (let i = 0, base = 0; i < ledCount; i++, base += 4) {
        const col = device.color(_ledX[i], _ledY[i]);
        _rgbBuffer[base    ] = 0x00;
        if (col) {
          _rgbBuffer[base + 1] = col[0];
          _rgbBuffer[base + 2] = col[1];
          _rgbBuffer[base + 3] = col[2];
        } else {
          _rgbBuffer[base + 1] = 0;
          _rgbBuffer[base + 2] = 0;
          _rgbBuffer[base + 3] = 0;
        }
      }
    } else {
      for (let i = 0, base = 0; i < ledCount; i++, base += 3) {
        const col = device.color(_ledX[i], _ledY[i]);
        if (col) {
          _rgbBuffer[base    ] = col[0];
          _rgbBuffer[base + 1] = col[1];
          _rgbBuffer[base + 2] = col[2];
        } else {
          _rgbBuffer[base    ] = 0;
          _rgbBuffer[base + 1] = 0;
          _rgbBuffer[base + 2] = 0;
        }
      }
    }
  }
}

// Ultra-fast bitwise unrolled checksum
function fast_checksum(buf){
  let sum = 0;
  let i = 0;
  const len = buf.length;
  while (i < len - 3) {
    sum = (sum + buf[i++] + buf[i++] + buf[i++] + buf[i++]) | 0;
  }
  while (i < len) sum = (sum + buf[i++]) | 0;
  return sum;
}

function sendColors(useShutdownColor=false, allowSkipSame=true){
  fillRgbBuffer(useShutdownColor);

  if (allowSkipSame){
    const checksum = fast_checksum(_rgbBuffer);
    if (checksum === _lastCRC) return false;
    _lastCRC = checksum;
  }

  const MAX_CHUNK = 900;
  let packetIDX = 0;
  
  // Directly passes buffer offsets. ZERO array allocation or subarrays here.
  for (let offset=0; offset<_rgbBuffer.length; offset += MAX_CHUNK, packetIDX++){
    const chunkLen = Math.min(MAX_CHUNK, _rgbBuffer.length - offset);
    Twinkly.sendGen3RTFramePooled(packetIDX, _rgbBuffer, offset, chunkLen);
  }
  return true;
}

export function Initialize(){
  if (_initedOnce) return;
  _initedOnce = true;

  try { _cachedIdleOffSeconds = Math.max(2, Number(idleOffSeconds) || 5); } catch(e){}
  try { _shutdownRgb = hexToRgb(shutdownColor); } catch(e){}
  try { _forcedRgb = hexToRgb(forcedColor); _lastForcedHex = forcedColor; } catch(e){}

  device.addFeature("udp");
  device.log("Init: controller ip=" + (controller && controller.ip ? controller.ip : "UNKNOWN"));

  let sm = "RT Live";
  try { sm = startMode; } catch(e){}

  Twinkly.fetchFirmwareVersionFromDevice();
  Twinkly.deviceLogin(() => {
    Twinkly.verifyToken(Twinkly.getAuthenticationToken(), Twinkly.getChallengeResponse(), () => {
      Twinkly.fetchDeviceInformation(() => {
        Twinkly.fetchDeviceBrightness(() => {
          if (sm === "Off"){
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
        });
      });
    });
  });
}

export function Shutdown(suspend){
  let skip = false;
  try { if (!isTrue(keepOffOnShutdown)) skip = true; } catch(e){}
  if (skip) return;

  try{
    let sendBlack = true;
    try { sendBlack = isTrue(sendBlackOnShutdown); } catch(e){}
    
    if (sendBlack) sendColors(true, false);
    Twinkly.setLEDMode("off");
    Twinkly.setDeviceBrightness("disabled","A",0);
    _rtActive = false;
    _offForced = true;

    if (_idleTimer) {
      clearInterval(_idleTimer);
      _idleTimer = null;
    }
  } catch(_){}
}

/* UI hooks */
export function onidleOffSecondsChanged(){ try{ _cachedIdleOffSeconds = Math.max(2, Number(idleOffSeconds) || 5); } catch(e){} }
export function onshutdownColorChanged(){ try{ _shutdownRgb = hexToRgb(shutdownColor); _lastCRC = -1; } catch(e){} }
export function onstartModeChanged(){
  try{
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
  } catch(e){}
}
export function onforcedColorChanged(){ try{ _forcedRgb = hexToRgb(forcedColor); _forcedDirty = true; _lastForcedHex = forcedColor; } catch(e){} }
export function onLightingModeChanged(){ _forcedDirty = true; _lastCRC = -1; }

export function onenableMatrixChanged(){ Twinkly.fetchDeviceLayoutType(); }
export function onmatrixWidthChanged(){ Twinkly.fetchDeviceLayoutType(); }
export function onmatrixHeightChanged(){ Twinkly.fetchDeviceLayoutType(); }
export function onxScaleChanged(){ Twinkly.fetchDeviceLayoutType(); }
export function onyScaleChanged(){ Twinkly.fetchDeviceLayoutType(); }

function enforceIdleOff(){
  const now = Date.now();
  let imm = true, idle = true;
  try { imm = isTrue(immediatePauseOff); } catch(e){}
  try { idle = isTrue(offWhenIdle); } catch(e){}

  if (imm){
    const paused = (now - _lastFrameMs) > 300;
    if (!_offForced && paused){
      try { sendColors(true, false); } catch(_){}
      Twinkly.setLEDMode("off");
      Twinkly.setDeviceBrightness("disabled","A",0);
      _rtActive = false;
      _offForced = true;
      return;
    }
  }
  if (idle){
    if (!_offForced && (now - _lastFrameMs) > (_cachedIdleOffSeconds*1000)){
      try { sendColors(true, false); } catch(_){}
      Twinkly.setLEDMode("off");
      Twinkly.setDeviceBrightness("disabled","A",0);
      _rtActive = false;
      _offForced = true;
    }
  }
}

export function Render(){
  let sm = "RT Live";
  try { sm = startMode; } catch(e){}
  if (sm !== "Off") _offForced = false;
  
  const now = Date.now();
  if ((now - _lastFrameMs) > 5000 && _lastFrameMs !== 0) {
    _forceRelogin = true;
    _lastFrameMs = now;
  }

  if (_offForced) return;

  let ka = 0;
  let lm = "Canvas";
  let fc = "";
  try { ka = Math.max(0, Number(keepaliveSeconds) || 0); } catch(e){}
  try { lm = LightingMode; } catch(e){}
  try { fc = forcedColor; } catch(e){}

  const colorChanged = _forcedDirty || (fc !== _lastForcedHex);

  if (lm === "Forced" && !colorChanged && ka === 0) return;

  checkConnectionStatusNonBlocking();

  if (!_rtActive){
    const now_rt = Date.now();
    if ((now_rt - _lastEnsureRt) > ENSURE_RT_INTERVAL_MS){
      Twinkly.setDeviceBrightness("enabled","A",100);
      Twinkly.setLEDMode("rt");
      _rtActive = true;
      _lastEnsureRt = now_rt;
    }
  }

  if (!_rtActive || !shouldSendFrame()) return;

  try{
    let sent = false;

    if (lm === "Forced"){
      if (colorChanged){
        sent = sendColors(false, false);
        _forcedDirty = false;
        _lastForcedHex = fc;
      } else if (ka > 0){
        sent = sendColors(false, true);
      }
    } else {
      sent = sendColors(false, true);
    }

    if (sent) {
      _lastFrameMs = Date.now();
      if (!_idleTimer) _idleTimer = setInterval(enforceIdleOff, 200);
    }
  } catch(_){}
}

let lastConnectionCheckAt = 0;
let _checking = false;

function checkConnectionStatusNonBlocking(){
  const now = Date.now();
  if (!_forceRelogin && (_checking || (now - lastConnectionCheckAt) < 60000)) return;

  _checking = true;
  _forceRelogin = false;

  Twinkly.fetchLEDMode(true, (status) => {
    let ar = true;
    try { ar = isTrue(autoReconnect); } catch(e){}

    if (status !== "Ok" && ar){
      Twinkly.deviceLogin(() => {
        Twinkly.verifyToken(Twinkly.getAuthenticationToken(), Twinkly.getChallengeResponse(), () => {
          let sm = "RT Live";
          try { sm = startMode; } catch(e){}
          
          if (!_offForced && sm !== "Off"){
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

const HEX_REGEX = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i;
function hexToRgb(hex){
  const m = HEX_REGEX.exec(hex);
  return m ? [parseInt(m[1],16), parseInt(m[2],16), parseInt(m[3],16)] : [0,0,0];
}

export function DiscoveryService(){
  this.IconUrl = "https://assets.signalrgb.com/brands/twinkly/logo.jpg";
  this.firstRun = true;
  this.Initialize = function(){ this.LoadCachedDevices(); };
  this.UdpBroadcastPort = 5555;
  this.UdpListenPort = 59136;
  this.lastPollTime = 0;
  this.PollInterval = 60000;
  this.cache = new IPCache();
  this.activeDevices = [];
  this.CheckForDevices = function(){
    if (Date.now() - discovery.lastPollTime < discovery.PollInterval) return;
    discovery.lastPollTime = Date.now();
    service.broadcast(`\x01discover`);
  };
  this.forceDiscover = function(ipaddress){
    if (ipaddress) this.confirmTwinklyDevice({ip: ipaddress, id: "00:00:00:00:00:00", name: "New Twinkly Device", port: "5555"});
  };
  this.Update = function(){
    for (const cont of service.controllers) cont.obj.update();
    this.CheckForDevices();
  };
  this.Discovered = function(value){
    if (this.activeDevices.includes(value.ip)) return;
    const resp = String(value.response);
    if (resp.includes("OKTwinkly") || resp.includes("WHEREAREYOU")) this.confirmTwinklyDevice(value);
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
        try {
          if (xhr2.response) {
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
          }
        } catch(e) {}
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
}

class TwinklyProtocol{
  constructor(){
    this.HEADER_GEN1 = new Uint8Array([0x01]);
    this.HEADER_GEN2 = new Uint8Array([0x02]);
    this.HEADER_GEN3_PART1 = new Uint8Array([0x03]);
    
    this.authentication_token = "";
    this.challenge_response   = "";
    
    // Gen3 Persistent Memory Objects
    this.gen3HeaderCache = [];
    this.udpPool = [];

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
			"Clusters" : "https://assets.signalrgb.com/devices/brands/twinkly/clusters.png",
			"Curtain" : "https://assets.signalrgb.com/devices/brands/twinkly/curtain.png",
			"Dots" : "https://assets.signalrgb.com/devices/brands/twinkly/dots.png",
			"Festoon" : "https://assets.signalrgb.com/devices/brands/twinkly/festoon.png",
			"Flex" : "https://assets.signalrgb.com/devices/brands/twinkly/flex.png",
			"Icicle" : "https://assets.signalrgb.com/devices/brands/twinkly/icicle.png",
			"Light Tree" : "https://assets.signalrgb.com/devices/brands/twinkly/light-tree.png",
			"Line" : "https://assets.signalrgb.com/devices/brands/twinkly/lines.png",
			"Garland" : "https://assets.signalrgb.com/devices/brands/twinkly/garland.png",
			"Prelit Tree" : "https://assets.signalrgb.com/devices/brands/twinkly/prelit-tree.png",
			"Prelit Wreath" : "https://assets.signalrgb.com/devices/brands/twinkly/wreath.png",
			"Spritzer" : "https://assets.signalrgb.com/devices/brands/twinkly/spritzer.png",
			"Squares" : "https://assets.signalrgb.com/devices/brands/twinkly/squares.png",
			"Strings" : "https://assets.signalrgb.com/devices/brands/twinkly/strings.png"
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
  
  setDecodedAuthenticationToken(v){ 
    this.config.decodedAuthToken = v; 
    
    if (v && v.length > 0) {
      this.gen3HeaderCache = new Array(v.length + 3);
      this.gen3HeaderCache[0] = this.HEADER_GEN3_PART1[0];
      for(let i=0; i<v.length; i++) this.gen3HeaderCache[i+1] = v[i];
      this.gen3HeaderCache[v.length + 1] = 0x00;
      this.gen3HeaderCache[v.length + 2] = 0x00;
    }
  }

  getChallengeResponse(){ return this.challenge_response; }
  setChallengeResponse(v){ this.config.challenge_response = v; }
  getNumberOfLEDs(){ return this.config.numberOfDeviceLEDs; }
  setNumberOfLEDs(v){ this.config.numberOfDeviceLEDs = v; }
  getNumberOfBytesPerLED(){ return this.config.bytesPerLED; }
  setNumberOfBytesPerLED(v){ this.config.bytesPerLED = v; }

  setImageFromSKU(SKU){
    const deviceType = this.deviceSKULibrary[SKU];
    if (deviceType && this.deviceImageLibrary[deviceType]) device.setImageFromUrl(this.deviceImageLibrary[deviceType]);
  }

  decodeAuthToken(){
    const token = this.getAuthenticationToken();
    const decoded = new Uint8Array(decode(token));
    this.setDecodedAuthenticationToken(decoded);
  }

  fetchFirmwareVersionFromDevice(cb){
    XmlHttp.Get(`http://${controller.ip}/xled/v1/fw/version`, (xhr)=>{
      try {
        if (xhr.readyState===4 && xhr.status===200 && xhr.response) this.setFirmwareVersion(JSON.parse(xhr.response).version);
      } catch(e) {}
      if (cb) cb();
    });
  }

  fetchDeviceBrightness(cb){
    XmlHttp.GetWithAuth(`http://${controller.ip}/xled/v1/led/out/brightness`, (xhr)=>{
      try {
        if (xhr.readyState===4 && xhr.status===200 && xhr.response){
          const p = JSON.parse(xhr.response);
          if (p.mode === "enabled") this.setPreviousDeviceBrightness(p.value);
        }
      } catch(e) {}
      if (cb) cb();
    });
  }

  setDeviceBrightness(mode="enabled", type="A", value=100, cb){
    XmlHttp.PostWithAuth(`http://${controller.ip}/xled/v1/led/out/brightness`, (_xhr)=>{ if (cb) cb(); }, {"mode":mode, "type":type, "value":value});
  }

  fetchLEDMode(statusCheck=false, cb=null){
    XmlHttp.GetWithAuth(`http://${controller.ip}/xled/v1/led/mode`, (xhr)=>{
      if (xhr.readyState !== 4) return;
      let packetStatus = "Error"; 
      try {
        if (xhr.status === 200 && xhr.response) {
          const packet = JSON.parse(xhr.response);
          packetStatus = (this.statusCodes[packet.code] || "Unknown");
          if (packet.mode !== "rt") packetStatus = "Incorrect Mode";
        } else if (xhr.status !== 200) packetStatus = "Error";
      } catch(e) { packetStatus = "Error"; }
      if (statusCheck && cb) cb(packetStatus);
    });
  }

  setLEDMode(mode="color", cb){
    XmlHttp.PostWithAuth(`http://${controller.ip}/xled/v1/led/mode`, (_xhr)=>{ if (cb) cb(); }, {"mode":mode});
  }

  fetchDeviceInformation(cb){
    XmlHttp.Get(`http://${controller.ip}/xled/v1/gestalt`, (xhr)=>{
      try {
        if (xhr.readyState===4 && xhr.status===200 && xhr.response){
          const p = JSON.parse(xhr.response);
          this.setNumberOfBytesPerLED(p.bytes_per_led);
          this.setNumberOfLEDs(p.number_of_led);
          this.setHardwareRevision(p.hardware_version);
          device.setName(p.device_name);
          this.setImageFromSKU(p.product_code);
        }
      } catch(e) {}
      if (cb) cb();
    });
  }

  fetchDeviceLayoutType(){
    XmlHttp.GetWithAuth(`http://${controller.ip}/xled/v1/led/layout/full`, (xhr)=>{
      if (xhr.readyState!==4 || xhr.status!==200) return;
      try {
        if (xhr.response) {
          const packet = JSON.parse(xhr.response);
          if (!packet.coordinates || packet.coordinates.length === 0) return;

          const xVals = [], yVals = [];
          const useZ = (packet.source === "3d");
          
          for (let i=0; i<packet.coordinates.length; i++){
            const c = packet.coordinates[i];
            let xv = Number(c.x); let yv = useZ ? Number(c.z) : Number(c.y);
            if(isNaN(xv)) xv = 0; if(isNaN(yv)) yv = 0;
            xVals.push(xv); yVals.push(yv);
          }

          let xMax = -Infinity, yMax = -Infinity;
          let xMin = Infinity, yMin = Infinity;
          for(let i=0; i<xVals.length; i++){
              if(xVals[i] > xMax) xMax = xVals[i];
              if(xVals[i] < xMin) xMin = xVals[i];
              if(yVals[i] > yMax) yMax = yVals[i];
              if(yVals[i] < yMin) yMin = yVals[i];
          }

          if(xMax === -Infinity) { xMax = 1; xMin = 0; }
          if(yMax === -Infinity) { yMax = 1; yMin = 0; }

          this.configureDeviceLayout(xVals, yVals, xMin, xMax, yMin, yMax);
        }
      } catch(e) {}
    });
  }

  configureDeviceLayout(xVals, yVals, xMin, xMax, yMin, yMax){
    const names = [], pos = [];
    
    let isMatrix = false;
    try { isMatrix = isTrue(enableMatrix); } catch(e){}

    let fW, fH;

    if (isMatrix) {
        let mX = 32, mY = 32;
        try { mX = Number(matrixWidth) || 32; } catch(e){}
        try { mY = Number(matrixHeight) || 32; } catch(e){}
        
        const xRange = Math.abs(xMax - xMin) || 1; 
        const yRange = Math.abs(yMax - yMin) || 1;
        
        for (let i=0; i<xVals.length; i++){
            const xNorm = (xVals[i] - xMin) / xRange;
            const yNorm = (yVals[i] - yMin) / yRange;
            
            let X = Math.round(xNorm * (mX - 1));
            let Y = Math.round(yNorm * (mY - 1));
            
            X = Math.max(0, Math.min(X, mX - 1));
            Y = Math.max(0, Math.min(Y, mY - 1));

            pos.push([X,Y]);
            names.push(`LED ${i+1}`);
        }
        fW = mX;
        fH = mY;
        
    } else {
        let uX = 2, uY = 2;
        try { uX = Number(xScale) || 2; } catch(e){}
        try { uY = Number(yScale) || 2; } catch(e){}

        const xRange = Math.abs(xMax - xMin) || 1; 
        const yRange = Math.abs(yMax - yMin) || 1;
        
        const baseWidth = 10 * uX;
        const baseHeight = 10 * uY;

        let finalWidth, finalHeight;
        if (xRange > yRange) {
            finalWidth = baseWidth;
            finalHeight = finalWidth * (yRange / xRange);
        } else {
            finalHeight = baseHeight;
            finalWidth = finalHeight * (xRange / yRange);
        }
        
        fW = Math.max(1, Math.round(finalWidth) || 1) + 1;
        fH = Math.max(1, Math.round(finalHeight) || 1) + 1;

        for (let i=0; i<xVals.length; i++){
          const xNorm = (xVals[i] - xMin) / xRange;
          const yNorm = (yVals[i] - yMin) / yRange;

          let X = Math.round(xNorm * finalWidth);
          let Y = Math.round(yNorm * finalHeight);
          
          if (isNaN(X)) X = 0; if (isNaN(Y)) Y = 0;
          X = Math.max(0, Math.min(X, fW - 1));
          Y = Math.max(0, Math.min(Y, fH - 1));

          pos.push([X,Y]);
          names.push(`LED ${i+1}`);
        }
    }

    this.setvLedNames(names);
    this.setvLedPositions(pos);
    device.setSize([fW, fH]);
    device.setControllableLeds(this.getvLedNames(), this.getvLedPositions());
    ensureRgbBuffer();
  }

  deviceLogin(cb){
    const challengeInput = encode(Array.from({length:32}, ()=>Math.floor(Math.random()*32)));
    XmlHttp.Post(`http://${controller.ip}/xled/v1/login`, (xhr)=>{
      try {
        if (xhr.readyState===4 && xhr.status===200 && xhr.response){
          const p = JSON.parse(xhr.response);
          this.setAuthenticationToken(p.authentication_token);
          this.setChallengeResponse(p["challenge-response"]);
        }
      } catch(e) {}
      if (cb) cb();
    }, {"challenge": challengeInput});
  }

  verifyToken(token, challenge_response, cb){
    XmlHttp.PostWithAuth(`http://${controller.ip}/xled/v1/verify`, (_xhr)=>{ if (cb) cb(); }, {"challenge-response": challenge_response}, token);
  }

  // --- ZERO-ALLOCATION UDP MEMORY POOL ---
  sendGen3RTFramePooled(packetIDX, dataBuffer, dataOffset, dataLen){
    const header = this.gen3HeaderCache;
    const size = header.length + 1 + dataLen;

    if (!this.udpPool[packetIDX] || this.udpPool[packetIDX].length !== size) {
        this.udpPool[packetIDX] = new Array(size);
    }

    const arr = this.udpPool[packetIDX];
    let offset = 0;

    for(let i=0; i<header.length; i++) arr[offset++] = header[i];
    arr[offset++] = packetIDX;
    for(let i=0; i<dataLen; i++) arr[offset++] = dataBuffer[dataOffset + i];

    udp.send(controller.ip, 7777, arr);
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
      try {
        if (xhr.readyState===4 && xhr.status===200 && xhr.response){
          const p = JSON.parse(xhr.response);
          this.authenticate(p["challenge-response"], p.authentication_token);
        }
      } catch(e) {}
    }, {"challenge": ch});
  }
  authenticate(cr, token){
    XmlHttp.PostWithAuth(`http://${this.ip}/xled/v1/verify`, (xhr)=>{
      try {
        if (xhr.readyState===4 && xhr.status===200 && xhr.response){
          const code = JSON.parse(xhr.response).code;
          if (code === 1000) this.authToken = token;
        }
      } catch(e) {}
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
