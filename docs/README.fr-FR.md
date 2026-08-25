# OpenList.ts

[![Déployer sur Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Wudarensheng/OpenList.ts)

[English](../README.md) · [简体中文](./README.zh-CN.md) · [繁體中文](./README.zh-TW.md) · [日本語](./README.ja-JP.md) · [Français](./README.fr-FR.md) · [조선어](./README.ko-KP.md)

Un programme de listage de fichiers pour [Cloudflare Workers](https://workers.cloudflare.com/) — une interface web de type OpenList/AList qui parcourt et gère des fichiers sur le stockage compatible S3 (Backblaze B2, Cloudflare R2, AWS S3, MinIO, …), Microsoft OneDrive, Alibaba Cloud Drive, PikPak et Dropbox.

Le tout est écrit en TypeScript, fonctionne sur le runtime Workers et stocke l'arborescence des fichiers et les liens de téléchargement dans [Cloudflare D1](https://developers.cloudflare.com/d1/).

> **OpenList.ts** est un projet de l'écosystème OpenList et un dérivé d'OpenList, faisant partie de l'écosystème OpenList.

---

## ✨ Fonctionnalités

- ☁️ Fonctionne entièrement sur Cloudflare Workers + D1 (aucun VPS requis)
- 📁 Multi-stockage : **compatible S3** (B2 / R2 / AWS / MinIO), **OneDrive**, **OneDrive APP**, **Alibaba Cloud Drive**, **PikPak**, **Dropbox**
- 🗄️ **Cache d'arborescence D1** : la navigation lit l'arborescence depuis D1 — le fournisseur de stockage n'est contacté que lorsqu'un administrateur visite un chemin à froid, et les URLs de téléchargement sont générées à la demande
- 🔐 Authentification et autorisation (invité / utilisateur / administrateur)
- 🛡️ **Authentification à deux facteurs TOTP (2FA)** — compatible Google Authenticator
- 🔑 Changement de mot de passe et mise à jour du profil
- 👤 Navigation anonyme (invité) via le compte utilisateur `guest`, désactivée par défaut
- 🖥️ Panneau d'administration : stockages, réglages, utilisateurs et pilotes
- 📥 Téléchargement direct (`/d/`) et via proxy (`/p/`), support Range/HEAD
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
| `npm run db:reset` | Supprime toutes les tables et réinitialise le schéma |

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
| POST | `/api/fs/remove` | Supprimer (`dir`, `names[]`) |
| POST | `/api/fs/move` | Déplacer (`src_dir`, `dst_dir`, `names[]`) |
| POST | `/api/fs/copy` | Copier (`src_dir`, `dst_dir`, `names[]`) |
| PUT | `/api/fs/put` | Téléverser (`?path=` + corps) |
| PUT | `/api/fs/form` | Téléversement multipart |
| POST | `/api/fs/search` | Recherche (stub) |

### Téléchargement / proxy

| Méthode | Chemin | Description |
|---|---|---|
| GET | `/d/<path>` | Redirection 302 vers l'URL signée |
| GET/HEAD | `/p/<path>` | Diffuser le fichier via le worker (Range supporté) |

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

### Public

| Méthode | Chemin | Description |
|---|---|---|
| GET | `/api/public/settings` | Réglages publics (titre du site, logo, favicon, …) |
| GET | `/api/public/archive_extensions` | Extensions d'archives |
| GET | `/api/public/offline_download_tools` | Outils de téléchargement hors-ligne (stub) |

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

> La navigation anonyme est contrôlée par le compte **`guest`** dans la liste des
> utilisateurs — créé désactivé par défaut. Activez-le pour permettre aux visiteurs
> de parcourir sans se connecter.

---

## 🗂️ Structure du projet

```
src/
├── drivers/                  # Pilotes de stockage
│   ├── types.ts              # Interfaces de base des pilotes
│   ├── registry.ts           # Enregistrement et recherche des pilotes
│   ├── base.ts               # Aides communes
│   ├── s3/                   # Pilote compatible S3
│   ├── onedrive/             # Pilote OneDrive
│   ├── onedrive_app/         # Pilote OneDrive APP (application Azure AD)
│   ├── aliyundrive_open/     # Pilote Alibaba Cloud Drive
│   ├── pikpak/               # Pilote PikPak
│   └── dropbox/              # Pilote Dropbox
├── models/
│   ├── init.ts               # Initialisation du schéma et données par défaut
│   └── schema.sql            # Schéma D1
├── routes/
│   ├── api.ts                # Routeur API
│   ├── auth.ts               # Authentification + 2FA + profil
│   ├── fs.ts                 # Routes système de fichiers + cache D1
│   ├── download.ts           # Routes de téléchargement /d/ et /p/
│   ├── storage.ts            # Routes d'administration des stockages
│   ├── settings.ts           # Routes d'administration des réglages
│   ├── users.ts              # Routes d'administration des utilisateurs
│   ├── drivers.ts            # Routes d'administration des pilotes
│   ├── refresh.ts            # Routes de rafraîchissement du cache
│   └── static.ts             # Assets statiques
├── utils/
│   ├── otp.ts                # Implémentation TOTP
│   ├── crypto.ts             # Aides de hachage de mot de passe
│   ├── guest.ts              # Modèle utilisateur invité
│   └── response.ts           # Aide de réponse JSON
├── cache.ts                  # Primitives de cache D1 (fichiers, liens, verrous)
├── router.ts                 # Routeur principal
├── types.ts                  # Types TypeScript
└── worker.ts                 # Point d'entrée du worker
```

### Ajouter un nouveau pilote de stockage

1. Créez `src/drivers/<name>/index.ts` implémentant l'interface `Driver` (`list`, `get`, `link`, `mkdir`, `rename`, `copy`, `move`, `remove`, `put`).
2. Exportez `config` et `additional`, puis appelez `registerDriver(...)`.
3. Importez le module dans `src/drivers/registry.ts`.

Voir `src/drivers/template.ts` pour un squelette prêt à copier.

---

## 📄 Licence

[AGPL-3.0](../LICENSE)
