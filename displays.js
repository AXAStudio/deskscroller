// Each monitor's current mode next to the mode saved in Windows' display settings.
//
// A game that switches to a stretched resolution (e.g. 1440x1080 on a 1920x1080
// monitor) changes the current mode only for as long as it runs; the saved mode
// stays the desktop resolution you normally use. Electron only knows the current
// mode, so this asks Windows (EnumDisplaySettingsW) for both.

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

// [{ device, current: {x, y, width, height}, saved: {width, height} }] in physical
// pixels, one per monitor on the desktop; [] if Windows can't be asked.
function displayModes() {
  if (!load()) return [];
  const out = [];
  for (let i = 0; i < 32; i++) {
    const dd = Buffer.alloc(DD_SIZE);
    dd.writeUInt32LE(DD_SIZE, 0);
    if (!api.enumDevices(null, i, dd, 0)) break;
    if (!(dd.readUInt32LE(DD_FLAGS) & ATTACHED_TO_DESKTOP)) continue;
    const device = dd.toString('utf16le', DD_NAME, DD_NAME + 64).replace(/\0.*$/s, '');
    const current = mode(device, ENUM_CURRENT_SETTINGS);
    const saved = mode(device, ENUM_REGISTRY_SETTINGS);
    if (current && saved && saved.width && saved.height) out.push({ device, current, saved });
  }
  return out;
}

module.exports = { displayModes };
