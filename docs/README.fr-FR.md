# OpenList.ts

[![Déployer sur Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Wudarensheng/OpenList.ts)

[English](../README.md) · [简体中文](./README.zh-CN.md) · [繁體中文](./README.zh-TW.md) · [日本語](./README.ja-JP.md) · [Français](./README.fr-FR.md) · [조선어](./README.ko-KP.md)

Un programme de listage de fichiers pour [Cloudflare Workers](https://workers.cloudflare.com/) — une interface web de type OpenList/AList qui parcourt et gère des fichiers sur le stockage compatible S3 (Backblaze B2, Cloudflare R2, AWS S3, MinIO, …), Microsoft OneDrive, OneDrive APP, Alibaba Cloud Drive, PikPak, Dropbox et 189Cloud (天翼云盤).

Le tout est écrit en TypeScript, fonctionne par défaut sur le runtime Workers et stocke l'arborescence des fichiers et les liens de téléchargement dans [Cloudflare D1](https://developers.cloudflare.com/d1/). La couche de base de données est multi-cloud — avec `USE_D1=false` elle utilise PostgreSQL à la place (une liaison [Hyperdrive](https://developers.cloudflare.com/hyperdrive/) sur Cloudflare, ou une simple chaîne de connexion `PG_ADDRS`) — et le même gestionnaire de requêtes peut aussi fonctionner hors de Cloudflare sur Bun, Deno ou Node (voir [Exécution hors de Cloudflare](#-exécution-hors-de-cloudflare)).

> **OpenList.ts** est un projet de l'écosystème OpenList et un dérivé d'OpenList, faisant partie de l'écosystème OpenList.

---

## ✨ Fonctionnalités

- ☁️ Fonctionne entièrement sur Cloudflare Workers + D1 par défaut (aucun VPS requis)
- 🌍 **Multi-cloud & multi-plateforme** : la base de données supporte D1 ou PostgreSQL (Hyperdrive / `PG_ADDRS`) ; le même gestionnaire de requêtes fonctionne sur Bun / Deno / Node hors de Cloudflare
- 📁 Multi-stockage : **compatible S3** (B2 / R2 / AWS / MinIO), **OneDrive**, **OneDrive APP**, **Alibaba Cloud Drive**, **PikPak**, **Dropbox**, **189Cloud (天翼云盤)**
- 🗄️ **Cache d'arborescence** : la navigation lit l'arborescence depuis la base de données — le fournisseur de stockage n'est contacté que lorsqu'un administrateur visite un chemin à froid, et les URLs de téléchargement sont générées à la demande
- 🔐 Authentification et autorisation (invité / utilisateur / administrateur)
- 🛡️ **Authentification à deux facteurs TOTP (2FA)** — compatible Google Authenticator
- 🔑 Changement de mot de passe et mise à jour du profil
- 👤 Navigation anonyme (invité) via le compte utilisateur `guest`, désactivée par défaut
- 🖥️ Panneau d'administration : stockages, réglages, utilisateurs, pilotes et métadonnées par chemin
- 🔗 **Partage de fichiers** — partages protégés par mot de passe avec expiration et limites d'accès
- 📤 **Téléchargement hors-ligne** — confiez URL/magnets à aria2 / qBittorrent / Transmission
- 🗜️ **Aperçu et extraction d'archives** — listez et extrayez des archives zip / tar / gz sans télécharger tout le fichier
- 📥 Téléchargement direct (`/d/`), via proxy (`/p/`) et depuis une archive (`/ad/`, `/ap/`, `/ae/`), support Range/HEAD
- 💻 **WebDAV** (`/dav/`) — montez vos drives cloud en dossier local (Explorateur Windows, Finder macOS, rclone, …)
- 🔄 Cache des liens pré-signés avec déduplication singleflight

---

## 🚀 Déploiement rapide

[![Déployer sur Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Wudarensheng/OpenList.ts)

Cliquez sur le bouton ci-dessus pour déployer directement sur votre compte Cloudflare (Workers + D1 sont créés automatiquement). Après le déploiement, ouvrez l'URL de votre Worker, connectez-vous avec les identifiants par défaut, puis ajoutez un stockage dans le panneau d'administration.

### Déploiement manuel

Prérequis : [Node.js](https://nodejs.org/) 18+ et [Wrangler](https://developers.cloudflare.com/workers/wrangler/).

```bash
# 1. Installer les dépendances (pnpm recommandé)
pnpm install          # ou : npm install

# 2. Se connecter à Cloudflare
npx wrangler login

# 3. Créer la base D1 et noter le database_id
npx wrangler d1 create openlist-db
#   → copier le database_id dans wrangler.toml sous [[d1_databases]]

# 4. Appliquer le schéma
npm run db:init       # = wrangler d1 execute openlist-db --file=./src/models/schema.sql

# 5. (Optionnel) Aperçu local
npm run dev           # http://127.0.0.1:8787

# 6. Déployer sur Cloudflare
npm run deploy
```

---

## 🖥️ Développement local

```bash
pnpm install
npm run dev          # démarre wrangler dev sur http://127.0.0.1:8787
```

La base D1 est simulée localement sous `.wrangler/state`. Le schéma et les données de cache persistent entre les redémarrages.

Autres scripts utiles :

| Commande | Description |
|---|---|
| `npm run typecheck` | Vérification des types TypeScript (`tsc --noEmit`) |
| `npm run lint` | ESLint sur `src` |
| `npm test` | Exécuteur de tests Vitest |
| `npm run deploy` | Déploie le worker sur Cloudflare |
| `npm run build:node` | Construit la version Node.js dans `dist-node/` (`node build.js`) |
| `npm run db:reset` | Supprime toutes les tables et réinitialise le schéma |

---

## 🌍 Exécution hors de Cloudflare

Le même gestionnaire de requêtes peut fonctionner sur n'importe quel hôte avec des sémantiques Web standard `Request`/`Response`. Comme il n'y a pas de liaison D1 hors de Cloudflare, PostgreSQL est utilisé à la place :

- **Bun** : `bun run src/server.ts`
- **Deno** : `deno run --allow-net --allow-read --allow-env src/server.ts`
- **Node** : `node build.js` (ou `npm run build:node`) compile le projet et l'entrée Node intégrée vers `dist-node/`, puis `node dist-node/server-node.js`
- **Fonctions cloud** : exécutez `node build.js` comme étape de build du fournisseur et pointez l'entrée de la fonction vers `dist-node/server-node.js`

Exigences (pas de liaison D1 hors de Cloudflare) :

```bash
USE_D1=false                              # Mode PostgreSQL
PG_ADDRS=postgres://user:pass@host:5432/dbname
# optionnel : STATIC_BASE=https://...     # servir les assets depuis un serveur externe
# optionnel : PUBLIC_DIR=/path/to/public  # build node : fichiers statiques locaux (défaut dist-node/public)
# optionnel : PORT=3000                   # build node : port d'écoute
# optionnel : HOST=0.0.0.0                # build node : adresse de liaison
```

---

## 🔐 Authentification

### Identifiants par défaut

| Nom d'utilisateur | Mot de passe | Rôle |
|---|---|---|
| `admin` | `admin` | Administrateur |

> ⚠️ **Changez immédiatement le mot de passe par défaut après la première connexion** (Profil → Changer le mot de passe).

### Rôles

- **Invité** (`role 1`) — visiteurs anonymes. Le compte utilisateur `guest` est créé
  **désactivé** par défaut ; activez-le dans la liste des utilisateurs pour autoriser
  la navigation anonyme.
- **Utilisateur** (`role 0`) — peut parcourir et gérer les fichiers.
- **Administrateur** (`role 2`) — accès complet, y compris le panneau d'administration.

> La navigation ne contacte jamais le fournisseur de stockage. Seul un **administrateur** visitant un chemin à froid déclenche une requête au fournisseur pour remplir l'arborescence D1 ; invités et utilisateurs lisent toujours depuis le cache.

### Authentification à deux facteurs (2FA)

1. Connectez-vous, puis allez dans **Profil** → **Authentification à deux facteurs**.
2. Cliquez sur **Activer** pour générer un secret, scannez le QR code avec Google Authenticator (ou toute application TOTP).
3. Saisissez le code à 6 chiffres pour confirmer.
4. Désormais, les connexions nécessitent le code à 6 chiffres.

La page de connexion affiche automatiquement le champ OTP lorsque votre compte a activé la 2FA.

---

## 🗄️ Cache d'arborescence

L'arborescence est mise en cache dans D1 pour une navigation rapide et respectueuse du fournisseur :

1. **La navigation** (`/api/fs/list`, `/api/fs/get`, `/api/fs/dirs`) lit l'arborescence **uniquement depuis D1**. Le fournisseur de stockage n'est jamais contacté.
2. Lorsqu'un **administrateur** ouvre un chemin non mis en cache (ou expiré), le worker liste le répertoire distant une fois et le stocke dans D1 (tables `files`, `file_cache`).
3. **Les téléchargements** (`/d/` et `/p/`) génèrent une URL signée à la demande et la mettent en cache dans D1 (table `file_links`), pour ne pas re-signer à chaque téléchargement.
4. Les répertoires vides sont aussi mis en cache (marqués par une ligne `file_cache`).

Configurez la durée de vie du cache par stockage via le champ `cache_expiration` (minutes, défaut 30).

---

## 📦 Stockages pris en charge

### Compatible S3 (Backblaze B2, Cloudflare R2, AWS S3, MinIO, …)

Dans le panneau d'administration, ajoutez un stockage avec le pilote **S3** et le JSON `addition` :

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

> Pour Backblaze B2, utilisez `region: "auto"` — le pilote détecte automatiquement la région depuis l'hôte de l'endpoint.

### Microsoft OneDrive / OneDrive APP

Deux pilotes sont disponibles :

- **OneDrive** — OneDrive personnel via un refresh token.
- **OneDrive APP** — flux d'inscription d'application Azure AD avec prise en charge des régions Global / CN (世纪互联) / DE / US.

Exemple `addition` (OneDrive APP) :

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

### 189Cloud (天翼云盤)

Exemple `addition` :

```json
{
  "username": "your-phone-number",
  "password": "your-password",
  "cookie": ""
}
```

> Si la connexion échoue à cause d'un CAPTCHA, remplissez le champ `cookie` avec un cookie de session connecté.

---

## 📡 Référence API

### Authentification

| Méthode | Chemin | Description |
|---|---|---|
| POST | `/api/auth/login` | Connexion (mot de passe en clair) |
| POST | `/api/auth/login/hash` | Connexion (hash sha256, utilisé par le frontend ; supporte `otp_code`) |
| GET | `/api/auth/me` | Obtenir l'utilisateur courant |
| GET | `/api/auth/logout` | Déconnexion |
| POST | `/api/auth/2fa/generate` | Générer un secret TOTP (retourne `secret` + `qr`) |
| POST | `/api/auth/2fa/verify` | Vérifier un code et activer la 2FA |
| POST | `/api/auth/2fa/disable` | Désactiver la 2FA (code valide requis) |
| GET | `/api/auth/sso` | Redirection de connexion SSO (Github / Microsoft / Google / OIDC) |
| GET | `/api/auth/sso_callback` | Rappel SSO |
| GET | `/api/auth/get_sso_id` | Obtenir l'identité SSO de l'utilisateur courant |
| GET | `/api/auth/sso_get_token` | Échanger un code SSO contre un jeton de session |

### Profil

| Méthode | Chemin | Description |
|---|---|---|
| GET | `/api/me` | Obtenir le profil de l'utilisateur courant |
| POST | `/api/me/update` | Mettre à jour nom d'utilisateur / mot de passe (`old_password` requis pour le mot de passe) |
| GET | `/api/me/sshkey/list` | Clés SSH (stub) |

### Système de fichiers

| Méthode | Chemin | Description |
|---|---|---|
| POST | `/api/fs/list` | Lister les fichiers d'un répertoire (`path`, `page`, `per_page`, `refresh`) |
| POST | `/api/fs/get` | Obtenir les infos fichier/dossier (`path`) |
| POST | `/api/fs/dirs` | Lister les dossiers (`path`) |
| POST | `/api/fs/mkdir` | Créer un dossier (`path`, `name`) |
| POST | `/api/fs/rename` | Renommer (`path`, `name`) |
| POST | `/api/fs/batch_rename` | Renommage par lot |
| POST | `/api/fs/regex_rename` | Renommage par expression régulière |
| POST | `/api/fs/remove` | Supprimer (`dir`, `names[]`) |
| POST | `/api/fs/remove_empty_directory` | Supprimer les dossiers vides |
| POST | `/api/fs/move` | Déplacer (`src_dir`, `dst_dir`, `names[]`) |
| POST | `/api/fs/recursive_move` | Déplacement récursif |
| POST | `/api/fs/copy` | Copier (`src_dir`, `dst_dir`, `names[]`) |
| PUT | `/api/fs/put` | Téléverser (`?path=` + corps) |
| PUT | `/api/fs/form` | Téléversement multipart |
| POST | `/api/fs/add_offline_download` | Ajouter une tâche de téléchargement hors-ligne (aria2 / qBittorrent / Transmission) |
| POST | `/api/fs/archive/meta` | Obtenir les métadonnées d'archive (`path`) |
| POST | `/api/fs/archive/list` | Lister les fichiers d'une archive (`path`, `inner`) |
| POST | `/api/fs/archive/decompress` | Décompresser une archive (`src_dir`, `dst_dir`, `names[]`) |
| POST | `/api/fs/search` | Recherche (stub) |
| POST | `/api/fs/other` | Autres opérations du pilote (stub) |
| POST | `/api/fs/link` | Générer un lien de téléchargement (`path`) |
| POST | `/api/fs/get_direct_upload_info` | Obtenir les infos de téléversement direct |

### Téléchargement / proxy

| Méthode | Chemin | Description |
|---|---|---|
| GET | `/d/<path>` | Redirection 302 vers l'URL signée |
| GET/HEAD | `/p/<path>` | Diffuser le fichier via le worker (Range supporté) |
| GET | `/ad/<path>?inner=` | Diffuser un fichier depuis une archive |
| GET | `/ap/<path>?inner=` | Proxifier un fichier depuis une archive (Range supporté) |
| GET | `/ae/<path>?inner=` | Extraire une entrée d'archive (téléchargement) |
| GET | `/sd/<sid>/<path>` | Télécharger un fichier d'un partage (`pwd` pour les partages protégés) |

### Partage

| Méthode | Chemin | Description |
|---|---|---|
| GET | `/api/share/list` | Lister les partages |
| GET | `/api/share/get?id=` | Obtenir un partage |
| POST | `/api/share/create` | Créer un partage (`files[]`, `expires`, `pwd`, `max_accessed`, …) |
| POST | `/api/share/update` | Mettre à jour un partage |
| POST | `/api/share/delete?id=` | Supprimer un partage |
| POST | `/api/share/enable?id=` | Activer un partage |
| POST | `/api/share/disable?id=` | Désactiver un partage |

### WebDAV

Montez vos drives cloud en dossier local via le protocole WebDAV standard sur `/dav/`. Méthodes supportées :
`PROPFIND`, `GET`, `HEAD`, `PUT`, `MKCOL`, `DELETE`, `MOVE`, `COPY`, `LOCK`, `UNLOCK`, `OPTIONS`.

Chaque stockage apparaît comme un dossier de premier niveau sous `/dav/` (ex. `/dav/backblaze/...`).

### Administration — stockages

| Méthode | Chemin | Description |
|---|---|---|
| GET | `/api/admin/storage/list` | Lister les stockages |
| GET | `/api/admin/storage/get?id=` | Obtenir un stockage |
| POST | `/api/admin/storage/create` | Créer un stockage |
| POST | `/api/admin/storage/update` | Mettre à jour un stockage |
| POST | `/api/admin/storage/delete?id=` | Supprimer un stockage |
| POST | `/api/admin/storage/enable?id=` | Activer |
| POST | `/api/admin/storage/disable?id=` | Désactiver |
| POST | `/api/admin/storage/refresh` | Rafraîchir tous les caches d'arborescence |
| POST | `/api/admin/storage/refresh_one?id=` | Rafraîchir un cache de stockage |

### Administration — réglages

| Méthode | Chemin | Description |
|---|---|---|
| GET | `/api/admin/setting/list` | Lister les réglages (optionnel `?group=`) |
| GET | `/api/admin/setting/get?key=` | Obtenir un réglage |
| POST | `/api/admin/setting/save` | Enregistrer un ou plusieurs réglages |
| POST | `/api/admin/setting/delete?key=` | Supprimer un réglage |

### Administration — utilisateurs

| Méthode | Chemin | Description |
|---|---|---|
| GET | `/api/admin/user/list` | Lister les utilisateurs |
| GET | `/api/admin/user/get?id=` | Obtenir un utilisateur |
| POST | `/api/admin/user/create` | Créer un utilisateur |
| POST | `/api/admin/user/update` | Mettre à jour un utilisateur |
| POST | `/api/admin/user/delete?id=` | Supprimer un utilisateur |

### Administration — pilotes

| Méthode | Chemin | Description |
|---|---|---|
| GET | `/api/admin/driver/names` | Lister les noms de pilotes enregistrés |
| GET | `/api/admin/driver/list` | Carte des infos pilotes |
| GET | `/api/admin/driver/info?driver=` | Infos d'un pilote |

### Administration — métadonnées (par chemin)

| Méthode | Chemin | Description |
|---|---|---|
| GET | `/api/admin/meta/list` | Lister les métadonnées |
| GET | `/api/admin/meta/get?path=` | Obtenir les métadonnées d'un chemin |
| POST | `/api/admin/meta/create` | Créer des métadonnées (readme / header / mot de passe / masquer / utilisateurs lecture-écriture) |
| POST | `/api/admin/meta/update` | Mettre à jour des métadonnées |
| POST | `/api/admin/meta/delete?path=` | Supprimer des métadonnées |

### Tâches (téléchargement hors-ligne, transfert, …)

| Méthode | Chemin | Description |
|---|---|---|
| GET | `/api/task/<type>/undone` | Lister les tâches non terminées |
| GET | `/api/task/<type>/done` | Lister les tâches terminées |
| GET | `/api/task/<type>/info?tid=` | Obtenir les infos d'une tâche |
| POST | `/api/task/<type>/cancel?tid=` | Annuler une tâche |
| POST | `/api/task/<type>/delete?tid=` | Supprimer une tâche |
| POST | `/api/task/<type>/retry?tid=` | Réessayer une tâche |
| POST | `/api/task/<type>/clear_done` | Effacer les tâches terminées |

### Public

| Méthode | Chemin | Description |
|---|---|---|
| GET | `/api/public/settings` | Réglages publics (titre du site, logo, favicon, …) |
| GET | `/api/public/archive_extensions` | Extensions d'archives |
| GET | `/api/public/offline_download_tools` | Outils de téléchargement hors-ligne configurés (aria2 / qBittorrent / Transmission) |

---

## ⚙️ Réglages

| Clé | Défaut | Description |
|---|---|---|
| `site_title` | `OpenList` | Titre du site |
| `site_description` | `A file list program` | Description du site |
| `logo` | `/images/logo.svg` | Logo |
| `favicon` | `/images/logo.png` | Favicon |
| `max_connections` | `0` | Connexions max (0 = illimité) |
| `cache_expiration` | `30` | Durée de vie du cache (minutes) |
| `aria2_uri` / `aria2_secret` | | Endpoint RPC aria2 / secret (téléchargement hors-ligne) |
| `qbittorrent_url` / `qbittorrent_seedtime` | | Web API qBittorrent / temps de partage (téléchargement hors-ligne) |
| `transmission_uri` / `transmission_seedtime` | | RPC Transmission / temps de partage (téléchargement hors-ligne) |

> La navigation anonyme est contrôlée par le compte **`guest`** dans la liste des
> utilisateurs — créé désactivé par défaut. Activez-le pour permettre aux visiteurs
> de parcourir sans se connecter.

---

## 🗂️ Structure du projet

```
src/
├── db/                       # Couche de base de données multi-cloud (D1 / PostgreSQL / Hyperdrive)
│   ├── types.ts              # Interface Database partagée (aucun type CF)
│   ├── d1.ts                 # Adaptateur D1 (Cloudflare)
│   ├── postgres.ts           # Adaptateur PostgreSQL (postgres.js, multi-cloud)
│   ├── sqlite.ts             # Traducteur SQL SQLite → PostgreSQL
│   └── index.ts              # createDatabase(env) : bascule USE_D1 / PG_ADDRS
├── drivers/                  # Pilotes de stockage
│   ├── types.ts              # Interfaces de base des pilotes
│   ├── registry.ts           # Enregistrement et recherche des pilotes
│   ├── base.ts               # Aides communes
│   ├── s3/                   # Pilote compatible S3
│   ├── onedrive/             # Pilote OneDrive
│   ├── onedrive_app/         # Pilote OneDrive APP (application Azure AD)
│   ├── aliyundrive_open/     # Pilote Alibaba Cloud Drive
│   ├── pikpak/               # Pilote PikPak
│   ├── dropbox/              # Pilote Dropbox
│   ├── cloud189/             # Pilote 189Cloud (天翼云盤)
│   ├── google_drive/         # Pilote Google Drive
│   ├── webdav/               # Pilote WebDAV
│   └── template.ts           # Squelette de pilote prêt à copier
├── models/
│   ├── init.ts               # Initialisation du schéma et données par défaut
│   └── schema.sql            # Schéma D1
├── routes/
│   ├── api.ts                # Routeur API
│   ├── auth.ts               # Authentification + 2FA + profil
│   ├── sso.ts                # Connexion SSO (Github / Microsoft / Google / OIDC)
│   ├── fs.ts                 # Routes système de fichiers + cache base de données
│   ├── download.ts           # Routes de téléchargement /d/, /p/ et archives
│   ├── share.ts              # Routes de partage de fichiers
│   ├── storage.ts            # Routes d'administration des stockages
│   ├── settings.ts           # Routes d'administration des réglages
│   ├── users.ts              # Routes d'administration des utilisateurs
│   ├── drivers.ts            # Routes d'administration des pilotes
│   ├── meta.ts               # Routes d'administration des métadonnées par chemin
│   ├── tasks.ts              # Routes de tâches (téléchargement hors-ligne, transfert, …)
│   ├── refresh.ts            # Routes de rafraîchissement du cache
│   ├── webdav.ts             # Routes WebDAV
│   └── static.ts             # Assets statiques
├── utils/
│   ├── otp.ts                # Implémentation TOTP
│   ├── crypto.ts             # Aides de hachage de mot de passe
│   ├── auth.ts               # Aides jeton / mot de passe / permissions
│   ├── sign.ts               # Signature des liens de téléchargement
│   ├── guest.ts              # Modèle utilisateur invité
│   ├── response.ts           # Aide de réponse JSON
│   ├── meta.ts               # Aides de métadonnées par chemin
│   ├── archive.ts            # Aperçu / extraction d'archives (zip / tar / gz)
│   └── offline.ts            # Téléchargement hors-ligne (aria2 / qBittorrent / Transmission)
├── cache.ts                  # Primitives de cache base de données (fichiers, liens, verrous)
├── router.ts                 # Routeur principal
├── types.ts                  # Types TypeScript
├── static-local.ts           # Fournisseur statique local (Bun / Deno, sans node)
├── server.ts                 # Entrée multi-plateforme (Bun / Deno)
└── worker.ts                 # Point d'entrée du worker (Cloudflare)
```

### Ajouter un nouveau pilote de stockage

1. Créez `src/drivers/<name>/index.ts` implémentant l'interface `Driver` (`list`, `get`, `link`, `mkdir`, `rename`, `copy`, `move`, `remove`, `put`).
2. Exportez `config` et `additional`, puis appelez `registerDriver(...)`.
3. Importez le module dans `src/drivers/registry.ts`.

Voir `src/drivers/template.ts` pour un squelette prêt à copier.

---

## 📄 Licence

[AGPL-3.0](../LICENSE)
