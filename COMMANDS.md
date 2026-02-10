# Bot Commands

All commands use the `!` prefix (configurable per-thread).

## User Commands

| Command     | Description                     | Example        |
|-------------|---------------------------------|----------------|
| `!help`     | List all available commands     | `!help`        |
| `!help <cmd>` | Show details for a command   | `!help status` |
| `!ping`     | Check if the bot is alive       | `!ping`        |
| `!status`   | Show bot status and uptime      | `!status`      |

## Admin Commands

These commands require the sender to have admin permissions (`is_admin = 1` in the database).

| Command                      | Description                        | Example                |
|------------------------------|------------------------------------|------------------------|
| `!stats`                     | Show detailed system statistics    | `!stats`               |
| `!block <userId>`            | Block a user from using the bot    | `!block 123456`        |
| `!unblock <userId>`          | Unblock a previously blocked user  | `!unblock 123456`      |
| `!admin grant <userId>`      | Grant admin permissions to a user  | `!admin grant 123456`  |
| `!admin revoke <userId>`     | Revoke admin permissions           | `!admin revoke 123456` |

## Automatic Handlers

These are not prefixed commands — they trigger automatically:

| Handler         | Trigger                                   | Action                              |
|-----------------|-------------------------------------------|-------------------------------------|
| Media Download  | Instagram/TikTok/Facebook links in chat   | Downloads and re-sends the media    |
| Ping (legacy)   | Bare "ping" message (no prefix)           | Replies "pong 🏓"                  |

## Permissions

- **user**: Default role. Can use `!help`, `!ping`, `!status`.
- **admin**: Can use all commands including `!block`, `!unblock`, `!admin`, `!stats`.

## Error Handling

- Invalid commands return a clear error message with a ❌ prefix.
- Admin-only commands show "🔒 This command requires admin permissions" for non-admins.
- Missing arguments show the correct usage syntax.

## Admin Dashboard

A web-based admin dashboard is available at `http://localhost:9090/dashboard` (same port as the metrics server).

### API Endpoints

| Method | Endpoint                   | Description               |
|--------|----------------------------|---------------------------|
| GET    | `/api/overview`            | System KPIs and health    |
| GET    | `/api/users`               | List users (pagination)   |
| GET    | `/api/users/:id`           | Get user details          |
| POST   | `/api/users/:id/block`     | Block/unblock user        |
| POST   | `/api/users/:id/admin`     | Grant/revoke admin        |
| GET    | `/api/threads`             | List threads (pagination) |
| GET    | `/api/threads/:id`         | Get thread details        |
| GET    | `/api/messages?thread=:id` | Messages for a thread     |
| GET    | `/health`                  | Health check              |
| GET    | `/metrics`                 | Prometheus-style metrics  |
