# OpenList.ts

OpenList TypeScript/JavaScript rewrite for Cloudflare Workers.

## Features

- Cloudflare Workers deployment
- D1 database for storing settings and file metadata
- S3-compatible storage support
- File browsing and management
- User authentication and authorization
- Admin panel for storage and settings management

## Prerequisites

- Node.js 18+
- Cloudflare account
- Wrangler CLI (`npm install -g wrangler`)

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Configure Cloudflare:
   - Login to Cloudflare: `wrangler login`
   - Create D1 database: `wrangler d1 create openlist-db`
   - Update `wrangler.toml` with your database ID

3. Initialize the database:
   ```bash
   wrangler d1 execute openlist-db --file=./src/models/schema.sql
   ```

4. Run locally:
   ```bash
   npm run dev
   ```

5. Deploy:
   ```bash
   npm run deploy
   ```

## Configuration

### Environment Variables

Configure in `wrangler.toml`:

```toml
[vars]
ENVIRONMENT = "production"
```

### D1 Database

The database schema includes:
- `users` - User accounts and authentication
- `settings` - Application settings
- `storages` - Storage configurations (S3, etc.)
- `files` - Cached file metadata
- `file_cache` - Cache expiration tracking

## API Endpoints

### Authentication
- `POST /api/auth/login` - User login
- `GET /api/auth/logout` - User logout
- `GET /api/auth/me` - Get current user

### File System
- `POST /api/fs/list` - List files in directory
- `POST /api/fs/get` - Get file info
- `POST /api/fs/dirs` - List directories
- `POST /api/fs/mkdir` - Create directory
- `POST /api/fs/rename` - Rename file/directory
- `POST /api/fs/remove` - Delete files
- `POST /api/fs/move` - Move files
- `POST /api/fs/copy` - Copy files
- `PUT /api/fs/upload` - Upload file

### Storage Management (Admin)
- `GET /api/admin/storage/list` - List storages
- `GET /api/admin/storage/get` - Get storage
- `POST /api/admin/storage/create` - Create storage
- `POST /api/admin/storage/update` - Update storage
- `POST /api/admin/storage/delete` - Delete storage
- `POST /api/admin/storage/enable` - Enable storage
- `POST /api/admin/storage/disable` - Disable storage

### Settings Management (Admin)
- `GET /api/admin/setting/list` - List settings
- `GET /api/admin/setting/get` - Get setting
- `POST /api/admin/setting/save` - Save settings
- `POST /api/admin/setting/delete` - Delete setting

### User Management (Admin)
- `GET /api/admin/user/list` - List users
- `GET /api/admin/user/get` - Get user
- `POST /api/admin/user/create` - Create user
- `POST /api/admin/user/update` - Update user
- `POST /api/admin/user/delete` - Delete user

### Public
- `GET /api/public/settings` - Get public settings

## Default Credentials

- Username: `admin`
- Password: `admin`

**Important:** Change the default password immediately after first login.

## S3 Storage Configuration

When creating a new S3 storage, provide the following JSON in the `addition` field:

```json
{
  "bucket": "your-bucket-name",
  "endpoint": "https://s3.amazonaws.com",
  "region": "us-east-1",
  "access_key_id": "your-access-key",
  "access_key_secret": "your-secret-key",
  "root_path": "",
  "custom_host": "",
  "sign_url_expire": 3600,
  "enable_custom_host_presign": false,
  "remove_bucket": false,
  "add_filename_to_disposition": false,
  "list_object_version": "v2",
  "placeholder": "placeholder"
}
```

## Development

### Project Structure

```
src/
├── drivers/                    # Storage drivers (inspired by OpenList)
│   ├── types.ts                # Core driver interfaces (Obj, Driver, etc.)
│   ├── registry.ts             # Driver registration and management
│   ├── base.ts                 # Common utility functions
│   ├── template.ts             # Template for creating new drivers
│   ├── s3/
│   │   └── index.ts            # S3 Compatible Storage driver
│   ├── onedrive/
│   │   └── index.ts            # Microsoft OneDrive driver
│   ├── aliyundrive_open/
│   │   └── index.ts            # Alibaba Cloud Drive (Aliyun Pan) driver
│   ├── pikpak/
│   │   └── index.ts            # PikPak cloud storage driver
│   └── dropbox/
│       └── index.ts            # Dropbox driver
├── models/
│   ├── init.ts                 # Database initialization
│   └── schema.sql              # Database schema
├── routes/
│   ├── api.ts                  # API router
│   ├── auth.ts                 # Authentication routes
│   ├── drivers.ts              # Driver management routes
│   ├── fs.ts                   # File system routes
│   ├── settings.ts             # Settings routes
│   ├── static.ts               # Static file serving
│   ├── storage.ts              # Storage management routes
│   └── users.ts                # User management routes
├── router.ts                   # Main router
├── types.ts                    # TypeScript types
└── worker.ts                   # Worker entry point
```

### Adding a New Storage Driver

1. Create a new directory under `src/drivers/` (e.g., `src/drivers/mydriver/`)
2. Create `index.ts` with the driver implementation:

```typescript
import { Driver, DriverConfig, DriverItem, Obj, ListResult, LinkResult } from '../types';
import { registerDriver } from '../registry';
import { createFileObj, createDirObj } from '../base';

// Driver configuration
const config: DriverConfig = {
  name: 'MyDriver',
  label: 'My Custom Driver',
  local_sort: false,
  only_proxy: false,
  no_cache: false,
  no_upload: false,
  default_root: '/',
};

// Additional configuration fields
const additional: DriverItem[] = [
  { name: 'api_key', type: 'string', default: '', options: '', required: true, help: 'API Key' },
];

export class MyDriver implements Driver {
  config(): DriverConfig { return config; }
  
  async init(cfg: Record<string, any>): Promise<void> {
    // Initialize your driver
  }
  
  async list(path: string, cfg: Record<string, any>): Promise<ListResult> {
    // List files in directory
    throw new Error('Not implemented');
  }
  
  // ... implement other methods (get, link, mkdir, rename, copy, move, remove, put)
}

// Register the driver
registerDriver(MyDriver, config, additional);
```

3. Import the driver in `src/drivers/registry.ts`:

```typescript
import './mydriver';
```

The driver will be automatically registered and available for use.

### Running Tests

```bash
npm test
```

### Linting

```bash
npm run lint
```

### Type Checking

```bash
npm run typecheck
```

## License

AGPL-3.0
