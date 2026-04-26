# Auto-deploy

Tag-triggered deploy from GitHub Actions to the homelab box, over Cloudflare
Tunnel + Access. No public inbound port; the host's sshd binds `127.0.0.1`
only and is reachable solely via the tunnel after CF Access validates a
service token.

## Pipeline

```
git tag v0.1.0 && git push --tags
   ↓
GitHub Actions: .github/workflows/deploy.yml
   ↓ pull image  ghcr.io/<owner>/imghost:sha-<short>     (built by CI)
   ↓ promote to ghcr.io/<owner>/imghost:v0.1.0  + :latest
   ↓ ssh deploy@ssh.aigf.dev   (via cloudflared access ssh, CF Access service token)
   ↓
Host (forced command): cd /opt/imghost && docker compose pull && docker compose up -d
```

Rollback: `gh workflow run deploy.yml -f tag=v0.0.9` re-runs the same flow
against an older image. CI never has to rebuild — the rollback target already
exists in GHCR.

## One-time host setup

### 1. Move the compose file under `/opt/imghost`

```bash
sudo install -d -m 0755 /opt/imghost
sudo install -m 0644 docker-compose.yml /opt/imghost/docker-compose.yml
```

The `/etc/imghost.env` file already lives at the path the compose `env_file`
expects — no change needed.

### 2. Bind sshd to localhost

The tunnel ingress points at `ssh://localhost:22`. The host's sshd must not
also be listening on a public interface — that would defeat the entire
"no public inbound" stance.

`/etc/ssh/sshd_config` (or a drop-in under `/etc/ssh/sshd_config.d/`):

```
ListenAddress 127.0.0.1
ListenAddress ::1
```

Restart sshd, then verify nothing else is listening:

```bash
sudo systemctl restart sshd
sudo ss -lntp | grep ':22'   # should show only 127.0.0.1 / ::1
```

### 3. Create the deploy user

```bash
sudo useradd -m -s /bin/bash -G docker deploy
sudo install -d -m 0700 -o deploy -g deploy /home/deploy/.ssh
```

The `docker` group is required so the forced command can talk to the docker
socket without sudo. (Membership in `docker` is effectively root — this is
the standard Docker trade-off; the forced command below restricts what `deploy`
can actually do.)

### 4. Generate the SSH keypair (on your workstation, not the host)

```bash
ssh-keygen -t ed25519 -C imghost-deploy -f imghost-deploy -N ""
```

This produces `imghost-deploy` (private) and `imghost-deploy.pub` (public).

Install the public key on the host with a forced command — even with the
private key, an attacker can run nothing else:

```bash
# /home/deploy/.ssh/authorized_keys (chmod 600, owned by deploy:deploy)
command="cd /opt/imghost && /usr/bin/docker compose pull && /usr/bin/docker compose up -d --remove-orphans",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty,restrict ssh-ed25519 AAAA...your-public-key-here imghost-deploy
```

The leading `command="..."` and the `restrict` option together mean:
- The literal `docker compose pull && up -d` runs on every connection,
  regardless of what the client requests.
- No port forwarding, X11, agent forwarding, PTY, or environment passing.
- If the client supplies its own command, it is silently replaced.

Verify from the host:

```bash
sudo -u deploy ssh -o StrictHostKeyChecking=no -i /tmp/imghost-deploy deploy@127.0.0.1 'whoami'
# → does not run `whoami`. Runs the forced command. Output is the docker compose pull/up output.
```

### 5. Cloudflare DNS + Tunnel ingress

```bash
cloudflared tunnel route dns imghost ssh.aigf.dev
```

Add the SSH ingress to `/etc/cloudflared/config.yml` (already in
`deploy/cloudflared.example.yml`):

```yaml
- hostname: ssh.aigf.dev
  service: ssh://localhost:22
```

Restart: `sudo systemctl restart cloudflared`.

### 6. Cloudflare Access app

Create `imghost-deploy` per `deploy/access-policies.md` §4. **Use a separate
service token from `imghost-uploader`** — different blast radius. The upload
token only POSTs to a single path; the deploy token gets shell.

Copy the service token Client ID + Secret — you'll add them as GitHub Secrets
in the next step.

## GitHub repo configuration

Add these secrets to **Settings → Secrets and variables → Actions**:

| Name | Value |
| --- | --- |
| `CF_ACCESS_CLIENT_ID` | Service token Client ID for `imghost-deploy` (looks like `<id>.access`). |
| `CF_ACCESS_CLIENT_SECRET` | Service token Client Secret. Shown once at creation. |
| `DEPLOY_SSH_KEY` | The `imghost-deploy` private key — entire file, including the `-----BEGIN`/`END-----` lines and trailing newline. |
| `DEPLOY_SSH_HOST` | `ssh.aigf.dev` |

`GITHUB_TOKEN` is provided automatically and is what the workflow uses to
push to GHCR. No additional setup needed beyond enabling **Settings → Actions
→ General → Workflow permissions → Read and write permissions** so the
default token can write packages.

(GHCR images are private by default. You can leave them private — the host
pulls authenticated via its own credential, see step 7. To make the image
public instead, go to **Packages → imghost → Package settings → Change
visibility**.)

### 7. Host-side GHCR auth

The host needs to `docker pull` from GHCR. Either:

**Option a — Public image (simplest).** Make the package public; no credential
required on the host. Slight info-leak: anyone can pull your runtime image
and inspect its bytes.

**Option b — Private image with a personal access token (recommended).**
Generate a fine-scoped GitHub PAT with `read:packages` only, then on the host:

```bash
echo "<github-pat>" | sudo -u deploy docker login ghcr.io -u <your-github-username> --password-stdin
```

The credential is stored in `/home/deploy/.docker/config.json` (mode 600).
Don't store it in `/etc/imghost.env` — that file is for the app, not docker.

## Cutting a release

```bash
# Bump version, commit, merge to master, then:
git tag v0.1.0
git push origin v0.1.0
```

GitHub UI → **Actions → Deploy** shows progress. The workflow refuses to start
if the `:sha-<short>` image for that commit doesn't exist in GHCR yet (the CI
run on the master commit must finish pushing first; takes 2–5 min).

## Rolling back

```bash
gh workflow run deploy.yml -f tag=v0.0.9
```

Or via the GitHub UI: **Actions → Deploy → Run workflow → Tag = v0.0.9**.
The image stays untouched in GHCR; only `:latest` moves and the host pulls.

## Verifying a deploy

The forced-command output streams back to the GitHub Actions log under
"Trigger host deploy". You'll see `Pulling imghost ...` and `Container imghost
Started`. Then:

```bash
# On the host:
docker compose -f /opt/imghost/docker-compose.yml ps
docker inspect imghost --format '{{.Config.Image}}'   # should match :latest digest
docker compose -f /opt/imghost/docker-compose.yml logs --tail=20 imghost
```

## Tearing the deploy path down

If you stop using auto-deploy:

1. Remove the `ssh.aigf.dev` ingress block from `/etc/cloudflared/config.yml`,
   then `sudo systemctl restart cloudflared`.
2. Delete the `imghost-deploy` Cloudflare Access app and revoke its service
   token.
3. Delete the `deploy` user: `sudo userdel -r deploy`.
4. Optionally re-bind sshd to a public interface if other workflows need it
   (most homelabs don't).
5. Delete the GitHub Secrets and the deploy workflow file.
