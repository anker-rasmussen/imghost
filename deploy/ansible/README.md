# Ansible playbook for the imghost homelab host

Bootstrap and ongoing config for the box that runs imghost. Stops where
Docker takes over — the service deploy itself (`.github/workflows/deploy.yml`,
the GHCR pull, the forced-command SSH) is unchanged and out of scope here.

## What this configures

| Concern | Role |
| --- | --- |
| sshd ListenAddress allow-list (loopback + LAN + Tailscale, never WAN) | `sshd_hardening` |
| `deploy` user + forced-command authorized key | `deploy_user` |
| Docker Engine + compose v2 plugin | `docker_engine` |
| cloudflared install, tunnel credentials, ingress config | `cloudflared` |
| `/opt/imghost/docker-compose.yml`, `/etc/imghost.env` | `imghost_host` |

`imghost_host` declares the other four as `meta/dependencies`; `site.yml`
also lists them explicitly for readability. Ansible deduplicates so order
is what matters and there's no double-run.

## Out of scope (intentionally)

- `.github/workflows/deploy.yml` and the GHCR pipeline.
- Contents of the `imghost-data` Docker volume.
- Cloudflare Access policies (configured in the Cloudflare dashboard, see
  `deploy/access-policies.md`).
- Anything that needs the `imghost-deploy` private SSH key. That key
  lives on whichever workstation runs Ansible and on GitHub Actions. The
  matching public key is committed to the vault.

## Requirements

- Ansible 2.14+ on the controller. No external collections — the
  playbook uses only `ansible.builtin`.
- Target host running Debian or Ubuntu. The Docker / cloudflared roles
  assert this and fail fast on anything else.
- A workstation that can reach the box. Anything in
  `sshd_listen_addresses` works post-hardening — typically the LAN IP
  and the Tailscale IP. Off-LAN reach goes through the cloudflared
  tunnel; see the ProxyCommand snippet in `inventory/hosts.yml`.

## Layout

```
deploy/ansible/
├── ansible.cfg
├── site.yml
├── inventory/hosts.yml
├── group_vars/
│   ├── imghost.yml                            # non-secret defaults
│   └── imghost.vault.yml.example              # template for the encrypted secret file
├── host_vars/
│   └── imghost.aigf.dev.yml.example           # per-host LAN/Tailscale IPs
└── roles/{sshd_hardening,deploy_user,docker_engine,cloudflared,imghost_host}/
```

## First run

1. **Create and encrypt the vault file.**

   ```bash
   cp group_vars/imghost.vault.yml.example group_vars/imghost.vault.yml
   $EDITOR group_vars/imghost.vault.yml          # fill in real values
   ansible-vault encrypt group_vars/imghost.vault.yml
   ```

   The decryption password lives outside the repo. Save it in a password
   manager; supply it at runtime with `--ask-vault-pass` or via
   `ANSIBLE_VAULT_PASSWORD_FILE`.

2. **Edit `inventory/hosts.yml`** with the real hostname and the user
   Ansible should connect as. If you're running on the box itself for
   the very first run, add `ansible_connection: local`.

3. **Set per-host network config.** Copy the example and fill in real
   addresses (find them with `ip -4 addr show` and `tailscale ip -4` on
   the host):

   ```bash
   cp host_vars/imghost.aigf.dev.yml.example host_vars/imghost.aigf.dev.yml
   $EDITOR host_vars/imghost.aigf.dev.yml
   ```

   `sshd_listen_addresses` is the allow-list. Default is loopback only;
   the example adds the LAN and Tailscale IPs because the LAN is
   trusted. The WAN interface deliberately never appears here — public
   reach goes through the cloudflared tunnel.

   If any address is on `tailscale0`, leave `sshd_wait_for_tailscale:
   true`. It installs a systemd drop-in that delays sshd startup until
   tailscale assigns the IP, otherwise sshd loses the boot race and
   refuses to start.

4. **Dry-run with diff against the live host.** This is the migration
   safety net: confirm Ansible's view matches reality *before* it
   applies anything.

   ```bash
   ansible-playbook site.yml --check --diff --ask-vault-pass
   ```

   If `--check` flags drift on a working host, fix the playbook to match
   the current host — never the other way around. The whole point of
   moving from `auto-deploy.md` to Ansible is that the playbook is the
   source of truth from this point on.

5. **Apply for real.**

   ```bash
   ansible-playbook site.yml --ask-vault-pass
   ```

   Reruns are idempotent. If someone SSH'd in and edited
   `/etc/ssh/sshd_config` or `/etc/cloudflared/config.yml` by hand,
   the next run reverts those edits.

## Verifying

After a successful run, on the host:

```bash
sudo ss -lntp | grep ':22'                                # exactly the addresses in sshd_listen_addresses
sudo -u deploy cat ~deploy/.ssh/authorized_keys           # forced command + restrict
docker compose version                                    # v2 plugin present
sudo systemctl is-active cloudflared                      # active
sudo stat -c '%a %U:%G' /etc/imghost.env                  # 600 root:root
sudo stat -c '%a %U:%G' /opt/imghost/docker-compose.yml   # 644 root:root
```

The deploy pipeline (`deploy/auto-deploy.md`) takes over from here and
hasn't changed.

## Adding a second host

Drop another entry under `imghost.hosts` in the inventory. Group vars
apply unchanged. Per-host overrides go in
`host_vars/<hostname>.yml`.
