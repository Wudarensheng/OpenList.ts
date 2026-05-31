import { Driver, DriverInfo, DriverItem } from './types';
import { s3Config, S3Driver } from './s3';
import { onedriveConfig, OneDriveDriver } from './onedrive';
import { aliyundriveOpenConfig, AliyundriveOpenDriver } from './aliyundrive_open';
import { pikpakConfig, PikPakDriver } from './pikpak';
import { dropboxConfig, DropboxDriver } from './dropbox';

// Common storage fields shared by all drivers
const COMMON_FIELDS: DriverItem[] = [
  { name: "mount_path", type: "string", default: "/", options: "", required: true, help: "Mount path" },
  { name: "order", type: "number", default: "0", options: "", required: false, help: "Order" },
  { name: "remark", type: "string", default: "", options: "", required: false, help: "Remark" },
  { name: "cache_expiration", type: "number", default: "30", options: "", required: false, help: "Cache expiration (minutes)" },
  { name: "web_proxy", type: "bool", default: "false", options: "", required: false, help: "Web proxy" },
  { name: "webdav_policy", type: "select", default: "302_redirect", options: "302_redirect,use_proxy_url,native_proxy", required: false, help: "WebDAV policy" },
  { name: "down_proxy_url", type: "string", default: "", options: "", required: false, help: "Download proxy URL" },
  { name: "order_by", type: "select", default: "name", options: "name,size,modified,", required: false, help: "Order by" },
  { name: "order_direction", type: "select", default: "", options: "ASC,DESC,", required: false, help: "Order direction" },
  { name: "extract_folder", type: "select", default: "front", options: "front,back,", required: false, help: "Extract folder" },
  { name: "disable_index", type: "bool", default: "false", options: "", required: false, help: "Disable index" },
  { name: "enable_sign", type: "bool", default: "false", options: "", required: false, help: "Enable sign" },
  { name: "proxy_range", type: "bool", default: "false", options: "", required: false, help: "Proxy range" },
  { name: "disable_proxy_sign", type: "bool", default: "false", options: "", required: false, help: "Disable proxy sign" },
];

// Add common fields to each driver info
function addCommonFields(info: DriverInfo): DriverInfo {
  return {
    ...info,
    common: COMMON_FIELDS,
  };
}

// Driver registry
const driverInfoMap: Record<string, DriverInfo> = {
  S3: addCommonFields(s3Config),
  OneDrive: addCommonFields(onedriveConfig),
  AliyundriveOpen: addCommonFields(aliyundriveOpenConfig),
  PikPak: addCommonFields(pikpakConfig),
  Dropbox: addCommonFields(dropboxConfig),
};

const driverConstructors: Record<string, new () => Driver> = {
  S3: S3Driver,
  OneDrive: OneDriveDriver,
  AliyundriveOpen: AliyundriveOpenDriver,
  PikPak: PikPakDriver,
  Dropbox: DropboxDriver,
};

// Cache driver instances
const driverInstances: Record<string, Driver> = {};

export function getDriverNames(): string[] {
  return Object.keys(driverInfoMap);
}

export function getDriverInfoMap(): Record<string, DriverInfo> {
  return driverInfoMap;
}

export function getDriverInfo(name: string): DriverInfo | null {
  return driverInfoMap[name] || null;
}

export async function getDriverInstance(driverName: string, config: Record<string, any>): Promise<Driver> {
  const cacheKey = `${driverName}_${JSON.stringify(config)}`;
  
  if (driverInstances[cacheKey]) {
    return driverInstances[cacheKey];
  }

  const Constructor = driverConstructors[driverName];
  if (!Constructor) {
    throw new Error(`Driver not found: ${driverName}`);
  }

  const driver = new Constructor();
  await driver.init(config);
  driverInstances[cacheKey] = driver;
  
  return driver;
}

export function clearDriverCache(driverName?: string): void {
  if (driverName) {
    Object.keys(driverInstances).forEach(key => {
      if (key.startsWith(driverName)) {
        delete driverInstances[key];
      }
    });
  } else {
    Object.keys(driverInstances).forEach(key => delete driverInstances[key]);
  }
}
