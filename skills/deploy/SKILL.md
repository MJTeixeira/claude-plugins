---
name: deploy
description: Deploying or hosting services on a VPS or bare server — systemd units/timers, cron, reverse proxies (nginx/Caddy), env files, firewalls. Not for Kubernetes or managed-PaaS setups.
---

# VPS deploy (systemd + reverse proxy)

## The environment trap (has cost us whole nights)

systemd, cron, and launchd do NOT read your shell profile. A service that
works when run by hand and dies when the timer fires is almost always PATH or
env:

- Set `Environment=PATH=...` (include `~/.local/bin` and friends) or use
  absolute paths in `ExecStart`.
- App config/secrets via `EnvironmentFile=` (chmod 600, outside the repo) —
  never inline in the unit; `systemctl show` prints unit contents.
- Prove the scheduled path, not your shell: start it once via `systemctl
  start` and read `journalctl -u <name> -e` before calling it done.

## Units and timers

- Prefer systemd timers over cron on Linux: journal logging, `Persistent=`
  catch-up, timezone pinning — and `(crontab -l; ...) | crontab -` piping has
  failed silently on us.
- Service basics: `User=` (not root), `WorkingDirectory=`,
  `Restart=on-failure`.
- After installing: `daemon-reload`, `enable --now`, and confirm it survives
  reboot (`systemctl is-enabled` at minimum).

## Reverse proxy

- The app binds 127.0.0.1:<port>; the proxy owns 80/443 and TLS (Caddy is the
  low-config default — automatic certs).
- Forward `Host`, `X-Forwarded-For`, `X-Forwarded-Proto`, and configure the
  framework to trust the proxy — otherwise: redirect loops, http:// URLs
  behind https, Secure cookies silently dropped.
- WebSockets need the Upgrade/Connection headers; uploads need
  `client_max_body_size` (nginx defaults to 1M).

## Verify a deploy

Curl the real domain through the proxy from outside, and exercise one changed
flow. "Green on localhost, 502 on the domain" is the standard failure. Check
`journalctl` for startup warnings even when it responds.

## Firewall

Expose only 22/80/443. Databases and caches bind to localhost or a private
interface (Tailscale/VPC) — never the public one.

Known-good templates (service, timer, Caddyfile, nginx block):
`references/templates.md`.
