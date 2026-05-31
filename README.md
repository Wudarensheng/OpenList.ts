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
├── drivers/
│   └── s3.ts          # S3 storage driver
├── models/
│   ├── init.ts        # Database initialization
│   └── schema.sql     # Database schema
├── routes/
│   ├── api.ts         # API router
│   ├── auth.ts        # Authentication routes
│   ├── fs.ts          # File system routes
│   ├── settings.ts    # Settings routes
│   ├── static.ts      # Static file serving
│   ├── storage.ts     # Storage management routes
│   └── users.ts       # User management routes
├── router.ts          # Main router
├── types.ts           # TypeScript types
└── worker.ts          # Worker entry point
```

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
