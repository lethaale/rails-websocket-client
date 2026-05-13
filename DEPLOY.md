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
- **Postgres instead of SQLite.** Production uses a Fly Managed Postgres (MPG) cluster per app. The four `*_DATABASE_URL` secrets are wired by `fly mpg attach`; both Rails and the Go listener read them. No volume mounts, no SQLite contention.
- **One Fly app per region** (`rwc-tyo`, `rwc-fra`, `rwc-nyc`). Each gets its own hostname and its own Postgres cluster, fully independent — what you want for a geo-latency demo.

## First-time setup

```bash
brew install flyctl
fly auth login
```

`fly.toml` is region-neutral: no `primary_region`, no `REGION` env. Pass `--primary-region` at deploy time and set the per-region `REGION` as a secret.

### Tokyo (`nrt`)

```bash
# 1. Create the app shell.
fly apps create rwc-tyo

# 2. Provision the Managed Postgres cluster (Basic plan, $38/mo).
#    Capture the cluster ID from the output (looks like `1zqyxr7dyeerwp8m`).
fly mpg create -n rwc-tyo-db -r nrt --plan Basic
CLUSTER=<paste-cluster-id-here>

# 3. Create the three extra databases on that cluster. The default
#    `fly-db` becomes DATABASE_URL (primary); these become queue/cable/cache.
fly mpg databases create $CLUSTER -n rwc_queue
fly mpg databases create $CLUSTER -n rwc_cable
fly mpg databases create $CLUSTER -n rwc_cache

# 4. Attach the cluster four times — once per logical database — so each
#    one lands as its own secret on the app.
fly mpg attach $CLUSTER -a rwc-tyo                                            # DATABASE_URL → fly-db
fly mpg attach $CLUSTER -a rwc-tyo -d rwc_queue --variable-name QUEUE_DATABASE_URL
fly mpg attach $CLUSTER -a rwc-tyo -d rwc_cable --variable-name CABLE_DATABASE_URL
fly mpg attach $CLUSTER -a rwc-tyo -d rwc_cache --variable-name CACHE_DATABASE_URL

# 5. The non-DB secrets: Rails master key + the region badge.
fly secrets set --app rwc-tyo \
  RAILS_MASTER_KEY="$(cat config/master.key)" \
  REGION=tyo

# 6. Build remotely and deploy. --primary-region pins the machines to nrt.
fly deploy --app rwc-tyo --remote-only --primary-region nrt --yes
```

`bin/fly-start` runs `bin/rails db:prepare` at boot, which loads each schema into its respective database — standard Rails 8 multi-database behavior, nothing custom.

Open `https://rwc-tyo.fly.dev/`. Badge should read **region: tyo**.

### Frankfurt (`fra`)

Same recipe, just substitute region/app/region-badge:

```bash
fly apps create rwc-fra

fly mpg create -n rwc-fra-db -r fra --plan Basic
CLUSTER=<paste-cluster-id-here>

fly mpg databases create $CLUSTER -n rwc_queue
fly mpg databases create $CLUSTER -n rwc_cable
fly mpg databases create $CLUSTER -n rwc_cache

fly mpg attach $CLUSTER -a rwc-fra
fly mpg attach $CLUSTER -a rwc-fra -d rwc_queue --variable-name QUEUE_DATABASE_URL
fly mpg attach $CLUSTER -a rwc-fra -d rwc_cable --variable-name CABLE_DATABASE_URL
fly mpg attach $CLUSTER -a rwc-fra -d rwc_cache --variable-name CACHE_DATABASE_URL

fly secrets set --app rwc-fra \
  RAILS_MASTER_KEY="$(cat config/master.key)" \
  REGION=fra

fly deploy --app rwc-fra --remote-only --primary-region fra --yes
```

## Push-to-deploy from GitHub

In the Fly dashboard for the app, **Settings → GitHub** → connect your repo. From then on, every push to `main` triggers a remote build and deploy.

## Adding more regions on Fly

Pick a region code from `fly platform regions` (e.g. `nyc`, `sin`, `syd`) and run the same six-step recipe with the new region and app name.

Useful day-2 commands:

```bash
fly logs --app rwc-tyo
fly ssh console --app rwc-tyo
fly status --app rwc-tyo
fly machine restart --app rwc-tyo <machine-id>
fly mpg connect --cluster <cluster-id>    # psql into the managed Postgres
```

## Pricing

`shared-cpu-1x@1gb` Machine ≈ ~$5/mo per region, plus Fly Managed Postgres Basic at $38/mo per cluster. Two regions ≈ ~$86/mo, three ≈ ~$129/mo. Note Fly auto-creates a second machine per app for HA (~$5/mo extra each) — pass `min_machines_running = 0` in `fly.toml` or `fly machine destroy <id>` the spare if you want a single box per region. Cheaper than running production at Aura was; expensive for a toy. Tear down between demos if cost matters.

## Teardown

These apps are demo-only — billing keeps running until you destroy both the app *and* the Postgres cluster (they're independent resources). Tear everything down with:

```bash
# Tokyo
fly mpg list                                            # find the cluster ID if you've lost it
fly apps destroy rwc-tyo -y
fly mpg destroy <tyo-cluster-id> -y

# Frankfurt
fly apps destroy rwc-fra -y
fly mpg destroy <fra-cluster-id> -y
```

Verify nothing's left:

```bash
fly apps list      # rwc-* should be gone
fly mpg list       # rwc-*-db should be gone
```

Destroying the app does not destroy its attached MPG cluster — easy to forget and keep paying $38/mo for an unused database. Always run both.

## Caveats

- The listener runs as a background process, not a separately supervised one. If the Go binary crashes, Rails keeps running but no new prices flow. Restart via `fly machine restart`. For production you'd want proper supervision (s6-overlay or a separate process group).
- Fly's natural model is one app many regions with anycast routing. We're explicitly *not* doing that here, because the demo needs distinct per-region URLs so the audience can compare them side-by-side.
- Postgres adds ~1–2 ms per query vs SQLite, but removes the single-writer contention that capped throughput on the SQLite version. Net win on a hot WebSocket feed.
