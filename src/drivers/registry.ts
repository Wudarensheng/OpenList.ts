/**
 * Driver Registry - Central driver management system
 * Inspired by OpenList's op.RegisterDriver pattern
 * Adapted for Cloudflare Workers stateless environment
 */

import { Driver, DriverConstructor, DriverInfo, DriverConfig, DriverItem } from './types';

// Driver registry maps - using lazy initialization to avoid ESM ordering issues
let _driverMap: Map<string, DriverConstructor> | null = null;
let _driverInfoMap: Map<string, DriverInfo> | null = null;
let _initialized = false;

function getDriverMap(): Map<string, DriverConstructor> {
  if (!_driverMap) {
    _driverMap = new Map();
  }
  return _driverMap;
}

function getDriverInfoMapInternal(): Map<string, DriverInfo> {
  if (!_driverInfoMap) {
    _driverInfoMap = new Map();
  }
  return _driverInfoMap;
}

// Common fields shared by all drivers
const COMMON_FIELDS: DriverItem[] = [
  { name: 'mount_path', type: 'string', default: '/', options: '', required: true, help: 'Mount path' },
  { name: 'order', type: 'number', default: '0', options: '', required: false, help: 'Order' },
  { name: 'remark', type: 'string', default: '', options: '', required: false, help: 'Remark' },
  { name: 'cache_expiration', type: 'number', default: '30', options: '', required: false, help: 'Cache expiration (minutes)' },
  { name: 'web_proxy', type: 'bool', default: 'false', options: '', required: false, help: 'Web proxy' },
  { name: 'webdav_policy', type: 'select', default: '302_redirect', options: '302_redirect,use_proxy_url,native_proxy', required: false, help: 'WebDAV policy' },
  { name: 'down_proxy_url', type: 'string', default: '', options: '', required: false, help: 'Download proxy URL' },
  { name: 'order_by', type: 'select', default: 'name', options: 'name,size,modified', required: false, help: 'Order by' },
  { name: 'order_direction', type: 'select', default: '', options: 'ASC,DESC', required: false, help: 'Order direction' },
  { name: 'extract_folder', type: 'select', default: 'front', options: 'front,back', required: false, help: 'Extract folder' },
  { name: 'disable_index', type: 'bool', default: 'false', options: '', required: false, help: 'Disable index' },
  { name: 'enable_sign', type: 'bool', default: 'false', options: '', required: false, help: 'Enable sign' },
  { name: 'proxy_range', type: 'bool', default: 'false', options: '', required: false, help: 'Proxy range' },
  { name: 'disable_proxy_sign', type: 'bool', default: 'false', options: '', required: false, help: 'Disable proxy sign' },
];

/**
 * Register a driver
 * This should be called in each driver module's initialization
 */
export function registerDriver(constructor: DriverConstructor, config: DriverConfig, additional: DriverItem[]): void {
  const info: DriverInfo = {
    config,
    common: COMMON_FIELDS,
    additional,
  };
  
  getDriverMap().set(config.name, constructor);
  getDriverInfoMapInternal().set(config.name, info);
}

/**
 * Ensure drivers are initialized. Call this before using driver functions.
 * This uses dynamic imports to break the circular dependency.
 */
async function ensureDrivers(): Promise<void> {
  if (_initialized) return;
  _initialized = true;

  // Dynamic imports to break circular dependency
  // Each module's top-level registerDriver() call will execute during import
  const [
    s3Mod,
    onedriveMod,
    onedriveAppMod,
    aliyundriveMod,
    pikpakMod,
    dropboxMod,
    cloud189Mod,
    webdavMod,
    googleDriveMod,
    yandexDiskMod,
    open123Mod,
    quarkOpenMod,
  ] = await Promise.all([
    import('./s3'),
    import('./onedrive'),
    import('./onedrive_app'),
    import('./aliyundrive_open'),
    import('./pikpak'),
    import('./dropbox'),
    import('./cloud189'),
    import('./webdav'),
    import('./google_drive'),
    import('./yandex_disk'),
    import('./123_open'),
    import('./quark_open'),
  ]);

  // Explicit registration calls in case top-level side-effects didn't run
  if (s3Mod.s3Config) registerDriver(s3Mod.S3Driver, s3Mod.s3Config, s3Mod.s3Additional);
  if (onedriveMod.onedriveConfig) registerDriver(onedriveMod.OneDriveDriver, onedriveMod.onedriveConfig, onedriveMod.onedriveAdditional);
  if (onedriveAppMod.onedriveAppConfig) registerDriver(onedriveAppMod.OnedriveAppDriver, onedriveAppMod.onedriveAppConfig, onedriveAppMod.onedriveAppAdditional);
  if (aliyundriveMod.aliyundriveOpenConfig) registerDriver(aliyundriveMod.AliyundriveOpenDriver, aliyundriveMod.aliyundriveOpenConfig, aliyundriveMod.aliyundriveOpenAdditional);
  if (pikpakMod.pikpakConfig) registerDriver(pikpakMod.PikPakDriver, pikpakMod.pikpakConfig, pikpakMod.pikpakAdditional);
  if (dropboxMod.dropboxConfig) registerDriver(dropboxMod.DropboxDriver, dropboxMod.dropboxConfig, dropboxMod.dropboxAdditional);
  if (cloud189Mod.cloud189Config) registerDriver(cloud189Mod.Cloud189Driver, cloud189Mod.cloud189Config, cloud189Mod.cloud189Additional);
  if (webdavMod.webdavConfig) registerDriver(webdavMod.WebDavDriver, webdavMod.webdavConfig, webdavMod.webdavAdditional);
  if (googleDriveMod.googleDriveConfig) registerDriver(googleDriveMod.GoogleDriveDriver, googleDriveMod.googleDriveConfig, googleDriveMod.googleDriveAdditional);
  if (yandexDiskMod.yandexDiskConfig) registerDriver(yandexDiskMod.YandexDiskDriver, yandexDiskMod.yandexDiskConfig, yandexDiskMod.yandexDiskAdditional);
  if (open123Mod.open123Config) registerDriver(open123Mod.Open123Driver, open123Mod.open123Config, open123Mod.open123Additional);
  if (quarkOpenMod.quarkOpenConfig) registerDriver(quarkOpenMod.QuarkOpenDriver, quarkOpenMod.quarkOpenConfig, quarkOpenMod.quarkOpenAdditional);
}

/**
 * Get driver constructor by name
 */
export function getDriverConstructor(name: string): DriverConstructor | undefined {
  return getDriverMap().get(name);
}

/**
 * Create a new driver instance by name
 * Note: In Cloudflare Workers, we create new instances per request (stateless)
 */
export function createDriver(name: string): Driver {
  const Constructor = getDriverMap().get(name);
  if (!Constructor) {
    throw new Error(`Driver not found: ${name}`);
  }
  return new Constructor();
}

/**
 * Get all registered driver names
 */
export async function getDriverNames(): Promise<string[]> {
  await ensureDrivers();
  return Array.from(getDriverInfoMapInternal().keys());
}

/**
 * Get driver info map
 */
export async function getDriverInfoMap(): Promise<Record<string, DriverInfo>> {
  await ensureDrivers();
  const result: Record<string, DriverInfo> = {};
  getDriverInfoMapInternal().forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

/**
 * Get driver info by name
 */
export async function getDriverInfo(name: string): Promise<DriverInfo | undefined> {
  await ensureDrivers();
  return getDriverInfoMapInternal().get(name);
}

/**
 * Initialize driver with config from storage
 * This creates a new instance and initializes it
 */
export async function getDriverInstance(driverName: string, addition: Record<string, any>): Promise<Driver> {
  await ensureDrivers();
  const driver = createDriver(driverName);
  await driver.init(addition);
  return driver;
}
