// Each monitor's current mode next to its native resolution.
//
// A stretched resolution (e.g. 1920x1440 on a 2560x1440 monitor) shows up as the
// desktop's current mode, whether a game switched to it or it was set as the
// desktop resolution. The monitor's native resolution comes from its preferred
// mode (QueryDisplayConfig), which no resolution setting changes; Windows' saved
// desktop mode is the fallback. Electron only knows the current mode, so this
// asks Windows directly.

let api = null;

function load() {
  if (api !== null) return api;
  api = false;
  if (process.platform !== 'win32') return api;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    api = {
      enumDevices: user32.func('bool __stdcall EnumDisplayDevicesW(const char16_t *device, uint32_t index, _Inout_ uint8_t *info, uint32_t flags)'),
      enumSettings: user32.func('bool __stdcall EnumDisplaySettingsW(const char16_t *device, uint32_t mode, _Inout_ uint8_t *devmode)'),
      bufferSizes: user32.func('long __stdcall GetDisplayConfigBufferSizes(uint32_t flags, _Out_ uint32_t *numPaths, _Out_ uint32_t *numModes)'),
      queryConfig: user32.func('long __stdcall QueryDisplayConfig(uint32_t flags, _Inout_ uint32_t *numPaths, _Out_ uint8_t *paths, _Inout_ uint32_t *numModes, _Out_ uint8_t *modes, void *topology)'),
      deviceInfo: user32.func('long __stdcall DisplayConfigGetDeviceInfo(_Inout_ uint8_t *packet)'),
    };
  } catch (err) {
    console.error('[DeskScroller] Display modes unavailable:', err.message);
  }
  return api;
}

const ENUM_CURRENT_SETTINGS = 0xffffffff;
const ENUM_REGISTRY_SETTINGS = 0xfffffffe;
const ATTACHED_TO_DESKTOP = 0x1;

// DISPLAY_DEVICEW: cb, DeviceName[32], DeviceString[128], StateFlags, DeviceID[128], DeviceKey[128].
const DD_SIZE = 840, DD_NAME = 4, DD_FLAGS = 324;
// DEVMODEW (display variant): dmSize at 68, dmPosition at 76, dmPelsWidth / dmPelsHeight at 172 / 176.
const DM_SIZE = 220;

function mode(device, which) {
  const dm = Buffer.alloc(DM_SIZE);
  dm.writeUInt16LE(DM_SIZE, 68);
  if (!api.enumSettings(device, which, dm)) return null;
  return { x: dm.readInt32LE(76), y: dm.readInt32LE(80), width: dm.readUInt32LE(172), height: dm.readUInt32LE(176) };
}

// QueryDisplayConfig layouts. DISPLAYCONFIG_PATH_INFO is 72 bytes: source
// { adapterId 0, id 8 }, target { adapterId 20, id 28, rotation 40, scaling 44 }.
const QDC_ONLY_ACTIVE_PATHS = 2;
const PATH_SIZE = 72, MODE_SIZE = 64;
const GET_SOURCE_NAME = 1, GET_TARGET_PREFERRED_MODE = 3;
const SOURCE_NAME_SIZE = 84, PREFERRED_MODE_SIZE = 80;
const ROTATE_90 = 2, ROTATE_270 = 4;

function infoPacket(type, size, adapterId, id) {
  const b = Buffer.alloc(size);
  b.writeUInt32LE(type, 0);
  b.writeUInt32LE(size, 4);
  adapterId.copy(b, 8);
  b.writeUInt32LE(id, 16);
  return b;
}

// \\.\DISPLAYn -> { width, height, scaling } of the monitor's native mode, turned
// to match the desktop's orientation.
function nativeModes() {
  const out = {};
  const np = [0], nm = [0];
  if (api.bufferSizes(QDC_ONLY_ACTIVE_PATHS, np, nm) !== 0) return out;
  const paths = Buffer.alloc(np[0] * PATH_SIZE), modes = Buffer.alloc(nm[0] * MODE_SIZE);
  if (api.queryConfig(QDC_ONLY_ACTIVE_PATHS, np, paths, nm, modes, null) !== 0) return out;
  for (let i = 0; i < np[0]; i++) {
    const p = paths.subarray(i * PATH_SIZE, (i + 1) * PATH_SIZE);
    const name = infoPacket(GET_SOURCE_NAME, SOURCE_NAME_SIZE, p.subarray(0, 8), p.readUInt32LE(8));
    const pref = infoPacket(GET_TARGET_PREFERRED_MODE, PREFERRED_MODE_SIZE, p.subarray(20, 28), p.readUInt32LE(28));
    if (api.deviceInfo(name) !== 0 || api.deviceInfo(pref) !== 0) continue;
    const device = name.toString('utf16le', 20, SOURCE_NAME_SIZE).replace(/\0.*$/s, '');
    let width = pref.readUInt32LE(20), height = pref.readUInt32LE(24);
    const rotation = p.readUInt32LE(40);
    if (rotation === ROTATE_90 || rotation === ROTATE_270) [width, height] = [height, width];
    if (width && height) out[device] = { width, height, scaling: p.readUInt32LE(44) };
  }
  return out;
}

// [{ device, current: {x, y, width, height}, native: {width, height, scaling} }] in
// physical pixels, one per monitor on the desktop; [] if Windows can't be asked.
function displayModes() {
  if (!load()) return [];
  let natives = {};
  try { natives = nativeModes(); } catch (err) { console.error('[DeskScroller] Native modes unavailable:', err.message); }
  const out = [];
  for (let i = 0; i < 32; i++) {
    const dd = Buffer.alloc(DD_SIZE);
    dd.writeUInt32LE(DD_SIZE, 0);
    if (!api.enumDevices(null, i, dd, 0)) break;
    if (!(dd.readUInt32LE(DD_FLAGS) & ATTACHED_TO_DESKTOP)) continue;
    const device = dd.toString('utf16le', DD_NAME, DD_NAME + 64).replace(/\0.*$/s, '');
    const current = mode(device, ENUM_CURRENT_SETTINGS);
    const native = natives[device] || mode(device, ENUM_REGISTRY_SETTINGS);
    if (current && native && native.width && native.height) out.push({ device, current, native });
  }
  return out;
}

module.exports = { displayModes };
