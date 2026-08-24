# OpenList.ts

[![Cloudflare Workers에 배포](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Wudarensheng/OpenList.ts)

[English](../README.md) · [中文](./README.zh-CN.md) · [日本語](./README.ja-JP.md) · [Français](./README.fr-FR.md) · [한국어](./README.ko-KR.md)

[Cloudflare Workers](https://workers.cloudflare.com/)용 파일 목록 프로그램입니다. OpenList/AList 스타일의 웹 UI로 S3 호환 스토리지(Backblaze B2, Cloudflare R2, AWS S3, MinIO 등), Microsoft OneDrive, Alibaba Cloud Drive, PikPak, Dropbox의 파일을 탐색하고 관리합니다.

전체가 TypeScript로 작성되었으며, Workers 런타임에서 실행되고 파일 트리와 다운로드 링크는 [Cloudflare D1](https://developers.cloudflare.com/d1/)에 캐시됩니다.

> **OpenList.ts**는 OpenList 생태계 프로젝트이자 OpenList의 파생 프로젝트로, OpenList 생태계에 속합니다.

---

## ✨ 기능

- ☁️ Cloudflare Workers + D1에서 완전히 동작 (VPS 불필요)
- 📁 다중 스토리지 지원: **S3 호환**(B2 / R2 / AWS / MinIO), **OneDrive**, **OneDrive APP**, **Alibaba Cloud Drive**, **PikPak**, **Dropbox**
- 🗄️ **D1 파일 트리 캐시**: 탐색 시 D1의 캐시된 파일 트리를 읽음 — 관리자가 콜드 경로를 방문할 때만 스토리지 제공자에 접속하고, 다운로드 URL은 다운로드 시에 지연 생성
- 🔐 사용자 인증 및 권한 (게스트 / 사용자 / 관리자)
- 🛡️ **TOTP 이중 인증(2FA)** — Google Authenticator 호환
- 🔑 비밀번호 변경 및 프로필 업데이트
- 👤 익명(게스트) 탐색 선택 지원, 기본 비활성화
- 🖥️ 관리자 패널: 스토리지, 설정, 사용자, 드라이버 관리
- 📥 직접 다운로드(`/d/`) 및 프록시 다운로드(`/p/`), Range/HEAD 지원
- 🔄 서명된 링크 캐시 및 singleflight 중복 제거

---

## 🚀 빠른 배포

[![Cloudflare Workers에 배포](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Wudarensheng/OpenList.ts)

위 버튼을 클릭하면 Cloudflare 계정에 직접 배포됩니다(Workers와 D1이 자동 생성). 배포 후 Worker URL을 열고 기본 자격 증명으로 로그인한 다음 관리자 패널에서 스토리지를 추가하세요.

### 수동 배포

필수 조건: [Node.js](https://nodejs.org/) 18+ 및 [Wrangler](https://developers.cloudflare.com/workers/wrangler/).

```bash
# 1. 의존성 설치 (pnpm 권장)
pnpm install          # 또는: npm install

# 2. Cloudflare 로그인
npx wrangler login

# 3. D1 데이터베이스 생성 및 database_id 기록
npx wrangler d1 create openlist-db
#   → 출력된 database_id를 wrangler.toml의 [[d1_databases]]에 입력

# 4. 스키마 적용
npm run db:init       # = wrangler d1 execute openlist-db --file=./src/models/schema.sql

# 5. (선택) 로컬 미리보기
npm run dev           # http://127.0.0.1:8787

# 6. Cloudflare에 배포
npm run deploy
```

---

## 🖥️ 로컬 개발

```bash
pnpm install
npm run dev          # wrangler dev 시작, http://127.0.0.1:8787
```

D1 데이터베이스는 `.wrangler/state` 아래에 로컬로 시뮬레이션되며, 스키마와 캐시 데이터는 재시작 후에도 유지됩니다.

기타 유용한 스크립트:

| 명령 | 설명 |
|---|---|
| `npm run typecheck` | TypeScript 타입 검사(`tsc --noEmit`) |
| `npm run lint` | `src`에 대해 ESLint |
| `npm test` | Vitest 테스트 러너 |
| `npm run deploy` | Cloudflare에 배포 |
| `npm run db:reset` | 모든 테이블 삭제 후 스키마 재초기화 |

---

## 🔐 인증

### 기본 자격 증명

| 사용자명 | 비밀번호 | 역할 |
|---|---|---|
| `admin` | `admin` | 관리자 |

> ⚠️ **첫 로그인 후 기본 비밀번호를 즉시 변경하세요** (프로필 → 비밀번호 변경).

### 역할

- **게스트**(`role 0`) — 익명 방문자. `anonymous` 설정이 활성화된 경우에만 표시됩니다.
- **사용자**(`role 1`) — 파일 탐색 및 관리 가능.
- **관리자**(`role 2`) — 관리자 패널을 포함한 전체 권한.

> 탐색 중에는 스토리지 제공자에 접속하지 않습니다. **관리자**가 콜드 경로를 방문할 때만 제공자에 요청하여 D1 파일 트리를 채웁니다. 게스트와 일반 사용자는 항상 캐시에서 읽습니다.

### 이중 인증(2FA)

1. 로그인 후 **프로필** → **이중 인증**으로 이동합니다.
2. **활성화**를 클릭해 시크릿을 생성하고 Google Authenticator(또는 TOTP 앱)로 QR 코드를 스캔합니다.
3. 6자리 코드를 입력해 확인합니다.
4. 이후 로그인에는 6자리 코드가 필요합니다.

계정에 2FA가 활성화되어 있으면 로그인 페이지에 OTP 입력란이 자동으로 표시됩니다.

---

## 🗄️ 파일 트리 캐시

파일 트리는 D1에 캐시되어 빠르고 제공자 친화적인 탐색을 제공합니다:

1. **탐색**(`/api/fs/list`, `/api/fs/get`, `/api/fs/dirs`)은 **D1에서만** 파일 트리를 읽습니다. 스토리지 제공자에는 절대 접속하지 않습니다.
2. **관리자**가 캐시되지 않았거나(또는 만료된) 경로를 열면, 워커가 원격 디렉터리를 한 번 나열하여 D1(`files`, `file_cache` 테이블)에 저장합니다.
3. **다운로드**(`/d/`, `/p/`)는 서명된 URL을 요청 시 생성하고 D1(`file_links` 테이블)에 캐시하므로 반복 다운로드 시 재서명하지 않습니다.
4. 빈 디렉터리도 캐시됩니다(`file_cache` 행으로 표시).

캐시 수명은 스토리지별로 `cache_expiration` 필드로 설정할 수 있습니다(분, 기본 30).

---

## 📦 지원 스토리지

### S3 호환(Backblaze B2, Cloudflare R2, AWS S3, MinIO 등)

관리자 패널에서 드라이버 **S3** 스토리지를 추가하고 `addition` JSON을 지정합니다:

```json
{
  "bucket": "your-bucket-name",
  "endpoint": "https://s3.ca-central-1.amazonaws.com",
  "region": "ca-central-1",
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

> Backblaze B2는 `region: "auto"`를 사용하세요. 드라이버가 엔드포인트 호스트에서 리전을 자동 감지합니다.

### Microsoft OneDrive / OneDrive APP

두 가지 드라이버를 제공합니다:

- **OneDrive** — refresh token으로 개인 OneDrive 접근.
- **OneDrive APP** — Azure AD 앱 등록 플로우. Global / CN(世纪互联) / DE / US 리전 지원.

`addition` 예시(OneDrive APP):

```json
{
  "client_id": "your-application-client-id",
  "client_secret": "your-client-secret",
  "tenant_id": "common",
  "refresh_token": "your-refresh-token",
  "email": "you@example.com",
  "region": "global",
  "root_folder_path": "/",
  "redirect_uri": "http://localhost",
  "chunk_size": 10,
  "custom_host": ""
}
```

---

## 📡 API 참조

### 인증

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/auth/login` | 로그인(평문 비밀번호) |
| POST | `/api/auth/login/hash` | 로그인(sha256 해시, 프론트엔드용. `otp_code` 지원) |
| GET | `/api/auth/me` | 현재 사용자 조회 |
| GET | `/api/auth/logout` | 로그아웃 |
| POST | `/api/auth/2fa/generate` | TOTP 시크릿 생성(`secret` + `qr` 반환) |
| POST | `/api/auth/2fa/verify` | 코드 검증 및 2FA 활성화 |
| POST | `/api/auth/2fa/disable` | 2FA 비활성화(유효한 코드 필요) |

### 프로필

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/me` | 현재 사용자 프로필 조회 |
| POST | `/api/me/update` | 사용자명/비밀번호 변경(비밀번호 변경 시 `old_password` 필요) |
| GET | `/api/me/sshkey/list` | SSH 키(스텁) |

### 파일 시스템

| 메서드 | 경로 | 설명 |
|---|---|---|
| POST | `/api/fs/list` | 디렉터리 파일 목록(`path`, `page`, `per_page`, `refresh`) |
| POST | `/api/fs/get` | 파일/디렉터리 정보 조회(`path`) |
| POST | `/api/fs/dirs` | 디렉터리 목록(`path`) |
| POST | `/api/fs/mkdir` | 디렉터리 생성(`path`, `name`) |
| POST | `/api/fs/rename` | 이름 변경(`path`, `name`) |
| POST | `/api/fs/remove` | 삭제(`dir`, `names[]`) |
| POST | `/api/fs/move` | 이동(`src_dir`, `dst_dir`, `names[]`) |
| POST | `/api/fs/copy` | 복사(`src_dir`, `dst_dir`, `names[]`) |
| PUT | `/api/fs/put` | 업로드(`?path=` + 본문) |
| PUT | `/api/fs/form` | 멀티파트 업로드 |
| POST | `/api/fs/search` | 검색(스텁) |

### 다운로드 / 프록시

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/d/<path>` | 서명된 다운로드 URL로 302 리다이렉트 |
| GET/HEAD | `/p/<path>` | 워커를 통해 파일 스트리밍(Range 지원) |

### 관리 — 스토리지

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/admin/storage/list` | 스토리지 목록 |
| GET | `/api/admin/storage/get?id=` | 스토리지 조회 |
| POST | `/api/admin/storage/create` | 스토리지 생성 |
| POST | `/api/admin/storage/update` | 스토리지 업데이트 |
| POST | `/api/admin/storage/delete?id=` | 스토리지 삭제 |
| POST | `/api/admin/storage/enable?id=` | 활성화 |
| POST | `/api/admin/storage/disable?id=` | 비활성화 |
| POST | `/api/admin/storage/refresh` | 모든 파일 트리 캐시 새로고침 |
| POST | `/api/admin/storage/refresh_one?id=` | 단일 스토리지 캐시 새로고침 |

### 관리 — 설정

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/admin/setting/list` | 설정 목록(선택 `?group=`) |
| GET | `/api/admin/setting/get?key=` | 설정 조회 |
| POST | `/api/admin/setting/save` | 하나 이상의 설정 저장 |
| POST | `/api/admin/setting/delete?key=` | 설정 삭제 |

### 관리 — 사용자

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/admin/user/list` | 사용자 목록 |
| GET | `/api/admin/user/get?id=` | 사용자 조회 |
| POST | `/api/admin/user/create` | 사용자 생성 |
| POST | `/api/admin/user/update` | 사용자 업데이트 |
| POST | `/api/admin/user/delete?id=` | 사용자 삭제 |

### 관리 — 드라이버

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/admin/driver/names` | 등록된 드라이버 이름 목록 |
| GET | `/api/admin/driver/list` | 드라이버 정보 맵 |
| GET | `/api/admin/driver/info?driver=` | 단일 드라이버 정보 |

### 공개

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/public/settings` | 공개 설정(`anonymous` 포함) |
| GET | `/api/public/archive_extensions` | 아카이브 확장자 |
| GET | `/api/public/offline_download_tools` | 오프라인 다운로드 도구(스텁) |

---

## ⚙️ 설정

| 키 | 기본값 | 설명 |
|---|---|---|
| `site_title` | `OpenList` | 사이트 제목 |
| `site_description` | `A file list program` | 사이트 설명 |
| `logo` | `/images/logo.svg` | 로고 |
| `favicon` | `/images/logo.png` | 파비콘 |
| `max_connections` | `0` | 최대 연결 수(0 = 무제한) |
| `cache_expiration` | `30` | 기본 캐시 수명(분) |
| `anonymous` | `false` | 익명 탐색 허용. `false`면 방문자는 로그인해야 합니다. |

---

## 🗂️ 프로젝트 구조

```
src/
├── drivers/                  # 스토리지 드라이버
│   ├── types.ts              # 핵심 드라이버 인터페이스
│   ├── registry.ts           # 드라이버 등록 및 조회
│   ├── base.ts               # 공통 헬퍼
│   ├── s3/                   # S3 호환 드라이버
│   ├── onedrive/             # OneDrive 드라이버
│   ├── onedrive_app/         # OneDrive APP(Azure AD 앱) 드라이버
│   ├── aliyundrive_open/     # Alibaba Cloud Drive 드라이버
│   ├── pikpak/               # PikPak 드라이버
│   └── dropbox/              # Dropbox 드라이버
├── models/
│   ├── init.ts               # 스키마 초기화 및 기본 데이터
│   └── schema.sql            # D1 스키마
├── routes/
│   ├── api.ts                # API 라우터
│   ├── auth.ts               # 인증 + 2FA + 프로필
│   ├── fs.ts                 # 파일 시스템 라우트 + D1 캐시
│   ├── download.ts           # /d/ 및 /p/ 다운로드 라우트
│   ├── storage.ts            # 스토리지 관리 라우트
│   ├── settings.ts           # 설정 관리 라우트
│   ├── users.ts              # 사용자 관리 라우트
│   ├── drivers.ts            # 드라이버 관리 라우트
│   ├── refresh.ts            # 캐시 새로고침 라우트
│   └── static.ts             # 정적 자산
├── utils/
│   ├── otp.ts                # TOTP 구현
│   ├── crypto.ts             # 비밀번호 해시 헬퍼
│   ├── guest.ts              # 게스트 사용자 모델
│   └── response.ts           # JSON 응답 헬퍼
├── cache.ts                  # D1 캐시 프리미티브(파일, 링크, 잠금)
├── router.ts                 # 메인 라우터
├── types.ts                  # TypeScript 타입
└── worker.ts                 # Worker 엔트리 포인트
```

### 새 스토리지 드라이버 추가

1. `src/drivers/<name>/index.ts`를 만들고 `Driver` 인터페이스(`list`, `get`, `link`, `mkdir`, `rename`, `copy`, `move`, `remove`, `put`)를 구현합니다.
2. `config`와 `additional`을 내보내고 `registerDriver(...)`를 호출합니다.
3. `src/drivers/registry.ts`에서 모듈을 가져옵니다.

복사용 스켈레톤은 `src/drivers/template.ts`를 참고하세요.

---

## 📄 라이선스

[AGPL-3.0](../LICENSE)
