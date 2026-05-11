# Deploying to Vultr Tokyo (or any single box)

This walks through deploying one region to one $5/mo box. To add more regions, copy `config/deploy.tyo.yml` to `deploy.<region>.yml`, change the IP and `REGION` label, and run `bin/kamal deploy -d <region>`.

---

## 0. Prereqs (one-time)

You need:

- A **Docker Hub** account + a personal access token (Read/Write/Delete scope).
  - Create token: https://app.docker.com/settings/personal-access-tokens
- A **Vultr** account.
- `docker` running locally (Docker Desktop or OrbStack).
- Local Docker buildx capable of `--platform linux/amd64` (default on modern Docker Desktop).

Export the Docker Hub token in your shell **before any `bin/kamal` command**:

```bash
export KAMAL_REGISTRY_PASSWORD=dckr_pat_xxxxxxxxxxxxxxxxx
```

---

## 1. Provision a Tokyo droplet on Vultr

1. **Deploy New Server** → "Cloud Compute" → "Shared CPU".
2. **Location:** Tokyo (`nrt`).
3. **OS:** Ubuntu 24.04 LTS x64.
4. **Plan:** Regular Cloud Compute, 1 vCPU / 1 GB RAM (~$6/mo). The $5 IPv6-only plan also works but you'll need to use an IPv6-shaped sslip.io hostname; IPv4 is easier.
5. **SSH Keys:** add your public key (`~/.ssh/id_ed25519.pub` or `~/.ssh/id_rsa.pub`). Kamal SSHes in as root.
6. Deploy. Wait ~60 seconds. Note the public IPv4 address.

Sanity-check:

```bash
ssh root@<VULTR_IP> 'uname -a'
```

---

## 2. Fill in the templates

Edit `config/deploy.yml`:

```yaml
image: <docker_user>/rails_websocket_client                # ← your Docker Hub username
registry:
  username: <docker_user>                                  # ← same
accessories:
  listener:
    image: <docker_user>/rails_websocket_client_listener:latest   # ← same
```

Edit `config/deploy.tyo.yml`:

```yaml
servers:
  web:
    - 198.51.100.42                                        # ← Vultr IP
proxy:
  host: 198-51-100-42.sslip.io                             # ← same IP, dashes
accessories:
  listener:
    host: 198.51.100.42                                    # ← same IP
```

`sslip.io` resolves any dash-separated IP-shaped hostname back to that IP, so you don't need DNS. Once you have a real domain, swap `proxy.host` for it and flip `proxy.ssl: true`.

---

## 3. Build & push the Go listener image (one-off, repeat on Go changes)

Kamal can't build accessory images, only deploy them. Build once, push to Docker Hub:

```bash
docker buildx build \
  --platform linux/amd64 \
  --push \
  -t <docker_user>/rails_websocket_client_listener:latest \
  script/go-websockets/
```

Sanity-check the image exists at `hub.docker.com/r/<docker_user>/rails_websocket_client_listener`.

---

## 4. First-time deploy

```bash
bin/kamal setup -d tyo
```

This will:

1. Install Docker on the droplet.
2. Boot the Kamal proxy.
3. Build the Rails image locally (cross-compiled to amd64) and push it.
4. Pull the listener image you built in step 3.
5. Start both containers, bind-mounting `/var/lib/rails_websocket_client/storage` so they share the SQLite files.
6. Run `db:prepare`.

When it finishes, open `http://<VULTR_IP>.sslip.io/` — you should see the comparison page with `region: tyo` in the badge.

---

## 5. Subsequent deploys

Rails-only change:

```bash
bin/kamal deploy -d tyo
```

Go listener change (rebuild + restart the accessory):

```bash
docker buildx build --platform linux/amd64 --push \
  -t <docker_user>/rails_websocket_client_listener:latest \
  script/go-websockets/

bin/kamal accessory reboot listener -d tyo
```

---

## 6. Day-2 commands

```bash
bin/kamal app logs -f -d tyo                 # Rails logs
bin/kamal accessory logs listener -f -d tyo  # Go listener logs
bin/kamal app exec -i --reuse "bin/rails console" -d tyo
bin/kamal proxy logs -d tyo                  # SSL / routing logs
bin/kamal app boot -d tyo                    # restart Rails
```

---

## Adding more regions

```bash
cp config/deploy.tyo.yml config/deploy.fra.yml
# edit: new IP, new sslip host, REGION: fra
bin/kamal setup -d fra
```

Repeat for any region. Each box is fully independent (its own SQLite, its own Binance connection), which is exactly what you want for a geo-latency demo.

---

# Alternative: Fly.io (push-to-deploy from GitHub)

If you'd rather skip the manual Vultr provisioning and Docker Hub build/push, Fly.io can build from your GitHub repo on every push. Same end-to-end architecture (Rails + Go listener on one Machine, both talking to the same database), totally different deploy story.

## How it's structured

- **One unified Docker image** built by `Dockerfile`. A `golang:1.25-alpine` build stage produces the listener binary and copies it to `/usr/local/bin/listener` in the final image; same image runs Rails.
- **One Machine per app**, running `bin/fly-start` — a tiny script that prepares the database, loads the Solid Queue / Cable / Cache schemas, then runs Rails in the foreground and the Go listener in the background once Rails is healthy.
- **Postgres instead of SQLite.** Production uses a Fly Managed Postgres (Supabase) instance per app. `DATABASE_URL` is auto-injected as a Fly secret; both Rails and the Go listener read it. No volume mounts, no SQLite contention.
- **One Fly app per region** (`rwc-tyo`, `rwc-fra`, `rwc-nyc`). Each gets its own hostname and its own Postgres database, fully independent — what you want for a geo-latency demo.

## First-time setup

```bash
brew install flyctl
fly auth login
```

Create the Tokyo app and provision its database:

```bash
fly apps create rwc-tyo

# Provision Supabase-managed Postgres in the same region. This injects
# DATABASE_URL into the app's secrets automatically.
fly ext supabase create --app rwc-tyo --region nrt

# Rails secret for credential decryption.
fly secrets set RAILS_MASTER_KEY=$(cat config/master.key) --app rwc-tyo

# Build remotely (no local cross-compile) and deploy.
fly deploy --app rwc-tyo --remote-only
```

Open `https://rwc-tyo.fly.dev/`. Badge should read **region: tyo**.

## Push-to-deploy from GitHub

In the Fly dashboard for the app, **Settings → GitHub** → connect your repo. From then on, every push to `main` triggers a remote build and deploy.

## Adding more regions on Fly

Each region is its own app + its own Postgres on Fly:

```bash
fly apps create rwc-fra
fly ext supabase create --app rwc-fra --region fra
fly secrets set RAILS_MASTER_KEY=$(cat config/master.key) REGION=fra --app rwc-fra
fly deploy --app rwc-fra --config fly.toml --remote-only
```

Useful day-2 commands:

```bash
fly logs --app rwc-tyo
fly ssh console --app rwc-tyo
fly status --app rwc-tyo
fly machine restart --app rwc-tyo <machine-id>
```

## Pricing

`shared-cpu-1x@1gb` Machine ≈ ~$5/mo per region, plus Supabase Managed Postgres at ~$20–25/mo per region (free tier exists but pauses on inactivity — not ideal for a demo you point at a URL). Three regions ≈ $75–90/mo total. Cheaper than running production at Aura was; expensive for a toy. Tear down between demos if cost matters.

## Caveats

- The listener runs as a background process, not a separately supervised one. If the Go binary crashes, Rails keeps running but no new prices flow. Restart via `fly machine restart`. For production you'd want proper supervision (s6-overlay or a separate process group).
- Fly's natural model is one app many regions with anycast routing. We're explicitly *not* doing that here, because the demo needs distinct per-region URLs so the audience can compare them side-by-side.
- Postgres adds ~1–2 ms per query vs SQLite, but removes the single-writer contention that capped throughput on the SQLite version. Net win on a hot WebSocket feed.
