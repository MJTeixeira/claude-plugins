# Known-good templates

Replace `<name>`, `<user>`, `<port>`, paths. Units go in
`/etc/systemd/system/` (or `~/.config/systemd/user/` + `loginctl
enable-linger <user>` for user services that must run while logged out).

## Service

```ini
[Unit]
Description=<name>
After=network-online.target
Wants=network-online.target

[Service]
User=<user>
WorkingDirectory=/srv/<name>
EnvironmentFile=/etc/<name>/env
Environment=PATH=/home/<user>/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## Timer (instead of cron)

```ini
# <name>.timer — pairs with a oneshot <name>.service
[Unit]
Description=Run <name> nightly

[Timer]
OnCalendar=*-*-* 03:00:00 Europe/Lisbon
Persistent=true

[Install]
WantedBy=timers.target
```

`systemctl enable --now <name>.timer`; inspect with `systemctl list-timers`.

## Caddyfile

```
example.com {
    reverse_proxy 127.0.0.1:<port>
}
```

TLS, redirects, WebSockets, and forwarded headers are automatic.

## nginx server block

```nginx
server {
    listen 443 ssl;
    server_name example.com;
    # ssl_certificate lines from certbot

    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:<port>;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # WebSockets:
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```
